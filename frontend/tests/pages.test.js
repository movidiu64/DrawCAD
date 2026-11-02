import test from "node:test";
import assert from "node:assert/strict";
import { rotatePoint, rotateAnnot, applyPageOp } from "../js/pages.js";
import { build, derive } from "../js/annots.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;

test("rotirea punctelor: patru sferturi revin la loc, colțurile ajung unde trebuie", () => {
  const W = 842;
  const H = 595;
  assert.deepEqual(rotatePoint([0, 0], 90, W, H), [H, 0]); // stânga-sus → dreapta-sus
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

test("cota liniară orizontală devine verticală și măsoară aceeași distanță", () => {
  const a = { id: "d", type: "dim", kind: "lin", orient: "h", p1: [100, 100], p2: [200, 100], p3: [150, 80], page: 0 };
  const before = build(a, S, measure).prims.filter((q) => q.t === "T").map((q) => q.txt).join("");
  rotateAnnot(a, 90, 842, 595);
  assert.equal(a.orient, "v");
  const after = build(a, S, measure).prims.filter((q) => q.t === "T").map((q) => q.txt).join("");
  assert.equal(after, before);
});

test("textul se rotește cu pagina, hașura își păstrează aspectul", () => {
  const t = rotateAnnot({ type: "text", p: [10, 10], angle: 0 }, 90, 842, 595);
  assert.equal(t.angle, -90);
  const hz = rotateAnnot({ type: "shape", kind: "hatch", pts: [[0, 0], [10, 0], [10, 10]], angle: 45 }, 90, 842, 595);
  assert.equal(hz.angle, 135);
  const r = rotateAnnot({ type: "white", r: [10, 20, 50, 60] }, 90, 842, 595);
  assert.deepEqual(r.r, [535, 10, 575, 50]);
});

test("ștergerea și mutarea paginilor renumerotează adnotările", () => {
  const ann = [{ id: "a", page: 0 }, { id: "b", page: 1 }, { id: "c", page: 2 }];
  assert.deepEqual(applyPageOp(ann, { op: "delete", pages: [1] }).map((a) => [a.id, a.page]), [["a", 0], ["c", 1]]);
  assert.deepEqual(applyPageOp(ann, { op: "move", page: 2, to: 0, count: 3 }).map((a) => [a.id, a.page]), [["a", 1], ["b", 2], ["c", 0]]);
  // tabelul rămâne orizontal și ajunge cu centrul în locul rotit
  const tab = { id: "t", type: "revtab", page: 0, p: [800, 560], rows: [{ rev: "1", desc: "x", date: "", name: "" }] };
  const b0 = build(tab, S, measure).bbox;
  const [rt] = applyPageOp([tab], { op: "rotate", pages: [0], delta: 90, sizes: [[842, 595]] }, S, measure);
  const b1 = build(rt, S, measure).bbox;
  assert.ok(Math.abs((b1[2] - b1[0]) - (b0[2] - b0[0])) < 1e-6);
  const c0 = [(b0[0] + b0[2]) / 2, (b0[1] + b0[3]) / 2];
  const c1 = [(b1[0] + b1[2]) / 2, (b1[1] + b1[3]) / 2];
  assert.ok(Math.abs(c1[0] - (595 - c0[1])) < 1e-6 && Math.abs(c1[1] - c0[0]) < 1e-6);
});

test("diametrul are săgeți pline ca linia de indicație, chiar cu capete oblice la cote", () => {
  const S2 = derive({ arrow: "tick" });
  const dia = { type: "dim", kind: "lin", orient: "v", p1: [100, 100], p2: [100, 200], p3: [80, 150], prefix: "Ø" };
  const lin = { ...dia, prefix: "" };
  const filled = (b) => b.prims.filter((q) => q.t === "P" && q.fill).length;
  assert.equal(filled(build(dia, S2, measure)), 2);
  assert.equal(filled(build(lin, S2, measure)), 0);
});
