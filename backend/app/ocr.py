"""Text recognition (OCR) on drawings, with Tesseract.

Technical drawings are hard for OCR: long lines touch the letters, and vertical
dimensions are rotated. So the page is rendered in grayscale at ~300 DPI, long straight
lines are removed before recognition, and recognition runs twice: once normally and
once with the page rotated, for text written bottom to top. The result is in visual coordinates
(PDF points, y down), like the rest of the app.
"""
from __future__ import annotations

import csv
import io
import math
import os
import re
import shutil
import subprocess
import threading
import sys
import tempfile
import time

import numpy as np
from PIL import Image

from . import pdfcore

DPI = 300
MAX_PX = 60e6  # A0 at 300 DPI ≈ 140 MP: the resolution is reduced so it does not take minutes


def _env(name, default):
    return os.environ.get(f"DRAWCAD_{name}") or os.environ.get(f"COTARE_{name}") or default


OCR_LANG = _env("OCR_LANG", "ron+eng")
OCR_TIMEOUT = int(_env("OCR_TIMEOUT", "150"))
_LANGS = None
RAGGED = None  # None = automatic (scan → yes)


def _exe():
    """Tesseract: the explicitly given path (the desktop app bundles it) or the one on PATH."""
    p = os.environ.get("DRAWCAD_TESSERACT")
    if p and os.path.isfile(p):
        return p
    return shutil.which("tesseract")


def _run_kw() -> dict:
    # Tesseract output is UTF-8 (diacritics); on Windows, no console window
    kw = {"capture_output": True, "text": True, "encoding": "utf-8", "errors": "replace"}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kw


_LANGS_LOCK = threading.Lock()
_LANGS_FAIL = 0.0  # time of the last failed detection: retried after a minute


def available_langs() -> list[str]:
    """Installed Tesseract languages. The first run may take a while (on Windows, the antivirus checks
    the executable on first start): a good result is remembered, a failure is retried later."""
    global _LANGS, _LANGS_FAIL
    if _LANGS is not None:
        return _LANGS
    with _LANGS_LOCK:
        if _LANGS is not None:
            return _LANGS
        if _LANGS_FAIL and time.time() - _LANGS_FAIL < 60:
            return []
        exe = _exe()
        if not exe:
            _LANGS = []
            return _LANGS
        try:
            r = subprocess.run([exe, "--list-langs"], timeout=60, **_run_kw())
            out = r.stdout or r.stderr or ""
            langs = [ln.strip() for ln in out.splitlines()[1:] if ln.strip() and ln.strip() != "osd"]
        except Exception:  # noqa: BLE001
            langs = []
        if langs:
            _LANGS = langs
        else:
            _LANGS_FAIL = time.time()
        return langs


def langs_known() -> bool:
    """Language detection has finished (with or without Tesseract)."""
    return _LANGS is not None


def lang() -> str | None:
    have = available_langs()
    want = [x for x in OCR_LANG.split("+") if x in have]
    if want:
        return "+".join(want)
    return "eng" if "eng" in have else (have[0] if have else None)


def available() -> bool:
    return lang() is not None


def render_gray(pdf_bytes: bytes, n: int, page_wh) -> tuple[np.ndarray, float]:
    """The page in grayscale, as a numpy array; also returns the scale (pixels per point)."""
    w, h = page_wh
    scale = DPI / 72
    if w * h * scale * scale > MAX_PX:
        scale = (MAX_PX / (w * h)) ** 0.5
    # straight to a gray array, without an intermediate PNG, and in strips: at 60 MP the color bitmap of
    # the whole page alone would be ~240 MB
    return pdfcore.render_gray_strips(pdf_bytes, n, scale), scale


