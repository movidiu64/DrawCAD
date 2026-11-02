"""Recunoașterea textului (OCR) pe desene, cu Tesseract.

Desenele tehnice sunt dificile pentru OCR: liniile lungi se lipesc de litere, iar cotele de pe
verticală sunt rotite. De aceea pagina se randează în tonuri de gri la ~300 DPI, liniile drepte
lungi se șterg înainte de recunoaștere, iar recunoașterea se face de două ori: o dată normal și
o dată cu pagina rotită, pentru textul scris de jos în sus. Rezultatul e în coordonate vizuale
(puncte PDF, y în jos), ca restul aplicației.
"""
from __future__ import annotations

import csv
import io
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image

from . import pdfcore

DPI = 300
MAX_PX = 60e6  # A0 la 300 DPI ≈ 140 MP: se reduce rezoluția ca să nu dureze minute


def _env(name, default):
    return os.environ.get(f"DRAWCAD_{name}") or os.environ.get(f"COTARE_{name}") or default


OCR_LANG = _env("OCR_LANG", "ron+eng")
OCR_TIMEOUT = int(_env("OCR_TIMEOUT", "150"))
_LANGS = None
RAGGED = None  # None = automat (scan → da)


def _exe():
    """Tesseract: calea dată explicit (aplicația desktop îl are în pachet) sau cel din PATH."""
    p = os.environ.get("DRAWCAD_TESSERACT")
    if p and os.path.isfile(p):
        return p
    return shutil.which("tesseract")


def _run_kw() -> dict:
    # ieșirea Tesseract e UTF-8 (diacriticele); pe Windows, fără fereastră de consolă
    kw = {"capture_output": True, "text": True, "encoding": "utf-8", "errors": "replace"}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kw


def available_langs() -> list[str]:
    global _LANGS
    if _LANGS is None:
        exe = _exe()
        if not exe:
            _LANGS = []
        else:
            try:
                r = subprocess.run([exe, "--list-langs"], timeout=10, **_run_kw())
                out = r.stdout or r.stderr or ""
                _LANGS = [ln.strip() for ln in out.splitlines()[1:] if ln.strip() and ln.strip() != "osd"]
            except Exception:  # noqa: BLE001
                _LANGS = []
    return _LANGS


def lang() -> str | None:
    have = available_langs()
    want = [x for x in OCR_LANG.split("+") if x in have]
    if want:
        return "+".join(want)
    return "eng" if "eng" in have else (have[0] if have else None)


def available() -> bool:
    return lang() is not None


def render_gray(pdf_bytes: bytes, n: int, page_wh) -> tuple[np.ndarray, float]:
    """Pagina în tonuri de gri, ca matrice numpy; întoarce și scara (pixeli pe punct)."""
    w, h = page_wh
    scale = DPI / 72
    if w * h * scale * scale > MAX_PX:
        scale = (MAX_PX / (w * h)) ** 0.5
    png = pdfcore.render_png(pdf_bytes, n, scale)
    im = Image.open(io.BytesIO(png)).convert("L")
    return np.asarray(im), scale


