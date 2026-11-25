"""Receiving an uploaded file, in a separate, limited process.

Everything that reads an unknown file for the first time (image decoding, PDF parsing, rendering and
geometry extraction) runs here, not in the web server: if a crafted file makes
the library hang, eat all the memory or crash, only this process stops,
and the server answers "file rejected". The result (the cleaned PDF) is written to the given folder.

Usage: python -m app.ingest <input> <output_folder> [dpi]
       python -m app.ingest --image <input> <output_folder>   (an image to place on a drawing)
Output on stdout: a single JSON object.
"""
from __future__ import annotations

import json
import os
import re
import sys


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
        f.write(data)
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


def process(path: str, out_dir: str, dpi: float | None) -> dict:
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


def main(argv):
    _limit_self()
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
        res = process(argv[1], out_dir, dpi)
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
