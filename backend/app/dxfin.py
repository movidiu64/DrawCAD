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
import re
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


_COLORS = False  # set by dxf_to_pdf: the drawing's own colors instead of a monochrome plot


def _ink(color: str) -> tuple[float, float, float]:
    """Plotted as with monochrome.ctb: every color black (yellow or cyan lines are unreadable on paper),
    except the white of wipeouts and background fills, which hides what is under it. With the drawing's
    own colors (an option when opening), only the white of ACI 7 lines becomes black. → RGB."""
    r, g, b = RGB.from_hex(color[:7]).to_floats()
    white = min(r, g, b) > 0.98
    if _COLORS:
        return (r, g, b)
    return (1.0, 1.0, 1.0) if white else (0.0, 0.0, 0.0)


def _set_fill(c, color: str) -> None:
    c.setFillColorRGB(*_ink(color))


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
        self.handles: list[str] = []  # the DXF entity of each PDF object, in drawing order
        self.layers: list[str] = []  # and its layer (inside a block: the layer it is drawn on)

    # --- state
    def _stroke(self, props):
        self.c.setStrokeColorRGB(*_ink(props.color))
        self.c.setLineWidth(max(self._min_lw, props.lineweight) * MM)

    def _fill(self, props):
        self.c.setFillColorRGB(*_ink(props.color))

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
        self.handles.append(props.handle)
        self.layers.append(props.layer)

    def draw_line(self, start, end, props) -> None:
        self._stroke(props)
        self.c.line(start.x, start.y, end.x, end.y)
        self.handles.append(props.handle)
        self.layers.append(props.layer)

    def draw_solid_lines(self, lines, props) -> None:
        if not lines:
            return
        self._stroke(props)
        p = self.c.beginPath()
        for a, b in lines:
            p.moveTo(a.x, a.y)
            p.lineTo(b.x, b.y)
        self.c.drawPath(p, stroke=1, fill=0)
        self.handles.append(props.handle)
        self.layers.append(props.layer)

    def draw_path(self, path, props) -> None:
        if len(path) == 0:
            return
        self._stroke(props)
        p = self.c.beginPath()
        self._add(p, path, False)
        self.c.drawPath(p, stroke=1, fill=0)
        self.handles.append(props.handle)
        self.layers.append(props.layer)

    def draw_filled_paths(self, paths, props) -> None:
        if not any(len(q) for q in paths):
            return
        self._fill(props)
        p = self.c.beginPath()
        for path in paths:
            self._add(p, path, True)
        self.c.drawPath(p, stroke=0, fill=1, fillMode=0)  # even-odd
        self.handles.append(props.handle)
        self.layers.append(props.layer)

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
        self.handles.append(props.handle)
        self.layers.append(props.layer)

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
        self.handles.append(props.handle)
        self.layers.append(props.layer)

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
    """Texts kept as PDF text (searchable, snapped at their insertion point, not glyph by glyph) instead
    of the outlines ezdxf makes, in the font ezdxf measured them with: osifont for SHX fonts and fonts
    missing here, the drawing's own TrueType font when it is on this machine. Items: (string, matrix
    to drawing units of the em-size-1 text, color, corners, entity handle, layer, PDF font name)."""

    def __init__(self, pipe):
        from ezdxf.addons.drawing.pipeline import prepare_string_for_rendering

        self.items = []
        self._pipe = pipe
        self._orig = pipe.draw_text
        self._prep = prepare_string_for_rendering
        pipe.draw_text = self.draw_text

    def _pdf_font(self, face):
        """(ReportLab font name, em size per cap height) of the font ezdxf draws `face` with, or None
        (a font ReportLab cannot embed: the text stays outlines)."""
        try:
            font = self._pipe.text_engine.get_font(face)
            glyphs = font.glyph_cache
            tt = glyphs.font
            path = tt.reader.file.name
            per_cap = tt["head"].unitsPerEm / glyphs.font_measurements.cap_height
        except Exception:  # noqa: BLE001 (a shape font, a font without its file)
            return None
        name = _rl_font(path)
        return (name, per_cap) if name and per_cap > 0 else None

    def draw_text(self, text, transform, properties, cap_height, dxftype="TEXT"):
        pipe = self._pipe
        face = properties.font or pipe.default_font_face
        pf = self._pdf_font(face) if text.strip() and face is not None else None
        if pf is None:
            return self._orig(text, transform, properties, cap_height, dxftype)
        text = self._prep(text, dxftype)
        eng = pipe.text_engine
        try:
            meas = eng.get_font_measurements(face, cap_height)
            width = eng.get_text_line_width(text, face, cap_height)
        except Exception:  # noqa: BLE001
            return self._orig(text, transform, properties, cap_height, dxftype)
        m = Matrix44.scale(cap_height * pf[1]) @ transform
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
        self.items.append((text, m, properties.color, pts, pipe._current_entity_handle, properties.layer, pf[0]))


