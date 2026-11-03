import test from "node:test";
import assert from "node:assert/strict";
import { build, derive, primsBBox } from "../js/annots.js";

const measure = (txt, s) => txt.length * s * 0.6;
const S = derive({});
const texts = (b) => b.prims.filter((p) => p.t === "T");

test("notes: title, numbering, empty lines skipped, frame", () => {
  const a = { type: "note", p: [100, 100], title: "NOTE", text: "Prima notă\n\nA doua notă", numbered: true, frame: false };
  const t = texts(build(a, S, measure)).map((p) => p.txt);
  assert.deepEqual(t, ["NOTE", "1.", "Prima notă", "2.", "A doua notă"]);
  // without a frame there is no polygon; with a frame, the frame encloses all the text
  assert.equal(build(a, S, measure).prims.filter((p) => p.t === "P").length, 0);
  const framed = build({ ...a, frame: true }, S, measure);
  const frame = framed.prims.find((p) => p.t === "P");
  const bb = primsBBox(texts(framed));
  assert.ok(frame.p[0] <= bb[0] && frame.p[2] >= bb[2], "the frame does not enclose the text width");
  // rows go down
  const ys = texts(framed).map((p) => p.p[1]);
  assert.ok(ys[ys.length - 1] > ys[0]);
});

test("revision table: anchored in the bottom-right corner, header at the bottom, newest revision on top", () => {
  const a = {
    type: "revtab", p: [500, 400], headerBottom: true,
    rows: [{ rev: "1", desc: "Cotă modificată", date: "29.10.2026", name: "OV" }, { rev: "2", desc: "Adăugat GD&T", date: "30.10.2026", name: "OV" }],
  };
  const b = build(a, S, measure);
  const bb = b.bbox;
  assert.ok(Math.abs(bb[2] - 500) < 1 && Math.abs(bb[3] - 400) < 1, `bbox ${bb}`);
  const yOf = (txt) => texts(b).find((p) => p.txt === txt).p[1];
  assert.ok(yOf("Rev.") > yOf("1"), "the header must be at the bottom");
  assert.ok(yOf("1") > yOf("2"), "revision 2 must be above revision 1");
  const top = build({ ...a, headerBottom: false }, S, measure);
  const yTop = (txt) => texts(top).find((p) => p.txt === txt).p[1];
  assert.ok(yTop("Rev.") < yTop("1"));
});

test("characters without a glyph are replaced consistently", async () => {
  const { fontSafe } = await import("../js/annots.js");
  assert.equal(fontSafe("48…52 „HRC”"), '48...52 "HRC"');
  const b = build({ type: "text", p: [0, 0], text: "a…b" }, S, measure);
  assert.equal(texts(b)[0].txt, "a...b");
});

test("multi-line text and leader", () => {
  const t = texts(build({ type: "text", p: [0, 100], text: "Rândul 1\nRândul 2", angle: 0 }, S, measure));
  assert.deepEqual(t.map((p) => p.txt), ["Rândul 1", "Rândul 2"]);
  assert.ok(t[1].p[1] > t[0].p[1], "the second line must be below the first");
  const v = texts(build({ type: "text", p: [0, 100], text: "A\nB", angle: 90 }, S, measure));
  assert.ok(v[1].p[0] > v[0].p[0], "for vertical text the lines advance to the right");
  const l = texts(build({ type: "lead", pts: [[0, 0], [50, -20]], text: "4× M8\n↧12", arrow: "arrow" }, S, measure));
  assert.deepEqual(l.map((p) => p.txt), ["4× M8", "↧12"]);
  assert.ok(l[1].p[1] > l[0].p[1] && l[1].p[1] < -20, "the last line sits on the shoulder, the first above it");
});

test("enlarging / shrinking an annotation", () => {
  const base = { type: "rough", target: [100, 100], pos: null, val: "Ra 1,6", kind: "remove", rot: 0 };
  const b1 = build(base, S, measure);
  const b05 = build({ ...base, scale: 0.5 }, S, measure);
  const h = (b) => b.bbox[3] - b.bbox[1];
  assert.ok(Math.abs(h(b05) / h(b1) - 0.5) < 0.02, `${h(b05)} / ${h(b1)}`);
  // the tip stays on the surface; the resize handle is in the corner opposite the anchor
  assert.ok(Math.abs(b05.bbox[3] - 100) < 1e-6);
  const sc = b1.handles.find((x) => x.k === "sc");
  assert.ok(sc && sc.p[1] < 100);
  // the revision table stays anchored in the bottom-right corner
  const rt = { type: "revtab", p: [500, 400], rows: [{ rev: "1", desc: "x", date: "29.10.2026", name: "OV" }], scale: 0.7 };
  const brt = build(rt, S, measure);
  assert.ok(Math.abs(brt.bbox[2] - 500) < 1 && Math.abs(brt.bbox[3] - 400) < 1);
  assert.ok(build({ ...rt, scale: 1 }, S, measure).bbox[1] < brt.bbox[1], "at 70% the table is shorter");
});
