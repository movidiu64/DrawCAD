import test from "node:test";
import assert from "node:assert/strict";
import { deviations, fmtDev, parseFit } from "../js/iso286.js";

// [nominal, câmp, abatere superioară, abatere inferioară] în µm, din tabelele ISO 286-2
const CASES = [
  [25, "H7", 21, 0],
  [30, "H7", 21, 0], // limită de interval: 30 aparține 18–30
  [50, "H7", 25, 0],
  [100, "H11", 220, 0],
  [25, "k6", 15, 2],
  [3, "k6", 6, 0],
  [40, "h6", 0, -16],
  [20, "g6", -7, -20],
  [30, "f7", -20, -41],
  [50, "e8", -50, -89],
  [40, "p6", 42, 26],
  [60, "s6", 72, 53],
  [70, "r6", 62, 43],
  [25, "m6", 21, 8],
  [25, "n6", 28, 15],
  [25, "K7", 6, -15],
  [25, "K6", 2, -11],
  [25, "M7", 0, -21],
  [25, "N7", -7, -28],
  [25, "P7", -14, -35],
  [25, "S7", -27, -48],
  [80, "R7", -32, -62],
  [2, "K7", 0, -10],
  [5, "K7", 3, -9],
  [5, "N7", -4, -16],
  [25, "F7", 41, 20],
  [10, "G7", 20, 5],
  [25, "js6", 6.5, -6.5],
  [25, "js7", 10.5, -10.5], // ISO 286-1:2010: ±IT/2, fără rotunjire la par
  [25, "JS7", 10.5, -10.5],
  [25, "M9", -8, -60],
  [25, "j6", 9, -4],
  [25, "j7", 13, -8],
  [20, "j5", 5, -4],
  [30, "u6", 61, 48],
  [50, "u6", 86, 70],
  [25, "J7", 12, -9],
  [25, "a11", -300, -430],
  [20, "x6", 67, 54],
  [2, "j8", 8, -6],
  [20, "U7", -33, -54],
];

for (const [D, fit, up, lo] of CASES) {
  test(`Ø${D} ${fit}`, () => {
    const r = deviations(D, fit);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.upper, up);
    assert.equal(r.lower, lo);
  });
}

test("câmpuri invalide", () => {
  assert.equal(parseFit("Js7"), null);
  assert.equal(parseFit("q7"), null);
  assert.equal(parseFit("t6"), null);
  assert.equal(deviations(600, "H7").ok, false);
  assert.equal(deviations(25, "H20").ok, false);
  assert.equal(deviations(40, "t6").ok, false); // t, v, y nu sunt incluse
  assert.equal(deviations(25, "j8").ok, false); // j8 doar până la 3 mm
  assert.equal(deviations(25, "J9").ok, false); // J9+ = JS
  assert.equal(deviations(25, "K9").ok, false); // K peste IT8 doar ≤ 3 mm
  assert.equal(deviations(25, "P2").ok, false); // alezajele cu Δ încep de la treapta 3
});

test("formatare abateri", () => {
  assert.equal(fmtDev(15), "+0,015");
  assert.equal(fmtDev(-21), "-0,021");
  assert.equal(fmtDev(0), "0");
  assert.equal(fmtDev(6.5), "+0,0065");
  assert.equal(fmtDev(250, "."), "+0.250");
});
