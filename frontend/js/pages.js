// Operații pe pagini (rotire, ștergere, mutare): adnotările se transformă odată cu pagina, ca să
// rămână pe desen. Coordonatele sunt vizuale (puncte, y în jos); rotirea e în sens orar, ca /Rotate.
import { build, moveAnnot } from "./annots.js";

const POINT_KEYS = ["p1", "p2", "p3", "c", "p", "v", "target", "pos", "vp", "tp", "elbow"];
// adnotări care rămân mereu orizontale (tabele): se mută întregi, nu se rotesc punct cu punct
const UPRIGHT = new Set(["revtab", "bom"]);

/** Un punct al paginii W×H după rotirea paginii cu `deg` (90, 180, 270) în sens orar. */
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

/** Rotește o adnotare odată cu pagina (deg în sens orar). Unghiurile din adnotări sunt
 *  trigonometrice pe ecran, deci scad cu deg. */
export function rotateAnnot(a, deg, W, H, S = null, measure = null) {
  deg = normDeg(deg);
  if (!deg) return a;
  const R = (p) => (Array.isArray(p) && p.length >= 2 ? rotatePoint(p, deg, W, H) : p);
  if (UPRIGHT.has(a.type) && S) {
    // tabelul ajunge cu centrul unde ajunge centrul lui, dar rămâne orizontal
    const b = build(a, S, measure).bbox;
    if (b) {
      const c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      const nc = R(c);
      moveAnnot(a, nc[0] - c[0], nc[1] - c[1]);
      return a;
    }
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
  return a;
}

/** Mărimea foii schimbată cu factorul k: punctele se înmulțesc (textele și săgețile rămân în mm). */
export function scaleAnnot(a, k) {
  const M = (p) => (Array.isArray(p) && p.length >= 2 ? [p[0] * k, p[1] * k] : p);
  for (const key of POINT_KEYS) if (a[key]) a[key] = M(a[key]);
  if (Array.isArray(a.pts)) a.pts = a.pts.map(M);
  if (Array.isArray(a.r) && a.r.length === 4) a.r = a.r.map((v) => v * k);
  if (typeof a.textShift === "number") a.textShift *= k;
  return a;
}

/** Formatele de foaie ISO (latura lungă, mm). */
export const SHEETS = [["A4", 297], ["A3", 420], ["A2", 594], ["A1", 841], ["A0", 1189]];

/**
 * Aplică o operație pe pagini unei liste de adnotări (o copie nouă).
 *  - {op:"rotate", pages:[n…], delta, sizes:[[W,H]…]} — sizes = dimensiunile vizuale înainte
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
