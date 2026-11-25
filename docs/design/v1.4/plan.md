# DrawCAD 1.4 — open DXF and DWG

Built on the `v1.4` branch, `VERSION` = `1.4.0-dev.N`. Agreed on 2026-11-25: drawings arrive as DXF or DWG
from people who have CAD; without a CAD program they cannot be opened. DrawCAD opens them, shows them as
a drawing like a PDF from CAD (snap, dimensions, revisions), and saves them as PDF, or a DWG as DXF.
DWG through **LibreDWG**, inside DrawCAD (Docker image and Windows executable), no outside service.

| # | Phase | Status |
|---|---|---|
| V14-1 | DXF → vector PDF on the server (ezdxf drawing add-on, ReportLab backend) | done |
| V14-2 | Open DXF in the editor: pages, scale, the original kept | planned |
| V14-3 | DWG through LibreDWG (`dwg2dxf`): Docker image and Windows executable | planned |
| V14-4 | DXF export of a DXF / DWG: the original entities, the DrawCAD annotations on their layers | planned |
| V14-5 | Guide, limits, tests on real files | planned |

## V14-1 — DXF → vector PDF

- `ezdxf.addons.drawing` (already a dependency for DXF export) reads the entities and draws them through a
  backend. ezdxf's PDF backend needs PyMuPDF; instead a small **ReportLab backend** (ReportLab is already
  used for the PDF overlay) writes lines, polylines, arcs and curves as PDF paths, fills (hatches, solids)
  as filled paths, raster images as images. The result is a vector PDF, so everything DrawCAD does with
  a PDF from CAD works: snap, removal, DXF export of the geometry.
- Text: ezdxf draws texts as outlines with TrueType fonts; SHX fonts are replaced (osifont, ISO 3098,
  already in the image, for the ISO / romans / simplex families). Text is not searchable without OCR
  (as AutoCAD's PDF export with SHX fonts).
- Colors as in the DXF on a white sheet (ACI 7 black), line weights from the entities (default 0.25 mm).

## V14-2 — Open DXF in the editor

- Upload accepts `.dxf` (ASCII and binary). The DXF is read in the separate, limited process that already
  reads uploads (ezdxf with `recover`, size and entity limits); the PDF made from it becomes the
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
- Docker: built from a release tarball in a build stage, only the binary and its library copied into the
  image. Windows: the release's win64 build, shipped next to the executable (as Tesseract).
- LibreDWG reads R13…2018 well; newer versions and custom objects can come out partly. The open dialog
  says when the conversion lost entities (ezdxf audit counts).

## V14-4 — DXF export of a DXF / DWG

- For a document opened from DXF / DWG, **Export → DXF** writes the original drawing unchanged (every
  entity, layer, block, layout), with the DrawCAD annotations added on their layers (DRAWCAD-COTE,
  DRAWCAD-REVIZIE…) in the space the page came from (a layout's paper space, or model space at the
  drawing scale). Removals made in DrawCAD (cover / delete) delete or cover the entities they hit.
- A DWG comes out as DXF this way (DWG → DXF conversion, with or without annotations).

## Checks

Unit tests (backend: render of lines, arcs, text, hatch, dimension, layout with viewport; page and
scale choice; round trip of a DrawCAD export; DWG sample through dwg2dxf where the binary exists),
e2e (open a DXF, a dimension snaps on its geometry, export PDF and DXF), security smoke (malformed DXF,
huge entity counts, a DWG that is not one).
