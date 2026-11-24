// Page operations (rotate, delete, move): annotations are transformed with the page so they
// stay on the drawing. Coordinates are visual (points, y down); rotation is clockwise, like /Rotate.
import { build, moveAnnot, SCALABLE, SCALE_MIN, SCALE_MAX } from "./annots.js";

const POINT_KEYS = ["p1", "p2", "p3", "c", "p", "v", "target", "pos", "vp", "tp", "elbow", "base", "lp"];
// annotations that always stay horizontal (tables, title blocks, QR codes): moved whole by their
// center, not rotated or mirrored point by point
const UPRIGHT = new Set(["revtab", "bom", "tblock", "qr"]);

/** Moves an upright annotation so that its center goes through f (rotation, mirror). */
function moveCenter(a, f, S, measure) {
  const b = build(a, S, measure).bbox;
  if (!b) return false;
  const c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const nc = f(c);
  moveAnnot(a, nc[0] - c[0], nc[1] - c[1]);
  return true;
}

/** A point of the W×H page after rotating the page by `deg` (90, 180, 270) clockwise. */
export function rotatePoint(p, deg, W, H) {
  const [x, y] = p;
  if (deg === 90) return [H - y, x];
  if (deg === 180) return [W - x, H - y];
  if (deg === 270) return [y, W - x];
  return [x, y];
}

export const normDeg = (d) => ((Math.round(d) % 360) + 360) % 360;

const wrap180 = (a) => {
  let v = ((a % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return v;
};

/** Rotates an annotation with the page (deg clockwise). Annotation angles are
 *  counter-clockwise on screen, so they decrease by deg. */
export function rotateAnnot(a, deg, W, H, S = null, measure = null) {
  deg = normDeg(deg);
  if (!deg) return a;
  const R = (p) => (Array.isArray(p) && p.length >= 2 ? rotatePoint(p, deg, W, H) : p);
  // the table's center goes where its center goes, but it stays horizontal
  if (UPRIGHT.has(a.type) && S && moveCenter(a, R, S, measure)) return a;
  if (a.type === "holes") {
    // the hole letters follow the holes; the table, kept horizontal, follows its center
    const b = S ? build({ ...a, tags: false }, S, measure).size : null;
    const [w, h] = b || [0, 0];
    const nc = R([a.p[0] - w / 2, a.p[1] - h / 2]);
    a.p = [nc[0] + w / 2, nc[1] + h / 2];
    if (Array.isArray(a.pts)) a.pts = a.pts.map(R);
    return a;
  }
  if (a.type === "ord" && typeof a.row === "number" && a.base) {
    // the row is a line x = row or y = row: rotate a point of it; a quarter turn swaps the axis
    const q = R(a.axis === "y" ? [a.row, a.base[1]] : [a.base[0], a.row]);
    const axis = deg % 180 === 90 ? (a.axis === "y" ? "x" : "y") : a.axis || "x";
    a.row = axis === "y" ? q[0] : q[1];
    a.axis = axis;
  }
  for (const k of POINT_KEYS) if (a[k]) a[k] = R(a[k]);
  if (Array.isArray(a.pts)) a.pts = a.pts.map(R);
  if (Array.isArray(a.r) && a.r.length === 4) {
    const p = R([a.r[0], a.r[1]]);
    const q = R([a.r[2], a.r[3]]);
    a.r = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  }
  const quarter = deg % 180 === 90;
  if (a.type === "shape" && a.kind === "hatch") {
    const ang = a.angle ?? 45;
    a.angle = (((ang - deg) % 180) + 180) % 180;
  } else if (typeof a.angle === "number") {
    a.angle = wrap180(a.angle - deg);
  }
  if (quarter && (a.orient === "h" || a.orient === "v")) a.orient = a.orient === "h" ? "v" : "h";
  else if (quarter && a.type === "dim" && a.kind !== "ali" && !a.orient) a.orient = "v";
  if (quarter && a.type === "rough" && !a.pos) a.rot = a.rot ? 0 : 90;
  if (a.type === "image") a.rot = ((a.rot || 0) + deg) % 360;
  return a;
}

// ------------------------------------------------------------------ grip edits (CMD-D14)
// MOVE / ROTATE / SCALE / MIRROR from a hot grip, about a base point. Unlike moveAnnot (which,
// for a hole table, moves only the table), these move every point of the annotation.

/** Every point of the annotation moved by (dx, dy). */
export function translateAnnot(a, dx, dy) {
  const T = (p) => (Array.isArray(p) && p.length >= 2 ? [p[0] + dx, p[1] + dy] : p);
  for (const k of POINT_KEYS) if (a[k]) a[k] = T(a[k]);
  if (Array.isArray(a.pts)) a.pts = a.pts.map(T);
  if (Array.isArray(a.r) && a.r.length === 4) a.r = [a.r[0] + dx, a.r[1] + dy, a.r[2] + dx, a.r[3] + dy];
  if (a.type === "ord" && typeof a.row === "number") a.row += a.axis === "y" ? dx : dy;
  return a;
}

/** Rotation about the base point by a quarter turn multiple (deg clockwise on screen: 90, 180, 270);
 *  annotations keep their horizontal / vertical texts and tables stay upright. */
export function rotateAbout(a, deg, base, S = null, measure = null) {
  deg = normDeg(deg);
  if (!deg) return a;
  // rotate about the page origin (tables and hole tables keep upright, as on page rotation),
  // then everything moves so that the base point is back where it was
  rotateAnnot(a, deg, 0, 0, S, measure);
  const b2 = rotatePoint(base, deg, 0, 0);
  translateAnnot(a, base[0] - b2[0], base[1] - b2[1]);
  return a;
}

/** Scale about the base point: positions by k, text and symbol sizes too (within the limits). */
export function scaleAbout(a, k, base) {
  if (!(k > 0) || Math.abs(k - 1) < 1e-9) return a;
  scaleAnnot(a, k);
  translateAnnot(a, base[0] * (1 - k), base[1] * (1 - k));
  if (SCALABLE.has(a.type) || a.type === "tblock") a.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round((a.scale || 1) * k * 1000) / 1000));
  // QR code: its side in mm (a QR code under ~10 mm is hard to read with a phone)
  if (a.type === "qr") a.size = Math.min(100, Math.max(10, Math.round((a.size || 20) * k * 10) / 10));
  return a;
}

