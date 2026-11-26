import test from "node:test";
import assert from "node:assert/strict";
import { symbolItems, placeItems, cleanSymbol, symbolsFromFile, symbolsFile, addSymbol, SYMBOL_TYPES } from "../js/blocks.js";

const annots = [
  { id: "a1", page: 0, type: "text", p: [110, 220], text: "NOTA" },
  { id: "a2", page: 0, type: "shape", kind: "line", pts: [[100, 200], [140, 200]], w: 0.5 },
  { id: "a3", page: 0, type: "redact", r: [0, 0, 10, 10] },
  { id: "a4", page: 0, type: "rough", p: [120, 210], v: [125, 205], ra: "1,6" },
];

test("a symbol keeps the allowed annotations, relative to the base point, without ids or pages", () => {
  const items = symbolItems(annots, [100, 200]);
  assert.equal(items.length, 3);
  assert.ok(!items.some((it) => "id" in it || "page" in it));
  assert.deepEqual(items[0].p, [10, 20]);
  assert.deepEqual(items[1].pts, [[0, 0], [40, 0]]);
  assert.deepEqual(items[2].v, [25, 5]);
  assert.deepEqual(annots[1].pts, [[100, 200], [140, 200]], "the originals do not move");
  const placed = placeItems(items, [300, 50]);
  assert.deepEqual(placed[1].pts, [[300, 50], [340, 50]]);
  assert.deepEqual(items[1].pts, [[0, 0], [40, 0]], "placing copies");
  for (const t of ["redact", "white", "strike", "ucs", "holes", "comment", "watermark"]) assert.ok(!SYMBOL_TYPES.has(t), t);
});

test("cleaning: unknown types, server images and bad image data go; a name is always there", () => {
  const s = cleanSymbol({
    name: "  Notă   standard ",
    items: [
      { type: "text", p: [0, 0], text: "x", id: "q", page: 3 },
      { type: "script", x: 1 },
      { type: "image", r: [0, 0, 10, 10], img: "abc" },
      { type: "image", r: [0, 0, 10, 10], data: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "image", r: [0, 0, 10, 10], data: "data:text/html;base64,PHNjcmlwdD4=" },
      { type: "tblock", p: [0, 0], tpl: { logo: { img: "srv", r: [0, 0, 1, 1] }, lines: [], texts: [] } },
      "text",
    ],
  });
  assert.equal(s.name, "Notă standard");
  assert.deepEqual(s.items.map((it) => it.type), ["text", "image", "tblock"]);
  assert.ok(!("id" in s.items[0]) && !("page" in s.items[0]));
  assert.ok(!("img" in s.items[1]));
  assert.ok(!s.items[2].tpl.logo, "a logo without its content goes");
  assert.equal(cleanSymbol({ name: "gol", items: [{ type: "redact" }] }), null);
  assert.equal(cleanSymbol({ items: [{ type: "text", p: [0, 0], text: "a" }] }).name, "Simbol");
});

test("file round trip, one symbol or a library; same name replaces", () => {
  const a = cleanSymbol({ name: "A", items: [{ type: "text", p: [0, 0], text: "a" }] });
  const b = cleanSymbol({ name: "B", items: [{ type: "text", p: [0, 0], text: "b" }] });
  const back = symbolsFromFile(symbolsFile([a, b]));
  assert.deepEqual(back.map((s) => s.name), ["A", "B"]);
  assert.deepEqual(back[0].items, a.items);
  assert.equal(symbolsFromFile(JSON.stringify({ name: "solo", items: a.items }))[0].name, "solo");
  assert.throws(() => symbolsFromFile(JSON.stringify({ hello: 1 })), /nu e un simbol/);
  assert.throws(() => symbolsFromFile("x".repeat(3 * 1024 * 1024)), /prea mare/);
  const r1 = addSymbol([a], b);
  assert.equal(r1.list.length, 2);
  assert.equal(r1.replaced, false);
  const a2 = cleanSymbol({ name: "a", items: b.items });
  const r2 = addSymbol(r1.list, a2);
  assert.equal(r2.replaced, true);
  assert.equal(r2.list.length, 2);
  assert.equal(r2.list[0].id, a.id, "the replaced symbol keeps its id");
  assert.deepEqual(r2.list[0].items, b.items);
});
