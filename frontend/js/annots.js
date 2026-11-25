// Annotation model and generation of drawing primitives.
// All coordinates: visual PDF points (y down). Text angles: degrees, counter-clockwise on screen.
import { deviations, fmtDev } from "./iso286.js";
import { symbolPrims, GDT_BY_ID, MODIFIERS } from "./gdt.js";
import { buildShape, SHAPE_NAMES } from "./shapes.js";
import { buildSection, buildDetail, buildBalloon } from "./symbols.js";
import { buildTblock } from "./tblock.js";
import { qrMatrix } from "./qr.js";

export const K = 72 / 25.4; // pt per mm
export const CAP = 1515 / 2048; // cap height in osifont, relative to the em

export const DEFAULT_SETTINGS = {
  textH: 3.5, // mm, cap height (ISO 3098)
  arrowLen: 3, // mm
  lineW: 0.25, // mm
  sep: ",",
  isoDisplay: "codeDev",
  codeSpace: false, // "Ø25k6" (ISO 286) or "Ø25 k6"
  arrow: "closed",
  dlang: "ro", // language of the texts on the drawing: table headers, default notes
  scale: 1, // real mm per paper mm (1 = scale 1:1)
  revNo: "1",
  extGap: 0.5,
  extOver: 2,
  gtol: "", // ISO 2768-1 general tolerance class: "", f, m, c, v
  gtol2: "", // ISO 2768-2 class for the designation text: "", H, K, L
};

export const TYPE_NAMES = {
  dim: "Cotă",
  rad: "Cotă rază",
  ang: "Cotă unghiulară",
  rough: "Rugozitate",
  note: "Note",
  revtab: "Tabel de revizii",
  lead: "Linie de indicație",
  text: "Text",
  gdt: "Cadru GD&T",
  datum: "Bază de referință",
  strike: "Cotă tăiată (revizie)",
  white: "Acoperire albă",
  redact: "Ștergere din original",
  shape: "Desen",
  section: "Plan de secționare",
  detail: "Detaliu",
  balloon: "Reper de poziție",
  bom: "Listă de componente",
  ink: "Înnegrire linii originale",
  ord: "Cote ordonate",
  holes: "Tabel de găuri",
  ucs: "Originea coordonatelor",
  image: "Imagine",
  tblock: "Indicator",
  cloud: "Nor de revizie",
  mark: "Marcaj",
  comment: "Comentariu",
  stamp: "Ștampilă",
  qr: "Cod QR",
  watermark: "Filigran",
};

export function typeName(a) {
  if (a.type === "rad" && a.dia) return "Cotă diametru";
  return (a.type === "shape" && SHAPE_NAMES[a.kind]) || TYPE_NAMES[a.type] || a.type;
}

// ------------------------------------------------------------------ vectors
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : null;
};
const perpL = (a) => [a[1], -a[0]]; // "up" relative to the text direction, on screen

export function derive(settings) {
  const S = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  S.h = S.textH * K;
  S.F = S.h / CAP;
  S.aw = S.arrowLen * K;
  S.lw = S.lineW * K;
  S.gap = S.extGap * K;
  S.over = S.extOver * K;
  return S;
}

// ------------------------------------------------------------------ formatting
export function round(v, d = 3) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function fmtNum(v, sep = ",", maxDec = 3) {
  if (v == null || Number.isNaN(v)) return "";
  let s = round(v, maxDec).toFixed(maxDec).replace(/\.?0+$/, "");
  if (s === "-0") s = "0";
  return s.replace(".", sep);
}

/** signed mm, at least 3 decimals: +0,015 / -0,1 → -0,100 */
export function fmtSigned(mm, sep = ",") {
  return fmtDev(mm * 1000, sep, true);
}

export function fmtLimit(mm, sep = ",") {
  let s = mm.toFixed(4).replace(/0$/, "");
  if ((s.split(".")[1] || "").length < 3) s = mm.toFixed(3);
  return s.replace(".", sep);
}

