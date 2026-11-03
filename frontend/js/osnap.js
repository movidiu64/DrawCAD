// Object snap, AutoCAD style: endpoint, midpoint, center, quadrant, intersection, apparent
// intersection, extension, perpendicular, tangent, parallel, nearest, plus tracking (alignment with
// "acquired" points) and polar tracking. Coordinates: visual PDF points (y down);
// angles are measured on screen, counter-clockwise. Arc = [cx, cy, r, a0, signed sweep].

export const MODES = [
  { id: "e", name: "Capăt" },
  { id: "m", name: "Mijloc" },
  { id: "c", name: "Centru" },
  { id: "q", name: "Cadran" },
  { id: "x", name: "Intersecție" },
  { id: "ax", name: "Intersecție aparentă" },
  { id: "ext", name: "Extensie" },
  { id: "p", name: "Perpendicular" },
  { id: "t", name: "Tangent" },
  { id: "par", name: "Paralel" },
  { id: "n", name: "Pe obiect" },
];
export const DEFAULT_MODES = ["e", "m", "c", "q", "x", "ax", "ext", "p", "t", "par", "n"];

export const LABELS = {
  e: "Capăt",
  a: "Punct de adnotare",
  m: "Mijloc",
  c: "Centru",
  q: "Cadran",
  x: "Intersecție",
  ax: "Intersecție aparentă",
  ext: "Extensie",
  p: "Perpendicular",
  t: "Tangent",
  par: "Paralel",
  n: "Pe obiect",
  trk: "Urmărire",
  pol: "Polar",
};

const TAU = Math.PI * 2;
const PRIO = { c: 0, e: 1, a: 1, x: 1, q: 2, ax: 2, p: 2.2, t: 2.2, m: 3 };
const angOf = (c, p) => Math.atan2(-(p[1] - c[1]), p[0] - c[0]);
const polar = (c, r, th) => [c[0] + r * Math.cos(th), c[1] - r * Math.sin(th)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrap = (x) => ((x % TAU) + TAU) % TAU;

export function inArc(arc, th) {
  const [, , , a0, sw] = arc;
  if (Math.abs(sw) >= TAU - 1e-6) return true;
  const rel = sw > 0 ? wrap(th - a0) : wrap(a0 - th);
  return rel <= Math.abs(sw) + 1e-6;
}

/** Intersection of the lines p + t·d and q + u·e: { t, u, p } or null if they are parallel. */
export function lineLine(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12) return null;
  const w = [q[0] - p[0], q[1] - p[1]];
  const t = (w[0] * e[1] - w[1] * e[0]) / den;
  const u = (w[0] * d[1] - w[1] * d[0]) / den;
  return { t, u, p: [p[0] + d[0] * t, p[1] + d[1] * t] };
}

/** Intersections of the line p + t·d with the circle (c, r): a list of { t, p }. */
export function lineCircle(p, d, c, r) {
  const fx = p[0] - c[0];
  const fy = p[1] - c[1];
  const A = d[0] * d[0] + d[1] * d[1];
  const B = 2 * (fx * d[0] + fy * d[1]);
  const C = fx * fx + fy * fy - r * r;
  const D = B * B - 4 * A * C;
  if (D < 0 || A < 1e-12) return [];
  const s = Math.sqrt(D);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].map((t) => ({ t, p: [p[0] + d[0] * t, p[1] + d[1] * t] }));
}

export function circleCircle(c1, r1, c2, r2) {
  const d = dist(c1, c2);
  if (d < 1e-9 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2[0] - c1[0]) / d;
  const uy = (c2[1] - c1[1]) / d;
  const m = [c1[0] + ux * a, c1[1] + uy * a];
  return [[m[0] - uy * h, m[1] + ux * h], [m[0] + uy * h, m[1] - ux * h]];
}

function footOnSeg(s, x, y) {
  const bx = s[2] - s[0];
  const by = s[3] - s[1];
  const L2 = bx * bx + by * by;
  const t = L2 ? ((x - s[0]) * bx + (y - s[1]) * by) / L2 : 0;
  return { t, p: [s[0] + bx * t, s[1] + by * t] };
}

