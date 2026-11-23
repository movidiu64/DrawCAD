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
  strike: ["STR", "TAIE"],
  white: ["WO", "WIPEOUT"],
  ink: ["INK"],
  redact: ["E", "ERASE", "STERGE"],
  calib: ["CALIB", "SCALA", "K"],
};

/** Commands that are not tools. */
export const ACTIONS = [
  { id: "undo", label: "Anulează acțiunea", aliases: ["U", "UNDO"] },
  { id: "redo", label: "Refă", aliases: ["REDO", "MREDO"] },
  { id: "fit", label: "Zoom pe toată pagina", aliases: ["Z", "ZE", "ZOOM"] },
  { id: "zoomSel", label: "Zoom pe selecție", aliases: ["ZS"] },
  { id: "find", label: "Caută text / OCR", aliases: ["FIND", "TEXTFIND", "OCR"] },
  { id: "export", label: "Exportă", aliases: ["EXP", "EXPORT", "PLOT", "SAVEAS"] },
  { id: "open", label: "Deschide desen", aliases: ["OPEN"] },
  { id: "close", label: "Închide documentul", aliases: ["CLOSE"] },
  { id: "settings", label: "Setări", aliases: ["OP", "OPTIONS"] },
  { id: "keys", label: "Taste și comenzi", aliases: ["ALIASEDIT", "KEYS", "TASTE"] },
  { id: "osnap", label: "Snap pornit / oprit", aliases: ["OS", "OSNAP"] },
  { id: "ortho", label: "Ortho pornit / oprit", aliases: ["OR", "ORTHO"] },
  { id: "polar", label: "Polar pornit / oprit", aliases: ["POLAR"] },
  { id: "selAll", label: "Selectează tot", aliases: ["ALL"] },
  { id: "nextPage", label: "Pagina următoare", aliases: ["PN"] },
  { id: "prevPage", label: "Pagina anterioară", aliases: ["PP"] },
  { id: "rotR", label: "Rotește pagina la dreapta", aliases: ["ROTR"] },
  { id: "rotL", label: "Rotește pagina la stânga", aliases: ["ROTL"] },
  { id: "pages", label: "Pagini (rotire, ordine, ștergere)", aliases: ["PAGES", "PAGINI"] },
];

// keys with a fixed role, which cannot be assigned to tools
export const RESERVED_KEYS = new Set(["f", "+", "-", "=", " "]);

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

export function defaultKeyConfig() {
  return { mode: "direct", keys: {}, aliases: {} };
}

export function keyConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) || "null");
    if (c && typeof c === "object") {
      return {
        mode: c.mode === "autocad" ? "autocad" : "direct",
        keys: c.keys && typeof c.keys === "object" ? c.keys : {},
        aliases: c.aliases && typeof c.aliases === "object" ? c.aliases : {},
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
    out.push({ id: a.id, kind: "action", label: a.label, group: "Comenzi", key: "", aliases: aliases.map((x) => x.toUpperCase()) });
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
  const q = String(input || "").trim().toUpperCase();
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
