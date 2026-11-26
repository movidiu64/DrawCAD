// OFFSET, TRIM and EXTEND on drawn shapes, with AutoCAD's logic (Quick mode: every shape on the page
// and the drawing's own vector geometry are cutting and boundary edges).
// Coordinates in visual PDF points (y down); angles on screen, counter-clockwise.
// Edges: segments [x1, y1, x2, y2] and arcs [cx, cy, r, a0, signed sweep], as in osnap.js.
import { arcGeom, rectCorners } from "./shapes.js";
import { inArc, lineLine, lineCircle, circleCircle } from "./osnap.js";

const TAU = Math.PI * 2;
const EPS = 1e-6;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const angOf = (c, p) => Math.atan2(-(p[1] - c[1]), p[0] - c[0]);
const polar = (c, r, th) => [c[0] + r * Math.cos(th), c[1] - r * Math.sin(th)];
const wrap = (x) => ((x % TAU) + TAU) % TAU;

/** Shape kinds each command works on. */
export const OFFSET_KINDS = new Set(["line", "poly", "rect", "circle", "arc"]);
export const TRIM_KINDS = OFFSET_KINDS;
export const EXTEND_KINDS = new Set(["line", "poly", "arc"]);

// ------------------------------------------------------------------ paths

/**
 * The shape as a path of elements: lines { t: "L", a, b } or one arc { t: "A", c, r, a0, sw }.
 * null for shapes these commands do not handle.
 */
export function toPath(a) {
  const P = a.pts || [];
  const lines = (Q, closed) => {
    const els = [];
    const n = Q.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = Q[i];
      const q = Q[(i + 1) % n];
      if (dist(p, q) > EPS) els.push({ t: "L", a: p, b: q });
    }
    return els.length ? { closed, els } : null;
  };
  switch (a.kind) {
    case "line":
      return P.length >= 2 ? lines([P[0], P[1]], false) : null;
    case "poly":
      return P.length >= 2 ? lines(P, !!a.closed && P.length > 2) : null;
    case "rect":
      return P.length >= 2 ? lines(rectCorners(a), true) : null;
    case "circle": {
      if (P.length < 2) return null;
      const r = dist(P[0], P[1]);
      return r > EPS ? { closed: true, els: [{ t: "A", c: P[0], r, a0: angOf(P[0], P[1]), sw: TAU }] } : null;
    }
    case "arc": {
      if (P.length < 3) return null;
      const g = arcGeom(a);
      return g.r > EPS ? { closed: Math.abs(g.sw) >= TAU - EPS, els: [{ t: "A", c: g.c, r: g.r, a0: g.a0, sw: g.sw }] } : null;
    }
    default:
      return null;
  }
}

function elPoint(e, t) {
  if (e.t === "L") return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  return polar(e.c, e.r, e.a0 + e.sw * t);
}

function elLen(e) {
  return e.t === "L" ? dist(e.a, e.b) : e.r * Math.abs(e.sw);
}

/** Parameter (0…1) of an angle on an arc element, or null when the angle is outside it. */
function arcT(e, th) {
  const rel = e.sw > 0 ? wrap(th - e.a0) : wrap(e.a0 - th);
  const s = Math.abs(e.sw);
  if (rel <= s + EPS) return Math.min(1, rel / s);
  if (TAU - rel < EPS) return 0;
  return null;
}

/** The point of the element nearest to p: { t, d }. */
function project(e, p) {
  if (e.t === "L") {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    const L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / L2));
    return { t, d: dist(p, elPoint(e, t)) };
  }
  let t = arcT(e, angOf(e.c, p));
  if (t == null) t = dist(p, elPoint(e, 0)) <= dist(p, elPoint(e, 1)) ? 0 : 1;
  return { t, d: dist(p, elPoint(e, t)) };
}

/** The path parameter nearest to p (element index + parameter on it) and the distance. */
export function pathParam(path, p) {
  let best = { s: 0, d: Infinity };
  path.els.forEach((e, i) => {
    const q = project(e, p);
    if (q.d < best.d) best = { s: i + q.t, d: q.d };
  });
  return best;
}

