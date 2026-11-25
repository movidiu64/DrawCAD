"""Opening DXF drawings (V14): the entities drawn as a vector PDF, one page per paper-space layout with
something on it, or model space fitted on an ISO sheet at a standard scale.

ezdxf's drawing add-on resolves entities, blocks, line types, hatches, dimensions and text (as outlines)
and records them; a small ReportLab backend writes the record as PDF paths, so the result is a PDF like
one exported from CAD: DrawCAD snaps on it, removes from it, exports it to DXF again.

Called only in the limited child process (ingest.py) for uploaded files: DXF input is untrusted.
"""
from __future__ import annotations

import io
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import ezdxf
from ezdxf.addons.drawing import config, frontend, layout, recorder
from ezdxf.addons.drawing.backend import BackendInterface
from ezdxf.addons.drawing.properties import RenderContext
from ezdxf.colors import RGB
from ezdxf.math import BoundingBox2d, Matrix44, Vec2
from ezdxf.path import Command

MM = 72 / 25.4  # pt per mm
# ISO sheets (mm, landscape) tried from the smallest; standard scales (paper mm per drawing mm)
SHEETS = [("A4", 297, 210), ("A3", 420, 297), ("A2", 594, 420), ("A1", 841, 594), ("A0", 1189, 841)]
SCALES = [50, 20, 10, 5, 2, 1, 1 / 2, 1 / 2.5, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000]
MARGIN = 10  # mm of paper around a model-space drawing
# custom header properties of a DXF exported by DrawCAD: its page (paper mm) and drawing scale
DRAWCAD_VARS = ("DRAWCAD_SHEET_W", "DRAWCAD_SHEET_H", "DRAWCAD_SCALE")
UNIT_MM = {0: 1.0, 1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 14: 100.0}  # $INSUNITS → mm


def _ink(color: str) -> float:
    """Plotted as with monochrome.ctb: every color black (yellow or cyan lines are unreadable on paper),
    except the white of wipeouts and background fills, which hides what is under it. → gray level."""
    r, g, b = RGB.from_hex(color[:7]).to_floats()
    return 1.0 if min(r, g, b) > 0.98 else 0.0


class NoDwg(Exception):
    """LibreDWG's dwg2dxf is not installed here."""


def dwg_exe() -> str | None:
    """LibreDWG's dwg2dxf: the given path (the desktop app bundles it) or the one on PATH."""
    p = os.environ.get("DRAWCAD_DWG2DXF")
    if p and os.path.isfile(p):
        return p
    return shutil.which("dwg2dxf")


def dwg_to_dxf(data: bytes, work: str, timeout: float = 90) -> bytes:
    """DWG → DXF with LibreDWG (`dwg2dxf`), in a temporary folder under `work`. The DXF keeps the DWG's
    version (R2000 text in its code page, 2007+ in UTF-8), as ezdxf expects."""
    exe = dwg_exe()
    if not exe:
        raise NoDwg()
    with tempfile.TemporaryDirectory(dir=work) as tmp:
        src = os.path.join(tmp, "in.dwg")
        dst = os.path.join(tmp, "out.dxf")
        with open(src, "wb") as f:
            f.write(data)
        kw = {"creationflags": 0x08000000} if sys.platform == "win32" else {}  # no console window
        try:
            res = subprocess.run([exe, "-y", "-o", dst, src], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE, timeout=timeout, cwd=tmp, check=False, **kw)
        except subprocess.TimeoutExpired as e:
            raise ValueError(f"Conversia DWG a durat peste {timeout:g} s") from e
        # dwg2dxf answers ≠ 0 for warnings too: what counts is a DXF that ezdxf can read
        if not os.path.isfile(dst) or os.path.getsize(dst) < 64:
            msg = res.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] if res.stderr else []
            raise ValueError("DWG imposibil de convertit" + (f": {msg[0][:200]}" if msg else ""))
        with open(dst, "rb") as f:
            return f.read()


class TooLarge(Exception):
    """More entities than the limit (the count is the message)."""


