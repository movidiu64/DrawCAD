import test from "node:test";
import assert from "node:assert/strict";
import { commandList, conflicts, defaultKeyConfig, directKeyMap, resolveCommand, suggest } from "../js/commands.js";
import { TOOLS } from "../js/tools.js";

const D = defaultKeyConfig();

test("defaults: no duplicate keys or commands, every tool has at least one command", () => {
  const bad = conflicts(D);
  assert.deepEqual(bad.keys, {});
  assert.deepEqual(bad.aliases, {});
  assert.deepEqual(bad.reserved, []);
  for (const t of TOOLS) {
    const c = commandList(D).find((x) => x.id === t.id);
    assert.ok(c.aliases.length, t.id);
  }
});

test("AutoCAD commands: L, C, PL, REC, A, H, DLI, DDI, DRA, DAN, DAL, LE, TOL, E, U, Z", () => {
  const want = { L: "line", C: "circle", PL: "poly", REC: "rect", A: "arc", H: "hatch", DLI: "dimLin", DDI: "dimDiaC",
    DRA: "dimRad", DAN: "dimAng", DAL: "dimAli", LE: "lead", DDL: "dimDia", TOL: "gdt", E: "redact", U: "undo", Z: "fit", P: "pan", T: "text" };
  for (const [a, id] of Object.entries(want)) assert.equal(resolveCommand(a, D).id, id, a);
  assert.equal(resolveCommand("dli", D).id, "dimLin"); // lowercase letters
  assert.equal(resolveCommand("Cerc", D).id, "circle"); // by name
  assert.equal(resolveCommand("teșitură", D).id, "chamfer"); // with diacritics
  assert.equal(resolveCommand("XYZQ", D), null);
});

test("suggestions: the exact match first, then aliases starting the same way", () => {
  const s = suggest("D", D).map((c) => c.id);
  assert.ok(s.includes("dimLin") && s.includes("dimDia") && s.includes("measure"));
  assert.equal(suggest("C", D)[0].id, "circle");
  assert.equal(suggest("DL", D)[0].id, "dimLin");
  assert.equal(suggest("raz", D)[0].id, "dimRad");
});

test("direct keys: the old ones stay default; changes and duplicates are visible", () => {
  const m = directKeyMap(D);
  assert.equal(m.v, "select");
  assert.equal(m.l, "lead");
  assert.equal(m.y, "circle");
  const cfg = { mode: "direct", keys: { circle: "L" }, aliases: { line: ["C"] } };
  const bad = conflicts(cfg);
  assert.deepEqual(bad.keys.L.sort(), ["circle", "lead"]);
  assert.deepEqual(bad.aliases.C.sort(), ["circle", "line"]);
  assert.deepEqual(conflicts({ mode: "direct", keys: { circle: "F" }, aliases: {} }).reserved, ["F"]);
  // a removed key no longer starts anything
  assert.equal(directKeyMap({ mode: "direct", keys: { lead: "" }, aliases: {} }).l, undefined);
});

// A short acad.pgp written for this test (same format as AutoCAD's file, not a copy of it).
const PGP = `
;  Program Parameters File — test fixture
;  External command format: <Command name>,[<Shell request>],<Bit flag>,[*]<Prompt>,
CATALOG,  DIR /W,  8,File specification: ,
EDIT,     START EDIT, 9,File to edit: ,

;  Command alias format: <Alias>,*<Full command name>
L,        *LINE
LI,       *LINE
DLI,      *DIMLINEAR
DIMLIN,   *DIMLINEAR
CO,       *COPY
-LA,      *-LAYER
Z,        *ZOOM
ZZ,       *ZOOM
C,        *CIRCLE
C,        *COPY
CE,       *CIRCLE
DT,       *DTEXT
OSN,      *OSNAP   ; trailing comment
`;

test("acad.pgp: aliases parsed, comments and external commands skipped, the last definition wins", async () => {
  const { parsePgp } = await import("../js/commands.js");
  const e = parsePgp(PGP);
  const m = Object.fromEntries(e.map((x) => [x.alias, x.command]));
  assert.equal(m.L, "LINE");
  assert.equal(m.C, "COPY", "C is defined twice: the last one");
  assert.equal(m.OSN, "OSNAP");
  assert.equal(m.CATALOG, undefined);
  assert.equal(m.EDIT, undefined);
});

test("acad.pgp import: mapped by AutoCAD names, unknown commands listed, conflicts moved, keys kept", async () => {
  const { parsePgp, importPgp, commandList, conflicts, defaultKeyConfig, resolveCommand } = await import("../js/commands.js");
  const base = { ...defaultKeyConfig(), keys: { line: "Q" } };
  const res = importPgp(base, parsePgp(PGP));
  const al = (id) => commandList(res.cfg).find((c) => c.id === id).aliases;
  assert.ok(al("line").includes("LI"));
  assert.ok(al("dimLin").includes("DIMLIN"));
  assert.ok(al("fit").includes("ZZ"));
  assert.ok(al("circle").includes("CE"));
  assert.ok(al("text").includes("DT"), "DTEXT maps to the text tool");
  assert.ok(al("osnap").includes("OSN"));
  // C → COPY: COPY is unknown, so C stays on the circle
  assert.ok(al("circle").includes("C"));
  assert.ok(res.unknown.includes("COPY"));
  assert.ok(res.unknown.includes("-LAYER"));
  assert.deepEqual(Object.keys(conflicts(res.cfg).aliases), [], "no alias on two commands");
  assert.equal(res.cfg.keys.line, "Q", "direct keys are not touched");
  assert.equal(resolveCommand("LI", res.cfg).id, "line");
  // an alias of another command moves to the pgp's command
  const moved = importPgp(defaultKeyConfig(), [{ alias: "DI", command: "DIMLINEAR" }]);
  assert.deepEqual(moved.moved, [{ alias: "DI", from: "measure", to: "dimLin" }]);
  assert.equal(resolveCommand("DI", moved.cfg).id, "dimLin");
});

test("transparent commands: 'Z and 'OS resolve, a non-transparent one does not", async () => {
  const { resolveCommand, defaultKeyConfig } = await import("../js/commands.js");
  const cfg = defaultKeyConfig();
  assert.equal(resolveCommand("'Z", cfg).id, "fit");
  assert.equal(resolveCommand("'z", cfg).quoted, true);
  assert.equal(resolveCommand("'OS", cfg).id, "osnap");
  assert.equal(resolveCommand("'EXPORT", cfg), null);
  assert.equal(resolveCommand("'L", cfg), null, "tools are not transparent");
});