def remove_long_lines(gray: np.ndarray, px_mm: float, min_mm: float = 7.0, dark: int = 150, ragged: bool = True,
                      inplace: bool = False, strip: int = 1024) -> np.ndarray:
    """Removes horizontal and vertical lines longer than `min_mm` (frames, dimension lines, borders),
    so letters are free for OCR. Text stays almost intact.

    Worked in strips: horizontal lines in bands of rows, vertical lines in bands of columns, each band
    with a few rows of margin (closing, the ragged edges and the thin-stroke test look up to 4 rows
    away), so the result is the same as on the whole page; only the mask of pixels to clear is page-sized
    (at 60 MP the whole-page masks took ~180 MB more)."""
    L = max(8, int(min_mm * px_mm))
    H, W = gray.shape
    kill = np.zeros((H, W), dtype=bool)
    M = 4
    for i in range(0, H, strip):
        a0, a1 = max(0, i - M), min(H, i + strip + M)
        k = _line_pixels(gray[a0:a1] < dark, L, ragged)
        kill[i:i + strip] |= k[i - a0:i - a0 + min(strip, H - i)]
    gT = gray.T
    for j in range(0, W, strip):
        a0, a1 = max(0, j - M), min(W, j + strip + M)
        k = _line_pixels(gT[a0:a1] < dark, L, ragged)
        kill[:, j:j + strip] |= k[j - a0:j - a0 + min(strip, W - j)].T
    if not kill.any():
        return gray
    # in place only on an array we own (np.asarray of a PIL image is read-only)
    out = gray if inplace and gray.flags.writeable else gray.copy()
    out[kill] = 255
    return out


def _line_pixels(b: np.ndarray, L: int, ragged: bool) -> np.ndarray:
    """The pixels of the horizontal lines longer than L in the dark mask `b` (rows), with their ragged
    edges when `ragged`. Vertical lines: the same on the transposed mask."""

    def runs(mask, L=L):  # per row: the pixels in continuous runs longer than L
        out = np.zeros_like(mask)
        for r in np.nonzero(mask.any(axis=1))[0]:
            d = np.diff(mask[r].view(np.int8), prepend=np.int8(0), append=np.int8(0))
            st = np.nonzero(d == 1)[0]
            en = np.nonzero(d == -1)[0]
            for s, e in zip(st, en):
                if e - s >= L:
                    out[r, s:e] = True
        return out

    def close(mask, r=1):  # closing along rows: gaps of up to 2r pixels (scan noise) are filled
        d = mask.copy()
        for k in range(1, r + 1):
            d[:, k:] |= mask[:, :-k]
            d[:, :-k] |= mask[:, k:]
        e = d.copy()
        for k in range(1, r + 1):
            e[:, k:] &= d[:, :-k]
            e[:, :k] = False
            e[:, :-k] &= d[:, k:]
            e[:, -k:] = False
        e |= mask
        return e

    def edges(core, mask):
        """Ragged edges of the line: pixels touching it (up to 3 rows above /
        below) that form only thin blots (≤ 3 pixels vertically). Letters touching the
        line have longer vertical strokes and stay."""
        near = core.copy()
        for k in (1, 2, 3):
            near[k:] |= core[:-k]
            near[:-k] |= core[k:]
        thin = runs(mask.T, 4).T  # long vertical strokes…
        np.logical_not(thin, out=thin)  # …no; the remaining black pixels yes
        thin &= mask
        near &= thin
        del thin
        np.greater(near, core, out=near)  # near and not core
        return near

    core = runs(close(b))
    core &= b
    if not ragged:
        return core
    k = edges(core, b)
    k |= core
    return k


