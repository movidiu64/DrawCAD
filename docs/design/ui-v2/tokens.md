# UI v2 — mockup colours mapped to DrawCAD tokens

Every colour used in `mockup/*.dc.html`, mapped to the token the implementation uses. The mockup
palette is slightly darker than the app's; **the tokens win** (the colour values are flexible, see
README). "new" means a token to add to `:root` in `frontend/css/app.css` (or to `COLORS` in
`frontend/js/view.js` for canvas drawing), with the role name given here.

## Interface (CSS tokens)

| Mockup colour | Used for | Token |
|---|---|---|
| `#111418` | app background, input and field fill | `--bg` |
| `#171b20` | header, rail, context bar, panel, status bar | `--panel` |
| `#1b1f25` | flyouts, menus, suggestions, dialog | `--panel2` |
| `#1f242b`, `#262c34` | raised: active document chip, zoom group, alias chip; hover | `--raised` |
| `#23272e` | canvas around the sheet | `--canvas` |
| `#2a3038` | thin borders, dividers, "on" state of segmented controls | `--line` (borders), `--line2` (`.seg button.on`, as today) |
| `#353c46` | stronger borders: menus, dialog, ghost buttons, key caps | `--line2` |
| `#e6e8eb` | main text | `--text` |
| `#b9c1cb` | secondary text, icon buttons | `--text2` |
| `#8f99a5` | labels, hints, muted values | `--muted` |
| `#f2a93b` | accent: active tool icon and bar, primary button, focus ring, on-chips | `--accent` |
| `#15181c` | text on the accent | `--accent-ink` |
| `#c9842a` | divider inside the Export split button | new `--accent-line` |
| `rgba(242,169,59,0.10…0.14)` | active tool, selected list row, on-chip fill | new `--accent-tint` (one value: 0.14) |
| `rgba(242,169,59,0.22…0.38)` | selection halo on the sheet (mockup only) | canvas: `COLORS.sel` with alpha, see below |
| `#7fd1a1` | "salvat" check, snap glyphs in the snap menu | `--ok` |
| `#f2c27a` | computed max / min sizes in the ISO 286 card | `--warn` |
| `#ff9b9b`, `rgba(239,68,68,0.14)` | revision badge text and fill (start screen) | `--bad`, `--bad-bg` |
| `#e6e8eb` dot | layer Original PDF (legend, Straturi tab) | `--layer-orig` |
| `#3b82f6` dot | layer Adăugate | `--layer-add` |
| `#ef4444` dot / icon | layer Revizii, revision triangle in the panel | `--layer-rev` |
| dashed `#8f99a5` | layer Ștergeri / acoperiri | `--layer-del` |
| `rgba(17,20,24,0.82)` | legend chip over the canvas | new `--chip-bg` |
| `rgba(0,0,0,0.45…0.55)` shadows | sheet, menus, dialog | keep the shadow values already in app.css |

## Sheet and canvas (`COLORS` in view.js)

The drawing in the mockup is an illustration; on the real canvas the existing colours apply.

| Mockup colour | Meaning | `COLORS` key |
|---|---|---|
| `#1a1a1a` | original drawing lines | the rendered PDF itself / `inkDefault` |
| `#1d4ed8` | added annotations | `add` |
| `#dc2626` | revision (struck value, new value, triangle) | `rev` |
| `#f2a93b` | grips of the selected annotation | `sel` |
| `#fcfcfa` | paper | `white` |
| `#16a34a` | snap marker (snap board) | `snapMark` |
| `rgba(242,169,59,0.38)` | halo under the selected annotation | new `selHalo` (only if the halo is built) |

The mockup fonts (Inter, JetBrains Mono) stand in for `--sans` / `--mono`: do not add web fonts.
