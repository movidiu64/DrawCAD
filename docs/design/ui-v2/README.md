# DrawCAD UI v2 — design decisions

The goal is a calmer, denser CAD-style interface: more room for the drawing, one place for each kind of
information, the accent color only for state. Nothing here changes how tools, commands, annotations or
export work. The mockups change nothing in the app.

This folder holds everything the design canvas knows, so nobody needs the canvas (it is private) to
build a piece. If a board and this folder disagree, this folder wins: fix it in a docs-only change.

| File | What it holds |
|---|---|
| `README.md` | Layout, decisions with their status, phases, checks (this page) |
| `boards/*.png` | The boards, rendered from the canvas (see the list below) |
| `measurements.md` | Sizes, paddings, radii and type sizes taken from the mockups |
| `tokens.md` | Every mockup colour mapped to a token in `app.css` or `COLORS`, or marked "new" |
| `mockup/*.dc.html` | The board sources, for exact values; they need the canvas runtime to render |

## How to use this

- **Build to the structure, not the pixels.** Each phase is a separate PR that cites the decisions it
  implements (`UI-D3`, …) and the boards it was built from, with screenshots.
- **A deviation is allowed, with a reason** in the PR. Then this folder is changed and the decision
  logged, or the code is.
- Follow the `drawcad-ui`, `drawcad-i18n` and `drawcad-commands` skills: colors only as tokens, overlays
  only through `dialogs.js`, every new string with an English key.

| Binding | Flexible |
|---|---|
| Where each piece lives (rail, context bar, panel tabs, status bar, start screen) | Exact sizes, spacing and colours: use the tokens and the sizes already in `app.css` (`tokens.md`, `measurements.md` give the mockup values) |
| Which existing element or helper a piece reuses (ids, `showModal`, `Panel` methods, `exportDialog`) | Icons, where the mockup draws a new one |
| What each control does and which command it calls; keys and aliases from `TOOLS` / `DEFAULT_ALIASES` | Wording of hints and help text, within the i18n rules |
| The families in UI-D1, the panel tabs and what each tab holds | Hover and animation detail |
| The accent only for state and the primary action | Anything marked *check* until it is confirmed |

## Boards

| Board | What it shows |
|---|---|
| [Editor, properties](boards/editor-properties.png) | A Ø60 h7 dimension selected: rail, context bar, Proprietăți tab with the ISO 286 card, status bar |
| [Editor, dimension tool](boards/editor-dimension-tool.png) | Linear dimension active: the context bar with the tool's defaults |
| [Editor, ± tolerance](boards/editor-tolerance-pm.png) | The same dimension with a symmetric tolerance |
| [Editor, layers](boards/editor-layers.png) | Straturi tab: layers, drawing scale, printing, document |
| [Editor, annotations](boards/editor-annotations.png) | Adnotări tab: filter, type chips, list with the selected row |
| [Start](boards/start.png) | No document open: drop zone, quick commands, recent documents |
| [States](boards/states.png) | Command suggestions, rail flyout and tooltip, snap menu and markers, export dialog |

## Decision log

**Status:** *decided* builds as drawn. *planned* is shown on purpose and comes later. *check* is
decided in the design but needs confirming before it is built. *built* is on branch `v1.1`, with the
commit that built it.