export function parseNum(str) {
  if (str == null) return null;
  const s = String(str).trim().replace(",", ".").replace(/^\+/, "");
  if (s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// ------------------------------------------------------------------ labels
/**
 * Builds the text of a dimension as a list of "runs": { txt, x, dy, s, w }.
 * x advances along the text direction, dy is above the baseline (pt).
 */
export function labelRuns(a, S, measure, nominal, prefix) {
  const F = S.F;
  const h = S.h;
  const sep = S.sep;
  const runs = [];
  let x = 0;
  let iso = null;
  const push = (txt, s = F, dy = 0) => {
    const w = measure(txt, s);
    runs.push({ txt, x, dy, s, w });
    x += w;
  };
  const stack = (up, lo) => {
    const fs = F * 0.72;
    const hs = h * 0.72;
    const wu = measure(up, fs);
    const wl = measure(lo, fs);
    runs.push({ txt: up, x, dy: hs + h * 0.3, s: fs, w: wu });
    runs.push({ txt: lo, x, dy: 0, s: fs, w: wl });
    x += Math.max(wu, wl);
  };
  const paren = (txt) => push(txt, F * 1.55, -h * 0.2);
  const gap = () => {
    x += h * 0.22;
  };

  const deg = a.type === "ang" || a.deg === true;
  const unit = deg ? "°" : "";
  // deviations: mm with at least 3 decimals; for angles, degrees without needless zeros
  const fd = (v) => (deg ? (v > 0 ? "+" : v < 0 ? "-" : "") + fmtNum(Math.abs(v), sep, 3) + "°" : fmtSigned(v, sep));
  const fabs = (v) => (deg ? fmtNum(Math.abs(v), sep, 3) + "°" : fmtSigned(Math.abs(v), sep).slice(1));
  const main = a.textOverride && a.textOverride.trim() ? a.textOverride.trim() : prefix + fmtNum(nominal, sep, deg ? 2 : 3) + unit;
  const t = a.tol || { mode: "none" };
  const space = S.codeSpace ? " " : "";

  if (t.mode === "pm" && t.pm) {
    // an angle written from a general tolerance: degrees and minutes (±0°30')
    if (deg && t.dms) {
      const min = Math.round(Math.abs(t.pm) * 60);
      const d = Math.floor(min / 60);
      push(main + "±" + (min % 60 ? `${d}°${min % 60}'` : `${d}°`));
    } else push(main + "±" + fabs(t.pm));
  } else if (t.mode === "dev" && (t.up != null || t.lo != null)) {
    const up = t.up || 0;
    const lo = t.lo || 0;
    if (Math.abs(up + lo) < 1e-9 && up !== 0) {
      push(main + "±" + fabs(up));
    } else {
      push(main);
      gap();
      stack(fd(up), fd(lo));
    }
  } else if (t.mode === "iso" && t.fit && !deg) {
    iso = deviations(nominal, t.fit);
    const disp = t.disp || S.isoDisplay;
    if (!iso.ok) {
      push(main + space + t.fit);
    } else {
      const code = space + iso.code;
      const sym = Math.abs(iso.upper + iso.lower) < 1e-9 && iso.upper !== 0;
      const dUp = fmtDev(iso.upper, sep);
      const dLo = fmtDev(iso.lower, sep);
      if (disp === "code") {
        push(main + code);
      } else if (disp === "codeDev") {
        push(main + code);
        gap();
        paren("(");
        if (sym) push("±" + fmtDev(iso.upper, sep, false));
        else stack(dUp, dLo);
        paren(")");
      } else if (disp === "codeLim") {
        push(main + code);
        gap();
        paren("(");
        stack(fmtLimit(nominal + iso.upper / 1000, sep), fmtLimit(nominal + iso.lower / 1000, sep));
        paren(")");
      } else {
        push(main);
        if (sym) push("±" + fmtDev(iso.upper, sep, false));
        else {
          gap();
          stack(dUp, dLo);
        }
      }
    }
  } else {
    push(main);
  }
  return { runs, w: x, iso };
}

// ------------------------------------------------------------------ helper primitives
function lineP(a, b, S, c) {
  return { t: "L", p: [a[0], a[1], b[0], b[1]], w: S.lw, c };
}

function arrowP(tip, d, S, c) {
  // d: the direction the arrow "points" (towards the tip)
  const aw = S.aw;
  const back = sub(tip, mul(d, aw));
  const n = [-d[1], d[0]];
  if (S.arrow === "open") {
    const hw = aw * 0.27;
    return [lineP(tip, add(back, mul(n, hw)), S, c), lineP(tip, add(back, mul(n, -hw)), S, c)];
  }
  if (S.arrow === "tick") {
    const k = aw * 0.45;
    const q = norm(add(d, n));
    return [{ t: "L", p: [tip[0] - q[0] * k, tip[1] - q[1] * k, tip[0] + q[0] * k, tip[1] + q[1] * k], w: S.lw * 2, c }];
  }
  if (S.arrow === "dot") {
    return [{ t: "C", p: tip, r: aw * 0.18, fill: true, nostroke: true, w: S.lw, c }];
  }
  const hw = aw * 0.17;
  const b1 = add(back, mul(n, hw));
  const b2 = add(back, mul(n, -hw));
  return [{ t: "P", p: [tip[0], tip[1], b1[0], b1[1], b2[0], b2[1]], close: true, fill: true, w: S.lw * 0.5, c }];
}

function textAngle(dir) {
  // readable direction (from below or from the right, ISO 129 method 1) and its angle
  let tu = dir;
  let ang = (Math.atan2(-tu[1], tu[0]) * 180) / Math.PI;
  if (ang <= -90 + 1e-6 || ang > 90 + 1e-6) {
    tu = mul(tu, -1);
    ang = (Math.atan2(-tu[1], tu[0]) * 180) / Math.PI;
  }
  return { tu, ang, up: perpL(tu) };
}

function placeRuns(lab, origin, tu, up, ang, c) {
  return lab.runs.map((r) => {
    const p = add(add(origin, mul(tu, r.x)), mul(up, r.dy));
    return { t: "T", p, s: r.s, a: ang, txt: r.txt, tw: r.w, c };
  });
}

// ------------------------------------------------------------------ builders per type

/**
 * Linear dimensions in a series, as DIMCONTINUE and DIMBASELINE do: `pts` are the points to
 * dimension, `at` the position of the (first) dimension line. Placed below or above the points the
 * dimensions are horizontal, to the left or right vertical.
 *  - "chain": the points sorted along the axis, one dimension between each pair, all on one line;
 *  - "base": every dimension from the first point, the shortest nearest the part, the next ones
 *    `step` further away.
 * `orient` ("h" / "v") forces the direction instead of deducing it from `at`.
 * Returns the geometry of each dimension: { orient, p1, p2, p3 }.
 */
export function dimSeries(pts, at, mode, step, force = null) {
  if (!Array.isArray(pts) || pts.length < 2 || !at) return [];
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const dxo = at[0] < x0 ? x0 - at[0] : at[0] > x1 ? at[0] - x1 : 0;
  const dyo = at[1] < y0 ? y0 - at[1] : at[1] > y1 ? at[1] - y1 : 0;
  const orient = force === "h" || force === "v" ? force : dyo > dxo ? "h" : dxo > dyo ? "v" : x1 - x0 >= y1 - y0 ? "h" : "v";
  const ax = orient === "h" ? 0 : 1; // the coordinate the dimensions measure
  const eps = 0.05 * K;
  const out = [];
  if (mode === "base") {
    const base = pts[0];
    const rest = pts.slice(1).filter((q) => Math.abs(q[ax] - base[ax]) >= eps);
    rest.sort((u, w) => Math.abs(u[ax] - base[ax]) - Math.abs(w[ax] - base[ax]));
    // the same length twice: kept once
    const seen = [];
    const lo = orient === "h" ? y0 : x0;
    const hi = orient === "h" ? y1 : x1;
    const a = at[1 - ax];
    const dir = a > hi ? 1 : a < lo ? -1 : a >= base[1 - ax] ? 1 : -1; // away from the part
    for (const q of rest) {
      if (seen.some((v) => Math.abs(v - q[ax]) < eps)) continue;
      seen.push(q[ax]);
      const k = out.length;
      const p3 = orient === "h" ? [at[0], at[1] + dir * k * step] : [at[0] + dir * k * step, at[1]];
      out.push({ orient, p1: [...base], p2: [...q], p3 });
    }
    return out;
  }
  const sorted = [...pts].sort((u, w) => u[ax] - w[ax]);
  const kept = [sorted[0]];
  for (const q of sorted.slice(1)) if (q[ax] - kept[kept.length - 1][ax] >= eps) kept.push(q);
  for (let i = 0; i + 1 < kept.length; i++) out.push({ orient, p1: [...kept[i]], p2: [...kept[i + 1]], p3: [...at] });
  return out;
}

function buildDim(a, S, measure) {
  const c = a.layer || "add";
  const { p1, p2, p3 } = a;
  let u;
  if (a.kind === "ali") u = norm(sub(p2, p1)) || [1, 0];
  else if (a.kind === "rot") {
    // rotated: along rotA degrees, counter-clockwise on the sheet (y grows down)
    const t = ((Number(a.rotA) || 0) * Math.PI) / 180;
    u = [Math.cos(t), -Math.sin(t)];
  } else u = a.orient === "v" ? [0, 1] : [1, 0];
  const n = [-u[1], u[0]];
  const A = add(p1, mul(n, dot(sub(p3, p1), n)));
  const B = add(p2, mul(n, dot(sub(p3, p2), n)));
  const Lpt = Math.abs(dot(sub(p2, p1), u));
  const measured = (Lpt / K) * S.scale;
  const prims = [];

  for (const [P, Q] of [[p1, A], [p2, B]]) {
    const d = sub(Q, P);
    const L = len(d);
    if (L > S.gap + 0.5) {
      const e = mul(d, 1 / L);
      prims.push(lineP(add(P, mul(e, S.gap)), add(Q, mul(e, S.over)), S, c));
    }
  }
  const AB = sub(B, A);
  const Ld = len(AB);
  const dir = Ld > 1e-6 ? mul(AB, 1 / Ld) : u;
  const nominal = a.nominal != null ? a.nominal : round(measured, 2);
  const lab = labelRuns(a, S, measure, nominal, a.prefix || "");
  // best fit (as ISO 129-1 drawings do it): value and arrows inside; if not, the value inside and the
  // arrows outside; if the value does not fit either, it goes next to an arrow, on the free side (textOut)
  const fitAll = lab.w + 2 * S.aw * 1.1 <= Ld;
  const fitText = !fitAll && lab.w + 0.4 * K <= Ld;
  const inside = fitAll || (!fitText && Ld >= 2.4 * S.aw + S.h);
  // for diameters, filled arrows like the leader, whatever terminators were chosen for dimensions
  // (the oblique stroke and the dot are not used on diameters)
  const SA = (a.prefix || "").startsWith("Ø") ? { ...S, arrow: "closed" } : S;
  if (inside) {
    prims.push(lineP(A, B, S, c));
    prims.push(...arrowP(A, mul(dir, -1), SA, c), ...arrowP(B, dir, SA, c));
  } else {
    prims.push(lineP(sub(A, mul(dir, S.aw * 2.2)), add(B, mul(dir, S.aw * 2.2)), S, c));
    prims.push(...arrowP(A, dir, SA, c), ...arrowP(B, mul(dir, -1), SA, c));
  }

  const { tu, ang, up } = textAngle(dir);
  const mid0 = mul(add(A, B), 0.5);
  let shift = a.textShift;
  const out = shift == null && !fitAll && !fitText;
  if (shift == null) {
    shift = out ? Ld / 2 + (inside ? S.aw * 0.8 : S.aw * 2.6) + lab.w / 2 : 0;
    // "left" / "right" as the reader sees it: along the text direction
    if (out && a.textOut === "l") shift = -shift;
  }
  const half = Ld / 2 + (inside ? 0 : S.aw * 2.2);
  const lo = shift - lab.w / 2 - S.h * 0.3;
  const hi = shift + lab.w / 2 + S.h * 0.3;
  if (hi > half) prims.push(lineP(add(mid0, mul(tu, half)), add(mid0, mul(tu, hi)), S, c));
  if (lo < -half) prims.push(lineP(add(mid0, mul(tu, -half)), add(mid0, mul(tu, lo)), S, c));
  const mid = add(mid0, mul(tu, shift));
  const lift = Math.max(0.6 * K, 0.3 * S.h);
  const origin = add(sub(mid, mul(tu, lab.w / 2)), mul(up, lift));
  prims.push(...placeRuns(lab, origin, tu, up, ang, c));
  const tcenter = add(mid, mul(up, lift + S.h * 0.6));
  return {
    prims,
    measured,
    nominal,
    iso: lab.iso,
    meta: { mid0, tu, out },
    handles: [
      { k: "p1", p: p1 },
      { k: "p2", p: p2 },
      { k: "p3", p: mul(add(A, B), 0.5), move: true },
      { k: "tx", p: tcenter },
    ],
  };
}

function buildRad(a, S, measure) {
  // radius (R) or diameter on a circle (Ø): arrow on the outline, line towards the center. With a "shoulder", the text sits
  // horizontally above a short line at the end of the leader (as on shop drawings).
  const c = a.layer || "add";
  const R = len(sub(a.p, a.c));
  const dia = !!a.dia;
  const d = norm(sub(a.p3, a.c)) || norm(sub(a.p, a.c)) || [1, 0];
  const q = add(a.c, mul(d, R));
  const far = len(sub(a.p3, a.c)) > R;
  // diameters get filled arrows, like the leader (ISO 129: no oblique stroke)
  const SA = dia ? { ...S, arrow: "closed" } : S;
  const shoulder = far && (a.style || (dia ? "shoulder" : "aligned")) === "shoulder";
  const measured = (((dia ? 2 : 1) * R) / K) * S.scale;
  const nominal = a.nominal != null ? a.nominal : round(measured, 2);
  const lab = labelRuns(a, S, measure, nominal, a.prefix ?? (dia ? "Ø" : "R"));
  const prims = [];
  const lift = Math.max(0.6 * K, 0.3 * S.h);
  const handles = [
    { k: "c", p: a.c },
    { k: "p", p: a.p },
    { k: "p3", p: a.p3 },
  ];
  if (shoulder) {
    prims.push(lineP(q, a.p3, S, c), ...arrowP(q, mul(d, -1), SA, c));
    // the shoulder points away from the circle
    const side = a.p3[0] >= a.c[0] ? 1 : -1;
    const pad = S.h * 0.3;
    const P2 = [a.p3[0] + side * (lab.w + 2 * pad), a.p3[1]];
    prims.push(lineP(a.p3, P2, S, c));
    const { tu, ang, up } = textAngle([1, 0]);
    const origin = add([Math.min(a.p3[0], P2[0]) + pad, a.p3[1]], mul(up, lift));
    prims.push(...placeRuns(lab, origin, tu, up, ang, c));
    return { prims, measured, nominal, iso: lab.iso, handles };
  }
  let s0;
  let s1;
  if (far) {
    s0 = q;
    s1 = a.p3;
    prims.push(lineP(q, a.p3, S, c), ...arrowP(q, mul(d, -1), SA, c));
  } else if (dia) {
    // inside: the line goes through the center, with arrows at both ends of the diameter
    s0 = sub(a.c, mul(d, R));
    s1 = q;
    prims.push(lineP(s0, q, S, c), ...arrowP(q, d, SA, c), ...arrowP(s0, mul(d, -1), SA, c));
  } else {
    s0 = a.c;
    s1 = q;
    prims.push(lineP(a.c, q, S, c), ...arrowP(q, d, S, c));
  }
  const { tu, ang, up } = textAngle(norm(sub(s1, s0)) || d);
  const mid = mul(add(s0, s1), 0.5);
  const origin = add(sub(mid, mul(tu, lab.w / 2)), mul(up, lift));
  prims.push(...placeRuns(lab, origin, tu, up, ang, c));
  return { prims, measured, nominal, iso: lab.iso, handles };
}

// "on screen" angle (counter-clockwise, y down) of a vector
const angOf = (v) => Math.atan2(-v[1], v[0]);
const TAU = Math.PI * 2;
const wrap = (x) => ((x % TAU) + TAU) % TAU;
const polar = (c, r, th) => [c[0] + r * Math.cos(th), c[1] - r * Math.sin(th)];

/**
 * The angular sector containing direction p3, out of the four formed by the two lines
 * through the vertex. Returns { s, e, sweep, legS, legE } — the ends in radians, counter-clockwise,
 * and for each end the index of the leg (0/1) and whether it is the leg's direction or its opposite.
 */
export function angleSector(v, p1, p2, p3) {
  const a1 = angOf(sub(p1, v));
  const a2 = angOf(sub(p2, v));
  const dirs = [
    { th: wrap(a1), leg: 0, rev: false },
    { th: wrap(a2), leg: 1, rev: false },
    { th: wrap(a1 + Math.PI), leg: 0, rev: true },
    { th: wrap(a2 + Math.PI), leg: 1, rev: true },
  ].sort((x, y) => x.th - y.th);
  const t = wrap(angOf(sub(p3, v)));
  for (let i = 0; i < 4; i++) {
    const s = dirs[i];
    const e = dirs[(i + 1) % 4];
    const sweep = wrap(e.th - s.th) || TAU;
    if (wrap(t - s.th) <= sweep + 1e-9) return { s: s.th, e: s.th + sweep, sweep, ends: [s, e] };
  }
  return { s: dirs[0].th, e: dirs[1].th, sweep: wrap(dirs[1].th - dirs[0].th), ends: [dirs[0], dirs[1]] };
}

function buildAng(a, S, measure) {
  const c = a.layer || "add";
  const V = a.v;
  const legs = [a.p1, a.p2];
  const sec = angleSector(V, a.p1, a.p2, a.p3);
  const r = Math.max(len(sub(a.p3, V)), S.aw * 2);
  const measured = (sec.sweep * 180) / Math.PI;
  const prims = [];

  // extension lines along the legs, past the arc
  for (const end of sec.ends) {
    const th = end.th;
    const d = [Math.cos(th), -Math.sin(th)];
    const legLen = end.rev ? 0 : len(sub(legs[end.leg], V));
    if (r > legLen + S.gap) {
      prims.push(lineP(add(V, mul(d, legLen + S.gap)), add(V, mul(d, r + S.over)), S, c));
    }
  }

  // the dimension arc, as a polyline
  const arcLen = r * sec.sweep;
  const inside = arcLen >= 2.4 * S.aw + S.h * 0.5;
  const ext = inside ? 0 : (S.aw * 2.2) / r;
  const s0 = sec.s - ext;
  const s1 = sec.e + ext;
  const n = Math.max(8, Math.ceil(((s1 - s0) * 180) / Math.PI / 3));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(...polar(V, r, s0 + ((s1 - s0) * i) / n));
  prims.push({ t: "P", p: pts, w: S.lw, c });
  const tanAt = (th, forward) => (forward ? [-Math.sin(th), -Math.cos(th)] : [Math.sin(th), Math.cos(th)]);
  const tipS = polar(V, r, sec.s);
  const tipE = polar(V, r, sec.e);
  prims.push(...arrowP(tipS, tanAt(sec.s, !inside), S, c), ...arrowP(tipE, tanAt(sec.e, inside), S, c));

  // the value: horizontal, outside the arc, on the bisector
  const nominal = a.nominal != null ? a.nominal : round(measured, 2);
  const lab = labelRuns(a, S, measure, nominal, "");
  const mid = (sec.s + sec.e) / 2 + (a.textShift || 0) / r;
  const u = [Math.cos(mid), -Math.sin(mid)];
  const hb = S.h * 0.9;
  const extent = Math.abs(u[0]) * (lab.w / 2) + Math.abs(u[1]) * hb;
  const cpt = add(V, mul(u, r + Math.max(0.6 * K, 0.3 * S.h) + extent));
  const origin = [cpt[0] - lab.w / 2, cpt[1] + S.h / 2];
  prims.push(...placeRuns(lab, origin, [1, 0], [0, -1], 0, c));
  return {
    prims,
    measured,
    nominal,
    iso: null,
    unit: "°",
    handles: [
      { k: "v", p: V },
      { k: "p1", p: a.p1 },
      { k: "p2", p: a.p2 },
      { k: "p3", p: polar(V, r, (sec.s + sec.e) / 2), move: true },
    ],
  };
}

// ------------------------------------------------------------------ roughness (ISO 1302 / ISO 21920-1)
const T60 = Math.tan(Math.PI / 6); // horizontal projection of a leg inclined at 60° to the surface

/** The symbol in local coordinates: tip at (0,0), symbol pointing "up" (negative y). */
function roughLocal(a, S, measure) {
  const h = S.h;
  const H1 = 1.43 * h; // ISO 1302: h = 3.5 → H1 = 5 mm
  const H2 = 3 * h; //            H2 = 10,5 mm
  const lines = [];
  const circles = [];
  const texts = [];
  const top = [H2 * T60, -H2];
  lines.push([0, 0, -H1 * T60, -H1], [0, 0, top[0], top[1]]);
  if (a.kind === "remove") lines.push([-H1 * T60, -H1, H1 * T60, -H1]);
  if (a.kind === "noremove") circles.push({ c: [0, -(2 * H1) / 3], r: H1 / 3 });
  const val = (a.val || "").trim();
  const method = (a.method || "").trim();
  if (val || method) {
    const s = S.F;
    const wv = val ? measure(val, s) : 0;
    const wm = method ? measure(method, s) : 0;
    const x0 = (H2 - 0.4 * h) * T60 + 0.5 * h; // the text starts to the right of the long leg
    const L = Math.max(wv, wm) + (x0 - top[0]) + 0.6 * h;
    lines.push([top[0], top[1], top[0] + Math.max(L, 2 * h), top[1]]);
    if (val) texts.push({ p: [x0, top[1] + 1.4 * h], txt: val, s, w: wv });
    if (method) texts.push({ p: [top[0] + 0.5 * h, top[1] - 0.5 * h], txt: method, s, w: wm });
  }
  return { lines, circles, texts, width: top[0] + 2 * h };
}

function buildRough(a, S, measure) {
  const c = a.layer || "add";
  const loc = roughLocal(a, S, measure);
  const leader = a.pos && len(sub(a.pos, a.target)) > 0.5;
  const prims = [];
  let origin = a.target;
  let rot = leader ? 0 : a.rot || 0;
  if (leader) {
    // leader with the arrow on the surface and a horizontal shoulder carrying the symbol
    const side = a.pos[0] >= a.target[0] ? 1 : -1;
    const span = loc.width + S.h * 1.6;
    const end = [a.pos[0] + side * span, a.pos[1]];
    prims.push(lineP(a.target, a.pos, S, c), lineP(a.pos, end, S, c));
    const d = norm(sub(a.target, a.pos));
    if (d) prims.push(...arrowP(a.target, d, { ...S, arrow: "closed" }, c));
    const left = Math.min(a.pos[0], end[0]);
    origin = [left + S.h * 0.8 + 1.43 * S.h * T60, a.pos[1]];
    rot = 0;
  }
  const th = (rot * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  // rotation on screen, counter-clockwise (y down)
  const tr = (x, y) => [origin[0] + x * cs + y * sn, origin[1] - x * sn + y * cs];
  for (const [x1, y1, x2, y2] of loc.lines) prims.push(lineP(tr(x1, y1), tr(x2, y2), S, c));
  for (const ci of loc.circles) prims.push({ t: "C", p: tr(...ci.c), r: ci.r, w: S.lw, c });
  for (const t of loc.texts) prims.push({ t: "T", p: tr(...t.p), s: t.s, a: rot, txt: t.txt, tw: t.w, c });
  return { prims, handles: [{ k: "target", p: a.target }, { k: "pos", p: a.pos || a.target, move: true }] };
}

// ------------------------------------------------------------------ technical notes
export function noteLines(a) {
  return String(a.text || "").replace(/\r/g, "").split("\n");
}

function buildNote(a, S, measure) {
  const c = a.layer || "add";
  const k = a.size || 1;
  const h = S.h * k;
  const F = S.F * k;
  const pitch = 1.7 * h; // distance between baselines
  const [x0, y0] = a.p;
  const pad = a.frame ? 0.8 * h : 0;
  const prims = [];
  let y = y0 + pad + h;
  let wMax = 0;
  const title = (a.title || "").trim();
  if (title) {
    const w = measure(title, F);
    prims.push({ t: "T", p: [x0 + pad, y], s: F, a: 0, txt: title, tw: w, c });
    wMax = Math.max(wMax, w);
    y += pitch * 1.15;
  }
  const lines = noteLines(a);
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const numW = a.numbered ? measure(`${nonEmpty}. `, F) : 0;
  let n = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim()) {
      let x = x0 + pad;
      if (a.numbered) {
        n += 1;
        const num = `${n}.`;
        prims.push({ t: "T", p: [x, y], s: F, a: 0, txt: num, tw: measure(num, F), c });
        x += numW;
      }
      const w = measure(line, F);
      prims.push({ t: "T", p: [x, y], s: F, a: 0, txt: line, tw: w, c });
      wMax = Math.max(wMax, x - x0 - pad + w);
    }
    y += pitch;
  }
  const H = y - pitch + 0.45 * h + pad - y0;
  if (a.frame) {
    const W = wMax + 2 * pad;
    prims.unshift({ t: "P", p: [x0, y0, x0 + W, y0, x0 + W, y0 + H, x0, y0 + H], close: true, w: S.lw, c });
  }
  return { prims, handles: [{ k: "p", p: a.p, move: true }] };
}

// ------------------------------------------------------------------ revision table
export const REVTAB_COLS = [
  { key: "rev", title: "Rev.", en: "Rev.", minMm: 10 },
  { key: "desc", title: "Modificare", en: "Description", minMm: 40 },
  { key: "date", title: "Data", en: "Date", minMm: 22 },
  { key: "name", title: "Nume", en: "Name", minMm: 14 },
];

// Parts list (ISO 7573): above the title block, header at the bottom, item 1 next to the header.
export const BOM_COLS = [
  { key: "poz", title: "Poz.", en: "Item", minMm: 10 },
  { key: "name", title: "Denumire", en: "Description", minMm: 45, left: true },
  { key: "qty", title: "Buc.", en: "Qty", minMm: 10 },
  { key: "mat", title: "Material", en: "Material", minMm: 28, left: true },
  { key: "obs", title: "Observații", en: "Remarks", minMm: 24, left: true },
];

// table headers are in the drawing language (document setting), not necessarily the UI language
const colTitle = (col, S) => (S.dlang === "en" && col.en ? col.en : col.title);

function buildRevtab(a, S, measure) {
  return buildTable(a, S, measure, REVTAB_COLS.map((c) => (c.key === "desc" ? { ...c, left: true } : c)));
}

function buildBom(a, S, measure) {
  return buildTable(a, S, measure, BOM_COLS);
}

export const HOLE_COLS = [
  { key: "tag", title: "Gaură", en: "Hole", minMm: 12 },
  { key: "x", title: "X", minMm: 16 },
  { key: "y", title: "Y", minMm: 16 },
  { key: "d", title: "Ø", minMm: 14 },
];
const HOLE_EPS = 0.75; // pt: two points closer than this are the same hole

/**
 * Hole table from the ordinate dimensions that share one base: X and Y of every hole, measured
 * from the base (with the values typed over the measured ones), and its diameter, read from the
 * smallest circle centered on it (`arcs`: [cx, cy, r, a0, sweep] of the page drawing).
 * Holes of the same diameter get the same letter (A1, A2…, B1…); without any circle, 1, 2, 3…
 * `prev` (an earlier table) keeps the diameters typed by hand. Returns { pts, rows } or null.
 */
export function holeTable(ords, arcs, S, prev = null) {
  const list = (ords || []).filter((o) => o && Array.isArray(o.base));
  if (!list.length) return null;
  const base = list[0].base;
  const sameBase = list.filter((o) => Math.hypot(o.base[0] - base[0], o.base[1] - base[1]) <= HOLE_EPS);
  const scale = S.scale || 1;
  const near = (p, q) => Math.abs(p[0] - q[0]) <= HOLE_EPS && Math.abs(p[1] - q[1]) <= HOLE_EPS;
  const holes = [];
  for (const o of sameBase) {
    const ax = o.axis === "y" ? 1 : 0;
    const step = Number(o.round) > 0 ? Number(o.round) : 0;
    [o.base, ...(o.pts || [])].forEach((p, idx) => {
      if (!Array.isArray(p)) return;
      let h = holes.find((q) => near(q.p, p));
      if (!h) {
        h = { p, v: [null, null], step };
        holes.push(h);
      }
      const ov = o.ov && o.ov[idx] != null && Number.isFinite(Number(o.ov[idx])) ? Number(o.ov[idx]) : null;
      if (ov != null) h.v[ax] = ov;
      if (step) h.step = step;
    });
  }
  const signed = (h, ax) => {
    const d = ax === 0 ? h.p[0] - base[0] : base[1] - h.p[1];
    const sign = d < 0 ? -1 : 1;
    if (h.v[ax] != null) return sign * Math.abs(h.v[ax]);
    let v = Math.abs(d / K) * scale;
    if (h.step) v = Math.round(v / h.step) * h.step;
    return sign * round(v, 2);
  };
  const circle = (p) => {
    const at = (arcs || []).filter((a) => Math.hypot(a[0] - p[0], a[1] - p[1]) <= Math.max(HOLE_EPS, a[2] * 0.02) && a[2] > 0.1);
    if (!at.length) return null;
    // a counterbore or a thread has several circles: the smallest (nearly) full one is the hole
    const full = at.filter((a) => Math.abs(a[4] ?? Math.PI * 2) >= Math.PI * 0.99);
    const r = Math.min(...(full.length ? full : at).map((a) => a[2]));
    return round((2 * r * scale) / K, 1);
  };
  const prevRows = prev && Array.isArray(prev.pts) ? prev.pts.map((q, i) => ({ q, r: (prev.rows || [])[i] })) : [];
  let items = holes.map((h) => {
    const old = prevRows.find((o) => Array.isArray(o.q) && o.r && near(o.q, h.p));
    const dia = circle(h.p);
    const d = old && String(old.r.d || "").trim() ? String(old.r.d).trim() : dia != null ? fmtNum(dia, S.sep, 2) : "";
    return { p: h.p, x: signed(h, 0), y: signed(h, 1), d, circle: dia != null, base: near(h.p, base) };
  });
  // points without a circle are edges, not holes, as soon as some of the points are holes
  // (on a scan there are no circles: then every point but the base is listed)
  items = items.some((it) => it.circle) ? items.filter((it) => it.circle || (!it.base && it.d)) : items.filter((it) => !it.base);
  if (!items.length) return null;
  items.sort((u, w) => u.x - w.x || u.y - w.y);
  const sizes = [...new Set(items.map((it) => it.d))].filter(Boolean);
  const dnum = (d) => parseFloat(String(d).replace(",", ".").replace(/^[^\d.-]+/, ""));
  sizes.sort((u, w) => (dnum(u) || 0) - (dnum(w) || 0) || u.localeCompare(w));
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const count = {};
  const rows = items.map((it) => {
    let tag;
    if (!sizes.length) tag = String(items.indexOf(it) + 1);
    else {
      const g = it.d ? sizes.indexOf(it.d) : sizes.length;
      const L = letters[g % letters.length] + (g >= letters.length ? String(Math.floor(g / letters.length)) : "");
      count[L] = (count[L] || 0) + 1;
      tag = `${L}${count[L]}`;
    }
    return { tag, x: fmtNum(it.x, S.sep, 3), y: fmtNum(it.y, S.sep, 3), d: it.d };
  });
  return { base: [...base], pts: items.map((it) => [...it.p]), rows };
}

/** Origin of the typed coordinates (UCS): an X / Y axes icon, on screen only, never exported. */
function buildUcs(a, S, measure) {
  const [x, y] = a.p;
  const L = 8 * K;
  const r = 0.8 * K;
  const c = "edgreen";
  const ln = (p, q) => ({ t: "L", p: [...p, ...q], w: 1.2, c, ed: true });
  const prims = [
    ln([x, y], [x + L, y]),
    ln([x + L, y], [x + L - 1.6 * K, y - 0.8 * K]),
    ln([x + L, y], [x + L - 1.6 * K, y + 0.8 * K]),
    ln([x, y], [x, y - L]),
    ln([x, y - L], [x - 0.8 * K, y - L + 1.6 * K]),
    ln([x, y - L], [x + 0.8 * K, y - L + 1.6 * K]),
    { t: "P", p: [x - r, y - r, x + r, y - r, x + r, y + r, x - r, y + r], close: true, w: 1.2, c, ed: true },
  ];
  const h = 2.5 * K;
  const F = h / CAP;
  for (const [txt, p] of [["X", [x + L + 0.8 * K, y + h / 2]], ["Y", [x - h * 0.35, y - L - 0.8 * K]]]) {
    prims.push({ t: "T", p, s: F, a: 0, txt, tw: measure(txt, F), c, ed: true });
  }
  return { prims, handles: [{ k: "p", p: a.p }] };
}

function buildHoles(a, S, measure) {
  const b = buildTable(a, S, measure, HOLE_COLS);
  if (a.tags === false) return b;
  // the hole letters next to the holes, up and to the right, clear of the circle
  const c = a.layer || "add";
  (a.pts || []).forEach((q, i) => {
    const r = (a.rows || [])[i];
    if (!Array.isArray(q) || !r || !String(r.tag || "").trim()) return;
    const dmm = parseFloat(String(r.d || "").replace(",", ".").replace(/^[^\d.]+/, ""));
    const rad = Number.isFinite(dmm) ? ((dmm / 2) * K) / (S.scale || 1) : 0;
    const off = rad * 0.75 + S.h * 0.45;
    const txt = String(r.tag).trim();
    b.prims.push({ t: "T", p: [q[0] + off, q[1] - off], s: S.F, a: 0, txt, tw: measure(txt, S.F), c });
  });
  return b;
}

function buildTable(a, S, measure, COLS) {
  const c = a.layer || "add";
  const h = S.h;
  const F = S.F;
  const rowH = 2 * h; // as for the GD&T frame: row height = 2 × text height
  const pad = 0.6 * h;
  const rows = a.rows || [];
  const widths = COLS.map((col) => {
    let w = col.minMm * K * (a.scale || 1);
    w = Math.max(w, measure(colTitle(col, S), F) + 2 * pad);
    for (const r of rows) w = Math.max(w, measure(String(r[col.key] || ""), F) + 2 * pad);
    return w;
  });
  const W = widths.reduce((s, w) => s + w, 0);
  const nRows = rows.length + 1;
  const Htot = nRows * rowH;
  // the anchor is the bottom-right corner: the table stays right-aligned with the title block, however wide it gets
  const yb = a.p[1];
  const x0 = a.p[0] - W;
  const yt = yb - Htot;
  const prims = [{ t: "P", p: [x0, yt, x0 + W, yt, x0 + W, yb, x0, yb], close: true, w: S.lw * 1.4, c }];
  // visual order of the rows, top to bottom
  const order = a.headerBottom !== false ? [...rows].reverse().map((r) => ({ r })).concat([{ header: true }]) : [{ header: true }].concat(rows.map((r) => ({ r })));
  order.forEach((item, i) => {
    const top = yt + i * rowH;
    if (i > 0) prims.push(lineP([x0, top], [x0 + W, top], { ...S, lw: item.header || order[i - 1].header ? S.lw * 1.4 : S.lw }, c));
    let x = x0;
    COLS.forEach((col, j) => {
      const txt = item.header ? colTitle(col, S) : String(item.r[col.key] || "");
      if (txt) {
        const tw = measure(txt, F);
        const tx = col.left && !item.header ? x + pad : x + (widths[j] - tw) / 2;
        prims.push({ t: "T", p: [tx, top + rowH / 2 + h / 2], s: F, a: 0, txt, tw, c });
      }
      x += widths[j];
    });
  });
  let x = x0;
  for (let j = 0; j < widths.length - 1; j++) {
    x += widths[j];
    prims.push(lineP([x, yt], [x, yb], S, c));
  }
  return {
    prims,
    handles: [{ k: "p", p: a.p, move: true }],
    size: [W, Htot],
  };
}

function buildLead(a, S, measure) {
  const c = a.layer || "add";
  const [P0, P1] = a.pts;
  // multi-line text: the last line sits on the shoulder, the others above it
  const lines = noteLines(a).map((l) => l.replace(/\s+$/, ""));
  const widths = lines.map((l) => measure(l, S.F));
  const w = Math.max(0, ...widths);
  const side = P1[0] >= P0[0] ? 1 : -1;
  const pad = S.h * 0.3;
  const pitch = 1.7 * S.h;
  const P2 = [P1[0] + side * (w + 2 * pad), P1[1]];
  const prims = [lineP(P0, P1, S, c), lineP(P1, P2, S, c)];
  const d = norm(sub(P0, P1)) || [-1, 0];
  if (a.arrow === "dot") prims.push({ t: "C", p: P0, r: S.aw * 0.18, fill: true, nostroke: true, w: S.lw, c });
  else if (a.arrow !== "none") prims.push(...arrowP(P0, d, { ...S, arrow: "closed" }, c));
  const x0 = Math.min(P1[0], P2[0]) + pad;
  const yLast = P1[1] - S.h * 0.35;
  lines.forEach((txt, i) => {
    if (!txt) return;
    const y = yLast - (lines.length - 1 - i) * pitch;
    prims.push({ t: "T", p: [x0, y], s: S.F, a: 0, txt, tw: widths[i], c });
  });
  return { prims, handles: [{ k: "pts.0", p: P0 }, { k: "pts.1", p: P1 }] };
}

function buildText(a, S, measure) {
  const c = a.layer || "add";
  const s = S.F * (a.size || 1);
  const h = S.h * (a.size || 1);
  const ang = a.angle || 0;
  const th = (ang * Math.PI) / 180;
  const down = [Math.sin(th), Math.cos(th)]; // "next line" direction on screen
  const prims = [];
  noteLines(a).forEach((raw, i) => {
    const txt = raw.replace(/\s+$/, "");
    if (!txt) return;
    const p = [a.p[0] + down[0] * i * 1.7 * h, a.p[1] + down[1] * i * 1.7 * h];
    prims.push({ t: "T", p, s, a: ang, txt, tw: measure(txt, s), c });
  });
  return { prims, handles: [{ k: "p", p: a.p }] };
}

export function gdtValueText(a, S) {
  let v = (a.dia ? "Ø" : "") + (a.val || "");
  for (const m of a.mods || []) {
    const mod = MODIFIERS.find((x) => x.id === m);
    if (mod) v += " " + mod.glyph;
  }
  return v;
}

function buildGdt(a, S, measure) {
  const c = a.layer || "add";
  const h = S.h;
  const Hf = 2 * h;
  const sym = GDT_BY_ID[a.sym] || GDT_BY_ID.pos;
  const cells = [{ w: Hf, sym: true }];
  const vtxt = gdtValueText(a, S);
  cells.push({ w: Math.max(Hf, measure(vtxt, S.F) + h), txt: vtxt });
  if (sym.datum !== "none") {
    for (const dname of a.datums || []) {
      if (dname && dname.trim()) {
        const tt = dname.trim();
        cells.push({ w: Math.max(Hf, measure(tt, S.F) + h), txt: tt });
      }
    }
  }
  const W = cells.reduce((s, q) => s + q.w, 0);
  // the placed point is the frame end nearest the feature: left end, right end or the middle
  const anc = a.anchor || "l";
  const x0 = anc === "r" ? a.pos[0] - W : anc === "c" ? a.pos[0] - W / 2 : a.pos[0];
  const y0 = a.pos[1] - Hf / 2;
  const prims = [{ t: "P", p: [x0, y0, x0 + W, y0, x0 + W, y0 + Hf, x0, y0 + Hf], close: true, w: S.lw, c }];
  let x = x0;
  cells.forEach((cell, i) => {
    if (i > 0) prims.push(lineP([x, y0], [x, y0 + Hf], S, c));
    if (cell.sym) prims.push(...symbolPrims(sym.id, x + Hf * 0.2, y0 + Hf * 0.2, Hf * 0.6, S.lw, c));
    else {
      const tw = measure(cell.txt, S.F);
      prims.push({ t: "T", p: [x + (cell.w - tw) / 2, y0 + Hf / 2 + h / 2], s: S.F, a: 0, txt: cell.txt, tw, c });
    }
    x += cell.w;
  });
  // leader line towards the feature
  const T = a.target;
  let elbowH = null;
  if (T) {
    let pts;
    const x1 = x0 + W;
    const E = a.elbow;
    if (E) {
      // free elbow: the line leaves from the frame end closest to the elbow, then goes to the feature
      let start;
      if (E[0] < x0) start = [x0, a.pos[1]];
      else if (E[0] > x1) start = [x1, a.pos[1]];
      else start = [Math.min(Math.max(E[0], x0 + h * 0.5), x1 - h * 0.5), E[1] < a.pos[1] ? y0 : y0 + Hf];
      pts = [start, E, T];
    } else if (T[0] < x0 - h) pts = [[x0, a.pos[1]], [T[0], a.pos[1]], T];
    else if (T[0] > x1 + h) pts = [[x1, a.pos[1]], [T[0], a.pos[1]], T];
    else {
      const sx = Math.min(Math.max(T[0], x0 + h * 0.5), x1 - h * 0.5);
      pts = [[sx, T[1] < y0 ? y0 : y0 + Hf], [sx, T[1]]];
      if (Math.abs(sx - T[0]) > 0.01) pts.push(T);
    }
    elbowH = E || (pts.length === 3 ? pts[1] : mul(add(pts[0], pts[pts.length - 1]), 0.5));
    // degenerate segments removed
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (len(sub(pts[i], clean[clean.length - 1])) > 0.3) clean.push(pts[i]);
    if (clean.length >= 2) {
      prims.push({ t: "P", p: clean.flat(), w: S.lw, c });
      const d = norm(sub(clean[clean.length - 1], clean[clean.length - 2]));
      if (d) prims.push(...arrowP(clean[clean.length - 1], d, { ...S, arrow: "closed" }, c));
    }
  }
  const handles = [{ k: "target", p: T }, { k: "pos", p: a.pos, move: true }];
  if (elbowH) handles.push({ k: "elbow", p: elbowH });
  // snap on the frame: corners, cell borders and edges (a datum triangle can sit on the frame)
  const x1 = x0 + W;
  const y1 = y0 + Hf;
  const pts = [[x0, y0, "e"], [x1, y0, "e"], [x1, y1, "e"], [x0, y1, "e"], [(x0 + x1) / 2, y0, "m"], [(x0 + x1) / 2, y1, "m"], [x0, a.pos[1], "m"], [x1, a.pos[1], "m"]];
  let cx = x0;
  for (const cell of cells.slice(0, -1)) {
    cx += cell.w;
    pts.push([cx, y0, "e"], [cx, y1, "e"]);
  }
  if (T) pts.push([T[0], T[1], "e"]);
  const segs = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
  return { prims, handles, snap: { pts, segs }, frame: [x0, y0, x1, y1] };
}

/** Is point p on the border of box b (within tol)? */
export function onBoxEdge(p, b, tol = 0.6) {
  if (!p || !b) return false;
  const [x, y] = p;
  const inX = x >= b[0] - tol && x <= b[2] + tol;
  const inY = y >= b[1] - tol && y <= b[3] + tol;
  return (inX && (Math.abs(y - b[1]) <= tol || Math.abs(y - b[3]) <= tol)) || (inY && (Math.abs(x - b[0]) <= tol || Math.abs(x - b[2]) <= tol));
}

/** Which end of a GD&T frame sits on the placed point: the one towards the feature. */
export function gdtAnchor(target, pos) {
  if (!target || !pos) return "l";
  const dx = pos[0] - target[0];
  const dy = pos[1] - target[1];
  if (Math.abs(dy) > Math.abs(dx) * 1.5) return "c";
  return dx >= 0 ? "l" : "r";
}

function buildDatum(a, S, measure) {
  const c = a.layer || "add";
  const h = S.h;
  const Hf = 2 * h;
  const d = norm(sub(a.pos, a.target)) || [0, 1];
  const n = [-d[1], d[0]];
  const th = h * 0.9;
  const hb = th * 0.65;
  const apex = add(a.target, mul(d, th));
  const b1 = add(a.target, mul(n, hb));
  const b2 = add(a.target, mul(n, -hb));
  const prims = [{ t: "P", p: [b1[0], b1[1], b2[0], b2[1], apex[0], apex[1]], close: true, fill: true, w: S.lw, c }];
  // box edge in the direction of the triangle
  const v = sub(apex, a.pos);
  const half = Hf / 2;
  const k = Math.min(Math.abs(v[0]) > 1e-9 ? half / Math.abs(v[0]) : Infinity, Math.abs(v[1]) > 1e-9 ? half / Math.abs(v[1]) : Infinity);
  if (k < 1) prims.push(lineP(apex, add(a.pos, mul(v, k)), S, c));
  const [px, py] = a.pos;
  prims.push({ t: "P", p: [px - half, py - half, px + half, py - half, px + half, py + half, px - half, py + half], close: true, w: S.lw, c });
  const txt = a.letter || "A";
  const tw = measure(txt, S.F);
  prims.push({ t: "T", p: [px - tw / 2, py + h / 2], s: S.F, a: 0, txt, tw, c });
  return { prims, handles: [{ k: "target", p: a.target }, { k: "pos", p: a.pos, move: true }] };
}

function buildStrike(a, S, measure) {
  const c = a.layer || "rev";
  const [x0, y0, x1, y1] = normRect(a.r);
  const vertical = y1 - y0 > (x1 - x0) * 1.3;
  const prims = [];
  const ext = 0.5 * K;
  const h = S.h;
  const txt = a.newText || "";
  const tw = txt ? measure(txt, S.F) : 0;
  const tri = h * 1.9;
  const triPrims = (bx, by, ang) => {
    // equilateral triangle with the revision number, in the text's local coordinates
    const tu = [Math.cos((ang * Math.PI) / 180), -Math.sin((ang * Math.PI) / 180)];
    const up = perpL(tu);
    const p0 = [bx, by];
    const p1 = add(p0, mul(tu, tri));
    const p2 = add(add(p0, mul(tu, tri / 2)), mul(up, tri * 0.866));
    const out = [{ t: "P", p: [...p0, ...p1, ...p2], close: true, w: S.lw, c }];
    const rn = a.rev || "";
    if (rn) {
      const s = S.F * 0.62;
      const w = measure(rn, s);
      const o = add(add(p0, mul(tu, tri / 2 - w / 2)), mul(up, tri * 0.18));
      out.push({ t: "T", p: o, s, a: ang, txt: rn, tw: w, c });
    }
    return out;
  };
  // the struck line
  if (!vertical) {
    const ym = (y0 + y1) / 2;
    prims.push(lineP([x0 - ext, ym], [x1 + ext, ym], { ...S, lw: S.lw * 1.4 }, c));
  } else {
    const xm = (x0 + x1) / 2;
    prims.push(lineP([xm, y1 + ext], [xm, y0 - ext], { ...S, lw: S.lw * 1.4 }, c));
  }
  // the new value and the revision triangle: where the user put them (lp), or on the chosen side
  const ang = vertical ? 90 : 0;
  const { origin, tu } = strikeLabelOrigin(a, S, tw);
  let o = origin;
  if (txt) {
    prims.push({ t: "T", p: o, s: S.F, a: ang, txt, tw, c });
    o = add(o, mul(tu, tw + 1 * K));
  }
  prims.push(...triPrims(o[0], o[1], ang));
  const handles = [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }, { k: "lp", p: origin }];
  return { prims, handles };
}