class _Canvas(BackendInterface):
    """ReportLab backend: the recorded, already placed output (pt, y up) on one PDF page."""

    def __init__(self, c, w_pt: float, h_pt: float):
        self.c = c
        self.w = w_pt
        self.h = h_pt
        self._lw = 0.25
        self._min_lw = 0.05

    # --- state
    def _stroke(self, props):
        self.c.setStrokeGray(_ink(props.color))
        self.c.setLineWidth(max(self._min_lw, props.lineweight) * MM)

    def _fill(self, props):
        self.c.setFillGray(_ink(props.color))

    @staticmethod
    def _add(p, path, close):
        start = path.start
        p.moveTo(start.x, start.y)
        first = start
        for cmd in path.commands():
            e = cmd.end
            if cmd.type == Command.MOVE_TO:
                if close:
                    p.close()
                p.moveTo(e.x, e.y)
                first = e
            elif cmd.type == Command.LINE_TO:
                p.lineTo(e.x, e.y)
            elif cmd.type == Command.CURVE3_TO:
                # quadratic → cubic
                c0 = start
                q = cmd.ctrl
                p.curveTo(c0.x + 2 / 3 * (q.x - c0.x), c0.y + 2 / 3 * (q.y - c0.y),
                          e.x + 2 / 3 * (q.x - e.x), e.y + 2 / 3 * (q.y - e.y), e.x, e.y)
            elif cmd.type == Command.CURVE4_TO:
                p.curveTo(cmd.ctrl1.x, cmd.ctrl1.y, cmd.ctrl2.x, cmd.ctrl2.y, e.x, e.y)
            start = e
        if close and first is not None:
            p.close()

    # --- BackendInterface
    def configure(self, cfg) -> None:
        if cfg.min_lineweight:
            self._min_lw = max(0.05, cfg.min_lineweight * 25.4 / 300)

    def set_background(self, color) -> None:
        pass  # the sheet is white

    def draw_point(self, pos, props) -> None:
        self._stroke(props)
        self.c.line(pos.x, pos.y, pos.x, pos.y)

    def draw_line(self, start, end, props) -> None:
        self._stroke(props)
        self.c.line(start.x, start.y, end.x, end.y)

    def draw_solid_lines(self, lines, props) -> None:
        self._stroke(props)
        p = self.c.beginPath()
        for a, b in lines:
            p.moveTo(a.x, a.y)
            p.lineTo(b.x, b.y)
        self.c.drawPath(p, stroke=1, fill=0)

    def draw_path(self, path, props) -> None:
        if len(path) == 0:
            return
        self._stroke(props)
        p = self.c.beginPath()
        self._add(p, path, False)
        self.c.drawPath(p, stroke=1, fill=0)

    def draw_filled_paths(self, paths, props) -> None:
        self._fill(props)
        p = self.c.beginPath()
        for path in paths:
            self._add(p, path, True)
        self.c.drawPath(p, stroke=0, fill=1, fillMode=0)  # even-odd

    def draw_filled_polygon(self, points, props) -> None:
        pts = [(float(q[0]), float(q[1])) for q in points.to_list()]
        if len(pts) < 3:
            return
        self._fill(props)
        p = self.c.beginPath()
        p.moveTo(*pts[0])
        for q in pts[1:]:
            p.lineTo(*q)
        p.close()
        self.c.drawPath(p, stroke=0, fill=1)

    def draw_image(self, image_data, props) -> None:
        from PIL import Image
        from reportlab.lib.utils import ImageReader

        img = image_data.image
        h, w = img.shape[:2]
        t = image_data.transform
        corners = list(t.transform_vertices([Vec2(0, 0), Vec2(w, 0), Vec2(w, h), Vec2(0, h)]))
        xs = [q.x for q in corners]
        ys = [q.y for q in corners]
        pil = Image.fromarray(img, mode="RGBA")
        self.c.drawImage(ImageReader(pil), min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys), mask="auto")

    def clear(self) -> None:
        pass

    def finalize(self) -> None:
        pass

    def enter_entity(self, entity, properties) -> None:
        pass

    def exit_entity(self, entity) -> None:
        pass


_FONTS_READY = False


def _use_fonts() -> None:
    """Texts in osifont (ISO 3098) when the drawing's font is not on this machine: SHX fonts (romans,
    simplex, isocp, txt…) are never here, TrueType fonts may be (Arial on Windows)."""
    global _FONTS_READY
    if _FONTS_READY:
        return
    from ezdxf.fonts import fonts

    from . import pdfcore

    path = Path(pdfcore.FONT_PATH).resolve()
    if path.is_file():
        fm = fonts.font_manager
        fm.scan_folder(path.parent)
        if fm.has_font(path.name):
            fm._fallback_font_name = path.name
            # SHX names resolved by family ("TXT", "ROMANS") also go to osifont
            fm.add_synonyms({path.name: n for n in fonts.SHX_FONTS.values()}, reverse=False)
    _FONTS_READY = True


