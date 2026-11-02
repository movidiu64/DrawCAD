"""Primirea unui fișier încărcat, într-un proces separat și limitat.

Tot ce citește prima dată un fișier necunoscut (decodarea imaginii, parsarea PDF-ului, randarea și
extragerea geometriei) rulează aici, nu în serverul web: dacă un fișier construit special face
biblioteca să se blocheze, să consume toată memoria sau să cadă, se oprește doar acest proces,
iar serverul răspunde „fișier respins”. Rezultatul (PDF-ul curățat) e scris în folderul primit.

Rulare: python -m app.ingest <intrare> <folder_ieșire> [dpi]
Ieșire pe stdout: un singur obiect JSON.
"""
from __future__ import annotations

import json
import os
import sys


def _env(name, default):
    return os.environ.get(f"DRAWCAD_{name}") or os.environ.get(f"COTARE_{name}") or default


MAX_PAGES = int(_env("MAX_PAGES", "300"))
MAX_IMAGE_MPX = float(_env("MAX_IMAGE_MPX", "400"))  # megapixeli pe imagine (scan A0 la 600 DPI ≈ 550)
MEM_MB = int(_env("WORKER_MEM_MB", "3072"))
CPU_S = int(_env("WORKER_CPU_S", "120"))
MAX_PAGE_PT = 14400  # 200 țoli, limita din specificația PDF
MAX_STATE = 8 * 1024 * 1024


class Rejected(Exception):
    pass


def _limit_self():
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEM_MB * 1024 * 1024, MEM_MB * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_S, CPU_S + 5))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except Exception:  # noqa: BLE001
        pass


def _clean_state(state):
    """Starea editabilă dintr-un export: doar structura așteptată, fără nimic executabil."""
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
    if b"%PDF-" not in head:
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
            data, js = emb
            if len(js) <= MAX_STATE:
                try:
                    state = _clean_state(json.loads(js.decode("utf-8")))
                except Exception:  # noqa: BLE001
                    state = None
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
    # fiecare pagină se randează o dată la rezoluție mică și se extrage geometria primelor pagini:
    # dacă fișierul blochează sau dărâmă biblioteca, se întâmplă aici, nu în server
    for i, p in enumerate(pages[:60]):
        pdfcore.render_png(data, i, min(0.25, 900 / max(p["w"], p["h"])))
        if i < 4:
            pdfcore.snap_points(data, i)
    with open(os.path.join(out_dir, "original.pdf"), "wb") as f:
        f.write(data)
    return {"kind": kind, "dpi": used_dpi, "pages": pages, "state": state, "removed": removed}


def _emit(out_dir, obj):
    """Rezultatul: pe ieșirea standard și în out_dir/result.json (pe Windows, o aplicație
    împachetată fără consolă poate să nu aibă ieșire standard)."""
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
    out_dir = argv[2] if len(argv) > 2 else "."
    try:
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
