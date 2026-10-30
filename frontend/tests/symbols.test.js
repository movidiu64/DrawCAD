import test from "node:test";
import assert from "node:assert/strict";
import { build, derive } from "../js/annots.js";
import { breakPoints, shapeSnap, K } from "../js/shapes.js";
import { SnapIndex } from "../js/view.js";

const S = derive({});
const measure = (txt, s) => txt.length * s * 0.6;
const texts = (b) => b.prims.filter((p) => p.t === "T").map((p) => p.txt);
const arrows = (b) => b.prims.filter((p) => p.t === "P" && p.fill);

test("secțiune: săgețile arată spre partea aleasă, litera la ambele capete", () => {
  const P0 = [100, 100];
  const P1 = [100, 300];
  for (const side of [1, -1]) {
    const b = build({ type: "section", pts: [P0, P1], vp: [100 + side * 50, 200], letter: "A" }, S, measure);
    assert.deepEqual(texts(b), ["A", "A"]);
    const ar = arrows(b);
    assert.equal(ar.length, 2);
    for (const a of ar) {
      // vârful e pe linie (x = 100), baza triunghiului pe partea opusă privirii
      assert.ok(Math.abs(a.p[0] - 100) < 1e-6);
      assert.ok(Math.sign(a.p[2] - 100) === -side);
    }
    // capetele îngroșate (0,5 mm) și linia-punct subțire între ele
    const lines = b.prims.filter((p) => p.t === "L");
    assert.equal(lines.filter((l) => Math.abs(l.w - 0.5 * K) < 1e-9).length, 2);
    assert.ok(lines.some((l) => l.dp && l.dp.length === 4));
  }
});

test("detaliu: cerc subțire și literă în afara lui", () => {
  const b = build({ type: "detail", pts: [[200, 200], [200 + 10 * K, 200]], letter: "B" }, S, measure);
  const c = b.prims.find((p) => p.t === "C");
  assert.ok(Math.abs(c.r - 10 * K) < 1e-9);
  const t = b.prims.find((p) => p.t === "T");
  assert.ok(Math.hypot(t.p[0] - 200, t.p[1] - 200) > c.r);
});

test("reper: linia pornește de pe cerc, punct pe piesă; varianta pe linie", () => {
  const b = build({ type: "balloon", target: [0, 0], pos: [100, -60], num: "12", shape: "circle", end: "dot" }, S, measure);
  assert.deepEqual(texts(b), ["12"]);
  const circles = b.prims.filter((p) => p.t === "C");
  assert.equal(circles.length, 2); // punctul și cercul
  const ring = circles.find((p) => !p.fill);
  const line = b.prims.find((p) => p.t === "L");
  assert.ok(Math.abs(Math.hypot(line.p[0] - 100, line.p[1] + 60) - ring.r) < 1e-6);
  const plain = build({ type: "balloon", target: [0, 0], pos: [100, -60], num: "3", shape: "plain", end: "arrow" }, S, measure);
  assert.equal(plain.prims.filter((p) => p.t === "C").length, 0);
  assert.equal(arrows(plain).length, 1);
});

test("linia de ruptură: capete păstrate, zigzag centrat", () => {
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

test("snap pe formele desenate: capete, mijloc, centru, intersecții", () => {
  const line = shapeSnap({ kind: "line", pts: [[0, 0], [100, 0]] });
  assert.ok(line.pts.some((p) => p[0] === 50 && p[2] === "m"));
  const circ = shapeSnap({ kind: "circle", pts: [[50, 50], [70, 50]] });
  assert.ok(circ.pts.some((p) => p[2] === "c") && circ.pts.filter((p) => p[2] === "q").length === 4);
  const idx = new SnapIndex();
  const v = shapeSnap({ kind: "line", pts: [[30, -40], [30, 40]] });
  // intersecția dintre două linii desenate, fără geometrie PDF
  const sn = idx.nearest(31, 1, 5, [], [...line.segs, ...v.segs]);
  assert.equal(sn.kind, "x");
  assert.ok(Math.abs(sn.p[0] - 30) < 1e-9 && Math.abs(sn.p[1]) < 1e-9);
  // pe linie, departe de puncte
  const on = idx.nearest(80, 2, 5, [], line.segs);
  assert.equal(on.kind, "n");
});

test("lista de componente: antet jos, poziția 1 lângă antet, Denumire aliniată la stânga", () => {
  const rows = [
    { poz: "1", name: "Arbore", qty: "1", mat: "42CrMo4", obs: "" },
    { poz: "2", name: "Rulment 6205", qty: "2", mat: "", obs: "ISO 15" },
  ];
  const b = build({ type: "bom", p: [500, 400], rows, headerBottom: true }, S, measure);
  const t = b.prims.filter((p) => p.t === "T");
  const y = (txt) => t.find((p) => p.txt === txt).p[1];
  assert.ok(y("Poz.") > y("Arbore") && y("Arbore") > y("Rulment 6205"));
  // colțul dreapta-jos e ancora
  assert.ok(Math.abs(b.bbox[2] - 500) < 1 && Math.abs(b.bbox[3] - 400) < 1);
  // denumiri de lungimi diferite pornesc din același x (aliniere la stânga); „Buc.” e centrată
  const x = (txt) => t.find((p) => p.txt === txt).p[0];
  assert.ok(Math.abs(x("Arbore") - x("Rulment 6205")) < 1e-9);
  const qx = t.filter((p) => p.txt === "1" || p.txt === "2").map((p) => p.p[0] + p.tw / 2);
  assert.ok(qx.length >= 2);
});
