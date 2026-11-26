"""Receiving an uploaded file, in a separate, limited process.

Everything that reads an unknown file for the first time (image decoding, PDF parsing, rendering and
geometry extraction) runs here, not in the web server: if a crafted file makes
the library hang, eat all the memory or crash, only this process stops,
and the server answers "file rejected". The result (the cleaned PDF) is written to the given folder.

Usage: python -m app.ingest <input> <output_folder> [dpi] [dxf units ($INSUNITS code)]
       python -m app.ingest --image <input> <output_folder>   (an image to place on a drawing)
       python -m app.ingest --font <input> <output_folder>    (a font for DXF / DWG texts)
       python -m app.ingest --serve                           (started ahead: one job from stdin, see serve)
Output on stdout: a single JSON object.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


def _env(name, default):
    return os.environ.get(f"DRAWCAD_{name}") or os.environ.get(f"COTARE_{name}") or default


MAX_PAGES = int(_env("MAX_PAGES", "300"))
MAX_IMAGE_MPX = float(_env("MAX_IMAGE_MPX", "400"))  # megapixels per image (A0 scan at 600 DPI ≈ 550)
MEM_MB = int(_env("WORKER_MEM_MB", "3072"))
CPU_S = int(_env("WORKER_CPU_S", "120"))
MAX_PAGE_PT = 14400  # 200 inches, the limit of the PDF specification
MAX_STATE = 8 * 1024 * 1024
MAX_DXF_ENTITIES = int(_env("MAX_DXF_ENTITIES", "400000"))


class Rejected(Exception):
    pass


def is_dwg(head: bytes) -> bool:
    """A DWG by its version string: AC1012 (R13) … AC1032 (2018+), the old AC1.40 … AC2.10 too."""
    return re.match(rb"AC(1\d{3}|[12]\.\d\d)", head[:6]) is not None


def is_dxf(head: bytes) -> bool:
    """A DXF by its content (the upload's name is not trusted): binary DXF sentinel, or an ASCII file
    that starts with group code 0 SECTION (after optional 999 comments)."""
    if head.startswith(b"AutoCAD Binary DXF"):
        return True
    lines = [ln.strip() for ln in head[:4096].decode("latin-1").splitlines()]
    i = 0
    while i + 1 < len(lines) and lines[i] == "999":
        i += 2
    return i + 1 < len(lines) and lines[i] == "0" and lines[i + 1].upper() == "SECTION"


DWG_TIMEOUT = float(_env("DWG_TIMEOUT", "90"))


def dwg_dxf(data: bytes, out_dir: str) -> bytes:
    """A DWG converted to DXF by LibreDWG (dwg2dxf), in this limited process (its limits apply to the
    converter too)."""
    from . import dxfin

    try:
        return dxfin.dwg_to_dxf(data, out_dir, DWG_TIMEOUT)
    except dxfin.NoDwg as e:
        raise Rejected("Deschiderea DWG nu e disponibilă aici (lipsește LibreDWG). Salvează desenul ca DXF.") from e
    except ValueError as e:
        raise Rejected(str(e)) from e


def dxf_pdf(data: bytes, out_dir: str) -> tuple[bytes, dict]:
    """A DXF made into a vector PDF (dxfin); the DXF is kept next to it (original.dxf), for the DXF export
    of the original drawing."""
    from . import dxfin

    try:
        pdf, info = dxfin.dxf_to_pdf(data, max_entities=MAX_DXF_ENTITIES)
    except dxfin.TooLarge as e:
        raise Rejected(f"Desen DXF prea mare: peste {MAX_DXF_ENTITIES} entități de desenat, cu blocurile desfăcute") from e
    except ValueError as e:
        raise Rejected(str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise Rejected(f"DXF imposibil de citit: {e}") from e
    if len(info["pages"]) > MAX_PAGES:
        raise Rejected(f"Prea multe pagini (limita e {MAX_PAGES})")
    with open(os.path.join(out_dir, "original.dxf"), "wb") as f:
        f.write(info.pop("fixed_dxf", None) or data)
    # which DXF entity each PDF object comes from: removals made in DrawCAD reach the DXF export
    with open(os.path.join(out_dir, "original.dxfmap.json"), "w", encoding="utf-8") as f:
        json.dump(info.pop("handles"), f, separators=(",", ":"))
    # the layer of each PDF object: layers can be hidden in the editor
    lm = info.pop("layer_map")
    with open(os.path.join(out_dir, "original.dxflayers.json"), "w", encoding="utf-8") as f:
        json.dump({"names": lm["names"], "pages": lm["pages"]}, f, separators=(",", ":"))
    info["layers"] = lm["layers"]
    return pdf, info


def _limit_self():
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEM_MB * 1024 * 1024, MEM_MB * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_S, CPU_S + 5))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:  # noqa: BLE001
        pass


def _clean_state(state):
    """The editable state from an export: only the expected structure, nothing executable."""
    if not isinstance(state, dict):
        return None
    annots = state.get("annots")
    if not isinstance(annots, list):
        return None
    clean = []
    for a in annots[:20000]:
        if isinstance(a, dict) and isinstance(a.get("type"), str) and a["type"].isidentifier():
            clean.append(a)
    out = {"v": state.get("v", 1), "annots": clean}
    if isinstance(state.get("settings"), dict):
        out["settings"] = state["settings"]
    return out


def _restore_images(exported: bytes, state: dict, out_dir: str) -> None:
    """Images of image annotations, attached by the export: each one decoded and written again
    (images.clean_image) into out_dir/images; the annotations get the new ids, the rest go."""
    from . import pdfcore
    from .images import BadImage, clean_image, image_id

    found = pdfcore.extract_embedded_images(exported)
    ids = {}
    if found:
        os.makedirs(os.path.join(out_dir, "images"), exist_ok=True)
    for old, raw in found.items():
        try:
            data, ext, _w, _h = clean_image(raw, min(MAX_IMAGE_MPX, 100))
        except BadImage:
            continue
        new = image_id(data)
        with open(os.path.join(out_dir, "images", f"{new}.{ext}"), "wb") as f:
            f.write(data)
        ids[old] = new
    keep = []
    for a in state["annots"]:
        if a.get("type") == "image":
            if a.get("img") not in ids:
                continue
            a["img"] = ids[a["img"]]
        logo = a.get("tpl", {}).get("logo") if a.get("type") == "tblock" and isinstance(a.get("tpl"), dict) else None
        if isinstance(logo, dict):
            # a title block keeps its lines and texts even if its logo did not come back
            if logo.get("img") in ids:
                logo["img"] = ids[logo["img"]]
            else:
                a["tpl"].pop("logo", None)
        keep.append(a)
    state["annots"] = keep


def clean_upload_image(path: str, out_dir: str) -> dict:
    from .images import BadImage, clean_image, image_id

    with open(path, "rb") as f:
        raw = f.read()
    if not raw:
        raise Rejected("Fișier gol")
    try:
        data, ext, w, h = clean_image(raw, min(MAX_IMAGE_MPX, 100))
    except BadImage as e:
        raise Rejected(f"Imagine respinsă: {e}") from e
    iid = image_id(data)
    with open(os.path.join(out_dir, f"{iid}.{ext}"), "wb") as f:
        f.write(data)
    return {"id": iid, "ext": ext, "w": w, "h": h}


def process(path: str, out_dir: str, dpi: float | None, units: int | None = None) -> dict:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = int(MAX_IMAGE_MPX * 1e6)
    from . import pdfcore
    from .sanitize import sanitize_pdf

    with open(path, "rb") as f:
        data = f.read()
    if not data:
        raise Rejected("Fișier gol")
    kind = "pdf"
    used_dpi = None
    state = None
    removed = {}
    head = data[:1024]
    dxf = None
    if is_dwg(head) or is_dxf(data[:4096]):
        kind = "dxf"
        if is_dwg(head):
            data = dwg_dxf(data, out_dir)
            kind = "dwg"
        if units:
            # read again in other units ($INSUNITS), chosen by the user
            from . import dxfin

            try:
                data = dxfin.set_insunits(data, units)
            except Exception as e:  # noqa: BLE001
                raise Rejected(f"DXF imposibil de citit: {e}") from e
        data, dxf = dxf_pdf(data, out_dir)
        data, removed = sanitize_pdf(data)  # our own PDF: nothing to remove, but every PDF goes through it
    elif b"%PDF-" not in head:
        try:
            im = Image.open(path)
            w, h = im.size
            if w * h > MAX_IMAGE_MPX * 1e6:
                raise Rejected(f"Imagine prea mare ({w}×{h} px, limita e {MAX_IMAGE_MPX:g} MP)")
            if getattr(im, "n_frames", 1) > MAX_PAGES:
                raise Rejected(f"Prea multe pagini (limita e {MAX_PAGES})")
            im.close()
            data, used_dpi = pdfcore.image_to_pdf(data, dpi)
            kind = "image"
        except Rejected:
            raise
        except Image.DecompressionBombError as e:
            raise Rejected(f"Imagine respinsă (prea mare): {e}") from e
        except Exception as e:  # noqa: BLE001
            raise Rejected(f"Nu e PDF și nici imagine citibilă: {e}") from e
    else:
        if not data.startswith(b"%PDF-"):
            data = data[data.find(b"%PDF-"):]
        emb = pdfcore.extract_embedded(data)
        if emb:
            exported = data
            data, js = emb
            if len(js) <= MAX_STATE:
                try:
                    state = _clean_state(json.loads(js.decode("utf-8")))
                except Exception:  # noqa: BLE001
                    state = None
            if state is not None:
                _restore_images(exported, state, out_dir)
        data, removed = sanitize_pdf(data)
    info = pdfcore.open_info(data)
    pages = info["pages"]
    if not pages:
        raise Rejected("PDF fără pagini")
    if len(pages) > MAX_PAGES:
        raise Rejected(f"Prea multe pagini: {len(pages)} (limita e {MAX_PAGES})")
    for p in pages:
        if not (0 < p["w"] <= MAX_PAGE_PT and 0 < p["h"] <= MAX_PAGE_PT):
            raise Rejected("Dimensiune de pagină invalidă")
    # each page is rendered once at low resolution and the geometry of the first pages is extracted:
    # if the file hangs or crashes the library, it happens here, not in the server
    for i, p in enumerate(pages[:60]):
        pdfcore.render_png(data, i, min(0.25, 900 / max(p["w"], p["h"])))
        if i < 4:
            pdfcore.snap_points(data, i)
    with open(os.path.join(out_dir, "original.pdf"), "wb") as f:
        f.write(data)
    return {"kind": kind, "dpi": used_dpi, "pages": pages, "state": state, "removed": removed, "dxf": dxf}


def _emit(out_dir, obj):
    """The result: on standard output and in out_dir/result.json (on Windows, a packaged
    app without a console may have no standard output)."""
    txt = json.dumps(obj)
    try:
        with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as f:
            f.write(txt)
    except OSError:
        pass
    if sys.stdout is not None:
        try:
            sys.stdout.write(txt)
            sys.stdout.flush()
        except (OSError, ValueError):
            pass


def dxf_colors(doc_dir: str) -> dict:
    """The drawing of a document opened from DXF / DWG plotted again in its own colors
    (original-color.pdf, next to the monochrome original.pdf). Same objects in the same order, checked
    page by page, so removals, hidden layers and the entity map keep working."""
    import pypdfium2 as pdfium

    from . import dxfin
    from .sanitize import sanitize_pdf

    with open(os.path.join(doc_dir, "original.dxf"), "rb") as f:
        data = f.read()
    try:
        pdf, _info = dxfin.dxf_to_pdf(data, max_entities=MAX_DXF_ENTITIES, colors=True)
    except Exception as e:  # noqa: BLE001
        raise Rejected(f"Desenul nu poate fi refăcut color: {e}") from e
    pdf, _removed = sanitize_pdf(pdf)

    def counts(b):
        d = pdfium.PdfDocument(b)
        try:
            return [pdfium.raw.FPDFPage_CountObjects(d[i].raw) for i in range(len(d))]
        finally:
            d.close()

    with open(os.path.join(doc_dir, "original.pdf"), "rb") as f:
        mono = f.read()
    if counts(pdf) != counts(mono):
        raise Rejected("Desenul color nu se potrivește cu cel deschis")
    tmp = os.path.join(doc_dir, "original-color.pdf.tmp")
    with open(tmp, "wb") as f:
        f.write(pdf)
    os.replace(tmp, os.path.join(doc_dir, "original-color.pdf"))
    return {}


class _NullPen:
    def __getattr__(self, _name):
        return lambda *a, **k: None


FONT_KINDS = {".ttf": "TrueType", ".otf": "OpenType", ".ttc": "TrueType", ".shx": "SHX"}


def check_font(path: str, ext: str) -> dict:
    """A font added for DXF / DWG texts, read the way the drawings will read it (fontTools for
    TrueType / OpenType, ezdxf's reader for SHX) and drawn once. → {family, kind}"""
    ext = ext.lower()
    if ext not in FONT_KINDS:
        raise Rejected("Font necunoscut: se acceptă .ttf, .otf, .ttc și .shx")
    with open(path, "rb") as f:
        head = f.read(32)
    if ext == ".shx":
        if not head.startswith(b"AutoCAD-86 "):
            raise Rejected("Nu e un font SHX")
        from ezdxf.fonts import shapefile

        font = shapefile.readfile(path)
        if not len(font):
            raise Rejected("Fontul SHX nu are caractere")
        family = Path(path).stem
    else:
        if head[:4] not in (b"\x00\x01\x00\x00", b"true", b"OTTO", b"ttcf"):
            raise Rejected("Nu e un font TrueType / OpenType")
        from fontTools.ttLib import TTFont

        tt = TTFont(path, fontNumber=0)
        family = ""
        for rec in tt["name"].names:
            if rec.nameID == 1:
                family = rec.toUnicode()
                break
        glyphs = tt.getGlyphSet()
        for ch in "AØ09":  # noqa: RUF001 (drawn once, as the drawings will)
            name = tt.getBestCmap().get(ord(ch))
            if name:
                glyphs[name].draw(_NullPen())
        tt.close()
    return {"family": family[:100], "kind": FONT_KINDS[ext]}


def serve(argv) -> int:
    """`--serve`: a process the server starts ahead of time and keeps waiting. The limits, the heavy
    imports and the font set-up are done here, then it reads its one job from stdin (a JSON list of the
    usual arguments) and runs it as a freshly started process would. Still one file per process: only
    the start-up (seconds for the Windows app) is spent before the file arrives."""
    _limit_self()
    import contextlib

    with contextlib.suppress(Exception):
        import pikepdf  # noqa: F401
        import pypdfium2  # noqa: F401
        from PIL import Image  # noqa: F401

        from . import dxfin, images, pdfcore, sanitize  # noqa: F401

        dxfin._use_fonts()
    try:
        args = json.loads(_read_job())
        if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args) or args[0] == "--serve":
            raise ValueError
    except ValueError:
        return NO_JOB
    return main([argv[0], *args])


NO_JOB = 64  # --serve without a usable job: the server then reads the file in a freshly started process


def _read_job() -> str:
    """One line from standard input. A Windows app without a console may have no sys.stdin even when the
    server passed a pipe: the handle is then opened directly."""
    if sys.stdin is not None:
        try:
            return sys.stdin.readline()
        except (OSError, ValueError):
            pass
    if os.name == "nt":
        try:
            import ctypes
            import msvcrt

            h = ctypes.windll.kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
            if h and h != -1:
                with os.fdopen(msvcrt.open_osfhandle(h, os.O_RDONLY), "r", encoding="utf-8") as f:
                    return f.readline()
        except Exception:  # noqa: BLE001
            pass
    return ""


def main(argv):
    if len(argv) > 1 and argv[1] == "--serve":
        return serve(argv)
    _limit_self()
    if len(argv) > 3 and argv[1] == "--font":
        try:
            _emit(argv[3], {"ok": True, **check_font(argv[2], os.path.splitext(argv[2])[1])})
            return 0
        except Rejected as e:
            _emit(argv[3], {"ok": False, "error": str(e)})
            return 2
        except Exception:  # noqa: BLE001
            _emit(argv[3], {"ok": False, "error": "Font respins: nu poate fi citit"})
            return 4
    if len(argv) > 2 and argv[1] == "--dxf-colors":
        try:
            _emit(argv[2], {"ok": True, **dxf_colors(argv[2])})
            return 0
        except Rejected as e:
            _emit(argv[2], {"ok": False, "error": str(e)})
            return 2
        except Exception as e:  # noqa: BLE001
            _emit(argv[2], {"ok": False, "error": f"Desenul nu poate fi refăcut color: {e}"})
            return 4
    image = len(argv) > 1 and argv[1] == "--image"
    if image:
        argv = argv[1:]
    out_dir = argv[2] if len(argv) > 2 else "."
    try:
        if image:
            res = clean_upload_image(argv[1], out_dir)
            _emit(out_dir, {"ok": True, **res})
            return 0
        dpi = float(argv[3]) if len(argv) > 3 and argv[3] else None
        units = int(argv[4]) if len(argv) > 4 and argv[4] else None
        res = process(argv[1], out_dir, dpi, units)
        _emit(out_dir, {"ok": True, **res})
        return 0
    except Rejected as e:
        _emit(out_dir, {"ok": False, "error": str(e)})
        return 2
    except MemoryError:
        _emit(out_dir, {"ok": False, "error": "Fișierul cere prea multă memorie la citire"})
        return 3
    except Exception as e:  # noqa: BLE001
        _emit(out_dir, {"ok": False, "error": f"PDF imposibil de citit: {e}"})
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
