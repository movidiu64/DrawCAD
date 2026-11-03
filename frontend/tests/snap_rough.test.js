import test from "node:test";
import assert from "node:assert/strict";
import { Snapper, lineLine } from "../js/osnap.js";
import { build, derive, K } from "../js/annots.js";

const measure = (txt, s) => txt.length * s * 0.6;
const S = derive({});

const ALL = new Set(["e", "m", "c", "q", "x", "ax", "ext", "p", "t", "par", "n"]);

test("intersection of two lines", () => {
  const r = lineLine([0, 0], [10, 10], [0, 10], [10, -10]);
  assert.deepEqual(r.p, [5, 5]);
  assert.equal(lineLine([0, 0], [10, 0], [0, 1], [10, 0]), null); // parallel
});

test("snap: the intersection wins over the point on the line", () => {
  const sn = new Snapper({ segs: [[0, 50, 100, 50], [40, 0, 40, 100]] });
  const s = sn.snap([41, 51], { tol: 5, modes: ALL });
  assert.equal(s.kind, "x");
  assert.deepEqual(s.p, [40, 50]);
  const n = sn.snap([70, 52], { tol: 5, modes: ALL });
  assert.equal(n.kind, "n");
});

test("roughness: the ISO 1302 variants and the text", () => {
  const base = { type: "rough", target: [100, 100], pos: null, val: "Ra 1,6", method: "", rot: 0 };
  const any = build({ ...base, kind: "any" }, S, measure);
  const rem = build({ ...base, kind: "remove" }, S, measure);
  const nor = build({ ...base, kind: "noremove" }, S, measure);
  const nLines = (b) => b.prims.filter((p) => p.t === "L").length;
  assert.equal(nLines(rem), nLines(any) + 1); // the horizontal bar
  assert.equal(nor.prims.filter((p) => p.t === "C").length, 1); // the circle
  const txt = any.prims.find((p) => p.t === "T");
  assert.equal(txt.txt, "Ra 1,6");
  // the tip sits on the surface, the symbol is above
  assert.ok(any.prims.filter((p) => p.t === "L").every((l) => l.p[1] <= 100 + 1e-6 && l.p[3] <= 100 + 1e-6));
  // to the left: rotated 90°, the text reads bottom to top
  const left = build({ ...base, kind: "any", rot: 90 }, S, measure);
  assert.equal(left.prims.find((p) => p.t === "T").a, 90);
  assert.ok(left.prims.filter((p) => p.t === "L").every((l) => l.p[0] <= 100 + 1e-6 && l.p[2] <= 100 + 1e-6));
  // with a leader: arrow at the target
  const lead = build({ ...base, kind: "remove", pos: [100 + 15 * K, 100 - 10 * K] }, S, measure);
  assert.ok(lead.prims.some((p) => p.t === "P" && p.fill && p.p[0] === 100 && p.p[1] === 100));
});
