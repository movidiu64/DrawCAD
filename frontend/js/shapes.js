// Drawn geometry: lines, polylines, rectangles, circles, arcs, center marks and hatches,
// with the line types of ISO 128-20 (element lengths in multiples of the width d).
// Coordinates in visual PDF points (y down); widths and lengths in mm at annotation level.
export const K = 72 / 25.4;

/** Line types. pat: dash, gap, dash, gap… in multiples of d (ISO 128-20, table 2). */
export const LTYPES = [
  { id: "cont", name: "Continuă", code: "01", pat: null },
  { id: "dash", name: "Întreruptă", code: "02", pat: [12, 3] },
  { id: "chain", name: "Linie-punct", code: "04", pat: [24, 3, 0.5, 3] },
  { id: "dchain", name: "Linie-două puncte", code: "05", pat: [24, 3, 0.5, 3, 0.5, 3] },
  { id: "dot", name: "Punctată", code: "07", pat: [0.5, 3] },
];
export const LTYPE_BY_ID = Object.fromEntries(LTYPES.map((t) => [t.id, t]));

/** The ISO 128-20 line width series (mm). */
export const WIDTHS = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1];

/** Usual applications on production drawings (ISO 128-24). */
export const PRESETS = [
  { id: "vis", name: "Contur vizibil", ltype: "cont", w: 0.5, code: "01.2" },
  { id: "thin", name: "Linie subțire (ajutătoare, cote)", ltype: "cont", w: 0.25, code: "01.1" },
  { id: "hid", name: "Contur ascuns", ltype: "dash", w: 0.25, code: "02.1" },
  { id: "axis", name: "Axă, cerc de divizare", ltype: "chain", w: 0.25, code: "04.1" },
  { id: "spec", name: "Suprafață cu cerințe speciale", ltype: "chain", w: 0.5, code: "04.2" },
  { id: "adj", name: "Piese vecine, poziții extreme", ltype: "dchain", w: 0.25, code: "05.1" },
];

export const SHAPE_NAMES = {
  line: "Linie",
  poly: "Polilinie",
  rect: "Dreptunghi",
  circle: "Cerc",
  arc: "Arc",
  cross: "Axe de cerc",
  hatch: "Hașură",
  break: "Linie de ruptură",
};

const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
// angles on screen, counter-clockwise (y down → y is flipped)
const angOf = (c, p) => Math.atan2(-(p[1] - c[1]), p[0] - c[0]);
const polar = (c, r, th) => [c[0] + r * Math.cos(th), c[1] - r * Math.sin(th)];
const wrap = (x) => ((x % TAU) + TAU) % TAU;

/**
 * The line pattern, fitted to the element length as in CAD: an open line starts and ends
 * with a full dash, a closed outline closes without a "seam". even: even number of periods,
 * so the middle dash falls exactly on the center (circle center lines cross on dashes).
 * Returns the list of lengths in pt, or null for a continuous line.
 */
export function fitDash(ltype, wMm, lscale, L, closed, even = false) {
  const t = LTYPE_BY_ID[ltype];
  if (!t || !t.pat || !(L > 0)) return null;
  const d = Math.max(wMm, 0.25) * (lscale || 1) * K; // on very thin lines the pattern would become invisible
  const pat = t.pat.map((v) => v * d);
  const P = pat.reduce((s, v) => s + v, 0);
  if (ltype === "dot") return pat;
  if (closed) {
    const n = Math.max(2, Math.round(L / P));
    const s = L / (n * P);
    return pat.map((v) => v * s);
  }
  const D = pat[0];
  let n = Math.round((L - D) / P);
  if (even) n = Math.round(n / 2) * 2;
  if (n < 1) return even || L < D * 0.5 ? null : pat; // too short for the pattern: continuous (ISO 128-24)
  const s = L / (n * P + D);
  return pat.map((v) => v * s);
}

function polyLen(pts, closed) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}

/** Arc geometry: center, radius, start angle and signed sweep (radians). */
export function arcGeom(a) {
  const [c, p1, p2] = a.pts;
  const r = dist(c, p1);
  const a0 = angOf(c, p1);
  const a1 = angOf(c, p2);
  let sw = a.ccw === false ? -wrap(a0 - a1) : wrap(a1 - a0);
  if (Math.abs(sw) < 1e-6) sw = a.ccw === false ? -TAU : TAU;
  return { c, r, a0, sw };
}