def _config() -> config.Configuration:
    # a white sheet: ACI 7 drawn black, line weights as in the drawing (0.25 mm by default)
    return config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        color_policy=config.ColorPolicy.COLOR,
        lineweight_policy=config.LineweightPolicy.ABSOLUTE,
        min_lineweight=0.05 / 25.4 * 300,
        hatch_policy=config.HatchPolicy.NORMAL,
        proxy_graphic_policy=config.ProxyGraphicPolicy.SHOW,
    )


class _Texts:
    """Texts drawn in osifont, kept as text (searchable, snapped at their insertion point, not glyph by
    glyph) instead of the outlines ezdxf makes: (string, matrix to drawing units of the em-size-1 text,
    color, corners)."""

    def __init__(self, pipe):
        from ezdxf.addons.drawing.pipeline import prepare_string_for_rendering
        from ezdxf.fonts import fonts

        self.items = []
        self._pipe = pipe
        self._orig = pipe.draw_text
        self._prep = prepare_string_for_rendering
        self._fm = fonts.font_manager
        pipe.draw_text = self.draw_text

    def _is_osifont(self, face) -> bool:
        fm = self._fm
        name = face.filename
        if not name:
            return False
        try:
            fb = fm.fallback_font_name()
            entry = fm._font_cache.get(name if fm.has_font(name) else fb, fb)
            return entry.file_path.name.lower() == "osifont.ttf"
        except Exception:  # noqa: BLE001
            return False

    def draw_text(self, text, transform, properties, cap_height, dxftype="TEXT"):
        pipe = self._pipe
        face = properties.font or pipe.default_font_face
        if not text.strip() or face is None or not self._is_osifont(face):
            return self._orig(text, transform, properties, cap_height, dxftype)
        text = self._prep(text, dxftype)
        eng = pipe.text_engine
        try:
            meas = eng.get_font_measurements(face, cap_height)
            width = eng.get_text_line_width(text, face, cap_height)
        except Exception:  # noqa: BLE001
            return self._orig(text, transform, properties, cap_height, dxftype)
        m = Matrix44.scale(cap_height / _OSI_CAP) @ transform
        # through the viewport(s) the text is seen in: the model → paper transforms; a text cut by a
        # viewport's edge stays outlines (they are clipped, a PDF text would not be)
        portal = pipe.clipping_portal
        corners = [Vec2(0, -meas.descender_height), Vec2(width, -meas.descender_height),
                   Vec2(width, meas.cap_height), Vec2(0, meas.cap_height)]
        pts = [Vec2(q) for q in transform.transform_vertices(corners)]
        if portal.is_active:
            seen = [portal.clip_point(q) for q in pts]
            if any(q is None for q in seen):
                return self._orig(text, transform, properties, cap_height, dxftype)

            def through(stage):
                nonlocal m
                if stage.transform:
                    m = m @ stage.transform
                return True

            portal.foreach_stage(through)
            pts = seen
        self.items.append((text, m, properties.color, pts))


_OSI_CAP = 1515 / 2048  # osifont: cap height / em (the size given to the PDF font)


class _Drawing:
    """A layout as recorded by ezdxf (geometry) plus its texts."""

    def __init__(self, rec, texts):
        self.rec = rec
        self.texts = texts

    def bbox(self) -> BoundingBox2d | None:
        b = self.rec.player().bbox()
        for *_x, pts in self.texts:
            b.extend(pts)
        return b if b.has_data else None


def _record(doc, layout_obj) -> _Drawing:
    _use_fonts()
    rec = recorder.Recorder()
    ctx = RenderContext(doc)
    fe = frontend.Frontend(ctx, rec, config=_config())
    texts = _Texts(fe.pipeline)
    fe.draw_layout(layout_obj, finalize=True)
    return _Drawing(rec, texts.items)


def _place(drw: _Drawing, c, page_mm: tuple[float, float], box: BoundingBox2d) -> None:
    """The recorded drawing, its `box` (drawing units) filling the page (no margins: the box already has
    the sheet's proportions), on a new page of the canvas."""
    from . import pdfcore

    wmm, hmm = page_mm
    player = drw.rec.player()
    page = layout.Page(wmm, hmm, layout.Units.mm)
    out = layout.Layout(box, flip_y=False)
    settings = layout.Settings(fit_page=True, output_coordinate_space=max(wmm, hmm) * MM)
    m = out.get_placement_matrix(page, settings=settings, top_origin=False)
    player.transform(m)
    c.setPageSize((wmm * MM, hmm * MM))
    be = _Canvas(c, wmm * MM, hmm * MM)
    be.configure(_config())
    player.replay(be)
    if drw.texts:
        pdfcore._register_font()
        for text, tm, color, _pts in drw.texts:
            t = tm @ m
            c.saveState()
            c.setFillGray(_ink(color))
            c.transform(t[0, 0], t[0, 1], t[1, 0], t[1, 1], t[3, 0], t[3, 1])
            c.setFont(pdfcore.FONT_NAME, 1)
            c.drawString(0, 0, text)
            c.restoreState()
    c.showPage()


