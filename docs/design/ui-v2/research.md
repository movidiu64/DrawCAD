# DrawCAD UI v2 — interface research (v1.1)

Research for the look and layout of DrawCAD's editor: what current CAD and professional design tools
do, what usability research says about it, and the design direction that follows. Keys, aliases and
commands are out of scope here (they are in `docs/design/commands-v2.md`); this is about the screen.

It refines the UI v2 package in this folder: where a finding contradicts a decision in `README.md`
or `audit.md`, the change is listed under *Changes to the UI v2 decisions*. The mockup built from this
page is linked at the end.

## Sources looked at

| Source | What was read |
|---|---|
| Figma, "Our approach to designing UI3" (figma.com/blog) and the UI3 feedback threads (forum.figma.com) | principles, floating vs fixed panels, labels, hover-only controls, what was reverted after the beta |
| Autodesk, "Fusion 360 fresh new look" (autodesk.com blog) and "The Fusion interface" (help.autodesk.com) | unified toolbar, tabs by function, contextual tabs, pinning, marking menu |
| Shapr3D, "Behind the Shapr3D user interface refresh", "Adaptive user interface", 5.440 release notes | fixed vs adaptive zones, tools offered after a selection, visual refresh |
| Onshape release notes (onshape.com) | S-key shortcut toolbar at the cursor, labels on numeric fields, HUD toolbar next to the cursor |
| BricsCAD help, "The Quad cursor menu", "Rollover properties" (help.bricsys.com) | properties and commands next to the cursor by entity type |
| AutoCAD and Revit forums and help (autodesk.com) | dark theme history; complaints about hover states too close to the background |
| CADCraft README (github.com/storytold/cadcraft) | AutoCAD-style layout in a modern app; truncating readouts; motion setting |
| SolidCraft README (github.com/tangency-labs/solidcraft) | Fusion-style layout; the interface is under a separate brand licence |
| Plasticity docs, "User Interface Overview" (doc.plasticity.xyz) | command bar, command palette, radial menu |
| Nielsen Norman Group: icon usability, progressive disclosure, Fitts's law (nngroup.com); Microsoft Office "The importance of labels" | labels, defaults, target size and distance |
| Material Design, dark theme (m2.material.io) | grey surfaces, desaturated accents, elevation by lighter surfaces |
| W3C, WCAG 2.2 SC 2.5.8 Target Size (Minimum) | 24 × 24 CSS px minimum |
| MDN, `font-variant-numeric` | tabular figures |

Ideas only. No icons, colours, tokens or layouts are copied; SolidCraft in particular licenses its UI
kit, icons, themes and design tokens separately and does not allow their use in another product.

## Findings

### F1 — The canvas comes first, but panels should be fixed, not floating

Figma's UI3 set "work comes first" and "minimal UI, shown on demand" as principles and first shipped
floating panels. In the open beta users said floating panels cramped the canvas on small screens,
let designs peek out distractingly behind them and slowed them down, so Figma went back to fixed,
resizable panels and kept floating ones only behind *Minimize UI*. Users also complained that the
gap around floating toolbars ate more room than it saved (one counted 40 px gained against 120 px
taken). Fusion made the same move years earlier: its toolbar stopped floating and became one strip,
which also fixed bugs.

→ Fixed side panels flush with the window edges, no margins around them; a key to hide them all.

### F2 — Icons need labels; experts navigate by position

Nielsen Norman Group's guidance is that universal icons are rare and a text label must sit next to an
icon to clear its ambiguity; labels shown only on hover add interaction cost and fail on touch. The
Outlook 97 toolbar was barely used until text labels were added; new icons and reordering had not
helped. Labels also make targets bigger, which by Fitts's law makes them faster to hit. Experts rely on
the remembered position of a control more than on its icon.

→ This contradicts UI-D1's icon-only rail. A rail of a few *family* slots, each with an icon and a
short label, keeps the position memory (one slot per family, always in the same place) and stays
readable for a new user. Tool names inside a flyout always have labels.

### F3 — Don't hide controls behind hover

