# DrawCAD 1.4 — open DXF and DWG

Built on the `v1.4` branch, `VERSION` = `1.4.0-dev.N`. Agreed on 2026-11-25: drawings arrive as DXF or DWG
from people who have CAD; without a CAD program they cannot be opened. DrawCAD opens them, shows them as
a drawing like a PDF from CAD (snap, dimensions, revisions), and saves them as PDF, or a DWG as DXF.
DWG through **LibreDWG**, inside DrawCAD (Docker image and Windows executable), no outside service.

| # | Phase | Status |
|---|---|---|
| V14-1 | DXF → vector PDF on the server (ezdxf drawing add-on, ReportLab backend) | done |
| V14-2 | Open DXF in the editor: pages, scale, the original kept | done |
| V14-3 | DWG through LibreDWG (`dwg2dxf`): Docker image and Windows executable | done (CI to confirm the image and exe builds) |
| V14-4 | DXF export of a DXF / DWG: the original entities, the DrawCAD annotations on their layers | done |
| V14-5 | Guide, limits, tests on real files | done |

## V14-1 — DXF → vector PDF

- `ezdxf.addons.drawing` (already a dependency for DXF export) reads the entities and draws them through a
  backend. ezdxf's PDF backend needs PyMuPDF; instead a small **ReportLab backend** (ReportLab is already
  used for the PDF overlay) writes lines, polylines, arcs and curves as PDF paths, fills (hatches, solids)
  as filled paths, raster images as images. The result is a vector PDF, so everything DrawCAD does with
  a PDF from CAD works: snap, removal, DXF export of the geometry.
- Text: SHX fonts are not available (nor redistributable); texts in them, and in any font missing on the
  machine, are drawn in osifont (ISO 3098, already in the image) and written as **PDF text**: searchable,
  snapped at the insertion point rather than glyph by glyph, exported to DXF as text. Texts in a TrueType
  font present on the machine, and texts cut by a viewport edge, stay outlines.
- Colors as in the DXF on a white sheet (ACI 7 black), line weights from the entities (default 0.25 mm).

## V14-2 — Open DXF in the editor

- Upload accepts `.dxf` (ASCII and binary), recognized by content. The DXF is read in the separate,
  limited process that already reads uploads (ezdxf with `recover`; entities counted with blocks expanded,
  `DRAWCAD_MAX_DXF_ENTITIES`, default 400 000, so block bombs and self-referencing blocks are refused); the PDF made from it becomes the
  document's original, and the DXF is kept next to it.
- **Pages:** each paper-space layout with something on it is a page, at its paper size (with its
  viewports, at their scales). Without layouts: model space, fitted on the smallest ISO sheet (A4…A0,
  landscape or portrait) at a standard scale (1:1, 1:2, 1:2.5, 1:5, 1:10…, 2:1, 5:1…), with a margin.
  The drawing scale (Settings) is set from it, so measured dimensions are real.
- **A DXF exported by DrawCAD** carries its page in the header (custom properties `DRAWCAD_SHEET_W`,
  `DRAWCAD_SHEET_H`: paper mm; `DRAWCAD_SCALE`: real mm per paper mm): it opens on that page exactly, the
  PAGINA frame on the edge.

## V14-3 — DWG through LibreDWG

- `dwg2dxf` from LibreDWG (GPL-3.0-or-later, compatible with DrawCAD's AGPL-3.0) converts DWG → DXF, then
  V14-2. It runs in the limited process too, with a time limit.
- Docker: LibreDWG 0.14 built from the release tarball (SHA-256 checked) in a build stage, statically:
  only `dwg2dxf` (≈15 MB, needs just libc) goes into the image. Windows: the release's win64 build
  (checksum checked), `dwg2dxf.exe` + `libredwg-0.dll` in `libredwg/` next to the executable, with the
  GPL text and the source link. `DRAWCAD_DWG2DXF` points to the binary; `/api/health` says `dwg: true`.
- Plotting: colors come out black (as monochrome.ctb: yellow and cyan are unreadable on paper), except
  white fills (wipeouts). A model space with a few far-away strays is fitted on the drawing itself (the
  97 % of entities nearest the median), the strays left off the sheet.
- LibreDWG reads R13…2018 well; newer versions and custom objects can come out partly. The open dialog
  says when the conversion lost entities (ezdxf audit counts).

## V14-4 — DXF export of a DXF / DWG

- For a document opened from DXF / DWG, **Export → DXF** writes the original drawing unchanged (every
  entity, layer, block, layout), with the DrawCAD annotations added on their layers (DRAWCAD-COTE,
  DRAWCAD-REVIZIE…) in the space the page came from (a layout's paper space, or model space at the
  drawing scale). Removals made in DrawCAD (cover / delete) delete or cover the entities they hit.
- A DWG comes out as DXF this way (DWG → DXF conversion, with or without annotations).
- How: on opening, dxfin records which DXF entity (top-level handle) each PDF object comes from
  (`original.dxfmap.json`, kept only for pages where the count matches the PDF one to one) and the
  drawing → page transform of each page (`tf`). On export, DrawCAD's annotations go through that
  transform into the page's space (`DxfOnto`); an entity whose PDF objects were all removed is
  deleted; one only partly removed (a block, a line cut by a zone) stays, the zones covered by a wipeout.
- The export dialog offers "the original DXF/DWG drawing" (default) or "rebuilt from the page" (the
  generic PDF → DXF path). Pages turned in the editor, R12 files and placed images fall back or are left
  out (said in the export message).

## Checks

Unit tests (backend: render of lines, arcs, text, hatch, dimension, layout with viewport; page and
scale choice; round trip of a DrawCAD export; DWG sample through dwg2dxf where the binary exists),
e2e (open a DXF, a dimension snaps on its geometry, export PDF and DXF), security smoke (malformed DXF,
huge entity counts, a DWG that is not one).

## After the first round (dev.9 →)

- Drawings saved from Inventor: the views, border and title block placed again from Inventor's *I blocks
  (its own block references are lost without the Inventor object enabler).
- Layer list of the opened drawing, each layer shown / hidden: hidden objects are made see-through in
  the working PDF (ids stay the same, so removals and the entity map still match), skipped by snap,
  object picking and search, removed from the PDF export, turned off in the original-DXF export.
- One drawing scale per layout (pages carry `src`, `name`, `dscale`); the page tabs show the layout names.
- Colors: monochrome by default; the drawing's own colors on request, plotted again in the limited child
  process (`original-color.pdf`, checked to have the same objects page by page).
- Texts in a TrueType font found on the machine are PDF text in that font (embedded subset).
- The original-DXF export also takes pages turned in the editor and images placed in DrawCAD (ZIP).
- A sheet frame drawn in model space (an ISO rectangle at a standard scale around the drawing) is the page,
  edge to edge; between equivalent sizes (A6 1:1 / A4 2:1) the median text height decides.