def _denoise(gray: np.ndarray) -> np.ndarray:
    """Scans have specks and an uneven background: 3×3 median filter and Otsu threshold → clean black and white.
    Works in place on a writable array (the caller gives up `gray`). Clean renders of vector PDFs pass
    practically unchanged."""
    from PIL import ImageFilter

    from .vectorize import otsu_hist

    # in strips (with a one-row margin for the filter), in place when the array is ours: the extra
    # memory is one strip; the row above a strip is kept as it was before the strip above was filtered.
    # The Otsu threshold comes from the histogram of the whole filtered image
    h = gray.shape[0]
    out = gray if gray.flags.writeable else np.array(gray)
    hist = np.zeros(256, dtype=np.int64)
    S = 1024
    above = None
    for i in range(0, h, S):
        a0, a1 = max(0, i - 1), min(h, i + S + 1)
        block = np.array(out[a0:a1])
        if above is not None:
            block[0] = above
        above = np.array(out[min(h, i + S) - 1])
        f = np.asarray(Image.fromarray(block).filter(ImageFilter.MedianFilter(3)))
        f = f[i - a0:i - a0 + min(S, h - i)]
        out[i:i + f.shape[0]] = f
        hist += np.bincount(f.ravel(), minlength=256)
    t = otsu_hist(hist)
    for i in range(0, h, S):
        c = out[i:i + S]
        c[:] = np.where(c < t, np.uint8(0), np.uint8(255))
    return out


def _tesseract(img: Image.Image, lng: str, dpi: int) -> list[dict]:
    exe = _exe()
    with tempfile.TemporaryDirectory(prefix="drawcad-ocr-") as td:
        p = os.path.join(td, "in.png")
        img.save(p)
        env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
        r = subprocess.run(
            [exe, p, "stdout", "-l", lng, "--psm", "11", "--dpi", str(int(dpi)), "-c", "preserve_interword_spaces=1", "tsv"],
            timeout=OCR_TIMEOUT, env=env, **_run_kw(),
        )
        if r.returncode != 0:
            raise RuntimeError((r.stderr or "tesseract a eșuat").strip().splitlines()[-1][:200])
        rows = list(csv.DictReader(io.StringIO(r.stdout), delimiter="\t", quoting=csv.QUOTE_NONE))
    words = []
    for w in rows:
        try:
            if int(w["level"]) != 5:
                continue
            conf = float(w["conf"])
        except (KeyError, ValueError, TypeError):
            continue
        txt = (w.get("text") or "").strip()
        if not txt or conf < 0:
            continue
        words.append({
            "t": txt, "conf": conf,
            "x": int(w["left"]), "y": int(w["top"]), "w": int(w["width"]), "h": int(w["height"]),
            "key": (w["block_num"], w["par_num"], w["line_num"]),
        })
    return words


_TECH = re.compile(
    r"^(?:[OØ0@©Q]?\d+(?:[.,]\d+)?(?:[a-zA-Z]{1,2}\d{1,2})?|[A-Za-z]{1,2}\d{1,2}|[MR]\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?"
    r"|\d+(?:[.,]\d+)?°|[+±-]\d+(?:[.,]\d+)?|\d+x\d+°?)$"
)


def _fix(txt: str) -> str:
    """Typical corrections on drawings: Ø read as O, 0, @ or © before a number; long dashes."""
    txt = re.sub(r"(?<![\w,.])[OQ0@©](?=\d{2,}(?:[.,]\d+)?(?:\b|[a-zA-Z]))", "Ø", txt)
    txt = re.sub(r"(?<![\w,.])[@©](?=\d)", "Ø", txt)
    return txt.replace("—", "-").replace("–", "-")


def _accept(w, min_conf):
    """"Technical" words (dimensions, tolerances, threads) are accepted at lower confidence too:
    Tesseract does not know Ø and lowers the confidence for the whole word."""
    if not any(ch.isalnum() for ch in w["t"]):
        return False
    if len(w["t"]) <= 3 and not w["t"].strip("lI|!ij.,'"):
        return False  # pieces of line read as letters
    if w["conf"] >= min_conf:
        return True
    return w["conf"] >= 38 and bool(_TECH.match(w["t"]))


