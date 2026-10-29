import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, primsBBox } from "../js/annots.js";

const measure = (txt, s) => txt.length * s * 0.6;
const S = derive({});
const texts = (b) => b.prims.filter((p) => p.t === "T");

test("note: titlu, numerotare, rânduri goale sărite, chenar", () => {
  const a = { type: "note", p: [100, 100], title: "NOTE", text: "Prima notă\n\nA doua notă", numbered: true, frame: false };
  const t = texts(build(a, S, measure)).map((p) => p.txt);
  assert.deepEqual(t, ["NOTE", "1.", "Prima notă", "2.", "A doua notă"]);
  // fără chenar nu există poligon; cu chenar, chenarul cuprinde tot textul
  assert.equal(build(a, S, measure).prims.filter((p) => p.t === "P").length, 0);
  const framed = build({ ...a, frame: true }, S, measure);
  const frame = framed.prims.find((p) => p.t === "P");
  const bb = primsBBox(texts(framed));
  assert.ok(frame.p[0] <= bb[0] && frame.p[2] >= bb[2], "chenarul nu cuprinde textul pe lățime");
  // rândurile coboară
  const ys = texts(framed).map((p) => p.p[1]);
  assert.ok(ys[ys.length - 1] > ys[0]);
});

test("tabel de revizii: ancorat în colțul dreapta-jos, antet jos, cea mai nouă revizie sus", () => {
  const a = {
    type: "revtab", p: [500, 400], headerBottom: true,
    rows: [{ rev: "1", desc: "Cotă modificată", date: "29.10.2026", name: "OV" }, { rev: "2", desc: "Adăugat GD&T", date: "30.10.2026", name: "OV" }],
  };
  const b = build(a, S, measure);
  const bb = b.bbox;
  assert.ok(Math.abs(bb[2] - 500) < 1 && Math.abs(bb[3] - 400) < 1, `bbox ${bb}`);
  const yOf = (txt) => texts(b).find((p) => p.txt === txt).p[1];
  assert.ok(yOf("Rev.") > yOf("1"), "antetul trebuie să fie jos");
  assert.ok(yOf("1") > yOf("2"), "revizia 2 trebuie să fie deasupra reviziei 1");
  const top = build({ ...a, headerBottom: false }, S, measure);
  const yTop = (txt) => texts(top).find((p) => p.txt === txt).p[1];
  assert.ok(yTop("Rev.") < yTop("1"));
});

test("caracterele fără glifă sunt înlocuite consecvent", async () => {
  const { fontSafe } = await import("../js/annots.js");
  assert.equal(fontSafe("48…52 „HRC”"), '48...52 "HRC"');
  const b = build({ type: "text", p: [0, 0], text: "a…b" }, S, measure);
  assert.equal(texts(b)[0].txt, "a...b");
});
