import test from "node:test";
import assert from "node:assert/strict";

// the interface in English (i18n.js reads the language from storage)
globalThis.localStorage = { getItem: (k) => (k === "drawcad.lang" ? "en" : null), setItem() {}, removeItem() {} };
const { tr } = await import("../js/i18n.js");
const { TOOL_BY_ID, promptFor } = await import("../js/tools.js");

test("prompts with states in parentheses are translated piece by piece; names stay", () => {
  assert.equal(tr("Obiectul de decalat (10 mm)"), "Object to offset (10 mm)");
  assert.equal(tr("Obiectul de decalat (prin punct)"), "Object to offset (through)");
  assert.equal(tr("Punctul 2 (pe Y)"), "Point 2 (on Y)");
  assert.equal(tr("Punctul de inserție (Flanșă, 90°)"), "Insertion point (Flanșă, 90°)");
  // a whole pattern with a parenthesis still wins
  assert.equal(tr("Imagine prea mare (limita e 40 MB)"), "Image too large (the limit is 40 MB)");
});

test("every prompt of every tool comes out in English (no Romanian left)", () => {
  const ro = /[ăâîșț]|\b(punctul|sau|pe|prin|rotit|orizontal|gata)\b/i;
  const states = [{}, { orient: "h" }, { orient: "v" }, { rotA: 30 }, { axis: "x" }];
  for (const t of Object.values(TOOL_BY_ID)) {
    for (let n = 0; n < 4; n++) {
      for (const st of states) {
        const app = { clicks: Array(n).fill([0, 0]), cmdState: st, placing: false, offsetDist: t.id === "offset" ? 10 : undefined,
          currentSymbol: () => ({ name: "S1" }), symRot: 0, symScale: 1, defaultTol: () => ({ mode: "none" }), S: () => ({ h: 10 }) };
        let pr;
        try {
          pr = promptFor(t, app);
        } catch (_) {
          continue;
        }
        if (!pr) continue;
        for (const s of [pr.text, ...pr.opts.map((o) => o.label)]) assert.ok(!ro.test(tr(s)), `${t.id}: ${s} → ${tr(s)}`);
      }
    }
  }
});

test("messages made of a name and a state", () => {
  assert.equal(tr("Snap: pornit"), "Snap: on");
  assert.equal(tr("Urmărire: oprit"), "Tracking: off");
  assert.equal(tr("Intrare dinamică: oprită"), "Dynamic input: off");
});
