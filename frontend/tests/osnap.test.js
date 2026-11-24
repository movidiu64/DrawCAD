import test from "node:test";
import assert from "node:assert/strict";
import { Snapper, inArc, lineCircle, circleCircle } from "../js/osnap.js";

const ALL = new Set(["e", "m", "c", "q", "x", "ax", "ext", "p", "t", "par", "n"]);
const near = (p, q, eps = 1e-6) => Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;
const TAU = Math.PI * 2;

test("apparent intersection: the theoretical corner of a chamfer", () => {
  // rectangle 0..100 × 0..60 with the corner (100, 0) chamfered 10×10
  const segs = [[0, 0, 90, 0], [90, 0, 100, 10], [100, 10, 100, 60]];
  const s = new Snapper({ segs });
  const r = s.snap([99, 1.5], { tol: 4, modes: ALL });
  assert.equal(r.kind, "ax");
  assert.ok(near(r.p, [100, 0]));
  assert.equal(r.guides.length, 2);
  // without center mode: no longer offered
  const r2 = s.snap([99, 1.5], { tol: 4, modes: new Set(["e", "x"]) });
  assert.ok(!r2 || r2.kind !== "ax");
});

test("apparent intersection at a fillet too (arc between two lines)", () => {
  const segs = [[0, 0, 95, 0], [100, 5, 100, 60]];
  const arcs = [[95, 5, 5, Math.PI / 2, -Math.PI / 2]];
  const r = new Snapper({ segs, arcs }).snap([99.5, 0.6], { tol: 3, modes: ALL });
  assert.equal(r.kind, "ax");
  assert.ok(near(r.p, [100, 0]));
});

test("extension: from the acquired endpoint, along the line's extension", () => {
  const segs = [[0, 0, 50, 0]];
  const s = new Snapper({ segs });
  const acq = [{ p: [50, 0], dirs: s.dirsAt([50, 0]) }];
  assert.deepEqual(acq[0].dirs, [[1, 0]]);
  const r = s.snap([80, 2], { tol: 4, modes: ALL, acq });
  assert.equal(r.kind, "ext");
  assert.ok(near(r.p, [80, 0]));
  // behind the endpoint there is no extension (the ray only goes outwards)
  const back = s.snap([-30, 2], { tol: 4, modes: new Set(["ext"]), acq });
  assert.equal(back, null);
});

test("tracking: X from one point, Y from another", () => {
  const s = new Snapper();
  const acq = [{ p: [10, 100], dirs: [] }, { p: [200, 30], dirs: [] }];
  const r = s.snap([11.5, 31], { tol: 4, modes: ALL, acq, tracking: true });
  assert.equal(r.kind, "trk");
  assert.ok(near(r.p, [10, 30]));
  assert.equal(r.guides.length, 2);
});

test("polar: the cursor snaps to the 30° ray from the previous point", () => {
  const s = new Snapper();
  const A = [0, 0];
  const th = (30 * Math.PI) / 180;
  const cur = [100 * Math.cos(th) + 1, -100 * Math.sin(th) + 1];
  const r = s.snap(cur, { tol: 4, modes: ALL, anchor: A, polarInc: 15 });
  assert.equal(r.kind, "pol");
  const ang = (Math.atan2(-r.p[1], r.p[0]) * 180) / Math.PI;
  assert.ok(Math.abs(ang - 30) < 1e-9);
  // polar × real line: exact point on the object
  const s2 = new Snapper({ segs: [[80, -100, 80, 100]] });
  const cur2 = [80.5, -80 * Math.tan(th) + 1];
  const r2 = s2.snap(cur2, { tol: 4, modes: new Set(["n"]), anchor: A, polarInc: 15 });
  assert.equal(r2.kind, "pol");
  assert.ok(r2.onObj && Math.abs(r2.p[0] - 80) < 1e-9);
});

test("perpendicular and tangent relative to the previous point", () => {
  const s = new Snapper({ segs: [[0, 50, 100, 50]], arcs: [[200, 0, 20, 0, TAU]] });
  const p = s.snap([31, 51], { tol: 3, modes: ALL, anchor: [30, 0] });
  assert.equal(p.kind, "p");
  assert.ok(near(p.p, [30, 50]));
  // tangent from (200, -60) to the circle (200, 0) r 20
  const A = [200, -60];
  const al = Math.acos(20 / 60);
  const th = Math.PI / 2 - al; // angle of the tangent point (on screen, counter-clockwise)
  const T = [200 + 20 * Math.cos(th), -20 * Math.sin(th)];
  const t = s.snap([T[0] + 0.5, T[1] + 0.5], { tol: 3, modes: new Set(["t"]), anchor: A });
  assert.equal(t.kind, "t");
  const v1 = [t.p[0] - 200, t.p[1]];
  const v2 = [t.p[0] - A[0], t.p[1] - A[1]];
  assert.ok(Math.abs(v1[0] * v2[0] + v1[1] * v2[1]) < 1e-6, "raza ⟂ tangenta");
});