| # | Decision | Status | Boards |
|---|---|---|---|
| UI-D1 | Tool rail, one slot per family, flyouts; **revised** by `research.md`: icon and label (72 px), icon-only as an option | built (e2dad48) | editor-*, states |
| UI-D1a | A slot shows the family member used last; one click runs it and opens the list, moving onto the drawing closes it | built (e2dad48, revised after testing) | states |
| UI-D1c | Hover with intent: 400 ms on a slot opens its list (no tool change); with a list open, hover switches families at once; 250 ms grace before closing on the drawing; option in Settings (NN/g and Baymard: hover delay against accidental opening and flicker) | built (v1.1) | — |
| UI-D1b | `calib` leaves the rail (K, `CALIB`, Calibrate in Straturi) | built (e2dad48) | editor-layers |
| UI-D2 | Context bar replaces the page-tab row; legend as a chip on the canvas | built (6f08861); tool defaults: text height (v1.1), tolerance of new dimensions (v1.5) | editor-properties, editor-dimension-tool |
| UI-D3 | Panel tabs Proprietăți / Straturi / Adnotări | built (b49c869) | editor-properties, editor-layers, editor-annotations |
| UI-D3a | The keys summary leaves the panel when a document is open | built (b49c869); on the start screen as a link to the Keys dialog | — |
| UI-D4 | Header: search field, icon buttons, Export split button; one document | built (5f27a88) | editor-* |
| UI-D4a | Several documents as tabs | built (v1.5): one document loaded at a time, the others kept as tabs (undo, page, zoom kept in the browser), max 8, hidden on a phone | editor-* (second chip) |
| UI-D5 | Status bar: wide command line, toggle chips | built (452f1cc) | editor-*, states |
| UI-D6 | Accent fill only for the primary action; `--accent-tint` for state; tabular figures for values (research F7) | built (452f1cc) | all |
| UI-D7 | Start screen: drop zone, a card on layers with the Keys link, recent documents as cards | built (5f27a88) | start |
| UI-D7a | Thumbnails of recent documents (needs a backend endpoint) | built (v1.5): `GET /api/doc/{id}/thumb`, cards as on the board, search by name | start |
| UI-D8 | Export dialog: PDF / DXF kept, one line per format, OCR stays a PDF option; toast with the file size | built (v1.1) | states |
| UI-D19 | Settings by scope: a section list on the left (Current document: Dimension style, Sheet and revisions; All documents: Interface, Commands and menu, Workspace), one pane at a time, a live preview of the dimension style; document panes take effect on Apply, app panes are saved at once | built (v1.1) | — |

## Layout

```
┌ header 44 px: brand · document (name, save state, close) · search field · undo/redo · zoom · settings · Export ▾ ┐
├ rail 72 px ┬ context bar 40 px: active tool · alias · hint · tool options ········ page tabs · pages ┬ panel 320 px ┤
│ icon slots │ canvas (legend chip bottom-left)                                                     │ tabs:         │
│ + flyouts  │                                                                                      │ Proprietăți   │
│            │                                                                                      │ Straturi      │
│            │                                                                                      │ Adnotări · n  │
├────────────┴ status 34 px: coordinates · command line (wide) · SNAP ▴ · URMĂRIRE · POLAR 15° · ORTHO · scale ──┤
```

## Decisions in detail

### UI-D1 — Tool rail: icons only, families in flyouts

- On desktop the rail uses the compact mode that already exists under `@media (max-width: 900px)`:
  icon-only `.tool` buttons, labels hidden, width 56 px. Group headers become thin dividers; groups are
  no longer collapsible.
- One rail button ("slot") per family; the other members are in a flyout next to the rail. The slot shows
  the member used last (stored per family in localStorage). Click = activate the shown tool; click on the
  already active slot, right-click or press-and-hold (300 ms, for touch) = open the flyout. A 5 px corner
  triangle marks slots with a flyout.

  | Group | Slot (default) → flyout members |
  |---|---|
  | Navigare | `select` · `pan` · `measure` |
  | Cote | `dimLin` → `dimAli`, `dimOrd` · `dimDia` → `dimDiaC`, `dimRad` · `dimAng` → `chamfer` · `lead` → `text` |
  | Toleranțe | `rough` · `gdt` · `datum` |
  | Documentare | `note` · `revtab` → `bom` |
  | Desen | `line` → `poly`, `rect` · `circle` → `arc`, `cross` · `hatch` → `break` |
  | Vederi | `section` → `detail`, `viewlabel`, `balloon` |
  | Revizie | `strike` · `white` → `ink` · `redact` |

  `calib` leaves the rail: it stays on key `K`, the `CALIB` command and the Calibrate button in the
  Straturi tab (UI-D3).
