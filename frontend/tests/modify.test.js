import test from "node:test";
import assert from "node:assert/strict";
import { offsetShape, trimShape, extendShape, shapeDistance } from "../js/modify.js";
import { arcGeom } from "../js/shapes.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const nearPt = (p, q) => {
  near(p[0], q[0]);
  near(p[1], q[1]);
};
const seg = (x1, y1, x2, y2) => [x1, y1, x2, y2];
const line = (a, b) => ({ type: "shape", kind: "line", pts: [a, b] });

test("trim: the picked part goes up to the nearest cutting edges on either side", () => {
  const a = line([0, 0], [100, 0]);
  const edges = { segs: [seg(30, -10, 30, 10), seg(70, -10, 70, 10)], arcs: [] };
  const mid = trimShape(a, [50, 1], edges);
  assert.equal(mid.pieces.length, 2);
  nearPt(mid.pieces[0].pts[1], [30, 0]);
  nearPt(mid.pieces[1].pts[0], [70, 0]);
  assert.equal(mid.pieces[0].kind, "line");
  const end = trimShape(a, [90, 0], edges);
  assert.equal(end.pieces.length, 1);
  nearPt(end.pieces[0].pts[0], [0, 0]);
  nearPt(end.pieces[0].pts[1], [70, 0]);
  // nothing crosses it: the whole line goes (AutoCAD's Quick mode)
  assert.deepEqual(trimShape(a, [50, 0], { segs: [seg(200, -5, 200, 5)], arcs: [] }).pieces, []);
});

test("trim: a circle becomes the arc outside the two cuts, a rectangle an open polyline", () => {
  const c = { type: "shape", kind: "circle", pts: [[0, 0], [10, 0]] };
  const edges = { segs: [seg(0, -20, 0, 20)], arcs: [] };
  const r = trimShape(c, [10, 0], edges); // the right half goes
  assert.equal(r.pieces.length, 1);
  const arc = r.pieces[0];
  assert.equal(arc.kind, "arc");
  const g = arcGeom(arc);
  near(Math.abs(g.sw), Math.PI);
  const left = [g.c[0] + g.r * Math.cos(g.a0 + g.sw / 2), g.c[1] - g.r * Math.sin(g.a0 + g.sw / 2)];
  nearPt(left, [-10, 0]);
  assert.equal(trimShape(c, [10, 0], { segs: [seg(0, 0, 0, -20)], arcs: [] }).err, "one");

  const rect = { type: "shape", kind: "rect", pts: [[0, 0], [40, 20]] };
  const t = trimShape(rect, [20, 0], { segs: [seg(10, -5, 10, 25), seg(30, -5, 30, 25)], arcs: [] });
  assert.equal(t.pieces.length, 1);
  assert.equal(t.pieces[0].kind, "poly");
  assert.equal(t.pieces[0].closed, false);
  nearPt(t.pieces[0].pts[0], [30, 0]);
  nearPt(t.pieces[0].pts[t.pieces[0].pts.length - 1], [10, 0]);
  assert.equal(t.pieces[0].pts.length, 6); // 30,0 → 40,0 → 40,20 → 0,20 → 0,0 → 10,0
});

test("trim: an arc edge cuts a line, a line cuts an arc", () => {
  const a = line([-20, 0], [20, 0]);
  const ring = { segs: [], arcs: [[0, 0, 10, 0, Math.PI * 2]] };
  const r = trimShape(a, [0, 0], ring);
  assert.equal(r.pieces.length, 2);
  nearPt(r.pieces[0].pts[1], [-10, 0]);
  nearPt(r.pieces[1].pts[0], [10, 0]);
  const arc = { type: "shape", kind: "arc", pts: [[0, 0], [10, 0], [-10, 0]], ccw: true }; // upper half (y down)
  const cut = trimShape(arc, [-7.07, -7.07], { segs: [seg(0, 0, 0, -20)], arcs: [] });
  assert.equal(cut.pieces.length, 1);
  const g = arcGeom(cut.pieces[0]);
  near(Math.abs(g.sw), Math.PI / 2);
});