/** Parameters (0…1) where the edges cross the element. */
function cutsOn(e, edges) {
  const out = [];
  const okU = (u) => u >= -EPS && u <= 1 + EPS;
  if (e.t === "L") {
    const d = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
    for (const s of edges.segs || []) {
      const r = lineLine(e.a, d, [s[0], s[1]], [s[2] - s[0], s[3] - s[1]]);
      if (r && okU(r.t) && okU(r.u)) out.push(r.t);
    }
    for (const g of edges.arcs || []) {
      for (const h of lineCircle(e.a, d, [g[0], g[1]], g[2])) {
        if (okU(h.t) && inArc(g, angOf([g[0], g[1]], h.p))) out.push(h.t);
      }
    }
  } else {
    for (const s of edges.segs || []) {
      for (const h of lineCircle([s[0], s[1]], [s[2] - s[0], s[3] - s[1]], e.c, e.r)) {
        if (!okU(h.t)) continue;
        const t = arcT(e, angOf(e.c, h.p));
        if (t != null) out.push(t);
      }
    }
    for (const g of edges.arcs || []) {
      for (const p of circleCircle(e.c, e.r, [g[0], g[1]], g[2])) {
        if (!inArc(g, angOf([g[0], g[1]], p))) continue;
        const t = arcT(e, angOf(e.c, p));
        if (t != null) out.push(t);
      }
    }
  }
  return out.map((t) => Math.max(0, Math.min(1, t)));
}

/** All cut parameters along the path, sorted, without repeats (a vertex is met by two elements). */
export function pathCuts(path, edges) {
  const all = [];
  path.els.forEach((e, i) => {
    for (const t of cutsOn(e, edges)) all.push(i + t);
  });
  all.sort((p, q) => p - q);
  const n = path.els.length;
  const out = [];
  for (const c of all) {
    if (out.length && c - out[out.length - 1] < 1e-7) continue;
    out.push(c);
  }
  // on a closed path 0 and n are the same point
  if (path.closed && out.length > 1 && out[0] < 1e-7 && n - out[out.length - 1] < 1e-7) out.pop();
  return out;
}

function pointAt(path, g) {
  const n = path.els.length;
  if (path.closed) g = ((g % n) + n) % n;
  const i = Math.min(Math.floor(g), n - 1);
  return elPoint(path.els[i], g - i);
}

/** The part of the path between parameters p < q (q may pass n on a closed path): elements. */
function subPath(path, p, q) {
  const n = path.els.length;
  if (path.els[0].t === "A") {
    const e = path.els[0];
    return [{ t: "A", c: e.c, r: e.r, a0: e.a0 + e.sw * p, sw: e.sw * (q - p) }];
  }
  const out = [];
  let g = p;
  while (g < q - 1e-9) {
    const k = Math.floor(g + 1e-9);
    const end = Math.min(q, k + 1);
    const e = path.els[((k % n) + n) % n];
    const a = elPoint(e, g - k);
    const b = elPoint(e, end - k);
    if (dist(a, b) > EPS) out.push({ t: "L", a, b });
    g = end;
  }
  return out;
}

/** Points along the elements (arcs approximated), for previews. */
export function elsPoints(els) {
  const pts = [];
  for (const e of els) {
    if (e.t === "L") {
      if (!pts.length) pts.push(e.a);
      pts.push(e.b);
    } else {
      const n = Math.max(8, Math.ceil((Math.abs(e.sw) * 180) / Math.PI / 3));
      for (let i = pts.length ? 1 : 0; i <= n; i++) pts.push(elPoint(e, i / n));
    }
  }
  return pts;
}

