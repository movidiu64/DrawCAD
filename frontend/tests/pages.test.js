import test from "node:test";
import assert from "node:assert/strict";
import { rotatePoint, rotateAnnot, applyPageOp, translateAnnot, rotateAbout, scaleAbout, mirrorAbout } from "../js/pages.js";
import { build, derive } from "../js/annots.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;

test("rotating points: four quarter turns return to the start, corners land where they should", () => {
  const W = 842;
  const H = 595;
  assert.deepEqual(rotatePoint([0, 0], 90, W, H), [H, 0]); // top-left → top-right
  assert.deepEqual(rotatePoint([W, H], 90, W, H), [0, W]);
  let p = [100, 200];
  let w = W;
  let h = H;
  for (let i = 0; i < 4; i++) {
    p = rotatePoint(p, 90, w, h);
    [w, h] = [h, w];
  }
  assert.deepEqual(p, [100, 200]);
  assert.deepEqual(rotatePoint([100, 200], 180, W, H), [W - 100, H - 200]);
});

test("a horizontal linear dimension becomes vertical and measures the same distance", () => {
  const a = { id: "d", type: "dim", kind: "lin", orient: "h", p1: [100, 100], p2: [200, 100], p3: [150, 80], page: 0 };
  const before = build(a, S, measure).prims.filter((q) => q.t === "T").map((q) => q.txt).join("");
  rotateAnnot(a, 90, 842, 595);
  assert.equal(a.orient, "v");
  const after = build(a, S, measure).prims.filter((q) => q.t === "T").map((q) => q.txt).join("");
  assert.equal(after, before);
});

test("text rotates with the page, the hatch keeps its look", () => {
  const t = rotateAnnot({ type: "text", p: [10, 10], angle: 0 }, 90, 842, 595);
  assert.equal(t.angle, -90);
  const hz = rotateAnnot({ type: "shape", kind: "hatch", pts: [[0, 0], [10, 0], [10, 10]], angle: 45 }, 90, 842, 595);
  assert.equal(hz.angle, 135);
  const r = rotateAnnot({ type: "white", r: [10, 20, 50, 60] }, 90, 842, 595);
  assert.deepEqual(r.r, [535, 10, 575, 50]);
});

test("deleting and moving pages renumbers the annotations", () => {
  const ann = [{ id: "a", page: 0 }, { id: "b", page: 1 }, { id: "c", page: 2 }];
  assert.deepEqual(applyPageOp(ann, { op: "delete", pages: [1] }).map((a) => [a.id, a.page]), [["a", 0], ["c", 1]]);
  assert.deepEqual(applyPageOp(ann, { op: "move", page: 2, to: 0, count: 3 }).map((a) => [a.id, a.page]), [["a", 1], ["b", 2], ["c", 0]]);
  // the table stays horizontal and its center lands at the rotated position
  const tab = { id: "t", type: "revtab", page: 0, p: [800, 560], rows: [{ rev: "1", desc: "x", date: "", name: "" }] };
  const b0 = build(tab, S, measure).bbox;
  const [rt] = applyPageOp([tab], { op: "rotate", pages: [0], delta: 90, sizes: [[842, 595]] }, S, measure);
  const b1 = build(rt, S, measure).bbox;
  assert.ok(Math.abs((b1[2] - b1[0]) - (b0[2] - b0[0])) < 1e-6);
  const c0 = [(b0[0] + b0[2]) / 2, (b0[1] + b0[3]) / 2];
  const c1 = [(b1[0] + b1[2]) / 2, (b1[1] + b1[3]) / 2];
  assert.ok(Math.abs(c1[0] - (595 - c0[1])) < 1e-6 && Math.abs(c1[1] - c0[0]) < 1e-6);
});

test("diameters have filled arrows like the leader, even with oblique terminators for dimensions", () => {
  const S2 = derive({ arrow: "tick" });
  const dia = { type: "dim", kind: "lin", orient: "v", p1: [100, 100], p2: [100, 200], p3: [80, 150], prefix: "Ø" };
  const lin = { ...dia, prefix: "" };
  const filled = (b) => b.prims.filter((q) => q.t === "P" && q.fill).length;
  assert.equal(filled(build(dia, S2, measure)), 2);
  assert.equal(filled(build(lin, S2, measure)), 0);
});

