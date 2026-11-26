// Own symbol library (AutoCAD's BLOCK / INSERT): a group of annotations saved with a base point and
// placed with one click on any drawing. Symbols live in the browser (localStorage) and move between
// computers as JSON files. Coordinates in visual PDF points (y down), relative to the base point.
import { moveAnnot } from "./annots.js";

export const SYMBOL_STORE = "drawcad.symbols";
export const SYMBOL_FILE_KIND = "drawcad-symbols";
export const MAX_SYMBOLS = 200;
export const MAX_ITEMS = 500;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_CHARS = 420 * 1024; // a data URL of about 300 kB

/**
 * Annotation types a symbol can hold. Left out: what belongs to the original under it (removal, cover,
 * strike-through), the page origin, review comments, the page watermark and the hole table (its letters
 * belong to holes of this drawing).
 */
export const SYMBOL_TYPES = new Set([
  "dim", "rad", "ang", "ord", "lead", "text", "rough", "gdt", "datum", "note", "revtab", "bom", "shape",
  "section", "detail", "balloon", "image", "tblock", "cloud", "mark", "stamp", "qr", "ink",
]);

const clone = (x) => JSON.parse(JSON.stringify(x));

/** The annotations as symbol items: no id or page, moved so the base point is 0,0. */
export function symbolItems(annots, base) {
  return annots.filter((a) => SYMBOL_TYPES.has(a.type)).map((a) => {
    const c = clone(a);
    delete c.id;
    delete c.page;
    moveAnnot(c, -base[0], -base[1]);
    return c;
  });
}

/** Copies of the items with the base point at `at` (ids are given by the caller). */
export function placeItems(items, at) {
  return items.map((it) => {
    const c = clone(it);
    moveAnnot(c, at[0], at[1]);
    return c;
  });
}

const okImage = (s) => typeof s === "string" && s.length <= MAX_IMAGE_CHARS && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);

/** One item from a file or storage, or null: known type, no ids or server images, images as data. */
export function cleanItem(x) {
  if (!x || typeof x !== "object" || Array.isArray(x) || !SYMBOL_TYPES.has(x.type)) return null;
  const c = clone(x);
  delete c.id;
  delete c.page;
  if (c.type === "image") {
    delete c.img;
    if (!okImage(c.data) || !Array.isArray(c.r) || c.r.length !== 4 || !c.r.every(Number.isFinite)) return null;
  } else delete c.data;
  if (c.type === "tblock" && c.tpl && c.tpl.logo) {
    delete c.tpl.logo.img;
    if (!okImage(c.tpl.logo.data)) delete c.tpl.logo;
  }
  return c;
}

/** A symbol from a file or storage, or null. */
export function cleanSymbol(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.items)) return null;
  const items = s.items.slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean);
  if (!items.length) return null;
  const name = String(s.name || "").replace(/\s+/g, " ").trim().slice(0, 80) || "Simbol";
  return { v: 1, id: typeof s.id === "string" && /^[a-z0-9]{4,24}$/.test(s.id) ? s.id : symbolId(), name, items };
}

/** The symbols of a file: a library export ({ kind, symbols }) or one symbol. */
export function symbolsFromFile(text) {
  if (text.length > MAX_IMPORT_BYTES) throw new Error("fișier prea mare");
  const j = JSON.parse(text);
  const list = j && j.kind === SYMBOL_FILE_KIND && Array.isArray(j.symbols) ? j.symbols : [j];
  const out = list.slice(0, MAX_SYMBOLS).map(cleanSymbol).filter(Boolean);
  if (!out.length) throw new Error("nu e un simbol DrawCAD");
  return out;
}

/** The library file (all symbols or some). */
export function symbolsFile(list) {
  return JSON.stringify({ kind: SYMBOL_FILE_KIND, v: 1, symbols: list.map((s) => ({ name: s.name, items: s.items })) }, null, 1);
}

/** Adds a symbol; one with the same name is replaced (as a redefined block). Returns { list, replaced }. */
export function addSymbol(list, sym) {
  const i = list.findIndex((s) => s.name.toLowerCase() === sym.name.toLowerCase());
  if (i < 0) return { list: [...list, sym].slice(-MAX_SYMBOLS), replaced: false };
  const out = [...list];
  out[i] = { ...sym, id: list[i].id };
  return { list: out, replaced: true };
}

export function symbolId() {
  return Math.random().toString(36).slice(2, 12).padEnd(6, "0");
}

/** How the symbol is described in the library: counts by kind. */
export function symbolSummary(sym) {
  const n = sym.items.length;
  const img = sym.items.filter((it) => it.type === "image").length;
  return { n, img };
}
