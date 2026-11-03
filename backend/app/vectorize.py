"""Vectorizarea unui desen scanat (experimental): imaginea alb-negru devine linii, arce și cercuri.

Pașii: binarizare (prag Otsu) → textul recunoscut prin OCR se maschează (intră în DXF ca text, nu
ca mâzgălituri) → subțiere la un pixel (Zhang-Suen) → urmărirea scheletului într-un graf de
lanțuri între capete și noduri → eliminarea cârligelor scurte din noduri, legarea liniilor care
trec drept prin noduri → simplificare Douglas-Peucker → arce și cercuri potrivite pe pixeli →
îndreptarea scanului înclinat și alinierea liniilor aproape orizontale / verticale.

Rezultatul e o bază de lucru, nu un desen CAD curat: liniile întrerupte ies ca segmente scurte,
hașurile ca linii, săgețile ca mici triunghiuri. Rulează într-un proces separat, limitat
(python -m app.vectorize imagine.png ieșire.json scară [măști.json]).
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np

PT_MM = 25.4 / 72


# ---------------------------------------------------------------- binarizare și subțiere


def otsu(gray: np.ndarray) -> int:
    return otsu_hist(np.bincount(gray.ravel(), minlength=256))


def otsu_hist(hist) -> int:
    """Pragul Otsu dintr-o histogramă de 256 de valori (se poate aduna pe fâșii)."""
    hist = np.asarray(hist, dtype=np.float64)
    total = hist.sum()
    if total == 0:
        return 128
    w = np.cumsum(hist)
    mu = np.cumsum(hist * np.arange(256))
    mt = mu[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mt * w - mu * total) ** 2 / (w * (total - w))
    between[~np.isfinite(between)] = 0
    t = int(np.argmax(between))
    # desenele sunt mai ales alb: pragul nu coboară sub mijlocul dintre hârtie și cerneală
    return max(60, min(200, t))


def _neighbors_code(img: np.ndarray) -> np.ndarray:
    """Pentru fiecare pixel, vecinii lui ca număr pe 8 biți: N, NE, E, SE, S, SV, V, NV."""
    P = np.pad(img.astype(np.uint8, copy=False), 1)
    h, w = img.shape
    code = np.zeros((h, w), np.uint8)
    tmp = np.empty((h, w), np.uint8)  # o singură matrice de lucru, refolosită pentru toți vecinii
    shifts = [(0, 1), (0, 2), (1, 2), (2, 2), (2, 1), (2, 0), (1, 0), (0, 0)]
    for bit, (dy, dx) in enumerate(shifts):
        np.left_shift(P[dy:dy + h, dx:dx + w], bit, out=tmp)
        code |= tmp
    return code


def _zs_luts():
    lut = [np.zeros(256, bool), np.zeros(256, bool)]
    for c in range(256):
        p = [(c >> i) & 1 for i in range(8)]  # p2..p9
        B = sum(p)
        A = sum(1 for i in range(8) if p[i] == 0 and p[(i + 1) % 8] == 1)
        p2, p3, p4, p5, p6, p7, p8, p9 = p
        ok = 2 <= B <= 6 and A == 1
        lut[0][c] = ok and p2 * p4 * p6 == 0 and p4 * p6 * p8 == 0
        lut[1][c] = ok and p2 * p4 * p8 == 0 and p2 * p6 * p8 == 0
    return lut


_LUT = _zs_luts()


def thin(b: np.ndarray, max_iter: int = 60) -> np.ndarray:
    img = b.astype(np.uint8)
    for _ in range(max_iter):
        changed = False
        for step in (0, 1):
            code = _neighbors_code(img)
            m = _LUT[step][code]
            del code
            m &= img.view(bool)  # img are doar 0 / 1
            if m.any():
                img[m] = 0
                changed = True
        if not changed:
            break
    # „treptele” rămase (un pixel în colțul unui L) se scot, ca fiecare pixel de lanț să aibă 2 vecini
    N, NE, E, SE, S, SW, W, NW = (1 << i for i in range(8))
    rules = [
        (N | E, S | W | SW),
        (S | E, N | W | NW),
        (S | W, N | E | NE),
        (N | W, S | E | SE),
    ]
    for need, none in rules:
        code = _neighbors_code(img)
        m = (img == 1) & ((code & need) == need) & ((code & none) == 0)
        img[m] = 0
    return img


# ---------------------------------------------------------------- graful scheletului


def trace(sk: np.ndarray):
    """Lanțuri de pixeli între capete / noduri, plus buclele închise. Coordonate în pixeli."""
    h, w = sk.shape
    Wp = w + 2
    pad = np.pad(sk, 1).astype(np.uint8)
    code = _neighbors_code(sk)
    deg_img = np.zeros_like(pad)
    popcnt = np.array([bin(i).count("1") for i in range(256)], np.uint8)
    deg_img[1:-1, 1:-1] = np.where(sk == 1, popcnt[code], 0)
    S = bytes(pad.ravel())
    D = bytes(deg_img.ravel())
    del code
    offs = (-Wp - 1, -Wp, -Wp + 1, -1, 1, Wp - 1, Wp, Wp + 1)
    flat = np.flatnonzero(pad.ravel())
    degf = deg_img.ravel()[flat]
    nodes = flat[degf != 2].tolist()

    # nodurile (≥3 vecini) alăturate formează un singur nod
    cid = {}
    cpts = []
    for n in nodes:
        if D[n] < 3 or n in cid:
            continue
        k = len(cpts)
        stack = [n]
        cid[n] = k
        members = []
        while stack:
            q = stack.pop()
            members.append(q)
            for o in offs:
                r = q + o
                if S[r] and D[r] >= 3 and r not in cid:
                    cid[r] = k
                    stack.append(r)
        xs = [m % Wp - 1 + 0.5 for m in members]
        ys = [m // Wp - 1 + 0.5 for m in members]
        cpts.append((sum(xs) / len(xs), sum(ys) / len(ys)))

    def key(n):
        return ("c", cid[n]) if n in cid else ("e", n)

    def xy(n):
        return (n % Wp - 1 + 0.5, n // Wp - 1 + 0.5)

    visited = bytearray(len(S))
    edges = []  # (cheie_a, cheie_b, [puncte])
    seen_pairs = set()
    for n in nodes:
        for o in offs:
            nb = n + o
            if not S[nb]:
                continue
            if D[nb] != 2:
                ka, kb = key(n), key(nb)
                if ka != kb:
                    pair = (min(n, nb), max(n, nb))
                    if pair not in seen_pairs:
                        seen_pairs.add(pair)
                        edges.append((ka, kb, [n, nb]))
                continue
            if visited[nb]:
                continue
            chain = [n, nb]
            visited[nb] = 1
            prev, cur = n, nb
            while True:
                nxt = -1
                for o2 in offs:
                    q = cur + o2
                    if q == prev or not S[q]:
                        continue
                    if D[q] != 2 or not visited[q]:
                        nxt = q
                        break
                if nxt < 0:
                    break
                chain.append(nxt)
                if D[nxt] != 2:
                    break
                visited[nxt] = 1
                prev, cur = cur, nxt
            end = chain[-1]
            kb = key(end) if D[end] != 2 else ("e", end)
            edges.append((key(n), kb, chain))
    # bucle fără noduri (cercuri, contururi închise)
    loops = []
    for start in flat[degf == 2].tolist():
        if visited[start]:
            continue
        chain = [start]
        visited[start] = 1
        cur = start
        while True:
            nxt = -1
            for o in offs:
                q = cur + o
                if S[q] and D[q] == 2 and not visited[q]:
                    nxt = q
                    break
            if nxt < 0:
                break
            visited[nxt] = 1
            chain.append(nxt)
            cur = nxt
        if len(chain) >= 8:
            loops.append([xy(q) for q in chain])

    out = []
    for i, (ka, kb, chain) in enumerate(edges):
        edges[i] = None  # lanțul de indici nu mai trebuie: memoria lui se refolosește pentru puncte
        pts = [xy(q) for q in chain]
        if ka[0] == "c":
            pts[0] = cpts[ka[1]]
        if kb[0] == "c":
            pts[-1] = cpts[kb[1]]
        out.append([ka, kb, pts])
    return out, loops


def _length(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def _dir_from(pts, at_start, span):
    """Direcția (unitară) cu care un lanț pleacă din capătul dat, măsurată pe ~`span` pixeli."""
    seq = pts if at_start else pts[::-1]
    p0 = seq[0]
    acc = 0.0
    q = seq[-1]
    for a, b in zip(seq, seq[1:]):
        acc += math.hypot(b[0] - a[0], b[1] - a[1])
        if acc >= span:
            q = b
            break
    dx, dy = q[0] - p0[0], q[1] - p0[1]
    n = math.hypot(dx, dy)
    return (dx / n, dy / n) if n > 0 else (0.0, 0.0)


def clean_graph(edges, px_mm):
    """Scoate cârligele scurte și bucățile izolate, apoi leagă lanțurile prin nodurile rămase cu
    două ramuri și prin nodurile unde o linie trece drept (T, X)."""
    spur = 1.2 * px_mm
    tiny = 0.6 * px_mm
    E = {i: e for i, e in enumerate(edges)}

    def adjacency():
        adj = {}
        for i, (ka, kb, _p) in E.items():
            adj.setdefault(ka, []).append(i)
            adj.setdefault(kb, []).append(i)
        return adj

    for _ in range(3):
        adj = adjacency()
        removed = False
        for i, (ka, kb, pts) in list(E.items()):
            L = _length(pts)
            da, db = len(adj.get(ka, [])), len(adj.get(kb, []))
            if ka == kb and L < spur * 2:
                del E[i]
                removed = True
            elif da == 1 and db == 1 and L < tiny:
                del E[i]
                removed = True
            elif (da == 1) != (db == 1) and min(da, db) == 1 and max(da, db) >= 3 and L < spur:
                del E[i]
                removed = True
        if not removed:
            break

    # perechi de ramuri opuse într-un nod: aceeași linie care trece prin nod
    nid = [len(E) + 1000000]

    def merge(i, j, k):
        ka, kb, p = E[i]
        kc, kd, q = E[j]
        if kb != k:
            ka, kb, p = kb, ka, p[::-1]
        if kc != k:
            kc, kd, q = kd, kc, q[::-1]
        E[i] = (ka, kd, p + q[1:])
        del E[j]

    span = 3 * px_mm
    changed = True
    guard = 0
    while changed and guard < 20:
        guard += 1
        changed = False
        adj = adjacency()
        for k, ids in adj.items():
            ids = [i for i in ids if i in E]
            if len(ids) == 2 and ids[0] != ids[1] and k[0] == "c":
                merge(ids[0], ids[1], k)
                changed = True
                break
            if len(ids) >= 3:
                dirs = {}
                for i in ids:
                    ka, kb, p = E[i]
                    if ka == kb:
                        continue
                    dirs[i] = _dir_from(p, ka == k, span)
                best = None
                for a in dirs:
                    for b in dirs:
                        if a >= b:
                            continue
                        dot = dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1]
                        if dot < -0.975 and (best is None or dot < best[0]):
                            best = (dot, a, b)
                if best:
                    # nodul se „desface”: ramura trece mai departe, cheia ei devine unică
                    _d, a, b = best
                    merge(a, b, k)
                    ka, kd, p = E[a]
                    nid[0] += 1
                    changed = True
                    break
    return list(E.values())


# ---------------------------------------------------------------- simplificare și arce


def douglas_peucker(P: np.ndarray, tol: float) -> list[int]:
    n = len(P)
    if n < 3:
        return list(range(n))
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = P[i], P[j]
        d = b - a
        L = math.hypot(d[0], d[1])
        seg = P[i + 1:j]
        if L < 1e-9:
            dist = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1])
        else:
            dist = np.abs(d[0] * (seg[:, 1] - a[1]) - d[1] * (seg[:, 0] - a[0])) / L
        k = int(np.argmax(dist))
        if dist[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return np.flatnonzero(keep).tolist()


def fit_circle(P: np.ndarray):
    """Cercul celor mai mici pătrate (Kåsa): (cx, cy, r, rms, max)."""
    x, y = P[:, 0], P[:, 1]
    A = np.column_stack([x, y, np.ones_like(x)])
    bvec = x * x + y * y
    try:
        sol, *_ = np.linalg.lstsq(A, bvec, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy = sol[0] / 2, sol[1] / 2
    r2 = sol[2] + cx * cx + cy * cy
    if r2 <= 0:
        return None
    r = math.sqrt(r2)
    res = np.abs(np.hypot(x - cx, y - cy) - r)
    return cx, cy, r, float(np.sqrt(np.mean(res * res))), float(res.max())


def _sweep(P, cx, cy):
    a = np.arctan2(-(P[:, 1] - cy), P[:, 0] - cx)
    d = np.diff(a)
    d = (d + np.pi) % (2 * np.pi) - np.pi
    return float(d.sum())


def _arc_ok(P, px_mm):
    if len(P) < 6:
        return None
    f = fit_circle(P)
    if not f:
        return None
    cx, cy, r, rms, mx = f
    if r < 0.4 * px_mm or r > 400 * px_mm:
        return None
    if rms > 0.38 + 0.0008 * r or mx > 1.1 + 0.002 * r:
        return None
    sw = _sweep(P, cx, cy)
    if abs(sw) < math.radians(12):
        return None
    # arcul trebuie să se depărteze clar de coarda lui (altfel e o linie)
    a, b = P[0], P[-1]
    chord = math.hypot(b[0] - a[0], b[1] - a[1])
    sag = r * (1 - math.cos(min(abs(sw), math.pi) / 2)) if chord > 0 else r
    if sag < 1.6:
        return None
    return cx, cy, r, sw


def to_primitives(pts, closed, px_mm, tol):
    """Un lanț de pixeli → polilinie cu arce ({pts, bulges, closed}) sau cerc (cx, cy, r)."""
    P = np.asarray(pts, np.float64)
    if closed or (len(P) > 12 and math.hypot(*(P[0] - P[-1])) < 1.5):
        f = fit_circle(P)
        if f:
            cx, cy, r, rms, mx = f
            if r >= 0.4 * px_mm and rms < 0.45 + 0.004 * r and mx < 1.3 + 0.012 * r and abs(_sweep(P, cx, cy)) > 1.9 * math.pi:
                return ("circle", (cx, cy, r))
    V = douglas_peucker(P, tol)
    # 1. bucăți: linii între vârfuri DP sau arce peste mai multe vârfuri DP la rând
    pieces = []  # ["L", i0, i1] sau ["A", i0, i1, (cx, cy, r)] cu indici de pixeli
    i = 0
    nseg = len(V) - 1
    while i < nseg:
        best = None
        if i + 2 <= nseg:
            j = i + 2
            while j <= nseg:
                turns = []
                for k in range(i, j - 1):
                    u = P[V[k + 1]] - P[V[k]]
                    w = P[V[k + 2]] - P[V[k + 1]]
                    turns.append(math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]))
                # toate cotiturile în același sens și line (fără colțuri ascuțite)
                if not turns or max(abs(t) for t in turns) > math.radians(55) or (min(turns) < 0 < max(turns)):
                    break
                arc = _arc_ok(P[V[i]:V[j] + 1], px_mm)
                if not arc:
                    break
                best = (j, arc)
                j += 1
        if best:
            j, arc = best
            pieces.append(["A", V[i], V[j], arc[:3]])
            i = j
        else:
            pieces.append(["L", V[i], V[i + 1]])
            i += 1
    # 2. arce vecine din același cerc → un singur arc; cercul se recalculează doar pe pixelii
    #    care chiar sunt pe arc (capetele drepte, din liniile tangente, se taie)
    merged = []
    for pc in pieces:
        if pc[0] == "A" and merged and merged[-1][0] == "A":
            c0, c1 = merged[-1][3], pc[3]
            if math.hypot(c0[0] - c1[0], c0[1] - c1[1]) < 0.25 * max(c0[2], c1[2]) and abs(c0[2] - c1[2]) < 0.25 * max(c0[2], c1[2]):
                merged[-1] = ["A", merged[-1][1], pc[2], c0]
                continue
        merged.append(pc)
    pieces = merged
    for pc in pieces:
        if pc[0] != "A":
            continue
        s0, s1 = pc[1], pc[2]
        circ = None
        for _ in range(4):
            f = fit_circle(P[s0:s1 + 1]) if s1 - s0 >= 5 else None
            if not f:
                break
            cx, cy, r = f[:3]
            circ = (cx, cy, r)
            res = np.abs(np.hypot(P[s0:s1 + 1, 0] - cx, P[s0:s1 + 1, 1] - cy) - r)
            lim = 0.9
            n0 = s0
            while n0 < s1 - 5 and res[n0 - s0] > lim:
                n0 += 1
            n1 = s1
            while n1 > n0 + 5 and res[n1 - s0] > lim:
                n1 -= 1
            if n0 == s0 and n1 == s1:
                break
            s0, s1 = n0, n1
        if circ:
            pc[3] = circ
    # 3. vârfurile: capetele DP; la trecerea linie → arc vârful se mută în punctul de tangență
    #    (piciorul perpendicularei din centru pe linie), ca racordarea să fie tangentă ca în CAD
    verts = [list(P[pieces[0][1]])] + [list(P[pc[2]]) for pc in pieces]

    def foot(cx, cy, a, b):
        d = b - a
        L2 = float(d @ d)
        if L2 < 1e-9:
            return None, None
        t = float(((cx - a[0]) * d[0] + (cy - a[1]) * d[1]) / L2)
        q = a + t * d
        return q, t

    for k, pc in enumerate(pieces):
        if pc[0] != "A":
            continue
        cx, cy, r = pc[3]
        tolT = max(1.5, 0.08 * r)
        if k > 0 and pieces[k - 1][0] == "L":
            a = P[pieces[k - 1][1]]
            b = P[pieces[k - 1][2]]
            q, t = foot(cx, cy, a, b)
            if q is not None and t > 0.2 and abs(math.hypot(q[0] - cx, q[1] - cy) - r) < tolT:
                verts[k] = list(q)
        if k + 1 < len(pieces) and pieces[k + 1][0] == "L":
            a = P[pieces[k + 1][2]]
            b = P[pieces[k + 1][1]]
            q, t = foot(cx, cy, a, b)
            if q is not None and t > 0.2 and abs(math.hypot(q[0] - cx, q[1] - cy) - r) < tolT:
                verts[k + 1] = list(q)
    bulges = []
    for k, pc in enumerate(pieces):
        if pc[0] != "A":
            bulges.append(0.0)
            continue
        cx, cy, r = pc[3]
        A, B = verts[k], verts[k + 1]
        # sensul îl dă lanțul de pixeli; mărimea, unghiul dintre capetele (mutate) ale arcului
        sw_dir = _sweep(P[pc[1]:pc[2] + 1], cx, cy)
        a0 = math.atan2(-(A[1] - cy), A[0] - cx)
        a1 = math.atan2(-(B[1] - cy), B[0] - cx)
        d = (a1 - a0) % (2 * math.pi)
        if sw_dir < 0:
            d -= 2 * math.pi
        if abs(abs(d) - abs(sw_dir)) > math.pi:  # capetele au trecut unul de altul: se păstrează arcul inițial
            d = sw_dir
        bulges.append(math.tan(d / 4))
    # 4. vârfurile rămase pe o linie dreaptă (între două segmente drepte) se scot
    if closed and len(verts) > 3 and math.hypot(verts[0][0] - verts[-1][0], verts[0][1] - verts[-1][1]) < 1.5:
        verts.pop()
        ring = True
    else:
        ring = False
        bulges.append(0.0)
    changed = True
    while changed and len(verts) > (3 if ring else 2):
        changed = False
        n = len(verts)
        rng = range(n) if ring else range(1, n - 1)
        for k in rng:
            if bulges[k - 1] or bulges[k]:
                continue
            a, m, b = verts[k - 1], verts[k], verts[(k + 1) % n]
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy)
            if L < 1e-9:
                continue
            dev = abs(dx * (m[1] - a[1]) - dy * (m[0] - a[0])) / L
            u = (m[0] - a[0]) * dx + (m[1] - a[1]) * dy
            if dev < 0.9 * tol and 0 < u < L * L:
                del verts[k]
                del bulges[k]
                changed = True
                break
    out_pts = [tuple(v) for v in verts]
    if ring:
        return ("poly", {"pts": out_pts, "bulges": bulges, "closed": True})
    return ("poly", {"pts": out_pts, "bulges": bulges, "closed": False})


# ---------------------------------------------------------------- înclinare și aliniere


def estimate_skew(polys) -> float:
    """Unghiul (grade, sens trigonometric pe ecran) cu care e înclinat scanul, din liniile lungi."""
    angs, ws = [], []
    for pl in polys:
        pts, bul = pl["pts"], pl["bulges"]
        for k in range(len(pts) - 1):
            if bul[k]:
                continue
            dx, dy = pts[k + 1][0] - pts[k][0], -(pts[k + 1][1] - pts[k][1])
            L = math.hypot(dx, dy)
            if L < 40:
                continue
            a = math.degrees(math.atan2(dy, dx)) % 90
            if a > 45:
                a -= 90
            if abs(a) < 3:
                angs.append(a)
                ws.append(L)
    if len(angs) < 3:
        return 0.0
    order = np.argsort(angs)
    a = np.asarray(angs)[order]
    w = np.cumsum(np.asarray(ws)[order])
    med = float(a[np.searchsorted(w, w[-1] / 2)])
    return med if abs(med) >= 0.03 else 0.0


def rotate_all(polys, circles, deg, cx, cy):
    t = math.radians(-deg)
    c, s = math.cos(t), math.sin(t)

    def R(p):
        dx, dy = p[0] - cx, -(p[1] - cy)
        return (cx + dx * c - dy * s, cy - (dx * s + dy * c))

    for pl in polys:
        pl["pts"] = [R(p) for p in pl["pts"]]
    return polys, [(*R((x, y)), r) for x, y, r in circles]


def snap_ortho(polys, max_deg=0.6, min_len=10.0):
    lim = math.tan(math.radians(max_deg))
    for pl in polys:
        pts = [list(p) for p in pl["pts"]]
        n = len(pts)
        segs = range(n if pl["closed"] else n - 1)
        for k in segs:
            if pl["bulges"][k]:
                continue
            a, b = pts[k], pts[(k + 1) % n]
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy)
            if L < min_len:
                continue
            if abs(dy) <= lim * abs(dx):
                m = (a[1] + b[1]) / 2
                a[1] = b[1] = m
            elif abs(dx) <= lim * abs(dy):
                m = (a[0] + b[0]) / 2
                a[0] = b[0] = m
        pl["pts"] = [tuple(p) for p in pts]
    return polys


# ---------------------------------------------------------------- tot procesul


def vectorize(gray: np.ndarray, px_per_pt: float, masks=(), deskew=True) -> dict:
    px_mm = px_per_pt / PT_MM
    thr = otsu(gray)
    b = gray < thr
    for x0, y0, x1, y1 in masks:
        X0, Y0 = max(0, int(x0 * px_per_pt) - 1), max(0, int(y0 * px_per_pt) - 1)
        X1, Y1 = int(math.ceil(x1 * px_per_pt)) + 1, int(math.ceil(y1 * px_per_pt)) + 1
        b[Y0:Y1, X0:X1] = False
    sk = thin(b)
    edges, loops = trace(sk)
    edges = clean_graph(edges, px_mm)
    tol = max(1.3, 0.16 * px_mm)
    polys, circles = [], []
    for ka, kb, pts in edges:
        if len(pts) < 2:
            continue
        kind, val = to_primitives(pts, ka == kb and ka[0] == "c", px_mm, tol)
        (circles if kind == "circle" else polys).append(val)
    for pts in loops:
        kind, val = to_primitives(pts, True, px_mm, tol)
        (circles if kind == "circle" else polys).append(val)
    h, w = gray.shape
    skew = estimate_skew(polys) if deskew else 0.0
    if skew:
        polys, circles = rotate_all(polys, circles, skew, w / 2, h / 2)
    polys = snap_ortho(polys, min_len=max(10.0, 2 * px_mm))
    k = 1 / px_per_pt
    out_p = []
    for pl in polys:
        out_p.append({
            "pts": [[round(x * k, 3), round(y * k, 3)] for x, y in pl["pts"]],
            "bulges": [round(v, 6) for v in pl["bulges"]],
            "closed": pl["closed"],
        })
    return {
        "polys": out_p,
        "circles": [[round(x * k, 3), round(y * k, 3), round(r * k, 3)] for x, y, r in circles],
        "skew": round(-skew, 4),  # rotația aplicată (grade, sens trigonometric pe ecran)
        "threshold": thr,
    }


def _emit(path, obj):
    txt = json.dumps(obj)
    try:
        with open(path + ".status", "w", encoding="utf-8") as f:
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
    from PIL import Image

    from .ingest import _limit_self

    _limit_self()
    out = argv[2]
    try:
        Image.MAX_IMAGE_PIXELS = 120_000_000
        gray = np.asarray(Image.open(argv[1]).convert("L"))
        scale = float(argv[3])
        masks = []
        if len(argv) > 4:
            with open(argv[4], encoding="utf-8") as f:
                masks = [m for m in json.load(f) if isinstance(m, list) and len(m) == 4]
        res = vectorize(gray, scale, masks)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f)
        _emit(out, {"ok": True, "polys": len(res["polys"]), "circles": len(res["circles"])})
        return 0
    except MemoryError:
        _emit(out, {"ok": False, "error": "Vectorizarea cere prea multă memorie"})
        return 3
    except Exception as e:  # noqa: BLE001
        _emit(out, {"ok": False, "error": f"Vectorizare eșuată: {e}"})
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