def fit_sheet(width: float, height: float) -> tuple[str, float, float, float]:
    """An ISO sheet (landscape or portrait) and a standard scale for a model-space drawing of
    width × height mm, with the margin: (name, sheet w, sheet h, scale paper/drawing).
    A small part is enlarged on A4 (10:1, 5:1, 2:1); otherwise 1:1 on the smallest sheet it fits (up to
    A0); a larger drawing is reduced, at the first standard scale that fits some sheet."""
    def fits(sc, sw, sh):
        for w, h in ((sw, sh), (sh, sw)):
            if width * sc <= w - 2 * MARGIN and height * sc <= h - 2 * MARGIN:
                return w, h
        return None

    a4 = SHEETS[0]
    for sc in (10, 5, 2):
        wh = fits(sc, a4[1], a4[2])
        if wh:
            return a4[0], wh[0], wh[1], sc
    for sc in [1] + [s for s in SCALES if s < 1]:
        for name, sw, sh in SHEETS:
            wh = fits(sc, sw, sh)
            if wh:
                return name, wh[0], wh[1], sc
    # larger than A0 at 1:1000: A0 at whatever scale it takes
    name, sw, sh = SHEETS[-1]
    sc = min((sw - 2 * MARGIN) / max(width, 1e-9), (sh - 2 * MARGIN) / max(height, 1e-9))
    return name, sw, sh, sc


