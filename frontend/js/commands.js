// Keys and commands: one key = one tool ("direct keys") or commands typed as in AutoCAD
// (L, C, PL, REC, DLI… + Space / Enter). Default aliases follow AutoCAD where an
// equivalent command exists; the rest have short Romanian or English names.
import { TOOLS, TOOL_BY_ID } from "./tools.js";

const STORE = "drawcad.keys";

/** Default tool aliases (the first one is the one shown). */
export const DEFAULT_ALIASES = {
  select: ["SEL", "SELECT"],
  pan: ["P", "PAN"],
  measure: ["DI", "DIST", "MEA", "MEASUREGEOM"],
  ucs: ["UCS", "ORIGIN", "ORIGINE"],
  moveSel: ["M", "MOVE"],
  copySel: ["CO", "CP", "COPY"],
  dimLin: ["DLI", "DIMLINEAR", "DIM"],
  dimAli: ["DAL", "DIMALIGNED"],
  dimDia: ["DDL", "DIMDIALIN"],
  dimDiaC: ["DDI", "DIMDIAMETER"],
  dimRad: ["DRA", "DIMRADIUS"],
  dimAng: ["DAN", "DIMANGULAR"],
  dimOrd: ["DOR", "DIMORDINATE", "ORD"],
  holes: ["HOLETABLE", "HT", "GAURI"],
  dimCont: ["DCO", "DIMCONTINUE", "LANT"],
  dimBase: ["DBA", "DIMBASELINE"],
  chamfer: ["CHA", "TES", "CHAMFER"],
  lead: ["LE", "QLEADER", "MLD", "MLEADER"],
  text: ["T", "MT", "MTEXT", "DT", "TEXT"],
  rough: ["RUG", "SURF", "RA"],
  gdt: ["TOL", "TOLERANCE", "GDT"],
  datum: ["DATUM", "BAZA"],
  note: ["NOTE", "NOTA"],
  revtab: ["REV", "REVTAB"],
  bom: ["BOM", "LISTA"],
  line: ["L", "LINE"],
  poly: ["PL", "PLINE"],
  rect: ["REC", "RECTANG", "RECTANGLE"],
  circle: ["C", "CIRCLE"],
  arc: ["A", "ARC"],
  cross: ["CM", "CENTERMARK", "DCE"],
  hatch: ["H", "HATCH", "BH"],
  break: ["BRL", "BREAKLINE"],
  section: ["SEC", "SECTION"],
  detail: ["DET", "DETAIL", "VIEWDETAIL"],
  viewlabel: ["VL", "ETI"],
  balloon: ["BAL", "BALLOON"],
  image: ["IAT", "IMAGEATTACH", "IMG"],
  tblock: ["TB", "TITLEBLOCK"],
  cloud: ["REVCLOUD", "RVC"],
  cloudp: ["RVCP", "REVCLOUDP"],
  mark: ["HL", "HIGHLIGHT"],
  comment: ["CMT", "COMMENT"],
  stamp: ["STAMP", "STP"],
  qr: ["QR", "QRCODE"],
  strike: ["STR", "TAIE"],
  white: ["WO", "WIPEOUT"],
  ink: ["INK"],
  redact: ["STERGE", "REDACT"],
  calib: ["CALIB", "SCALA", "K"],
};

/** Commands that are not tools. */
export const ACTIONS = [
  { id: "erase", label: "Șterge adnotările", aliases: ["E", "ERASE", "DEL"] },
  { id: "undo", label: "Anulează acțiunea", aliases: ["U", "UNDO"] },
  { id: "redo", label: "Refă", aliases: ["REDO", "MREDO"] },
  { id: "fit", label: "Zoom pe toată pagina", aliases: ["Z", "ZE", "ZOOM"], transparent: true },
  { id: "zoomSel", label: "Zoom pe selecție", aliases: ["ZS"], transparent: true },
  { id: "find", label: "Caută text / OCR", aliases: ["FIND", "TEXTFIND", "OCR"] },
  { id: "export", label: "Exportă", aliases: ["EXP", "EXPORT", "PLOT", "SAVEAS"] },
  { id: "open", label: "Deschide desen", aliases: ["OPEN"] },
  { id: "close", label: "Închide documentul", aliases: ["CLOSE"] },
  { id: "settings", label: "Setări", aliases: ["OP", "OPTIONS"] },
  { id: "keys", label: "Taste și comenzi", aliases: ["ALIASEDIT", "KEYS", "TASTE"] },
  { id: "osnap", label: "Snap pornit / oprit", aliases: ["OS", "OSNAP"], transparent: true },
  { id: "ortho", label: "Ortho pornit / oprit", aliases: ["OR", "ORTHO"], transparent: true },
  { id: "polar", label: "Polar pornit / oprit", aliases: ["POLAR"], transparent: true },
  { id: "selAll", label: "Selectează tot", aliases: ["ALL"] },
  { id: "nextPage", label: "Pagina următoare", aliases: ["PN"] },
  { id: "prevPage", label: "Pagina anterioară", aliases: ["PP"] },
  { id: "rotR", label: "Rotește pagina la dreapta", aliases: ["ROTR"] },
  { id: "rotL", label: "Rotește pagina la stânga", aliases: ["ROTL"] },
  { id: "pages", label: "Pagini (rotire, ordine, ștergere)", aliases: ["PAGES", "PAGINI"] },
  { id: "compare", label: "Compară cu altă revizie", aliases: ["COMPARE", "CMP"] },
];

