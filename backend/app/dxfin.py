"""Opening DXF drawings (V14): the entities drawn as a vector PDF, one page per paper-space layout with
something on it, or model space fitted on an ISO sheet at a standard scale.

ezdxf's drawing add-on resolves entities, blocks, line types, hatches, dimensions and text (as outlines)
and records them; a small ReportLab backend writes the record as PDF paths, so the result is a PDF like
one exported from CAD: DrawCAD snaps on it, removes from it, exports it to DXF again.

Called only in the limited child process (ingest.py) for uploaded files: DXF input is untrusted.
"""
from __future__ import annotations

import copy
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


# entities ezdxf cannot draw: ACIS solids and surfaces (their shape is a SAT / SAB model)
ACIS_TYPES = {"3DSOLID", "BODY", "REGION", "SURFACE", "EXTRUDEDSURFACE", "LOFTEDSURFACE", "REVOLVEDSURFACE",
              "SWEPTSURFACE", "PLANESURFACE", "NURBSURFACE"}


def set_insunits(data: bytes, code: int) -> bytes:
    """The DXF with its drawing units ($INSUNITS) set to `code` (1 inch, 4 mm…), the rest unchanged: a
    drawing started from an inch template but drawn in millimetres (or the reverse) is read again in
    the units it was drawn in. ASCII DXF: the header value is replaced (or added); binary DXF: written
    again by ezdxf, binary."""
    if not data.startswith(b"AutoCAD Binary DXF"):
        m = re.search(rb"(\r?\n)[ \t]*9\r?\n\$INSUNITS\r?\n[ \t]*70\r?\n[ \t]*-?\d+", data)
        if m:
            nl = m.group(1)
            return data[:m.start()] + nl + b"  9" + nl + b"$INSUNITS" + nl + b" 70" + nl + f"{code:6d}".encode() + data[m.end():]
        m = re.search(rb"(\r?\n)[ \t]*2\r?\nHEADER\r?\n", data)
        if not m:
            raise ValueError("DXF fără secțiune HEADER")
        nl = m.group(1)
        return data[:m.end()] + b"  9" + nl + b"$INSUNITS" + nl + b" 70" + nl + f"{code:6d}".encode() + nl + data[m.end():]
    doc, _aud = load(data)
    doc.header["$INSUNITS"] = code
    out = io.BytesIO()
    doc.write(out, fmt="bin")
    return out.getvalue()


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

    # ezdxf may pass generators: read once into lists (an empty one would make an empty path, which
    # PDFium drops, shifting the entity map; a test on a generator would eat its first items)
    def draw_solid_lines(self, lines, props) -> None:
        lines = list(lines)
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
        paths = [q for q in paths if len(q)]
        if not paths:
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


def font_dirs() -> list[Path]:
    """Folders with the fonts the user added (TrueType, OpenType, SHX): `<data>/fonts`, the folders in
    DRAWCAD_FONTS and, on Windows, the Fonts folders of the Autodesk programs installed here."""
    out = []
    data = os.environ.get("DRAWCAD_DATA") or os.environ.get("COTARE_DATA") or "/data"
    out.append(Path(data) / "fonts")
    for d in (os.environ.get("DRAWCAD_FONTS") or "").split(os.pathsep):
        if d.strip():
            out.append(Path(d.strip()))
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                out += sorted(Path(base, "Autodesk").glob("*/Fonts"))
    return [d for d in out if d.is_dir()]


_FONTS_SIG = None


def _fonts_sig() -> tuple:
    """What the font folders hold: names, sizes and times of their files (a listing, no reading)."""
    out = []
    for d in font_dirs():
        try:
            for f in sorted(d.iterdir()):
                if f.is_file():
                    st = f.stat()
                    out.append((str(f), st.st_size, int(st.st_mtime)))
        except OSError:
            continue
    return tuple(out)