export function arcPoints(c, r, a0, sw) {
  const n = Math.max(8, Math.ceil((Math.abs(sw) * 180) / Math.PI / 2));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(polar(c, r, a0 + (sw * i) / n));
  return out;
}

/**
 * Hatch lines inside the polygon (even-odd rule): parallel lines at the given angle
 * (degrees, counter-clockwise on screen), at spacing sp (pt), anchored at the origin so adjacent
 * hatches of the same part line up.
 */
export function hatchLines(poly, angleDeg, sp) {
  if (poly.length < 3 || !(sp > 0)) return [];
  const th = (angleDeg * Math.PI) / 180;
  // local system: u along the hatch, v perpendicular
  const u = [Math.cos(th), -Math.sin(th)];
  const v = [Math.sin(th), Math.cos(th)];
  const loc = poly.map((p) => [p[0] * u[0] + p[1] * u[1], p[0] * v[0] + p[1] * v[1]]);
  const vs = loc.map((p) => p[1]);
  const k0 = Math.ceil(Math.min(...vs) / sp);
  const k1 = Math.floor(Math.max(...vs) / sp);
  const out = [];
  if (k1 - k0 > 4000) return out;
  for (let k = k0; k <= k1; k++) {
    const y = k * sp;
    const xs = [];
    for (let i = 0; i < loc.length; i++) {
      const A = loc[i];
      const B = loc[(i + 1) % loc.length];
      if ((A[1] <= y) === (B[1] <= y)) continue;
      xs.push(A[0] + ((y - A[1]) * (B[0] - A[0])) / (B[1] - A[1]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 1e-6) continue;
      const P = [xs[i] * u[0] + y * v[0], xs[i] * u[1] + y * v[1]];
      const Q = [xs[i + 1] * u[0] + y * v[0], xs[i + 1] * u[1] + y * v[1]];
      out.push([P, Q]);
    }
  }
  return out;
}

export function rectCorners(a) {
  const [p, q] = a.pts;
  return [[p[0], p[1]], [q[0], p[1]], [q[0], q[1]], [p[0], q[1]]];
}

/** Measured values for the panel (paper mm). */
export function shapeInfo(a) {
  const m = (v) => v / K;
  switch (a.kind) {
    case "break":
    case "line":
      return { len: m(dist(a.pts[0], a.pts[1])), ang: ((angOf(a.pts[0], a.pts[1]) * 180) / Math.PI + 360) % 360 };
    case "poly":
      return { len: m(polyLen(a.pts, a.closed)), n: a.pts.length };
    case "rect":
      return { w: m(Math.abs(a.pts[1][0] - a.pts[0][0])), h: m(Math.abs(a.pts[1][1] - a.pts[0][1])) };
    case "circle":
    case "cross":
      return { r: m(dist(a.pts[0], a.pts[1])) };
    case "arc": {
      const g = arcGeom(a);
      return { r: m(g.r), sweep: (Math.abs(g.sw) * 180) / Math.PI };
    }
    default:
      return {};
  }
}

/** Primitives of a drawn shape. */
export function buildShape(a) {
  const c = a.layer || "add";
  const wMm = a.w ?? 0.25;
  const w = wMm * K;
  const lt = a.ltype || "cont";
  const ls = a.lscale || 1;
  const pts = a.pts || [];
  const prims = [];
  const handles = pts.map((p, i) => ({ k: `pts.${i}`, p }));
  const polyPrim = (P, closed) => ({ t: "P", p: P.flat(), close: !!closed, w, c, dp: fitDash(lt, wMm, ls, polyLen(P, closed), closed) });

  switch (a.kind) {
    case "line":
      if (pts.length >= 2) prims.push({ t: "L", p: [...pts[0], ...pts[1]], w, c, dp: fitDash(lt, wMm, ls, dist(pts[0], pts[1]), false) });
      break;
    case "poly":
      if (pts.length >= 2) prims.push(polyPrim(pts, a.closed && pts.length > 2));
      break;
    case "rect":
      if (pts.length >= 2) prims.push(polyPrim(rectCorners(a), true));
      break;
    case "circle":
      if (pts.length >= 2) {
        const r = dist(pts[0], pts[1]);
        prims.push({ t: "C", p: [...pts[0]], r, w, c, dp: fitDash(lt, wMm, ls, TAU * r, true) });
        // handles: the center and the point on the circle (radius)
      }
      break;
    case "arc":
      if (pts.length >= 3) {
        const g = arcGeom(a);
        const P = arcPoints(g.c, g.r, g.a0, g.sw);
        prims.push(polyPrim(P, false));
        handles[2] = { k: "pts.2", p: P[P.length - 1] };
      }
      break;
    case "cross":
      if (pts.length >= 2) {
        const [C, Q] = pts;
        const r = dist(C, Q);
        const e = (a.ext ?? 3) * K;
        const L = r + e;
        const th = a.rot ? (a.rot * Math.PI) / 180 : 0;
        for (const ang of [th, th + Math.PI / 2]) {
          const d = [Math.cos(ang), -Math.sin(ang)];
          const A = [C[0] - d[0] * L, C[1] - d[1] * L];
          const B = [C[0] + d[0] * L, C[1] + d[1] * L];
          prims.push({ t: "L", p: [...A, ...B], w, c, dp: fitDash(lt, wMm, ls, 2 * L, false, true) });
        }
        // reference circle, editor only
        prims.push({ t: "C", p: [...C], r, w: 0.4, c: "edgray", ed: true, dash: true });
      }
      break;
    case "hatch":
      if (pts.length >= 3) {
        const sp = (a.sp ?? 2) * K;
        const ang = a.angle ?? 45;
        const sets = [ang];
        if (a.cross) sets.push(ang + 90);
        for (const an of sets) {
          for (const [P, Q] of hatchLines(pts, an, sp)) prims.push({ t: "L", p: [...P, ...Q], w, c, dp: lt === "cont" ? null : fitDash(lt, wMm, ls, dist(P, Q), false) });
        }
        if (a.outline) prims.push(polyPrim(pts, true));
        else prims.push({ t: "P", p: pts.flat(), close: true, w: 0.4, c: "edgray", ed: true, dash: true });
      }
      break;
    case "break":
      if (pts.length >= 2) prims.push(polyPrim(breakPoints(pts[0], pts[1], a.style || "zigzag"), false));
      break;
    default:
      break;
  }
  return { prims, handles, info: shapeInfo(a), snap: shapeSnap(a) };
}

/** Break line (ISO 128-20 type 01.1): straight with a zigzag in the middle, or wavy (freehand). */
export function breakPoints(A, B, style) {
  const L = dist(A, B);
  if (L < 1e-6) return [A, B];
  const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
  const n = [-u[1], u[0]];
  const at = (t, h) => [A[0] + u[0] * t + n[0] * h, A[1] + u[1] * t + n[1] * h];
  if (style === "wave") {
    const wl = Math.min(L / 1.5, 12 * K);
    const amp = Math.min(1.5 * K, L * 0.06);
    const out = [];
    const steps = Math.max(24, Math.ceil(L / (0.5 * K)));
    for (let i = 0; i <= steps; i++) {
      const t = (L * i) / steps;
      out.push(at(t, amp * Math.sin((TAU * t) / wl)));
    }
    return out;
  }
  // zigzag: 3.5 mm wide, ±2.5 mm high, centered (shrinks on short lines)
  const half = Math.min(1.75 * K, L / 4);
  const h = Math.min(2.5 * K, L / 3);
  const m = L / 2;
  return [A, at(m - half, 0), at(m - half / 3, h), at(m + half / 3, -h), at(m + half, 0), B];
}

/** Points (endpoint e, midpoint m, center c, quadrant q) and segments for snapping to the drawn shape. */
export function shapeSnap(a) {
  const pts = [];
  const segs = [];
  const P = a.pts || [];
  const seg = (p, q, mid = true) => {
    segs.push([p[0], p[1], q[0], q[1]]);
    if (mid) pts.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, "m"]);
  };
  const chain = (Q, closed) => {
    Q.forEach((q) => pts.push([q[0], q[1], "e"]));
    for (let i = 1; i < Q.length; i++) seg(Q[i - 1], Q[i]);
    if (closed && Q.length > 2) seg(Q[Q.length - 1], Q[0]);
  };
  const arcs = [];
  // circles and arcs go as exact arcs: center, quadrants, tangent, intersections (in osnap.js)
  const ring = (c, r) => arcs.push([c[0], c[1], r, 0, TAU]);
  switch (a.kind) {
    case "line":
    case "break":
      if (P.length >= 2) chain([P[0], P[1]], false);
      break;
    case "poly":
      chain(P, a.closed);
      break;
    case "rect":
      if (P.length >= 2) {
        chain(rectCorners(a), true);
        pts.push([(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2, "c"]);
      }
      break;
    case "circle":
      if (P.length >= 2) ring(P[0], dist(P[0], P[1]));
      break;
    case "cross":
      if (P.length >= 1) pts.push([P[0][0], P[0][1], "c"]);
      break;
    case "arc":
      if (P.length >= 3) {
        const g = arcGeom(a);
        arcs.push([g.c[0], g.c[1], g.r, g.a0, g.sw]);
      }
      break;
    case "hatch":
      P.forEach((q) => pts.push([q[0], q[1], "e"]));
      break;
    default:
      break;
  }
  return { pts, segs, arcs };
}

