import test from "node:test";
import assert from "node:assert/strict";
import { nextRev, revName, revOfName } from "../js/revision.js";

test("next revision: numbers, letters, empty", () => {
  assert.equal(nextRev("1"), "2");
  assert.equal(nextRev("9"), "10");
  assert.equal(nextRev("A"), "B");
  assert.equal(nextRev("Z"), "AA");
  assert.equal(nextRev("b"), "c");
  assert.equal(nextRev("2a"), "2b");
  assert.equal(nextRev(""), "1");
  assert.equal(nextRev(null), "1");
});

test("file name: the suffix keeps its style, a name without one gets _revN", () => {
  assert.equal(revName("flansa", "1"), "flansa_rev1");
  assert.equal(revName("flansa_rev1", "2"), "flansa_rev2");
  assert.equal(revName("flansa_rev.3", "4"), "flansa_rev.4");
  assert.equal(revName("flansa-Rev 3", "4"), "flansa-Rev 4");
  assert.equal(revName("FLANSA_REV9", "10"), "FLANSA_REV10");
  assert.equal(revName("arbore rev B", "C"), "arbore rev C");
  // "rev" inside a word is not a suffix
  assert.equal(revName("brevet", "1"), "brevet_rev1");
  assert.equal(revOfName("brevet"), null);
  assert.equal(revOfName("piesa_rev12"), "12");
});