def _use_fonts() -> None:
    """Texts in osifont (ISO 3098) when the drawing's font is not on this machine: SHX fonts (romans,
    simplex, isocp, txt…) and CAD TrueType fonts (ISOCPEUR, AIGDT) are usually missing, others may be
    here (Arial on Windows). Fonts the user added (`font_dirs`) are used first, SHX files too."""
    global _FONTS_READY, _FONTS_SIG
    sig = _fonts_sig()
    if _FONTS_READY and sig == _FONTS_SIG:
        return
    # a reader started ahead set the fonts up before its file came: a font copied into a folder since
    # then is scanned now (scan_folder adds what is new)
    _FONTS_SIG = sig
    from ezdxf.fonts import fonts

    from . import pdfcore

    fm = fonts.font_manager
    for d in font_dirs():
        try:
            fm.scan_folder(d)
        except Exception:  # noqa: BLE001 (a font that cannot be read is skipped by ezdxf; a folder error here)
            pass
    # an SHX font the user added wins over its TrueType stand-in
    ezdxf.options.set("drawing-addon", "shx_resolve_order", "stl")
    path = Path(pdfcore.FONT_PATH).resolve()
    if path.is_file():
        fm.scan_folder(path.parent)
        if fm.has_font(path.name):
            fm._fallback_font_name = path.name
            # SHX names resolved by family ("TXT", "ROMANS") also go to osifont
            fm.add_synonyms({path.name: n for n in fonts.SHX_FONTS.values()}, reverse=False)
    _FONTS_READY = True


# GD&T symbol fonts: a letter stands for a symbol (n = diameter, j = position…), the same in AutoCAD's
# gdt.shx / amgdt.shx and in the TrueType AIGDT / AMGDT
_GDT_FONT = re.compile(r"(?i)^(ai|am)?gdt(\.(shx|ttf))?$")
_GDT_CHARS = str.maketrans({
    "a": "\u2220", "b": "\u22a5", "c": "\u23e5", "d": "\u2313", "e": "\u25cb", "f": "\u2225",
    "g": "\u232d", "h": "\u2197", "i": "\u232f", "j": "\u2316", "k": "\u2312", "l": "\u24c1",
    "m": "\u24c2", "n": "\u00d8", "o": "\u25a1", "p": "\u24c5", "q": "\u2104", "r": "\u25ce",
    "s": "\u24c8", "t": "\u2330", "u": "\u23e4", "v": "\u2334", "w": "\u2335", "x": "\u21a7",
    "y": "\u2332", "z": "\u2333",
})


def _font_found(name: str) -> bool:
    """A font file (or, without an extension, a family) is on this machine."""
    from ezdxf.fonts import fonts

    if "." in name:
        return fonts.font_manager.has_font(name)
    return fonts.find_best_match(family=name) is not None


