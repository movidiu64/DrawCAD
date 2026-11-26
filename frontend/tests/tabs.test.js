import test from "node:test";
import assert from "node:assert/strict";
import { withTab, nextAfterClose, MAX_TABS } from "../js/app/tabs.js";

const d = (n) => ({ id: String(n).padStart(32, "0"), name: `d${n}.pdf`, kind: "pdf" });

test("a document opened from a tab goes right after it; an open one keeps its place", () => {
  let t = withTab([], d(1), null);
  t = withTab(t, d(2), d(1).id);
  t = withTab(t, d(3), d(1).id);
  assert.deepEqual(t.map((x) => x.name), ["d1.pdf", "d3.pdf", "d2.pdf"]);
  t = withTab(t, { ...d(2), name: "nou.pdf" }, d(3).id);
  assert.deepEqual(t.map((x) => x.name), ["d1.pdf", "d3.pdf", "nou.pdf"]);
});

test("at most MAX_TABS: the oldest other tab goes, never the current or the new one", () => {
  let t = [];
  for (let i = 1; i <= MAX_TABS; i++) t = withTab(t, d(i), t.length ? t[t.length - 1].id : null);
  t = withTab(t, d(99), d(1).id);
  assert.equal(t.length, MAX_TABS);
  assert.ok(t.some((x) => x.id === d(1).id) && t.some((x) => x.id === d(99).id));
  assert.ok(!t.some((x) => x.id === d(2).id));
});

test("closing a tab shows the one to its right, else to its left", () => {
  const t = [d(1), d(2), d(3)];
  assert.equal(nextAfterClose(t, d(2).id), d(3).id);
  assert.equal(nextAfterClose(t, d(3).id), d(2).id);
  assert.equal(nextAfterClose([d(1)], d(1).id), null);
  assert.equal(nextAfterClose(t, "x"), null);
});
