import test from "node:test";
import assert from "node:assert/strict";
import { isoTemplate, templateFields, buildTblock, fieldValues, scaleText, sheetOf, cleanTemplate, templateFromItems } from "../js/tblock.js";
import { derive, K } from "../js/annots.js";

const measure = (txt, s) => txt.length * s * 0.6;

test("ISO 7200 template: 180 × 40 mm, the usual fields, the origin at the bottom-right corner", () => {
  const t = isoTemplate({ lang: "ro" });
  assert.equal(t.w, 180);
  assert.equal(t.h, 40);
  const f = templateFields(t);
  for (const k of ["titlu", "nr_desen", "material", "rev", "data", "scara", "format", "foaia", "autor", "firma"]) assert.ok(f.includes(k), k);
  for (const l of t.lines) for (const v of l.slice(0, 4)) assert.ok(v <= 1e-9 && v >= -180 - 1e-9, String(l));
  // a company name replaces the {firma} field
  assert.ok(!templateFields(isoTemplate({ company: "ACME" })).includes("firma"));
});

test("placed title block: fields filled, automatic values from the document", () => {
  const S = { ...derive({ revNo: "3", revDate: "24.11.2026", scale: 2 }), pagesWH: [[1191, 842], [842, 595]] };
  const a = { type: "tblock", p: [1150, 800], page: 0, tpl: isoTemplate({}), vals: { titlu: "Flanșă", nr_desen: "D-100" } };
  const v = fieldValues(a, S, { page: S.pagesWH[0], total: 2 });
  assert.equal(v.rev, "3");
  assert.equal(v.scara, "1:2");
  assert.equal(v.format, "A3");
  assert.equal(v.foaia, "1/2");
  const b = buildTblock(a, S, measure, { page: S.pagesWH[0], total: 2 });
  const txt = b.prims.filter((p) => p.t === "T").map((p) => p.txt);
  assert.ok(txt.includes("Flanșă") && txt.includes("D-100") && txt.includes("24.11.2026"));
  // nothing sticks out to the right of or below the corner
  for (const p of b.prims.filter((q) => q.t === "L")) assert.ok(p.p[0] <= 1150 + 1e-6 && p.p[1] <= 800 + 1e-6);
  assert.ok(Math.abs(b.snap.pts[2][0] - (1150 - 180 * K)) < 1e-6);
});

test("scale and sheet names", () => {
  assert.equal(scaleText(1), "1:1");
  assert.equal(scaleText(2.5), "1:2,5");
  assert.equal(scaleText(0.5), "2:1");
  assert.equal(sheetOf(595.3, 841.9), "A4");
  assert.equal(sheetOf(3370, 2384), "A0");
});

test("templates from files are cleaned; from the drawing the origin is the bottom-right corner", () => {
  const bad = cleanTemplate({ name: "x", w: 10, h: 5, lines: [[0, 0, -10, 0]], texts: [{ x: -5, y: -1, s: 2.5, txt: "{titlu}", onload: "alert(1)" }], logo: { data: "javascript:alert(1)", x: 0, y: 0, w: 1, h: 1 } });
  assert.equal(bad.logo, undefined);
  assert.deepEqual(Object.keys(bad.texts[0]).sort(), ["s", "txt", "x", "y"]);
  const t = templateFromItems([{ kind: "line", p: [100, 100, 200, 100] }, { kind: "text", p: [110, 90], txt: "{titlu}", h: 5 }]);
  assert.equal(t.lines[0][2], 0);
  assert.ok(t.texts[0].x < 0 && t.texts[0].y < 0);
});
