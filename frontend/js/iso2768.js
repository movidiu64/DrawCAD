// ISO 2768-1:1989 general tolerances for linear and angular dimensions without an individual tolerance,
// in four classes: f (fine), m (medium), c (coarse), v (very coarse). ISO 2768-2 (H, K, L, geometrical
// tolerances) only goes into the designation text ("ISO 2768-mK"). Pure: tested in Node.
const K = 72 / 25.4; // pt per mm (as in annots.js; no import, tblock.js uses this module)

const CLASSES = ["f", "m", "c", "v"];

// Table 1 — linear dimensions except broken edges: [over, up to (inclusive)], ± mm per class
// (null = no value in the standard: the deviation is written on the dimension).
export const LINEAR = [
  [0.5, 3, [0.05, 0.1, 0.2, null]],
  [3, 6, [0.05, 0.1, 0.3, 0.5]],
  [6, 30, [0.1, 0.2, 0.5, 1]],
  [30, 120, [0.15, 0.3, 0.8, 1.5]],
  [120, 400, [0.2, 0.5, 1.2, 2.5]],
  [400, 1000, [0.3, 0.8, 2, 4]],
  [1000, 2000, [0.5, 1.2, 3, 6]],
  [2000, 4000, [null, 2, 4, 8]],
];

// Table 2 — broken edges (external radii and chamfer heights), ± mm
export const EDGES = [
  [0.5, 3, [0.2, 0.2, 0.4, 0.4]],
  [3, 6, [0.5, 0.5, 1, 1]],
  [6, Infinity, [1, 1, 2, 2]],
];

// Table 3 — angular dimensions, by the length of the shorter side (mm), ± minutes of arc
export const ANGULAR = [
  [0, 10, [60, 60, 90, 180]],
  [10, 50, [30, 30, 60, 120]],
  [50, 120, [20, 20, 30, 60]],
  [120, 400, [10, 10, 15, 30]],
  [400, Infinity, [5, 5, 10, 20]],
];

/** "ISO 2768-mK" from the document settings (gtol = f/m/c/v, gtol2 = H/K/L), or "" without a class. */
export function gtolLabel(S) {
  const c = S && CLASSES.includes(S.gtol) ? S.gtol : "";
  if (!c) return "";
  const g2 = S && ["H", "K", "L"].includes(S.gtol2) ? S.gtol2 : "";
  return `ISO 2768-${c}${g2}`;
}

/** Row of a table for a size: the first range is closed at its lower end ("0.5 up to 3"), the others
 *  open ("over 3 up to 6"). Below the first range: null. */
function rowOf(table, size) {
  if (!(size >= table[0][0])) return null;
  return table.find(([lo, hi], i) => (i === 0 ? size >= lo : size > lo) && size <= hi + 1e-9) || null;
}

/**
 * General tolerance of a size in a class.
 * kind: "lin" (Table 1), "edge" (Table 2), "ang" (Table 3, size = shorter side in mm).
 * → { pm, unit: "mm" | "min", range: [over, up to] } or null when the standard gives no value.
 */
export function generalTol(kind, size, cls) {
  const ci = CLASSES.indexOf(cls);
  if (ci < 0 || !Number.isFinite(size)) return null;
  const table = kind === "ang" ? ANGULAR : kind === "edge" ? EDGES : LINEAR;
  const row = kind === "ang" ? table.find(([lo, hi], i) => (i === 0 ? size >= 0 : size > lo) && size <= hi + 1e-9) : rowOf(table, size);
  if (!row || row[2][ci] == null) return null;
  return { pm: row[2][ci], unit: kind === "ang" ? "min" : "mm", range: [row[0], row[1]] };
}

/** Minutes of arc as written on drawings: 90 → 1°30', 30 → 0°30', 60 → 1°. */
export function fmtMinutes(min) {
  const d = Math.floor(min / 60 + 1e-9);
  const m = Math.round(min - d * 60);
  return m ? `${d}°${m}'` : `${d}°`;
}

/**
 * The general tolerance that applies to a dimension annotation (dim, rad, ang), from its built value
 * (b.nominal, real mm or degrees). null when the class is not set, the dimension has its own
 * tolerance or replacement text, or the standard has no value for it.
 * → { pm, unit, kind, size, label } (pm in mm, or in minutes for angles)
 */
export function gtolFor(a, b, S) {
  if (!S || !CLASSES.includes(S.gtol) || !a || !b) return null;
  if (a.tol && a.tol.mode && a.tol.mode !== "none") return null;
  if (a.textOverride && String(a.textOverride).trim()) return null;
  let kind;
  let size;
  if (a.type === "ang") {
    if (!a.v || !a.p1 || !a.p2) return null;
    kind = "ang";
    const leg = (p) => Math.hypot(p[0] - a.v[0], p[1] - a.v[1]);
    size = (Math.min(leg(a.p1), leg(a.p2)) / K) * (Number(S.scale) || 1);
  } else if (a.type === "dim" || a.type === "rad") {
    kind = a.type === "rad" && !a.dia && a.edge ? "edge" : "lin";
    size = Math.abs(Number(b.nominal));
  } else return null;
  const r = generalTol(kind, size, S.gtol);
  return r ? { ...r, kind, size, label: gtolLabel(S) } : null;
}
