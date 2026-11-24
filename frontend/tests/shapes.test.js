import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, exportPrims } from "../js/annots.js";
import { fitDash, hatchLines, arcGeom, resizeShape, K } from "../js/shapes.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("ISO 128-20 pattern at 1×: elements in multiples of d", () => {
  // 0.5 mm dashed line, a length that fits exactly: 12d dash, 3d gap
  const d = 0.5 * K;
  const L = 3 * (15 * d) + 12 * d;
  const dp = fitDash("dash", 0.5, 1, L, false);
  assert.ok(near(dp[0], 12 * d) && near(dp[1], 3 * d));
});

test("open line: starts and ends with a full dash", () => {
  for (const L of [37, 80, 123.4, 300]) {
    const dp = fitDash("chain", 0.25, 1, L * K, false);
    const P = dp.reduce((s, v) => s + v, 0);
    const n = (L * K - dp[0]) / P;
    assert.ok(near(n, Math.round(n), 1e-6), `L=${L}: ${n} perioade`);
  }
});

test("closed outline: a whole number of periods, no seam", () => {
  const L = 2 * Math.PI * 20 * K;
  const dp = fitDash("dash", 0.25, 1, L, true);
  const P = dp.reduce((s, v) => s + v, 0);
  assert.ok(near(L / P, Math.round(L / P), 1e-6));
});

test("center marks: the middle dash is centered on the center", () => {
  const b = build({ type: "shape", kind: "cross", pts: [[100, 100], [100 + 10 * K, 100]], ltype: "chain", w: 0.25, ext: 3 }, S, measure);
  const lines = b.prims.filter((p) => p.t === "L");
  assert.equal(lines.length, 2);
  const L = Math.hypot(lines[0].p[2] - lines[0].p[0], lines[0].p[3] - lines[0].p[1]);
  assert.ok(near(L, 2 * 13 * K, 1e-6));
  const dp = lines[0].dp;
  const P = dp.reduce((s, v) => s + v, 0);
  const n = Math.round((L - dp[0]) / P);
  assert.equal(n % 2, 0);
  // the center: after n/2 periods + half a dash
  assert.ok(near(n / 2 * P + dp[0] / 2, L / 2, 1e-6));
});

test("line too short for a chain line: becomes continuous", () => {
  assert.equal(fitDash("chain", 0.25, 1, 2 * K, false, true), null);
  assert.equal(fitDash("cont", 0.25, 1, 100, false), null);
});

test("hatch: segments only inside, at the requested spacing", () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const h = hatchLines(sq, 0, 10);
  assert.equal(h.length, 10); // y = 0…90; at y = 100 the line would coincide with the edge
  for (const [P, Q] of h) {
    assert.ok(near(P[1], Q[1]));
    assert.ok(Math.min(P[0], Q[0]) >= -1e-9 && Math.max(P[0], Q[0]) <= 100 + 1e-9);
  }
  // concave polygon (L): a line crossing both arms produces two segments
  const L = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100]];
  const v = hatchLines(L, 90, 10).filter(([P]) => near(P[0], 20) || near(P[0], 60));
  assert.ok(v.length >= 2);
  for (const [P, Q] of hatchLines(L, 45, 5)) {
    const m = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
    assert.ok(!(m[0] > 30 + 1e-6 && m[1] > 30 + 1e-6), "segment outside the L");
  }
});

test("arc: counter-clockwise on screen and the complementary arc", () => {
  const a = { kind: "arc", pts: [[0, 0], [10, 0], [0, -10]], ccw: true };
  assert.ok(near(arcGeom(a).sw, Math.PI / 2));
  assert.ok(near(arcGeom({ ...a, ccw: false }).sw, -1.5 * Math.PI));
});

test("dimensions typed in the panel: circle Ø, line length, rectangle", () => {
  const c = { kind: "circle", pts: [[0, 0], [5, 0]] };
  resizeShape(c, "r", 10);
  assert.ok(near(c.pts[1][0], 10 * K));
  const l = { kind: "line", pts: [[0, 0], [3, 4]] };
  resizeShape(l, "len", 50);
  assert.ok(near(Math.hypot(...l.pts[1]), 50 * K));
  assert.ok(near(l.pts[1][1] / l.pts[1][0], 4 / 3));
  const r = { kind: "rect", pts: [[0, 0], [-5, -5]] };
  resizeShape(r, "w", 20);
  assert.ok(near(r.pts[1][0], -20 * K));
});

test("the export keeps the line pattern, and editor helpers do not reach the PDF", () => {
  const b = build({ type: "shape", kind: "cross", pts: [[0, 0], [30, 0]], ltype: "chain", w: 0.25 }, S, measure);
  const ex = exportPrims(b.prims);
  assert.equal(ex.length, 2);
  assert.ok(ex.every((p) => Array.isArray(p.dp) && p.dp.length === 4));
});

test("grip menu: add and remove polyline vertices", async () => {
  const { addVertex, removeVertex, hasVertices } = await import("../js/shapes.js");
  const p = { type: "shape", kind: "poly", pts: [[0, 0], [10, 0], [10, 10]] };
  assert.ok(hasVertices(p));
  assert.equal(addVertex(p, 0), 1);
  assert.deepEqual(p.pts[1], [5, 0]);
  // after the last vertex of an open polyline: half a segment further on
  assert.equal(addVertex(p, 3), 4);
  assert.deepEqual(p.pts[4], [10, 15]);
  assert.ok(removeVertex(p, 4));
  assert.ok(removeVertex(p, 1));
  assert.ok(removeVertex(p, 2));
  assert.equal(removeVertex(p, 0), false); // an open polyline keeps 2 vertices
  const h = { type: "shape", kind: "hatch", pts: [[0, 0], [10, 0], [10, 10]] };
  assert.equal(addVertex(h, 2), 3); // closed: between the last and the first
  assert.deepEqual(h.pts[3], [5, 5]);
  assert.ok(removeVertex(h, 3));
  assert.equal(removeVertex(h, 0), false); // a hatch keeps 3
  assert.equal(hasVertices({ type: "shape", kind: "line", pts: [[0, 0], [1, 1]] }), false);
});
