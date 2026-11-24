import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, K, dimSeries } from "../js/annots.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;
const mm = (x, y) => [x * K, y * K];
const len = (d) => build({ type: "dim", kind: "lin", ...d, tol: { mode: "none" } }, S, measure).measured;

test("chain: points sorted along X, one dimension per pair, all on the same line", () => {
  // clicked out of order, one point repeated
  const ds = dimSeries([mm(10, 50), mm(40, 60), mm(25, 50), mm(25, 55), mm(70, 50)], mm(30, 80), "chain", 8 * K);
  assert.equal(ds.length, 3);
  assert.ok(ds.every((d) => d.orient === "h" && d.p3[1] === 80 * K));
  assert.deepEqual(ds.map((d) => Math.round(len(d) * 100) / 100), [15, 15, 30]);
  // each dimension starts where the previous one ended
  assert.deepEqual(ds[1].p1, ds[0].p2);
});

test("chain: to the side of the points the dimensions are vertical", () => {
  const ds = dimSeries([mm(50, 10), mm(50, 30), mm(55, 45)], mm(80, 20), "chain", 8 * K);
  assert.ok(ds.every((d) => d.orient === "v"));
  assert.deepEqual(ds.map((d) => Math.round(len(d))), [20, 15]);
});

test("baseline: every dimension from the first point, shortest nearest, stepped outwards", () => {
  const step = 8 * K;
  const ds = dimSeries([mm(10, 50), mm(70, 50), mm(30, 50), mm(30, 40)], mm(40, 62), "base", step);
  assert.equal(ds.length, 2, "the same length twice is kept once");
  assert.deepEqual(ds.map((d) => Math.round(len(d))), [20, 60]);
  assert.ok(ds.every((d) => d.p1[0] === 10 * K));
  assert.deepEqual(ds.map((d) => Math.round(d.p3[1] / K)), [62, 70]);
  // above the part the steps go up
  const up = dimSeries([mm(10, 50), mm(30, 50), mm(70, 50)], mm(40, 30), "base", step);
  assert.deepEqual(up.map((d) => Math.round(d.p3[1] / K)), [30, 22]);
});

test("series: nothing to dimension", () => {
  assert.deepEqual(dimSeries([mm(10, 10)], mm(0, 0), "chain", 1), []);
  assert.deepEqual(dimSeries([mm(10, 10), mm(10, 30)], mm(10, 50), "chain", 1), []);
});

test("series: a forced direction wins over the cursor side (continuing an existing dimension)", () => {
  // the row is beside the points (would be vertical), forced horizontal
  const ds = dimSeries([mm(10, 50), mm(30, 50), mm(60, 50)], mm(80, 50), "chain", 8 * K, "h");
  assert.ok(ds.every((d) => d.orient === "h"));
  assert.equal(ds.length, 2);
});