/** Changes the main dimension keeping the first point (and the direction). */
export function resizeShape(a, field, mm) {
  const v = mm * K;
  const [p0, p1] = a.pts;
  if (!(v > 0)) return;
  if (field === "len" && a.kind === "line") {
    const L = dist(p0, p1) || 1;
    a.pts = [p0, [p0[0] + ((p1[0] - p0[0]) / L) * v, p0[1] + ((p1[1] - p0[1]) / L) * v]];
  } else if (field === "ang" && a.kind === "line") {
    const L = dist(p0, p1);
    a.pts = [p0, polar(p0, L, (mm * Math.PI) / 180)];
  } else if (field === "w" && a.kind === "rect") {
    a.pts = [p0, [p0[0] + Math.sign(p1[0] - p0[0] || 1) * v, p1[1]]];
  } else if (field === "h" && a.kind === "rect") {
    a.pts = [p0, [p1[0], p0[1] + Math.sign(p1[1] - p0[1] || 1) * v]];
  } else if (field === "r" && (a.kind === "circle" || a.kind === "cross" || a.kind === "arc")) {
    const L = dist(p0, p1) || 1;
    const k = v / L;
    a.pts = a.pts.map((p, i) => (i === 0 ? p : [p0[0] + (p[0] - p0[0]) * k, p0[1] + (p[1] - p0[1]) * k]));
  }
}

