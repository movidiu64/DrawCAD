// Typed points, as at AutoCAD's command prompt (docs/design/commands-v2.md, CMD-D1 to D4):
//   x,y   #x,y   @dx,dy   @d<a   d<a   #d<a   @   a lone number (direct distance)
// Values are real mm (paper mm × settings.scale), Y up, angles in degrees counter-clockwise
// from +X. Page points are visual PDF points (y down), as everywhere else in the app.
import { K } from "./annots.js";

const NUM = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const RE_XY = new RegExp(`^(${NUM}),(${NUM})$`);
const RE_POLAR = new RegExp(`^(${NUM})<(${NUM})$`);
const RE_NUM = new RegExp(`^${NUM}$`);

/**
 * Parses a typed point. Returns { kind, … } or null when the text is not a point:
 *   abs {x, y} · rel {x, y} · polarAbs {d, a} · polarRel {d, a} · last · dist {d}
 * The comma separates X and Y and the decimal mark is a point, as in AutoCAD.
 */
export function parsePoint(text) {
  let s = String(text ?? "").replace(/\s+/g, "");
  if (!s) return null;
  let rel = false;
  let forceAbs = false;
  if (s[0] === "@") {
    rel = true;
    s = s.slice(1);
    if (!s) return { kind: "last" };
  } else if (s[0] === "#") {
    forceAbs = true;
    s = s.slice(1);
  }
  let m = RE_XY.exec(s);
  if (m) return { kind: rel ? "rel" : "abs", x: Number(m[1]), y: Number(m[2]), forceAbs };
  m = RE_POLAR.exec(s);
  if (m) return { kind: rel ? "polarRel" : "polarAbs", d: Number(m[1]), a: Number(m[2]), forceAbs };
  if (!rel && !forceAbs && RE_NUM.test(s)) return { kind: "dist", d: Number(s) };
  return null;
}

/** The default origin of a page: its bottom-left corner (visual coordinates). */
export function defaultOrigin(pageH) {
  return [0, pageH];
}

/** Page point → user coordinates (real mm from the origin, Y up). */
export function toUser(pt, origin, scale = 1) {
  const k = Number(scale) || 1;
  return [((pt[0] - origin[0]) / K) * k, ((origin[1] - pt[1]) / K) * k];
}

/** User coordinates (real mm from the origin, Y up) → page point. */
export function fromUser(xy, origin, scale = 1) {
  const k = Number(scale) || 1;
  return [origin[0] + (xy[0] / k) * K, origin[1] - (xy[1] / k) * K];
}

/** A displacement in real mm (Y up) → page offset. */
function offset(dx, dy, scale) {
  const k = Number(scale) || 1;
  return [(dx / k) * K, (-dy / k) * K];
}

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Resolves a parsed point to a page point.
 * ctx: { last: page point or null, cursor: page point or null, origin, scale }
 * Returns { p } or { error } (Romanian UI text).
 */
export function resolvePoint(q, ctx) {
  if (!q) return { error: "Punct invalid" };
  const { last, cursor, origin, scale } = ctx;
  const need = () => ({ error: "Nu există un punct anterior pentru @" });
  switch (q.kind) {
    case "abs":
      return { p: fromUser([q.x, q.y], origin, scale) };
    case "polarAbs":
      return { p: fromUser([q.d * Math.cos(rad(q.a)), q.d * Math.sin(rad(q.a))], origin, scale) };
    case "last":
      return last ? { p: [...last] } : need();
    case "rel": {
      if (!last) return need();
      const o = offset(q.x, q.y, scale);
      return { p: [last[0] + o[0], last[1] + o[1]] };
    }
    case "polarRel": {
      if (!last) return need();
      const o = offset(q.d * Math.cos(rad(q.a)), q.d * Math.sin(rad(q.a)), scale);
      return { p: [last[0] + o[0], last[1] + o[1]] };
    }
    case "dist": {
      // direct distance entry: along the cursor direction (the cursor is already snapped, so
      // ortho, polar and tracking apply)
      if (!last) return { error: "Distanța singură are nevoie de un punct anterior" };
      if (!cursor) return { error: "Mută cursorul în direcția dorită" };
      const L = Math.hypot(cursor[0] - last[0], cursor[1] - last[1]);
      if (L < 1e-9) return { error: "Mută cursorul în direcția dorită" };
      const k = Number(scale) || 1;
      const t = ((q.d / k) * K) / L;
      return { p: [last[0] + (cursor[0] - last[0]) * t, last[1] + (cursor[1] - last[1]) * t] };
    }
    default:
      return { error: "Punct invalid" };
  }
}

/** Point modifiers typed at a point prompt: FROM (base + offset), M2P / MTP (midpoint of two). */
export function parsePointMod(text) {
  const q = String(text || "").trim().toUpperCase().replace(/^[_']+/, "");
  if (q === "FROM" || q === "FRO") return "from";
  if (q === "M2P" || q === "MTP") return "m2p";
  return null;
}

/** Ortho while Shift is held: Shift turns it on when off and off when on (as in AutoCAD). */
export function orthoActive(orthoOn, shift) {
  return !!orthoOn !== !!shift;
}

/**
 * Where a key typed during a command goes (CMD-D3):
 *  - "dyn": the length / angle box next to the cursor (digits, the comma is a decimal mark there);
 *  - "cmd": the command line, which reads the AutoCAD point syntax;
 *  - null: not a point key (letters, Enter… are handled elsewhere).
 * state: { dynUsable } — the box is on and there is a previous point.
 * A leading + or − stays zoom when the box is not in use; type the point in the command line
 * (or start it with # or a digit) for a negative first value.
 */
export function routeKey(state, key) {
  if (key === "@" || key === "#" || key === "<") return "cmd";
  if (state.dynUsable && /^[0-9.,-]$/.test(key)) return "dyn";
  if (/^[0-9.]$/.test(key)) return "cmd";
  return null;
}
