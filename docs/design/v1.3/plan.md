# DrawCAD 1.3 — plan

Built on the `v1.3` branch, one phase per commit (or a few), `VERSION` = `1.3.0-dev.N`. Scope agreed on
2026-11-25 from the improvement plan and the items left over from 1.2 and UI v2.

| # | Phase | Status |
|---|---|---|
| V13-1 | `main.js` split by area into `js/app/*.js` | built |
| V13-2 | Page operations in undo / redo | built |
| V13-3 | ISO 2768-1 general tolerances | built |
| V13-4 | Measure: area and perimeter | built |
| V13-5 | Text at any angle, rotated linear dimension | built |
| V13-6 | Command search (Ctrl+K), shortcut sheet (? / F1), first-run tips | built |
| V13-7 | Revision compare: two-point alignment | built |
| V13-8 | Light theme | built |

Not in 1.3: ISO 286 above 500 mm, weld symbols (ISO 2553), offset / trim / extend, a symbol library,
CSV export, the performance items (scan vectorization, Windows worker process, cached drawing layer,
OCR in strips), documents as tabs, recent-document thumbnails, user accounts.

## V13-1 — `main.js` split · built

- `main.js` (≈ 5 000 lines, one `App` class) keeps the constructor and start-up. The methods move,
  unchanged, by section into `js/app/`: `state.js` (history, autosave, adding annotations), `mouse.js`,
  `keys.js` (keyboard and command line), `input.js` (typed points, dynamic input), `grips.js`,
  `edit.js` (erase, move / copy, copy / paste), `ui.js`, `contextbar.js`, `documents.js` (documents,
  text and OCR), `review.js` (compare, stamps, markup), `sheet.js` (title blocks, images), `radial.js`;
  module-level helpers in `util.js`.
- Each file exports a class; `main.js` copies its methods (descriptors, so getters stay getters) onto
  `App.prototype` in the old order, so `this` is still the app and nothing else changes.
- `tools/check_rules.py` and `tools/i18n_extract.py` scan `js/**`.

## V13-2 — Page operations in undo / redo · built

- Rotate, delete and reorder pages become history steps: Ctrl+Z / Ctrl+Y (and `U`, `REDO`) undo them
  like any other change. Today the guide says they cannot be undone.
- A history entry for a page operation holds the page state before it (order, rotations, the pages
  removed) and the annotations; undo sends the server the inverse state, redo the operation again.
  The uploaded file is never changed, so a deleted page can come back.
- Tests: backend (set page state, deleted page restored), e2e (rotate, delete, undo, redo; annotations
  back in place).

## V13-3 — ISO 2768-1 general tolerances · built

- Document setting (Settings → Sheet and revisions): general tolerance class **none / f / m / c / v**,
  and optionally the ISO 2768-2 class **H / K / L** (text only). Default for new documents: none; the
  user can save m (or mK) as default.
- Values (ISO 2768-1:1989): linear dimensions (Table 1), external radii and chamfer heights (Table 2),
  angular dimensions by the length of the shorter side (Table 3). Below 0.5 mm the standard gives no
  value: nothing is shown.
- A dimension without its own tolerance shows its general tolerance in the panel (for example
  "±0,3 mm · ISO 2768-mK · 30…120 mm"); *Write it on the dimension* turns it into an explicit
  ± tolerance (angles in degrees and minutes). Dimensions with their own tolerance or fit are left
  alone. Radii take Table 1, or Table 2 when marked as a broken edge. (The hover label was left out:
  the panel shows it as soon as the dimension is selected.)
- The title block's general-tolerances field and the default note text follow the class
  ("ISO 2768-mK").
- Tests: unit tests for every table row edge (3 / 3.0001, 6, 30, 120, 400, 1000, 2000, 4000), the
  missing values (f over 2000, v up to 3), angular minutes.

## V13-4 — Measure: area and perimeter · built

- `DI` / `MEASUREGEOM` gets the options of AutoCAD's MEASUREGEOM: **Distance** (today), **Area**:
  points one after the other (typed points and snaps work), Enter closes, or **Object**: click a
  closed drawn shape (rectangle, circle, closed polyline, hatch outline).
- The result in real units (drawing scale): area in mm² (and cm² above 10 000 mm²), perimeter in mm,
  shown in a toast and in the command history (F2).
- The measured outline stays highlighted until the next pick or Esc; nothing is added to the drawing.

## V13-5 — Text at any angle, rotated linear dimension · built

- Text gets an angle field (any value, degrees) beside Horizontal / Vertical (`TEXT R` already took
  any angle at creation). The rotate hot grip turns texts, stamps, dimensions and drawn shapes (line,
  polyline, hatch, circle, arc, break) by any angle; a selection with anything else (tables, symbols,
  GD&T, rectangles) still turns by quarter turns. Notes and leaders stay horizontal (ISO 129).
- Linear dimension: the **Rotated** option of DIMLINEAR (`R` at the first prompt, then the angle):
  the dimension measures along that direction, as AutoCAD's rotated dimension.
- PDF and DXF export keep the angle (DXF TEXT rotation, dimension geometry as today).
- The known limitation "annotations only horizontal or vertical" leaves the guide.

## V13-6 — Command search, shortcut sheet, first-run tips (UI-D9, UI-D14) · built

- **Ctrl+K** (and *Search* at the bottom of the rail): a search dialog near the top (overlays live in
  dialogs.js, so not at the cursor) that finds tools, actions and settings pages by name in Romanian
  and English, by alias and by description (the tool's hint); ↑ ↓ Enter runs, Esc closes. Ranking:
  exact alias, alias prefix, name prefix, a word of the name, the description (`searchCommands()`).
- **? / F1**: the shortcut sheet: keys and commands in columns by family, from `TOOLS`, the aliases
  and the user's own aliases, with a filter; link to the Keys dialog.
- First document opened: three tips (rail, command line, panel), one after the other, each with
  *Am înțeles*; shown once, reopened from the shortcut sheet.

## V13-7 — Revision compare: two-point alignment · built

- In the compare window, *Align with two points*: pick two points on the open page (with snap), then
  the same two points on the older revision, drawn in red over the page (its points snap to its own
  corners and ends). The older page is rendered at the matching resolution, then moved, turned and
  scaled (a similarity from the two pairs) so both pairs meet: an export at another scale or rotated
  lines up. One more pixel of tolerance covers the resampling.
- The automatic alignment stays the default; after two points it only refines by a few pixels.

## V13-8 — Light theme · built

- Settings → Interface → Theme: dark (default), light, as the system.
- The overlay colours in `app.css` became tokens (`--shade` for shadows, `--glass` behind floating
  labels, `--backdrop` behind dialogs); the light values are a second token set under
  `:root[data-theme="light"]`, and `COLORS_LIGHT` in `view.js` switches the canvas around the sheet,
  the tracking tip line and the symbol previews. The sheet stays white, so annotation and selection
  colors do not change. Text contrast in the light set: 5.2 : 1 or more (muted on the page background),
  field edges 3.7 : 1. The rule check accepts the two token blocks.

## Checks for every phase

`python tools/check_rules.py`, `cd frontend && npm test`, backend tests, `tools/e2e_smoke.py`,
`tools/security_smoke.py`; screenshots of what changed in both UI languages.
