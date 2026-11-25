# DrawCAD — notes for agents

Self-hosted editor for technical drawings: dimensions, tolerances, GD&T and revisions on a PDF or a scan,
exported as vector PDF or DXF. License: **AGPL-3.0** (see `LICENSE`); keep new dependencies AGPL-compatible.

## Stack

- **Backend:** Python, Starlette + uvicorn (`backend/app`). PDFium (pypdfium2), pikepdf, reportlab, ezdxf,
  Tesseract. Untrusted files are read in separate, limited processes (`ingest.py`, `vectorize.py`).
- **Frontend:** plain ES modules, **no build step** (`frontend/js`, `frontend/css/app.css`, `frontend/index.html`).
  The editor object `App` is in `js/main.js`; its methods live by area in `js/app/*.js` (classes whose
  methods are copied onto `App.prototype`), so `this` is the app everywhere.
- **Desktop (Windows):** pywebview + PyInstaller (`desktop/drawcad.spec`), Inno Setup installer.
- **Docker:** `Dockerfile`, `compose.yaml` (prebuilt image), `compose.build.yaml` (build from source).

## Tests (run before every commit)

```bash
python tools/check_rules.py                               # project rules (colors, i18n, overlays)
cd backend && python -m unittest discover -s tests        # API + security tests
cd frontend && npm test                                   # ISO 286, geometry, commands, pages
# with a server running (DRAWCAD_DATA=./data uvicorn app.main:app --port 8765, from backend/):
python tools/e2e_smoke.py http://127.0.0.1:8765 e2e_out   # browser test (Playwright), screenshots in e2e_out/
python tools/security_smoke.py http://127.0.0.1:8765      # crafted files, CSP, cross-site, isolation
```

## Version

`VERSION` holds the version being developed (`1.3.0-dev.N`). Bump `N` with every push to a development
branch, and set it to the plain version (`1.3.0`) in the commit that is tagged for a release. Settings shows
it: the release tag in CI images, `VERSION` + build time in images built from source (git stacks), and
`VERSION (commit)` when run from a checkout.

## Language rules

- Commits, PR texts, code comments, docs: **English**.
- UI text is written in **Romanian** in the source; every visible string needs its English entry in
  `frontend/js/i18n_en.js` (`{}` stands for `${…}`). Text on the drawing follows the document's drawing
  language (`settings.dlang`), not the UI language.

## Skills (`.claude/skills/`)

| Skill | Use when |
|---|---|
| `drawcad-ui` | changing anything visible: CSS, dialogs, panels, colors |
| `drawcad-commands` | adding or changing a tool, a command alias or a key |
| `drawcad-i18n` | adding or changing any visible text |
| `drawcad-annotations` | adding or changing dimensions, tolerances, GD&T, symbols, export of annotations |
| `drawcad-backend` | changing the server, file handling, OCR/DXF, Docker or the desktop build |