- Tooltip of a slot and of each flyout row: label, first alias, direct key (`Cotă liniară · DLI · D`).
  Flyout rows show the same three columns.
- Active state (UI-D6): `--accent-tint` background, 2 px inset accent bar on the left, accent icon.
- The flyout is part of the rail markup, positioned `absolute` inside `.body` (the rail itself scrolls, so
  a flyout inside it would be clipped). It is not a modal and not `position: fixed`. Esc, a click outside
  or choosing a tool closes it; arrow keys move inside it.
- Every tool keeps a `[data-tool=<id>]` button in the DOM (flyout rows included).
  `tools/e2e_smoke.py` clicks `[data-tool="cross"]`, which now lives in a flyout: open the flyout first in
  the test, or start the tool through the command line.
- Direct keys, aliases and the command line are unchanged.

### UI-D2 — Context bar replaces the page-tab row

- `#pageTabs` becomes the context bar. Left: icon and label of the active tool, a chip with its first
  alias and direct key, then the tool's hint (the text now written to `#stHint` and the panel intro). One
  line, ellipsis when it does not fit.
- For dimension tools, the defaults used by new dimensions as compact controls (the default tolerance from
  `defaultTol()`, text height `settings.textH`); changing them changes the document default, as the
  Settings dialog does today.
- Right: the existing page tabs (`[data-pg]`) and page operations (`[data-pgop]`), unchanged in behavior.
- The color legend ("Original: negru · Adăugat: albastru · Revizie: roșu") moves to a small chip in the
  bottom-left corner of `.viewport` (absolute, `pointer-events: none`), with color dots from the layer
  tokens.

### UI-D3 — Right panel with three tabs

- Tabs at the top of `.panel`: **Proprietăți**, **Straturi**, **Adnotări · n**. The tab is remembered in
  localStorage; selecting an annotation (canvas or list) switches to Proprietăți.
- **Proprietăți:** what `render()` shows today for a selection (`headHtml` + `html_<type>` + `footHtml`,
  or `groupHtml` for several). With nothing selected: a one-line "Nicio selecție" note with the active
  tool's options, not the document page.
- **Straturi:** the parts of `docHtml()` about the document: drawing scale with Calibrate, layers with
  counts and visibility, original-when-printing option, document info.
- **Adnotări:** `annListHtml()` with a text filter and type chips (Toate, Cote, GD&T, Revizii, Text,
  with counts). The list is no longer capped at 280 px; it fills the tab.
- The keys summary (`keysHtml()`) leaves the panel when a document is open; it stays in the intro (no
  document) and in the Keys dialog (`ALIASEDIT`).
- Phone (≤ 640 px): the bottom sheet keeps the tabs at its top.

### UI-D4 — Header

- Keep every id (`#btnClose`, `#btnUndo`, `#btnRedo`, `#btnZoomOut/In`, `#btnFit`, `#btnText`,
  `#btnSettings`, `#btnOpen`, `#btnExport`, `#btnPanel`).
- `#btnText` looks like a search field: magnifier, "Caută text în desen, OCR…", `Ctrl F` key cap.
- Settings and Open become icon buttons (`aria-label` and `title`). Export stays the one primary button;
  a chevron next to it (`#btnExportMenu`) opens a small menu (PDF / DXF) that calls
  `exportDialog(app, { fmt })` with the format preselected.
- The save state stays next to the document name.
- Several open documents as tabs: UI-D4a (v1.5), the editor still holds one document, the others are
  kept as tabs and loaded again when shown.

### UI-D5 — Status bar and command line

- Coordinates left; the command line takes the free width (`flex: 1`), placeholder
  "Comandă: L, C, DLI, TOL… apoi Space sau Enter", and a muted "ultima: XXX" at its right end
  (the last command that Space/Enter repeats).
