import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, K, gdtAnchor, onBoxEdge, strikeLabelBox, annotSnapSegs, setHandle, moveAnnot } from "../js/annots.js";
import { diaAllowed } from "../js/gdt.js";

// approximate text width: 0.6 em per character (enough for geometry)
const measure = (txt, s) => txt.length * s * 0.6;
const S = derive({});
const mm = (x, y) => [x * K, y * K];
const textBox = (b) => {
  const t = b.prims.filter((p) => p.t === "T");
  const xs = t.flatMap((p) => [p.p[0], p.p[0] + (p.tw || 0)]);
  return [Math.min(...xs), Math.max(...xs)];
};

test("linear dimension: a value that fits between the extension lines stays there, arrows go outside", () => {
  // 8 mm: "8" fits, the arrows do not
  const a = { type: "dim", kind: "lin", orient: "h", p1: mm(60, 50), p2: mm(68, 50), p3: mm(60, 40), tol: { mode: "none" } };
  const b = build(a, S, measure);
  assert.equal(b.meta.out, false);
  const [x0, x1] = textBox(b);
  assert.ok(x0 >= 60 * K && x1 <= 68 * K, `text ${x0 / K}..${x1 / K} mm`);
});

test("linear dimension: a value that does not fit goes to the side chosen in textOut", () => {
  const a = { type: "dim", kind: "lin", orient: "h", p1: mm(60, 50), p2: mm(62, 50), p3: mm(60, 40), tol: { mode: "none" } };
  const r = build(a, S, measure);
  assert.equal(r.meta.out, true);
  assert.ok(textBox(r)[0] > 62 * K);
  const l = build({ ...a, textOut: "l" }, S, measure);
  assert.ok(textBox(l)[1] < 60 * K);
});

test("GD&T frame: the placed point is the frame end towards the feature", () => {
  assert.equal(gdtAnchor(mm(100, 50), mm(120, 55)), "l");
  assert.equal(gdtAnchor(mm(100, 50), mm(80, 55)), "r");
  assert.equal(gdtAnchor(mm(100, 50), mm(102, 80)), "c");
  const a = { type: "gdt", target: mm(100, 50), pos: mm(80, 60), anchor: "r", sym: "flat", val: "0,05", mods: [], datums: [] };
  const f = build(a, S, measure).frame;
  assert.ok(Math.abs(f[2] - 80 * K) < 1e-6, "the right end sits on the placed point");
  // dragging the position to the other side of the feature turns the frame round
  setHandle(a, "pos", mm(120, 60));
  assert.equal(a.anchor, "l");
});

test("GD&T frame: edges to snap on, and Ø only for an axis", () => {
  const a = { type: "gdt", target: mm(100, 50), pos: mm(120, 60), sym: "perp", val: "0,05", mods: [], datums: ["A"] };
  const b = build(a, S, measure);
  assert.equal(b.snap.segs.length, 4);
  assert.ok(onBoxEdge([(b.frame[0] + b.frame[2]) / 2, b.frame[3]], b.frame));
  assert.ok(!onBoxEdge([(b.frame[0] + b.frame[2]) / 2, b.frame[3] + 5], b.frame));
  assert.equal(diaAllowed("pos"), true);
  assert.equal(diaAllowed("coax"), true);
  assert.equal(diaAllowed("flat"), false);
  assert.equal(diaAllowed("runC"), false);
});

test("struck value: the label sides do not overlap the struck rectangle, lp moves with the annotation", () => {
  const a = { type: "strike", r: [...mm(60, 50), ...mm(66, 54)], newText: "7", rev: "1" };
  const r = [60 * K, 50 * K, 66 * K, 54 * K];
  for (const side of ["r", "t", "l", "b"]) {
    const b = strikeLabelBox(a, S, 10, side);
    const overlap = !(b[2] <= r[0] || b[0] >= r[2] || b[3] <= r[1] || b[1] >= r[3]);
    assert.ok(!overlap, side);
  }
  const moved = { ...a, lp: mm(70, 40) };
  moveAnnot(moved, 10, 0);
  assert.equal(moved.lp[0], 70 * K + 10);
});

test("annotation lines can be snapped on (dimension line), arrows and text cannot", () => {
  const a = { type: "dim", kind: "lin", orient: "h", p1: mm(0, 50), p2: mm(40, 50), p3: mm(0, 40), tol: { mode: "none" } };
  const segs = annotSnapSegs(build(a, S, measure));
  assert.ok(segs.some((q) => Math.abs(q[1] - 40 * K) < 1e-6 && Math.abs(q[3] - 40 * K) < 1e-6), "the dimension line");
  assert.ok(segs.length <= 4);
});
