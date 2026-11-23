import test from "node:test";
import assert from "node:assert/strict";
import { K } from "../js/annots.js";
import { TOOLS, TOOL_BY_ID, promptFor, resolveOption } from "../js/tools.js";

const app = (extra = {}) => ({ clicks: [], placing: false, cmdState: {}, chain: null, defaultTol: () => ({ mode: "none" }), S: () => ({ h: 3.5 * K }), ...extra });
const mm = (x, y) => [x * K, y * K];

test("prompts: option keys are unique per tool and every tool has a prompt", () => {
  for (const t of TOOLS) {
    if (t.kind === "select" || t.kind === "pan") continue;
    const all = promptFor(t, app({ clicks: [mm(0, 0), mm(1, 1), mm(2, 2)], chain: { ids: [1, 2] } }));
    assert.ok(all.text, t.id);
    const keys = all.opts.map((o) => o.key);
    assert.equal(new Set(keys).size, keys.length, `${t.id}: ${keys}`);
  }
});

test("options: the key letter, the English keyword and the Romanian label mean the same option", () => {
  const { opts } = promptFor(TOOL_BY_ID.dimLin, app({ clicks: [mm(0, 0), mm(10, 0)] }));
  for (const q of ["h", "H", "horizontal", "Orizontal", " orizontal "]) assert.equal(resolveOption(opts, q).key, "H", q);
  assert.equal(resolveOption(opts, "L"), null, "a command alias is not an option");
  assert.equal(resolveOption(promptFor(TOOL_BY_ID.line, app({ clicks: [mm(0, 0)] })).opts, "u").key, "U");
});

test("options appear only when they can act", () => {
  const keys = (id, a) => promptFor(TOOL_BY_ID[id], app(a)).opts.map((o) => o.key);
  assert.deepEqual(keys("line", {}), [], "nothing to undo or close yet");
  assert.deepEqual(keys("line", { clicks: [mm(0, 0)], chain: { ids: [1] } }), ["U"]);
  assert.deepEqual(keys("line", { clicks: [mm(0, 0)], chain: { ids: [1, 2] } }), ["U", "C"]);
  assert.deepEqual(keys("circle", {}), []);
  assert.deepEqual(keys("circle", { clicks: [mm(0, 0)] }), ["D"]);
  assert.deepEqual(keys("poly", { clicks: [mm(0, 0), mm(1, 0), mm(1, 1)] }), ["U", "C"]);
});

test("DLI Horizontal / Vertical override the cursor; Text sets the value or a text", () => {
  const t = TOOL_BY_ID.dimLin;
  const pts = [mm(0, 0), mm(40, 30), mm(20, 60)]; // the cursor below would make it horizontal
  assert.equal(t.make(pts, app()).orient, "h");
  assert.equal(t.make(pts, app({ cmdState: { orient: "v" } })).orient, "v");
  assert.equal(t.make(pts, app({ cmdState: { text: "25,5" } })).nominal, 25.5);
  assert.equal(t.make(pts, app({ cmdState: { text: "%%c25 H7" } })).textOverride, "%%c25 H7");
  assert.equal(t.make(pts, app({ cmdState: { text: "" } })).nominal, null, "empty = measured");
});

test("DOR X / Y force the axis whatever the row position", () => {
  const t = TOOL_BY_ID.dimOrd;
  const pts = [mm(10, 10), mm(30, 10), mm(50, 20)];
  const below = mm(30, 40); // below the points: X values by default
  assert.equal(t.make(pts, app(), false, below).axis, "x");
  const a = t.make(pts, app({ cmdState: { axis: "y" } }), false, below);
  assert.equal(a.axis, "y");
  assert.equal(a.row, below[0]);
});