_RL_FONTS: dict[str, str | None] = {}


def _rl_font(path: str) -> str | None:
    """The TrueType file registered with ReportLab (embedded as a subset in the PDF): osifont under
    DrawCAD's own name; None for what ReportLab cannot embed (CFF / OpenType outlines, collections)."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    from . import pdfcore

    key = os.path.normcase(os.path.abspath(path))
    if key in _RL_FONTS:
        return _RL_FONTS[key]
    name = None
    try:
        if os.path.normcase(os.path.abspath(pdfcore.FONT_PATH)) == key:
            pdfcore._register_font()
            name = pdfcore.FONT_NAME
        elif key.endswith(".ttf"):
            name = "DXF-" + re.sub(r"[^A-Za-z0-9]+", "", Path(path).stem)[:40] + f"-{len(_RL_FONTS)}"
            pdfmetrics.registerFont(TTFont(name, path))
        else:
            name = None
    except Exception:  # noqa: BLE001
        name = None
    _RL_FONTS[key] = name
    return name


class _Drawing:
    """A layout as recorded by ezdxf (geometry) plus its texts."""

    def __init__(self, rec, texts):
        self.rec = rec
        self.texts = texts

    def bbox(self) -> BoundingBox2d | None:
        b = self.rec.player().bbox()
        for t in self.texts:
            b.extend(t[3])
        return b if b.has_data else None


def _record(doc, layout_obj) -> _Drawing:
    _use_fonts()
    rec = recorder.Recorder()
    ctx = RenderContext(doc)
    fe = frontend.Frontend(ctx, rec, config=_config())
    texts = _Texts(fe.pipeline)
    fe.draw_layout(layout_obj, finalize=True)
    return _Drawing(rec, texts.items)


def _place(drw: _Drawing, c, page_mm: tuple[float, float], box: BoundingBox2d) -> tuple[list, tuple[list[str], list[str]]]:
    """The recorded drawing, its `box` (drawing units) filling the page (no margins: the box already has
    the sheet's proportions), on a new page of the canvas. → (the drawing → PDF points transform
    [a, b, c, d, e, f], the DXF entity handle of each PDF object on the page, in order)."""
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
    handles, layers = be.handles, be.layers
    if drw.texts:
        for text, tm, color, _pts, handle, lay, font in drw.texts:
            t = tm @ m
            c.saveState()
            _set_fill(c, color)
            c.transform(t[0, 0], t[0, 1], t[1, 0], t[1, 1], t[3, 0], t[3, 1])
            c.setFont(font, 1)
            c.drawString(0, 0, text)
            c.restoreState()
            handles.append(handle)
            layers.append(lay)
    c.showPage()
    return [round(float(m[i, j]), 12) for i, j in ((0, 0), (0, 1), (1, 0), (1, 1), (3, 0), (3, 1))], (handles, layers)


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


# sheet frames a drawing may carry in model space (SolidWorks, Solid Edge…): A6 … A0, mm
ISO_FRAMES = [("A6", 148, 105), ("A5", 210, 148), *SHEETS]


def _rect_of(pts: list) -> BoundingBox2d | None:
    """The rectangle a polyline draws along (closed or not, corners repeated or not): all its vertices on
    the edges of its bounding box, every corner reached."""
    if len(pts) < 4:
        return None
    b = BoundingBox2d(pts)
    if b.size.x <= 0 or b.size.y <= 0:
        return None
    eps = 1e-6 * max(b.size.x, b.size.y)
    on_edge = all(min(abs(q.x - b.extmin.x), abs(q.x - b.extmax.x)) <= eps or min(abs(q.y - b.extmin.y), abs(q.y - b.extmax.y)) <= eps for q in pts)
    corners = [Vec2(b.extmin.x, b.extmin.y), Vec2(b.extmax.x, b.extmin.y), Vec2(b.extmax.x, b.extmax.y), Vec2(b.extmin.x, b.extmax.y)]
    hit = all(any(q.isclose(c, abs_tol=eps * 10) for q in pts) for c in corners)
    # an open path with 4 corners has at least 5 vertices (back to the start) or misses one side: the
    # 3 sides drawn and the title block line make a frame too, so 4 corners reached are enough
    return b if on_edge and hit else None


def sheet_frame(msp, full: BoundingBox2d, unit: float, max_entities: int = 50000):
    """The sheet of a drawing whose frame is drawn in model space (SolidWorks, Solid Edge, AutoCAD
    templates…): → (page box in drawing units, sheet name, sheet w, sheet h mm, scale paper/drawing) or
    None. Found, in this order:
    - a rectangle of an ISO size (A6 … A0) at a standard scale: the sheet edge, edge to edge;
    - the extents of the drawing themselves of an ISO size (the corners of the sheet are drawn);
    - a rectangle that is an ISO sheet less its margins (ISO 5457: 20 mm to the left for filing, 10 mm
      elsewhere, or alike): the sheet around it.
    Rectangles are polylines along a rectangle, or four lines. Between equivalent sizes (ISO sizes are
    all alike: an A6 frame at 1:1 is also an A4 frame at 2:1, as SolidWorks exports a sheet scaled to the
    drawing) the text heights decide: the scale nearest 1:1 at which they come out 1.4 … 7 mm high."""
    tol = 0.01
    horiz, vert, rects = [], [], []
    for i, e in enumerate(msp):
        if i >= max_entities:
            return None
        t = e.dxftype()
        if t == "LINE":
            a, b = Vec2(e.dxf.start), Vec2(e.dxf.end)
            if abs(a.y - b.y) <= 1e-6 * max(1, abs(a.x - b.x)) and abs(a.x - b.x) > 0:
                horiz.append((min(a.x, b.x), max(a.x, b.x), a.y))
            elif abs(a.x - b.x) <= 1e-6 * max(1, abs(a.y - b.y)) and abs(a.y - b.y) > 0:
                vert.append((min(a.y, b.y), max(a.y, b.y), a.x))
        elif t == "LWPOLYLINE" and len(e) >= 4:
            r = _rect_of([Vec2(q) for q in e.get_points("xy")])
            if r is not None:
                rects.append(r)
        elif t == "POLYLINE" and e.is_2d_polyline and len(e) >= 4:
            r = _rect_of([Vec2(v.dxf.location) for v in e.vertices])
            if r is not None:
                rects.append(r)
    # four lines: two horizontal ones with the same span, closed by vertical ones at their ends
    span = max(full.size.x, full.size.y)
    hs = sorted((h for h in horiz if h[1] - h[0] > 0.3 * span), key=lambda h: h[0] - h[1])[:16]
    for i, (x0, x1, y0) in enumerate(hs):
        for xa, xb, y1 in hs[i + 1:]:
            if abs(xa - x0) > tol * span or abs(xb - x1) > tol * span or abs(y1 - y0) < 0.1 * span:
                continue
            lo, hi = min(y0, y1), max(y0, y1)
            sides = [v for v in vert if abs(v[0] - lo) <= tol * span and abs(v[1] - hi) <= tol * span]
            if any(abs(v[2] - x0) <= tol * span for v in sides) and any(abs(v[2] - x1) <= tol * span for v in sides):
                rects.append(BoundingBox2d([Vec2(x0, lo), Vec2(x1, hi)]))
    # around nearly everything (the extents may stick out a little: a stray text): the largest
    rects = [r for r in rects if r.size.x >= 0.85 * full.size.x and r.size.y >= 0.85 * full.size.y]
    rect = max(rects, key=lambda q: q.size.x * q.size.y) if rects else None
    scales = (1, 2, 5, 10, *[s for s in SCALES if s < 1])

    def iso_fits(w, h):
        out = []
        for name, sw, sh in ISO_FRAMES:
            for pw, ph in ((sw, sh), (sh, sw)):
                for sc in scales:
                    if abs(w * sc - pw) <= max(1.5, 0.006 * pw) and abs(h * sc - ph) <= max(1.5, 0.006 * ph):
                        out.append((name, pw, ph, sc))
        return out

    hs_ = sorted(e.dxf.char_height if e.dxftype() == "MTEXT" else e.dxf.height
                 for e in msp.query("TEXT MTEXT") if (e.dxf.get("char_height") if e.dxftype() == "MTEXT" else e.dxf.get("height")))
    med = hs_[len(hs_) // 2] * unit if hs_ else None

    def readable(sc):  # the texts come out 1.4 … 7 mm high on paper
        return med is None or 1.4 <= med * sc <= 7

    def pick(fits):
        ok = [f for f in fits if readable(f[-1])] or fits
        return min(ok, key=lambda f: abs(math.log(f[-1])))  # the scale nearest 1:1

    # 1. the sheet edge
    if rect is not None:
        fits = iso_fits(rect.size.x * unit, rect.size.y * unit)
        if fits:
            name, pw, ph, sc = pick(fits)
            return rect, name, rect.size.x * unit * sc, rect.size.y * unit * sc, sc
    # 2. the extents: the sheet corners are drawn
    fits = iso_fits(full.size.x * unit, full.size.y * unit)
    if fits and rect is not None:
        name, pw, ph, sc = pick(fits)
        return full, name, full.size.x * unit * sc, full.size.y * unit * sc, sc
    # 3. a frame inside the sheet's margins (a drawing with texts: a bare rectangle may be the part)
    if rect is None or med is None:
        return None
    w, h = rect.size.x * unit, rect.size.y * unit
    fits = []
    for name, sw, sh in ISO_FRAMES:
        for pw, ph in ((sw, sh), (sh, sw)):
            for sc in scales:
                mx, my = pw - w * sc, ph - h * sc  # margins on paper, both sides together
                if 8 <= mx <= 45 and 8 <= my <= 45 and abs(mx - my) <= 25 and readable(sc):
                    fits.append((name, pw, ph, mx + my, sc))
    if not fits:
        return None
    name, pw, ph, _m, sc = min(fits, key=lambda f: (abs(math.log(f[4])), f[3]))
    mx, my = pw - w * sc, ph - h * sc
    side = my / 2  # top, bottom and right; the rest of the width is the filing margin, on the left
    left = mx - side if mx >= my else mx / 2
    k = 1 / (sc * unit)
    o = Vec2(rect.extmin.x - left * k, rect.extmin.y - side * k)
    return BoundingBox2d([o, o + Vec2(pw * k, ph * k)]), name, pw, ph, sc


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


def _paper_box(lay, content: BoundingBox2d, wmm: float, hmm: float) -> BoundingBox2d:
    """The sheet of a paper-space layout, in paper-space units. The LIMITS when they match the paper size
    (many files leave them at the 12 × 9 default); else the printable area from the plot margins, which
    starts at paper (0, 0); else the sheet centered on what is drawn."""
    u = 25.4 if lay.dxf_layout.dxf.get("plot_paper_units", 1) == 0 else 1.0  # paper units: inch / mm
    w, h = wmm / u, hmm / u
    lo, hi = (Vec2(p) for p in lay.get_paper_limits())
    lim = hi - lo
    if abs(lim.x - w) <= 0.02 * w and abs(lim.y - h) <= 0.02 * h:
        return BoundingBox2d([lo, hi])
    m = layout.Page.from_dxf_layout(lay).margins_in_mm
    o = Vec2(-m.left / u, -m.bottom / u)
    plot = BoundingBox2d([o, o + Vec2(w, h)])
    tol = 0.01 * max(w, h)
    if (content.extmin.x >= plot.extmin.x - tol and content.extmin.y >= plot.extmin.y - tol
            and content.extmax.x <= plot.extmax.x + tol and content.extmax.y <= plot.extmax.y + tol):
        return plot
    c = content.center
    return BoundingBox2d([c - Vec2(w / 2, h / 2), c + Vec2(w / 2, h / 2)])


def fix_viewports(doc) -> int:
    """Viewports as LibreDWG writes them: every one with id 0 and status 0 ("off"), which AutoCAD works
    out on loading and DXF readers take as given, so the views of every layout stayed empty. In a layout
    whose viewports all have id 0 and status 0, the first one (the paper itself, as AutoCAD stores it)
    gets id 1 and the others are switched on. → number of viewports switched on."""
    on = 0
    for lay in doc.layouts:
        if lay.is_modelspace:
            continue
        vps = list(lay.query("VIEWPORT"))
        if len(vps) < 2 or any(v.dxf.get("status", 0) != 0 or v.dxf.get("id", 0) != 0 for v in vps):
            continue
        for n, v in enumerate(vps):
            v.dxf.id = n + 1
            v.dxf.status = n + 1
            on += n > 0
    return on


def rebuild_inventor(doc) -> int:
    """Drawings saved as DWG by Inventor keep every view, the border and the title block in anonymous
    blocks (*I1, *I2…) placed by Inventor's own block references (ACIDBLOCKREFERENCE), which only
    Inventor's object enabler can read: LibreDWG and AutoCAD without it drop them and the sheet is
    empty. The blocks themselves are there, so they are placed again in the layout: blocks drawn in
    sheet coordinates (border, title block, notes) at (0, 0); each view block centred on the viewport
    frame Inventor leaves for it (matched by size: the view fits its frame, with an equal margin), at
    the frame's scale. → number of blocks placed (0: nothing to do)."""
    from ezdxf import bbox as ebbox

    if not any(k[0] == "ACIDBLOCKREFERENCE" for k in doc.classes.classes):
        return 0
    used = set()
    for blk in doc.blocks:
        for e in blk:
            if e.dxftype() == "INSERT":
                used.add(e.dxf.name.upper())
    cand = []
    for blk in doc.blocks:
        n = blk.name
        if not re.fullmatch(r"\*I\d+", n, re.I) or n.upper() in used or not len(blk):
            continue
        try:
            ext = ebbox.extents(blk, fast=True)
        except Exception:  # noqa: BLE001
            continue
        if ext.has_data:
            cand.append((n, BoundingBox2d([Vec2(ext.extmin), Vec2(ext.extmax)])))
    if not cand:
        return 0
    placed = 0
    papers = sorted((lay for lay in doc.layouts if not lay.is_modelspace), key=lambda x: x.dxf.get("taborder", 0))
    # the sheets Inventor made: layouts with view frames (an empty default layout gets nothing)
    framed = [lay for lay in papers if any(v.dxf.get("id", 0) != 1 for v in lay.query("VIEWPORT"))]
    for lay in framed or papers[:1]:
        page = layout.Page.from_dxf_layout(lay)
        tol = 0.02 * max(page.width_in_mm, page.height_in_mm)
        # model windows of the viewports (the layout's own, id 1, is the paper itself), smallest first
        wins = []
        for v in lay.query("VIEWPORT"):
            if v.dxf.get("id", 0) == 1 or v.dxf.view_height <= 0 or v.dxf.height <= 0:
                continue
            k = v.dxf.view_height / v.dxf.height
            wins.append((Vec2(v.dxf.center), k, v.dxf.width * k, v.dxf.view_height))
        wins.sort(key=lambda w: w[2] * w[3])
        for pc, k, ww, wh in wins:
            fits = [nb for nb in cand if nb[1].size.x <= ww + 1e-6 and nb[1].size.y <= wh + 1e-6]
            if fits:
                n, b = max(fits, key=lambda nb: nb[1].size.x * nb[1].size.y)
                lay.add_blockref(n, pc - b.center / k, dxfattribs={"xscale": 1 / k, "yscale": 1 / k})
                cand.remove((n, b))
                placed += 1
        for n, b in list(cand):
            if (b.extmin.x >= -tol and b.extmin.y >= -tol
                    and b.extmax.x <= page.width_in_mm + tol and b.extmax.y <= page.height_in_mm + tol):
                lay.add_blockref(n, (0, 0))
                cand.remove((n, b))
                placed += 1
    return placed


