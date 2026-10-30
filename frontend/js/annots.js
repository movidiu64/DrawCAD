// Modelul adnotărilor și generarea primitivelor de desen.
// Toate coordonatele: puncte PDF vizuale (y în jos). Unghiuri text: grade, sens trigonometric pe ecran.
import { deviations, fmtDev } from "./iso286.js";
import { symbolPrims, GDT_BY_ID, MODIFIERS } from "./gdt.js";
import { buildShape, SHAPE_NAMES } from "./shapes.js";
import { buildSection, buildDetail, buildBalloon } from "./symbols.js";

export const K = 72 / 25.4; // pt pe mm
export const CAP = 1515 / 2048; // înălțimea majusculelor în osifont, raportată la em

export const DEFAULT_SETTINGS = {
  textH: 3.5, // mm, înălțimea majusculelor (ISO 3098)
  arrowLen: 3, // mm
  lineW: 0.25, // mm
  sep: ",",
  isoDisplay: "codeDev",
  codeSpace: false, // „Ø25k6” (ISO 286) sau „Ø25 k6”
  arrow: "closed",
  scale: 1, // mm reali pe mm de hârtie (1 = scara 1:1)
  revNo: "1",
  extGap: 0.5,
  extOver: 2,
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
};

export function typeName(a) {
  return (a.type === "shape" && SHAPE_NAMES[a.kind]) || TYPE_NAMES[a.type] || a.type;
}

// ------------------------------------------------------------------ vectori
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : null;
};
const perpL = (a) => [a[1], -a[0]]; // „sus” față de direcția textului, pe ecran

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

// ------------------------------------------------------------------ formatare
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

/** mm cu semn, minim 3 zecimale: +0,015 / -0,1 → -0,100 */
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