def remove_long_lines(gray: np.ndarray, px_mm: float, min_mm: float = 7.0, dark: int = 150, ragged: bool = True) -> np.ndarray:
    """Șterge liniile orizontale și verticale mai lungi de `min_mm` (cadre, linii de cotă, chenare),
    ca literele să rămână libere pentru OCR. Textul rămâne aproape intact."""
    b = gray < dark
    L = max(8, int(min_mm * px_mm))

    def runs(mask, L=L):  # pe rânduri: pixelii aflați în secvențe continue mai lungi de L
        out = np.zeros_like(mask)
        m = np.pad(mask, ((0, 0), (1, 1))).astype(np.int8)
        d = np.diff(m, axis=1)
        for r in np.nonzero(mask.any(axis=1))[0]:
            st = np.nonzero(d[r] == 1)[0]
            en = np.nonzero(d[r] == -1)[0]
            for s, e in zip(st, en):
                if e - s >= L:
                    out[r, s:e] = True
        return out

    def shift(m, k):
        out = np.zeros_like(m)
        if k > 0:
            out[:, k:] = m[:, :-k]
        elif k < 0:
            out[:, :k] = m[:, -k:]
        else:
            out[:] = m
        return out

    def close(mask, r=1):  # închidere pe rânduri: golurile de până la 2r pixeli (zgomot de scanare) se umplu
        d = mask.copy()
        for k in range(1, r + 1):
            d |= shift(mask, k) | shift(mask, -k)
        e = d.copy()
        for k in range(1, r + 1):
            e &= shift(d, k) & shift(d, -k)
        return e | mask

    def edges(core, mask):
        """Marginile zdrențuite ale liniei: pixelii lipiți de ea (până la 3 rânduri deasupra /
        dedesubt) care formează doar pete subțiri (≤ 3 pixeli pe verticală). Literele lipite de
        linie au trăsături verticale mai lungi și rămân."""
        near = core.copy()
        for k in (1, 2, 3):
            near[k:] |= core[:-k]
            near[:-k] |= core[k:]
        thin_v = mask & ~runs(mask.T, 4).T
        return near & thin_v & ~core

    hk = runs(close(b)) & b
    vk = (runs(close(b.T)) & b.T)
    kill = (hk | edges(hk, b) | (vk | edges(vk, b.T)).T) if ragged else (hk | vk.T)
    if not kill.any():
        return gray
    out = gray.copy()
    out[kill] = 255
    return out


def _denoise(gray: np.ndarray) -> np.ndarray:
    """Scanurile au „purici” și fond neuniform: filtru median 3×3 și prag Otsu → alb-negru curat.
    Randările curate din PDF vectorial trec practic neschimbate."""
    from PIL import ImageFilter

    from .vectorize import otsu

    im = Image.fromarray(gray).filter(ImageFilter.MedianFilter(3))
    a = np.asarray(im)
    t = otsu(a)
    return np.where(a < t, 0, 255).astype(np.uint8)


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
    """Corecturi tipice pe desene: Ø citit ca O, 0, @ sau © în fața unui număr; liniuțe lungi."""
    txt = re.sub(r"(?<![\w,.])[OQ0@©](?=\d{2,}(?:[.,]\d+)?(?:\b|[a-zA-Z]))", "Ø", txt)
    txt = re.sub(r"(?<![\w,.])[@©](?=\d)", "Ø", txt)
    return txt.replace("—", "-").replace("–", "-")


