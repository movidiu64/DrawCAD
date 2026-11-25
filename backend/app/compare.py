"""Revision compare: two drawing pages rendered at the same scale and laid over each other.

Ink only in the older page is red (removed), only in the newer page green (added), in both gray.
A small tolerance (dilation) keeps anti-aliasing and sub-millimetre shifts from showing as changes;
an optional automatic alignment (phase correlation) removes an overall shift between the two exports.
Changed areas are grouped into rectangles, in the newer page's coordinates (pt), to step through.
"""
from __future__ import annotations

import io

import numpy as np

from . import pdfcore

INK = 200  # gray level under which a pixel is ink (faint gray lines count too)


def _dilate(m: np.ndarray, r: int) -> np.ndarray:
    """Binary dilation with a (2r+1)² square, by shifting (no scipy in the image)."""
    if r <= 0:
        return m.copy()
    out = m.copy()
    h, w = m.shape
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx == 0 and dy == 0:
                continue
            ys = slice(max(0, dy), h + min(0, dy))
            yd = slice(max(0, -dy), h + min(0, -dy))
            xs = slice(max(0, dx), w + min(0, dx))
            xd = slice(max(0, -dx), w + min(0, -dx))
            out[yd, xd] |= m[ys, xs]
    return out


def _shift(m: np.ndarray, dy: int, dx: int, fill=0) -> np.ndarray:
    out = np.full_like(m, fill)
    h, w = m.shape
    ys = slice(max(0, -dy), h - max(0, dy))
    yd = slice(max(0, dy), h - max(0, -dy))
    xs = slice(max(0, -dx), w - max(0, dx))
    xd = slice(max(0, dx), w - max(0, -dx))
    out[yd, xd] = m[ys, xs]
    return out


def _align(a: np.ndarray, b: np.ndarray, limit: float = 0.04) -> tuple[int, int]:
    """Shift (dy, dx) that moves `a` onto `b`, by phase correlation on a reduced copy; (0, 0) if the
    peak is weak or the shift larger than `limit` of the page (probably not the same drawing)."""
    k = 4
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    if h < 64 or w < 64:
        return 0, 0
    ra = a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    rb = b[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    fa = np.fft.fft2(ra - ra.mean())
    fb = np.fft.fft2(rb - rb.mean())
    r = fb * np.conj(fa)
    r /= np.abs(r) + 1e-9
    c = np.fft.ifft2(r).real
    iy, ix = np.unravel_index(np.argmax(c), c.shape)
    if c[iy, ix] < 0.05:
        return 0, 0
    hy, hx = c.shape
    sy = iy - hy if iy > hy // 2 else iy
    sx = ix - hx if ix > hx // 2 else ix
    if abs(sy) > hy * limit or abs(sx) > hx * limit:
        return 0, 0
    return int(sy * k), int(sx * k)


def _warp(old: np.ndarray, m: complex, t: complex, shape: tuple[int, int], fill=0) -> np.ndarray:
    """The older page (gray levels) moved, turned and scaled by z → m·z + t (pixels, z = x + iy),
    sampled on the newer page's grid (nearest pixel: the dilation tolerance absorbs the half pixel);
    outside the older page: `fill` (white)."""
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w]
    src = ((xs + 1j * ys) - t) / m
    sx = np.rint(src.real).astype(np.int64)
    sy = np.rint(src.imag).astype(np.int64)
    oh, ow = old.shape
    ok = (sx >= 0) & (sx < ow) & (sy >= 0) & (sy < oh)
    out = np.full((h, w), fill, dtype=old.dtype)
    out[ok] = old[sy[ok], sx[ok]]
    return out


def similarity(pairs) -> tuple[complex, complex] | None:
    """Two point pairs [[new, old], [new, old]] (pt, z = x + iy) → the similarity z_new = m·z_old + t;
    None if the points are too close (under 2 pt) or the scale is absurd."""
    (n1, o1), (n2, o2) = pairs
    zn1, zn2 = complex(*n1), complex(*n2)
    zo1, zo2 = complex(*o1), complex(*o2)
    if abs(zo2 - zo1) < 2 or abs(zn2 - zn1) < 2:
        return None
    m = (zn2 - zn1) / (zo2 - zo1)
    if not 0.05 <= abs(m) <= 20:
        return None
    return m, zn1 - m * zo1


