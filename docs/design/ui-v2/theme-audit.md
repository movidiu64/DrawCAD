# DrawCAD UI v2 — theme and icon audit (v1.1)

An audit of the dark theme and the header icons on branch `v1.1`, after the UI v2 phases: contrast of
every token pair that carries text or marks a control, the marks drawn on the white sheet, and icons
that could be read as something else. Findings with a fix are built in the same commit as this page;
the rest is listed under *Not done*.

Contrast is the WCAG 2.x ratio, computed from the token values in `frontend/css/app.css` and
`COLORS` in `frontend/js/view.js`. Text needs 4.5 : 1 (AA); the edge of a control and graphics that
carry meaning need 3 : 1 (SC 1.4.11).

## Text (passes, no change)

| Pair | Ratio |
|---|---|
| `--text` on `--bg` / `--panel` | 14.8 / 13.4 |
| `--text2` on `--panel` | 9.8 |
| `--muted` on `--panel` / `--bg` / `--panel2` | 7.0 / 7.8 / 6.8 |
| `--accent` on `--panel`; on `--accent-tint` | 8.1; 6.2 |
| `--accent-ink` on `--accent` (Export) | 8.9 |
| `--bad`, `--ok` on `--panel` | 8.0, 8.9 |
| status pairs (`--info` / `--warn-ink` / `--ok-ink` on their backgrounds) | 7.4 / 7.6 / 7.6 |

## Findings

| # | Finding | Measured | Fix |
|---|---|---|---|
| TH1 | Edges of fields (inputs, lists, text areas, the search field, the command line) were `--line` / `--line2`: a field barely separates from the panel | 1.5 – 1.7 : 1 | New `--field-line` #666f7a: 3.5 : 1 on `--bg`, 3.2 : 1 on `--panel` |
| TH2 | Hover was one step lighter than the panel, too little to see (the complaint Revit and AutoCAD users made about their dark themes) | `--raised` on `--panel` 1.13 : 1 | `--raised` #2b313a: 1.23 : 1; muted text on it still 5.7 : 1 |
| TH3 | A disabled primary button (Export with no document) was amber at 45 % opacity: it reads as a brown button, not as unavailable | — | Disabled primary turns neutral (`--raised`, `--muted` text) |
| TH4 | Grips were amber with a white edge: on the white sheet the edge disappears and amber alone is too faint | amber on white 2.0 : 1 | Grips keep the amber fill with a dark edge (`COLORS.gripEdge`) |
| TH5 | Tracking lines and acquired points (`snapMark` #3ccf8e) on the white sheet | 2.0 : 1 | #1f9d55: 3.5 : 1 on the sheet, 3.8 : 1 on the canvas |
| TH6 | The snap marker (`acquired` #e07b00) on the white sheet | 3.0 : 1 | #d06f00: 3.5 : 1 on the sheet, 3.8 : 1 on the canvas |
| TH7 | Keyboard focus in the rail's flyout and in header menus was only the hover background | 1.23 : 1 | A 2 px accent bar on the focused row; textareas and `[tabindex]` headings get the focus outline |
| TH8 | Header menus (Export, ⋯) opened under toasts | — | The header stacks above toasts |

## Icons

| Button | Was | Read as | Now |
|---|---|---|---|
| Settings | circle with eight rays | a sun: the light theme switch | a cog with eight teeth |
| Properties (tablet, phone) | three sliders | settings or filters | a window with a side panel |
| Hide the panels (Ctrl+0) | window with two columns | a layout or columns switch | four corners: more room for the drawing; the tooltip says "More room for the drawing" |
| Open | folder | — | unchanged |
| Undo / Redo, Close, Search, Export ▾ | — | — | unchanged |

On a phone, Redo, Open, Settings and Keys moved into a **⋯** menu (UI-D16): the header kept the
document, Undo, the panel and Export.

## Not done

- **Light theme** (UI-D15): built in v1.3 (V13-8); the note below is what was done first. The tokens make it a second set of values under
  `[data-theme="light"]`, but 16 overlay colours in `app.css` (`rgba(21, 24, 28, …)`, shadows) and
  `COLORS.canvasBg` / `tipBg` / `uiDark` in `view.js` are written for dark and need tokens first.
  The sheet is white in both themes; the canvas around it would be a light grey (#d9dde3 or so), and
  the selection amber needs the dark edge of TH4 everywhere.
- `COLORS.sel` (the amber selection halo) stays 2.0 : 1 on white: it is drawn under the annotation as
  a wide translucent band and is not the only cue (the grips and the panel show the selection).
- `hitMark` #f08c00 (highlight of text found by search) 2.5 : 1 on white: drawn as a filled band
  behind the text, not as a line; left as it is.

## Change log

| Date | Change | Summary |
|---|---|---|
| 2026-11-24 | major | First theme and icon audit on `v1.1`: TH1 – TH8 fixed, settings / properties / minimize icons, phone ⋯ menu; light theme listed with what it needs |