test("extend: a line to the nearest boundary beyond the picked end; none → error", () => {
  const a = line([0, 0], [50, 0]);
  const edges = { segs: [seg(80, -10, 80, 10), seg(120, -10, 120, 10), seg(-30, -10, -30, 10)], arcs: [] };
  const r = extendShape(a, [45, 0], edges);
  nearPt(r.shape.pts[1], [80, 0]);
  nearPt(r.shape.pts[0], [0, 0]);
  const s = extendShape(a, [5, 0], edges);
  nearPt(s.shape.pts[0], [-30, 0]);
  assert.equal(extendShape(a, [45, 0], { segs: [seg(80, 5, 80, 10)], arcs: [] }).err, "none");
  assert.equal(extendShape({ type: "shape", kind: "rect", pts: [[0, 0], [1, 1]] }, [0, 0], edges).err, "kind");
  // to a circle
  const c = extendShape(a, [45, 0], { segs: [], arcs: [[100, 0, 10, 0, Math.PI * 2]] });
  nearPt(c.shape.pts[1], [90, 0]);
});

test("extend: the end of an open polyline and an arc", () => {
  const p = { type: "shape", kind: "poly", pts: [[0, 0], [10, 0], [10, 10]], closed: false };
  const r = extendShape(p, [10, 9], { segs: [seg(-5, 30, 25, 30)], arcs: [] });
  assert.equal(r.shape.pts.length, 3);
  nearPt(r.shape.pts[2], [10, 30]);
  const arc = { type: "shape", kind: "arc", pts: [[0, 0], [10, 0], [0, -10]], ccw: true }; // quarter, up
  const e = extendShape(arc, [0, -10], { segs: [seg(-20, 0, -5, 0)], arcs: [] });
  const g = arcGeom({ ...arc, ...e.shape });
  near(Math.abs(g.sw), Math.PI);
  assert.equal(extendShape({ type: "shape", kind: "poly", pts: [[0, 0], [10, 0], [10, 10]], closed: true }, [0, 0], { segs: [], arcs: [] }).err, "closed");
});

test("offset: line, circle, arc, rectangle and polyline toward the picked side", () => {
  const l = offsetShape(line([0, 0], [10, 0]), 2, [5, 7]);
  nearPt(l.shape.pts[0], [0, 2]);
  nearPt(l.shape.pts[1], [10, 2]);
  const thr = offsetShape(line([0, 0], [10, 0]), null, [3, -4]);
  nearPt(thr.shape.pts[0], [0, -4]);
  assert.equal(offsetShape(line([0, 0], [10, 0]), 2, [5, 0]).err, "side");

  const c = { type: "shape", kind: "circle", pts: [[0, 0], [10, 0]] };
  nearPt(offsetShape(c, 3, [20, 0]).shape.pts[1], [13, 0]);
  nearPt(offsetShape(c, 3, [1, 0]).shape.pts[1], [7, 0]);
  assert.equal(offsetShape(c, 12, [1, 0]).err, "big");
  const arc = { type: "shape", kind: "arc", pts: [[0, 0], [10, 0], [0, -10]], ccw: true };
  const ao = offsetShape(arc, 5, [0, -30]).shape;
  nearPt(ao.pts[1], [15, 0]);
  nearPt(ao.pts[2], [0, -15]);

  const rect = { type: "shape", kind: "rect", pts: [[0, 0], [40, 20]] };
  assert.deepEqual(offsetShape(rect, 2, [50, 10]).shape.pts, [[-2, -2], [42, 22]]);
  assert.deepEqual(offsetShape(rect, 2, [20, 10]).shape.pts, [[2, 2], [38, 18]]);
  assert.equal(offsetShape(rect, 10, [20, 10]).err, "big");

  const sq = { type: "shape", kind: "poly", pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true };
  const out = offsetShape(sq, 1, [5, -3]).shape.pts;
  assert.equal(out.length, 4);
  for (const [p, q] of [[out[0], [-1, -1]], [out[1], [11, -1]], [out[2], [11, 11]], [out[3], [-1, 11]]]) nearPt(p, q);
  assert.equal(offsetShape(sq, 6, [5, 5]).err, "big");
  const open = { type: "shape", kind: "poly", pts: [[0, 0], [10, 0], [10, 10]], closed: false };
  const oo = offsetShape(open, 1, [5, 3]).shape.pts; // inside the corner
  nearPt(oo[0], [0, 1]);
  nearPt(oo[1], [9, 1]);
  nearPt(oo[2], [9, 10]);
});

test("offset through: the distance to the shape", () => {
  near(shapeDistance(line([0, 0], [10, 0]), [50, 4]), 4);
  near(shapeDistance({ kind: "circle", pts: [[0, 0], [10, 0]] }, [0, 15]), 5);
  near(shapeDistance({ kind: "rect", pts: [[0, 0], [10, 10]] }, [5, 12]), 2);
});
