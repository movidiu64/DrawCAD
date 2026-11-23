---
name: drawcad-ui
description: Use when changing anything visible in the DrawCAD interface — CSS, colors, fonts, dialogs, panels, toasts, toolbar, canvas marks. Covers the color tokens, the dialog helpers, the dark style and how to check the result with a screenshot.
---

# DrawCAD UI

The interface is one dark theme, built from plain HTML strings in ES modules (no framework, no build step).
`tools/check_rules.py` enforces the color and overlay rules below in CI.

## Colors and fonts

- **CSS:** colors only as tokens in `:root` (`frontend/css/app.css`), used as `var(--…)`. A hex color anywhere
  else in app.css fails CI. Need a new shade? Add a token with a role name (`--info-bg`, `--layer-rev`),
  not a value name. Reuse before adding: `--bg`, `--panel`, `--panel2`, `--raised`, `--line…`, `--text`,
  `--text2`, `--muted`, `--accent`, `--ok`, `--warn`, `--bad` and their `-bg` / `-ink` pairs.
- **JS:** a hex color only inside `COLORS` in `frontend/js/view.js` (canvas drawing cannot read CSS variables).
  Inline styles in HTML strings use `var(--…)` (`style="background:var(--layer-add)"`); canvas code uses
  `COLORS.x`. A hex anywhere else in the JS fails CI.
- **Fonts:** `var(--sans)` for the interface, `var(--mono)` (class `mono`) for numbers, codes and values.
  `osifont` (ISO 3098) is only for text on the drawing.
- Exceptions go in `EXCEPTIONS` in `tools/check_rules.py`, one line each, with the reason.

## Dialogs, overlays, messages

- Modal dialogs only through `dialogs.js`: `showModal(html, onKey)` returns the dialog element;
  `closeModal()`; `isModalOpen()`. Short messages: `toast(msg, ms)`. Never create another overlay, backdrop,
  `<dialog>` or `position: fixed` element (CI fails; the radial menu and the phone snap popover are the
  listed exceptions).
- Dialog markup: `<h2>Title</h2>`, sections `<div class="sec">` with `<div class="lbl">`, rows `.row`,
  side by side `.cols`, help text `.sub`, notes `.note` (`.note.warn`), segmented choices
  `<div class="seg"><button class="on">`, and a footer
  `<div class="foot"><button class="ghost" data-close>Închide</button><button class="primary">…</button></div>`.
  `data-close` buttons close the dialog; Esc and a click on the backdrop close it too; the first input or
  `button.primary` gets focus.
- Buttons: `primary` (one per dialog, the main action), `ghost` (everything else), `danger` (deletes),
  `icon` (toolbar / list icons, always with `aria-label` and `title`).
- Escape user and file text with the module's `esc()` before putting it in HTML.

## Style

- Dark panels, thin `--line` borders, 6–8 px radii, 12 px muted labels above fields, accent (`--accent`) only
  for the selected / primary state. Keep spacing and sizes consistent with the neighbors; no new
  font sizes for one element.
- Layouts must also work on a phone: the panel becomes a bottom sheet under `@media (max-width: …)`.
- Visible text is Romanian in the source and needs an English key (skill `drawcad-i18n`).

## Check it

1. `python tools/check_rules.py`
2. Start a server and run `python tools/e2e_smoke.py http://127.0.0.1:8765 e2e_out`; look at
   `e2e_out/editor.png` (editor with annotations) and `e2e_out/dialog_stergere.png` (a dialog). The script
   also checks the English interface at the end.
3. For a new dialog or panel, take your own Playwright screenshot of it in both languages
   (`localStorage.setItem('drawcad.lang', 'en')`) and look at it before committing.
