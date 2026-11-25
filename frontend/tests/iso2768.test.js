import { test } from "node:test";
import assert from "node:assert/strict";
import { generalTol, gtolFor, gtolLabel, fmtMinutes } from "../js/iso2768.js";

const K = 72 / 25.4;
const pm = (kind, size, cls) => (generalTol(kind, size, cls) || {}).pm ?? null;

test("ISO 2768-1 table 1: range edges (over … up to, the first closed)", () => {
  assert.equal(pm("lin", 0.5, "m"), 0.1);
  assert.equal(pm("lin", 3, "m"), 0.1);
  assert.equal(pm("lin", 3.0001, "c"), 0.3);
  assert.equal(pm("lin", 6, "c"), 0.3);
  assert.equal(pm("lin", 6.01, "m"), 0.2);
  assert.equal(pm("lin", 30, "f"), 0.1);
  assert.equal(pm("lin", 30.5, "f"), 0.15);
  assert.equal(pm("lin", 120, "m"), 0.3);
  assert.equal(pm("lin", 400, "v"), 2.5);
  assert.equal(pm("lin", 1000, "c"), 2);
  assert.equal(pm("lin", 2000, "m"), 1.2);
  assert.equal(pm("lin", 4000, "v"), 8);
  // no value in the standard: v up to 3, f over 2000, below 0.5, over 4000, no class
  assert.equal(pm("lin", 2, "v"), null);
  assert.equal(pm("lin", 2500, "f"), null);
  assert.equal(pm("lin", 0.4, "m"), null);
  assert.equal(pm("lin", 4001, "m"), null);
  assert.equal(pm("lin", 50, ""), null);
});

test("ISO 2768-1 table 2 (broken edges) and table 3 (angles, minutes)", () => {
  assert.equal(pm("edge", 1, "m"), 0.2);
  assert.equal(pm("edge", 3, "c"), 0.4);
  assert.equal(pm("edge", 5, "f"), 0.5);
  assert.equal(pm("edge", 40, "v"), 2);
  assert.equal(pm("ang", 10, "m"), 60);
  assert.equal(pm("ang", 10, "c"), 90);
  assert.equal(pm("ang", 25, "f"), 30);
  assert.equal(pm("ang", 100, "m"), 20);
  assert.equal(pm("ang", 300, "c"), 15);
  assert.equal(pm("ang", 800, "v"), 20);
  assert.equal(fmtMinutes(90), "1°30'");
  assert.equal(fmtMinutes(30), "0°30'");
  assert.equal(fmtMinutes(180), "3°");
});

test("general tolerance of a dimension annotation", () => {
  const S = { gtol: "m", gtol2: "K", scale: 2 };
  assert.equal(gtolLabel(S), "ISO 2768-mK");
  assert.equal(gtolLabel({ gtol: "" }), "");
  const dim = { type: "dim" };
  assert.equal(gtolFor(dim, { nominal: 50 }, S).pm, 0.3);
  // its own tolerance or a replacement text: nothing
  assert.equal(gtolFor({ type: "dim", tol: { mode: "pm", pm: 0.1 } }, { nominal: 50 }, S), null);
  assert.equal(gtolFor({ type: "dim", textOverride: "4× M8" }, { nominal: 50 }, S), null);
  // radius on a broken edge: table 2
  assert.equal(gtolFor({ type: "rad", edge: true }, { nominal: 2 }, S).pm, 0.2);
  assert.equal(gtolFor({ type: "rad" }, { nominal: 2 }, S).pm, 0.1);
  // angle: the shorter leg, 20 paper mm × scale 2 = 40 real mm → ±30'
  const ang = { type: "ang", v: [0, 0], p1: [20 * K, 0], p2: [0, 60 * K] };
  const g = gtolFor(ang, { nominal: 90 }, S);
  assert.equal(g.unit, "min");
  assert.equal(g.pm, 30);
});

test("an angular general tolerance is written in degrees and minutes", async () => {
  const { build, derive } = await import("../js/annots.js");
  const ang = { type: "ang", v: [100, 100], p1: [200, 100], p2: [100, 0], p3: [160, 60], tol: { mode: "pm", pm: 0.5, dms: true } };
  const txt = build(ang, derive({}), (t, s) => String(t).length * s * 0.5).prims.filter((p) => p.t === "T").map((p) => p.txt).join("");
  assert.match(txt, /±0°30'/);
  ang.tol = { mode: "pm", pm: 1.5, dms: true };
  const txt2 = build(ang, derive({}), (t, s) => String(t).length * s * 0.5).prims.filter((p) => p.t === "T").map((p) => p.txt).join("");
  assert.match(txt2, /±1°30'/);
});
