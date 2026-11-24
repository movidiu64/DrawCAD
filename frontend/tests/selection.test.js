import test from "node:test";
import assert from "node:assert/strict";
import { clickSelection, windowSelection } from "../js/selection.js";

const S = (...ids) => new Set(ids);
const arr = (s) => [...s].sort();

test("DrawCAD selection: a click replaces, Shift toggles, a window replaces, Shift+window adds", () => {
  assert.deepEqual(arr(clickSelection(S("a"), "b")), ["b"]);
  assert.deepEqual(arr(clickSelection(S("a", "b"), "b")), ["a", "b"], "a click on the selection keeps it (to drag)");
  assert.deepEqual(arr(clickSelection(S("a"), "b", { shift: true })), ["a", "b"]);
  assert.deepEqual(arr(clickSelection(S("a", "b"), "b", { shift: true })), ["a"]);
  assert.deepEqual(arr(windowSelection(S("a"), ["b", "c"])), ["b", "c"]);
  assert.deepEqual(arr(windowSelection(S("a"), ["b"], { shift: true })), ["a", "b"]);
  assert.deepEqual(arr(windowSelection(S("a"), [], { empty: true })), []);
});

test("AutoCAD selection (PICKADD): a click or window adds, Shift removes, nothing clicked keeps", () => {
  const o = { pickadd: true };
  assert.deepEqual(arr(clickSelection(S("a"), "b", o)), ["a", "b"]);
  assert.deepEqual(arr(clickSelection(S("a", "b"), "b", { ...o, shift: true })), ["a"]);
  assert.deepEqual(arr(clickSelection(S("a"), "b", { ...o, shift: true })), ["a"], "Shift on an unselected one: nothing");
  assert.deepEqual(arr(windowSelection(S("a"), ["b", "c"], o)), ["a", "b", "c"]);
  assert.deepEqual(arr(windowSelection(S("a", "b", "c"), ["b", "c"], { ...o, shift: true })), ["a"]);
  assert.deepEqual(arr(windowSelection(S("a"), [], { ...o, empty: true })), ["a"]);
});