def _lines(words, px_mm, min_conf):
    groups = {}
    for w in words:
        if not _accept(w, min_conf):
            continue
        hmm = w["h"] / px_mm
        if hmm < 1.0 or hmm > 25:
            continue
        groups.setdefault(w["key"], []).append(w)
    out = []
    for ws in groups.values():
        ws.sort(key=lambda w: w["x"])
        # words too far apart on the same Tesseract "line" are different texts (table columns)
        cur = [ws[0]]
        for w in ws[1:]:
            prev = cur[-1]
            gap = w["x"] - (prev["x"] + prev["w"])
            if gap > 2.5 * max(prev["h"], w["h"]):
                out.append(cur)
                cur = [w]
            else:
                cur.append(w)
        out.append(cur)
    res = []
    for ws in out:
        compact = "".join(w["t"] for w in ws)
        conf_l = sum(w["conf"] for w in ws) / len(ws)
        # 1–2 character bits: only if they are digits or read with high confidence
        if len(compact) <= 2 and not (compact.isdigit() and conf_l >= 60) and conf_l < 80:
            continue
        x0 = min(w["x"] for w in ws)
        y0 = min(w["y"] for w in ws)
        x1 = max(w["x"] + w["w"] for w in ws)
        y1 = max(w["y"] + w["h"] for w in ws)
        txt = _fix(" ".join(w["t"] for w in ws))
        conf = sum(w["conf"] for w in ws) / len(ws)
        # cap height and baseline: the median over words (the box of the whole line
        # grows slightly because of a single word with descenders or a blot touching the text)
        caps, bases = [], []
        for w in ws:
            t = w["t"]
            desc = any(ch in "gjpqyQ,;()[]{}|" for ch in t)
            tall = any(ch.isupper() or ch.isdigit() or ch in "bdfhklt/Ø" for ch in t)
            h = w["h"] / 1.3 if desc else w["h"]
            caps.append(h if tall else h / 0.72)  # only lowercase letters without ascenders/descenders: the height of "x"
            bases.append(w["y"] + w["h"] - (w["h"] * 0.23 / 1.3 if desc else 0))
        caps.sort()
        bases.sort()
        med = caps[(len(caps) - 1) // 2]
        # a blot touching a word enlarges its box, never shrinks it: the smallest one counts
        cap = min(c for c in caps if c >= 0.6 * med)
        res.append({"text": txt, "conf": round(conf, 1), "px": [x0, y0, x1, y1],
                    "cap": cap, "base": bases[(len(bases) - 1) // 2]})
    return res


def _iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if not inter:
        return 0.0
    # relative to the smaller box: a false piece inside a correctly read text is dropped
    ar = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return inter / ar if ar > 0 else 0.0


def estimate_skew(gray: np.ndarray) -> float:
    """Scan skew (degrees, counter-clockwise on screen), from the projection profile: at
    the right angle, the drawing's horizontal lines fall on as few rows as possible."""
    im = Image.fromarray(np.where(gray < 150, np.uint8(255), np.uint8(0)))
    f = 1000 / max(im.size)
    if f < 1:
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))), Image.BILINEAR)

    def score(a):
        r = np.asarray(im.rotate(a, resample=Image.BILINEAR), np.float32)
        return float(np.var(r.sum(axis=1)) + np.var(r.sum(axis=0)))

    best = max(np.arange(-2.0, 2.01, 0.1), key=score)
    best = max(np.arange(best - 0.1, best + 0.101, 0.02), key=score)
    # the straightening rotation is `best`; the scan skew is its opposite
    return 0.0 if abs(best) < 0.05 else float(-best)


def _rot(p, deg, c):
    """Rotates point p (image coordinates, y down) by `deg` degrees counter-clockwise on screen."""
    t = math.radians(deg)
    dx, dy = p[0] - c[0], p[1] - c[1]
    return (c[0] + dx * math.cos(t) + dy * math.sin(t), c[1] - dx * math.sin(t) + dy * math.cos(t))