/** Width and height of a struck dimension's label (new value + triangle) along its reading direction. */
export function strikeLabelSize(S, tw) {
  const tri = S.h * 1.9;
  return { w: (tw ? tw + 1 * K : 0) + tri, h: Math.max(S.h, tri * 0.866) };
}

/** Baseline origin of the label of a struck dimension: a.lp if dragged there, otherwise on side a.side
 * (r after the old value, t above it, l before it, b below it, in its reading direction). */
export function strikeLabelOrigin(a, S, tw, side = a.side || "r") {
  const [x0, y0, x1, y1] = normRect(a.r);
  const vertical = y1 - y0 > (x1 - x0) * 1.3;
  const tu = vertical ? [0, -1] : [1, 0];
  const up = perpL(tu);
  if (a.lp) return { origin: [...a.lp], tu, up };
  const g = 1.5 * K;
  const { w, h } = strikeLabelSize(S, tw);
  const us = [[x0, y0], [x1, y1]].map((q) => dot(q, tu));
  const vs = [[x0, y0], [x1, y1]].map((q) => dot(q, up));
  const [uMin, uMax] = [Math.min(...us), Math.max(...us)];
  const [vMin, vMax] = [Math.min(...vs), Math.max(...vs)];
  const uc = (uMin + uMax) / 2;
  const [u, v] = {
    r: [uMax + g, vMin],
    l: [uMin - g - w, vMin],
    t: [uc - w / 2, vMax + g],
    b: [uc - w / 2, vMin - g - h],
  }[side] || [uMax + g, vMin];
  return { origin: add(mul(tu, u), mul(up, v)), tu, up };
}

