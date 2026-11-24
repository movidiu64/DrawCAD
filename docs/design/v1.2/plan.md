# DrawCAD 1.2 — plan

Status: **confirmed** (phases in order below). Branch `v1.2`.

Decisions: title blocks in the browser only (for now); revision format `rev1`; DXF leaves images out;
comments are exported as native PDF notes by default; the QR code holds drawing number, revision and date
by default, plus an optional free field (a link).

Scope agreed with the user: images, a custom title block, revision number in the document, and from the
PDF-editor features: revision compare, review comments, revision cloud, stamps, QR code and a highlighter.

Every phase keeps the project rules (`CLAUDE.md`): English in code and docs, Romanian UI text with English
keys, colors as tokens, overlays only through `dialogs.js`, tests before each commit.

---

## V12-1 — Revision number in the document · built

The state embedded in an export (`drawcad.json`) already reopens as editable. The revision joins it.

- `settings.revNo` (already there) becomes the **document revision**. Written on export to:
  - the embedded state (as now);
  - the PDF Info dictionary and XMP: `/DrawCADRevision`, plus `pdf:Keywords` / `dc:description`
    containing `rev N` so other programs show it.
- **Automatic increment:** a document opened from a DrawCAD export at rev N goes to rev N+1 at the
  **first real change** (an annotation added, edited or removed; a page operation). Repeated exports in
  the same session do not increment again. A toast says it: "Revizie nouă: rev N+1".
- **File name:** the export name replaces a `_revN` / `_rev.N` / `-revN` / ` rev N` suffix (any case) with
  `_rev{N+1}`; a name without a suffix gets `_rev1`.
- The same number feeds the struck-value triangle default, the revision table and the title block
  field `{rev}`.
- Settings → Sheet and revisions: the number can be corrected by hand; a switch turns the automatic
  increment off.
- Tests: name suffix parsing (unit), increment once per session (e2e), metadata present (backend).

## V12-2 — Images · built

- New annotation `image`: placed by dragging a rectangle (aspect kept; Shift = free), or pasted with
  **Ctrl+V** at the cursor. Move, resize from the corners, rotate 90°, opacity (100 / 70 / 40 %).
- Formats PNG, JPG, WebP. The server re-encodes them with Pillow (metadata stripped, max 4000 px on the
  long side, max size from `DRAWCAD_MAX_IMAGE_MB`), stores them next to the document and returns an id.
  SVG is refused (active content).
- **PDF export:** an image XObject at full resolution, with the opacity as an ExtGState.
- **Stays editable:** the image bytes go into the embedded state of the export, so the next revision
  reopens it as an image annotation, not as part of the original.
- **DXF export:** images are not exported (DXF cannot embed them).
- As built: command `IAT` / `IMAGEATTACH`; the server limit is `DRAWCAD_MAX_IMAGE_MB` (40) and 100 MP.
- Security: `security_smoke.py` gets crafted images (decompression bomb, wrong extension, SVG renamed).

## V12-3 — Custom title block (browser library) · built

- **Library in the browser** (`localStorage`, `cotare.tblocks`), shown in a dialog: new, edit, duplicate,
  delete, export `.drawcad-tb.json`, import.
- **Two ways to make one:**
  1. generator after ISO 7200: width 180 mm, rows and fields picked from a list (title, drawing number,
     revision, date, scale, material, mass, sheet, format, drawn / checked / approved, company);
  2. from the drawing: select lines, rectangles, texts (and an image as logo), then
     "Salvează ca indicator".
- **Fields** in texts as placeholders: `{titlu}`, `{nr_desen}`, `{rev}`, `{data}`, `{scara}`, `{material}`,
  `{autor}`, `{format}`, `{foaia}`, plus free ones. Filled in the panel; `{rev}`, `{data}`, `{scara}`,
  `{format}`, `{foaia}` fill themselves.
- **Placement:** the tool snaps the block's bottom-right corner to the frame corner; the revision table
  and parts list already sit above a title block and keep doing so.
- A logo image inside a block is stored in the library as data (limit 300 KB per block, so the browser
  storage is not filled); placed on a drawing it is uploaded as an image of the document.
- As built: command `TB` / `TITLEBLOCK`; a placed block keeps its own copy of the template; `{data}` is the
  date of the current revision (`settings.revDate`, set when a revision starts or the first block is placed).

## V12-4 — Markup: revision cloud, highlighter, comments · built

- **Revision cloud:** drawn as a rectangle (a polyline outline is left for later), turned into arcs (arc length from the text
  height); optional revision triangle on the outline, numbered from the document revision. Layer
  Revisions.
- **Highlighter:** freehand or straight strokes, wide (3 / 6 / 10 mm) and transparent; colors green
  (default), yellow, pink as tokens. Exported to PDF with multiply blending so lines and text under it
  stay readable; in DXF as a polyline with transparency.
- **Comments (review):** a note pin with text, author, date and status (open / resolved). A new layer
  **Review**: visible on screen, listed in the Annotations tab with a filter; by default **not printed**.
  Export: as native PDF notes (`/Text` annotations) that Acrobat and other readers show as comments
  (default), or left out.

## V12-5 — Stamps and QR code

- **Stamps:** APROBAT, VERIFICAT, PENTRU EXECUȚIE, ANULAT, COPIE NECONTROLATĂ, PRELIMINAR, with date and
  name filled in automatically; custom stamps (text, color, frame) in the same browser library as title
  blocks. Option: a diagonal watermark on every page.
- **QR code:** content built from chosen fields (drawing number, revision, date, name, free text or a
  URL), shown next to the code as text. Generated in the browser by a vendored MIT-licensed encoder
  (no build step), drawn as vector squares, so it stays sharp in PDF and DXF. Error correction level M;
  minimum module size checked against print (warning under 0.4 mm).

## V12-6 — Revision compare

- **Compare** two PDFs or two revisions of the same drawing: the older one is picked from Recent or
  uploaded.
- The server renders both pages at the same DPI (PDFium) and combines them: only in old = red, only in
  new = green / blue, common = gray. Pages of different size are aligned by the page box; an optional
  two-point alignment (same point clicked on both) fixes a shifted or rescaled export.
- Shown as an overlay mode in the editor (toggle, slider between old and new), with a list of changed
  regions (connected areas of difference) to step through.
- Export of the comparison as a PDF page, for the review record.

---

## Order and checks

1. V12-1 revision (small, everything else uses the number)
2. V12-2 images (the title block logo needs them)
3. V12-3 title block
4. V12-4 markup
5. V12-5 stamps and QR
6. V12-6 compare (largest)

Each phase: unit tests for the pure parts, e2e steps, `security_smoke.py` where files come in, screenshots
in Romanian and English at 1440 and 390 px, guide updated, commit on `v1.2`.
