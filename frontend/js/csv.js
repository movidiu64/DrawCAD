// The tables on the drawing (revision table, parts list, hole table) as CSV, for Excel or an ERP.

import { REVTAB_COLS, BOM_COLS, HOLE_COLS } from "./annots.js";

const COLS = { revtab: REVTAB_COLS, bom: BOM_COLS, holes: HOLE_COLS };
const QUOTE = String.fromCharCode(34);

/** Can annotation a be saved as CSV? */
export const hasCsv = (a) => !!(a && COLS[a.type]);

/**
 * CSV of a table annotation: the column titles in the drawing language, the rows in their order
 * (item 1 / revision 1 first, whatever the order on the sheet). With a decimal comma the fields are
 * separated by ";" (what Excel expects in Romanian, German… settings), otherwise by ",". UTF-8 with a
 * byte-order mark, so Excel reads the diacritics; CRLF line ends.
 */
export function tableCsv(a, S = {}) {
  const cols = COLS[a.type];
  if (!cols) return "";
  const sep = (S.sep || ",") === "," ? ";" : ",";
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    // Excel runs a cell that starts with = + - @ as a formula (rows can come from a PDF someone else
    // exported): such text gets a leading apostrophe; plain numbers (-0,02, +5) stay numbers
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(?:[.,]\d+)?$/.test(s)) s = `'${s}`;
    const quote = s.includes(sep) || s.includes(QUOTE) || /[\r\n]/.test(s) || s.trim() !== s;
    return quote ? QUOTE + s.split(QUOTE).join(QUOTE + QUOTE) + QUOTE : s;
  };
  const head = cols.map((c) => (S.dlang === "en" && c.en ? c.en : c.title));
  const lines = [head, ...(a.rows || []).map((r) => cols.map((c) => r[c.key]))].map((row) => row.map(cell).join(sep));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** File name: the document's name, the table's kind (in the drawing's language), `.csv`. */
export function csvName(docName, a, dlang = "ro") {
  const base = String(docName || "desen").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");
  const kind = (dlang === "en" ? { revtab: "revisions", bom: "parts", holes: "holes" } : { revtab: "revizii", bom: "componente", holes: "gauri" })[a.type] || (dlang === "en" ? "table" : "tabel");
  return `${base}_${kind}.csv`;
}
