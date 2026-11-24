import test from "node:test";
import assert from "node:assert/strict";
import { qrMatrix, qrVersionFor } from "../js/qr.js";
import { build, derive, qrText, K } from "../js/annots.js";

const measure = (txt, s) => txt.length * s * 0.6;

test("QR: size by version, finder patterns in three corners, too long text refused", () => {
  assert.equal(qrMatrix("HELLO").length, 21);
  assert.equal(qrVersionFor(106), 6); // ISO/IEC 18004 table: 6-M holds 106 bytes, 7-M 122
  assert.equal(qrVersionFor(107), 7);
  const m = qrMatrix("Nr. desen: ACME-100\nRev: 2");
  const n = m.length;
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    assert.ok(m[y][x] && m[y + 6][x + 6] && !m[y + 1][x + 1] && m[y + 3][x + 3], `finder at ${x},${y}`);
  }
  assert.ok(m[n - 8][8], "the dark module");
  assert.throws(() => qrMatrix("x".repeat(1000)));
});

test("QR annotation: content from the document, one rectangle per run", () => {
  const S = derive({ revNo: "4", revDate: "01.12.2026" });
  const a = { type: "qr", p: [0, 0], size: 20, vals: { nr_desen: "D-7", extra: "" } };
  assert.equal(qrText(a, S), "Nr. desen: D-7\nRev: 4\nData: 01.12.2026");
  assert.equal(qrText({ ...a, vals: {} }, derive({ revNo: "1", dlang: "en" })), "Rev: 1");
  const b = build(a, S, measure);
  assert.ok(b.prims.length > 20 && b.prims.every((p) => p.t === "R"));
  assert.ok(Math.abs(b.bbox[2] - 20 * K) < 1e-6);
});

test("stamp: double frame around the word, date and name under it; turned", () => {
  const S = derive({});
  const a = { type: "stamp", p: [300, 300], text: "aprobat", color: "stGreen", date: "24.11.2026", name: "OV", angle: 0 };
  const b = build(a, S, measure);
  const t = b.prims.filter((p) => p.t === "T").map((p) => p.txt);
  assert.deepEqual(t, ["APROBAT", "24.11.2026 · OV"]);
  assert.ok(b.prims.every((p) => p.c === "stGreen"));
  const r = build({ ...a, angle: 15 }, S, measure);
  assert.ok(r.prims.filter((p) => p.t === "T").every((p) => p.a === 15));
});
