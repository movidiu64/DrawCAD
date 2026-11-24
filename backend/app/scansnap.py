"""Snap geometry for a scanned page, from its vectorization (docs/design/commands-v2.md, CMD-D9).

The vectorizer (vectorize.py) turns the page image into polylines with arcs (bulges) and circles,
in page points. Here they become the same snap data as for a vector PDF (pdfcore.snap_points):
characteristic points, straight segments and arcs [cx, cy, r, a0, sweep], with angles counter-
clockwise and Y up, as the browser's Snapper expects. The vectorization must not be straightened
(deskew off): the snap points have to sit on the image as it is shown.
"""
from __future__ import annotations

import math

MM = 72 / 25.4


def _bulge_arc(a, b, bulge):
    """The arc from a to b with a DXF bulge (counter-clockwise with Y up, on page coordinates with
    Y down): (cx, cy, r, a0, sweep) or None for a straight piece."""
    if abs(bulge) < 1e-9:
        return None
    # in Y-up coordinates the usual DXF formulas apply
    ax, ay = a[0], -a[1]
    bx, by = b[0], -b[1]
    cx_, cy_ = bx - ax, by - ay
    d = math.hypot(cx_, cy_)
    if d < 1e-9:
        return None
    k = (1 - bulge * bulge) / (4 * bulge)
    ux, uy = (ax + bx) / 2 - k * cy_, (ay + by) / 2 + k * cx_
    r = d * (1 + bulge * bulge) / (4 * abs(bulge))
    a0 = math.atan2(ay - uy, ax - ux)
    sw = 4 * math.atan(bulge)
    return ux, -uy, r, a0, sw


def to_snap(vec: dict, min_len: float = 1.0 * MM, min_r: float = 0.5 * MM) -> dict:
    """Vectorization → {pts, segs, arcs}. Pieces shorter than `min_len` (letters, specks) and
    circles smaller than `min_r` are left out: on a scan they are noise, not geometry."""
    pts, segs, arcs = [], [], []
    seen = set()

    def add(x, y, kind):
        key = (round(x, 2), round(y, 2), kind)
        if key in seen:
            return
        seen.add(key)
        pts.append([round(x, 3), round(y, 3), kind])

    for pl in vec.get("polys", []):
        P = pl.get("pts") or []
        if len(P) < 2:
            continue
        bul = list(pl.get("bulges") or []) + [0.0] * len(P)
        closed = bool(pl.get("closed"))
        n = len(P) if closed else len(P) - 1
        total = 0.0
        pieces = []
        for i in range(n):
            a, b = P[i], P[(i + 1) % len(P)]
            arc = _bulge_arc(a, b, bul[i])
            length = abs(arc[2] * arc[4]) if arc else math.hypot(b[0] - a[0], b[1] - a[1])
            total += length
            pieces.append((a, b, arc, length))
        if total < min_len:
            continue
        if not closed:
            add(P[0][0], P[0][1], "e")
            add(P[-1][0], P[-1][1], "e")
        for a, b, arc, length in pieces:
            add(b[0], b[1], "e")
            if length < min_len:
                continue
            if arc:
                cx, cy, r, a0, sw = arc
                arcs.append([round(cx, 3), round(cy, 3), round(r, 3), round(a0, 6), round(sw, 6)])
                add(cx, cy, "c")
                am = a0 + sw / 2
                add(cx + r * math.cos(am), cy - r * math.sin(am), "m")
            else:
                segs.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3)])
                add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, "m")
    for cx, cy, r in vec.get("circles", []):
        if r < min_r:
            continue
        arcs.append([round(cx, 3), round(cy, 3), round(r, 3), 0, round(2 * math.pi, 6)])
        add(cx, cy, "c")
        for i in range(4):
            th = i * math.pi / 2
            add(cx + r * math.cos(th), cy - r * math.sin(th), "q")
    return {"pts": pts, "segs": segs, "arcs": arcs, "truncated": False}
