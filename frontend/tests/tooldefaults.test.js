import test from "node:test";
import assert from "node:assert/strict";
import { Editing } from "../js/app/edit.js";
import { TOOL_BY_ID } from "../js/tools.js";

// the tolerance new dimensions take from the document default (context bar, UI-D2)
const tolFor = (tolDef, prefix) => Editing.prototype.defaultTol.call({ settings: { tolDef } }, prefix);

test("default tolerance: none, ± a value, a fit (not for radii)", () => {
  assert.deepEqual(tolFor(undefined, ""), { mode: "none" });
  assert.deepEqual(tolFor({ mode: "none" }, "Ø"), { mode: "none" });
  assert.deepEqual(tolFor({ mode: "pm", pm: 0.1 }, "R"), { mode: "pm", pm: 0.1 });
  assert.deepEqual(tolFor({ mode: "iso", fit: "H7" }, "Ø"), { mode: "iso", fit: "H7" });
  assert.deepEqual(tolFor({ mode: "iso", fit: "h6" }, ""), { mode: "iso", fit: "h6" });
  assert.deepEqual(tolFor({ mode: "iso", fit: "H7" }, "R"), { mode: "none" });
  assert.deepEqual(tolFor({ mode: "pm", pm: 0 }, ""), { mode: "none" });
});

test("new dimensions take it", () => {
  const app = { settings: { tolDef: { mode: "iso", fit: "H7" } } };
  app.defaultTol = Editing.prototype.defaultTol;
  const d = TOOL_BY_ID.dimDia.make([[0, 0], [10, 0], [20, 0]], app);
  assert.deepEqual(d.tol, { mode: "iso", fit: "H7" });
  const r = TOOL_BY_ID.dimRad.make([[0, 0], [10, 0], [20, 0]], app);
  assert.deepEqual(r.tol, { mode: "none" });
  app.settings.tolDef = { mode: "pm", pm: 0.05 };
  const l = TOOL_BY_ID.dimLin.make([[0, 0], [10, 0], [5, 8]], app);
  assert.deepEqual(l.tol, { mode: "pm", pm: 0.05 });
});