Figma reverted two UI3 beta changes that hid things: a control that appeared only on hover, and a
blend-mode icon that hid the current value behind a tooltip; both slowed users down. Revit and AutoCAD
users complained when hover states in the dark theme became nearly invisible against the background.

→ The current value of every property is visible without hovering. Hover states differ from the
resting state by at least one clear surface step. Hover menus (DrawCAD's grip menu) stay accelerators,
never the only way.

### F4 — Show what fits the selection, in a fixed place

Shapr3D's adaptive UI recommends tools as you select, and its refresh visually separates fixed zones
from adaptive ones so the user has stable anchors for the next action. Fusion opens a contextual tab
while sketching. BricsCAD's Quad shows, next to the cursor, the commands and a few editable
properties of the entity under it. Onshape added a HUD toolbar next to the cursor for mates.

→ One fixed strip (the context bar) whose content adapts: the active tool's options, or the actions
for the selection. The strip itself never moves, only its content.

### F5 — Progressive disclosure for the properties panel

Show the few options most people need; put the rest one clearly labelled step away; remember the
state per user. NN/g credits it with better learnability, efficiency and fewer errors.

→ Each panel section collapsible, secondary ones collapsed by default, state remembered.

### F6 — Dark theme: grey surfaces, few desaturated accents, elevation by lightness

Material's dark theme uses dark grey (#121212) rather than black, lighter surfaces for higher
elevation, and desaturated accents so text on them passes WCAG AA; saturated colours vibrate on dark
backgrounds. Large surfaces stay neutral.

→ DrawCAD's tokens already follow this (`--bg` #15181c, `--panel` #1d2127, `--muted` text 7 : 1 on
the panel). What to fix is accent use: today the amber fills ordinary "on" states (active tool, 100 %
size, chosen segment), so it no longer marks the one thing that matters. Amber fill only for the
primary action; a tint and a 2 px bar for "active".

### F7 — Numbers are the content

A drafting tool shows coordinates, dimensions, deviations and limits all the time. Tabular figures
(`font-variant-numeric: tabular-nums`) give every digit the same width so values line up in columns
and do not jitter while the cursor moves, without switching to a monospace face.

→ Values in the panel, the status bar coordinates and the ISO 286 card use tabular figures of the
sans font; monospace stays for typed commands and aliases.

### F8 — Edges are fast; targets have a floor