def dxf_to_pdf(data: bytes, max_entities: int = 0, colors: bool = False) -> tuple[bytes, dict]:
    """DXF (ASCII or binary) → (PDF, info). info: pages [{name, space, sheet, scale}] where scale is the
    drawing scale for DrawCAD (real mm per paper mm), and the audit counts. `colors`: the drawing's own
    colors instead of a monochrome plot (the same objects in the same order, so object ids match)."""
    global _COLORS
    _COLORS = bool(colors)
    try:
        return _dxf_to_pdf(data, max_entities)
    finally:
        _COLORS = False


def _dxf_to_pdf(data: bytes, max_entities: int) -> tuple[bytes, dict]:
    from reportlab.pdfgen import canvas as rl

    doc, auditor = load(data)
    fix_viewports(doc)
    rebuilt = rebuild_inventor(doc)
    if max_entities:
        n = expanded_count(doc, max_entities)
        if n > max_entities:
            raise TooLarge(n)
    unit = UNIT_MM.get(int(doc.header.get("$INSUNITS", 4) or 4), 1.0)
    buf = io.BytesIO()
    c = rl.Canvas(buf, pageCompression=1)
    c.setTitle("DXF")
    pages = []
    maps = []
    # a DXF exported by DrawCAD: its page frame and scale, exactly
    dc = drawcad_page(doc)
    if dc:
        # a DXF exported by DrawCAD: its page, exactly ((0, 0)…sheet × scale in model space)
        sw, sh, scale = dc
        rec = _record(doc, doc.modelspace())
        box = BoundingBox2d([Vec2(0, 0), Vec2(sw * scale / unit, sh * scale / unit)])
        tf, hl = _place(rec, c, (sw, sh), box)
        maps.append(hl)
        pages.append({"name": "Model", "space": "model", "sheet": [round(sw, 3), round(sh, 3)], "scale": round(scale, 6), "tf": tf})
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
            box = _paper_box(lay, rec.bbox(), wmm, hmm)
            tf, hl = _place(rec, c, (wmm, hmm), box)
            maps.append(hl)
            vps = [v for v in lay.viewports() if v.dxf.get("status", 1) > 1 and v.dxf.view_height > 0]
            scale = (vps[0].dxf.view_height / vps[0].dxf.height) * unit if vps else 1.0
            pages.append({"name": lay.name, "space": "paper", "sheet": [round(wmm, 2), round(hmm, 2)], "scale": round(scale, 6), "tf": tf})
    if not pages:
        rec = _record(doc, doc.modelspace())
        outliers = 0
        b = rec.bbox()
        if b is None:
            raise ValueError("Desenul DXF nu are nimic de afișat")
        frame = sheet_frame(doc.modelspace(), b, unit)
        if frame is not None:
            # the drawing brings its own sheet: that is the page, edge to edge
            # (its own size: a frame drawn 148.5 tall for A6 is not cut by a 148 mm page)
            box, name, sw, sh, sc = frame
            sw, sh = round(sw, 3), round(sh, 3)
        else:
            core = core_extents(doc.modelspace(), b)
            if core is not None:
                b, outliers = core
            wmm, hmm = b.size.x * unit, b.size.y * unit
            name, sw, sh, sc = fit_sheet(wmm, hmm)
            cx, cy = b.center.x, b.center.y
            half = Vec2(sw / sc / unit / 2, sh / sc / unit / 2)
            box = BoundingBox2d([Vec2(cx, cy) - half, Vec2(cx, cy) + half])
        tf, hl = _place(rec, c, (sw, sh), box)
        maps.append(hl)
        pages.append({"name": "Model", "space": "model", "sheet": [sw, sh], "scale": round(1 / sc, 6), "iso": name, "tf": tf})
        if frame is not None:
            pages[-1]["frame"] = True
        if outliers:
            pages[-1]["outliers"] = outliers
    c.save()
    pdf = buf.getvalue()
    if rebuilt:
        # the drawing as placed again: the DXF kept for export is this one
        s = io.StringIO()
        doc.write(s)
        fixed = s.getvalue().encode("utf-8")
    checked = _checked_maps(pdf, [h for h, _l in maps])
    info = {"pages": pages, "fixes": len(auditor.fixes), "errors": len(auditor.errors), "units_mm": unit,
            "inventor": rebuilt, "handles": checked,
            "layer_map": _layer_map(doc, [(h, lay) if ok is not None else None for (h, lay), ok in zip(maps, checked)])}
    if rebuilt:
        info["fixed_dxf"] = fixed
    return pdf, info