/** The shape fields of a piece made of elements: line, open polyline or arc. */
function pieceOf(els, kind) {
  if (!els.length) return null;
  if (els[0].t === "A") {
    const e = els[0];
    if (e.r * Math.abs(e.sw) < 1e-3) return null;
    return { kind: "arc", pts: [e.c, polar(e.c, e.r, e.a0), polar(e.c, e.r, e.a0 + e.sw)], ccw: e.sw > 0, closed: undefined };
  }
  const pts = elsPoints(els);
  if (els.reduce((s, e) => s + elLen(e), 0) < 1e-3) return null;
  if (kind === "line") return { kind: "line", pts: [pts[0], pts[pts.length - 1]] };
  return { kind: "poly", pts, closed: false };
}

// ------------------------------------------------------------------ TRIM

/**
 * TRIM at the picked point: the part between the nearest cutting edges on either side is removed.
 * Returns { pieces: [shape fields…], gone: [points] } (no pieces: the whole shape goes, as in AutoCAD's
 * Quick mode when nothing crosses it) or { err: "kind" | "one" }.
 */
export function trimShape(a, pick, edges) {
  if (!TRIM_KINDS.has(a.kind)) return { err: "kind" };
  const path = toPath(a);
  if (!path) return { err: "kind" };
  const n = path.els.length;
  const { s } = pathParam(path, pick);
  let cuts = pathCuts(path, edges);
  if (!path.closed) cuts = cuts.filter((c) => c > 1e-7 && c < n - 1e-7);
  const whole = { pieces: [], gone: elsPoints(path.els), whole: true };
  if (!cuts.length) return whole;
  if (path.closed) {
    if (cuts.length < 2) return { err: "one" };
    const below = cuts.filter((c) => c < s);
    const above = cuts.filter((c) => c > s);
    const lo = below.length ? below[below.length - 1] : cuts[cuts.length - 1] - n;
    const hi = above.length ? above[0] : cuts[0] + n;
    const keep = pieceOf(subPath(path, hi, lo + n), a.kind === "line" ? "line" : "poly");
    return { pieces: keep ? [keep] : [], gone: elsPoints(subPath(path, lo, hi)) };
  }
  const below = cuts.filter((c) => c < s);
  const above = cuts.filter((c) => c > s);
  const lo = below.length ? below[below.length - 1] : 0;
  const hi = above.length ? above[0] : n;
  const pieces = [];
  if (lo > 0) pieces.push(pieceOf(subPath(path, 0, lo), a.kind));
  if (hi < n) pieces.push(pieceOf(subPath(path, hi, n), a.kind));
  return { pieces: pieces.filter(Boolean), gone: elsPoints(subPath(path, lo, hi)) };
}

// ------------------------------------------------------------------ EXTEND

/** The nearest t > 0 where the ray p + t·d meets an edge. */
function rayHit(p, d, edges) {
  let best = Infinity;
  for (const s of edges.segs || []) {
    const r = lineLine(p, d, [s[0], s[1]], [s[2] - s[0], s[3] - s[1]]);
    if (r && r.t > 1e-6 && r.u >= -EPS && r.u <= 1 + EPS && r.t < best) best = r.t;
  }
  for (const g of edges.arcs || []) {
    for (const h of lineCircle(p, d, [g[0], g[1]], g[2])) {
      if (h.t > 1e-6 && h.t < best && inArc(g, angOf([g[0], g[1]], h.p))) best = h.t;
    }
  }
  return best < Infinity ? best : null;
}

/** All angles where the circle (c, r) meets the edges. */
function circleHits(c, r, edges) {
  const out = [];
  for (const s of edges.segs || []) {
    for (const h of lineCircle([s[0], s[1]], [s[2] - s[0], s[3] - s[1]], c, r)) {
      if (h.t >= -EPS && h.t <= 1 + EPS) out.push(angOf(c, h.p));
    }
  }
  for (const g of edges.arcs || []) {
    for (const p of circleCircle(c, r, [g[0], g[1]], g[2])) if (inArc(g, angOf([g[0], g[1]], p))) out.push(angOf(c, p));
  }
  return out;
}

/**
 * EXTEND the end nearest to the picked point up to the nearest boundary edge.
 * Returns { shape: shape fields, added: [points] } or { err: "kind" | "closed" | "none" }.
 */