// ------------------------------------------------------------------ etichete
/**
 * Construiește textul unei cote ca listă de „run”-uri: { txt, x, dy, s, w }.
 * x avansează pe direcția textului, dy e deasupra liniei de bază (pt).
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
  // abateri: mm cu minim 3 zecimale; la unghiuri, grade fără zerouri inutile
  const fd = (v) => (deg ? (v > 0 ? "+" : v < 0 ? "-" : "") + fmtNum(Math.abs(v), sep, 3) + "°" : fmtSigned(v, sep));
  const fabs = (v) => (deg ? fmtNum(Math.abs(v), sep, 3) + "°" : fmtSigned(Math.abs(v), sep).slice(1));
  const main = a.textOverride && a.textOverride.trim() ? a.textOverride.trim() : prefix + fmtNum(nominal, sep, deg ? 2 : 3) + unit;
  const t = a.tol || { mode: "none" };
  const space = S.codeSpace ? " " : "";

  if (t.mode === "pm" && t.pm) {
    push(main + "±" + fabs(t.pm));
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

// ------------------------------------------------------------------ primitive auxiliare
function lineP(a, b, S, c) {
  return { t: "L", p: [a[0], a[1], b[0], b[1]], w: S.lw, c };
}

function arrowP(tip, d, S, c) {
  // d: direcția în care „arată” săgeata (spre vârf)
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
  // direcție lizibilă (de jos sau din dreapta, ISO 129 metoda 1) și unghiul ei
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

// ------------------------------------------------------------------ constructori pe tip

function buildDim(a, S, measure) {
  const c = a.layer || "add";
  const { p1, p2, p3 } = a;
  let u;
  if (a.kind === "ali") u = norm(sub(p2, p1)) || [1, 0];
  else u = a.orient === "v" ? [0, 1] : [1, 0];
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
  const inside = Ld >= 2.4 * S.aw + S.h;
  if (inside) {
    prims.push(lineP(A, B, S, c));
    prims.push(...arrowP(A, mul(dir, -1), S, c), ...arrowP(B, dir, S, c));
  } else {
    prims.push(lineP(sub(A, mul(dir, S.aw * 2.2)), add(B, mul(dir, S.aw * 2.2)), S, c));
    prims.push(...arrowP(A, dir, S, c), ...arrowP(B, mul(dir, -1), S, c));
  }

  const nominal = a.nominal != null ? a.nominal : round(measured, 2);
  const lab = labelRuns(a, S, measure, nominal, a.prefix || "");
  const { tu, ang, up } = textAngle(dir);
  const mid0 = mul(add(A, B), 0.5);
  // textul care nu încape între săgeți se mută lângă săgeată, pe prelungirea liniei de cotă
  let shift = a.textShift;
  if (shift == null) {
    const fits = lab.w + 2 * S.aw * 1.1 <= Ld;
    shift = fits ? 0 : Ld / 2 + (inside ? S.aw * 0.8 : S.aw * 2.6) + lab.w / 2;
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
    meta: { mid0, tu },
    handles: [
      { k: "p1", p: p1 },
      { k: "p2", p: p2 },
      { k: "p3", p: mul(add(A, B), 0.5), move: true },
      { k: "tx", p: tcenter },
    ],
  };
}

function buildRad(a, S, measure) {
  const c = a.layer || "add";
  const R = len(sub(a.p, a.c));
  const d = norm(sub(a.p3, a.c)) || norm(sub(a.p, a.c)) || [1, 0];
  const q = add(a.c, mul(d, R));
  const far = len(sub(a.p3, a.c)) > R;
  const prims = [];
  let s0;
  let s1;
  if (far) {
    s0 = q;
    s1 = a.p3;
    prims.push(lineP(q, a.p3, S, c), ...arrowP(q, mul(d, -1), S, c));
  } else {
    s0 = a.c;
    s1 = q;
    prims.push(lineP(a.c, q, S, c), ...arrowP(q, d, S, c));
  }
  const measured = (R / K) * S.scale;
  const nominal = a.nominal != null ? a.nominal : round(measured, 2);
  const lab = labelRuns(a, S, measure, nominal, a.prefix ?? "R");
  const { tu, ang, up } = textAngle(norm(sub(s1, s0)) || d);
  const mid = mul(add(s0, s1), 0.5);
  const lift = Math.max(0.6 * K, 0.3 * S.h);
  const origin = add(sub(mid, mul(tu, lab.w / 2)), mul(up, lift));
  prims.push(...placeRuns(lab, origin, tu, up, ang, c));
  return {
    prims,
    measured,
    nominal,
    iso: lab.iso,
    handles: [
      { k: "c", p: a.c },
      { k: "p", p: a.p },
      { k: "p3", p: a.p3 },
    ],
  };
}

// unghi „pe ecran” (sens trigonometric, y în jos) al unui vector
const angOf = (v) => Math.atan2(-v[1], v[0]);
const TAU = Math.PI * 2;
const wrap = (x) => ((x % TAU) + TAU) % TAU;
const polar = (c, r, th) => [c[0] + r * Math.cos(th), c[1] - r * Math.sin(th)];

/**
 * Sectorul unghiular care conține direcția p3, dintre cele patru formate de cele două drepte
 * prin vârf. Întoarce { s, e, sweep, legS, legE } — capetele în radiani, sens trigonometric,
 * și pentru fiecare capăt indicele laturii (0/1) și dacă e direcția laturii sau opusa ei.
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

  // linii ajutătoare pe direcțiile laturilor, până dincolo de arc
  for (const end of sec.ends) {
    const th = end.th;
    const d = [Math.cos(th), -Math.sin(th)];
    const legLen = end.rev ? 0 : len(sub(legs[end.leg], V));
    if (r > legLen + S.gap) {
      prims.push(lineP(add(V, mul(d, legLen + S.gap)), add(V, mul(d, r + S.over)), S, c));
    }
  }

  // arcul de cotă, ca polilinie
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

  // valoarea: orizontală, în afara arcului, pe bisectoare
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

// ------------------------------------------------------------------ rugozitate (ISO 1302 / ISO 21920-1)
const T60 = Math.tan(Math.PI / 6); // proiecția orizontală a unei laturi înclinate la 60° față de suprafață

/** Simbolul în sistemul local: vârful în (0,0), simbolul „în sus” (y negativ). */
function roughLocal(a, S, measure) {
  const h = S.h;
  const H1 = 1.43 * h; // ISO 1302: h = 3,5 → H1 = 5 mm
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
    const x0 = (H2 - 0.4 * h) * T60 + 0.5 * h; // textul începe în dreapta laturii lungi
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
    // linie de indicație cu săgeată pe suprafață și umăr orizontal pe care stă simbolul
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
  // rotire pe ecran în sens trigonometric (y în jos)
  const tr = (x, y) => [origin[0] + x * cs + y * sn, origin[1] - x * sn + y * cs];
  for (const [x1, y1, x2, y2] of loc.lines) prims.push(lineP(tr(x1, y1), tr(x2, y2), S, c));
  for (const ci of loc.circles) prims.push({ t: "C", p: tr(...ci.c), r: ci.r, w: S.lw, c });
  for (const t of loc.texts) prims.push({ t: "T", p: tr(...t.p), s: t.s, a: rot, txt: t.txt, tw: t.w, c });
  return { prims, handles: [{ k: "target", p: a.target }, { k: "pos", p: a.pos || a.target, move: true }] };
}

