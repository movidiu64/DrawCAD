import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, angleSector, K, labelRuns } from "../js/annots.js";

// lățime aproximativă a textului: 0,6 em pe caracter (suficient pentru geometrie)
const measure = (txt, s) => txt.length * s * 0.6;
const S = derive({});
const mm = (x, y) => [x * K, y * K];

test("cotă liniară: valoarea măsurată ține cont de scară", () => {
  const a = { type: "dim", kind: "lin", orient: "h", p1: mm(10, 10), p2: mm(50, 30), p3: mm(30, 0), tol: { mode: "none" } };
  assert.equal(Math.round(build(a, S, measure).measured * 1000) / 1000, 40);
  const S2 = derive({ scale: 2 });
  assert.equal(Math.round(build(a, S2, measure).measured * 1000) / 1000, 80);
});

test("cotă aliniată măsoară distanța reală", () => {
  const a = { type: "dim", kind: "ali", p1: mm(0, 0), p2: mm(30, 40), p3: mm(0, 10), tol: { mode: "none" } };
  assert.equal(Math.round(build(a, S, measure).measured * 1000) / 1000, 50);
});

test("eticheta ISO cu abateri în paranteză", () => {
  const a = { type: "dim", prefix: "Ø", tol: { mode: "iso", fit: "k6", disp: "codeDev" } };
  const lab = labelRuns(a, S, measure, 25, "Ø");
  assert.deepEqual(lab.runs.map((r) => r.txt), ["Ø25k6", "(", "+0,015", "+0,002", ")"]);
});

test("cotă unghiulară: 30° și sectoarele vecine", () => {
  const v = mm(30, 150);
  const p1 = mm(70, 150); // orizontal spre dreapta
  const p2 = [v[0] + 40 * K * Math.cos(Math.PI / 6), v[1] - 40 * K * Math.sin(Math.PI / 6)]; // 30° în sus
  const inside = [v[0] + 25 * K * Math.cos(Math.PI / 12), v[1] - 25 * K * Math.sin(Math.PI / 12)];
  const a = { type: "ang", v, p1, p2, p3: inside, tol: { mode: "none" } };
  assert.equal(Math.round(build(a, S, measure).measured * 100) / 100, 30);
  // poziția arcului de partea cealaltă a laturii orizontale → suplementul (150°)
  const sup = [v[0] + 25 * K * Math.cos(Math.PI * 0.6), v[1] - 25 * K * Math.sin(Math.PI * 0.6)];
  assert.equal(Math.round((angleSector(v, p1, p2, sup).sweep * 180) / Math.PI * 100) / 100, 150);
  const lab = build({ ...a, tol: { mode: "pm", pm: 0.5 } }, S, measure).prims.filter((p) => p.t === "T").map((p) => p.txt);
  assert.deepEqual(lab, ["30°±0,5°"]);
});

test("textul care nu încape se mută în afara săgeților, cu linia prelungită", () => {
  const a = { type: "dim", kind: "lin", orient: "v", p1: mm(75, 82.5), p2: mm(75, 107.5), p3: mm(75, 95), prefix: "Ø",
    tol: { mode: "iso", fit: "k6", disp: "codeLim" } };
  const b = build(a, S, measure);
  const texts = b.prims.filter((p) => p.t === "T");
  // textul vertical urcă: totul trebuie să fie deasupra capătului de sus (y mai mic)
  const top = 82.5 * K;
  assert.ok(texts.every((t) => t.p[1] < top), "textul a rămas între săgeți");
  const fixed = build({ ...a, textShift: 0 }, S, measure).prims.filter((p) => p.t === "T");
  assert.ok(fixed.some((t) => t.p[1] > top), "textShift explicit trebuie respectat");
});