/** Page box of the label of a struck dimension placed on a side (for choosing a free side). */
export function strikeLabelBox(a, S, tw, side) {
  const { origin, tu, up } = strikeLabelOrigin({ ...a, lp: null }, S, tw, side);
  const { w, h } = strikeLabelSize(S, tw);
  const q = [origin, add(origin, mul(tu, w)), add(add(origin, mul(tu, w)), mul(up, h)), add(origin, mul(up, h))];
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function normRect(r) {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function rectOutline(r, c) {
  const [x0, y0, x1, y1] = normRect(r);
  return { t: "P", p: [x0, y0, x1, y0, x1, y1, x0, y1], close: true, w: 0.6, c, ed: true, dash: true };
}

/** Color of a cover: white by default or the chosen color (#rrggbb). */
export function coverColor(a) {
  return a.color && /^#[0-9a-f]{6}$/i.test(a.color) && a.color.toLowerCase() !== "#ffffff" ? a.color.toLowerCase() : "white";
}

function buildWhite(a) {
  const r = normRect(a.r);
  return {
    prims: [{ t: "R", p: r, c: coverColor(a), cover: true }, rectOutline(r, "edgray")],
    handles: [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }],
  };
}

function buildInk(a) {
  const r = normRect(a.r);
  const prims = [rectOutline(r, "edgray")];
  for (const o of a.objs || []) {
    for (const poly of o.poly || []) if (poly.length >= 2) prims.push({ t: "P", p: poly.flat(), w: 1.2, c: "edgreen", ed: true });
    if (!o.poly && o.bbox) prims.push(rectOutline(o.bbox, "edgreen"));
  }
  return { prims, handles: [] };
}

function buildRedact(a) {
  // the editor page is already rendered with removals applied: only the zone outline remains here
  const r = normRect(a.r);
  const prims = [rectOutline(r, a.mode === "cover" ? "edgray" : "edred")];
  // old zones (without "cover") were always covered with white
  const cover = (a.mode === "zone" && a.cover !== false) || a.mode === "cover";
  if (cover) prims.unshift({ t: "R", p: r, c: a.mode === "cover" ? coverColor(a) : "white", cover: true });
  return { prims, handles: [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }] };
}