- Snap, Urmărire, Polar, Ortho look like toggle chips (uppercase mono text; accent text on
  `--accent-tint` when on). Keep the existing checkboxes and ids (`#stSnap`, `#stTrack`, `#stPolar`,
  `#stOrtho`) for the code; style `label.chk:has(input:checked)` and hide the box visually. The snap
  menu chevron and the polar step select stay.
- `#stHint` is no longer shown on desktop (the hint is in the context bar, UI-D2); keep the element for
  the phone layout if it is still used there.

### UI-D6 — Visual rules

- New token `--accent-tint: rgba(242, 169, 59, 0.14)` for active tools, selected list rows and "on" chips.
  A full accent fill is used only for the primary button.
- Section labels 11 px uppercase `--muted` with 0.08em letter spacing; body 13 px; secondary 12 px.
  Values, aliases, keys and coordinates in `var(--mono)`.
- Segmented controls (`.seg`): neutral "on" state (`--line2`), not accent.
- Fonts stay `--sans` / `--mono` (system fonts). The mockup uses Inter and JetBrains Mono only because the
  canvas has no system fonts; do not add web fonts.
- Mockup texts, keys and numbers are illustrative; labels, keys and aliases come from `TOOLS` and
  `DEFAULT_ALIASES`.

### UI-D7 — Start screen (no document open)

- `.empty`: the drop zone and a small card side by side (quick commands: DLI, DDI, TOL, STR, Z, a link to
  the Keys dialog; the storage mode and retention note), the recent documents below as a card grid
  (name, pages, annotation count, last use, revision badge when the document has revisions).
- Thumbnails need a new endpoint (first page, small PNG, cached). That is a separate backend step
  following `drawcad-backend` (owner check, render limits, cache size). Until then the card shows the
  PDF / IMG badge where the thumbnail would be.

### UI-D8 — Export dialog

- Keep the PDF / DXF segmented control (`#eFmt`, `[data-fmt]`) and all current options; OCR stays an
  option of PDF. Add one line under the control that says what the chosen format is for.
- The success toast names the file and its size.

### UI-D19 — Settings by scope

- The old dialog mixed per-document style, per-browser preferences and the workspace code in one long
  page, with the scope written in each label. Now the scope is the structure: the left list has two
  groups, *Current document* and *All documents*, and each pane repeats its scope under its title.
- Document panes (Dimension style, Sheet and revisions) collect changes and apply them on **Apply**
  (disabled until something changes; it reads *Apply changes* then). *Use this style as the default
  for new documents* is shown only there.
- App panes (Interface, Commands and menu, Workspace) save at once, like the rail options already did;
  the radial menu no longer waits for Apply. The footer says so instead of showing the checkbox.
- Dimension style shows a Ø25k6 shaft dimension drawn with the pending choices, on paper, at a fixed
  zoom, so text height, ends, line width and the ISO 286 display can be compared before applying.
- The last pane is remembered (`cotare.stab`); the list is a `tablist` with arrow keys, Home and End.
  On a phone it becomes a scrolling row of tabs and the radial menu a two-column list in reading order.
- The modal sits above the header now (the header's z-index had put it over the backdrop) and on a
  phone toasts appear at the bottom, clear of the ⋯ menu.

## Phases

1. Rail and active state: UI-D1, UI-D6.
2. Context bar and legend chip: UI-D2.
3. Panel tabs: UI-D3.
4. Header, status bar, command line: UI-D4, UI-D5.
5. Start screen without thumbnails: UI-D7; then the thumbnail endpoint.
6. Export dialog: UI-D8.

## Check each phase

- `python tools/check_rules.py`, `cd frontend && npm test`, backend tests.
- `tools/e2e_smoke.py`: update selectors only where a decision moved an element (say which in the PR);
  look at `e2e_out/editor.png` and the dialog screenshots.
- Screenshots in Romanian and English at 1440 × 900, 1100 px (panel as drawer) and 390 px (phone).
- Keyboard: every control reachable with Tab, visible focus, `aria-label` on icon-only buttons,
  `aria-pressed` / `aria-selected` on toggles and tabs.