def _fix_faces(ctx: RenderContext, doc) -> list[str]:
    """Text styles whose font is missing here: drawn in osifont, the face keeping the font's name as its
    family (GD&T fonts are recognised by it). A style with only a family name (the font file name
    left empty, the family in XDATA: ISOCPEUR, AIGDT, Arial from Inventor) would otherwise fall to a
    generic sans-serif. → the missing TrueType / GD&T font names."""
    from ezdxf.fonts import fonts

    from . import pdfcore

    osi = Path(pdfcore.FONT_PATH).name
    missing = []
    for st in doc.styles:
        key = st.dxf.name.lower()
        face = ctx.fonts.get(key)
        if face is None:
            continue
        file = (st.dxf.get("font") or "").strip()
        family = ""
        if not file and st.has_extended_font_data:
            family = (st.get_extended_font_data()[0] or "").strip()
        name = file or family
        if not name:
            continue
        stem = Path(name).stem if "." in name else name
        is_gdt = bool(_GDT_FONT.match(name))
        shx = fonts.is_shx_font_name(file) if file else False
        if shx and not is_gdt:
            continue  # SHX text fonts: osifont is their usual stand-in
        if _font_found(name if "." in name or not shx else f"{name}.shx"):
            if is_gdt:
                ctx.fonts[key] = face._replace(family=stem)
            continue
        ctx.fonts[key] = face._replace(filename=osi, family=stem)
        if stem not in missing:
            missing.append(stem)
    return missing


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

    def __init__(self, pipe, missing=()):
        from ezdxf.addons.drawing.pipeline import prepare_string_for_rendering

        from . import pdfcore

        self.items = []
        self._osi = Path(pdfcore.FONT_PATH).name
        self._families = {"sans-serif", "serif", "monospace"}
        self._missing = set(missing)
        self.missing_used: set[str] = set()
        self.used_gdt = False
        self._gdt: dict[str, bool] = {}
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

    def _gdt_missing(self, face) -> bool:
        """`face` is a GD&T symbol font that is not on this machine (its letters become the symbols)."""
        name = face.family or ""
        if face.filename and _GDT_FONT.match(face.filename):
            name = face.filename
        if not _GDT_FONT.match(name):
            return False
        if name not in self._gdt:
            drawn = ""
            try:
                font = self._pipe.text_engine.get_font(face)
                try:  # a TrueType font: the file it was read from (a missing one reads the fallback)
                    drawn = font.glyph_cache.font.reader.file.name
                except Exception:  # noqa: BLE001 (a shape font: gdt.shx itself, when the user added it)
                    drawn = getattr(font, "name", "")
            except Exception:  # noqa: BLE001
                pass
            self._gdt[name] = "gdt" not in Path(str(drawn)).name.lower()
        return self._gdt[name]

    def draw_text(self, text, transform, properties, cap_height, dxftype="TEXT"):
        pipe = self._pipe
        face = properties.font or pipe.default_font_face
        if face is not None and not face.filename and face.family and face.family not in self._families:
            # a family named in MTEXT (\\FISOCPEUR|b0|…;) that is not here: osifont, as for styles
            from ezdxf.fonts import fonts

            if fonts.find_best_match(family=face.family) is None:
                face = face._replace(filename=self._osi)
                properties = copy.copy(properties)
                properties.font = face
                self._missing.add(face.family)
        if face is not None and face.family in self._missing:
            self.missing_used.add(face.family)
        if face is not None and self._gdt_missing(face):
            text = self._prep(text, dxftype).translate(_GDT_CHARS)
            self.used_gdt = True
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
    """A layout as recorded by ezdxf (geometry) plus its texts and the fonts missing for them."""

    def __init__(self, rec, texts, missing=(), gdt=False):
        self.rec = rec
        self.texts = texts
        self.missing = list(missing)
        self.gdt = gdt  # GD&T letters drawn as symbols (the symbol font is missing)

    def bbox(self) -> BoundingBox2d | None:
        b = self.rec.player().bbox()
        for t in self.texts:
            b.extend(t[3])
        return b if b.has_data else None


def _record(doc, layout_obj) -> _Drawing:
    _use_fonts()
    rec = recorder.Recorder()
    ctx = RenderContext(doc)
    missing = _fix_faces(ctx, doc)
    fe = frontend.Frontend(ctx, rec, config=_config())
    texts = _Texts(fe.pipeline, missing)
    fe.draw_layout(layout_obj, finalize=True)
    used = texts.missing_used
    return _Drawing(rec, texts.items, [m for m in missing if m in used] + sorted(used - set(missing)), texts.used_gdt)


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
    sheets = framed or papers[:1]
    page0 = layout.Page.from_dxf_layout(sheets[0])
    tol0 = 0.02 * max(page0.width_in_mm, page0.height_in_mm)
    # blocks in sheet coordinates (border, title block, notes) are not views: shared out per sheet first
    on_sheet = [nb for nb in cand if _on_sheet(nb[1], page0, tol0)]
    anchors = _anchors(doc, on_sheet, len(sheets))
    per_sheet = [_sheet_blocks(doc, on_sheet, len(sheets), i, anchors) for i in range(len(sheets))]
    cand = [nb for nb in cand if nb not in on_sheet]
    for i, (lay, mine) in enumerate(zip(sheets, per_sheet)):
        # the view blocks made with this sheet: those between its border and the next sheet's
        pool = [nb for nb in cand if _sheet_index(anchors, _block_num(nb[0])) == i] if anchors else cand
        # model windows of the viewports (the layout's own, id 1, is the paper itself), in creation order
        wins = []
        for order, v in enumerate(lay.query("VIEWPORT")):
            if v.dxf.get("id", 0) == 1 or v.dxf.view_height <= 0 or v.dxf.height <= 0:
                continue
            k = v.dxf.view_height / v.dxf.height
            wins.append((v.dxf.get("id", 0), order, Vec2(v.dxf.center), k, v.dxf.width * k, v.dxf.view_height))
        wins.sort(key=lambda w: w[:2])
        views = sorted(pool, key=lambda nb: _block_num(nb[0]))

        def fits(nb, w):
            return nb[1].size.x <= w[4] + 1e-6 and nb[1].size.y <= w[5] + 1e-6

        if len(views) == len(wins) and all(fits(nb, w) for nb, w in zip(views, wins)):
            # Inventor makes the frames and the view blocks in the same order: frames of equal size (top /
            # bottom, left / right, isometric views) keep their own view
            pairs = list(zip(views, wins))
        else:  # otherwise by size: the largest view that fits each frame, smallest frame first
            pairs = []
            for w in sorted(wins, key=lambda w: w[4] * w[5]):
                ok = [nb for nb in views if fits(nb, w)]
                if ok:
                    nb = max(ok, key=lambda nb: nb[1].size.x * nb[1].size.y)
                    views.remove(nb)
                    pairs.append((nb, w))
        for (n, b), (_id, _o, pc, k, _ww, _wh) in pairs:
            lay.add_blockref(n, pc - b.center / k, dxfattribs={"xscale": 1 / k, "yscale": 1 / k})
            cand.remove((n, b))
            placed += 1
        for n, _b in mine:
            lay.add_blockref(n, (0, 0))
            placed += 1
    return placed