// ------------------------------------------------------------------ ordinate dimensions
/**
 * Ordinate dimensions (AutoCAD DIMORDINATE, ISO 129-1 coordinate dimensioning): distances from a
 * base point, along one axis. axis "x": vertical extension lines ending at the row y = a.row, with
 * the values written along them (read from below); axis "y": horizontal lines ending at x = a.row.
 * Values are absolute, in real mm. Points with the same value keep only the one closest to the row.
 * Values too close to each other spread apart and their extension lines get a jog.
 */
export function ordinateItems(a, S) {
  const ax = a.axis === "y" ? 1 : 0;
  const all = [a.base, ...(a.pts || [])];
  const step = Number(a.round) > 0 ? Number(a.round) : 0;
  const byVal = new Map();
  all.forEach((p, idx) => {
    if (!Array.isArray(p)) return;
    const d = ax === 0 ? p[0] - a.base[0] : a.base[1] - p[1];
    let auto = Math.abs(d / K) * (S.scale || 1);
    // measured on a PDF or a scan the values are never round: optional rounding for all of them
    if (step) auto = Math.round(auto / step) * step;
    auto = round(auto, 2);
    const ov = a.ov && a.ov[idx] != null && Number.isFinite(Number(a.ov[idx])) ? Number(a.ov[idx]) : null;
    const v = ov ?? auto;
    const key = v.toFixed(3);
    const prev = byVal.get(key);
    if (!prev || Math.abs(a.row - p[1 - ax]) < Math.abs(a.row - prev.p[1 - ax])) byVal.set(key, { p, v, auto, ov, idx });
  });
  return [...byVal.values()].sort((u, w) => u.p[ax] - w.p[ax]);
}