// keys with a fixed role, which cannot be assigned to tools
export const RESERVED_KEYS = new Set(["f", "+", "-", "=", " "]);

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

export function defaultKeyConfig() {
  return { mode: "direct", keys: {}, aliases: {}, pickadd: false };
}

export function keyConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) || "null");
    if (c && typeof c === "object") {
      return {
        mode: c.mode === "autocad" ? "autocad" : "direct",
        keys: c.keys && typeof c.keys === "object" ? c.keys : {},
        aliases: c.aliases && typeof c.aliases === "object" ? c.aliases : {},
        pickadd: !!c.pickadd,
      };
    }
  } catch (_) { /* storage unavailable */ }
  return defaultKeyConfig();
}

export function saveKeyConfig(cfg) {
  try {
    localStorage.setItem(STORE, JSON.stringify(cfg));
  } catch (_) { /* storage unavailable */ }
}

/** All commands (tools + actions), with the direct key and the aliases currently valid. */
export function commandList(cfg = defaultKeyConfig()) {
  const out = [];
  for (const t of TOOLS) {
    const key = Object.prototype.hasOwnProperty.call(cfg.keys, t.id) ? cfg.keys[t.id] : t.key || "";
    const aliases = cfg.aliases[t.id] || DEFAULT_ALIASES[t.id] || [];
    out.push({ id: t.id, kind: "tool", label: t.label, group: t.group, key: String(key || "").toUpperCase(), aliases: aliases.map((a) => a.toUpperCase()) });
  }
  for (const a of ACTIONS) {
    const aliases = cfg.aliases[a.id] || a.aliases;
    out.push({ id: a.id, kind: "action", label: a.label, group: "Comenzi", key: "", aliases: aliases.map((x) => x.toUpperCase()), transparent: !!a.transparent });
  }
  return out;
}

/** Direct key (lowercase letter) → tool id. */
export function directKeyMap(cfg) {
  const map = {};
  for (const c of commandList(cfg)) if (c.kind === "tool" && c.key) map[c.key.toLowerCase()] = c.id;
  return map;
}

/** The typed command: exact alias first, then the tool name (without diacritics and spaces). */
export function resolveCommand(input, cfg) {
  let q = String(input || "").trim().toUpperCase();
  // 'Z, 'OS…: a transparent command, typed during another one (CMD-D11)
  const quoted = q.startsWith("'");
  if (quoted) {
    q = q.slice(1);
    const c = resolveCommand(q, cfg);
    return c && c.transparent ? { ...c, quoted } : null;
  }
  if (!q) return null;
  const list = commandList(cfg);
  const byAlias = list.find((c) => c.aliases.includes(q));
  if (byAlias) return byAlias;
  const n = norm(q);
  return list.find((c) => norm(c.label) === n) || null;
}

/** Suggestions for what has been typed so far, like AutoCAD autocomplete. */
export function suggest(input, cfg, max = 12) {
  const q = String(input || "").trim().toUpperCase();
  if (!q) return [];
  const n = norm(q);
  const scored = [];
  for (const c of commandList(cfg)) {
    let s = -1;
    let hit = "";
    if (c.aliases.includes(q)) {
      s = 0;
      hit = q;
    } else {
      const pre = c.aliases.find((a) => a.startsWith(q));
      if (pre) {
        s = 1 + pre.length / 100;
        hit = pre;
      } else if (norm(c.label).startsWith(n)) s = 2;
      else if (n.length >= 3 && norm(c.label).includes(n)) s = 3;
    }
    if (s >= 0) scored.push({ ...c, score: s, hit: hit || c.aliases[0] || "" });
  }
  scored.sort((a, b) => a.score - b.score || a.hit.length - b.hit.length || a.label.localeCompare(b.label));
  return scored.slice(0, max);
}