Controls on a screen edge are faster to hit because the edge stops the pointer (Fitts's law). In a
browser the window edge is not always the screen edge, but the rail and the status bar still sit at
the window's edges. WCAG 2.2 AA asks for at least 24 × 24 CSS px per pointer target, or enough
spacing; 44 × 44 is the enhanced level.

→ Rail slots flush with the left edge, full rail width as the target (≥ 56 × 48 px). Status toggles
≥ 24 px high. Touch layout ≥ 40 px.

### F9 — A way out of all the chrome

Figma's *Minimize UI* (Shift+\) collapses the side panels and keeps the tools. AutoCAD has Clean
Screen (Ctrl+0).

→ One key hides header, panel and rail; the command line and status stay.

## Design direction

The screen, top to bottom, at 1440 × 900 (mockup board *Editor — selection*):

| Zone | Height / width | Holds |
|---|---|---|
| Header | 44 | brand · document chip (name, "salvat", close) · search field (text in drawing, OCR) · undo / redo · zoom group · panel toggle · settings · **Exportă** (the only amber fill) |
| Rail | 72 wide | family slots, icon over a short label: Selecție, Pan, Măsoară · Cote, Toleranțe, Adnotări · Desen, Vederi · Revizie; a 4 px corner mark when a slot has a flyout; the slot shows the family's last tool |
| Context bar | 40 | left: active tool icon + name + its hint, or *n selectate* + the actions for the selection; right: page tabs and page operations |
| Canvas | rest | the sheet; legend chip bottom-left; no floating toolbars |
| Panel | 300 wide | tabs Proprietăți · Straturi · Adnotări; sections with a chevron; values in tabular figures |
| Status bar | 32 | coordinates · command line (prompt › and options as chips) · SNAP URMĂRIRE POLAR ORTHO chips · scale; one line, ellipsis, never wraps |

Families (from `TOOLS`; `calib` moves to Straturi):

| Slot | Flyout members |
|---|---|
| Selecție | — |
| Pan | — |
| Măsoară | Origine (UCS) |
| Cote | Liniară, Aliniată, Diametru, Diametru cerc, Rază, Unghi, Teșitură, Ordonate, În lanț, Față de bază, Tabel găuri |
| Toleranțe | Rugozitate, Cadru GD&T, Bază |
| Adnotări | Text, Indicație, Note, Tabel rev., Componente, Reper |
| Desen | Linie, Polilinie, Dreptunghi, Cerc, Arc, Axe cerc, Hașură, Ruptură |
| Vederi | Secțiune, Detaliu, Etichetă |
| Revizie | Taie cota, Acoperă, Înnegrește, Șterge |

Nine slots of 56 px fit in 900 px without scrolling (≈ 520 px with dividers), against 1 382 px of
labelled buttons today.

Visual rules:

- Surfaces: `--bg` for fields and the canvas surround, `--panel` for chrome, `--panel2` for menus;
  hover = one step lighter, active = `--accent-tint` + 2 px amber bar on the leading edge.
- Amber: fill only on **Exportă** and the primary button of a dialog; text and bar for active states;
  the selection on the canvas keeps `COLORS.sel`.
- Type: 13 px body, 12 px secondary, 11 px upper-case section labels with 0.08 em tracking; tabular
  figures for values; mono only for typed commands, aliases and keys.
- Borders 1 px `--line`; radii 6 px controls, 8 px menus, 10 px dialogs.
- Motion: 120 ms fades for menus and flyouts, none with `prefers-reduced-motion`.

## Changes to the UI v2 decisions

| # | Change | Why |
|---|---|---|
| UI-D1 | **Revised:** family slots with icon *and* short label (72 px rail), not icon-only; a compact icon-only rail (56 px) as an option in Settings | F2, F8 |
| UI-D1a | Decided: the slot shows the family's last tool (was *check*) | F2: position stays, content adapts |
| UI-D1b | Decided: Calibrare leaves the rail, stays on K and in Straturi | fewer slots |
| UI-D2 / UI-D10 | Context bar keeps one fixed place, content adapts (tool options or selection actions) | F4 |
| UI-D6 | Amber fill only for the primary action; tabular figures for values (new) | F6, F7 |
| UI-D13 | Collapsible panel sections with remembered state | F5 |
| UI-D17 (new) | **Minimize UI:** one key (Ctrl+0 as AutoCAD's Clean Screen, *check* in the browser, where Ctrl+0 resets zoom) hides rail, header and panel; command line and status stay | F9 |
| UI-D18 (new) | **No hover-only values:** every property value visible at rest; hover one surface step lighter, checked in both languages | F3 |
| — | Floating panels and a floating bottom toolbar are left out on purpose | F1 |

## Mockup

A design canvas with the boards built from this page (private until shared: https://claude.ai/artifact/X5wHuKHGoFDtDKNsCT9fHM):
*Editor — selection*, *Editor — Cote flyout and Linear active*, *Start*, *Phone*. Its texts,
values and icons are illustrative; tool names come from `TOOLS`.

## Change log

| Date | Change | Summary |
|---|---|---|
| 2026-11-24 | minor | Built on `v1.1`: labelled family rail (UI-D1), quieter accent and tabular figures (UI-D6), Minimize UI with Ctrl+0 (UI-D17); UI-D18 holds for the new panel |
| 2026-11-24 | major | Interface research: Figma UI3, Fusion, Shapr3D, Onshape, BricsCAD, AutoCAD, CADCraft, SolidCraft, Plasticity; NN/g, Material, WCAG 2.2; findings F1–F9 and changes to UI-D1, D1a, D1b, D6, D13; new UI-D17, D18 |
