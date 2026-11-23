---
name: drawcad-annotations
description: Use when adding or changing a DrawCAD annotation — dimensions, tolerances, ISO 286 fits, GD&T frames, datums, roughness, line types, section/detail symbols, revisions, removals — or how annotations are exported. Covers the standards each one follows and the rule that the original PDF is never modified.
---

# DrawCAD annotations

## The model

- Annotations are JSON objects in `app.annots` (`type`, `page`, `layer`, points…), saved as the document
  state on the server. **The original PDF is never modified while editing**: annotations, removals and
  blackening are applied only on export (and previewed by rendering, not by changing the file).
- Coordinates: visual PDF points of the displayed page (y down, page rotation applied). `K` = points per mm.
  `settings.scale` = real mm per paper mm: values shown on the drawing are real mm (measured × scale);
  sizes of text and arrows are paper mm (ISO 3098 text height `settings.textH`).
- `build(a, S, measure)` in `frontend/js/annots.js` turns an annotation into `{ prims, bbox, handles, … }`
  through `BUILDERS[type]`. The same primitives are drawn on screen and sent to the export
  (`exportPrims` drops editor-only `ed` primitives), so screen and PDF match.
- A new type: builder in `BUILDERS`, `typeName` label, `SCALABLE` if it can be resized, point keys in
  `POINT_KEYS` (`frontend/js/pages.js`) so it follows page rotation / sheet size, `moveAnnot` /
  `setHandle` for editing, DXF export comes for free from the primitives. Add Node tests in
  `frontend/tests/`.

## Standards

- **ISO 286 (fits):** `frontend/js/iso286.js` + `iso286_data.js` (data from TechTools, validated against all
  limit deviations printed in ISO 286-2 up to 500 mm). Letters a–zc without t, v, y; grades IT1–IT18;
  JS/js = ±IT/2 without rounding to even; Δ for K…ZC in the fine grades. Never hand-edit the tables;
  never invent values outside 0 < D ≤ 500 mm — say the range is not covered.
- **Tolerance modes** (`a.tol.mode`): `none`, `pm` (±), `dev` (upper/lower deviation), `iso` (class with
  computed limits). Deviations are written in mm with at least 3 decimals.
- **ISO 1101 (GD&T):** the 14 characteristics in `GDT_SYMBOLS` (`gdt.js`) with the datum rule of each
  (form tolerances take no datum), modifiers in `MODIFIERS` (Ⓜ Ⓛ Ⓟ Ⓕ CZ…), frame row height = 2 × text height,
  leader to the feature or to the dimension line.
- **ISO 5459 (datums):** letters without I, O and Q (`DATUM_LETTERS` in main.js, `VIEW_LETTERS` in
  symbols.js for views).
- **ISO 1302 / ISO 21920-1 (roughness):** symbol variants (any process, removal, no removal), parameter
  (Ra, Rz…) above the long leg, on the surface or on a leader; surfaces seen from below or from the right
  need a leader.
- **ISO 128 (lines):** types and the width series in `shapes.js` (`LTYPES`, `WIDTHS` 0.13…1 mm); pattern
  lengths in multiples of the width d (ISO 128-20), dashes fitted to start and end with a full dash;
  ISO 128-44 for section planes and details, ISO 129 for dimension text orientation (readable from below or
  from the right), ISO 6433 balloons, ISO 7573 parts list (header at the bottom).

## Struck dimension vs removal

- **Struck dimension (`strike`, layer `rev`)** is a revision: the old value stays visible, struck through,
  with the new value and the revision triangle; it feeds the revision table. Use it when a value changes.
- **Removal (`redact`)** takes objects out of the original on export (objects mode, text only, or the whole
  zone with lines cut at its edge); **cover (`white`)** paints over without removing anything; **blacken
  (`ink`)** recolors original lines for printing. These are layer `del` and are the only things that touch
  the original — always on export, never in place.

## Check it

`cd frontend && npm test`; in the browser draw the annotation, move it, resize it, rotate the page, undo,
export PDF and DXF and look at the exported page (`tools/e2e_smoke.py` exports and renders one).