// ------------------------------------------------------------------ drawing tools
/** Arc direction from the cursor movement: the angle swept since the second click. */
export function trackSweep(state, c, start, cur) {
  const a = angOf(c, cur);
  if (state.last == null) {
    state.last = angOf(c, start);
    state.acc = 0;
  }
  let d = a - state.last;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  state.acc += d;
  state.last = a;
  return state.acc >= 0;
}

// ---- vertices of polylines and hatches (grip menu: Add vertex / Remove vertex, CMD-D14)

/** Can vertices be added to or removed from this shape? (polylines and hatch outlines) */
export function hasVertices(a) {
  return !!(a && a.type === "shape" && (a.kind === "poly" || a.kind === "hatch") && Array.isArray(a.pts));
}

const minVertices = (a) => (a.kind === "hatch" || a.closed ? 3 : 2);

/**
 * Adds a vertex after vertex i: halfway to the next one, or, after the last vertex of an open
 * polyline, half a segment further on. Returns the new vertex's index, or -1.
 */
export function addVertex(a, i) {
  if (!hasVertices(a) || i < 0 || i >= a.pts.length) return -1;
  const P = a.pts;
  const closedRing = a.kind === "hatch" || a.closed;
  let q;
  if (i < P.length - 1 || closedRing) {
    const n = P[(i + 1) % P.length];
    q = [(P[i][0] + n[0]) / 2, (P[i][1] + n[1]) / 2];
  } else {
    const p = P[i - 1] || P[i];
    q = [P[i][0] + (P[i][0] - p[0]) / 2, P[i][1] + (P[i][1] - p[1]) / 2];
  }
  P.splice(i + 1, 0, q);
  return i + 1;
}

/** Removes vertex i, if the shape keeps enough of them. Returns true when removed. */
export function removeVertex(a, i) {
  if (!hasVertices(a) || i < 0 || i >= a.pts.length || a.pts.length <= minVertices(a)) return false;
  a.pts.splice(i, 1);
  return true;
}