export function extendShape(a, pick, edges) {
  if (!EXTEND_KINDS.has(a.kind)) return { err: "kind" };
  const path = toPath(a);
  if (!path) return { err: "kind" };
  if (path.closed) return { err: "closed" };
  const n = path.els.length;
  // which end: the one nearer along the path
  const { s } = pathParam(path, pick);
  let before = 0;
  let total = 0;
  path.els.forEach((e, i) => {
    const L = elLen(e);
    total += L;
    if (i < Math.floor(s)) before += L;
    else if (i === Math.floor(s)) before += L * (s - i);
  });
  const atStart = before < total / 2;
  if (path.els[0].t === "A") {
    const e = path.els[0];
    const sg = e.sw > 0 ? 1 : -1;
    const endA = atStart ? e.a0 : e.a0 + e.sw;
    let best = Infinity;
    for (const th of circleHits(e.c, e.r, edges)) {
      // beyond the end, in the arc's direction (backwards at the start)
      const rel = (sg > 0) === !atStart ? wrap(th - endA) : wrap(endA - th);
      if (rel > 1e-6 && Math.abs(e.sw) + rel < TAU - 1e-6 && rel < best) best = rel;
    }
    if (best === Infinity) return { err: "none" };
    const a0 = atStart ? e.a0 - sg * best : e.a0;
    const sw = e.sw + sg * best;
    const added = atStart ? { t: "A", c: e.c, r: e.r, a0, sw: sg * best } : { t: "A", c: e.c, r: e.r, a0: e.a0 + e.sw, sw: sg * best };
    return { shape: { pts: [e.c, polar(e.c, e.r, a0), polar(e.c, e.r, a0 + sw)], ccw: sw > 0 }, added: elsPoints([added]) };
  }
  const e = atStart ? path.els[0] : path.els[n - 1];
  const from = atStart ? e.b : e.a;
  const end = atStart ? e.a : e.b;
  const L = dist(from, end);
  const d = [(end[0] - from[0]) / L, (end[1] - from[1]) / L];
  const t = rayHit(end, d, edges);
  if (t == null) return { err: "none" };
  const q = [end[0] + d[0] * t, end[1] + d[1] * t];
  const pts = (a.pts || []).map((p) => [p[0], p[1]]);
  if (a.kind === "line") pts[atStart ? 0 : 1] = q;
  else pts[atStart ? 0 : pts.length - 1] = q;
  return { shape: { pts }, added: [end, q] };
}

// ------------------------------------------------------------------ OFFSET

/** Distance from p to the shape (for OFFSET Through). */
export function shapeDistance(a, p) {
  const path = toPath(a);
  if (!path) return null;
  if (a.kind === "line") {
    const [A, B] = a.pts;
    const L = dist(A, B);
    return Math.abs(((B[0] - A[0]) * (A[1] - p[1]) - (A[0] - p[0]) * (B[1] - A[1])) / L);
  }
  if (path.els[0].t === "A") return Math.abs(dist(path.els[0].c, p) - path.els[0].r);
  return pathParam(path, p).d;
}