/** Mirror about the vertical (axis "v": x = base x) or horizontal (axis "h") line through the base.
 *  Texts stay readable (as AutoCAD with MIRRTEXT = 0): only positions are mirrored. */
export function mirrorAbout(a, axis, base, S = null, measure = null) {
  const M = (p) => (Array.isArray(p) && p.length >= 2 ? (axis === "v" ? [2 * base[0] - p[0], p[1]] : [p[0], 2 * base[1] - p[1]]) : p);
  if (UPRIGHT.has(a.type) && S && moveCenter(a, M, S, measure)) return a;
  for (const k of POINT_KEYS) if (a[k]) a[k] = M(a[k]);
  if (Array.isArray(a.pts)) a.pts = a.pts.map(M);
  if (Array.isArray(a.r) && a.r.length === 4) {
    const p = M([a.r[0], a.r[1]]);
    const q = M([a.r[2], a.r[3]]);
    a.r = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  }
  if (a.type === "ord" && typeof a.row === "number") {
    // the row is y = row (values on X) or x = row (values on Y)
    if (axis === "v" && a.axis === "y") a.row = 2 * base[0] - a.row;
    if (axis === "h" && a.axis !== "y") a.row = 2 * base[1] - a.row;
  }
  if (a.type === "shape" && a.kind === "hatch") a.angle = ((180 - (a.angle ?? 45)) % 180 + 180) % 180;
  return a;
}

/** Sheet size changed by factor k: points are multiplied (texts and arrows stay in mm). */
export function scaleAnnot(a, k) {
  const M = (p) => (Array.isArray(p) && p.length >= 2 ? [p[0] * k, p[1] * k] : p);
  for (const key of POINT_KEYS) if (a[key]) a[key] = M(a[key]);
  if (Array.isArray(a.pts)) a.pts = a.pts.map(M);
  if (Array.isArray(a.r) && a.r.length === 4) a.r = a.r.map((v) => v * k);
  if (typeof a.textShift === "number") a.textShift *= k;
  if (a.type === "ord" && typeof a.row === "number") a.row *= k;
  return a;
}

/** ISO sheet formats (long side, mm). */
export const SHEETS = [["A4", 297], ["A3", 420], ["A2", 594], ["A1", 841], ["A0", 1189]];

/**
 * Applies a page operation to a list of annotations (a new copy).
 *  - {op:"rotate", pages:[n…], delta, sizes:[[W,H]…]} — sizes = visual dimensions before
 *  - {op:"delete", pages:[n…]}
 *  - {op:"move", page, to}
 */
export function applyPageOp(annots, op, S = null, measure = null) {
  const out = JSON.parse(JSON.stringify(annots));
  if (op.op === "rotate") {
    const set = new Set(op.pages);
    const deg = normDeg(op.delta);
    for (const a of out) {
      const n = a.page || 0;
      if (!set.has(n)) continue;
      const [W, H] = op.sizes[n];
      rotateAnnot(a, deg, W, H, S, measure);
    }
    return out;
  }
  if (op.op === "scale") {
    const set = new Set(op.pages ?? [...Array(op.count).keys()]);
    for (const a of out) if (set.has(a.page || 0)) scaleAnnot(a, op.factor);
    return out;
  }
  if (op.op === "delete") {
    const drop = new Set(op.pages);
    return out
      .filter((a) => !drop.has(a.page || 0))
      .map((a) => ({ ...a, page: (a.page || 0) - op.pages.filter((d) => d < (a.page || 0)).length }));
  }
  if (op.op === "move") {
    const order = [...Array(op.count).keys()];
    order.splice(op.to, 0, order.splice(op.page, 1)[0]);
    const where = new Map(order.map((old, i) => [old, i]));
    return out.map((a) => ({ ...a, page: where.get(a.page || 0) ?? a.page }));
  }
  return out;
}
