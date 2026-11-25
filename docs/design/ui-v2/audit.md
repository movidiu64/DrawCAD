# DrawCAD UI v2 — audit and proposals (v1.1)

An audit of DrawCAD's interface and working experience on branch `v1.1`, compared with current CAD
apps, and the decisions that would follow from it. It extends the UI v2 package in this folder
(`README.md`, decisions UI-D1 … D8): those stay as they are, the new ones are UI-D9 … D16.

Nothing here is built yet. Status values as in `README.md`: *decided*, *planned*, *check*.

## Headline (estimate)

**≈ 50 % today, ≈ 71 % with UI-D1 … D8 built, ≈ 84 % with UI-D9 … D16 as well.**

The strengths are real and should stay: the command line with prompts and clickable options, the
radial menu on the right button, the grip menu, snap markers with labels, the hover label on the
canvas, the layer colours. What hurts is density and placement: 40 tools as labelled buttons in a
rail that scrolls (1 382 px of content in 820 px), the tool hint written twice (panel and status
bar), a status bar that wraps to two lines while a command runs, one long panel that mixes the
document, the active tool, the scale, the layers and a wall of shortcuts, and a phone layout whose
status bar is cut off.

## References

What each app does that matters for DrawCAD. Ideas only: no icons, colours, tokens or layout are
copied (SolidCraft's interface, icons, themes and tokens are under a separate brand licence that does
not allow use in another product).

| App | What it does | Taken for |
|---|---|---|
| CADCraft (AutoCAD-style, Rust, desktop and web) | Tool sets left, Layers and Properties right, command line at the bottom; prompts with clickable `[Keywords]`; Space cycles grip modes; status readouts truncate and show the full value in a tooltip; animation follows the OS setting; option to keep the system cursor | UI-D12 (no wrapping), UI-D15 (motion) |
| SolidCraft / Fusion (parametric) | Toolbar in tabs per workspace, contextual tabs while a command runs; right-click marking menu; S opens a toolbox at the cursor with search and favourites | UI-D9 (search at the cursor), UI-D10 (contextual actions) |
| SolidWorks | S opens the shortcut bar at the pointer, with *Search Commands* that finds and runs any command | UI-D9 |
| Onshape | S toolbar at the cursor, user picks which commands it holds | UI-D9, UI-D11 |
| Shapr3D | Adaptive UI: after a selection, the tools that fit it are offered first; command search; fixed and adaptive zones marked visually | UI-D10 |
| Plasticity | Command bar at the bottom with the common commands and F for command search | UI-D9 |
| AutoCAD | Ribbon or tool palettes; right-click shortcut menus; status bar toggles; Quick Properties | already covered (radial menu, UI-D5) |

Links: CADCraft README (github.com/storytold/cadcraft), SolidCraft README
(github.com/tangency-labs/solidcraft), Fusion "The Fusion interface" (help.autodesk.com),
SolidWorks "Shortcut Bar and Command Search" (help.solidworks.com), Shapr3D "Accessing tools" and
"Command Search" (support.shapr3d.com), Plasticity "Command Bar" (doc.plasticity.xyz).

## How this was measured

- **DrawCAD:** the running app at 1440 × 900, 1100 × 800 and 390 × 844, English UI, sample drawing
  `arbore_intermediar_rev0.pdf`, states: start, document open, Linear active, a dimension selected.
  Screenshots in `audit/`. Code read where a number is quoted (`main.js` tool rail, `dialogs.js`
  toast, `app.css`).
- **Percentages** are judgement, weighted by how often a drafter annotating a drawing meets each
  area. "With D1 … D8" assumes the existing UI v2 package built as written.

| Area | Weight | Today | With D1 … D8 | With D1 … D16 |
|---|---:|---:|---:|---:|
| Tool access (rail, families, search) | 20 % | 45 % | 70 % | 85 % |
| Feedback while working (hint, prompt, status, toasts) | 15 % | 45 % | 70 % | 85 % |
| Properties panel | 15 % | 50 % | 75 % | 85 % |
| Canvas and on-canvas UI | 10 % | 70 % | 75 % | 85 % |
| Start screen and documents | 10 % | 50 % | 75 % | 80 % |
| Discoverability and learning | 10 % | 45 % | 65 % | 85 % |
| Tablet and phone | 10 % | 45 % | 60 % | 75 % |
| Visual consistency and accessibility | 10 % | 60 % | 75 % | 85 % |
| **Total (weighted sum)** | 100 % | **≈ 50 %** | **≈ 71 %** | **≈ 84 %** |

Sums: today 9 + 6.75 + 7.5 + 7 + 5 + 4.5 + 4.5 + 6 = 50.25; with D1 … D8 70.75; with D1 … D16 83.5.

## Findings by area

### Tool access (≈ 45 %)

