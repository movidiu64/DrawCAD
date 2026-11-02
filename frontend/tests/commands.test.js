import test from "node:test";
import assert from "node:assert/strict";
import { commandList, conflicts, defaultKeyConfig, directKeyMap, resolveCommand, suggest } from "../js/commands.js";
import { TOOLS } from "../js/tools.js";

const D = defaultKeyConfig();

test("implicit: fără dubluri de taste sau de comenzi, fiecare unealtă are cel puțin o comandă", () => {
  const bad = conflicts(D);
  assert.deepEqual(bad.keys, {});
  assert.deepEqual(bad.aliases, {});
  assert.deepEqual(bad.reserved, []);
  for (const t of TOOLS) {
    const c = commandList(D).find((x) => x.id === t.id);
    assert.ok(c.aliases.length, t.id);
  }
});

test("comenzile AutoCAD: L, C, PL, REC, A, H, DLI, DDI, DRA, DAN, DAL, LE, TOL, E, U, Z", () => {
  const want = { L: "line", C: "circle", PL: "poly", REC: "rect", A: "arc", H: "hatch", DLI: "dimLin", DDI: "dimDia",
    DRA: "dimRad", DAN: "dimAng", DAL: "dimAli", LE: "lead", TOL: "gdt", E: "redact", U: "undo", Z: "fit", P: "pan", T: "text" };
  for (const [a, id] of Object.entries(want)) assert.equal(resolveCommand(a, D).id, id, a);
  assert.equal(resolveCommand("dli", D).id, "dimLin"); // litere mici
  assert.equal(resolveCommand("Cerc", D).id, "circle"); // după nume
  assert.equal(resolveCommand("teșitură", D).id, "chamfer"); // cu diacritice
  assert.equal(resolveCommand("XYZQ", D), null);
});

test("sugestii: potrivirea exactă prima, apoi prescurtările care încep la fel", () => {
  const s = suggest("D", D).map((c) => c.id);
  assert.ok(s.includes("dimLin") && s.includes("dimDia") && s.includes("measure"));
  assert.equal(suggest("C", D)[0].id, "circle");
  assert.equal(suggest("DL", D)[0].id, "dimLin");
  assert.equal(suggest("raz", D)[0].id, "dimRad");
});

test("taste directe: cele vechi rămân implicite; modificările și dublurile se văd", () => {
  const m = directKeyMap(D);
  assert.equal(m.v, "select");
  assert.equal(m.l, "lead");
  assert.equal(m.y, "circle");
  const cfg = { mode: "direct", keys: { circle: "L" }, aliases: { line: ["C"] } };
  const bad = conflicts(cfg);
  assert.deepEqual(bad.keys.L.sort(), ["circle", "lead"]);
  assert.deepEqual(bad.aliases.C.sort(), ["circle", "line"]);
  assert.deepEqual(conflicts({ mode: "direct", keys: { circle: "F" }, aliases: {} }).reserved, ["F"]);
  // o tastă scoasă nu mai pornește nimic
  assert.equal(directKeyMap({ mode: "direct", keys: { lead: "" }, aliases: {} }).l, undefined);
});