/** Spreads 1-D positions so neighbors are at least `gap` apart, each cluster centered on its wishes. */
export function spreadSlots(want, gap) {
  const cl = want.map((w, i) => ({ lo: i, hi: i, sum: w, n: 1 }));
  const pos = (c) => c.sum / c.n - ((c.n - 1) * gap) / 2;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i + 1 < cl.length; i++) {
      const A = cl[i];
      const B = cl[i + 1];
      if (pos(A) + A.n * gap > pos(B) + 1e-9) {
        cl.splice(i, 2, { lo: A.lo, hi: B.hi, sum: A.sum + B.sum, n: A.n + B.n });
        merged = true;
        break;
      }
    }
  }
  const out = [];
  for (const c of cl) for (let j = 0; j < c.n; j++) out.push(pos(c) + j * gap);
  return out;
}

function buildOrd(a, S, measure) {
  const c = a.layer || "add";
  const ax = a.axis === "y" ? 1 : 0; // coordinate along which the values are measured
  const items = ordinateItems(a, S);
  const prims = [];
  const h = S.h;
  const slots = spreadSlots(items.map((it) => it.p[ax]), h * 1.7);
  const J = h * 1.6; // length of the jog zone before the row
  const tgap = h * 0.4;
  for (let i = 0; i < items.length; i++) {
    const { p, v } = items[i];
    const s = slots[i];
    const across = p[1 - ax];
    const d = a.row >= across ? 1 : -1; // direction from the point towards the row
    const P = (u, w) => (ax === 0 ? [u, w] : [w, u]); // (along, across) → page point
    const start = across + d * Math.min(S.gap, Math.abs(a.row - across) / 2);
    if (Math.abs(s - p[ax]) < 0.01) {
      prims.push(lineP(P(p[ax], start), P(p[ax], a.row), S, c));
    } else {
      const k1 = a.row - d * J;
      const k2 = a.row - d * J * 0.35;
      const pts = [P(p[ax], start)];
      if ((k1 - start) * d > 0) pts.push(P(p[ax], k1));
      pts.push(P(s, k2), P(s, a.row));
      for (let j = 0; j + 1 < pts.length; j++) prims.push(lineP(pts[j], pts[j + 1], S, c));
    }
    const txt = fmtNum(v, S.sep, 3);
    const w = measure(txt, S.F);
    let origin;
    let ang;
    if (ax === 0) {
      // vertical text, read from below (ISO 129 method 1), centered on the line
      ang = 90;
      origin = d > 0 ? [s + h / 2, a.row + tgap + w] : [s + h / 2, a.row - tgap];
    } else {
      ang = 0;
      origin = d > 0 ? [a.row + tgap, s + h / 2] : [a.row - tgap - w, s + h / 2];
    }
    prims.push({ t: "T", p: origin, s: S.F, a: ang, txt, tw: w, c });
  }
  const along = items.map((it) => it.p[ax]);
  const mid = along.length ? (Math.min(...along) + Math.max(...along)) / 2 : a.base[ax];
  const rowH = ax === 0 ? [mid, a.row] : [a.row, mid];
  return {
    prims,
    values: items.map((it) => it.v),
    items: items.map(({ v, auto, ov, idx }) => ({ v, auto, ov, idx })),
    handles: [{ k: "base", p: a.base }, ...(a.pts || []).map((q, i) => ({ k: `pts.${i}`, p: q })), { k: "row", p: rowH }],
  };
}

function buildImage(a) {
  const r = normRect(a.r);
  return {
    prims: [{ t: "I", p: r, img: a.img, rot: a.rot || 0, op: a.op ?? 1 }],
    handles: [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }],
  };
}

/** Rectangle of an image placed from corner `p` towards `q` with the image's proportions (iw × ih,
 * already turned by rot): the longer of the two drag directions decides the size. */
export function imageRect(p, q, iw, ih, free = false) {
  if (free || !(iw > 0 && ih > 0)) return [p[0], p[1], q[0], q[1]];
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const k = Math.max(Math.abs(dx) / iw, Math.abs(dy) / ih);
  return [p[0], p[1], p[0] + Math.sign(dx || 1) * iw * k, p[1] + Math.sign(dy || 1) * ih * k];
}

// the title block needs its page's size and the number of pages (fields Format and Foaia): S.pagesWH
const buildTb = (a, S, measure) => buildTblock(a, S, measure, { page: S.pagesWH && S.pagesWH[a.page || 0], total: S.pagesWH ? S.pagesWH.length : 0 });

