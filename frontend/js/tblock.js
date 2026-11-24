// Title blocks (indicator): templates kept in the browser, placed on a drawing as one annotation.
// A template is drawn in mm with the origin at its bottom-right corner (x ≤ 0 to the left, y ≤ 0 up),
// the corner that sits on the corner of the drawing frame. Texts may hold fields: {titlu}, {rev}…
// Pure module (tested in Node): no DOM, no storage.

const K = 72 / 25.4; // pt per mm
const CAP = 1515 / 2048; // cap height of osifont, relative to the em

/** Fields filled by DrawCAD itself; the others are typed in the panel. */
export const AUTO_FIELDS = ["rev", "data", "scara", "format", "foaia"];

/** Names of the known fields, for the panel (Romanian in the source, translated like the interface). */
export const FIELD_LABELS = {
  titlu: "Denumire",
  nr_desen: "Nr. desen",
  material: "Material",
  masa: "Masă",
  tol: "Toleranțe generale",
  autor: "Desenat",
  verificat: "Verificat",
  aprobat: "Aprobat",
  firma: "Firmă",
  rev: "Revizie",
  data: "Data",
  scara: "Scara",
  format: "Format",
  foaia: "Foaia",
};

const FIELD_RE = /\{([a-z0-9_]{1,24})\}/gi;

/** Fields used by a template, in order of appearance, without repeats. */
export function templateFields(tpl) {
  const out = [];
  for (const t of (tpl && tpl.texts) || []) {
    for (const m of String(t.txt || "").matchAll(FIELD_RE)) {
      const k = m[1].toLowerCase();
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

/** Scale as written on drawings: settings.scale = real mm per paper mm (2 → 1:2, 0.5 → 2:1). */
export function scaleText(scale) {
  const s = Number(scale) || 1;
  const fmt = (v) => String(Math.round(v * 100) / 100).replace(".", ",");
  return s >= 1 ? `1:${fmt(s)}` : `${fmt(1 / s)}:1`;
}

/** ISO sheet name from the page size in pt (A4…A0, either orientation), or "W×H" in mm. */
export function sheetOf(w, h) {
  const sizes = [["A4", 210, 297], ["A3", 297, 420], ["A2", 420, 594], ["A1", 594, 841], ["A0", 841, 1189]];
  const a = Math.min(w, h) / K;
  const b = Math.max(w, h) / K;
  const hit = sizes.find(([, s, l]) => Math.abs(a - s) < 3 && Math.abs(b - l) < 3);
  return hit ? hit[0] : `${Math.round(w / K)}×${Math.round(h / K)}`;
}

/** Value of every field: typed values first, then DrawCAD's own (revision, date, scale, sheet). */
export function fieldValues(a, S, ctx = {}) {
  const v = { ...(a.vals || {}) };
  const auto = {
    rev: S.revNo || "1",
    data: S.revDate || "",
    scara: scaleText(S.scale),
    format: ctx.page ? sheetOf(ctx.page[0], ctx.page[1]) : "",
    foaia: ctx.total ? `${(a.page || 0) + 1}/${ctx.total}` : "",
  };
  for (const k of AUTO_FIELDS) if (v[k] == null || v[k] === "") v[k] = auto[k];
  return v;
}

/** The template's texts with the fields replaced. */
export function fillText(txt, vals) {
  return String(txt || "").replace(FIELD_RE, (_m, k) => String(vals[k.toLowerCase()] ?? ""));
}

/**
 * Primitives of a placed title block. a: { p: bottom-right corner (pt), tpl, vals, scale }.
 * ctx: { page: [w, h] of its page, total: number of pages }.
 */
export function buildTblock(a, S, measure, ctx = {}) {
  const c = a.layer || "add";
  const tpl = a.tpl || {};
  const k = (a.scale || 1) * K;
  const [ox, oy] = a.p;
  const P = (x, y) => [ox + x * k, oy + y * k];
  const vals = fieldValues(a, S, ctx);
  const prims = [];
  const thick = 0.5 * K * (a.scale || 1);
  const thin = 0.25 * K * (a.scale || 1);
  for (const l of tpl.lines || []) {
    const [x1, y1, x2, y2, heavy] = l;
    const p = P(x1, y1);
    const q = P(x2, y2);
    prims.push({ t: "L", p: [p[0], p[1], q[0], q[1]], w: heavy ? thick : thin, c });
  }
  for (const t of tpl.texts || []) {
    const txt = fillText(t.txt, vals);
    if (!txt.trim()) continue;
    const s = ((t.s || 2.5) * k) / CAP;
    const tw = measure(txt, s);
    const [x, y] = P(t.x, t.y);
    const x0 = t.align === "c" ? x - tw / 2 : t.align === "r" ? x - tw : x;
    prims.push({ t: "T", p: [x0, y], s, a: 0, txt, tw, c });
  }
  if (tpl.logo && tpl.logo.img) {
    const L = tpl.logo;
    const p = P(L.x, L.y);
    const q = P(L.x + L.w, L.y + L.h);
    prims.push({ t: "I", p: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])], img: L.img, rot: 0, op: 1 });
  }
  const W = (tpl.w || 0) * k;
  const H = (tpl.h || 0) * k;
  return {
    prims,
    handles: [{ k: "p", p: a.p, move: true }],
    snap: {
      pts: [[ox, oy, "e"], [ox - W, oy, "e"], [ox - W, oy - H, "e"], [ox, oy - H, "e"]],
      segs: prims.filter((q) => q.t === "L").map((q) => q.p),
    },
  };
}