// ------------------------------------------------------------------ note tehnice
export function noteLines(a) {
  return String(a.text || "").replace(/\r/g, "").split("\n");
}

function buildNote(a, S, measure) {
  const c = a.layer || "add";
  const k = a.size || 1;
  const h = S.h * k;
  const F = S.F * k;
  const pitch = 1.7 * h; // distanța dintre liniile de bază
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

// ------------------------------------------------------------------ tabel de revizii
export const REVTAB_COLS = [
  { key: "rev", title: "Rev.", minMm: 10 },
  { key: "desc", title: "Modificare", minMm: 40 },
  { key: "date", title: "Data", minMm: 22 },
  { key: "name", title: "Nume", minMm: 14 },
];

// Lista de componente (ISO 7573): deasupra cartușului, antetul jos, poziția 1 lângă antet.
export const BOM_COLS = [
  { key: "poz", title: "Poz.", minMm: 10 },
  { key: "name", title: "Denumire", minMm: 45, left: true },
  { key: "qty", title: "Buc.", minMm: 10 },
  { key: "mat", title: "Material", minMm: 28, left: true },
  { key: "obs", title: "Observații", minMm: 24, left: true },
];

function buildRevtab(a, S, measure) {
  return buildTable(a, S, measure, REVTAB_COLS.map((c) => (c.key === "desc" ? { ...c, left: true } : c)));
}

function buildBom(a, S, measure) {
  return buildTable(a, S, measure, BOM_COLS);
}

function buildTable(a, S, measure, COLS) {
  const c = a.layer || "add";
  const h = S.h;
  const F = S.F;
  const rowH = 2 * h; // ca la cadrul GD&T: înălțimea rândului = 2 × înălțimea textului
  const pad = 0.6 * h;
  const rows = a.rows || [];
  const widths = COLS.map((col) => {
    let w = col.minMm * K * (a.scale || 1);
    w = Math.max(w, measure(col.title, F) + 2 * pad);
    for (const r of rows) w = Math.max(w, measure(String(r[col.key] || ""), F) + 2 * pad);
    return w;
  });
  const W = widths.reduce((s, w) => s + w, 0);
  const nRows = rows.length + 1;
  const Htot = nRows * rowH;
  // ancora e colțul dreapta-jos: tabelul se aliniază la dreapta cu cartușul, oricât de lat devine
  const yb = a.p[1];
  const x0 = a.p[0] - W;
  const yt = yb - Htot;
  const prims = [{ t: "P", p: [x0, yt, x0 + W, yt, x0 + W, yb, x0, yb], close: true, w: S.lw * 1.4, c }];
  // ordinea vizuală a rândurilor, de sus în jos
  const order = a.headerBottom !== false ? [...rows].reverse().map((r) => ({ r })).concat([{ header: true }]) : [{ header: true }].concat(rows.map((r) => ({ r })));
  order.forEach((item, i) => {
    const top = yt + i * rowH;
    if (i > 0) prims.push(lineP([x0, top], [x0 + W, top], { ...S, lw: item.header || order[i - 1].header ? S.lw * 1.4 : S.lw }, c));
    let x = x0;
    COLS.forEach((col, j) => {
      const txt = item.header ? col.title : String(item.r[col.key] || "");
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
  // text pe mai multe rânduri: ultimul rând stă pe umăr, celelalte deasupra
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
  const down = [Math.sin(th), Math.cos(th)]; // direcția „rândul următor” pe ecran
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
  const x0 = a.pos[0];
  const y0 = a.pos[1] - Hf / 2;
  const W = cells.reduce((s, q) => s + q.w, 0);
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
  // linia de indicație spre element
  const T = a.target;
  let elbowH = null;
  if (T) {
    let pts;
    const x1 = x0 + W;
    const E = a.elbow;
    if (E) {
      // cot liber: linia pleacă din capătul cadrului cel mai apropiat de cot, apoi spre element
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
    // segmente degenerate eliminate
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
  return { prims, handles };
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
  // marginea casetei pe direcția spre triunghi
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
    // triunghi echilateral cu numărul reviziei, în sistemul local al textului
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
  if (!vertical) {
    const ym = (y0 + y1) / 2;
    prims.push(lineP([x0 - ext, ym], [x1 + ext, ym], { ...S, lw: S.lw * 1.4 }, c));
    let x = x1 + 1.5 * K;
    if (txt) {
      prims.push({ t: "T", p: [x, y1], s: S.F, a: 0, txt, tw, c });
      x += tw + 1 * K;
    }
    prims.push(...triPrims(x, y1, 0));
  } else {
    const xm = (x0 + x1) / 2;
    prims.push(lineP([xm, y1 + ext], [xm, y0 - ext], { ...S, lw: S.lw * 1.4 }, c));
    let y = y0 - 1.5 * K;
    if (txt) {
      prims.push({ t: "T", p: [x1, y], s: S.F, a: 90, txt, tw, c });
      y -= tw + 1 * K;
    }
    prims.push(...triPrims(x1, y, 90));
  }
  return { prims, handles: [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }] };
}

function normRect(r) {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function rectOutline(r, c) {
  const [x0, y0, x1, y1] = normRect(r);
  return { t: "P", p: [x0, y0, x1, y0, x1, y1, x0, y1], close: true, w: 0.6, c, ed: true, dash: true };
}

/** Culoarea unei acoperiri: alb implicit sau culoarea aleasă (#rrggbb). */
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
  // pagina din editor e deja randată cu ștergerile aplicate: aici rămâne doar conturul zonei
  const r = normRect(a.r);
  const prims = [rectOutline(r, a.mode === "cover" ? "edgray" : "edred")];
  // vechile zone (fără „cover”) se acopereau mereu cu alb
  const cover = (a.mode === "zone" && a.cover !== false) || a.mode === "cover";
  if (cover) prims.unshift({ t: "R", p: r, c: a.mode === "cover" ? coverColor(a) : "white", cover: true });
  return { prims, handles: [{ k: "r0", p: [a.r[0], a.r[1]] }, { k: "r1", p: [a.r[2], a.r[3]] }] };
}

const BUILDERS = { dim: buildDim, rad: buildRad, ang: buildAng, rough: buildRough, note: buildNote, revtab: buildRevtab, lead: buildLead, text: buildText, gdt: buildGdt, datum: buildDatum, strike: buildStrike, white: buildWhite, redact: buildRedact, ink: buildInk, shape: buildShape, section: buildSection, detail: buildDetail, balloon: buildBalloon, bom: buildBom };

// caractere fără glifă în osifont → echivalente care există (la fel pe ecran și în PDF)
const GLYPH_SUBST = { "…": "...", "„": '"', "”": '"', "“": '"', "«": '"', "»": '"', "‚": ",", "‘": "'", "\u00a0": " ", "−": "-" };
const GLYPH_RE = new RegExp(`[${Object.keys(GLYPH_SUBST).join("")}]`, "g");
export function fontSafe(txt) {
  return String(txt ?? "").replace(GLYPH_RE, (ch) => GLYPH_SUBST[ch]);
}

export const SCALABLE = new Set(["dim", "rad", "ang", "rough", "lead", "text", "note", "gdt", "datum", "strike", "revtab", "section", "detail", "balloon", "bom"]);
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 5;

/** Setările pentru o adnotare mărită/micșorată: text, săgeți și distanțe; grosimea liniilor rămâne. */
export function scaledS(S, k) {
  if (!k || Math.abs(k - 1) < 1e-9) return S;
  return { ...S, h: S.h * k, F: S.F * k, aw: S.aw * k, gap: S.gap * k, over: S.over * k };
}

/** Punctul fix la mărire: ancora principală a adnotării. */
export function scaleAnchor(a) {
  return a.target || a.p || a.pos || a.v || a.c || (a.pts && a.pts[1]) || a.p1 || (a.r && [a.r[0], a.r[1]]) || [0, 0];
}

export function build(a, S, measure) {
  const fn = BUILDERS[a.type];
  if (!fn) return { prims: [], handles: [] };
  const safeMeasure = (t, s) => measure(fontSafe(t), s);
  const b = fn(a, scaledS(S, a.scale || 1), safeMeasure);
  for (const p of b.prims) if (p.t === "T") p.txt = fontSafe(p.txt);
  b.bbox = primsBBox(b.prims);
  if (b.bbox && SCALABLE.has(a.type)) {
    // pătrățelul de mărire: colțul casetei cel mai depărtat de ancoră
    const an = scaleAnchor(a);
    const [x0, y0, x1, y1] = b.bbox;
    let best = null;
    let bd = -1;
    for (const q of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      const d = Math.hypot(q[0] - an[0], q[1] - an[1]);
      if (d > bd) {
        bd = d;
        best = q;
      }
    }
    b.handles = [...(b.handles || []), { k: "sc", p: best }];
  }
  return b;
}

// ------------------------------------------------------------------ geometrie de selecție
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
  if (!built.bbox) return false;
  const [x0, y0, x1, y1] = built.bbox;
  if (pt[0] < x0 - tol || pt[0] > x1 + tol || pt[1] < y0 - tol || pt[1] > y1 + tol) return false;
  if (a.type === "white" || a.type === "redact" || a.type === "ink") {
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

// ------------------------------------------------------------------ editare geometrie
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
  if (k.startsWith("pts.")) {
    const i = Number(k.slice(4));
    a.pts = a.pts.map((q, j) => (j === i ? [...pt] : q));
    return;
  }
  a[k] = [...pt];
}

export function moveAnnot(a, dx, dy) {
  const mv = (p) => (p ? [p[0] + dx, p[1] + dy] : p);
  for (const k of ["p1", "p2", "p3", "c", "p", "v", "target", "pos", "vp", "tp", "elbow"]) if (a[k]) a[k] = mv(a[k]);
  if (a.pts) a.pts = a.pts.map(mv);
  if (a.r) a.r = [a.r[0] + dx, a.r[1] + dy, a.r[2] + dx, a.r[3] + dy];
}

/** Puncte ale adnotărilor, oferite ca țintă de snap. */
export function annotSnapPoints(built) {
  return (built.handles || []).filter((h) => h.p && h.k !== "tx" && h.k !== "sc").map((h) => h.p);
}

/** Primitive pentru export: fără elementele care există doar în editor. */
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
