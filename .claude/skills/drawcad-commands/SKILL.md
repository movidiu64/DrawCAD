---
name: drawcad-commands
description: Use when adding or changing a DrawCAD tool, a command, a command alias or a keyboard shortcut — anything in tools.js, commands.js or the command line. Covers TOOLS, DEFAULT_ALIASES (AutoCAD names), ACTIONS, conflicts and the Keys dialog.
---

# DrawCAD tools and commands

Two keyboard modes (Settings → Keys and commands): **direct keys** (one key = one tool) and
**AutoCAD commands** (type `L`, `C`, `DLI`… + Space/Enter). Both read the same tables.

## A new tool

1. **`TOOLS` in `frontend/js/tools.js`:** `{ id, label, key, group, icon, kind, n | min, hint, make(pts, app, closed, cur), preview(pts, cur, app) }`.
   - `kind`: `"clicks"` (fixed `n` points), `"poly"` (any number, Enter / right click finishes; `place: true`
     adds a last click to place the result, as for ordinate dimensions) or `"rect"` (a dragged box).
     `"select"`, `"pan"` and `"remove"` are the built-in modes.
   - `label` and `hint` are Romanian UI text: add the English keys (skill `drawcad-i18n`).
   - `key`: one lowercase letter or `""`. Free letters are few; never use the reserved `f + - = space`.
2. **Alias in `DEFAULT_ALIASES` in `frontend/js/commands.js`:** the first entry is the one shown.
   Use the **AutoCAD command name and alias** where an equivalent exists (`DIMORDINATE` / `DOR`,
   `DIMLINEAR` / `DLI`, `LINE` / `L`); otherwise a short English or Romanian name. Every tool needs at
   least one alias (tested in `frontend/tests/commands.test.js`).
3. **No conflicts:** `conflicts(cfg)` must return empty `keys`, `aliases` and `reserved` for the defaults.
   Run `npm test` — the commands test checks it.
4. **Keys dialog:** `keysDialog` lists `commandList()`, which is built from `TOOLS` + `ACTIONS`; a tool in
   `TOOLS` with an alias appears there and becomes configurable without extra code. Open the dialog
   (`ALIASEDIT`) and check the new row.
5. The annotation it makes: skill `drawcad-annotations`.

## A new action (not a tool)

- Add `{ id, label, aliases }` to `ACTIONS` in `commands.js` and its handler in the `act` map of
  `runCommand()` in `frontend/js/main.js`. Actions that need an open document call `needDoc()` first.

## Behavior to keep

- Space / Enter with nothing typed repeats the last command; the command history (arrow up/down) stores
  what the user typed when it is a real alias.
- `E` with a selection deletes the selection (AutoCAD ERASE), otherwise starts removal.
- During a command, digits go to the dynamic input (L / ∠ next to the cursor), not to the command line.

## Check it

`cd frontend && npm test`, then in the browser: the toolbar button, the direct key, the typed alias,
the Keys dialog row, and the English UI.
