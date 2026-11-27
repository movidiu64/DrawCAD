# Commands v2: parity with AutoCAD for the command line, point entry and snaps

> **Measured:** 2026-11-24 · **Commit:** `d1b6ed75b8ae747abdd39a99f33fe607b30d3e50` (main, "Chain and
> baseline dimension series") · **Target:** AutoCAD for Windows as described in Autodesk's current
> online help (AutoCAD / AutoCAD LT 2026–2027); every AutoCAD row below can be checked in a local
> AutoCAD install. · **Status:** phases 1–5 built on branch `v1.1` (see "After v1.1").

This page measures how close DrawCAD's interaction is to AutoCAD's for the parts a drafter uses on
every pick: typing points, object snaps, tracking, dynamic input, the command line, grips, selection,
and keys and aliases. "The tool exists" is not enough: it has to take the same input, snap to the same
points and answer the same keys. The second half proposes the decisions (`CMD-D…`) and the phases to
close the gaps. The format follows CADCraft's `docs/ui-parity.md` (MIT / Apache-2.0); only the format
is borrowed, no text or code.

DrawCAD is not a CAD system: it annotates a fixed sheet (a PDF page or a scan). Where AutoCAD
behaviour only makes sense for model geometry (3D, UCS rotation, isometric snap, blocks), it is left
out of the measure and listed as *not applicable*.

**Headline (estimate): ≈ 42 % at the measured commit, ≈ 81 % on branch `v1.1`.** Snaps (11 running modes, tracking, extension, parallel, apparent
intersection), polar and ortho, the alias table with AutoCAD names and the command line with
autocomplete and history are real. Typed coordinates are missing entirely (no `x,y`, `@`, `<`, `#`),
the command line knows only command names (no prompts, no options, no typed points), there are no
typed snap overrides, no hot-grip modes and no MOVE / COPY with a base point.

## After v1.1 (branch `v1.1`) — estimate

Re-measured on branch `v1.1` after phases 1–5, the same way and with the same weights.

| Area | Weight | Before | v1.1 | What changed |
|---|---:|---:|---:|---|
| Point entry | 15 % | 15 % | 82 % | the whole typed syntax, typed first point, origin and UCS, typed box corners, FROM, M2P, .X / .Y, TK |
| Object snaps | 20 % | 60 % | 84 % | typed overrides, Tab cycling, Node as a mode, CEN from the edge, Geometric center, Insertion, snap on scans |
| Tracking, polar, ortho | 10 % | 60 % | 86 % | Shift toggles ortho; additional and relative polar angles, polar step; tracking along polar angles (option); TK |
| Dynamic input | 10 % | 35 % | 72 % | `@ # <` from anywhere, absolute points through the command line, the prompt and its options menu next to the cursor; length and angle at the cursor on a hot grip (Stretch, Move) |
| Command line | 15 % | 40 % | 77 % | prompts, options by letter or click (DCO / DBA Select, TEXT H / R, DIST M too), typed points, transparent commands, F2 |
| Grips and editing | 10 % | 30 % | 85 % | MOVE and COPY with base point and displacement; hot grips (Space: Stretch / Move / Rotate / Scale / Mirror, Base point, Copy, typed points and values); grips on up to 100 selected annotations, several hot grips with Shift; dimensional input on hot grips; grip menu (modes, add / remove vertex) |
| Selection | 10 % | 40 % | 83 % | Select objects prompt (W, C, F, WP, CP, ALL, L, P, R, A), AutoCAD selection option, selection cycling with Tab |
| Keys and aliases | 10 % | 55 % | 75 % | acad.pgp import, F2, E = ERASE |
| **Total (estimate)** | 100 % | ≈ 42 % | **≈ 81 %** | |

The total is the weighted sum of the rows (0.15 × 82 + 0.20 × 84 + 0.10 × 86 + 0.10 × 72 + 0.15 × 77 +
0.10 × 85 + 0.10 × 83 + 0.10 × 75 = 80.75). The previous revision gave ≈ 76 % with grips at 45 %, which
sums to 73.85: it was overstated by about two points.

Still missing: lasso (press-drag is the rectangle here, by design); X / Y pointer-input boxes for the first point (left out on purpose:
typed in the command line instead).

## How this was measured

- **DrawCAD:** read from the source at the commit above: `frontend/js/commands.js`, `main.js`,
  `osnap.js`, `tools.js`, `dialogs.js` (plus `backend/app/pdfcore.py` for where snap geometry comes
  from). Behaviour confirmed where `tools/e2e_smoke.py` exercises it. Not run by hand in this pass.
- **AutoCAD:** Autodesk's online help (command reference, "About Coordinate Entry", "About Entering
  2D Cartesian Coordinates", "To Specify Relative or Absolute Coordinates in the Dynamic Input
  Tooltip", DIMLINEAR, "About Creating Command Aliases"; links at the end). Rows marked **verify**
  are from memory of AutoCAD's behaviour and should be checked in a running AutoCAD.
- **Percentages** are judgement, not counts: each area's rows are weighed by how often a drafter
  annotating a drawing hits them.

| Area | Weight | DrawCAD | Weighted |
|---|---:|---:|---:|
| Point entry | 15 % | 15 % | 2.3 |
| Object snaps | 20 % | 60 % | 12.0 |
| Tracking, polar, ortho | 10 % | 60 % | 6.0 |
| Dynamic input | 10 % | 35 % | 3.5 |
| Command line | 15 % | 40 % | 6.0 |
| Grips and editing | 10 % | 30 % | 3.0 |
| Selection | 10 % | 40 % | 4.0 |
| Keys and aliases | 10 % | 55 % | 5.5 |
| **Total (estimate)** | 100 % | | **≈ 42 %** |

## Point entry (≈ 15 %)

DrawCAD works in visual PDF points (1/72 in), origin at the top-left corner of the displayed page, Y
down. `settings.scale` is "real mm per paper mm" (`annots.js` `DEFAULT_SETTINGS.scale`, 2 = drawing
at 1:2).

| Input | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| Pick with the mouse | yes | yes, with snap | `main.js:232` `toolClick`, `main.js:1316` `snapPoint` |
| Absolute `x,y` at the command prompt | yes, from the UCS origin | **no**: the command line only resolves command names; anything else is "Comandă necunoscută" | `commands.js:126` `resolveCommand`, `main.js:2318` |
| Relative `@dx,dy` | yes | **no** | — |
| Relative polar `@d<a` | yes | partly: the dynamic box takes L and ∠ relative to the last point (not as typed text) | `main.js:2077` `dynPoint`, `main.js:2110` `dynKey` |
| Absolute polar `d<a` | yes | **no** | — |
| `#x,y` (absolute when the tooltip defaults to relative) | yes, in dynamic input | **no** | — |
| `*x,y` (WCS) | yes | not applicable (no UCS) | — |
| Bare `@` (the last point) | yes | **no** | — |
| Direct distance entry (cursor direction + typed length) | yes, follows ortho / polar / tracking | yes: a typed L with the cursor's direction; the direction is the snapped cursor, so polar and ortho apply | `main.js:2077`, `main.js:2512` |
| First point typed | yes | **no**: dynamic input needs a previous click (`clicks.length`) | `main.js:2065` `dynTool` |
| Points of drag tools (strike, cover, remove, blacken) typed | yes for rectangles (RECTANG) | **no**: `kind: "rect"` tools are drag-only | `main.js:1557` |
| `FROM`, `M2P` / `MTP`, `TK`, point filters `.x .y` | yes | **no** | — |
| Angle override `<a` | yes | **no** (the ∠ field locks the angle, which is close) | `main.js:2110` |
| Typed snap override (`END`, `MID`, …) at a point prompt | yes | **no** (see Object snaps) | — |

**Gaps:** the whole typed-coordinate syntax; a typed first point; a defined origin; drag tools
without typed points.

## Object snaps (≈ 60 %)

Snap geometry comes from the original PDF page (segments, arcs, endpoints, midpoints, circle centers
from `pdfcore.snap_points`) and from the annotations already drawn (their handles, and the real
geometry of drawn shapes). On a scan there is no vector geometry, so only annotation points,
tracking and polar work.

| Mode | AutoCAD | DrawCAD (`osnap.js:6` `MODES`) | On a PDF | On a scan |
|---|---|---|---|---|
| Endpoint | every curve | `e`: segment ends from the PDF paths, arc ends (`osnap.js:241`, `:258`) | useful | no geometry |
| Midpoint | segments, arcs | `m`: segments (backend), arcs (`osnap.js:259`) | useful | no geometry |
| Center | arcs, circles, ellipses | `c`: arcs and circles, Bézier circles fitted by the backend (`osnap.js:257`) | essential (holes) | no geometry |
| Quadrant | circles, arcs | `q` (`osnap.js:260`) | useful | no geometry |
| Intersection | every pair, extended | `x`: segment × segment, segment × arc, arc × arc (`osnap.js:270`) | essential | no geometry |
| Apparent intersection | projected | `ax`: where two lines near the cursor would meet if extended (`osnap.js:306`) | useful (chamfered corners) | no geometry |
| Extension | dashed path from an end | `ext`: from acquired points along their line directions (`osnap.js:366`, `main.js:1412`) | useful | annotations only |
| Perpendicular | every curve, deferred | `p` to segments and arcs, from the last point (`osnap.js:332`); not deferred for the first point | useful | no geometry |
| Tangent | arcs, circles, deferred | `t` from the last point (`osnap.js:349`); not deferred | rare | no geometry |
| Nearest | every curve | `n` (`osnap.js:424`) | useful (leaders, roughness) | no geometry |
| Parallel | path through the last point | `par`: rest on a segment during a command, then move nearly parallel (`main.js:1380`, `osnap.js:366`) | useful | annotations only |
| Node | point objects, dimension definition points | partly: annotation points (kind `a`, "Punct de adnotare") always snap and cannot be turned off; PDFs have no point objects (`osnap.js:246`) | annotation points only | annotation points only |
| Geometric center | closed polylines | **no** | rectangles and closed outlines from the PDF | — |
| Insertion | text, blocks | **no** (PDF text has positions; not used for snap) | useful for struck values | OCR boxes could serve |
| Typed overrides (`END`, `MID`, `INT`, `NON` …) | yes | **no** | | |
| Shift / Ctrl + right-click snap menu | yes | **no**: right-click held opens the radial command menu (`main.js:160`, `main.js:1517`); the snap modes are in the status-bar menu (`main.js:1450`) | | |
| Tab cycles the candidates under the cursor | yes | **no**: Tab belongs to dynamic input (L ↔ ∠) | | |
| Marker, name tooltip, magnet | yes | marker per mode and a name label (`osnap.js` `LABELS`); aperture fixed at 10 px (`main.js:1316`) | | |
| Snap modes as a saved set, F3 toggle | yes (OSMODE) | yes: the menu ticks modes, saved in the browser; F3 toggles (`main.js:43`, `main.js:2462`) | | |

**Which make sense here.** On a vector PDF: all twelve; Center, Intersection and Endpoint carry
most dimensioning. Node only for annotation points (no PDF points). Geometric center and Insertion
are cheap wins (closed outlines and text runs are already parsed by the backend). On a scan: none of
the geometric modes until the scan is vectorized; the vectorizer used for DXF export
(`backend/app/vectorize.py`) could feed snap geometry, at a cost and with its accuracy (*check*).

**Gaps:** typed overrides, Tab cycling, a snap shortcut menu at the cursor, Node as a switchable mode,
Geometric center, Insertion, snaps on scans.

## Tracking, polar and ortho (≈ 60 %)

| Feature | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| Ortho, F8 | yes | yes | `main.js:2462` |
| Shift while held | toggles ortho (on when off, off when on) | **forces ortho on**; does not turn it off | `main.js:1319` |
| Polar increment, F10 | yes, list of increments | yes, select in the status bar (5–90°) | `main.js:1477`, `osnap.js:376` |
| Additional polar angles, relative to the last segment | yes | **no** | — |
| PolarSnap (distance steps along the path) | yes | **no** | — |
| Ortho and polar exclusive | yes | yes | `main.js:1477` |
| Object snap tracking, F11 | acquire by pausing on a snap point; up to 7 points; horizontal / vertical (or polar) paths; path × path | yes: hover 450 ms acquires or releases, 7 points at most, horizontal / vertical paths, path × path and path × object | `main.js:1380`, `main.js:1408`, `main.js:1418`, `osnap.js:366` |
| Tracking along polar angles (POLARMODE) | yes | **no**: tracking paths are horizontal and vertical only | `osnap.js:366` |
| Tooltip "Polar: d < a" | yes | coordinates in the status bar (Δx, Δy, L), snap name at the cursor | `main.js:2198` |
| Grid (F7), snap (F9) | yes | not applicable: the sheet is the reference | — |

**Gaps:** Shift semantics, additional / relative polar angles, PolarSnap, polar tracking paths.

## Dynamic input (≈ 35 %)

| Feature | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| On / off, F12 | yes | yes, remembered | `main.js:2448` |
| Pointer input (X, Y boxes) for the first point | yes | **no** (removed on purpose: L and ∠ only) | `main.js:2170` |
| Dimensional input (length, angle) for the next point | yes, Tab between the fields, lock icons | yes: L, Tab to ∠, the typed value stays locked | `main.js:2110`, `main.js:2170` |
| Relative by default, `#` for absolute, `@` for relative | yes (DYNPICOORDS) | relative only; no `#` / `@` | `main.js:2077` |
| Comma | separates X and Y | **decimal separator** (`12,5` = 12.5; chosen for Romanian users) | `main.js:2113` |
| Prompt next to the cursor with options (DYNPROMPT, ↓ for the menu) | yes | **no**: the hint is in the status line | `main.js:2025` |
| Dimensional input on grips | yes | **no** | — |

**Gaps:** typed absolute points, `#` / `@`, the prompt with options at the cursor, grip input. The
comma rule is a deliberate deviation (see CMD-D3).

## Command line (≈ 40 %)

| Feature | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| Type a command anywhere (AutoCAD mode) | yes | yes in "Comenzi AutoCAD" mode; in "Taste directe" mode Enter opens the line | `main.js:2518`, `main.js:2534` |
| Autocomplete: alias prefix, name, mid-string | yes, plus synonyms | alias prefix, label prefix, label substring from 3 letters; up to 12 | `commands.js:137` `suggest` |
| Enter / Space repeats the last command | yes | yes | `main.js:2349`, `main.js:2534` |
| History ↑ / ↓ | yes | yes, 50 entries kept in the browser | `main.js:2251`, `main.js:2354`, `main.js:2373` |
| F2 text window (prompts and messages) | yes | **no** | — |
| Prompts during a command (`Specify next point or [Undo]:`) | yes | **no**: the step is shown as a hint (`pas 2/3`) in the status line | `main.js:2025` |
| Options in the prompt, by letter or click | yes | **no** (see CMD-D5) | — |
| Typed points and values at the prompt | yes | **no**; numbers only through the dynamic box | `main.js:2512` |
| Transparent commands (`'Z`, `'P`, `'OS`) | yes | partly: actions (zoom, snap toggles) run during a command and do not cancel it, but there is no `'` prefix and they overwrite the repeat command | `main.js:2397` |
| Unknown command | message | toast "Comandă necunoscută: X" | `main.js:2318` |
| Esc cancels | yes | yes | `main.js:92` |
| Right-click = Enter during a command | configurable (shortcut menu or Enter) | short right-click = Enter for polylines and point series, Esc for other tools; held = radial menu; dragged = pan | `main.js:1517`, `main.js:1750`, `main.js:92` |

**Gaps:** prompts, options, typed points, `'` prefix, F2.

## Grips and editing (≈ 30 %)

| Feature | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| Grips on definition points, drag to stretch, with snap | yes | yes, for one selected annotation; the drag tip shows the measured value | `main.js:1988` `tryHandleDrag`, `main.js:1649` |
| Move by dragging the object | no (needs MOVE or a grip) | yes | `main.js:1919` |
| Resize | SCALE | box corners of the selection scale text and symbols | `main.js:1874` `edgeAt` |
| Hot grip: Space cycles Stretch / Move / Rotate / Scale / Mirror; Base point, Copy | yes | **no** | — |
| Several hot grips (Shift) | yes | **no** (grips only with one annotation selected) | `main.js:1907` |
| Multifunctional grip menus | yes | **no** (done in v1.1: modes, add / remove vertex) | — |
| MOVE / COPY / ROTATE / MIRROR with base point and displacement | yes | **no**; arrows nudge 0.5 mm (Shift 5 mm), Ctrl+C / V / D copy at the cursor | `main.js:2557`, `main.js:1104`, `main.js:1118` |
| Double-click edits | yes | yes: selects and focuses the first field in the panel | `main.js:1836` |

**Gaps:** typed displacement for moves and copies, hot-grip modes, grips on several objects.

## Selection (≈ 40 %)

| Feature | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| Pick | yes | yes | `main.js:1919` |
| Window (left → right), crossing (right → left) | yes | yes, blue / green | `main.js:1691`, `main.js:1802` |
| Click on another object | adds to the selection (PICKADD = 2) **verify** | replaces the selection | `main.js:1919` |
| Shift + click | removes from the selection **verify** | toggles (adds or removes) | `main.js:1919` |
| Select all | Ctrl+A, `ALL` at Select objects | Ctrl+A and the `ALL` command | `main.js:2397`, `main.js:2444` |
| Noun → verb (select, then command) | yes | only `E` (deletes the selection) and Delete | `main.js:2406`, `main.js:1093` |
| "Select objects:" prompt with W, C, F, WP, CP, L, P, R, A | yes | **no**: commands do not ask for a selection | — |
| Lasso, selection cycling | yes | **no** | — |
| Hover highlight | yes | yes | `main.js:2013` |

**Gaps:** a select-objects prompt (needed as soon as commands take selections), PICKADD behaviour,
lasso.

## Keys and aliases (≈ 55 %)

| Feature | AutoCAD | DrawCAD | Evidence |
|---|---|---|---|
| Aliases | about 250 in `acad.pgp` | 131 aliases over 58 commands (39 tools, 19 actions); AutoCAD names where an equivalent exists | `commands.js:9` `DEFAULT_ALIASES`, `commands.js:52` `ACTIONS` |
| Editing aliases | ALIASEDIT, edit `acad.pgp`, REINIT | Taste și comenzi dialog (`ALIASEDIT`): per command, comma-separated, duplicates blocked | `dialogs.js:751` `keysDialog`, `commands.js:163` `conflicts` |
| Load an existing `acad.pgp` | yes (alias editor: Load) | **no** (CMD-D10) | — |
| One-key tools | not by default | "Taste directe" mode: one key per tool, configurable | `commands.js:119` `directKeyMap` |
| F3, F8, F10, F11, F12 | yes | yes | `main.js:2448`, `main.js:2462` |
| F2, F7, F9, Ctrl+1 | yes | **no** (F7 / F9 not applicable) | — |
| Ctrl+Z / Y / C / V / A, Delete, Esc | yes | yes; Ctrl+D duplicates; Ctrl+S opens Export | `main.js:2444` |
| `E` with nothing selected | ERASE asks "Select objects:" | **starts "Șterge" (removal from the original, a drag tool)** | `main.js:2406`, `commands.js:47` |

**Gaps:** pgp import, F2, the meaning of `E` with nothing selected.

## Checks asked for

### 1. Coordinates: syntax, origin, scale

- **Today:** none of `x,y`, `@dx,dy`, `@d<a`, `d<a`, `#x,y` is accepted. The only typed point is the
  dynamic box's L / ∠, relative to the last click, in real mm (paper distance × `settings.scale`),
  Y up, angle counter-clockwise from +X (`main.js:2077`).
- **Origin today:** the status bar shows `X … · Y … mm` measured from the **top-left** corner of the
  displayed page, **Y down**, in **paper** mm, without the scale (`main.js:2198`), while Δx, Δy and L
  next to it are real mm. The two disagree on both axis direction and units.
- **What AutoCAD does:** absolute values are from the UCS origin, Y up. At the command line `x,y` is
  absolute and `#` is not needed; in the dynamic tooltip the first point is absolute and later points
  are relative by default, `#` forces absolute and `@` relative.
- **Proposal:** CMD-D1 (syntax), CMD-D2 (origin and units), CMD-D3 (where typed text goes), CMD-D4
  (first point).

### 2. Options in the prompt

AutoCAD prompts like `Specify dimension line location or [Mtext/Text/Angle/Horizontal/Vertical/Rotated]:`
take an option by its capital letter + Enter, or by a click on the option. DrawCAD has no prompt. The
options that would change something here:

| Command | AutoCAD options | Useful in DrawCAD | Why |
|---|---|---|---|
| DIMLINEAR (`DLI`) | Mtext, Text, Angle, Horizontal, Vertical, Rotated | **Text, Horizontal, Vertical** | today H / V is guessed from the cursor (`tools.js:8` `autoOrient`); Text sets the value before placing |
| DIMALIGNED, DIMDIAMETER, DIMRADIUS, DIMANGULAR | Mtext, Text, Angle | **Text** | same |
| DIMORDINATE (`DOR`) | Xdatum, Ydatum, Mtext, Text, Angle | **Xdatum, Ydatum** | forces the axis instead of guessing from the row position (`tools.js:104`) |
| DIMCONTINUE / DIMBASELINE (`DCO` / `DBA`) | Undo, Select | **Undo, Select** | Undo drops the last point; Select starts from an existing linear dimension, as AutoCAD does (DrawCAD's tools today are a point series, `tools.js:21`) |
| LINE (`L`) | Undo, Close | **Undo, Close** | the chain exists (`tools.js:186`); no way to undo one segment or close |
| PLINE (`PL`) | Arc, Close, Halfwidth, Length, Undo, Width | **Close, Undo** | arcs and widths are out of scope |
| CIRCLE (`C`) | 3P, 2P, Ttr; then Diameter | **Diameter, 2P** | today centre + point on the circle (`tools.js:198`) |
| RECTANG (`REC`) | Chamfer, Fillet, Width…; then Area, Dimensions, Rotation | **Dimensions** | typed length × width; today exact sizes only in the panel (`tools.js:194`) |
| ARC (`A`) | Center, End, Angle… | **Angle** | the three-point centre form exists (`tools.js:202`) |
| MLEADER / QLEADER (`LE`) | many | none for now | |
| TEXT / MTEXT (`T`) | Justify, Style; Height, Rotation | **Height, Rotation** | both exist in the panel |
| DIST (`DI`) | Multiple points | **Multiple** | sum of a chain of distances |
| ERASE (`E`) | selection keywords | **W, C, ALL, L** | see CMD-D12 |

### 3. Snaps

All twelve modes asked about are mapped in the table under Object snaps. Present as switchable
modes: Endpoint, Midpoint, Center, Intersection, Apparent intersection, Extension, Perpendicular,
Tangent, Nearest, Quadrant, Parallel (11). Node exists only as annotation points that are always on.
Missing and worth having on PDFs: Geometric center, Insertion. On scans no geometric mode works until
the scan is vectorized (CMD-D9).

### 4. Importing `acad.pgp`

- **Format** (Autodesk): one alias per line, `abbreviation,*command`, spaces allowed after the comma;
  `;` starts a comment; lines without `*` are external commands (not aliases); when the same
  abbreviation appears twice, the last one wins.
- **Mapping:** the long names are already in `DEFAULT_ALIASES` and `ACTIONS` (`LINE`, `DIMLINEAR`,
  `DIMORDINATE`, `ERASE`, `ZOOM`, `OPTIONS` …). A reverse index *every alias of a command → its id*
  maps `L,*LINE` to `line` and `DLI,*DIMLINEAR` to `dimLin`. One AutoCAD name may reach a DrawCAD
  command that differs (`ERASE` → `redact`; `DIM` → `dimLin` although AutoCAD's DIM is a combined
  command): the import report says so.
- **Unknown commands** (`*COPY`, `*LAYER`, `*-LAYER`, `*OFFSET` … most of the ~250) are skipped and
  listed, not stored, so a later DrawCAD version that adds the command picks them up on a new import.
- **Conflicts:** after merging, `conflicts()` (`commands.js:163`) must return empty `aliases`. Where an
  imported alias already belongs to another DrawCAD command, the import moves it (the pgp file wins,
  as in AutoCAD) and lists the move. Direct keys are not touched.
- **Where:** the Taste și comenzi dialog (`dialogs.js:751`) gets "Importă acad.pgp…" next to "Revino
  la implicit": a local file picker (the file is read in the browser, never uploaded), then a summary
  (added, moved, unknown) and the table updated; nothing is saved until Aplică.

## Decisions

**Status:** *decided* builds as written. *planned* comes later, in the phase named. *check* needs
Ovidiu's confirmation (behaviour in his AutoCAD, or a product choice) before it is built.

| # | Decision | Status | Phase |
|---|---|---|---|
| CMD-D1 | Point syntax parser: `x,y`, `@dx,dy`, `@d<a`, `d<a`, `#…`, `@`, plain distance | done (v1.1) | 1 |
| CMD-D2 | Drawing origin and units: bottom-left of the page, Y up, real mm; `UCS` / `ORIGIN` command | done (v1.1) | 1 |
| CMD-D3 | Where typed text goes during a command; the comma | done (v1.1) | 1 |
| CMD-D4 | Typed first point through the command line | done (v1.1) | 1 |
| CMD-D5 | Prompts with options in the command line | done (v1.1), with DCO / DBA Select, TEXT H / R, DIST M, and the prompt next to the cursor | 2 |
| CMD-D6 | Typed snap overrides (`END`, `MID` … `NON`), then `FROM`, `M2P` | done (v1.1) | 3 |
| CMD-D7 | Tab cycles snap candidates when nothing is being typed | done (v1.1) | 3 |
| CMD-D8 | Shift toggles ortho while held | done (v1.1) | 1 |
| CMD-D9 | Node as a mode; Geometric center and Insertion; snaps on scans | done (v1.1); scans as an option | 3 / 6 |
| CMD-D10 | Import `acad.pgp` in the Keys dialog | done (v1.1) | 4 |
| CMD-D11 | Transparent commands with `'` | done (v1.1) | 4 |
| CMD-D12 | `E` without a selection asks "Select objects:"; PICKADD option | done (v1.1) | 5 |
| CMD-D13 | MOVE / COPY with base point and typed displacement | done (v1.1) | 5 |
| CMD-D14 | Hot-grip modes, grip input, grips on several objects, several hot grips, grip menus | done (v1.1) | 6 |
| CMD-D15 | F2 history window with prompts and messages | done (v1.1) | 2 |
| CMD-D16 | Additional and relative polar angles, PolarSnap | done (v1.1) | 6 |

### CMD-D1 — Point syntax parser

- New pure module `frontend/js/pointin.js`: `parsePoint(text) →
  { kind: "abs" | "rel" | "polarAbs" | "polarRel" | "last" | "dist", x, y, d, a, forceAbs }` or `null`.
- Grammar, as in AutoCAD: `x,y` · `#x,y` · `@dx,dy` · `@d<a` · `d<a` · `#d<a` · `@` · a lone number
  (direct distance). Decimal point `.`; a leading `-` and `+`; spaces ignored; angle in degrees,
  counter-clockwise from +X; `@0,0` and `@` = the last point.
- `resolvePoint(parsed, { last, cursor, origin, scale })` → page point. Relative and polar values are
  real mm (`/ scale` to paper); absolute values are real mm from the origin (CMD-D2); direct distance
  uses the cursor direction from `last` (the snapped cursor, so ortho / polar / tracking apply).
- Errors: an unparseable entry keeps the command running and shows "Punct invalid: …" in the prompt.
- **Node tests (`pointin.test.js`):** every form parses; `12,5` is a point, not 12.5; `@10<90` goes up
  on screen (page Y decreases); `@` returns `last`; with `scale = 2`, `@10,0` moves 5 paper mm; `#x,y`
  and `x,y` give the same point; `@` forms without a last point return an error; garbage → `null`.

### CMD-D2 — Origin and units (*check*)

- **Origin:** the bottom-left corner of the displayed page, Y up, like a sheet in paper space. A
  `UCS` command (aliases `UCS`, `ORIGIN`) sets the origin to a picked point (typically the part's
  datum or the base of an ordinate set); `UCS` + `W` (World) resets it. The origin is stored per page
  in the document settings and follows page rotation and sheet-size changes like annotations
  (`pages.js` `rotateAnnot` / `scaleAnnot`).
- **Units:** every typed value is **real mm** (paper mm × `settings.scale`), absolute and relative
  alike, so `@25,0` on a 1:2 drawing makes a 25 mm dimension. The status bar shows X, Y from the
  origin, Y up, in real mm, the same units as Δx, Δy, L (`main.js:2198` changes).
- **Check:** is bottom-left / real mm what you expect in AutoCAD paper-space habits, or should
  absolute coordinates stay paper mm (independent of the scale) while relative ones are real mm?
- **Node tests:** origin after `UCS` → `0,0` resolves to the picked point; page rotation by 90° keeps
  the origin on the same drawing point; sheet resize scales it; status text uses the same numbers as
  `resolvePoint` (shared function, one test).

### CMD-D3 — Where typed text goes during a command (*check*)

- **Dynamic box (as today):** digits, `-`, `.` and `,` go to the L / ∠ box; comma stays the decimal
  separator there (the choice made for DrawCAD; L and ∠ never need a coordinate separator).
- **Command line:** any of `@ # <`, a letter, or a second number after a separator sends the text to
  the command line, which parses CMD-D1 syntax: there `,` separates X and Y and `.` is the decimal.
  With dynamic input off (F12), everything typed goes to the command line.
- Enter in the command line with a valid point = a click at that point; Enter with nothing typed = the
  same as today (finish / repeat).
- **Check:** is it acceptable that `12,5` means 12.5 in the box but X 12, Y 5 in the command line? The
  alternative is AutoCAD's rule everywhere (comma separates, point is decimal), which reverses the
  earlier decision for the box.
- **Node tests:** a pure router `routeKey(state, key) → "dyn" | "cmd"` for the listed cases.

### CMD-D4 — Typed first point

- At the first point of any point tool (`kind: "clicks"` and `"poly"`), the command line accepts
  CMD-D1 input (`@` forms relative to the last point of the previous command, as AutoCAD's LASTPOINT).
- Drag tools (`kind: "rect"`): two typed corners are accepted the same way (corner, then `@w,h`).
- **Node tests:** a typed first point plus a typed second point produce the same annotation as two
  clicks (via `TOOLS[…].make`); a rect tool from `x,y` and `@w,h`.

### CMD-D5 — Prompts with options

- Each tool step gets a prompt: `prompts: [{ text: "Primul punct", opts: [] }, …]` in `TOOLS`; the
  command line shows `Punctul următor sau [Anulează/Închide]:` with the options clickable.
- Option keys are **AutoCAD's English keyword letters** (`H`, `V`, `T`, `U`, `C`, `D`, `X`, `Y`, `S`),
  accepted in both UI languages; the label is translated and the key letter is shown in capitals, e.g.
  `[Text/Orizontal (H)/Vertical (V)]`. Option letters win over command aliases while a prompt is open.
- First set (from the table in check 2): DLI `T H V`, DAL / DDI / DRA / DAN `T`, DOR `X Y`, DCO / DBA
  `U S`, L `U C`, PL `U C`, C `D 2P`, REC `D`, A `A` (angle), T `H R`, DI `M`.
- **Node tests:** for each tool with options, the option ids are unique in its step; `resolveOption`
  maps a letter, a full word and a click id to the same option; an option letter does not start a
  command while a prompt is open; DLI + `H` makes `orient: "h"` whatever the cursor; L + `U` removes
  only the last segment; DOR + `X` gives `axis: "x"`.

### CMD-D6 — Typed snap overrides

- At a point prompt, `END`, `MID`, `CEN`, `QUA`, `INT`, `APP`, `EXT`, `PER`, `TAN`, `NEA`, `PAR`, `NOD`,
  `GCE`, `INS` and `NON` limit the next pick to that mode (or to none), then the running modes return.
  Long names (`ENDPOINT` …) and the `_` prefix are accepted.
- `FROM` (base point, then an `@` offset) and `M2P` / `MTP` (midpoint of two picks): done on `v1.1` (CMD-D6), same
  phase if time allows.
- **Node tests:** `parseOverride("mid")` → `m`; `Snapper.snap` with the override's single mode returns
  only that kind on a fixture with an end and a middle under the cursor; `NON` returns the raw point;
  the override is gone after one pick.

### CMD-D7 — Tab cycles snap candidates (*check*)

- With the cursor over several candidates and nothing typed in the dynamic box, Tab steps through
  them (Shift+Tab back); while a value is being typed, Tab keeps switching L ↔ ∠.
- Needs `Snapper.candidates(cur, o)` (sorted list) next to `snap()`.
- **Check:** confirm in AutoCAD that Tab cycles while the dynamic tooltip shows an empty field.
- **Node tests:** `candidates()` on a fixture returns each mode once, nearest first; the cycle wraps.

### CMD-D8 — Shift toggles ortho

- `ortho = cfg.ortho !== e.shiftKey` instead of `e.shiftKey || cfg.ortho` (`main.js:1319`): holding
  Shift turns ortho off when it is on, as in AutoCAD.
- **Node test:** the pure helper `orthoActive(cfg, shift)` for the four combinations.

### CMD-D9 — Node, Geometric center, Insertion, scans

- **Node (decided):** the annotation points (`a`) become a mode `node` ("Nod") in `MODES`, on by
  default, switchable in the snap menu.
- **Geometric center (done on `v1.1`):** the backend adds the centroid of closed paths (rectangles,
  outlines) as kind `g`.
- **Insertion (done on `v1.1`):** the backend adds PDF text-run origins as kind `i` (useful to place a
  struck value on the old one).
- **Scans (check):** use the vectorizer's lines and arcs as snap geometry for image pages, computed
  once per page in the background, with its accuracy limits shown in the snap menu.
- **Node tests:** with `node` off, annotation points do not snap; `g` and `i` points snap only when
  their mode is on (fixtures in `osnap.test.js`).

### CMD-D10 — Import `acad.pgp`

- Pure functions in `commands.js`: `parsePgp(text) → [{ alias, command }]` (comments, blank lines,
  external-command lines and malformed lines dropped; last definition of an alias wins) and
  `importPgp(cfg, entries) → { cfg, added, moved, unknown, invalid }`.
- Mapping through a reverse index of `DEFAULT_ALIASES` and `ACTIONS`; aliases must match
  `^[A-Z0-9]{1,16}$` (the dialog's rule, `dialogs.js:751`); names with `-` or `+` prefixes are unknown.
- Dialog: "Importă acad.pgp…" (file input, `.pgp`), a summary line and an expandable list of unknown
  commands; Aplică saves, Anulează discards.
- **Node tests (`commands.test.js`):** `L,   *LINE` → `line`; `;` comment ignored; external command
  line ignored; an alias defined twice keeps the last; an alias taken by another command moves and is
  reported; `*COPY` is unknown; after import `conflicts(cfg)` has no alias conflicts; direct keys
  unchanged; a real `acad.pgp` fixture (written for the test, not copied from Autodesk) imports
  without errors.

### CMD-D11 — Transparent commands

- `'Z`, `'ZS`, `'P`, `'OS`, `'OR`, `'POLAR` (and the same without `'` when a command is running) run
  without cancelling the command and without replacing the repeat command (`lastCmd`).
- `ACTIONS` get `transparent: true` for the ones allowed.
- **Node tests:** `resolveCommand("'Z")` resolves to `fit` with `transparent`; a non-transparent action
  typed during a command is refused with a message.

### CMD-D12 — `E` and selection (*check*)

- `E` / `ERASE` with nothing selected asks "Selectează obiectele:" (pick, window, crossing, `ALL`,
  `L` last, Enter to finish) and deletes annotations; the removal tool on the original keeps `X`,
  `STERGE`, `REDACT` and no longer answers to `E`.
- Option "Selecție ca în AutoCAD" (AutoCAD mode only): click adds to the selection, Shift+click
  removes.
- **Check:** confirm PICKADD = 2 behaviour in your AutoCAD, and that `E` should never start the
  removal tool.
- **Node tests:** `selectionReducer(sel, event, mode)` for click, Shift+click and window in both modes.
- **Selection cycling (v1.1):** in Select mode, over annotations on top of each other the tip shows
  `1/2 — Tab: next`; Tab changes which one is highlighted and the click takes that one. AutoCAD
  shows a list instead (SELECTIONCYCLING); Tab was chosen because it already cycles snaps here.
  e2e step 28.

### CMD-D13 — MOVE / COPY with a base point (done on `v1.1`)

- `M` / `MOVE` and `CO` / `COPY` on the selection: base point, then second point or a CMD-D1
  displacement; COPY repeats until Enter. Uses `moveAnnot` (`annots.js`) as today.
- **Node tests:** `@10,0` moves every selected annotation by 10 real mm; a hole table moves only its
  table (existing rule).

### CMD-D14 — Grips (done on `v1.1`)

- A click on a grip without dragging makes it hot (dragging still stretches, as before). Space,
  Enter, right click or an empty Enter in the command line cycle Stretch → Move → Rotate → Scale →
  Mirror; options B (base point), C (copy: each click leaves a copy, the grip stays hot), X (exit);
  Esc cancels. Points can be typed (`@dx,dy`, `@L<∠`, absolute, FROM …), relative to the base.
- Move, Rotate, Scale and Mirror apply to the whole selection; Stretch to the grip's annotation.
- **Rotate** turns in quarter turns only (the cursor's angle rounded to 90°, or typed degrees that
  must be a multiple of 90): annotations keep texts and symbols readable, as the page rotation does
  (`rotateAbout` in `pages.js` reuses `rotateAnnot`).
- **Scale:** the cursor's distance from the base when Scale starts is factor 1, or the factor is
  typed; points scale about the base, text and symbols with them (`scaleAbout`).
- **Mirror:** about a horizontal or vertical axis through the base, picked from the cursor's
  direction; texts stay readable, hatch angles flip (`mirrorAbout`).
- Grips show on every selected annotation up to 100 (AutoCAD's GRIPOBJLIMIT); with several selected
  the resize corners are left out. Shift+click makes grips hot (red, Shift+click again drops one);
  a click on one of them starts the hot grip, and Stretch moves all hot grips by the same
  displacement. A click elsewhere or a new selection drops them.
- Dynamic input on a hot grip in Stretch or Move: digits at the cursor give the length from the base,
  Tab the angle (locked, as for the next point of a line); Enter applies. In Rotate and Scale the
  digits go to the command line as the angle or factor. e2e step 30.
- **Grip menu** (AutoCAD's multifunctional grips): resting on a grip for 0.6 s opens a menu next to
  it with Stretch, Move, Rotate, Scale, Mirror (each starts the hot grip in that mode) and, on a
  vertex of a polyline or hatch, Add vertex (inserted halfway to the next vertex, then placed like a
  hot grip) and Remove vertex (while an open polyline keeps 2 and a closed one or a hatch keeps 3).
  `addVertex` / `removeVertex` in `shapes.js`, tested in `tests/shapes.test.js`; e2e step 31.
- Not offered: AutoCAD's Convert to arc and Lengthen (annotations here have no arc segments).
- **Tests:** `frontend/tests/pages.test.js` (translate, rotate, scale, mirror about a base);
  `tools/e2e_smoke.py` step 26 (Space → Move with `@0,-10`; Enter twice → Rotate 90) and step 27
  (two lines selected, Shift+click on a grip of each, `@5,0` stretches both).

### CMD-D15 — F2 history window (done on `v1.1`)

- F2 opens a panel with the commands, prompts, options chosen and messages of the session (the toasts
  that belong to commands), newest at the bottom.

### CMD-D16 — Polar extras (done on `v1.1`)

- Additional polar angles (a list in the snap menu), angles relative to the last segment, PolarSnap
  distance; tracking paths along polar angles.
- Tracking along polar angles is an option in the snap menu, off by default as in AutoCAD ("Track
  orthogonally only"). With it on, each acquired point also gets the polar angle nearest the
  cursor's direction (measured from 0°, not from the last segment), when polar is on.
- **`TK` (tracking)**, typed at any point prompt: the first tracking point, then each next one only
  horizontal or vertical from the previous (ortho is forced, picked or typed `@dx,dy` alike); Enter
  ends and the last one goes to the command. The path stays on screen while tracking.
- **Tests:** `tests/osnap.test.js` (tracking along 45° only with the option), `tests/pointin.test.js`
  (`TK`, `'TRACKING`), e2e step 29 (`TK 50,100 @20,0 @3,15 Enter @10,0` draws 70,115 → 80,115).

### CMD-D17 — OFFSET, TRIM, EXTEND (done on `v1.5`)

- **`O` / OFFSET:** asks the distance first (real mm, as typed lengths; `T` = Through; an empty Enter
  keeps the last one, remembered for the session), then repeats: pick a line, polyline, rectangle,
  circle or arc, then a point on the side of the copy. Polylines and rectangles keep sharp corners
  (AutoCAD's default gap type). A distance too large for the outline (a segment would turn around, a
  radius ≤ 0) is refused. The copy takes the source's style and goes right after it in the list.
- **`TR` / TRIM** and **`EX` / EXTEND** work as AutoCAD's Quick mode: no cutting-edge selection,
  every other drawn shape on the page and the drawing's own vector geometry (PDF lines, arcs and
  circles, or the vectorized scan) are edges. TRIM removes the picked part up to the nearest cuts; a
  shape that nothing crosses is erased whole; a circle becomes an arc, a rectangle or closed polyline an
  open polyline. EXTEND moves the end nearer to the pick (along the path) to the nearest boundary:
  lines, the end segments of open polylines, arcs along their circle. **Shift + click** swaps the two.
- **Fence:** a click beside the objects starts a line, a second click ends it; every drawn shape it
  crosses is trimmed at each crossing (EXTEND: the end nearer the crossing goes), in one undo step —
  AutoCAD's drag across objects, as two clicks.
- Objects are picked at the cursor without snap; OFFSET's side point snaps. The part that would go
  (TRIM, red dashed) or be added (EXTEND) is previewed under the cursor. `U` undoes the last change
  inside the command; Enter, right click or Esc ends.
- Edges are looked up only around the shape for TRIM (the drawing's grid), and the result is kept
  while the cursor stays on the same shape, so a page with 60 000 drawing lines stays fluid.
- Not yet: the Edge (extend to the apparent intersection) option, OFFSET
  Erase / Layer options, trimming hatches, dimensions or the PDF itself.
- **Code:** geometry in `js/modify.js` (pure, `tests/modify.test.js`), the commands in
  `js/app/modify.js` (tool kind `"pick"`); e2e step 18b.

### CMD-D18 — BLOCK / INSERT: own symbols (done on `v1.5`)

- **`B` / BLOCK:** on the selection (or after Select objects): a base point, then the name (free text:
  Space types a space at such prompts). The items are stored relative to the base point, without ids,
  pages or server images (images go in as data, ≤ 300 kB each); a symbol with the same name is
  replaced, as a redefined block. Types that belong to their drawing are left out (removal, cover,
  struck value, comment, origin, watermark, hole table).
- **`I` / INSERT:** places the chosen symbol at each click (with snap, the preview follows the cursor)
  until Enter / Esc; `L` opens the library, `R` sets the rotation (any angle when every item can
  turn freely, else the nearest quarter turn, as grips), `S` the scale; both are also in the context
  bar. The placed annotations are independent (exploded, in
  AutoCAD terms) and selected after placing, so grips rotate or scale them.
- Library in `localStorage` (`drawcad.symbols`), as the title blocks; files `.drawcad-sym.json` (one
  symbol or `{ kind: "drawcad-symbols", symbols }`), cleaned on import (known types only, image data
  only as PNG / JPEG / WebP data URLs, 2 MB per file).
- **Code:** `js/blocks.js` (pure, `tests/blocks.test.js`), `js/app/blocks.js`, `symbolDialog` in
  `dialogs.js`; e2e (B, I, L after the rectangle step).

## Phases

1. **Points:** CMD-D1, D2, D3, D4, D8. Point input from the command line, origin and units, Shift.
   Expected: point entry 15 % → 65 %, dynamic input 35 % → 45 %.
2. **Prompts:** CMD-D5, D15. Expected: command line 40 % → 70 %.
3. **Snaps:** CMD-D6, D7, D9 (Node). Expected: object snaps 60 % → 75 %.
4. **Aliases:** CMD-D10, D11. Expected: keys and aliases 55 % → 75 %.
5. **Selection and edit commands:** CMD-D12, D13. Expected: selection 40 % → 60 %, grips and editing
   30 % → 45 %.
6. **Later:** CMD-D9 (Geometric center, Insertion, scans), D14, D16.

After phases 1–5 the same weights give about **≈ 65 %** (estimate).

## Check each phase

- `python tools/check_rules.py`, `cd frontend && npm test`, backend tests, `tools/e2e_smoke.py`
  (add one typed-point step per phase: `L`, `0,0`, `@20,0`, `@20<90`, Enter).
- Every new prompt and option string in Romanian with its English key (`drawcad-i18n`); options and
  keys follow `drawcad-commands`.
- The AutoCAD rows marked **verify** and the *check* decisions are confirmed by Ovidiu in his AutoCAD
  before the phase that depends on them.

## Sources

- Autodesk, [About Coordinate Entry](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-0A0135DB-3216-482B-81DD-74E6DB8CA3E3.htm)
- Autodesk, [About Entering 2D Cartesian Coordinates](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-F64F8008-E1C0-49CC-A268-A6B8C6E9B566.htm)
- Autodesk, [To Specify Relative or Absolute Coordinates in the Dynamic Input Tooltip](https://help.autodesk.com/cloudhelp/2015/ENU/AutoCAD-LT/files/GUID-AE225073-2ECD-41CC-9B8A-61743E8CFBA9.htm)
- Autodesk, [Coordinate Entry with Dynamic Input](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DidYouKnow/files/GUID-683349C0-E5C2-4E16-8846-5523E71172A9.htm)
- Autodesk, [DIMLINEAR (Command)](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-E908848F-4621-43D2-B377-FD3FBC2B8848.htm)
- Autodesk, [About Creating Command Aliases](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-LT/files/GUID-FE9AE544-F537-4D3B-8F75-B76484513787.htm), [Command Aliases, Shortcut Keys, and AutoCorrect](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DidYouKnow/files/GUID-D2B4BF16-B1F7-4EF2-89AF-88ACE85FAD73.htm)
- CADCraft, `docs/ui-parity.md` (format only), github.com/storytold/cadcraft

## Revision history

| Date | Change | Summary |
|---|---|---|
| 2026-11-26 | minor | BLOCK / INSERT, own symbol library (CMD-D18) on `v1.5` |
| 2026-11-26 | minor | OFFSET, TRIM, EXTEND on drawn shapes (CMD-D17) on `v1.5` |
| 2026-11-24 | minor | Grip menu (modes, add / remove vertex) on `v1.1`; grips 85 %; ≈ 81 % (estimate) |
| 2026-11-24 | minor | Dynamic input on hot grips on `v1.1`; dynamic input 72 %, grips 78 %; ≈ 80 % (estimate) |
| 2026-11-24 | minor | `TK` and tracking along polar angles on `v1.1`; point entry 82 %, tracking 86 %; ≈ 79 % (estimate) |
| 2026-11-24 | minor | Selection cycling with Tab on `v1.1`; selection 78 → 83 %; ≈ 77 % (estimate) |
| 2026-11-24 | minor | Grips on several selected annotations and several hot grips (Shift) on `v1.1`; grips 65 → 75 %; ≈ 77 % (estimate) |
| 2026-11-24 | minor | Hot grips (CMD-D14, partly) on `v1.1`; grips 45 → 65 %; total corrected to the weighted sum, ≈ 76 % (estimate) |
| 2026-11-24 | minor | Polar extras, WP / CP, .X / .Y, snap on scans on `v1.1`; ≈ 76 % (estimate) |
| 2026-11-24 | minor | Select objects keywords, TEXT H / R, DIST M, prompt next to the cursor on `v1.1`; ≈ 71 % (estimate) |
| 2026-11-24 | minor | FROM, M2P, DCO / DBA Select, Geometric center and Insertion added on `v1.1`; ≈ 67 % (estimate) |
| 2026-11-24 | minor | Phases 1–5 built on branch `v1.1`; re-measured ≈ 64 % (estimate); D1–D8, D9 Node, D10–D13, D15 done |
| 2026-11-24 | minor | Decisions confirmed by Ovidiu as proposed (D2, D3, D7, D12 decided; scans planned); work on branch `v1.1` |
| 2026-11-24 | major | First audit of the command line, point entry, snaps, tracking, dynamic input, grips, selection, keys and aliases; decisions CMD-D1 … D16 and phases |