def _accept(w, min_conf):
    """Cuvintele „tehnice” (cote, toleranțe, filete) se acceptă și la încredere mai mică:
    Tesseract nu cunoaște Ø și scade încrederea pentru tot cuvântul."""
    if not any(ch.isalnum() for ch in w["t"]):
        return False
    if len(w["t"]) <= 3 and not w["t"].strip("lI|!ij.,'"):
        return False  # bucăți de linie citite ca litere
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
        # cuvinte prea depărtate pe același „rând” Tesseract sunt texte diferite (coloane de tabel)
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
        # bucățele de 1–2 caractere: doar dacă sunt cifre sau citite foarte sigur
        if len(compact) <= 2 and not (compact.isdigit() and conf_l >= 60) and conf_l < 80:
            continue
        x0 = min(w["x"] for w in ws)
        y0 = min(w["y"] for w in ws)
        x1 = max(w["x"] + w["w"] for w in ws)
        y1 = max(w["y"] + w["h"] for w in ws)
        txt = _fix(" ".join(w["t"] for w in ws))
        conf = sum(w["conf"] for w in ws) / len(ws)
        # înălțimea majusculelor și linia de bază: mediana pe cuvinte (caseta întregului rând se
        # umflă ușor din cauza unui singur cuvânt cu codițe sau a unei pete lipite de text)
        caps, bases = [], []
        for w in ws:
            t = w["t"]
            desc = any(ch in "gjpqyQ,;()[]{}|" for ch in t)
            tall = any(ch.isupper() or ch.isdigit() or ch in "bdfhklt/Ø" for ch in t)
            h = w["h"] / 1.3 if desc else w["h"]
            caps.append(h if tall else h / 0.72)  # doar litere mici fără codițe: înălțimea lui „x”
            bases.append(w["y"] + w["h"] - (w["h"] * 0.23 / 1.3 if desc else 0))
        caps.sort()
        bases.sort()
        med = caps[(len(caps) - 1) // 2]
        # o pată lipită de un cuvânt îi umflă caseta, niciodată nu o micșorează: contează cel mai mic
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
    # raportat la caseta mai mică: o bucată falsă din interiorul unui text citit corect se elimină
    ar = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return inter / ar if ar > 0 else 0.0


def estimate_skew(gray: np.ndarray) -> float:
    """Înclinarea scanului (grade, sens trigonometric pe ecran), din profilul de proiecție: la
    unghiul corect, liniile orizontale ale desenului cad pe cât mai puține rânduri."""
    im = Image.fromarray(np.where(gray < 150, 255, 0).astype(np.uint8))
    f = 1000 / max(im.size)
    if f < 1:
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))), Image.BILINEAR)

    def score(a):
        r = np.asarray(im.rotate(a, resample=Image.BILINEAR), np.float32)
        return float(np.var(r.sum(axis=1)) + np.var(r.sum(axis=0)))

    best = max(np.arange(-2.0, 2.01, 0.1), key=score)
    best = max(np.arange(best - 0.1, best + 0.101, 0.02), key=score)
    # rotirea care îndreaptă e `best`; înclinarea scanului e opusul ei
    return 0.0 if abs(best) < 0.05 else float(-best)


def _rot(p, deg, c):
    """Rotește punctul p (coordonate imagine, y în jos) cu `deg` grade în sens trigonometric pe ecran."""
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
    # scanul înclinat se îndreaptă întâi: liniile lungi devin exact orizontale / verticale și se pot
    # șterge fără să atingă literele; coordonatele se întorc la final în pagina originală
    skew = estimate_skew(den)
    work = den
    if skew:
        work = np.asarray(Image.fromarray(den).rotate(-skew, resample=Image.NEAREST, fillcolor=255))
    # pe scanuri liniile au margini zdrențuite care trebuie șterse și ele; pe randările curate
    # ale unui PDF vectorial ștergerea marginilor ar ciunti literele lipite de linii
    ragged = RAGGED if scan is None else scan
    if scan is None and RAGGED is None:
        ragged = bool(skew)
    clean = remove_long_lines(work, px_mm, ragged=ragged)
    img = Image.fromarray(clean)
    dpi = scale * 72
    lines = []
    for ln in _lines(_tesseract(img, lng, dpi), px_mm, 55):
        ln["rot"] = 0
        lines.append(ln)
    if rotated:
        H = clean.shape[0]
        rimg = img.rotate(-90, expand=True)  # textul scris de jos în sus devine orizontal
        for ln in _lines(_tesseract(rimg, lng, dpi), px_mm, 60):
            u0, v0, u1, v1 = ln["px"]
            ln["px"] = [v0, H - u1, v1, H - u0]
            # linia de bază orizontală din imaginea rotită devine verticală (x = v) în pagină
            ln["rot"] = 90
            lines.append(ln)
        # aceeași zonă citită în ambele orientări: rămâne citirea mai sigură
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
    """Textele reale din PDF (nu din imagine), cu încadrarea lor: pentru căutare."""
    import ctypes  # noqa: F401

    from .pdfcore import PDFIUM_LOCK, PageGeo, R, _bbox_page_space, _text_of, _walk, pdfium

    out = []
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[n]
            g = PageGeo.of(page)
            tp = page.get_textpage()
            for _oid, obj, typ, parent_total, _c, _n in _walk(page.raw):
                if typ != R.FPDF_PAGEOBJ_TEXT:
                    continue
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