def _nice_scale(x: float) -> float:
    """A viewport scale read from its sizes (0.999824): the standard scale it stands for, when within 0.5 %."""
    for sc in SCALES:
        k = 1 / sc  # SCALES are paper / real; DrawCAD keeps real / paper
        if abs(x - k) <= 0.005 * k:
            return k
    return x


def _on_sheet(b: BoundingBox2d, page, tol: float) -> bool:
    return (b.extmin.x >= -tol and b.extmin.y >= -tol
            and b.extmax.x <= page.width_in_mm + tol and b.extmax.y <= page.height_in_mm + tol)


def _linework(blk) -> tuple:
    """The lines of a block (texts left out), rounded: the same border or title block twice has the same."""
    out = []
    for e in blk:
        t = e.dxftype()
        if t == "LINE":
            pts = sorted([(round(e.dxf.start.x, 1), round(e.dxf.start.y, 1)), (round(e.dxf.end.x, 1), round(e.dxf.end.y, 1))])
            out.append(("L", *pts))
        elif t == "LWPOLYLINE":
            out.append(("P", *((round(x, 1), round(y, 1)) for x, y, *_r in e.get_points())))
        elif t in ("CIRCLE", "ARC"):
            out.append((t[0], round(e.dxf.center.x, 1), round(e.dxf.center.y, 1), round(e.dxf.radius, 1)))
    return tuple(sorted(out))


def _block_num(name: str) -> int:
    return int(re.sub(r"\D", "", name) or 0)


def _groups(doc, on) -> list:
    """Sheet blocks grouped by their lines (the same border or title block several times), oldest first."""
    groups: dict = {}
    for nb in sorted(on, key=lambda nb: _block_num(nb[0])):
        sig = _linework(doc.blocks.get(nb[0]))
        groups.setdefault(sig if sig else nb[0], []).append(nb)
    return list(groups.values())


def _anchors(doc, on, sheets: int) -> list[int]:
    """With several sheets: the block numbers of their borders (the largest block that repeats once per
    sheet), in order; [] for one sheet or when no border repeats."""
    if sheets <= 1:
        return []
    borders = [g[-sheets:] for g in _groups(doc, on) if len(g) >= sheets]
    if not borders:
        return []
    big = max(borders, key=lambda g: g[0][1].size.x * g[0][1].size.y)
    return [_block_num(nb[0]) for nb in big]


def _sheet_index(anchors: list[int], num: int) -> int:
    """The sheet a block belongs to: the one whose border came last before it (the first, for earlier ones)."""
    return max(sum(1 for a in anchors if a <= num) - 1, 0)