test("parallel: the acquired direction, through the previous point", () => {
  const s = new Snapper();
  const d = [Math.SQRT1_2, -Math.SQRT1_2];
  const r = s.snap([51, -49], { tol: 4, modes: ALL, anchor: [0, 0], parDir: d });
  assert.equal(r.kind, "par");
  assert.ok(near(r.p, [50, -50]));
});

test("arcs: line–arc intersection only within the arc sweep, center, quadrants", () => {
  const arc = [0, 0, 10, 0, Math.PI / 2]; // from 0° to 90° (right → up)
  assert.ok(inArc(arc, Math.PI / 4) && !inArc(arc, Math.PI));
  const s = new Snapper({ arcs: [arc], segs: [[-20, -5, 20, -5], [-20, 0, 20, 0]] });
  // the line y = -5 (up on screen) cuts the arc at x = +√75; the symmetric point x = −√75 is outside the arc
  const r = s.snap([Math.sqrt(75) + 0.4, -5.3], { tol: 2, modes: ALL });
  assert.equal(r.kind, "x");
  assert.equal(s.snap([-Math.sqrt(75), -5], { tol: 1, modes: new Set(["x"]) }), null);
  assert.equal(s.snap([0.5, 0.5], { tol: 2, modes: ALL }).kind, "c");
  // at 90° the arc ends: the endpoint wins; on a semicircle, 90° is a quadrant (and the midpoint)
  assert.equal(s.snap([0.3, -9.8], { tol: 2, modes: ALL }).kind, "e");
  assert.equal(new Snapper({ arcs: [[0, 0, 10, 0, Math.PI]] }).snap([0.3, -9.8], { tol: 2, modes: ALL }).kind, "q");
  assert.equal(lineCircle([-20, 0], [1, 0], [0, 0], 10).length, 2);
  assert.equal(circleCircle([0, 0], 10, [15, 0], 10).length, 2);
});

test("long segments (the sheet border) take part in intersections", () => {
  const s = new Snapper({ segs: [[0, 0, 5000, 0], [2500, -10, 2500, 10]] });
  const r = s.snap([2501, 1], { tol: 3, modes: ALL });
  assert.equal(r.kind, "x");
});

test("typed overrides: AutoCAD names, three letters or whole, with _ or ' prefixes", async () => {
  const { parseOverride, overrideModes } = await import("../js/osnap.js");
  assert.equal(parseOverride("mid"), "m");
  assert.equal(parseOverride("_ENDPOINT"), "e");
  assert.equal(parseOverride("'int"), "x");
  assert.equal(parseOverride("non"), "none");
  assert.equal(parseOverride("app"), "ax");
  assert.equal(parseOverride("L"), null, "a command alias is not an override");
  assert.equal(overrideModes("none").size, 0);
  // with only Midpoint, an endpoint under the cursor is not taken
  const s = new Snapper({ pts: [[0, 0, "e"], [50, 0, "m"], [100, 0, "e"]], segs: [[0, 0, 100, 0]] });
  const atEnd = s.snap([2, 1], { tol: 60, modes: overrideModes("m") });
  assert.equal(atEnd.kind, "m");
  assert.equal(s.snap([2, 1], { tol: 3, modes: overrideModes("none") }), null);
});

test("Node: annotation points snap only with the Node mode", () => {
  const s = new Snapper({});
  const extra = { pts: [[10, 10]], segs: [], arcs: [] }; // annotation handle (kind "a")
  assert.equal(s.snap([11, 10], { tol: 3, modes: new Set(["node"]), extra }).kind, "a");
  assert.equal(s.snap([11, 10], { tol: 3, modes: new Set(["e", "m"]), extra }), null);
});

test("candidates for Tab: every snap under the cursor once, best first", () => {
  const s = new Snapper({ pts: [[0, 0, "e"], [4, 0, "m"]], segs: [[0, 0, 8, 0], [0, -5, 0, 5]] });
  const list = s.candidates([1, 0.5], { tol: 6, modes: ALL });
  assert.ok(list.length >= 2, JSON.stringify(list));
  assert.equal(list[0].kind, s.snap([1, 0.5], { tol: 6, modes: ALL }).kind, "the first is what snap() picks");
  const keys = list.map((c) => c.p.join(","));
  assert.equal(new Set(keys).size, keys.length, "one entry per point");
});

test("CEN override: the center of a hole from its edge", () => {
  const s = new Snapper({ arcs: [[50, 50, 10, 0, TAU]] });
  assert.equal(s.snap([60.5, 50.5], { tol: 2, modes: new Set(["c"]) }).kind, "c");
  assert.ok(near(s.snap([60.5, 50.5], { tol: 2, modes: new Set(["c"]) }).p, [50, 50]));
  // running modes: the edge is not the center (nearest / quadrant keep working there)
  const r = s.snap([59.5, 53], { tol: 2, modes: ALL });
  assert.ok(!r || r.kind !== "c", JSON.stringify(r));
});
