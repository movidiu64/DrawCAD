import test from "node:test";
import assert from "node:assert/strict";
import { SnapIndex, segIntersect } from "../js/view.js";
import { build, derive, K } from "../js/annots.js";

const measure = (txt, s) => txt.length * s * 0.6;
const S = derive({});

test("intersecția a două segmente care se încrucișează", () => {
  assert.deepEqual(segIntersect([0, 0, 10, 10], [0, 10, 10, 0]), [5, 5]);
  assert.equal(segIntersect([0, 0, 10, 0], [0, 1, 10, 1]), null); // paralele
  assert.equal(segIntersect([0, 0, 5, 0], [6, -1, 6, 1]), null); // nu se ating
  assert.equal(segIntersect([0, 0, 10, 0], [10, 0, 10, 10]), null); // capăt comun
});

test("snap: intersecția are prioritate față de punctul pe linie", () => {
  const idx = new SnapIndex([], [[0, 50, 100, 50], [40, 0, 40, 100]]);
  const s = idx.nearest(41, 51, 5);
  assert.equal(s.kind, "x");
  assert.deepEqual(s.p, [40, 50]);
  const n = idx.nearest(70, 52, 5);
  assert.equal(n.kind, "n");
});

test("rugozitate: variantele ISO 1302 și textul", () => {
  const base = { type: "rough", target: [100, 100], pos: null, val: "Ra 1,6", method: "", rot: 0 };
  const any = build({ ...base, kind: "any" }, S, measure);
  const rem = build({ ...base, kind: "remove" }, S, measure);
  const nor = build({ ...base, kind: "noremove" }, S, measure);
  const nLines = (b) => b.prims.filter((p) => p.t === "L").length;
  assert.equal(nLines(rem), nLines(any) + 1); // bara orizontală
  assert.equal(nor.prims.filter((p) => p.t === "C").length, 1); // cercul
  const txt = any.prims.find((p) => p.t === "T");
  assert.equal(txt.txt, "Ra 1,6");
  // vârful stă pe suprafață, simbolul e deasupra
  assert.ok(any.prims.filter((p) => p.t === "L").every((l) => l.p[1] <= 100 + 1e-6 && l.p[3] <= 100 + 1e-6));
  // la stânga: rotit 90°, textul se citește de jos în sus
  const left = build({ ...base, kind: "any", rot: 90 }, S, measure);
  assert.equal(left.prims.find((p) => p.t === "T").a, 90);
  assert.ok(left.prims.filter((p) => p.t === "L").every((l) => l.p[0] <= 100 + 1e-6 && l.p[2] <= 100 + 1e-6));
  // cu linie de indicație: săgeată la țintă
  const lead = build({ ...base, kind: "remove", pos: [100 + 15 * K, 100 - 10 * K] }, S, measure);
  assert.ok(lead.prims.some((p) => p.t === "P" && p.fill && p.p[0] === 100 && p.p[1] === 100));
});