def _layer_map(doc, per_page: list) -> dict:
    """The layer of each PDF object, as indices into `names`, and the layers with their color and how
    many objects they have (for the layer list in the editor). As in CAD, what is drawn on layer 0
    inside a block (a dimension's lines, a block's geometry) belongs to the layer of the block itself."""
    names: list[str] = []
    idx: dict[str, int] = {}
    pages = []
    count: dict[str, int] = {}
    top: dict[str, str] = {}

    def top_layer(h):
        if h not in top:
            e = doc.entitydb.get(h) if h else None
            top[h] = e.dxf.get("layer", "0") if e is not None else "0"
        return top[h]

    for item in per_page:
        if item is None:
            pages.append(None)
            continue
        row = []
        for h, n in zip(*item):
            n = n or "0"
            if n == "0":
                n = top_layer(h) or "0"
            if n not in idx:
                idx[n] = len(names)
                names.append(n)
            row.append(idx[n])
            count[n] = count.get(n, 0) + 1
        pages.append(row)
    summary = []
    for n in sorted(names, key=str.casefold):
        col = "#000000"
        try:
            la = doc.layers.get(n)
            if la is not None:
                tc = la.dxf.get("true_color")
                rgb = ezdxf.colors.int2rgb(tc) if tc is not None else ezdxf.colors.aci2rgb(abs(la.color) or 7)
                col = "#%02x%02x%02x" % tuple(rgb)
        except Exception:  # noqa: BLE001
            pass
        # ACI 7 (black on white, white on black): the editor shows it in the text color
        summary.append({"name": n, "color": None if col == "#ffffff" else col, "n": count[n]})
    return {"names": names, "pages": pages, "layers": summary}