| Finding | Evidence |
|---|---|
| 40 tools, each a 2-column button with icon and label, in 7 collapsible groups; the rail scrolls (1 382 px of content at 900 px window height); Drawing, Views and Revision are below the fold | `now-tool.png`; `main.js` tool rail (`#tools`) |
| Collapsing groups saves room but hides tools; the state is per browser | `cotare.toolGroups` in localStorage |
| Tooltips give label and direct key, not the AutoCAD alias | `title="${t.label} (${t.key})"` |
| Radial menu on the held right button with 8 user-chosen commands: fast and already AutoCAD/Fusion-like | `mmenu.js` |
| No search at the cursor: a tool is found by scrolling the rail or by knowing its alias | — |

### Feedback while working (≈ 45 %)

| Finding | Evidence |
|---|---|
| The tool hint is written three times: panel ("Active tool"), status bar, and the command prompt | `now-tool.png` |
| With a command running the status bar wraps to two lines; "Scale 1:1" drops to a second row; at 1100 px the hint wraps to three lines | `now-tool.png`, `now-1100.png` |
| Toasts sit at `bottom: 46px`, over the status bar's hint and close to the command line | `app.css` `.toast` |
| The command line itself is good: prompt, option buttons, typed points, F2 history | — |

### Properties panel (≈ 50 %)

| Finding | Evidence |
|---|---|
| With nothing selected the panel is one long page: document, active tool and its hint, drawing scale, layers, printing option, annotation list, then the full shortcut list | `now-tool.png` |
| With a dimension selected: value, symbols, direction, tolerance, a large preview box (≈ 70 px high, the value in 36 px type), size with 9 preset buttons, layer — about two screens | `now-selection.png` |
| Accent fill used for ordinary "on" states (size 100 %, active tool), so the primary action does not stand out | `now-selection.png` |

### Canvas and on-canvas UI (≈ 70 %)

| Finding | Evidence |
|---|---|
| Strong: snap markers and labels, hover label of what a click would grab, grip menu, hot grips, selection cycling with Tab | v1.1 |
| The colour legend is plain text at the right of the page-tab row, far from the drawing | `now-tool.png` |
| The page-tab row is mostly empty (two tabs, three page buttons) | `now-tool.png` |

### Start screen and documents (≈ 50 %)

| Finding | Evidence |
|---|---|
| Drop zone in the middle; the language switch under it; the panel shows the whole shortcut list | `now-start.png` |
| Recent documents exist (`recentHtml`) but as a list; no annotation count or revision badge at a glance | `dialogs.js` |

### Discoverability and learning (≈ 45 %)

| Finding | Evidence |
|---|---|
| Shortcuts are one paragraph of text in the panel (≈ 30 entries in a run-on line) | `now-start.png` |
| No first-run guidance; the guide is in `docs/guide.md`, not reachable from the app except via Settings | — |

### Tablet and phone (≈ 45 %)

| Finding | Evidence |
|---|---|
| 390 px: the document name is cut to "a…", the status bar is cut off ("Tra…"), the rail takes a full-height column of icons | `now-phone.png` |
| 1100 px: panel as a drawer (good), status hint wraps to three lines | `now-1100.png` |

### Visual consistency and accessibility (≈ 60 %)

| Finding | Evidence |
|---|---|
| Colours as tokens, `:focus-visible` outline, `aria-label` on icon buttons | `app.css`, `index.html` |
| No `prefers-reduced-motion`; no light theme. Contrast is fine: `--muted` on `--panel` 7.0 : 1, on `--bg` 7.8 : 1 (AA needs 4.5 : 1) | `app.css` |

## Decisions

UI-D1 … D8 are in `README.md` and unchanged. New:

| # | Decision | Status |
|---|---|---|
| UI-D9 | Command search at the cursor | built in v1.3 (Ctrl+K, a dialog near the top) |
| UI-D10 | Selection actions in the context bar | built (6f08861) |
| UI-D11 | Rail you can trim | built (e2dad48) |
| UI-D12 | One-line status bar; toasts out of the way | built (452f1cc) |
| UI-D13 | Compact properties: collapsible sections | built (b49c869) |
| UI-D14 | Shortcut sheet and first-run tips | built in v1.3 (? / F1) |
| UI-D15 | Motion, contrast, light theme | motion built (452f1cc); light theme built in v1.3 |
| UI-D16 | Phone and tablet layout | built (5f27a88) |

### UI-D9 — Command search at the cursor (*check*: the key)

- A small search box opens at the cursor (SolidWorks / Onshape "S", Shapr3D and Plasticity command
  search): type part of a name in Romanian or English, an alias or a key; the list shows icon, label,
  alias and key; Enter runs, ↑ / ↓ move, Esc closes. Recent commands first when the box is empty.
- Searches tools (`TOOLS`), actions (`ACTIONS`: export, settings, keys, zoom…) and settings pages, with
  `suggest()` from `commands.js` so the ranking matches the command line.
- **Key — check:** `S` is the direct key of Strike dimension and letters go to the command line in
  AutoCAD mode, so `S` cannot be used. Proposed: **Ctrl+K** (and a magnifier on the rail). The radial
  menu can offer it as one of its 8 positions.
- Reuses the command-line suggestion rendering; not a modal, positioned like the grip menu.

### UI-D10 — Selection actions in the context bar

