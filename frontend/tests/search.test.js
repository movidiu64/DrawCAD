import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCommands, defaultKeyConfig } from "../js/commands.js";

const cfg = defaultKeyConfig();
const ids = (q, opts) => searchCommands(q, cfg, opts).map((c) => c.id);

test("command search: aliases first, then names in both languages, then descriptions", () => {
  assert.equal(ids("CMP")[0], "compare");
  assert.equal(ids("dli")[0], "dimLin");
  assert.equal(ids("compar")[0], "compare");
  // a word of the name, without diacritics
  assert.ok(ids("stampila").includes("stamp"));
  assert.ok(ids("raza").includes("dimRad"));
  // English names through the dictionary
  const en = { "Ștampilă": "Stamp", "Rază": "Radius" };
  assert.ok(ids("stamp", { en }).includes("stamp"));
  assert.ok(ids("radius", { en }).includes("dimRad"));
  // the description (hint): "arie" is in the Measure hint only
  assert.ok(ids("arie").includes("measure"));
  // extra items (settings pages)
  const extra = [{ id: "settings:sheet", kind: "settings", label: "Foaie și revizii", group: "Setări", key: "", aliases: [] }];
  assert.equal(ids("foaie", { extra })[0], "settings:sheet");
  // every word must match
  assert.deepEqual(ids("cerc zzzz"), []);
  assert.deepEqual(ids(""), []);
});