/** Revision triangle with its number, base from (bx, by) along the reading direction (ang, °). */
function revTriangle(bx, by, ang, size, S, measure, rev, c) {
  const tu = [Math.cos((ang * Math.PI) / 180), -Math.sin((ang * Math.PI) / 180)];
  const up = perpL(tu);
  const p0 = [bx, by];
  const p1 = add(p0, mul(tu, size));
  const p2 = add(add(p0, mul(tu, size / 2)), mul(up, size * 0.866));
  const out = [{ t: "P", p: [...p0, ...p1, ...p2], close: true, w: S.lw, c }];
  if (rev) {
    const s = (S.F * 0.62 * size) / (S.h * 1.9);
    const w = measure(rev, s);
    const o = add(add(p0, mul(tu, size / 2 - w / 2)), mul(up, size * 0.18));
    out.push({ t: "T", p: o, s, a: ang, txt: rev, tw: w, c });
  }
  return out;
}

/** Revision cloud: arcs bulging outwards along the rectangle, optional revision triangle at the
 * top-right corner. a.arc = chord of one arc in mm (paper). */
function buildCloud(a, S, measure) {
  const c = a.layer || "rev";
  const L = Math.max(1, (a.arc || 6) * K * (a.scale || 1));
  // a rectangle, or any closed outline (a.pts), turned clockwise on screen so the arcs bulge outwards
  let corners;
  if (Array.isArray(a.pts) && a.pts.length >= 3) {
    corners = a.pts.map((q) => [...q]);
    let area = 0;
    corners.forEach((q, i) => {
      const r = corners[(i + 1) % corners.length];
      area += q[0] * r[1] - r[0] * q[1];
    });
    if (area < 0) corners.reverse();
  } else if (Array.isArray(a.r)) {
    const [x0, y0, x1, y1] = normRect(a.r);
    corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  } else return { prims: [], handles: [] };
  const nc = corners.length;
  const pts = [];
  for (let i = 0; i < nc; i++) {
    const A = corners[i];
    const B = corners[(i + 1) % nc];
    const d = sub(B, A);
    const len = Math.hypot(d[0], d[1]);
    if (len < 1e-6) continue;
    const u = [d[0] / len, d[1] / len];
    const nOut = [u[1], -u[0]]; // clockwise on screen: outwards is to the left of the direction
    const n = Math.max(1, Math.round(len / L));
    const chord = len / n;
    const r = chord / 2;
    for (let j = 0; j < n; j++) {
      const mid = add(A, mul(u, chord * (j + 0.5)));
      for (let k = j === 0 && i === 0 ? 0 : 1; k <= 8; k++) {
        const t = (k / 8) * Math.PI;
        pts.push(...add(add(mid, mul(u, -Math.cos(t) * r)), mul(nOut, Math.sin(t) * r)));
      }
    }
  }
  const prims = [{ t: "P", p: pts, close: true, w: S.lw * 1.4, c }];
  if (a.tri) {
    // at the top-right corner of the outline
    const tr = corners.reduce((b, q) => (q[0] - q[1] > b[0] - b[1] ? q : b), corners[0]);
    const size = S.h * 1.9 * (a.scale || 1);
    prims.push(...revTriangle(tr[0] + L * 0.6, tr[1] - L * 0.6, 0, size, S, measure, String(a.rev || ""), c));
  }
  const handles = Array.isArray(a.pts) && a.pts.length >= 3
    ? a.pts.map((q, i) => ({ k: `pts.${i}`, p: q }))
    : [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }];
  return { prims, handles };
}

/** Highlighter: a wide, transparent stroke that leaves what is under it readable (multiply). */
export const MARK_COLORS = ["hlGreen", "hlYellow", "hlPink"];
function buildMark(a) {
  const pts = (a.pts || []).flat();
  if (pts.length < 4) return { prims: [], handles: [] };
  const color = MARK_COLORS.includes(a.color) ? a.color : "hlGreen";
  return { prims: [{ t: "P", p: pts, w: (a.w || 6) * K, c: color, op: 0.38, cap: "round", blend: "multiply" }], handles: [] };
}

/** Review comment: a note pin on screen only (layer Review); exported as a PDF note, not drawn. */
function buildComment(a, S, measure) {
  const [x, y] = a.p;
  const k = K * 0.9;
  const w = 5.5 * k;
  const h = 4.2 * k;
  const fill = a.done ? "cmtDone" : "cmt";
  const bubble = [x, y - h - 1.6 * k, x + w, y - h - 1.6 * k, x + w, y - 1.6 * k, x + 2.2 * k, y - 1.6 * k, x, y, x + 0.9 * k, y - 1.6 * k, x, y - 1.6 * k];
  const prims = [
    { t: "P", p: bubble, close: true, fill: true, nostroke: true, c: fill, ed: true },
    { t: "P", p: bubble, close: true, w: 0.8, c: "cmtInk", ed: true },
  ];
  const first = String(a.text || "").split("\n")[0].trim();
  if (first) {
    const s = 2.2 * K / CAP;
    const txt = first.length > 40 ? `${first.slice(0, 39)}…` : first;
    prims.push({ t: "T", p: [x + w + 1.2 * k, y - 2.4 * k], s, a: 0, txt, tw: measure(txt, s), c: "cmtInk", ed: true });
  }
  return { prims, handles: [{ k: "p", p: a.p, move: true }] };
}

// ------------------------------------------------------------------ stamps, QR, watermark (V12-5)
export const STAMP_COLORS = ["stRed", "stGreen", "stBlue"];

/** Rubber stamp: a word in a double frame, with the date and name under it; turned by a.angle (°). */
function buildStamp(a, S, measure) {
  const c = STAMP_COLORS.includes(a.color) ? a.color : "stRed";
  const [cx, cy] = a.p;
  const big = S.F * 1.45;
  const small = S.F * 0.7;
  const txt = String(a.text || "").toUpperCase() || "—";
  const sub = a.sub === false ? "" : [a.date, a.name].filter(Boolean).join(" · ");
  const tw = measure(txt, big);
  const sw = sub ? measure(sub, small) : 0;
  const pad = S.h * 0.8;
  const hb = S.h * 1.45;
  const hs = sub ? S.h * 0.7 : 0;
  const gap = sub ? S.h * 0.55 : 0;
  const W = Math.max(tw, sw) + 2 * pad + S.h * 0.6;
  const H = hb + gap + hs + 2 * pad;
  const ang = Number(a.angle) || 0;
  const th = (-ang * Math.PI) / 180;
  const R = (x, y) => [cx + x * Math.cos(th) - y * Math.sin(th), cy + x * Math.sin(th) + y * Math.cos(th)];
  const rect = (dx) => {
    const q = [R(-W / 2 + dx, -H / 2 + dx), R(W / 2 - dx, -H / 2 + dx), R(W / 2 - dx, H / 2 - dx), R(-W / 2 + dx, H / 2 - dx)];
    return q.flat();
  };
  const prims = [
    { t: "P", p: rect(0), close: true, w: S.lw * 2.4, c },
    { t: "P", p: rect(S.h * 0.35), close: true, w: S.lw, c },
  ];
  const y0 = -H / 2 + pad + hb;
  prims.push({ t: "T", p: R(-tw / 2, y0), s: big, a: ang, txt, tw, c });
  if (sub) prims.push({ t: "T", p: R(-sw / 2, y0 + gap + hs), s: small, a: ang, txt: sub, tw: sw, c });
  return { prims, handles: [{ k: "p", p: a.p, move: true }] };
}

/** Text a QR code holds: its template with the fields filled, empty lines left out. */
export function qrText(a, S) {
  const vals = { ...(a.vals || {}), rev: S.revNo || "1", data: S.revDate || "" };
  // drawing text: in the document's drawing language
  const tpl = a.content || (S.dlang === "en" ? "Drawing no.: {nr_desen}\nRev: {rev}\nDate: {data}\n{extra}" : "Nr. desen: {nr_desen}\nRev: {rev}\nData: {data}\n{extra}");
  return tpl
    .replace(/\{([a-z0-9_]{1,24})\}/gi, (_m, k) => String(vals[k.toLowerCase()] ?? ""))
    .split("\n")
    .filter((l) => l.trim() && !/:\s*$/.test(l.trim()))
    .join("\n");
}

/** QR code, vector squares (one rectangle per run of dark modules), top-left corner at a.p. */
function buildQr(a, S) {
  const c = a.layer || "add";
  const text = qrText(a, S) || " ";
  let m;
  try {
    m = qrMatrix(text);
  } catch (_) {
    m = null;
  }
  const size = (a.size || 20) * K * (a.scale || 1);
  const [x0, y0] = a.p;
  if (!m) {
    return { prims: [{ t: "P", p: [x0, y0, x0 + size, y0, x0 + size, y0 + size, x0, y0 + size], close: true, w: S.lw, c }], handles: [{ k: "p", p: a.p, move: true }], qr: { tooLong: true } };
  }
  const n = m.length;
  const u = size / n;
  const prims = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!m[y][x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && m[y][x]) x++;
      prims.push({ t: "R", p: [x0 + start * u, y0 + y * u, x0 + x * u, y0 + (y + 1) * u], c });
    }
  }
  return { prims, handles: [{ k: "p", p: a.p, move: true }], qr: { modules: n, moduleMm: (u / K) } };
}

/** Watermark: a large, faint diagonal text across its page. */
function buildWatermark(a, S, measure) {
  const wh = (S.pagesWH && S.pagesWH[a.page || 0]) || [842, 595];
  const [W, H] = wh;
  const txt = String(a.text || "").toUpperCase() || "COPIE";
  const ang = (Math.atan2(H, W) * 180) / Math.PI;
  const diag = Math.hypot(W, H);
  // width per unit of font size, measured at a normal size (the measure rounds at tiny sizes)
  const per = Math.max(0.01, measure(txt, 100) / 100);
  const s = Math.min((0.62 * diag) / per, H * 0.3);
  const tw = measure(txt, s);
  const th = (ang * Math.PI) / 180;
  const tu = [Math.cos(th), -Math.sin(th)];
  const up = [-Math.sin(th), -Math.cos(th)];
  const cx = W / 2;
  const cy = H / 2;
  const p = [cx - (tu[0] * tw) / 2 - up[0] * s * CAP * 0.5, cy - (tu[1] * tw) / 2 - up[1] * s * CAP * 0.5];
  return { prims: [{ t: "T", p, s, a: ang, txt, tw, c: "wm", op: a.op ?? 0.14 }], handles: [] };
}

