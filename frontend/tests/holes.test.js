import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, K, holeTable, moveAnnot } from "../js/annots.js";
import { applyPageOp } from "../js/pages.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;
const mm = (x, y) => [x * K, y * K];
const circ = (x, y, d, sweep = Math.PI * 2) => [x * K, y * K, (d / 2) * K, 0, sweep];

// base at the bottom-left corner (20, 100); y on the page grows downwards
const ordX = { type: "ord", axis: "x", base: mm(20, 100), pts: [mm(30, 90), mm(50, 90), mm(50, 70), mm(80, 100)], row: 110 * K };
const ordY = { type: "ord", axis: "y", base: mm(20, 100), pts: [mm(30, 90), mm(50, 90), mm(50, 70)], row: 10 * K };
const arcs = [circ(30, 90, 6.6), circ(50, 90, 6.6), circ(50, 70, 11), circ(50, 70, 18, Math.PI / 2)];

test("hole table: X and Y from the base, diameter from the smallest full circle", () => {
  const t = holeTable([ordX, ordY], arcs, S);
  // (80, 100) has no circle: an edge, not a hole; the base is not a hole either
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows.map((r) => [r.x, r.y, r.d]), [["10", "10", "6,6"], ["30", "10", "6,6"], ["30", "30", "11"]]);
});

test("hole table: same diameter, same letter", () => {
  const t = holeTable([ordX, ordY], arcs, S);
  assert.deepEqual(t.rows.map((r) => r.tag), ["A1", "A2", "B1"]);
  assert.deepEqual(t.pts[2], mm(50, 70));
});

test("hole table: values typed over the ordinates are used, with the sign of the side", () => {
  const ox = { ...ordX, base: mm(60, 100), ov: { 1: 29.95 } }; // pts[0] = (30, 90): left of the base
  const oy = { ...ordY, base: mm(60, 100), ov: { 1: 10.02 } };
  const t = holeTable([ox, oy], arcs, S);
  const r = t.rows.find((q) => q.d === "6,6" && q.x.startsWith("-29"));
  assert.ok(r, JSON.stringify(t.rows));
  assert.equal(r.x, "-29,95");
  assert.equal(r.y, "10,02");
});

test("hole table: on a scan (no circles) every point but the base is listed, numbered", () => {
  const t = holeTable([ordX], [], S);
  assert.deepEqual(t.rows.map((r) => r.tag), ["1", "2", "3", "4"]);
  assert.ok(t.rows.every((r) => r.d === ""));
});

test("hole table: a diameter typed by hand survives an update from the ordinates", () => {
  const t = holeTable([ordX, ordY], arcs, S);
  t.rows[2].d = "M10";
  const u = holeTable([ordX, ordY], arcs, S, t);
  assert.equal(u.rows.find((r) => r.d === "M10").tag, "B1");
  assert.equal(holeTable([], arcs, S), null);
});

test("hole table: table with letters on the holes; moving moves only the table", () => {
  const t = holeTable([ordX, ordY], arcs, S);
  const a = { type: "holes", p: mm(200, 150), pts: t.pts, rows: t.rows, page: 0 };
  const b = build(a, S, measure);
  const txt = b.prims.filter((p) => p.t === "T").map((p) => p.txt);
  for (const s of ["Gaură", "X", "Y", "Ø", "A1", "B1", "6,6", "30"]) assert.ok(txt.includes(s), s);
  // B1 is up and to the right of its hole, outside the Ø11 circle
  const b1 = b.prims.filter((p) => p.t === "T" && p.txt === "B1").find((p) => p.p[1] < 100 * K);
  assert.ok(b1.p[0] > 50 * K + 5.5 * K * 0.7 && b1.p[1] < 70 * K, JSON.stringify(b1.p));
  assert.equal(build({ ...a }, { ...S, dlang: "en" }, measure).prims.filter((p) => p.t === "T" && p.txt === "Hole").length, 1);
  moveAnnot(a, 10, 5);
  assert.deepEqual(a.p, [200 * K + 10, 150 * K + 5]);
  assert.deepEqual(a.pts[0], mm(30, 90));
});

test("hole table: rotating the page carries the letters with the holes, the table stays upright", () => {
  const t = holeTable([ordX, ordY], arcs, S);
  const a = { type: "holes", p: mm(200, 150), pts: t.pts, rows: t.rows, page: 0 };
  const [r] = applyPageOp([a], { op: "rotate", pages: [0], delta: 90, sizes: [[297 * K, 210 * K]] }, S, measure);
  // (x, y) → (H − y, x)
  assert.deepEqual(r.pts[0].map((v) => Math.round(v / K)), [120, 30]);
  assert.deepEqual(r.rows, a.rows);
  const b = build(r, S, measure);
  const frame = b.prims[0];
  assert.equal(frame.p[1], frame.p[3], "the table frame is still horizontal");
});