def _sheet_blocks(doc, on, sheets: int, index: int, anchors: list[int]) -> list:
    """The blocks drawn in sheet coordinates (border, title block, notes) that belong on sheet `index` of
    `sheets`. Inventor may leave an older copy of the border and the title block (same lines, other
    texts) beside the current one: of blocks with the same lines, the latest ones (highest *I number)
    are kept, one per sheet. With several sheets, a block goes to the sheet whose border came before it."""
    kept = []
    for members in _groups(doc, on):
        kept += members[-sheets:] if len(members) > 1 and _linework(doc.blocks.get(members[0][0])) else members
    kept.sort(key=lambda nb: _block_num(nb[0]))
    if sheets <= 1:
        return kept
    if not anchors:
        return kept if index == 0 else []
    return [nb for nb in kept if _sheet_index(anchors, _block_num(nb[0])) == index]


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
    insunits = int(doc.header.get("$INSUNITS", 4) or 4)
    unit = UNIT_MM.get(insunits, 1.0)
    # what is not drawn: ACIS solids, and layout views looking at the model from another direction
    acis = sum(1 for e in doc.entitydb.values() if e.dxftype() in ACIS_TYPES)
    views_3d = sum(1 for lay in doc.layouts if not lay.is_modelspace for v in lay.query("VIEWPORT")
                   if v.dxf.get("status", 0) >= 1 and v.dxf.get("id", 0) != 1 and not v.is_top_view)
    buf = io.BytesIO()
    c = rl.Canvas(buf, pageCompression=1)
    c.setTitle("DXF")
    pages = []
    maps = []
    missing: list[str] = []  # fonts drawn in osifont instead
    gdt = []

    def note(rec: _Drawing) -> _Drawing:
        missing.extend(m for m in rec.missing if m not in missing)
        gdt.append(rec.gdt)
        return rec
    # a DXF exported by DrawCAD: its page frame and scale, exactly
    dc = drawcad_page(doc)
    if dc:
        # a DXF exported by DrawCAD: its page, exactly ((0, 0)…sheet × scale in model space)
        sw, sh, scale = dc
        rec = note(_record(doc, doc.modelspace()))
        box = BoundingBox2d([Vec2(0, 0), Vec2(sw * scale / unit, sh * scale / unit)])
        tf, hl = _place(rec, c, (sw, sh), box)
        maps.append(hl)
        pages.append({"name": "Model", "space": "model", "sheet": [round(sw, 3), round(sh, 3)], "scale": round(scale, 6), "tf": tf})
    if not pages:
        # paper-space layouts with something on them, in tab order
        for lay in sorted(doc.layouts, key=lambda x: x.dxf.get("taborder", 0)):
            if lay.is_modelspace or not len(lay):
                continue
            rec = note(_record(doc, lay))
            if rec.bbox() is None:
                continue
            page = layout.Page.from_dxf_layout(lay)
            wmm, hmm = page.width_in_mm, page.height_in_mm
            if not (wmm > 1 and hmm > 1):
                continue
            box = _paper_box(lay, rec.bbox(), wmm, hmm)
            tf, hl = _place(rec, c, (wmm, hmm), box)
            maps.append(hl)
            # the drawing scale: the largest view (the layout's own viewport, id 1, is the paper; LibreDWG
            # writes every viewport with status 1, so the status cannot tell)
            vps = [v for v in lay.viewports() if v.dxf.get("id", 0) != 1 and v.dxf.get("status", 1) != 0
                   and v.dxf.view_height > 0 and v.dxf.height > 0]
            vp = max(vps, key=lambda v: v.dxf.width * v.dxf.height) if vps else None
            scale = _nice_scale((vp.dxf.view_height / vp.dxf.height) * unit) if vp else 1.0
            pages.append({"name": lay.name, "space": "paper", "sheet": [round(wmm, 2), round(hmm, 2)], "scale": round(scale, 6), "tf": tf})
    if not pages:
        rec = note(_record(doc, doc.modelspace()))
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
            "fonts_missing": missing, "gdt_symbols": any(gdt), "insunits": insunits, "acis": acis, "views_3d": views_3d,
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
