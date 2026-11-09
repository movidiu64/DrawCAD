import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, K, spreadSlots, moveAnnot, setHandle } from "../js/annots.js";
import { applyPageOp } from "../js/pages.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;
const mm = (x, y) => [x * K, y * K];
const texts = (b) => b.prims.filter((p) => p.t === "T");

test("ordinate X: absolute values from the base, vertical text beyond the row", () => {
  const a = { type: "ord", axis: "x", base: mm(20, 100), pts: [mm(60, 80), mm(90, 70), mm(10, 90)], row: 110 * K };
  const b = build(a, S, measure);
  assert.deepEqual(b.values, [10, 0, 40, 70]);
  const t = texts(b);
  assert.deepEqual(t.map((p) => p.txt), ["10", "0", "40", "70"]);
  assert.ok(t.every((p) => p.a === 90 && p.p[1] > 110 * K), "vertical text below the row");
  // every extension line ends on the row
  const ends = b.prims.filter((p) => p.t === "L").map((p) => p.p[3]);
  assert.equal(ends.filter((y) => Math.abs(y - 110 * K) < 1e-6).length, 4);
});

test("ordinate Y: Y up, horizontal text left of the row", () => {
  const a = { type: "ord", axis: "y", base: mm(20, 100), pts: [mm(40, 70), mm(50, 40)], row: 5 * K };
  const b = build(a, S, measure);
  assert.deepEqual([...b.values].sort((x, y) => x - y), [0, 30, 60]);
  assert.ok(texts(b).every((p) => p.a === 0 && p.p[0] + p.tw < 5 * K), "text ends before the row");
});

test("ordinate: same value kept once, the point closest to the row", () => {
  const a = { type: "ord", axis: "x", base: mm(0, 0), pts: [mm(30, 10), mm(30, 50)], row: 60 * K };
  const b = build(a, S, measure);
  assert.deepEqual(b.values, [0, 30]);
  const line30 = b.prims.find((p) => p.t === "L" && Math.abs(p.p[0] - 30 * K) < 1e-6);
  assert.ok(line30.p[1] > 49 * K, "starts at the point at y = 50");
});

test("ordinate: values too close spread apart with a jogged line", () => {
  const a = { type: "ord", axis: "x", base: mm(0, 0), pts: [mm(1, 0), mm(2, 0)], row: 30 * K };
  const b = build(a, S, measure);
  const xs = texts(b).map((p) => p.p[0]).sort((u, v) => u - v);
  assert.ok(xs[1] - xs[0] >= S.h * 1.6 && xs[2] - xs[1] >= S.h * 1.6, "texts do not overlap");
  assert.ok(b.prims.filter((p) => p.t === "L").length > 3, "jogged lines have several segments");
  const s = spreadSlots([0, 1, 2], 10);
  assert.deepEqual(s, [-9, 1, 11]);
});

test("ordinate: move, row handle and page rotation", () => {
  const a = { type: "ord", axis: "x", base: mm(10, 10), pts: [mm(30, 10)], row: 40 * K, page: 0 };
  moveAnnot(a, 5, 7);
  assert.equal(a.row, 40 * K + 7);
  setHandle(a, "row", [0, 50 * K]);
  assert.equal(Math.round(a.row / K), 50);
  const v0 = build(a, S, measure).values;
  const [r] = applyPageOp([a], { op: "rotate", pages: [0], delta: 90, sizes: [[297 * K, 210 * K]] });
  assert.equal(r.axis, "y");
  assert.deepEqual(build(r, S, measure).values, v0);
});

test("ordinate: typed values replace the measured ones, rounding for the rest", () => {
  const a = { type: "ord", axis: "x", base: mm(0, 0), pts: [mm(10.04, 0), mm(25.3, 0), mm(40.7, 0)], row: 30 * K };
  assert.deepEqual(build(a, S, measure).values, [0, 10.04, 25.3, 40.7]);
  a.round = 1;
  assert.deepEqual(build(a, S, measure).values, [0, 10, 25, 41]);
  a.ov = [null, null, 25.5, 40];
  const b = build(a, S, measure);
  assert.deepEqual(b.values, [0, 10, 25.5, 40]);
  assert.deepEqual(texts(b).map((p) => p.txt), ["0", "10", "25,5", "40"]);
  assert.deepEqual(b.items.map((it) => it.idx), [0, 1, 2, 3]);
  assert.equal(b.items[3].auto, 41);
});