/** Offset copy of a polyline (sharp corners, as AutoCAD's default), toward the side of the point. */
function offsetPoly(Q, closed, side, dd) {
  const pts = [];
  for (const p of Q) if (!pts.length || dist(pts[pts.length - 1], p) > EPS) pts.push(p);
  if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) <= EPS) pts.pop();
  const n = pts.length;
  const m = closed ? n : n - 1;
  if (m < 1) return null;
  const segs = [];
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const L = dist(a, b);
    segs.push({ a, b, u: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] });
  }
  // side: the segment nearest to the point decides
  let near = 0;
  let nd = Infinity;
  segs.forEach((s, i) => {
    const q = project({ t: "L", a: s.a, b: s.b }, side);
    if (q.d < nd) {
      nd = q.d;
      near = i;
    }
  });
  const s0 = segs[near];
  const nrm = (s) => [-s.u[1], s.u[0]];
  const n0 = nrm(s0);
  const sg = Math.sign((side[0] - s0.a[0]) * n0[0] + (side[1] - s0.a[1]) * n0[1]);
  if (!sg) return null;
  const d = dd == null ? nd : dd;
  const off = segs.map((s) => {
    const k = nrm(s);
    return { a: [s.a[0] + k[0] * sg * d, s.a[1] + k[1] * sg * d], u: s.u, b: [s.b[0] + k[0] * sg * d, s.b[1] + k[1] * sg * d] };
  });
  const join = (s1, s2) => {
    const r = lineLine(s1.a, s1.u, s2.a, s2.u);
    return r ? r.p : s2.a;
  };
  const out = [];
  if (closed) for (let i = 0; i < m; i++) out.push(join(off[(i - 1 + m) % m], off[i]));
  else {
    out.push(off[0].a);
    for (let i = 1; i < m; i++) out.push(join(off[i - 1], off[i]));
    out.push(off[m - 1].b);
  }
  // a segment that turned around: the distance is too large for the outline
  const k = out.length;
  for (let i = 0; i < m; i++) {
    const a = out[i];
    const b = out[(i + 1) % k];
    if ((b[0] - a[0]) * segs[i].u[0] + (b[1] - a[1]) * segs[i].u[1] <= EPS) return null;
  }
  return out;
}

/**
 * OFFSET: a parallel copy at distance d (pt), or through the point when d is null, on the side of `side`.
 * Returns { shape: shape fields } or { err: "kind" | "big" | "side" }.
 */
export function offsetShape(a, d, side) {
  if (!OFFSET_KINDS.has(a.kind) || !toPath(a)) return { err: "kind" };
  const P = a.pts;
  if (a.kind === "line") {
    const [A, B] = P;
    const L = dist(A, B);
    const nv = [-(B[1] - A[1]) / L, (B[0] - A[0]) / L];
    const h = (side[0] - A[0]) * nv[0] + (side[1] - A[1]) * nv[1];
    if (Math.abs(h) < EPS) return { err: "side" };
    const k = Math.sign(h) * (d == null ? Math.abs(h) : d);
    return { shape: { pts: [[A[0] + nv[0] * k, A[1] + nv[1] * k], [B[0] + nv[0] * k, B[1] + nv[1] * k]] } };
  }
  if (a.kind === "circle" || a.kind === "arc") {
    const c = P[0];
    const r = dist(c, P[1]);
    const ds = dist(c, side);
    const dd = d == null ? Math.abs(ds - r) : d;
    if (dd < EPS) return { err: "side" };
    const r2 = ds > r ? r + dd : r - dd;
    if (r2 <= EPS) return { err: "big" };
    const sc = (p) => [c[0] + ((p[0] - c[0]) * r2) / r, c[1] + ((p[1] - c[1]) * r2) / r];
    return { shape: { pts: [[c[0], c[1]], ...P.slice(1).map(sc)] } };
  }
  if (a.kind === "rect") {
    const x0 = Math.min(P[0][0], P[1][0]);
    const x1 = Math.max(P[0][0], P[1][0]);
    const y0 = Math.min(P[0][1], P[1][1]);
    const y1 = Math.max(P[0][1], P[1][1]);
    const inside = side[0] > x0 && side[0] < x1 && side[1] > y0 && side[1] < y1;
    let dd = d;
    if (dd == null) {
      if (inside) dd = Math.min(side[0] - x0, x1 - side[0], side[1] - y0, y1 - side[1]);
      else dd = Math.hypot(Math.max(x0 - side[0], 0, side[0] - x1), Math.max(y0 - side[1], 0, side[1] - y1));
    }
    if (dd < EPS) return { err: "side" };
    const k = inside ? -dd : dd;
    if (x1 - x0 + 2 * k <= EPS || y1 - y0 + 2 * k <= EPS) return { err: "big" };
    return { shape: { pts: [[x0 - k, y0 - k], [x1 + k, y1 + k]] } };
  }
  const closed = !!a.closed && P.length > 2;
  const out = offsetPoly(P, closed, side, d);
  if (!out) return { err: "big" };
  return { shape: { pts: out } };
}
