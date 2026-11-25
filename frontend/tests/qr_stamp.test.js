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

test("QR and title block stay upright under rotate / mirror; scale grows the QR side", async () => {
  const { rotateAbout, mirrorAbout, scaleAbout } = await import("../js/pages.js");
  const S = derive({});
  const center = (a) => {
    const b = build(a, S, measure).bbox;
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  };
  const near = (p, q) => assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6, `${p} vs ${q}`);
  const qr = () => ({ type: "qr", p: [100, 100], size: 20, vals: { nr_desen: "X" } });
  const c0 = center(qr());
  // a quarter turn about (0, 0): the center turns, the code stays the same square (not rotated)
  const r = rotateAbout(qr(), 90, [0, 0], S, measure);
  near(center(r), [-c0[1], c0[0]]);
  // mirror about x = 0: the center is mirrored, the code is not
  near(center(mirrorAbout(qr(), "v", [0, 0], S, measure)), [-c0[0], c0[1]]);
  // scale ×1.5 about its corner: 30 mm side, corner unchanged
  const s = scaleAbout(qr(), 1.5, [100, 100]);
  assert.equal(s.size, 30);
  assert.deepEqual(s.p, [100, 100]);
  const tb = { type: "tblock", p: [200, 300], tpl: { w: 180, h: 40, lines: [[0, 0, 180, 0, 1], [0, 40, 180, 40, 1]], texts: [] }, vals: {} };
  const t0 = center(JSON.parse(JSON.stringify(tb)));
  near(center(mirrorAbout(JSON.parse(JSON.stringify(tb)), "h", [0, 500], S, measure)), [t0[0], 1000 - t0[1]]);
  assert.equal(scaleAbout(JSON.parse(JSON.stringify(tb)), 2, [0, 0]).scale, 2);
});

test("area and perimeter of an outline and of closed shapes", async () => {
  const { polygonMetrics, closedOutline } = await import("../js/shapes.js");
  const m = polygonMetrics([[0, 0], [30, 0], [30, 20], [0, 20]]);
  assert.equal(m.area, 600);
  assert.equal(m.perimeter, 100);
  // clockwise or not, the area is positive
  assert.equal(polygonMetrics([[0, 0], [0, 20], [30, 20], [30, 0]]).area, 600);
  assert.deepEqual(closedOutline({ type: "shape", kind: "rect", pts: [[10, 10], [40, 30]] }).pts, [[10, 10], [40, 10], [40, 30], [10, 30]]);
  assert.equal(closedOutline({ type: "shape", kind: "circle", pts: [[0, 0], [3, 4]] }).r, 5);
  assert.equal(closedOutline({ type: "shape", kind: "poly", pts: [[0, 0], [1, 0], [1, 1]] }), null);
  assert.equal(closedOutline({ type: "shape", kind: "poly", closed: true, pts: [[0, 0], [1, 0], [1, 1]] }).pts.length, 3);
  assert.equal(closedOutline({ type: "dim" }), null);
});