function segDist(s, x, y) {
  const f = footOnSeg(s, x, y);
  const t = Math.max(0, Math.min(1, f.t));
  return Math.hypot(s[0] + (s[2] - s[0]) * t - x, s[1] + (s[3] - s[1]) * t - y);
}

// ------------------------------------------------------------------ spatial index
class Grid {
  constructor(cell) {
    this.cell = cell;
    this.m = new Map();
  }

  key(i, j) {
    return i * 100003 + j;
  }

  put(k, item) {
    let arr = this.m.get(k);
    if (!arr) this.m.set(k, (arr = []));
    arr.push(item);
  }

  addBox(item, x0, y0, x1, y1) {
    const c = this.cell;
    const i0 = Math.floor(x0 / c);
    const i1 = Math.floor(x1 / c);
    const j0 = Math.floor(y0 / c);
    const j1 = Math.floor(y1 / c);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) return false;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this.put(this.key(i, j), item);
    return true;
  }

  addPoints(item, pts) {
    const keys = new Set(pts.map(([x, y]) => this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))));
    for (const k of keys) this.put(k, item);
  }

  query(x0, y0, x1, y1, out) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) {
      for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++) {
        const arr = this.m.get(this.key(i, j));
        if (arr) for (const it of arr) out.add(it);
      }
    }
    return out;
  }
}

function addSeg(grid, s) {
  if (grid.addBox(s, Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3]))) return;
  // long segment (border, axis): only the cells along its path are registered
  const L = Math.hypot(s[2] - s[0], s[3] - s[1]);
  const n = Math.ceil(L / (grid.cell / 2));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push([s[0] + ((s[2] - s[0]) * i) / n, s[1] + ((s[3] - s[1]) * i) / n]);
  grid.addPoints(s, pts);
}

function addArc(grid, a) {
  const [cx, cy, r, a0, sw] = a;
  if (grid.addBox(a, cx - r, cy - r, cx + r, cy + r)) return;
  const n = Math.ceil((Math.abs(sw) * r) / (grid.cell / 2));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(polar([cx, cy], r, a0 + (sw * i) / n));
  grid.addPoints(a, pts);
}

// ------------------------------------------------------------------ snap
export class Snapper {
  constructor(data = {}, cell = 24) {
    this.cell = cell;
    this.pg = new Grid(cell);
    this.sg = new Grid(cell);
    this.ag = new Grid(cell);
    for (const p of data.pts || []) this.pg.addBox(p, p[0], p[1], p[0], p[1]);
    for (const s of data.segs || []) addSeg(this.sg, s);
    for (const a of data.arcs || []) addArc(this.ag, a);
  }

