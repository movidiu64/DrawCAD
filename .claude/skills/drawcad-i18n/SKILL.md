---
name: drawcad-i18n
description: Use when adding or changing any visible text in DrawCAD — labels, hints, dialog text, tooltips, aria-labels, toasts, panel text. Every string needs a key in i18n_en.js; covers the {} placeholder rule, composed texts, drawing-language text and how to run the extractor and the CI check.
---

# DrawCAD translations

The UI is written in **Romanian** in the source. In English, `i18n.js` translates the page as it is built
(text nodes and `title` / `placeholder` / `aria-label` / `alt`) from the dictionary `EN` in
`frontend/js/i18n_en.js`. Anything without a key stays Romanian, and CI fails.

## Adding a key

- The key is the exact Romanian text of the text node or attribute; whitespace is normalized.
- A template `${…}` becomes `{}` in the key and in the value, in the same order:
  `` `Ai ${n} ${word} (linii, cercuri…)` `` → `"Ai {} {} (linii, cercuri…)": "You have {} {} (lines, circles…)"`.
  Values filled in for `{}` are translated too when they have their own key (`"formă desenată": "drawn shape"`).
- Text split by HTML tags is separate text nodes: `Distanța <b>…</b> pe hârtie.` needs `"pe hârtie."` too.
- Texts joined with ` · ` are looked up piece by piece; a leading `· ` is kept.
- A word that is the same in English still gets a key (`"Snap": "Snap"`) so the check stays simple.
- No duplicate keys (CI fails); search the file before adding.
- Not interface text, so no key: text drawn on the drawing (table headers, default notes, revision
  table words). It follows the document's drawing language `settings.dlang`, with both languages in the
  code; list it in `EXCEPTIONS` in `tools/check_rules.py` with the reason. Same for `translate="no"`
  elements and `KeyboardEvent.key` values.
- In code that builds strings outside the DOM (canvas tooltips, toasts built before insertion) call `tr()`.

## Tools

```bash
python tools/i18n_extract.py > strings.json   # every UI string the extractor finds, with its files
python tools/check_rules.py                   # fails on strings without a key, duplicates, stale exceptions
```

The extractor reads JS string literals and `index.html`; it skips CSS selectors, SVG paths, CSS fonts and
values made only of numbers and units. If it reports something that is not UI text, improve
`is_ui()` / `NOT_UI` in the extractor rather than adding an exception.

## Check it

Run the check, then open the feature with `localStorage.setItem('drawcad.lang', 'en')` and read every
text; `tools/e2e_smoke.py` also checks the English interface at the end.