const BUILDERS = { stamp: buildStamp, qr: buildQr, watermark: buildWatermark, cloud: buildCloud, mark: buildMark, comment: buildComment, tblock: buildTb, image: buildImage, ord: buildOrd, dim: buildDim, rad: buildRad, ang: buildAng, rough: buildRough, note: buildNote, revtab: buildRevtab, lead: buildLead, text: buildText, gdt: buildGdt, datum: buildDatum, strike: buildStrike, white: buildWhite, redact: buildRedact, ink: buildInk, shape: buildShape, section: buildSection, detail: buildDetail, balloon: buildBalloon, bom: buildBom, holes: buildHoles, ucs: buildUcs };

// characters without a glyph in osifont → existing equivalents (same on screen and in the PDF)
const GLYPH_SUBST = { "…": "...", "„": '"', "”": '"', "“": '"', "«": '"', "»": '"', "‚": ",", "‘": "'", "\u00a0": " ", "−": "-" };
const GLYPH_RE = new RegExp(`[${Object.keys(GLYPH_SUBST).join("")}]`, "g");
export function fontSafe(txt) {
  return String(txt ?? "").replace(GLYPH_RE, (ch) => GLYPH_SUBST[ch]);
}

export const SCALABLE = new Set(["stamp", "ord", "dim", "rad", "ang", "rough", "lead", "text", "note", "gdt", "datum", "strike", "revtab", "section", "detail", "balloon", "bom", "holes"]);
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 5;

/** Settings for an enlarged/shrunk annotation: text, arrows and distances; line widths stay. */
export function scaledS(S, k) {
  if (!k || Math.abs(k - 1) < 1e-9) return S;
  return { ...S, h: S.h * k, F: S.F * k, aw: S.aw * k, gap: S.gap * k, over: S.over * k };
}

/** Fixed point when resizing: the annotation's main anchor. */
export function scaleAnchor(a) {
  return a.base || a.target || a.p || a.pos || a.v || a.c || (a.pts && a.pts[1]) || a.p1 || (a.r && [a.r[0], a.r[1]]) || [0, 0];
}

export function build(a, S, measure) {
  const fn = BUILDERS[a.type];
  if (!fn) return { prims: [], handles: [] };
  const safeMeasure = (t, s) => measure(fontSafe(t), s);
  const b = fn(a, scaledS(S, a.scale || 1), safeMeasure);
  for (const p of b.prims) if (p.t === "T") p.txt = fontSafe(p.txt);
  b.bbox = primsBBox(b.prims);
  if (b.bbox && SCALABLE.has(a.type)) {
    // resize handles: the box corners far from the anchor (farthest first)
    const an = scaleAnchor(a);
    const [x0, y0, x1, y1] = b.bbox;
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => ({ q, d: Math.hypot(q[0] - an[0], q[1] - an[1]) }));
    corners.sort((u, v) => v.d - u.d);
    const far = corners.filter((c) => c.d >= corners[0].d * 0.45 && c.d > 4);
    b.handles = [...(b.handles || []), ...far.map((c) => ({ k: "sc", p: c.q }))];
  }
  return b;
}

// ------------------------------------------------------------------ selection geometry
function textCorners(p) {
  const ang = ((p.a || 0) * Math.PI) / 180;
  const tu = [Math.cos(ang), -Math.sin(ang)];
  const up = perpL(tu);
  const w = p.tw || p.s * 0.6 * (p.txt || "").length;
  const h = p.s * 0.9;
  const o = add(p.p, mul(up, -p.s * 0.2));
  return [o, add(o, mul(tu, w)), add(add(o, mul(tu, w)), mul(up, h)), add(o, mul(up, h))];
}

export function primsBBox(prims) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const ext = (x, y) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const p of prims) {
    if (p.t === "C") {
      ext(p.p[0] - p.r, p.p[1] - p.r);
      ext(p.p[0] + p.r, p.p[1] + p.r);
    } else if (p.t === "T") {
      for (const q of textCorners(p)) ext(q[0], q[1]);
    } else {
      for (let i = 0; i + 1 < p.p.length; i += 2) ext(p.p[i], p.p[i + 1]);
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

function distSeg(p, a, b) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  let t = L2 > 0 ? dot(sub(p, a), ab) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return len(sub(p, add(a, mul(ab, t))));
}

function inPoly(pt, xs) {
  let inside = false;
  for (let i = 0, j = xs.length / 2 - 1; i < xs.length / 2; j = i++) {
    const xi = xs[2 * i];
    const yi = xs[2 * i + 1];
    const xj = xs[2 * j];
    const yj = xs[2 * j + 1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function hit(built, a, pt, tol) {
  if (a.type === "mark") tol += ((a.w || 6) * K) / 2; // a highlighter stroke is wide
  if (!built.bbox) return false;
  const [x0, y0, x1, y1] = built.bbox;
  if (pt[0] < x0 - tol || pt[0] > x1 + tol || pt[1] < y0 - tol || pt[1] > y1 + tol) return false;
  if (a.type === "white" || a.type === "redact" || a.type === "ink" || a.type === "image") {
    const r = normRect(a.r);
    return pt[0] >= r[0] - tol && pt[0] <= r[2] + tol && pt[1] >= r[1] - tol && pt[1] <= r[3] + tol;
  }
  for (const p of built.prims) {
    if (p.t === "L") {
      if (distSeg(pt, [p.p[0], p.p[1]], [p.p[2], p.p[3]]) <= tol) return true;
    } else if (p.t === "P") {
      const xs = p.p;
      const n = xs.length / 2;
      for (let i = 0; i + 1 < n; i++) if (distSeg(pt, [xs[2 * i], xs[2 * i + 1]], [xs[2 * i + 2], xs[2 * i + 3]]) <= tol) return true;
      if (p.close && n > 2 && distSeg(pt, [xs[2 * n - 2], xs[2 * n - 1]], [xs[0], xs[1]]) <= tol) return true;
      if (p.fill && p.close && inPoly(pt, xs)) return true;
    } else if (p.t === "C") {
      const d = len(sub(pt, p.p));
      if (Math.abs(d - p.r) <= tol || (p.fill && d <= p.r)) return true;
    } else if (p.t === "T") {
      if (inPoly(pt, textCorners(p).flat())) return true;
    } else if (p.t === "R") {
      if (pt[0] >= p.p[0] && pt[0] <= p.p[2] && pt[1] >= p.p[1] && pt[1] <= p.p[3]) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ geometry editing
export function setHandle(a, k, pt, built) {
  if (k === "tx") {
    const meta = built && built.meta;
    if (meta) a.textShift = round(dot(sub(pt, meta.mid0), meta.tu), 2);
    return;
  }
  if (k === "r0") {
    a.r = [pt[0], pt[1], a.r[2], a.r[3]];
    return;
  }
  if (k === "r1") {
    a.r = [a.r[0], a.r[1], pt[0], pt[1]];
    return;
  }
  if (k === "row") {
    a.row = round(a.axis === "y" ? pt[0] : pt[1], 2);
    return;
  }
  if (k.startsWith("pts.")) {
    const i = Number(k.slice(4));
    a.pts = a.pts.map((q, j) => (j === i ? [...pt] : q));
    return;
  }
  a[k] = [...pt];
  if (a.type === "gdt" && (k === "pos" || k === "target") && !a.elbow) a.anchor = gdtAnchor(a.target, a.pos);
}

export function moveAnnot(a, dx, dy) {
  const mv = (p) => (p ? [p[0] + dx, p[1] + dy] : p);
  if (a.type === "holes") {
    // the table moves; the hole letters stay on the holes
    a.p = mv(a.p);
    return;
  }
  for (const k of ["p1", "p2", "p3", "c", "p", "v", "target", "pos", "vp", "tp", "elbow", "base", "lp"]) if (a[k]) a[k] = mv(a[k]);
  if (a.type === "ord" && typeof a.row === "number") a.row += a.axis === "y" ? dx : dy;
  if (a.pts) a.pts = a.pts.map(mv);
  if (a.r) a.r = [a.r[0] + dx, a.r[1] + dy, a.r[2] + dx, a.r[3] + dy];
}

/** Annotation points, offered as snap targets. */
/** Straight pieces of an annotation's lines, for snap on line / nearest / perpendicular (dimension and
 * extension lines, leaders, cutting lines…); arrowheads, text and filled shapes are left out. */
export function annotSnapSegs(built) {
  if (built._segs) return built._segs;
  const out = [];
  for (const p of built.prims || []) {
    if (p.ed || p.cover) continue;
    if (p.t === "L") out.push([p.p[0], p.p[1], p.p[2], p.p[3]]);
    else if (p.t === "P" && !p.fill && p.p.length >= 4 && (!p.close || p.p.length > 6)) {
      for (let i = 2; i < p.p.length; i += 2) out.push([p.p[i - 2], p.p[i - 1], p.p[i], p.p[i + 1]]);
      if (p.close) out.push([p.p[p.p.length - 2], p.p[p.p.length - 1], p.p[0], p.p[1]]);
    }
  }
  built._segs = out.filter((q) => Math.hypot(q[2] - q[0], q[3] - q[1]) > 0.5);
  return built._segs;
}

export function annotSnapPoints(built) {
  return (built.handles || []).filter((h) => h.p && h.k !== "tx" && h.k !== "sc" && h.k !== "row" && h.k !== "lp").map((h) => h.p);
}

/** Primitives for export: without elements that exist only in the editor. */
export function exportPrims(prims) {
  return prims
    .filter((p) => !p.ed)
    .map((p) => {
      const q = { t: p.t, p: p.p.map((v) => round(v, 3)), c: p.c };
      if (p.w != null) q.w = round(p.w, 3);
      if (p.close) q.close = true;
      if (p.fill) q.fill = true;
      if (p.nostroke) q.nostroke = true;
      if (p.r != null) q.r = round(p.r, 3);
      if (p.dp && p.dp.length) q.dp = p.dp.map((v) => round(v, 3));
      if (p.cover) q.cover = true;
      if (p.op != null && p.t !== "I") q.op = p.op;
      if (p.cap) q.cap = p.cap;
      if (p.blend) q.blend = p.blend;
      if (p.t === "I") {
        q.img = p.img;
        q.rot = p.rot || 0;
        q.op = p.op ?? 1;
      }
      if (p.t === "T") {
        q.s = round(p.s, 3);
        q.a = round(p.a || 0, 3);
        q.txt = p.txt;
      }
      return q;
    });
}

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}