/** Duplicates: the same key on two tools or the same alias on two commands. */
export function conflicts(cfg) {
  const keys = {};
  const aliases = {};
  for (const c of commandList(cfg)) {
    if (c.key) (keys[c.key] = keys[c.key] || []).push(c.id);
    for (const a of c.aliases) (aliases[a] = aliases[a] || []).push(c.id);
  }
  const bad = { keys: {}, aliases: {}, reserved: [] };
  for (const [k, ids] of Object.entries(keys)) {
    if (ids.length > 1) bad.keys[k] = ids;
    if (RESERVED_KEYS.has(k.toLowerCase())) bad.reserved.push(k);
  }
  for (const [a, ids] of Object.entries(aliases)) if (ids.length > 1) bad.aliases[a] = ids;
  return bad;
}

export const labelOf = (id) => (TOOL_BY_ID[id] && TOOL_BY_ID[id].label) || (ACTIONS.find((a) => a.id === id) || {}).label || id;

// ------------------------------------------------------------------ acad.pgp import (CMD-D10)

/** AutoCAD command names with a DrawCAD equivalent that are not among the default aliases. */
const PGP_EXTRA = {
  DTEXT: "text", DIMCENTER: "cross", LEADER: "lead", BHATCH: "hatch", RECTANGLE: "rect",
  QSAVE: "export", SAVE: "export", PUBLISH: "export", SELECTALL: "selAll", ZOOMEXTENTS: "fit",
};

/**
 * Reads an acad.pgp file: one `abbreviation,*COMMAND` per line. `;` starts a comment; lines
 * without `*` (external commands) and malformed lines are skipped; the last definition of an
 * abbreviation wins, as in AutoCAD. Returns [{ alias, command }].
 */
export function parsePgp(text) {
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line) continue;
    const m = /^([^,\s]+)\s*,\s*\*\s*([^\s,]+)\s*$/.exec(line);
    if (!m) continue;
    const alias = m[1].toUpperCase();
    out.delete(alias); // keeps the order of the last definition
    out.set(alias, m[2].toUpperCase());
  }
  return [...out].map(([alias, command]) => ({ alias, command }));
}

/**
 * Merges acad.pgp aliases into a key configuration. Commands are matched by their AutoCAD names
 * (the default aliases of every command); an alias that belongs to another command moves (the pgp
 * file wins). Direct keys are not touched.
 * Returns { cfg, added: [{alias, id}], moved: [{alias, from, to}], unknown: [command], invalid: [alias] }.
 */
export function importPgp(cfg, entries) {
  const index = new Map();
  for (const t of TOOLS) for (const a of DEFAULT_ALIASES[t.id] || []) index.set(a.toUpperCase(), t.id);
  for (const a of ACTIONS) for (const x of a.aliases) index.set(x.toUpperCase(), a.id);
  for (const [name, id] of Object.entries(PGP_EXTRA)) if (!index.has(name)) index.set(name, id);
  const next = { mode: cfg.mode, keys: { ...cfg.keys }, aliases: {}, pickadd: !!cfg.pickadd };
  const cur = {};
  for (const c of commandList(cfg)) cur[c.id] = [...c.aliases];
  const added = [];
  const moved = [];
  const unknown = new Set();
  const invalid = [];
  for (const { alias, command } of entries) {
    const id = index.get(command.replace(/^[_.]+/, ""));
    if (!id) {
      unknown.add(command);
      continue;
    }
    if (!/^[A-Z0-9]{1,16}$/.test(alias)) {
      invalid.push(alias);
      continue;
    }
    if (cur[id].includes(alias)) continue;
    for (const [other, list] of Object.entries(cur)) {
      if (other !== id && list.includes(alias)) {
        cur[other] = list.filter((x) => x !== alias);
        moved.push({ alias, from: other, to: id });
      }
    }
    cur[id].push(alias);
    if (!moved.some((m) => m.alias === alias)) added.push({ alias, id });
  }
  const defaults = (id) => (DEFAULT_ALIASES[id] || (ACTIONS.find((a) => a.id === id) || {}).aliases || []).map((x) => x.toUpperCase());
  for (const [id, list] of Object.entries(cur)) if (list.join(",") !== defaults(id).join(",")) next.aliases[id] = list;
  return { cfg: next, added, moved, unknown: [...unknown].sort(), invalid };
}