def _checked_maps(pdf: bytes, maps: list[list[str]]) -> list:
    """The handle lists, kept only for pages where they match the PDF's objects one to one (a text
    split in two by its font, say, would shift them): None for the others."""
    import pypdfium2 as pdfium

    from . import pdfcore

    out = []
    with pdfcore.PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf)
        try:
            for i, hs in enumerate(maps):
                n = pdfium.raw.FPDFPage_CountObjects(doc[i].raw)
                out.append(hs if n == len(hs) else None)
        finally:
            doc.close()
    return out


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


def load(data: bytes):
    """The DXF (ASCII or binary) as ezdxf reads it, repaired: (doc, auditor)."""
    if data[:22] == b"AutoCAD Binary DXF\r\n\x1a\x00":
        from ezdxf.document import Drawing
        from ezdxf.lldxf.tagger import binary_tags_loader

        doc = Drawing.load(binary_tags_loader(data, errors="surrogateescape"))
        return doc, doc.audit()
    from ezdxf import recover

    try:
        return recover.read(io.BytesIO(data))
    except ValueError as e:
        if "Invalid handle" not in str(e):
            raise
        return recover.read(io.BytesIO(_drop_null_entries(data)))


def _drop_null_entries(data: bytes) -> bytes:
    """Dictionary entries that point to handle 0 (LibreDWG writes nameless ones for objects it could not
    read: the root dictionary of many R2000 / R2004 DWGs), which stop ezdxf: left out."""
    lines = data.split(b"\n")
    out = []
    i = 0
    n = len(lines)
    while i + 1 < n:  # walk group code / value pairs, so a value is never read as a code
        if (i + 3 < n and lines[i].strip() == b"3" and lines[i + 2].strip() in (b"350", b"360")
                and lines[i + 3].strip() == b"0"):
            i += 4
            continue
        out += lines[i:i + 2]
        i += 2
    out += lines[i:]
    return b"\n".join(out)


