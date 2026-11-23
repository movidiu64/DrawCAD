---
name: drawcad-backend
description: Use when changing the DrawCAD server (backend/app), file upload and reading, PDF rendering or export, OCR, DXF, vectorization, the Docker image or compose files, or anything the Windows desktop build packages. Covers sanitizing uploaded PDFs, the read-only container, what security_smoke.py checks and desktop compatibility.
---

# DrawCAD backend

Starlette app in `backend/app/main.py`, one uvicorn worker. Heavy or untrusted work runs off the event loop
(`run_in_threadpool`) or in a separate process.

## Untrusted files

- Every upload goes through `ingest.py` in a **separate process** with limits (memory `RLIMIT_AS`, CPU time,
  no core dumps): decoding, PDF parsing, a first render of each page. A crash or hang rejects the file,
  never the server.
- **Every PDF that enters is cleaned by `sanitize.sanitize_pdf()`** (JavaScript, launch/submit actions,
  attachments, multimedia annotations, XFA, actions in bookmarks) before it is stored. A new way in for
  PDFs (import, merge, re-open of an export) must go through ingest + sanitize too. Content streams are
  not touched, so object ids stay stable.
- Keep the limits: upload size streamed to disk (`DRAWCAD_MAX_UPLOAD_MB`), pages (`DRAWCAD_MAX_PAGES`),
  image megapixels (`DRAWCAD_MAX_IMAGE_MPX`), render size (`DRAWCAD_MAX_RENDER_PX` / `_MP`), timeouts for
  OCR and vectorization. Validate everything the frontend sends (primitives, removals, rectangles) as
  `_clean_prims()` and `_clean_ops()` do.
- Every new endpoint keeps the owner check for the private modes (`_req_owner(request)`; another browser's
  document answers 404) and goes through `SecurityMiddleware` (CSP, same-origin check for writes,
  allowed hosts on desktop).

## The container is read-only

`compose.yaml` runs with `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`. The app
may write only to `DRAWCAD_DATA` (`/data`) and `/tmp` (tmpfs, 512 MB). Temporary files: `tempfile` under
`/tmp`, deleted after use; nothing next to the code, no `~/.config` (ezdxf's HOME is redirected for this).
Large in-memory arrays should be released (`pdfcore.release_memory()` after big renders / OCR).

## What `tools/security_smoke.py` checks (CI runs it on the built container)

- the CSP header on `/`; a "trojan" PDF is accepted with its active content listed as removed, and its
  export contains no `/JavaScript` or launch target;
- an executable and a corrupt PDF are rejected with 400; an upload with a foreign `Origin` gets 403;
- the server still answers afterwards; in `private` / `session` mode another browser cannot see or list
  the document; the interface works under the strict CSP (no `eval`, no inline scripts).
New risky surface → add a case there and in `backend/tests/test_security.py`.

## Desktop build compatibility (Windows, PyInstaller)

- Child processes start with `_child_cmd(module, …)`: `python -m` normally, `--run-module` in the frozen
  exe. Never call `sys.executable -m` directly. Pass results through files as well as stdout (a windowed
  app may have none) and use `_child_kw()` (no console window).
- A new backend module or a dependency with data files: add it to `hiddenimports` / `collect_all` in
  `desktop/drawcad.spec`; a new package also goes in `desktop/requirements.txt` and must have a Windows
  wheel. External binaries are bundled explicitly (as Tesseract is).
- Paths: no hard-coded `/tmp` or `/data`; use `DATA_DIR`, `tempfile` and `Path`. File names may contain
  diacritics (UTF-8 headers). The desktop serves only `127.0.0.1` and checks the Host header.
- After changing the desktop launcher, run `python desktop/drawcad_desktop.py --selftest` locally; CI runs
  the self-test and the e2e test on the built exe.

## Check it

```bash
cd backend && python -m unittest discover -s tests
# with a server running:
python tools/e2e_smoke.py http://127.0.0.1:8765 e2e_out
python tools/security_smoke.py http://127.0.0.1:8765
```