def core_extents(msp, full: BoundingBox2d, max_entities: int = 50000):
    """Model space without a few far-away strays (a point or block lost kilometres away, which makes
    "zoom extents" useless): the extents of the 97 % of entities nearest to the median, if the rest makes
    the drawing over 5× larger. → (extents, number of entities left out) or None."""
    from ezdxf import bbox as ebbox

    cache = ebbox.Cache()
    items = []
    for i, e in enumerate(msp):
        if i >= max_entities:
            return None
        try:
            eb = ebbox.extents([e], cache=cache, fast=True)
        except Exception:  # noqa: BLE001
            continue
        if eb.has_data:
            items.append(BoundingBox2d([Vec2(eb.extmin), Vec2(eb.extmax)]))
    if len(items) < 10:
        return None
    xs = sorted(b.center.x for b in items)
    ys = sorted(b.center.y for b in items)
    med = Vec2(xs[len(xs) // 2], ys[len(ys) // 2])
    items.sort(key=lambda b: (b.center - med).magnitude)
    keep = items[: max(1, math.ceil(len(items) * 0.97))]
    core = BoundingBox2d()
    for b in keep:
        core.extend([b.extmin, b.extmax])
    big = max(full.size.x, full.size.y)
    small = max(core.size.x, core.size.y, 1e-9)
    if big <= 5 * small:
        return None
    out = sum(1 for b in items[len(keep):] if not (core.inside(b.extmin) and core.inside(b.extmax)))
    return core, out


def expanded_count(doc, limit: int) -> int:
    """Entities drawn once block references are expanded (nested blocks, insert arrays, dimension
    blocks): a few inserts can stand for billions of lines. Stops counting past `limit`; a block that
    contains itself counts as over the limit."""
    memo: dict[str, int] = {}
    busy: set[str] = set()

    def block(name: str) -> int:
        key = name.lower()
        if key in memo:
            return memo[key]
        if key in busy:
            return limit + 1  # recursion
        blk = doc.blocks.get(name)
        if blk is None:
            return 0
        busy.add(key)
        n = count(blk)
        busy.discard(key)
        memo[key] = n
        return n

    def count(entities) -> int:
        n = 0
        for e in entities:
            t = e.dxftype()
            n += 1
            if t == "INSERT":
                reps = max(1, int(e.dxf.get("row_count", 1))) * max(1, int(e.dxf.get("column_count", 1)))
                n += reps * block(e.dxf.name)
            elif t == "DIMENSION" or t.startswith("ARC_DIMENSION"):
                g = e.dxf.get("geometry")
                if g:
                    n += block(g)
            if n > limit:
                return limit + 1
        return n

    total = 0
    for lay in doc.layouts:
        total += count(lay)
        if total > limit:
            return limit + 1
    return total


def dxf_to_pdf(data: bytes, max_entities: int = 0) -> tuple[bytes, dict]:
    """DXF (ASCII or binary) → (PDF, info). info: pages [{name, space, sheet, scale}] where scale is the
    drawing scale for DrawCAD (real mm per paper mm), and the audit counts."""
    from reportlab.pdfgen import canvas as rl

    if data[:22] == b"AutoCAD Binary DXF\r\n\x1a\x00":
        from ezdxf.document import Drawing
        from ezdxf.lldxf.tagger import binary_tags_loader

        doc = Drawing.load(binary_tags_loader(data, errors="surrogateescape"))
        auditor = doc.audit()
    else:
        from ezdxf import recover

        doc, auditor = recover.read(io.BytesIO(data))
    if max_entities:
        n = expanded_count(doc, max_entities)
        if n > max_entities:
            raise TooLarge(n)
    unit = UNIT_MM.get(int(doc.header.get("$INSUNITS", 4) or 4), 1.0)
    buf = io.BytesIO()
    c = rl.Canvas(buf, pageCompression=1)
    c.setTitle("DXF")
    pages = []
    # a DXF exported by DrawCAD: its page frame and scale, exactly
    dc = drawcad_page(doc)
    if dc:
        # a DXF exported by DrawCAD: its page, exactly ((0, 0)…sheet × scale in model space)
        sw, sh, scale = dc
        rec = _record(doc, doc.modelspace())
        box = BoundingBox2d([Vec2(0, 0), Vec2(sw * scale / unit, sh * scale / unit)])
        _place(rec, c, (sw, sh), box)
        pages.append({"name": "Model", "space": "model", "sheet": [round(sw, 3), round(sh, 3)], "scale": round(scale, 6)})
    if not pages:
        # paper-space layouts with something on them, in tab order
        for lay in sorted(doc.layouts, key=lambda x: x.dxf.get("taborder", 0)):
            if lay.is_modelspace or not len(lay):
                continue
            rec = _record(doc, lay)
            if rec.bbox() is None:
                continue
            page = layout.Page.from_dxf_layout(lay)
            wmm, hmm = page.width_in_mm, page.height_in_mm
            if not (wmm > 1 and hmm > 1):
                continue
            # the whole paper, in paper-space units (its origin is where the plot margins start)
            lo, hi = lay.get_paper_limits()
            box = BoundingBox2d([Vec2(lo), Vec2(hi)])
            _place(rec, c, (wmm, hmm), box)
            vps = [v for v in lay.viewports() if v.dxf.get("status", 1) > 1 and v.dxf.view_height > 0]
            scale = (vps[0].dxf.view_height / vps[0].dxf.height) * unit if vps else 1.0
            pages.append({"name": lay.name, "space": "paper", "sheet": [round(wmm, 2), round(hmm, 2)], "scale": round(scale, 6)})
    if not pages:
        rec = _record(doc, doc.modelspace())
        outliers = 0
        b = rec.bbox()
        if b is None:
            raise ValueError("Desenul DXF nu are nimic de afișat")
        core = core_extents(doc.modelspace(), b)
        if core is not None:
            b, outliers = core
        wmm, hmm = b.size.x * unit, b.size.y * unit
        name, sw, sh, sc = fit_sheet(wmm, hmm)
        cx, cy = b.center.x, b.center.y
        half = Vec2(sw / sc / unit / 2, sh / sc / unit / 2)
        box = BoundingBox2d([Vec2(cx, cy) - half, Vec2(cx, cy) + half])
        _place(rec, c, (sw, sh), box)
        pages.append({"name": "Model", "space": "model", "sheet": [sw, sh], "scale": round(1 / sc, 6), "iso": name})
        if outliers:
            pages[-1]["outliers"] = outliers
    c.save()
    info = {"pages": pages, "fixes": len(auditor.fixes), "errors": len(auditor.errors), "units_mm": unit}
    return buf.getvalue(), info


def drawcad_page(doc) -> tuple[float, float, float] | None:
    """(sheet w, sheet h, scale) written by DrawCAD's DXF export, or None."""
    cv = doc.header.custom_vars
    try:
        vals = tuple(float(cv.get(k)) for k in DRAWCAD_VARS)
    except (TypeError, ValueError):
        return None
    sw, sh, sc = vals
    if not (1 <= sw <= 20000 and 1 <= sh <= 20000 and 1e-6 <= sc <= 1e6):
        return None
    return vals


if __name__ == "__main__":  # quick manual check: python -m app.dxfin file.dxf out.pdf
    import sys

    pdf, info = dxf_to_pdf(Path(sys.argv[1]).read_bytes())
    Path(sys.argv[2]).write_bytes(pdf)
    print(info)