def export_source(data: bytes, pages: list[dict], color: str = "black", hidden: list[str] | None = None) -> tuple[bytes, dict]:
    """The DXF export of a drawing opened from DXF / DWG: the original drawing, entities and all, with
    what was done in DrawCAD. pages: [{"page": its dxfin info, "H": height pt, "kp": resize, "prims":
    annotations, "handles": the entity of each PDF object or None, "gone": / "cut": PDF objects removed
    whole / cut, "zones": zone removal rectangles, "images": [(file name, pixel size, prim)]}]. Entities removed whole are deleted; partly removed
    ones (a block, a line cut by a zone) stay, and the zones are covered by a wipeout. Layers hidden in
    DrawCAD are turned off."""
    from collections import Counter

    from . import dxfout

    doc, _aud = load(data)
    if doc.dxfversion < "AC1015":
        raise ValueError("DXF R12: nu poate primi adnotările DrawCAD (salvează-l ca DXF 2000 sau mai nou)")
    counts: dict = {}
    for name in hidden or []:
        la = doc.layers.get(name)
        if la is not None:
            la.off()  # hidden in DrawCAD: off in the DXF (still there, one click away in CAD)

    def add(k, n=1):
        counts[k] = counts.get(k, 0) + n

    for pg in pages:
        info = pg["page"]
        space = doc.modelspace() if info["space"] == "model" else doc.layouts.get(info["name"])
        if space is None:
            continue
        out = dxfout.DxfOnto(doc, space, info["tf"], pg["H"], pg.get("kp", 1), pg.get("W"), pg.get("rot", 0))
        hs = pg.get("handles")
        gone_ids, cut_ids = pg.get("gone") or [], pg.get("cut") or []
        partial = len(cut_ids)
        if hs:
            total = Counter(h for h in hs if h)
            gone = Counter(hs[int(o)] for o in gone_ids if o.isdigit() and int(o) < len(hs) and hs[int(o)])
            for h, n in gone.items():
                e = doc.entitydb.get(h)
                if e is None or not e.is_alive:
                    continue
                lay = doc.layouts.get_layout_by_key(e.dxf.owner) if n >= total[h] else None
                if lay is not None:
                    lay.delete_entity(e)
                    add("deleted")
                else:
                    partial += 1
        else:
            partial += len(gone_ids)
        if partial:
            for x0, y0, x1, y1 in pg.get("zones", []):
                space.add_wipeout([out.xy((min(x0, x1), max(y0, y1))), out.xy((max(x0, x1), min(y0, y1)))],
                                  dxfattribs={"layer": "DRAWCAD-ACOPERIRI"})
                out._count("acoperiri")
            add("deleted_partly", partial)
        for name, px, p in pg.get("images") or []:
            out.add_annot_image(name, px, p["p"], p.get("rot", 0), float(p.get("op", 1) or 1))
        if pg.get("prims"):
            out.add_prims(pg["prims"], color)
        for k, v in out.counts.items():
            add(k, v)
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode("utf-8"), counts


if __name__ == "__main__":  # quick manual check: python -m app.dxfin file.dxf out.pdf
    import sys

    pdf, info = dxf_to_pdf(Path(sys.argv[1]).read_bytes())
    Path(sys.argv[2]).write_bytes(pdf)
    print(info)