  near(x, y, r, extra) {
    const box = [x - r, y - r, x + r, y + r];
    const segs = [...this.sg.query(...box, new Set())];
    const arcs = [...this.ag.query(...box, new Set())];
    const touch = (b) => b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1];
    for (const s of extra.segs || []) if (touch([Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])])) segs.push(s);
    for (const a of extra.arcs || []) if (touch([a[0] - a[2], a[1] - a[2], a[0] + a[2], a[1] + a[2]])) arcs.push(a);
    return { segs, arcs };
  }

  /** Extension directions of the lines ending at p (for extension snap). */
  dirsAt(p, extra = {}) {
    const eps = 0.05;
    const out = [];
    const { segs } = this.near(p[0], p[1], eps, extra);
    for (const s of segs) {
      if (s[4]) continue; // pieces of an approximated curve: no extension
      const a = [s[0], s[1]];
      const b = [s[2], s[3]];
      const L = dist(a, b);
      if (L < 1e-6) continue;
      if (dist(b, p) < eps) out.push([(b[0] - a[0]) / L, (b[1] - a[1]) / L]);
      else if (dist(a, p) < eps) out.push([(a[0] - b[0]) / L, (a[1] - b[1]) / L]);
    }
    return out;
  }

  /** Direction of the segment under the cursor (for parallel), or null. */
  dirUnder(x, y, tol, extra = {}) {
    const { segs } = this.near(x, y, tol, extra);
    let best = null;
    let bd = tol;
    for (const s of segs) {
      const d = segDist(s, x, y);
      const L = Math.hypot(s[2] - s[0], s[3] - s[1]);
      if (d <= bd && L > 1e-6) {
        bd = d;
        best = { dir: [(s[2] - s[0]) / L, (s[3] - s[1]) / L], seg: s };
      }
    }
    return best;
  }

  /**
   * o: { tol, modes (Set), anchor, extra: {pts, segs, arcs}, acq: [{p, dirs}], parDir,
   *      polarInc (degrees, 0 = off), tracking (bool) }.
   * Returns { p, kind, guides: [{ o, p }], from } or null.
   */
  snap(cur, o) {
    const [x, y] = cur;
    const tol = o.tol;
    const M = o.modes;
    const extra = o.extra || {};
    const A = o.anchor;
    let best = null;
    let bestScore = Infinity;
    const take = (p, kind, d, prio, more = {}) => {
      const score = d + prio * tol * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = { p, kind, ...more };
      }
    };

    // 1. characteristic points
    const pts = this.pg.query(x - tol, y - tol, x + tol, y + tol, new Set());
    for (const q of extra.pts || []) if (Math.abs(q[0] - x) <= tol && Math.abs(q[1] - y) <= tol) pts.add(q);
    for (const q of pts) {
      const k = q[2] || "a";
      if (k !== "a" && !M.has(k)) continue;
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d <= tol) take([q[0], q[1]], k, d, PRIO[k] ?? 2);
    }
    const R = tol * 3;
    const { segs, arcs } = this.near(x, y, R, extra);
    // endpoints, midpoints, centers and quadrants for arcs (including those of drawn shapes)
    for (const a of arcs) {
      const c = [a[0], a[1]];
      const full = Math.abs(a[4]) >= TAU - 1e-6;
      const cand = [];
      if (M.has("c")) cand.push([c, "c"]);
      if (!full && M.has("e")) cand.push([polar(c, a[2], a[3]), "e"], [polar(c, a[2], a[3] + a[4]), "e"]);
      if (!full && M.has("m")) cand.push([polar(c, a[2], a[3] + a[4] / 2), "m"]);
      if (M.has("q")) for (let i = 0; i < 4; i++) if (inArc(a, (i * Math.PI) / 2)) cand.push([polar(c, a[2], (i * Math.PI) / 2), "q"]);
      for (const [p, k] of cand) {
        const d = dist(p, cur);
        if (d <= tol) take(p, k, d, PRIO[k]);
      }
    }

    // 2. real intersections, close to the cursor
    const close = segs.filter((s) => segDist(s, x, y) <= tol);
    const closeArcs = arcs.filter((a) => Math.abs(dist([a[0], a[1]], cur) - a[2]) <= tol && inArc(a, angOf([a[0], a[1]], cur)));
    if (M.has("x")) {
      for (let i = 0; i < close.length; i++) {
        const s = close[i];
        const P = [s[0], s[1]];
        const D = [s[2] - s[0], s[3] - s[1]];
        for (let j = i + 1; j < close.length; j++) {
          const u = close[j];
          const r = lineLine(P, D, [u[0], u[1]], [u[2] - u[0], u[3] - u[1]]);
          if (r && r.t >= -1e-6 && r.t <= 1 + 1e-6 && r.u >= -1e-6 && r.u <= 1 + 1e-6) {
            const d = dist(r.p, cur);
            if (d <= tol) take(r.p, "x", d, PRIO.x);
          }
        }
        for (const a of closeArcs) {
          for (const h of lineCircle(P, D, [a[0], a[1]], a[2])) {
            if (h.t < -1e-6 || h.t > 1 + 1e-6 || !inArc(a, angOf([a[0], a[1]], h.p))) continue;
            const d = dist(h.p, cur);
            if (d <= tol) take(h.p, "x", d, PRIO.x);
          }
        }
      }
      for (let i = 0; i < closeArcs.length; i++) {
        for (let j = i + 1; j < closeArcs.length; j++) {
          const a = closeArcs[i];
          const b = closeArcs[j];
          for (const p of circleCircle([a[0], a[1]], a[2], [b[0], b[1]], b[2])) {
            if (!inArc(a, angOf([a[0], a[1]], p)) || !inArc(b, angOf([b[0], b[1]], p))) continue;
            const d = dist(p, cur);
            if (d <= tol) take(p, "x", d, PRIO.x);
          }
        }
      }
    }

    // 3. apparent intersection: the extensions of two nearby lines meet under the cursor
    //    (the theoretical corner of a chamfer or fillet, which is what gets dimensioned)
    if (M.has("ax")) {
      // the lines may be a few mm from the theoretical corner (5×45° chamfer, R5 fillet…)
      const RAX = Math.max(R, 12 * (72 / 25.4));
      const cand = (RAX > R ? this.near(x, y, RAX, extra).segs : segs).filter((s) => !s[4]).slice(0, 90);
      for (let i = 0; i < cand.length; i++) {
        const s = cand[i];
        for (let j = i + 1; j < cand.length; j++) {
          const u = cand[j];
          const r = lineLine([s[0], s[1]], [s[2] - s[0], s[3] - s[1]], [u[0], u[1]], [u[2] - u[0], u[3] - u[1]]);
          if (!r) continue;
          const onS = r.t >= -1e-6 && r.t <= 1 + 1e-6;
          const onU = r.u >= -1e-6 && r.u <= 1 + 1e-6;
          if (onS && onU) continue; // it is a real intersection
          const d = dist(r.p, cur);
          if (d > tol || segDist(s, r.p[0], r.p[1]) > RAX || segDist(u, r.p[0], r.p[1]) > RAX) continue;
          // angle too small: the point would be unstable
          const L1 = Math.hypot(s[2] - s[0], s[3] - s[1]);
          const L2 = Math.hypot(u[2] - u[0], u[3] - u[1]);
          const sin = Math.abs(((s[2] - s[0]) * (u[3] - u[1]) - (s[3] - s[1]) * (u[2] - u[0])) / (L1 * L2));
          if (sin < 0.05) continue;
          take(r.p, "ax", d, PRIO.ax, { guides: [{ o: closestEnd(s, r.p), p: r.p }, { o: closestEnd(u, r.p), p: r.p }] });
        }
      }
    }

    // 4. perpendicular and tangent relative to the previous point
    if (A && M.has("p")) {
      for (const s of close) {
        const f = footOnSeg(s, A[0], A[1]);
        const d = dist(f.p, cur);
        if (d <= tol * 2.5 && dist(f.p, A) > 1e-6) take(f.p, "p", d / 2.5, PRIO.p, f.t < 0 || f.t > 1 ? { guides: [{ o: closestEnd(s, f.p), p: f.p }] } : {});
      }
      for (const a of closeArcs) {
        const c = [a[0], a[1]];
        const th = angOf(c, A);
        for (const t of [th, th + Math.PI]) {
          if (!inArc(a, t)) continue;
          const p = polar(c, a[2], t);
          const d = dist(p, cur);
          if (d <= tol * 2.5) take(p, "p", d / 2.5, PRIO.p);
        }
      }
    }
    if (A && M.has("t")) {
      for (const a of closeArcs) {
        const c = [a[0], a[1]];
        const D = dist(c, A);
        if (D <= a[2] + 1e-6) continue;
        const th = angOf(c, A);
        const al = Math.acos(a[2] / D);
        for (const t of [th + al, th - al]) {
          if (!inArc(a, t)) continue;
          const p = polar(c, a[2], t);
          const d = dist(p, cur);
          if (d <= tol * 2.5) take(p, "t", d / 2.5, PRIO.t);
        }
      }
    }
    if (best) return best;

    // 5. alignment: tracking from acquired points, extensions, parallel, polar
    const guides = [];
    for (const q of o.acq || []) {
      if (o.tracking) {
        guides.push({ o: q.p, d: [1, 0], line: true, kind: "trk" });
        guides.push({ o: q.p, d: [0, 1], line: true, kind: "trk" });
      }
      if (M.has("ext")) for (const d of q.dirs || []) guides.push({ o: q.p, d, ray: true, kind: "ext" });
    }
    if (A && o.parDir && M.has("par")) guides.push({ o: A, d: o.parDir, line: true, kind: "par" });
    if (A && o.polarInc > 0) {
      const inc = (o.polarInc * Math.PI) / 180;
      const th = Math.round(angOf(A, cur) / inc) * inc;
      guides.push({ o: A, d: [Math.cos(th), -Math.sin(th)], ray: true, kind: "pol" });
    }
    if (guides.length) {
      const GP = { ext: 1, par: 1, trk: 1.5, pol: 2 };
      const proj = (g) => {
        const t = (x - g.o[0]) * g.d[0] + (y - g.o[1]) * g.d[1];
        if (g.ray && t < 0) return null;
        return [g.o[0] + g.d[0] * t, g.o[1] + g.d[1] * t];
      };
      // two alignments meeting under the cursor
      for (let i = 0; i < guides.length; i++) {
        for (let j = i + 1; j < guides.length; j++) {
          const g = guides[i];
          const h = guides[j];
          if (g.o === h.o && g.kind === h.kind) continue;
          const r = lineLine(g.o, g.d, h.o, h.d);
          if (!r || (g.ray && r.t < 0) || (h.ray && r.u < 0)) continue;
          const d = dist(r.p, cur);
          if (d <= tol) take(r.p, g.kind, d, 0, { guides: [{ o: g.o, p: r.p }, { o: h.o, p: r.p }], from: g.kind === "pol" || g.kind === "par" ? g.o : h.kind === "pol" || h.kind === "par" ? h.o : g.o, d2: h.kind });
        }
        // alignment × real object
        const g = guides[i];
        for (const s of close) {
          const r = lineLine(g.o, g.d, [s[0], s[1]], [s[2] - s[0], s[3] - s[1]]);
          if (!r || (g.ray && r.t < 0) || r.u < -1e-6 || r.u > 1 + 1e-6) continue;
          const d = dist(r.p, cur);
          if (d <= tol) take(r.p, g.kind, d, 0.5, { guides: [{ o: g.o, p: r.p }], from: g.o, onObj: true });
        }
        for (const a of closeArcs) {
          for (const hh of lineCircle(g.o, g.d, [a[0], a[1]], a[2])) {
            if ((g.ray && hh.t < 0) || !inArc(a, angOf([a[0], a[1]], hh.p))) continue;
            const d = dist(hh.p, cur);
            if (d <= tol) take(hh.p, g.kind, d, 0.5, { guides: [{ o: g.o, p: hh.p }], from: g.o, onObj: true });
          }
        }
      }
      for (const g of guides) {
        const q = proj(g);
        if (!q) continue;
        const d = dist(q, cur);
        if (d <= tol && dist(q, g.o) > tol) take(q, g.kind, d, GP[g.kind], { guides: [{ o: g.o, p: q }], from: g.o });
      }
      if (best) return best;
    }

    // 6. nearest point on an object
    if (M.has("n")) {
      let bd = tol;
      for (const s of close) {
        const f = footOnSeg(s, x, y);
        const t = Math.max(0, Math.min(1, f.t));
        const p = [s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t];
        const d = dist(p, cur);
        if (d <= bd) {
          bd = d;
          best = { p, kind: "n" };
        }
      }
      for (const a of closeArcs) {
        const c = [a[0], a[1]];
        const p = polar(c, a[2], angOf(c, cur));
        const d = dist(p, cur);
        if (d <= bd) {
          bd = d;
          best = { p, kind: "n" };
        }
      }
    }
    return best;
  }
}

function closestEnd(s, p) {
  const a = [s[0], s[1]];
  const b = [s[2], s[3]];
  return dist(a, p) < dist(b, p) ? a : b;
}