// ------------------------------------------------------------------ generator (after ISO 7200)
const LBL = {
  ro: { drawn: "Desenat", checked: "Verificat", approved: "Aprobat", title: "Denumire", material: "Material", mass: "Masă", tol: "Toleranțe generale", number: "Nr. desen", rev: "Rev.", sheet: "Foaia", scale: "Scara", format: "Format", date: "Data", owner: "Proprietar" },
  en: { drawn: "Drawn", checked: "Checked", approved: "Approved", title: "Title", material: "Material", mass: "Mass", tol: "General tolerances", number: "Drawing no.", rev: "Rev.", sheet: "Sheet", scale: "Scale", format: "Format", date: "Date", owner: "Owner" },
};

/**
 * A title block after ISO 7200: 180 mm wide, 5 rows of 8 mm. Left: people and the owner (with an
 * optional logo); middle: title, material, mass, general tolerances; right: drawing number, revision,
 * sheet, scale, format, date. opts: { name, lang: "ro" | "en", company, logo: { data, w, h } }.
 */
export function isoTemplate(opts = {}) {
  const L = LBL[opts.lang === "en" ? "en" : "ro"];
  const W = 180;
  const H = 40;
  const R = 8;
  const X = (x) => x - W; // from the left edge to the bottom-right origin
  const Y = (y) => y - H; // from the top edge
  const lines = [];
  const texts = [];
  const box = (x0, y0, x1, y1) => lines.push([X(x0), Y(y0), X(x1), Y(y0)], [X(x1), Y(y0), X(x1), Y(y1)], [X(x1), Y(y1), X(x0), Y(y1)], [X(x0), Y(y1), X(x0), Y(y0)]);
  const label = (x, y, txt) => texts.push({ x: X(x + 1), y: Y(y + 2.6), s: 1.8, txt });
  const value = (x, y, txt, s = 2.5, w = 0) => texts.push(w ? { x: X(x + w / 2), y: Y(y + R - 1.6), s, txt, align: "c" } : { x: X(x + 1.5), y: Y(y + R - 1.6), s, txt });
  // columns: people 0–50, title 50–130, document 130–180
  for (let r = 0; r < 3; r++) box(0, r * R, 50, (r + 1) * R);
  box(0, 3 * R, 50, H);
  box(50, 0, 130, 2 * R);
  for (let r = 2; r < 5; r++) box(50, r * R, 130, (r + 1) * R);
  box(130, 0, 180, 2 * R);
  box(130, 2 * R, 155, 3 * R);
  box(155, 2 * R, 180, 3 * R);
  box(130, 3 * R, 155, 4 * R);
  box(155, 3 * R, 180, 4 * R);
  box(130, 4 * R, 180, 5 * R);
  // the outline is a thick line
  lines.push([X(0), Y(0), X(W), Y(0), 1], [X(W), Y(0), X(W), Y(H), 1], [X(W), Y(H), X(0), Y(H), 1], [X(0), Y(H), X(0), Y(0), 1]);
  [[0, L.drawn, "{autor}"], [1, L.checked, "{verificat}"], [2, L.approved, "{aprobat}"]].forEach(([r, l, f]) => {
    label(0, r * R, l);
    value(0, r * R, f);
  });
  label(0, 3 * R, L.owner);
  const tpl = { v: 1, name: opts.name || "ISO 7200", w: W, h: H, lines, texts };
  if (opts.logo && opts.logo.data && opts.logo.w > 0 && opts.logo.h > 0) {
    // the logo in the owner cell, under its label, proportions kept
    const cw = 46;
    const ch = 11;
    const kk = Math.min(cw / opts.logo.w, ch / opts.logo.h);
    const w = opts.logo.w * kk;
    const h = opts.logo.h * kk;
    tpl.logo = { x: X(2 + (cw - w) / 2), y: Y(3 * R + 3.5 + (ch - h) / 2), w, h, data: opts.logo.data };
  } else {
    texts.push({ x: X(25), y: Y(H - 4), s: 3.5, txt: opts.company ? String(opts.company).slice(0, 60) : "{firma}", align: "c" });
  }
  label(50, 0, L.title);
  texts.push({ x: X(90), y: Y(2 * R - 3), s: 5, txt: "{titlu}", align: "c" });
  [[2, L.material, "{material}"], [3, L.mass, "{masa}"], [4, L.tol, "{tol}"]].forEach(([r, l, f]) => {
    label(50, r * R, l);
    value(50, r * R, f, 2.5, 80);
  });
  label(130, 0, L.number);
  texts.push({ x: X(155), y: Y(2 * R - 3), s: 3.5, txt: "{nr_desen}", align: "c" });
  [[130, 2, L.rev, "{rev}"], [155, 2, L.sheet, "{foaia}"], [130, 3, L.scale, "{scara}"], [155, 3, L.format, "{format}"]].forEach(([x, r, l, f]) => {
    label(x, r * R, l);
    value(x, r * R, f, 2.5, 25);
  });
  label(130, 4 * R, L.date);
  value(130, 4 * R, "{data}", 2.5, 50);
  return tpl;
}

