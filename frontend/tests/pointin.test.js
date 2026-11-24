import test from "node:test";
import assert from "node:assert/strict";
import { K, build, derive } from "../js/annots.js";
import { applyPageOp } from "../js/pages.js";
import { parsePoint, resolvePoint, toUser, fromUser, defaultOrigin, orthoActive, routeKey } from "../js/pointin.js";

const near = (p, q, eps = 1e-6) => Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;
const H = 210 * K; // A4 landscape, visual height
const origin = defaultOrigin(H);

test("point syntax: every AutoCAD form parses; the comma separates X and Y", () => {
  assert.deepEqual(parsePoint("12,5"), { kind: "abs", x: 12, y: 5, forceAbs: false });
  assert.equal(parsePoint("#-2.5,1").kind, "abs");
  assert.equal(parsePoint("#-2.5,1").forceAbs, true);
  assert.deepEqual(parsePoint("@10,-3"), { kind: "rel", x: 10, y: -3, forceAbs: false });
  assert.deepEqual(parsePoint("@20<90"), { kind: "polarRel", d: 20, a: 90, forceAbs: false });
  assert.deepEqual(parsePoint("30<45"), { kind: "polarAbs", d: 30, a: 45, forceAbs: false });
  assert.deepEqual(parsePoint("@"), { kind: "last" });
  assert.deepEqual(parsePoint(" 25 "), { kind: "dist", d: 25 });
  assert.deepEqual(parsePoint(".5"), { kind: "dist", d: 0.5 });
  for (const bad of ["", "L", "12,", "@10", "1,2,3", "a,b", "10<", "#12"]) assert.equal(parsePoint(bad), null, bad);
});

test("absolute: from the bottom-left corner, Y up, real mm through the drawing scale", () => {
  const p = resolvePoint(parsePoint("10,20"), { origin, scale: 1 }).p;
  assert.ok(near(p, [10 * K, H - 20 * K]));
  // drawing at 1:2: 10 real mm are 5 mm on the paper
  const q = resolvePoint(parsePoint("10,20"), { origin, scale: 2 }).p;
  assert.ok(near(q, [5 * K, H - 10 * K]));
  assert.ok(near(resolvePoint(parsePoint("#10,20"), { origin, scale: 1 }).p, p), "# is the same as plain at the prompt");
  assert.ok(near(toUser(p, origin, 1), [10, 20]));
  assert.ok(near(fromUser([10, 20], origin, 1), p));
});

test("relative and polar: from the last point; 90° goes up on the sheet", () => {
  const last = [50 * K, 100 * K];
  const r = resolvePoint(parsePoint("@10,0"), { last, origin, scale: 2 }).p;
  assert.ok(near(r, [55 * K, 100 * K]), "10 real mm at 1:2 = 5 paper mm");
  const up = resolvePoint(parsePoint("@20<90"), { last, origin, scale: 1 }).p;
  assert.ok(near(up, [50 * K, 80 * K]), "page Y decreases going up");
  const pa = resolvePoint(parsePoint("10<0"), { origin, scale: 1 }).p;
  assert.ok(near(pa, [10 * K, H]));
  assert.ok(near(resolvePoint(parsePoint("@"), { last, origin }).p, last));
  assert.ok(resolvePoint(parsePoint("@5,5"), { last: null, origin }).error);
});

test("direct distance: along the cursor direction from the last point", () => {
  const last = [0, 0];
  const p = resolvePoint(parsePoint("30"), { last, cursor: [3 * K, 4 * K], origin, scale: 1 }).p;
  assert.ok(near(p, [18 * K, 24 * K]));
  assert.ok(resolvePoint(parsePoint("30"), { last: null, cursor: [1, 1], origin }).error);
});

test("Shift toggles ortho while held", () => {
  assert.equal(orthoActive(false, false), false);
  assert.equal(orthoActive(false, true), true);
  assert.equal(orthoActive(true, false), true);
  assert.equal(orthoActive(true, true), false);
});

test("typed keys: the box takes numbers when it can, the command line takes the point syntax", () => {
  assert.equal(routeKey({ dynUsable: true }, "5"), "dyn");
  assert.equal(routeKey({ dynUsable: true }, ","), "dyn", "comma = decimal mark in the box");
  assert.equal(routeKey({ dynUsable: false }, "5"), "cmd", "first point: the command line");
  assert.equal(routeKey({ dynUsable: true }, "@"), "cmd");
  assert.equal(routeKey({ dynUsable: true }, "#"), "cmd");
  assert.equal(routeKey({ dynUsable: false }, "-"), null, "minus stays zoom out without the box");
  assert.equal(routeKey({ dynUsable: false }, "+"), null);
  assert.equal(routeKey({ dynUsable: false }, "L"), null);
});

test("UCS origin: editor-only symbol, follows page rotation", () => {
  const S = derive({});
  const measure = (t, s) => t.length * s * 0.6;
  const a = { type: "ucs", p: [40 * K, 150 * K], page: 0 };
  const b = build(a, S, measure);
  assert.ok(b.prims.length && b.prims.every((p) => p.ed), "nothing is exported");
  const [r] = applyPageOp([a], { op: "rotate", pages: [0], delta: 90, sizes: [[297 * K, H]] }, S, measure);
  // (x, y) → (H − y, x)
  assert.ok(near(r.p, [H - 150 * K, 40 * K]));
});

test("point modifiers: FROM and M2P (MTP), with the usual prefixes", async () => {
  const { parsePointMod } = await import("../js/pointin.js");
  assert.equal(parsePointMod("from"), "from");
  assert.equal(parsePointMod("_FRO"), "from");
  assert.equal(parsePointMod("m2p"), "m2p");
  assert.equal(parsePointMod("'MTP"), "m2p");
  assert.equal(parsePointMod("M"), null);
  assert.equal(parsePointMod("tk"), "tk");
  assert.equal(parsePointMod("'TRACKING"), "tk");
});

test("point filters .X / .Y", async () => {
  const { parsePointMod } = await import("../js/pointin.js");
  assert.equal(parsePointMod(".x"), "fx");
  assert.equal(parsePointMod(".Y"), "fy");
  assert.equal(parsePointMod(".z"), null);
});
