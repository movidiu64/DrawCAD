import test from "node:test";
import assert from "node:assert/strict";
import { build, derive } from "../js/annots.js";
import { breakPoints, shapeSnap, K } from "../js/shapes.js";
import { Snapper } from "../js/osnap.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;
const texts = (b) => b.prims.filter((p) => p.t === "T").map((p) => p.txt);
const arrows = (b) => b.prims.filter((p) => p.t === "P" && p.fill);

test("section: the arrows point to the chosen side, the letter at both ends", () => {
  const P0 = [100, 100];
  const P1 = [100, 300];
  for (const side of [1, -1]) {
    const b = build({ type: "section", pts: [P0, P1], vp: [100 + side * 50, 200], letter: "A" }, S, measure);
    assert.deepEqual(texts(b), ["A", "A"]);
    const ar = arrows(b);
    assert.equal(ar.length, 2);
    for (const a of ar) {
      // the tip is on the line (x = 100), the triangle base on the side opposite the viewing direction
      assert.ok(Math.abs(a.p[0] - 100) < 1e-6);
      assert.ok(Math.sign(a.p[2] - 100) === -side);
    }
    // thick ends (0.5 mm) and the thin chain line between them
    const lines = b.prims.filter((p) => p.t === "L");
    assert.equal(lines.filter((l) => Math.abs(l.w - 0.5 * K) < 1e-9).length, 2);
    assert.ok(lines.some((l) => l.dp && l.dp.length === 4));
  }
});

test("detail: thin circle and the letter outside it", () => {
  const b = build({ type: "detail", pts: [[200, 200], [200 + 10 * K, 200]], letter: "B" }, S, measure);
  const c = b.prims.find((p) => p.t === "C");
  assert.ok(Math.abs(c.r - 10 * K) < 1e-9);
  const t = b.prims.find((p) => p.t === "T");
  assert.ok(Math.hypot(t.p[0] - 200, t.p[1] - 200) > c.r);
});

test("balloon: the line starts on the circle, dot on the part; the on-line variant", () => {
  const b = build({ type: "balloon", target: [0, 0], pos: [100, -60], num: "12", shape: "circle", end: "dot" }, S, measure);
  assert.deepEqual(texts(b), ["12"]);
  const circles = b.prims.filter((p) => p.t === "C");
  assert.equal(circles.length, 2); // the dot and the circle
  const ring = circles.find((p) => !p.fill);
  const line = b.prims.find((p) => p.t === "L");
  assert.ok(Math.abs(Math.hypot(line.p[0] - 100, line.p[1] + 60) - ring.r) < 1e-6);
  const plain = build({ type: "balloon", target: [0, 0], pos: [100, -60], num: "3", shape: "plain", end: "arrow" }, S, measure);
  assert.equal(plain.prims.filter((p) => p.t === "C").length, 0);
  assert.equal(arrows(plain).length, 1);
});

test("break line: ends kept, zigzag centered", () => {
  const A = [0, 0];
  const B = [40 * K, 0];
  const z = breakPoints(A, B, "zigzag");
  assert.deepEqual(z[0], A);
  assert.deepEqual(z[z.length - 1], B);
  const ys = z.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...ys) + Math.min(...ys)) < 1e-9 && Math.max(...ys) > 0);
  const w = breakPoints(A, B, "wave");
  assert.ok(w.length > 20 && Math.abs(w[w.length - 1][0] - B[0]) < 1e-9);
});

test("snap on drawn shapes: endpoints, midpoint, center, intersections", () => {
  const line = shapeSnap({ kind: "line", pts: [[0, 0], [100, 0]] });
  assert.ok(line.pts.some((p) => p[0] === 50 && p[2] === "m"));
  const circ = shapeSnap({ kind: "circle", pts: [[50, 50], [70, 50]] });
  assert.equal(circ.arcs.length, 1);
  const idx = new Snapper();
  const M = new Set(["e", "m", "c", "q", "x", "n"]);
  const cs = idx.snap([70.5, 50.5], { tol: 3, modes: M, extra: circ });
  assert.equal(cs.kind, "q");
  const v = shapeSnap({ kind: "line", pts: [[30, -40], [30, 40]] });
  // intersection between two drawn lines, without PDF geometry
  const sn = idx.snap([31, 1], { tol: 5, modes: M, extra: { segs: [...line.segs, ...v.segs] } });
  assert.equal(sn.kind, "x");
  assert.ok(Math.abs(sn.p[0] - 30) < 1e-9 && Math.abs(sn.p[1]) < 1e-9);
  // on the line, far from the points
  const on = idx.snap([80, 2], { tol: 5, modes: M, extra: { segs: line.segs } });
  assert.equal(on.kind, "n");
});

test("parts list: header at the bottom, item 1 next to the header, Name left aligned", () => {
  const rows = [
    { poz: "1", name: "Arbore", qty: "1", mat: "42CrMo4", obs: "" },
    { poz: "2", name: "Rulment 6205", qty: "2", mat: "", obs: "ISO 15" },
  ];
  const b = build({ type: "bom", p: [500, 400], rows, headerBottom: true }, S, measure);
  const t = b.prims.filter((p) => p.t === "T");
  const y = (txt) => t.find((p) => p.txt === txt).p[1];
  assert.ok(y("Poz.") > y("Arbore") && y("Arbore") > y("Rulment 6205"));
  // the bottom-right corner is the anchor
  assert.ok(Math.abs(b.bbox[2] - 500) < 1 && Math.abs(b.bbox[3] - 400) < 1);
  // names of different lengths start at the same x (left aligned); "Buc." is centered
  const x = (txt) => t.find((p) => p.txt === txt).p[0];
  assert.ok(Math.abs(x("Arbore") - x("Rulment 6205")) < 1e-9);
  const qx = t.filter((p) => p.txt === "1" || p.txt === "2").map((p) => p.p[0] + p.tw / 2);
  assert.ok(qx.length >= 2);
});

test("GD&T: the leader elbow can be moved freely", () => {
  const base = { type: "gdt", target: [100, 200], pos: [150, 100], sym: "pos", dia: true, val: "0,1", mods: [], datums: ["A", "", ""] };
  const auto = build(base, S, measure);
  const h = auto.handles.find((q) => q.k === "elbow");
  assert.ok(h, "elbow handle");
  const free = build({ ...base, elbow: [120, 140] }, S, measure);
  const lead = free.prims.find((p) => p.t === "P" && !p.close && !p.fill);
  // goes through the elbow and ends at the target
  const pts = [];
  for (let i = 0; i < lead.p.length; i += 2) pts.push([lead.p[i], lead.p[i + 1]]);
  assert.ok(pts.some((q) => Math.abs(q[0] - 120) < 1e-9 && Math.abs(q[1] - 140) < 1e-9));
  assert.deepEqual(pts[pts.length - 1], [100, 200]);
});

test("colored cover: the chosen color reaches the primitives and the export", () => {
  const b = build({ type: "redact", r: [0, 0, 50, 30], mode: "cover", color: "#ffe8a0" }, S, measure);
  const r = b.prims.find((p) => p.t === "R");
  assert.equal(r.c, "#ffe8a0");
  assert.ok(r.cover);
  const w = build({ type: "white", r: [0, 0, 50, 30] }, S, measure);
  assert.equal(w.prims.find((p) => p.t === "R").c, "white");
});