// ------------------------------------------------------------------ from the drawing
/**
 * A template from drawn objects: items = [{ kind: "line", p: [x1, y1, x2, y2] (pt), heavy },
 * { kind: "text", p: [x, y] (pt, baseline start), txt, h: cap height in pt }, { kind: "logo", r: [x0, y0,
 * x1, y1] (pt), data, iw, ih }]. The origin is the bottom-right corner of everything selected.
 */
export function templateFromItems(items, name = "Indicator") {
  let x1 = -Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  let y0 = Infinity;
  const ext = (x, y) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const it of items) {
    if (it.kind === "line") {
      ext(it.p[0], it.p[1]);
      ext(it.p[2], it.p[3]);
    } else if (it.kind === "text") ext(it.p[0], it.p[1]);
    else if (it.kind === "logo") {
      ext(it.r[0], it.r[1]);
      ext(it.r[2], it.r[3]);
    }
  }
  if (x0 === Infinity) return null;
  const mm = (v) => Math.round((v / K) * 100) / 100;
  const X = (x) => mm(x - x1);
  const Y = (y) => mm(y - y1);
  const tpl = { v: 1, name, w: mm(x1 - x0), h: mm(y1 - y0), lines: [], texts: [] };
  for (const it of items) {
    if (it.kind === "line") tpl.lines.push([X(it.p[0]), Y(it.p[1]), X(it.p[2]), Y(it.p[3]), ...(it.heavy ? [1] : [])]);
    else if (it.kind === "text") tpl.texts.push({ x: X(it.p[0]), y: Y(it.p[1]), s: mm(it.h), txt: it.txt });
    else if (it.kind === "logo" && it.data) {
      const r = it.r;
      tpl.logo = { x: X(Math.min(r[0], r[2])), y: Y(Math.min(r[1], r[3])), w: mm(Math.abs(r[2] - r[0])), h: mm(Math.abs(r[3] - r[1])), data: it.data };
    }
  }
  return tpl;
}

/** A template read from a file (.drawcad-tb.json): only the expected structure, sizes limited. */
export function cleanTemplate(t) {
  if (!t || typeof t !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(-2000, Math.min(2000, Number(v))) : 0);
  const out = {
    v: 1,
    name: String(t.name || "Indicator").slice(0, 80),
    w: Math.abs(num(t.w)),
    h: Math.abs(num(t.h)),
    lines: (Array.isArray(t.lines) ? t.lines : []).slice(0, 2000).filter((l) => Array.isArray(l) && l.length >= 4).map((l) => [num(l[0]), num(l[1]), num(l[2]), num(l[3]), ...(l[4] ? [1] : [])]),
    texts: (Array.isArray(t.texts) ? t.texts : []).slice(0, 500).filter((x) => x && typeof x === "object").map((x) => ({
      x: num(x.x), y: num(x.y), s: Math.max(0.5, Math.min(30, num(x.s) || 2.5)), txt: String(x.txt || "").slice(0, 200),
      ...(["c", "r"].includes(x.align) ? { align: x.align } : {}),
    })),
  };
  const L = t.logo;
  if (L && typeof L === "object" && typeof L.data === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(L.data) && L.data.length <= 420000) {
    out.logo = { x: num(L.x), y: num(L.y), w: Math.abs(num(L.w)), h: Math.abs(num(L.h)), data: L.data };
  }
  return out;
}