def _regions(diff: np.ndarray, cell: int, scale: float, min_px: int = 6) -> list[list[float]]:
    """Changed areas: cells holding changed pixels, grouped by touching (8 neighbours), as rectangles
    in points, largest first."""
    h, w = diff.shape
    gh, gw = -(-h // cell), -(-w // cell)
    pad = np.zeros((gh * cell, gw * cell), dtype=bool)
    pad[:h, :w] = diff
    counts = pad.reshape(gh, cell, gw, cell).sum(axis=(1, 3))
    occ = counts >= min_px
    seen = np.zeros_like(occ)
    out = []
    for y0 in range(gh):
        for x0 in range(gw):
            if not occ[y0, x0] or seen[y0, x0]:
                continue
            stack = [(y0, x0)]
            seen[y0, x0] = True
            ys, xs = [], []
            while stack:
                y, x = stack.pop()
                ys.append(y)
                xs.append(x)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < gh and 0 <= nx < gw and occ[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            box = [min(xs) * cell, min(ys) * cell, (max(xs) + 1) * cell, (max(ys) + 1) * cell]
            out.append([round(v / scale, 2) for v in box])
    out.sort(key=lambda b: -(b[2] - b[0]) * (b[3] - b[1]))
    return out[:200]


def compare_pages(old_pdf: bytes, old_i: int, new_pdf: bytes, new_i: int, size_new: tuple[float, float],
                  size_old: tuple[float, float], align: bool = True, long_px: int = 2400, pairs=None) -> dict:
    """The overlay as RGB array, the changed regions (pt, newer page) and counts. `pairs` = two points
    picked on the newer page and the same two on the older one ([[new, old], [new, old]], pt): the older
    page is moved, turned and scaled onto the newer one (an export at another scale or rotated)."""
    wn, hn = size_new
    wo, ho = size_old
    s = long_px / max(wn, hn)
    new = pdfcore.render_array(new_pdf, new_i, s)
    sim = similarity(pairs) if pairs else None
    if pairs and sim is None:
        raise ValueError("Punctele de aliniere sunt prea apropiate")
    h, w = new.shape[:2]
    if sim:
        # the older page rendered so that, once scaled onto the newer one, one of its pixels is about
        # one pixel there (lines keep their width), then moved and turned by the two-point similarity
        m, t = sim
        so = min(s * abs(m), 6000 / max(wo, ho, 1))
        old = pdfcore.render_array(old_pdf, old_i, so)
        oldg = _warp(old, s * m / so, s * t, (h, w), fill=255)
    else:
        # the older page at the newer one's size (a sheet exported at another size is stretched to fit)
        so = s * min(wn / wo, hn / ho) if wo > 0 and ho > 0 else s
        old = pdfcore.render_array(old_pdf, old_i, so)
        if old.shape[:2] != (h, w):
            from PIL import Image

            old = np.asarray(Image.fromarray(old).resize((w, h), Image.BILINEAR))
        oldg = old
    a = oldg < INK
    b = new < INK
    dy = dx = 0
    if align:
        # after two points only the last pixels are left: no coarse search
        dy, dx = (0, 0) if sim else _align(a.astype(np.float32), b.astype(np.float32))
        # refine to the pixel around the coarse shift: the most ink in common
        best = (-1, dy, dx)
        for ey in range(-4, 5):
            for ex in range(-4, 5):
                sh = _shift(a, dy + ey, dx + ex)
                score = int(np.count_nonzero(sh & b))
                if score > best[0]:
                    best = (score, dy + ey, dx + ex)
        _s, dy, dx = best
        if dy or dx:
            a = _shift(a, dy, dx)
            oldg = _shift(oldg, dy, dx, fill=255)
    px_mm = s * 72 / 25.4
    tol = max(1, round(px_mm * 0.18))  # ≈ 0.18 mm on each side
    if sim:
        tol += 1  # resampling a scaled, turned page moves an edge by up to a pixel
    removed = a & ~_dilate(b, tol)
    added = b & ~_dilate(a, tol)
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    both = (a | b) & ~removed & ~added
    img[both] = (165, 170, 178)
    img[removed] = (214, 40, 40)
    img[added] = (24, 150, 60)
    cell = max(8, round(px_mm * 2.5))  # ≈ 2.5 mm cells: nearby changes become one area
    regions = _regions(_dilate(removed | added, 1), cell, s)
    return {
        "img": img, "scale": s, "regions": regions,
        "removed": int(removed.sum()), "added": int(added.sum()), "shift_mm": [round(dx / s / 72 * 25.4, 2), round(dy / s / 72 * 25.4, 2)],
        "old": oldg,  # the older page as laid under the newer one (aligned), gray levels
        "fit": {"scale": round(abs(sim[0]), 5), "angle": round(float(np.degrees(np.angle(sim[0]))), 3)} if sim else None,
    }


def overlay_png(res: dict) -> bytes:
    return pdfcore.png_from_array(res["img"])


def old_png(res: dict) -> bytes:
    """The older page, aligned on the newer one: for side by side and the curtain view."""
    return pdfcore.png_from_array(res["old"])


def overlay_pdf(res: dict, size: tuple[float, float], legend: str) -> bytes:
    """The comparison on a page of the newer drawing's size, with a one-line legend at the bottom."""
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    w, h = size
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h + 28))
    c.setCreator("DrawCAD")
    png = io.BytesIO(overlay_png(res))
    c.drawImage(ImageReader(png), 0, 28, w, h)
    pdfcore._register_font()
    c.setFont(pdfcore.FONT_NAME, 9)
    x = 12
    parts = legend.split("|")
    for (r, g, b), txt in zip(((214, 40, 40), (24, 150, 60), (120, 125, 133)), parts):
        c.setFillColorRGB(r / 255, g / 255, b / 255)
        c.rect(x, 10, 10, 8, stroke=0, fill=1)
        c.setFillColorRGB(0.1, 0.1, 0.1)
        c.drawString(x + 14, 11, txt.strip())
        x += 22 + c.stringWidth(txt.strip(), pdfcore.FONT_NAME, 9)
    c.showPage()
    c.save()
    return buf.getvalue()
