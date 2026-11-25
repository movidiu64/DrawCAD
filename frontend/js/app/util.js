// Small helpers shared by the editor modules (App methods in main.js and js/app/*.js).


export const round2 = (v) => Math.round(v * 100) / 100;
/** Today as written on drawings (dd.mm.yyyy). */
export const today = () => new Date().toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Ramer–Douglas–Peucker: the points of a freehand stroke, keeping the shape within tol. */
export function simplifyPath(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1e-9;
  let iMax = 0;
  let dMax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = L > 1e-6 ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > dMax) {
      dMax = d;
      iMax = i;
    }
  }
  if (dMax <= tol) return [a, b];
  return [...simplifyPath(pts.slice(0, iMax + 1), tol).slice(0, -1), ...simplifyPath(pts.slice(iMax), tol)];
}

/** Does segment [x0, y0, x1, y1] cross box [x0, y0, x1, y1]? (Liang–Barsky clipping) */
export function segHitsBox(q, b) {
  let t0 = 0;
  let t1 = 1;
  const dx = q[2] - q[0];
  const dy = q[3] - q[1];
  for (const [pp, qq] of [[-dx, q[0] - b[0]], [dx, b[2] - q[0]], [-dy, q[1] - b[1]], [dy, b[3] - q[1]]]) {
    if (Math.abs(pp) < 1e-12) {
      if (qq < 0) return false;
    } else {
      const r = qq / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const $ = (id) => document.getElementById(id);
/** Short hash (FNV-1a) for render keys. */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const DATUM_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"; // ISO 5459: no I, O, Q
// grips are shown on at most this many selected annotations (AutoCAD: GRIPOBJLIMIT, 100)
export const GRIP_LIMIT = 100;
export const gripKey = (id, k) => `${id}:${k}`;