- With a selection, the context bar (UI-D2) shows the actions that fit it (Shapr3D's adaptive tools,
  Fusion's contextual tabs), as buttons with the alias: for one dimension *Toleranță*, *Taie (STR)*,
  *Cotă în lanț de aici (DCO)*, *Mută (M)*, *Copiază (CO)*, *Șterge (E)*; for text *Editează*,
  *Mărime*; for several *Mută*, *Copiază*, *Șterge*, *Zoom la selecție*.
- Only existing commands; the panel keeps every property. The actions per type are a table in
  `panel.js` next to the type's HTML, so adding a type adds its actions in one place.

### UI-D11 — Rail you can trim

- Settings → *Bara de unelte*: a checkbox per family (UI-D1) to show or hide it on the rail; hidden
  tools still run from the command line, the radial menu and UI-D9. Default: all shown.
- Fusion-style workspaces (a rail per kind of work) were considered and left out: DrawCAD's families
  are few and one drawing mixes dimensions, tolerances and revisions.

### UI-D12 — One-line status bar; toasts out of the way

- The status bar never wraps: coordinates, command line (`flex: 1`), toggles, scale; any text that
  does not fit is cut with an ellipsis and shows in full in its `title` (CADCraft does the same).
- The tool hint lives in one place: the context bar (UI-D2), or the command prompt when the command
  line is in use. The panel's "Active tool" block and `#stHint` go on desktop.
- Toasts move to the top centre of the canvas, under the context bar, and never cover the command line
  or the prompt. Messages that belong to a command ("Cotă liniară adăugată: 38") go to the command
  history (F2) and the prompt line instead of a toast.

### UI-D13 — Compact properties

- Every panel section can be collapsed; the state is remembered per section name. Secondary sections
  start collapsed: *Aspect* (size, layer) for dimensions and symbols.
- Size: a stepper with a select of the presets instead of 9 buttons.
- The large tolerance preview goes (the canvas shows the dimension as it will print); the computed
  limits stay as the small ISO 286 card of board `editor-properties`.
- Accent only for state and the primary action (UI-D6): "on" segments and presets use `--line2`.

### UI-D14 — Shortcut sheet and first-run tips

- `?` or F1 opens a shortcut sheet: keys and commands in columns by family (from `TOOLS`,
  `DEFAULT_ALIASES` and the user's own aliases), with a filter field; it replaces the shortcut
  paragraph in the panel (UI-D3a) and links to the Keys dialog.
- First document opened: three small tips pointing at the rail, the command line and the panel, one
  after the other, each with *Am înțeles*; shown once (localStorage), reopened from the shortcut sheet.

### UI-D15 — Motion, contrast, light theme

- `prefers-reduced-motion`: no transitions on menus, flyouts and panels.
- Contrast stays as measured (`--muted` 7.0 : 1 on `--panel`); new tokens are checked the same way.
- `aria-live="polite"` on the command prompt, so a screen reader hears what the command asks.
- Light theme: *planned*. The sheet is white already; the interface would need a second token set.
  Not before the rest.

### UI-D16 — Phone and tablet

- ≤ 640 px: the rail becomes a bottom bar of family slots (UI-D1 flyouts open upwards); the status bar
  keeps the command line and moves the toggles into one *Snap ▴* menu; the document name truncates
  with the full name in the menu.
- Touch targets at least 40 × 40 px; the grip menu and radial menu open on long press (they do).
- 641 … 1100 px: as desktop with the panel as a drawer (today), plus UI-D12 so nothing wraps.

## Phases

Each phase is one PR on `v1.1`, cites the decisions it builds and has screenshots (RO and EN, 1440,
1100 and 390 px).

1. **Quick wins:** UI-D12, UI-D6, UI-D15 (motion, aria-live). Expected: feedback 45 → 65 %.
2. **Rail:** UI-D1 (icon rail, families, flyouts), UI-D11.
3. **Context bar:** UI-D2, UI-D10.
4. **Panel:** UI-D3 (tabs), UI-D13.
5. **Header, status, search:** UI-D4, UI-D5, UI-D9.
6. **Start and help:** UI-D7 (without thumbnails), UI-D14.
7. **Export and phone:** UI-D8, UI-D16.

## Checks

- `python tools/check_rules.py`, `cd frontend && npm test`, backend tests, `tools/e2e_smoke.py`
  (selectors updated only where an element moved, said in the PR).
- Keyboard: every control reachable with Tab, visible focus, `aria-pressed` / `aria-selected` on
  toggles and tabs; Esc closes every popover.
- Nothing in the drawing, export or commands changes; the command-parity tests stay green.

## Change log

| Date | Change | Summary |
|---|---|---|
| 2026-11-24 | minor | Phases 1–5 built on `v1.1` (UI-D1 as revised, D2–D7, D10–D13, D15 motion, D16, D17); still open: D9, D14, light theme (D8 and the context-bar defaults built after) |
| 2026-11-24 | major | First UI audit on `v1.1` (≈ 50 %); references CADCraft, SolidCraft / Fusion, SolidWorks, Onshape, Shapr3D, Plasticity; decisions UI-D9 … D16 and phases with UI-D1 … D8 |