test("diameter on a circle: arrow on the outline towards the center, horizontal text on a shoulder, value 2R", () => {
  const K = 72 / 25.4;
  const a = { type: "rad", dia: true, style: "shoulder", c: [100, 100], p: [150, 100], p3: [140 + 30, 140], prefix: "Ø", nominal: null, tol: { mode: "none" } };
  const b = build(a, S, measure);
  assert.ok(Math.abs(b.measured - (100 / K)) < 1e-9);
  const t = b.prims.filter((q) => q.t === "T");
  assert.equal(t.map((q) => q.txt).join(""), `Ø${String(Math.round((100 / K) * 100) / 100).replace(".", ",")}`);
  assert.ok(t.every((q) => q.a === 0));
  // the arrow tip is on the circle, in the direction of the position
  const tri = b.prims.find((q) => q.t === "P" && q.fill);
  const tip = [tri.p[0], tri.p[1]];
  assert.ok(Math.abs(Math.hypot(tip[0] - 100, tip[1] - 100) - 50) < 1e-6);
  // the shoulder: a horizontal line starting at the end of the leader
  const sh = b.prims.find((q) => q.t === "L" && Math.abs(q.p[1] - 140) < 1e-9 && Math.abs(q.p[3] - 140) < 1e-9);
  assert.ok(sh && sh.p[0] === 170 && sh.p[2] > 170);
  // the text sits above the shoulder
  assert.ok(t[0].p[1] < 140);
});

// ---- grip modes (CMD-D14): transforms about a base point
test("translateAnnot moves every point", () => {
  const a = translateAnnot({ type: "dim", p1: [0, 0], p2: [10, 0], pos: [5, -5] }, 3, 4);
  assert.deepEqual([a.p1, a.p2, a.pos], [[3, 4], [13, 4], [8, -1]]);
});

test("rotateAbout turns clockwise on the page around the base", () => {
  // 90 on the page (y down) is clockwise: (10,0) around (0,0) goes to (0,10)
  const a = rotateAbout({ type: "dim", p1: [0, 0], p2: [10, 0], pos: [5, -5] }, 90, [0, 0]);
  assert.deepEqual(a.p1, [0, 0]);
  assert.deepEqual(a.p2, [0, 10]);
  const b = rotateAbout({ type: "dim", p1: [10, 10], p2: [20, 10], pos: [15, 5] }, 180, [10, 10]);
  assert.deepEqual([b.p1, b.p2], [[10, 10], [0, 10]]);
});

test("scaleAbout keeps the base fixed", () => {
  const a = scaleAbout({ type: "dim", p1: [10, 10], p2: [20, 10], pos: [15, 0] }, 2, [10, 10]);
  assert.deepEqual([a.p1, a.p2, a.pos], [[10, 10], [30, 10], [20, -10]]);
});

test("mirrorAbout flips across a horizontal or vertical axis", () => {
  const h = mirrorAbout({ type: "dim", p1: [0, 0], p2: [10, 0], pos: [5, -5] }, "h", [0, 0]);
  assert.deepEqual(h.pos, [5, 5]);
  const v = mirrorAbout({ type: "dim", p1: [0, 0], p2: [10, 0], pos: [5, -5] }, "v", [0, 0]);
  assert.deepEqual([v.p2, v.pos], [[-10, 0], [-5, -5]]);
  const hatch = mirrorAbout({ type: "shape", kind: "hatch", pts: [[0, 0], [1, 0], [1, 1]], angle: 45 }, "v", [0, 0]);
  assert.equal(hatch.angle, 135);
});

test("mirror keeps an arc's own part of the circle; a GD&T frame's leader side follows its feature", async () => {
  const { arcGeom } = await import("../js/shapes.js");
  const arc = { type: "shape", kind: "arc", pts: [[0, 0], [10, 0], [0, -10]], ccw: true }; // a quarter, 90°
  for (const axis of ["v", "h"]) {
    const m = mirrorAbout(JSON.parse(JSON.stringify(arc)), axis, [0, 0]);
    assert.ok(Math.abs(Math.abs(arcGeom(m).sw) - Math.PI / 2) < 1e-9, `${axis}: still 90°`);
  }
  const gdt = { type: "gdt", target: [100, 100], pos: [150, 100], anchor: "l", sym: "flat", val: "0,05" };
  assert.equal(mirrorAbout({ ...gdt }, "v", [100, 100]).anchor, "r", "the feature is now to the right of the frame");
  assert.equal(rotateAnnot({ ...gdt }, 90, 600, 400).anchor, "c", "after a quarter turn the frame is below the feature");
});