def ocr_page(pdf_bytes: bytes, n: int, page_wh, rotated: bool = True, scan: bool | None = None) -> dict:
    lng = lang()
    if not lng:
        raise RuntimeError("Tesseract nu e instalat pe server")
    t0 = time.time()
    gray, scale = render_gray(pdf_bytes, n, page_wh)
    px_mm = scale * 72 / 25.4
    den = _denoise(gray)
    del gray  # page arrays are large (tens of MB): released as soon as they are no longer needed
    # a skewed scan is straightened first: long lines become exactly horizontal / vertical and can be
    # removed without touching the letters; coordinates are mapped back to the original page at the end
    skew = estimate_skew(den)
    work = den
    if skew:
        work = np.asarray(Image.fromarray(den).rotate(-skew, resample=Image.NEAREST, fillcolor=255))
    # on scans lines have ragged edges that must be removed too; on clean renders
    # of a vector PDF removing the edges would clip letters touching the lines
    ragged = RAGGED if scan is None else scan
    if scan is None and RAGGED is None:
        ragged = bool(skew)
    clean = remove_long_lines(work, px_mm, ragged=ragged, inplace=True)  # `work` is not needed afterwards
    del work, den
    img = Image.fromarray(clean)
    dpi = scale * 72
    lines = []
    for ln in _lines(_tesseract(img, lng, dpi), px_mm, 55):
        ln["rot"] = 0
        lines.append(ln)
    if rotated:
        H = clean.shape[0]
        rimg = img.rotate(-90, expand=True)  # text written bottom to top becomes horizontal
        for ln in _lines(_tesseract(rimg, lng, dpi), px_mm, 60):
            u0, v0, u1, v1 = ln["px"]
            ln["px"] = [v0, H - u1, v1, H - u0]
            # the horizontal baseline in the rotated image becomes vertical (x = v) on the page
            ln["rot"] = 90
            lines.append(ln)
        # the same area read in both orientations: the more confident reading stays
        lines.sort(key=lambda l: -l["conf"] * min(len(l["text"]), 8))
        keep = []
        for ln in lines:
            if all(_iou(ln["px"], o["px"]) < 0.4 for o in keep):
                keep.append(ln)
        lines = keep
    c = (clean.shape[1] / 2, clean.shape[0] / 2)
    for ln in lines:
        x0, y0, x1, y1 = ln.pop("px")
        vert = ln["rot"] == 90
        org = (ln["base"], y1) if vert else (x0, ln["base"])
        length = (y1 - y0) if vert else (x1 - x0)
        corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        if skew:
            org = _rot(org, skew, c)
            corners = [_rot(q, skew, c) for q in corners]
        xs = [q[0] for q in corners]
        ys = [q[1] for q in corners]
        ln["box"] = [round(min(xs) / scale, 2), round(min(ys) / scale, 2), round(max(xs) / scale, 2), round(max(ys) / scale, 2)]
        ln["org"] = [round(org[0] / scale, 2), round(org[1] / scale, 2)]
        ln["ang"] = round((90 if vert else 0) + skew, 3)
        ln["len"] = round(length / scale, 2)
        ln["cap"] = round(ln["cap"] / scale, 2)
        ln["base"] = round(ln["base"] / scale, 2)
    lines.sort(key=lambda l: (round(l["box"][1] / 6), l["box"][0]))
    return {"lines": lines, "lang": lng, "ms": int((time.time() - t0) * 1000), "dpi": round(dpi), "skew": round(skew, 3)}


def native_text(pdf_bytes: bytes, n: int) -> list[dict]:
    """Real texts of the PDF (not from the image), with their bounding boxes: for search."""
    import ctypes  # noqa: F401

    from .pdfcore import PDFIUM_LOCK, PageGeo, R, _bbox_page_space, _is_hidden, _text_of, _walk, pdfium

    out = []
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[n]
            g = PageGeo.of(page)
            tp = page.get_textpage()
            for _oid, obj, typ, parent_total, _c, _n in _walk(page.raw):
                if typ != R.FPDF_PAGEOBJ_TEXT or _is_hidden(obj, typ):
                    continue  # a text on a hidden layer is not found either
                txt = _text_of(obj, tp.raw).strip()
                if not txt:
                    continue
                bb = _bbox_page_space(obj, parent_total)
                if bb:
                    out.append({"text": txt, "box": [round(v, 2) for v in g.bbox_to_vis(*bb)]})
                if len(out) > 20000:
                    break
            tp.close()
            page.close()
        finally:
            doc.close()
    return out
