"""PDF operations: rendering, geometry for snap, objects in a zone, object removal, export.

"Visual" coordinates: PDF points (1/72"), origin at the top-left corner of the page
as displayed (CropBox + /Rotate applied), y down. The frontend works only in
this system; conversion to PDF space happens here.
"""
from __future__ import annotations

import ctypes
import io
import math
import os
import re
import threading
from dataclasses import dataclass

import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as R
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

# pdfium is not thread-safe: all calls go through this lock
PDFIUM_LOCK = threading.RLock()

FONT_NAME = "osifont"
FONT_PATH = os.environ.get("DRAWCAD_FONT") or os.environ.get(
    "COTARE_FONT",
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "fonts", "osifont.ttf"),
)
_font_registered = False

ATTACH_JSON = "drawcad.json"
ATTACH_ORIGINAL = "drawcad-original.pdf"
# exports made before the rename (Cotare) can still be reopened
LEGACY_ATTACH = [("cotare.json", "cotare-original.pdf")]

OBJ_TYPE_NAMES = {
    R.FPDF_PAGEOBJ_TEXT: "text",
    R.FPDF_PAGEOBJ_PATH: "path",
    R.FPDF_PAGEOBJ_IMAGE: "image",
    R.FPDF_PAGEOBJ_SHADING: "shading",
    R.FPDF_PAGEOBJ_FORM: "form",
}

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _register_font():
    global _font_registered
    if not _font_registered:
        pdfmetrics.registerFont(TTFont(FONT_NAME, FONT_PATH))
        _font_registered = True


def mat_mul(m1, m2):
    """Applies m1, then m2 (PDF convention, row vector)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def mat_apply(m, x, y):
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


def _obj_matrix(obj):
    m = R.FS_MATRIX()
    if not R.FPDFPageObj_GetMatrix(obj, ctypes.byref(m)):
        return IDENTITY
    return (m.a, m.b, m.c, m.d, m.e, m.f)


def _obj_bounds(obj):
    l, b, r, t = ctypes.c_float(), ctypes.c_float(), ctypes.c_float(), ctypes.c_float()
    if not R.FPDFPageObj_GetBounds(obj, ctypes.byref(l), ctypes.byref(b), ctypes.byref(r), ctypes.byref(t)):
        return None
    return l.value, b.value, r.value, t.value


@dataclass
class PageGeo:
    """Conversion between the page's PDF space and visual coordinates."""

    left: float
    bottom: float
    right: float
    top: float
    rotation: int

    @classmethod
    def of(cls, page: pdfium.PdfPage) -> "PageGeo":
        l, b, r, t = page.get_cropbox()
        return cls(l, b, r, t, page.get_rotation() % 360)

    @property
    def W(self):
        return self.right - self.left

    @property
    def H(self):
        return self.top - self.bottom

    @property
    def visual_size(self):
        return (self.W, self.H) if self.rotation in (0, 180) else (self.H, self.W)

    def to_vis(self, x, y):
        u, v = x - self.left, self.top - y
        r = self.rotation
        if r == 0:
            return u, v
        if r == 90:
            return self.H - v, u
        if r == 180:
            return self.W - u, self.H - v
        return v, self.W - u  # 270

    def from_vis(self, vx, vy):
        r = self.rotation
        if r == 0:
            u, v = vx, vy
        elif r == 90:
            u, v = vy, self.H - vx
        elif r == 180:
            u, v = self.W - vx, self.H - vy
        else:
            u, v = self.W - vy, vx
        return u + self.left, self.top - v

    def bbox_to_vis(self, l, b, r, t):
        pts = [self.to_vis(l, b), self.to_vis(r, t), self.to_vis(l, t), self.to_vis(r, b)]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)]


def _walk(page_raw):
    """Walks the page objects recursively (including inside Form XObjects).

    Yields (id, handle, type, parent_matrix, container, is_nested).
    id = indices separated by '.', stable as long as the original file does not change.
    """

    def rec(container, nested, parent_total, prefix):
        if nested:
            count = R.FPDFFormObj_CountObjects(container)
        else:
            count = R.FPDFPage_CountObjects(container)
        for i in range(count):
            obj = R.FPDFFormObj_GetObject(container, i) if nested else R.FPDFPage_GetObject(container, i)
            if not obj:
                continue
            typ = R.FPDFPageObj_GetType(obj)
            oid = f"{prefix}{i}"
            yield oid, obj, typ, parent_total, container, nested
            if typ == R.FPDF_PAGEOBJ_FORM:
                yield from rec(obj, True, mat_mul(_obj_matrix(obj), parent_total), oid + ".")

    yield from rec(page_raw, False, IDENTITY, "")


def _bbox_page_space(obj, parent_total):
    bb = _obj_bounds(obj)
    if bb is None:
        return None
    l, b, r, t = bb
    if parent_total == IDENTITY:
        return bb
    pts = [mat_apply(parent_total, x, y) for x, y in ((l, b), (r, t), (l, t), (r, b))]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _path_points(obj, total):
    """Segments of a path, in page space: a list of subpaths (lists of points)
    plus flags telling whether the subpath contains curves."""
    n = R.FPDFPath_CountSegments(obj)
    subpaths = []
    cur = None
    for i in range(n):
        seg = R.FPDFPath_GetPathSegment(obj, i)
        x, y = ctypes.c_float(), ctypes.c_float()
        R.FPDFPathSegment_GetPoint(seg, ctypes.byref(x), ctypes.byref(y))
        typ = R.FPDFPathSegment_GetType(seg)
        px, py = mat_apply(total, x.value, y.value)
        if typ == R.FPDF_SEGMENT_MOVETO or cur is None:
            cur = {"pts": [(px, py)], "kinds": ["M"], "closed": False}
            subpaths.append(cur)
        else:
            cur["pts"].append((px, py))
            cur["kinds"].append("L" if typ == R.FPDF_SEGMENT_LINETO else "B")
        if R.FPDFPathSegment_GetClose(seg):
            cur["closed"] = True
    return subpaths


def _text_of(obj, textpage_raw):
    n = R.FPDFTextObj_GetText(obj, textpage_raw, None, 0)
    if n <= 2:
        return ""
    buf = ctypes.create_string_buffer(n)
    R.FPDFTextObj_GetText(obj, textpage_raw, ctypes.cast(buf, ctypes.POINTER(ctypes.c_ushort)), n)
    return buf.raw[: n - 2].decode("utf-16-le", errors="replace")


# ---------------------------------------------------------------- opening


def open_info(pdf_bytes: bytes) -> dict:
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            pages = []
            for i in range(len(doc)):
                page = doc[i]
                g = PageGeo.of(page)
                w, h = g.visual_size
                n_path = n_text = 0
                for _oid, _obj, typ, _pm, _c, _n in _walk(page.raw):
                    if typ == R.FPDF_PAGEOBJ_PATH:
                        n_path += 1
                    elif typ == R.FPDF_PAGEOBJ_TEXT:
                        n_text += 1
                pages.append({"w": round(w, 3), "h": round(h, 3), "rot": g.rotation, "paths": n_path, "texts": n_text})
                page.close()
            return {"pages": pages}
        finally:
            doc.close()


def extract_embedded(pdf_bytes: bytes):
    """If the PDF was exported by the app with an editable layer, returns (original, json)."""
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pk:
            att = pk.attachments
            for jn, on in [(ATTACH_JSON, ATTACH_ORIGINAL), *LEGACY_ATTACH]:
                if jn in att and on in att:
                    js = att[jn].get_file().read_bytes()
                    orig = att[on].get_file().read_bytes()
                    return orig, js
    except Exception:
        pass
    return None


def image_to_pdf(data: bytes, dpi: float | None) -> tuple[bytes, float]:
    """Converts an image (PNG/JPG/TIFF) to a PDF page at the given DPI or the one read from the file."""
    import img2pdf
    from PIL import Image

    im = Image.open(io.BytesIO(data))
    file_dpi = None
    if "dpi" in im.info:
        try:
            file_dpi = float(im.info["dpi"][0])
        except Exception:
            file_dpi = None
    use_dpi = dpi or (file_dpi if file_dpi and file_dpi > 30 else 300.0)
    if not dpi:
        # 72 / 96 DPI are usually default values (photos, screenshots), not the scan resolution: the sheet would
        # come out huge (an A3 drawing of 3300 px at 72 DPI = 1.16 m), and dimensions would look tiny.
        # Above A1, with a low DPI, the sheet is brought to A3 (420 mm on the long side).
        long_px = max(im.size)
        if use_dpi <= 96 and long_px / use_dpi * 25.4 > 841:
            use_dpi = long_px / (420 / 25.4)
    frames = []
    n_frames = getattr(im, "n_frames", 1)
    for i in range(n_frames):
        im.seek(i)
        # img2pdf does not accept an alpha channel: black-and-white/gray stays gray, the rest RGB
        fr = im.convert("L") if im.mode in ("1", "L", "LA", "I", "I;16") else im.convert("RGB")
        b = io.BytesIO()
        fr.save(b, format="PNG")
        frames.append(b.getvalue())
    layout = img2pdf.get_fixed_dpi_layout_fun((use_dpi, use_dpi))
    return img2pdf.convert(frames, layout_fun=layout), use_dpi


# ---------------------------------------------------------------- pages: order, rotation, deletion


def _push_inherited(po):
    """Attributes inherited from the page tree (resources, boxes, rotation) are copied onto the page,
    so they stay correct after the page is moved directly under the root."""
    for key in ("/Resources", "/MediaBox", "/CropBox", "/Rotate"):
        if key in po:
            continue
        node = po.get("/Parent")
        guard = 0
        while node is not None and guard < 64:
            guard += 1
            if key in node:
                po[key] = node[key]
                break
            node = node.get("/Parent")


def apply_layout(pdf_bytes: bytes, layout: list[dict]) -> bytes:
    """The PDF with the pages in the given order, additionally rotated (`rot`, degrees clockwise) and without
    the missing ones. Page content is not touched, so object ids stay the same."""
    pk = pikepdf.open(io.BytesIO(pdf_bytes))
    objs = [p.obj for p in pk.pages]
    for po in objs:
        _push_inherited(po)
    new = []
    for it in layout:
        po = objs[int(it["src"])]
        try:
            base = int(po.get("/Rotate", 0))
        except (TypeError, ValueError):
            base = 0
        po.Rotate = (base + int(it.get("rot", 0))) % 360
        k = float(it.get("scale", 1) or 1)
        if abs(k - 1) > 1e-9:
            # sheet size: the page boxes and the content (a transform at the start) by factor k;
            # the page objects stay the same, and so do their ids
            for box in ("/MediaBox", "/CropBox", "/BleedBox", "/TrimBox", "/ArtBox"):
                if box in po:
                    po[box] = pikepdf.Array([float(v) * k for v in po[box]])
            for an in po.get("/Annots", []) or []:
                if isinstance(an, pikepdf.Dictionary) and "/Rect" in an:
                    an.Rect = pikepdf.Array([float(v) * k for v in an.Rect])
            page = pikepdf.Page(po)
            page.contents_add(pikepdf.Stream(pk, f"q {k:.6f} 0 0 {k:.6f} 0 0 cm\n".encode()), prepend=True)
            page.contents_add(pikepdf.Stream(pk, b"\nQ\n"))
        new.append(po)
    root = pk.Root.Pages
    for po in new:
        po.Parent = root
    root.Kids = pikepdf.Array(new)
    root.Count = len(new)
    out = io.BytesIO()
    pk.save(out)
    pk.close()
    return out.getvalue()


# ---------------------------------------------------------------- rendering


def _to_png(img, out):
    """Fast PNG from a PIL image (used for small images); gray → a single channel."""
    from PIL import ImageChops

    if img.mode == "RGB":
        r, g, b = img.split()
        if ImageChops.difference(r, g).getbbox() is None and ImageChops.difference(g, b).getbbox() is None:
            img = r
    elif img.mode == "RGBA":
        img = img.convert("RGB")
        return _to_png(img, out)
    img.save(out, format="PNG", compress_level=1)


_PNG_ROWS = 256  # rows compressed at a time: the extra memory is one strip, not the whole image


def _is_gray(arr) -> bool:
    """Do all pixels have R = G = B? Checked in strips, so the image is not allocated three times."""
    if arr.ndim == 2:
        return True
    for i in range(0, arr.shape[0], _PNG_ROWS):
        c = arr[i:i + _PNG_ROWS]
        if not (np.array_equal(c[..., 0], c[..., 1]) and np.array_equal(c[..., 1], c[..., 2])):
            return False
    return True


def png_from_array(arr, level: int = 1) -> bytes:
    """PNG straight from the bitmap array (H×W gray or H×W×3 RGB), compressed in strips.
    No PIL copies of the whole image: for a 100 MP page the memory peak drops from
    ~11 to ~3 bytes per pixel. Black-and-white / gray drawings are written as a single channel."""
    import struct
    import zlib

    if arr.ndim == 3 and _is_gray(arr):
        arr = arr[..., 0]
    h, w = arr.shape[:2]
    ch = 1 if arr.ndim == 2 else 3

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    z = zlib.compressobj(level)
    parts = []
    row = w * ch
    prev = np.zeros(row, dtype=np.uint8)
    for i in range(0, h, _PNG_ROWS):
        c = arr[i:i + _PNG_ROWS].reshape(-1, row)
        n = c.shape[0]
        # the "Up" filter (2): difference from the row above (modulo 256). On drawings, neighboring
        # rows are nearly identical, so they compress 2–4× better than without a filter
        buf = np.empty((n, row + 1), dtype=np.uint8)
        buf[:, 0] = 2
        buf[0, 1:] = c[0] - prev
        if n > 1:
            np.subtract(c[1:], c[:-1], out=buf[1:, 1:])
        prev = c[-1].copy()
        parts.append(z.compress(buf.tobytes()))
    parts.append(z.flush())
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0 if ch == 1 else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", b"".join(parts)) + chunk(b"IEND", b"")


def _bitmap_array(bmp):
    """Numpy view over the bitmap pixels (no copy), RGB or gray."""
    arr = bmp.to_numpy()
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = arr[..., :3]
    return arr


_LIBC = None


def release_memory():
    """Returns to the OS the free memory left after a large render (otherwise glibc keeps it
    in the process, and the server holds hundreds of MB for nothing). No effect outside Linux."""
    global _LIBC
    if _LIBC is None:
        try:
            _LIBC = ctypes.CDLL("libc.so.6")
            _LIBC.malloc_trim.argtypes = [ctypes.c_size_t]
        except (OSError, AttributeError):
            _LIBC = False
    if _LIBC:
        _LIBC.malloc_trim(0)


def to_gray(arr):
    """RGB → gray in strips, with the same formula as PIL convert("L") (bit-identical result)."""
    if arr.ndim == 2:
        return np.array(arr)
    out = np.empty(arr.shape[:2], dtype=np.uint8)
    for i in range(0, arr.shape[0], _PNG_ROWS):
        c = arr[i:i + _PNG_ROWS].astype(np.uint32)
        out[i:i + _PNG_ROWS] = (c[..., 0] * 19595 + c[..., 1] * 38470 + c[..., 2] * 7471 + 0x8000) >> 16
    return out


def render_png(pdf_bytes: bytes, page_index: int, scale: float, removals=None, ink=None, clip=None, gray: bool = False) -> bytes:
    """The page as PNG. `clip` = (x0, y0, x1, y1) in visual coordinates (points): only that area,
    for high zoom (the visible detail at high resolution, without the whole page).
    `gray`: grayscale PNG (OCR, vectorization)."""
    if ink and ink.get("all"):
        pdf_bytes = ink_pdf(pdf_bytes, {page_index}, ink.get("fills", "black"), bool(ink.get("images")))
    bmp = _render_bitmap(pdf_bytes, page_index, scale, removals, clip)
    big = False
    try:
        # compression happens outside the PDFium lock: another page can be rendered meanwhile
        arr = _bitmap_array(bmp)
        big = arr.shape[0] * arr.shape[1] > 4e6
        return png_from_array(to_gray(arr) if gray else arr)
    finally:
        with PDFIUM_LOCK:
            bmp.close()
        if big:
            release_memory()


def render_array(pdf_bytes: bytes, page_index: int, scale: float, gray: bool = True):
    """The page as a numpy array (own copy), without an intermediate PNG. Rendering is always in color:
    PDFium's gray mode smooths edges differently, and OCR and vectorization are tuned for this."""
    bmp = _render_bitmap(pdf_bytes, page_index, scale, None, None)
    try:
        arr = _bitmap_array(bmp)
        return to_gray(arr) if gray else np.array(arr)
    finally:
        with PDFIUM_LOCK:
            bmp.close()


def _render_bitmap(pdf_bytes, page_index, scale, removals, clip):
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[page_index]
            if removals:
                _apply_removals_page(page, removals)
            crop = (0, 0, 0, 0)
            if clip:
                W, H = PageGeo.of(page).visual_size
                x0, y0, x1, y1 = clip
                x0, x1 = max(0.0, min(x0, x1)), min(W, max(x0, x1))
                y0, y1 = max(0.0, min(y0, y1)), min(H, max(y0, y1))
                # the PDFium crop is in display orientation: left, bottom, right, top
                crop = (x0, H - y1, W - x1, y0)
            bmp = page.render(scale=scale, rotation=0, crop=crop, may_draw_forms=True, draw_annots=True, rev_byteorder=True)
            page.close()
            return bmp
        finally:
            doc.close()


# ---------------------------------------------------------------- blackening for printing
# Colored drawings (light green, yellow…) print almost invisible. Lines and text
# are made black by rewriting the color operators in the content streams (page and blocks), so
# geometry, fonts and object order stay untouched. White (paper, masks) stays white.

INK_FILLS = ("black", "gray", "keep")


def _num(v):
    try:
        return float(v)
    except Exception:  # noqa: BLE001
        return 0.0


def _cs_kind(name, resources, depth=0):
    """Kind of a color space: (family, number of components, extra)."""
    if depth > 6:
        return ("unknown", 0, None)
    if isinstance(name, pikepdf.Array):
        arr = name
    else:
        n = str(name)
        dev = {"/DeviceGray": ("gray", 1), "/G": ("gray", 1), "/CalGray": ("gray", 1), "/DeviceRGB": ("rgb", 3),
               "/RGB": ("rgb", 3), "/CalRGB": ("rgb", 3), "/DeviceCMYK": ("cmyk", 4), "/CMYK": ("cmyk", 4),
               "/Pattern": ("pattern", 0)}
        if n in dev:
            return (*dev[n], None)
        try:
            arr = resources.ColorSpace[name]
        except Exception:  # noqa: BLE001
            return ("unknown", 0, None)
        if isinstance(arr, pikepdf.Name):
            return _cs_kind(arr, resources, depth + 1)
    try:
        fam = str(arr[0])
        if fam == "/ICCBased":
            nc = int(arr[1].get("/N", 3))
            return ({1: "gray", 3: "rgb", 4: "cmyk"}.get(nc, "unknown"), nc, None)
        if fam in ("/CalRGB", "/CalGray", "/Lab"):
            return ({"/CalRGB": "rgb", "/CalGray": "gray", "/Lab": "lab"}[fam], 1 if fam == "/CalGray" else 3, None)
        if fam == "/Separation":
            return ("sep", 1, None)
        if fam == "/DeviceN":
            return ("devn", len(arr[1]), None)
        if fam == "/Indexed":
            base = _cs_kind(arr[1], resources, depth + 1)
            look = arr[3]
            data = bytes(look.read_bytes()) if isinstance(look, pikepdf.Stream) else bytes(look)
            return ("indexed", 1, (base, data))
        if fam == "/Pattern":
            return ("pattern", 0, None)
    except Exception:  # noqa: BLE001
        pass
    return ("unknown", 0, None)


def _color_eval(kind, vals):
    """(is_white, lightness 0…1) for a color."""
    fam, _n, extra = kind
    v = [_num(x) for x in vals if not isinstance(x, pikepdf.Name)]
    if fam == "gray" and v:
        return v[0] >= 0.97, v[0]
    if fam == "rgb" and len(v) >= 3:
        r, g, b = v[:3]
        return min(r, g, b) >= 0.97, 0.299 * r + 0.587 * g + 0.114 * b
    if fam == "cmyk" and len(v) >= 4:
        c, m, y, k = v[:4]
        r, g, b = (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
        return max(v[:4]) <= 0.03, 0.299 * r + 0.587 * g + 0.114 * b
    if fam in ("sep", "devn") and v:
        return max(v) <= 0.03, 1 - max(v)
    if fam == "lab" and v:
        return v[0] >= 97, v[0] / 100
    if fam == "indexed" and v and extra:
        base, data = extra
        nb = base[1] or 3
        i = int(v[0])
        comps = [b / 255 for b in data[i * nb:(i + 1) * nb]]
        if len(comps) == nb:
            return _color_eval(base, comps)
    return False, 0.0


def _ink_instrs(instrs, resources, fills):
    """Rewrites color operators: strokes and text become black, fills according to `fills`."""
    out = []
    st = {"S": ("gray", 1, None), "F": ("gray", 1, None), "fw": False, "last": []}
    stack = []
    in_text = False
    keep = fills == "keep"

    def fill_value(white, lum):
        if white:
            return 1
        return 0 if fills == "black" else round(max(0.0, min(1.0, lum)) * 0.85, 3)

    for operands, op in instrs:
        o = str(op)
        if o == "q":
            stack.append((dict(st), list(st["last"])))
            out.append((operands, op))
            continue
        if o == "Q":
            if stack:
                saved, last = stack.pop()
                st.update(saved)
                st["last"] = last
            out.append((operands, op))
            continue
        if o in ("CS", "cs"):
            kind = _cs_kind(operands[0], resources) if operands else ("gray", 1, None)
            if o == "CS":
                st["S"] = kind
                out.append(([0], pikepdf.Operator("G")))
            else:
                st["F"] = kind
                if keep and not in_text:
                    out.append((operands, op))
                    st["last"] = [(operands, op)]
                else:
                    em = ([0], pikepdf.Operator("g"))
                    out.append(em)
                    if not in_text:
                        st["last"] = [em]
            continue
        if o in ("G", "RG", "K", "SC", "SCN"):
            kind = {"G": ("gray", 1, None), "RG": ("rgb", 3, None), "K": ("cmyk", 4, None)}.get(o, st["S"])
            if o in ("G", "RG", "K"):
                st["S"] = kind
            white, _lum = _color_eval(kind, operands)
            out.append(([1 if white else 0], pikepdf.Operator("G")))
            continue
        if o in ("g", "rg", "k", "sc", "scn"):
            kind = {"g": ("gray", 1, None), "rg": ("rgb", 3, None), "k": ("cmyk", 4, None)}.get(o, st["F"])
            if o in ("g", "rg", "k"):
                st["F"] = kind
            white, lum = _color_eval(kind, operands)
            if in_text:
                # text is always black (or white, if it was white)
                out.append(([1 if white else 0], pikepdf.Operator("g")))
                continue
            st["fw"] = white
            if keep:
                prev_cs = [st["last"][0]] if o in ("sc", "scn") and st["last"] and str(st["last"][0][1]) == "cs" else []
                st["last"] = prev_cs + [(operands, op)]
                out.append((operands, op))
            else:
                em = ([fill_value(white, lum)], pikepdf.Operator("g"))
                st["last"] = [em]
                out.append(em)
            continue
        if o == "BT":
            in_text = True
            out.append((operands, op))
            if fills != "black":
                out.append(([1 if st["fw"] else 0], pikepdf.Operator("g")))
            continue
        if o == "ET":
            in_text = False
            out.append((operands, op))
            if fills != "black" and st["last"]:
                out.extend(st["last"])
            continue
        out.append((operands, op))
    return out


def _ink_image(obj):
    """Image → black and white for printing: everything that is not paper (dark or colored) becomes black."""
    from PIL import Image, ImageChops  # noqa: PLC0415

    if obj.get("/ImageMask", False):
        return False  # mask: drawn with the fill color, already blackened
    try:
        im = pikepdf.PdfImage(obj).as_pil_image()
    except Exception:  # noqa: BLE001
        return False
    rgb = im.convert("RGB")
    lum = rgb.convert("L")
    r, g, b = rgb.split()
    spread = ImageChops.subtract(ImageChops.lighter(ImageChops.lighter(r, g), b), ImageChops.darker(ImageChops.darker(r, g), b))
    ink = ImageChops.lighter(lum.point(lambda v: 255 if v < 215 else 0), spread.point(lambda v: 255 if v > 45 else 0))
    out = ImageChops.invert(ink)
    import zlib  # noqa: PLC0415

    obj.write(zlib.compress(out.tobytes(), 6), filter=pikepdf.Name.FlateDecode)
    obj.ColorSpace = pikepdf.Name.DeviceGray
    obj.BitsPerComponent = 8
    obj.Width = out.width
    obj.Height = out.height
    for k in ("/DecodeParms", "/Decode", "/Intent"):
        if k in obj:
            del obj[k]
    return True


def ink_pdf(pdf_bytes: bytes, pages=None, fills: str = "black", images: bool = False) -> bytes:
    """Makes the original's lines and text black (optionally images too) on the given pages."""
    fills = fills if fills in INK_FILLS else "black"
    pk = pikepdf.open(io.BytesIO(pdf_bytes))
    done = set()

    def process_resources(res, depth=0):
        if depth > 8 or res is None or "/XObject" not in res:
            return
        for _name, xo in res.XObject.items():
            try:
                key = xo.objgen
            except Exception:  # noqa: BLE001
                key = None
            if key in done:
                continue
            done.add(key)
            sub = str(xo.get("/Subtype", ""))
            if sub == "/Form":
                xres = xo.get("/Resources", res)
                try:
                    instrs = pikepdf.parse_content_stream(xo)
                    xo.write(pikepdf.unparse_content_stream(_ink_instrs(instrs, xres, fills)))
                except Exception:  # noqa: BLE001
                    pass
                process_resources(xres, depth + 1)
            elif sub == "/Image" and images:
                _ink_image(xo)

    for i, page in enumerate(pk.pages):
        if pages is not None and i not in pages:
            continue
        res = page.obj.get("/Resources", pikepdf.Dictionary())
        instrs = pikepdf.parse_content_stream(page)
        page.obj.Contents = pk.make_stream(pikepdf.unparse_content_stream(_ink_instrs(instrs, res, fills)))
        process_resources(res)
    out = io.BytesIO()
    pk.save(out)
    return out.getvalue()


# ---------------------------------------------------------------- geometry for snap


def _bez_at(p0, c1, c2, p3, t):
    u = 1 - t
    return (
        u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0],
        u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1],
    )


def _circle3(a, b, c):
    """The circle through three points: (cx, cy, r) or None if they are collinear."""
    ax, ay = a
    bx, by = b
    cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-9:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


def _wrap_pi(a):
    while a <= -math.pi:
        a += 2 * math.pi
    while a > math.pi:
        a -= 2 * math.pi
    return a


def _bez_as_arc(p0, c1, c2, p3):
    """If a Bézier curve (in visual coordinates) is a circular arc, returns (cx, cy, r, a0, sweep)
    with on-screen angles, counter-clockwise (y down), otherwise None."""
    m = _bez_at(p0, c1, c2, p3, 0.5)
    circ = _circle3(p0, m, p3)
    if not circ:
        return None
    cx, cy, r = circ
    if r > 3000 or r < 0.05:
        return None
    tol = max(0.02, r * 0.004)
    for t in (0.25, 0.75):
        q = _bez_at(p0, c1, c2, p3, t)
        if abs(math.hypot(q[0] - cx, q[1] - cy) - r) > tol:
            return None
    ang = lambda q: math.atan2(-(q[1] - cy), q[0] - cx)  # noqa: E731
    a0, am, a3 = ang(p0), ang(m), ang(p3)
    sw = _wrap_pi(am - a0) + _wrap_pi(a3 - am)
    return cx, cy, r, a0, sw


def _centroid(P):
    """Area centroid of a closed polygon (PDF coordinates), or None when it has no area."""
    Q = list(P)
    if len(Q) > 1 and (Q[0][0] - Q[-1][0]) ** 2 + (Q[0][1] - Q[-1][1]) ** 2 < 1e-6:
        Q = Q[:-1]
    if len(Q) < 3:
        return None
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(Q, Q[1:] + Q[:1]):
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    if abs(a) < 1e-3:
        return None
    return cx / (3 * a), cy / (3 * a)


def snap_points(pdf_bytes: bytes, page_index: int, limit: int = 60000) -> dict:
    """Characteristic points: endpoints (e) and midpoints (m) of segments, circle centers (c) and
    quadrants (q), centroids of closed polygons (g, geometric center) and text origins (i, insertion).

    Also returns the straight segments (for snap on line / perpendicular)."""
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[page_index]
            g = PageGeo.of(page)
            seen = set()
            pts = []
            segs = []
            arcs = []

            def add(x, y, kind):
                vx, vy = g.to_vis(x, y)
                key = (round(vx, 2), round(vy, 2), kind)
                if key in seen:
                    return
                seen.add(key)
                pts.append([round(vx, 3), round(vy, 3), kind])

            for _oid, obj, typ, parent_total, _c, _n in _walk(page.raw):
                if typ == R.FPDF_PAGEOBJ_TEXT:
                    # insertion point of a text run: its baseline origin
                    t = mat_mul(_obj_matrix(obj), parent_total)
                    add(t[4], t[5], "i")
                    continue
                if typ != R.FPDF_PAGEOBJ_PATH:
                    continue
                total = mat_mul(_obj_matrix(obj), parent_total)
                for sp in _path_points(obj, total):
                    P = sp["pts"]
                    K = sp["kinds"]
                    if len(P) < 2:
                        continue
                    # closed circle / arc approximated by Bézier curves → center
                    geom_closed = sp["closed"] or (
                        (P[0][0] - P[-1][0]) ** 2 + (P[0][1] - P[-1][1]) ** 2 < 1e-4
                    )
                    if geom_closed and K.count("B") >= 6 and K.count("L") <= 1:
                        xs = [p[0] for p in P]
                        ys = [p[1] for p in P]
                        w, h = max(xs) - min(xs), max(ys) - min(ys)
                        if w > 0 and abs(w - h) / w < 0.03:
                            add((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, "c")
                            cv = g.to_vis((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2)
                            arcs.append([round(cv[0], 3), round(cv[1], 3), round((w + h) / 4, 3), 0, round(2 * math.pi, 6)])
                            add(min(xs), (max(ys) + min(ys)) / 2, "q")
                            add(max(xs), (max(ys) + min(ys)) / 2, "q")
                            add((max(xs) + min(xs)) / 2, min(ys), "q")
                            add((max(xs) + min(xs)) / 2, max(ys), "q")
                            continue
                    i = 0
                    prev = P[0]
                    add(prev[0], prev[1], "e")
                    j = 1
                    while j < len(P):
                        if K[j] == "L":
                            p = P[j]
                            add(p[0], p[1], "e")
                            if (prev[0] - p[0]) ** 2 + (prev[1] - p[1]) ** 2 > 1e-4:
                                add((prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2, "m")
                            a = g.to_vis(*prev)
                            b = g.to_vis(*p)
                            if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > 0.25:
                                segs.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3)])
                            prev = p
                            j += 1
                        else:  # Bézier: three points, the last one is the endpoint
                            c1, c2 = P[j], P[min(j + 1, len(P) - 1)]
                            end = P[min(j + 2, len(P) - 1)]
                            add(end[0], end[1], "e")
                            vp = [g.to_vis(*q) for q in (prev, c1, c2, end)]
                            arc = _bez_as_arc(*vp)
                            if arc:
                                # consecutive arcs of the same circle (fillets made of several curves) are merged
                                last = arcs[-1] if arcs else None
                                if (
                                    last and abs(last[0] - arc[0]) < 0.05 and abs(last[1] - arc[1]) < 0.05
                                    and abs(last[2] - arc[2]) < 0.05 and abs(_wrap_pi(last[3] + last[4] - arc[3])) < 1e-3
                                    and abs(last[4] + arc[4]) < 2 * math.pi
                                ):
                                    last[4] = round(last[4] + arc[4], 6)
                                else:
                                    arcs.append([round(arc[0], 3), round(arc[1], 3), round(arc[2], 3), round(arc[3], 6), round(arc[4], 6)])
                            else:
                                # arbitrary curve: approximated by segments, for "nearest" and intersections
                                qs = [vp[0]] + [_bez_at(*vp, k / 8) for k in range(1, 9)]
                                for a, b in zip(qs, qs[1:]):
                                    segs.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3), 1])
                            prev = end
                            j += 3
                    if (sp["closed"] or geom_closed) and len(P) >= 3 and all(k == "L" for k in K[1:]):
                        # closed polygon (rectangle, outline): its geometric center
                        gc = _centroid(P)
                        if gc:
                            add(gc[0], gc[1], "g")
                    if sp["closed"]:
                        p = P[0]
                        if (prev[0] - p[0]) ** 2 + (prev[1] - p[1]) ** 2 > 0.01:
                            add((prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2, "m")
                            a = g.to_vis(*prev)
                            b = g.to_vis(*p)
                            segs.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3)])
                    if len(pts) > limit:
                        break
                if len(pts) > limit:
                    break
            page.close()
            # centers and midpoints of arcs (fillets): useful for radius dimensions and center lines
            for cx, cy, r, a0, sw in arcs:
                if abs(sw) < 2 * math.pi - 1e-3:
                    key = (round(cx, 2), round(cy, 2), "c")
                    if key not in seen:
                        seen.add(key)
                        pts.append([cx, cy, "c"])
                    am = a0 + sw / 2
                    pts.append([round(cx + r * math.cos(am), 3), round(cy - r * math.sin(am), 3), "m"])
            return {"pts": pts, "segs": segs[:limit], "arcs": arcs[:limit], "truncated": len(pts) > limit}
        finally:
            doc.close()


# ---------------------------------------------------------------- objects in a zone / removal


GLYPH_MAX = 12 * 72 / 25.4  # 12 mm


def _glyph_in(b, r):
    """Small object (letter) with the center of its box in the zone."""
    cx = (b[0] + b[2]) / 2
    cy = (b[1] + b[3]) / 2
    w, h = b[2] - b[0], b[3] - b[1]
    # straight lines (one dimension ~0) are not letters: those are cut at the edge
    return max(w, h) <= GLYPH_MAX and min(w, h) >= 2.3 and r[0] <= cx <= r[2] and r[1] <= cy <= r[3]


def _area_frac(b, r):
    w = max(b[2] - b[0], 1e-6)
    h = max(b[3] - b[1], 1e-6)
    iw = max(0.0, min(b[2], r[2]) - max(b[0], r[0]))
    ih = max(0.0, min(b[3], r[3]) - max(b[1], r[1]))
    # very thin object (horizontal/vertical line): only the long dimension counts
    if b[2] - b[0] < 0.5:
        return round(ih / h, 3)
    if b[3] - b[1] < 0.5:
        return round(iw / w, 3)
    return round(iw * ih / (w * h), 3)


def _frac_inside(subpaths, r):
    """Fraction of a path's length inside rectangle r (in page space)."""
    tot = 0.0
    out = 0.0

    def seg(a, b):
        nonlocal tot, out
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        tot += L
        for p, q in _clip_outside(a, b, r):
            out += math.hypot(q[0] - p[0], q[1] - p[1])

    for sp in subpaths:
        P, K_ = sp["pts"], sp["kinds"]
        prev = P[0]
        j = 1
        while j < len(P):
            if K_[j] == "L":
                seg(prev, P[j])
                prev = P[j]
                j += 1
            else:
                c1, c2, p3 = P[j], P[min(j + 1, len(P) - 1)], P[min(j + 2, len(P) - 1)]
                pts = [prev] + _bez(prev, c1, c2, p3, 12)
                for a, b in zip(pts, pts[1:]):
                    seg(a, b)
                prev = p3
                j += 3
        if sp["closed"]:
            seg(prev, P[0])
    return 1.0 if tot <= 1e-9 else max(0.0, 1 - out / tot)


def objects_in_rect(pdf_bytes: bytes, page_index: int, rect_vis) -> list[dict]:
    x0, y0, x1, y1 = rect_vis
    rx0, rx1 = min(x0, x1), max(x0, x1)
    ry0, ry1 = min(y0, y1), max(y0, y1)
    out = []
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[page_index]
            g = PageGeo.of(page)
            tp = page.get_textpage()
            for oid, obj, typ, parent_total, _c, _n in _walk(page.raw):
                if typ == R.FPDF_PAGEOBJ_FORM:
                    continue  # list the children
                bb = _bbox_page_space(obj, parent_total)
                if bb is None:
                    continue
                vb = g.bbox_to_vis(*bb)
                if vb[2] < rx0 or vb[0] > rx1 or vb[3] < ry0 or vb[1] > ry1:
                    continue
                inside = vb[0] >= rx0 - 0.01 and vb[2] <= rx1 + 0.01 and vb[1] >= ry0 - 0.01 and vb[3] <= ry1 + 0.01
                item = {
                    "id": oid,
                    "type": OBJ_TYPE_NAMES.get(typ, "other"),
                    "bbox": [round(v, 2) for v in vb],
                    "inside": inside,
                    "locked": "." in oid,  # inside a block (Form XObject): cover only
                }
                # how much of the object is in the zone (line length, or box area for text and images)
                item["frac"] = 1.0 if inside else _area_frac(vb, (rx0, ry0, rx1, ry1))
                if typ == R.FPDF_PAGEOBJ_TEXT:
                    item["text"] = _text_of(obj, tp.raw)
                elif typ == R.FPDF_PAGEOBJ_PATH:
                    total = mat_mul(_obj_matrix(obj), parent_total)
                    poly = []
                    nseg = 0
                    sps = _path_points(obj, total)
                    if not inside:
                        a, b = g.from_vis(rx0, ry0), g.from_vis(rx1, ry1)
                        rpdf = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
                        if not _cut_runs(sps, rpdf)[1]:
                            continue  # only the bounding box touches the zone (e.g. the sheet border)
                        item["frac"] = round(_frac_inside(sps, rpdf), 3)
                    for sp in sps:
                        nseg += len(sp["pts"])
                        poly.append([[round(c, 2) for c in g.to_vis(*p)] for p in sp["pts"][:400]])
                    item["segments"] = nseg
                    item["poly"] = poly[:50]
                    fill = ctypes.c_int()
                    stroke = ctypes.c_int()
                    ok = R.FPDFPath_GetDrawMode(obj, ctypes.byref(fill), ctypes.byref(stroke))
                    # only plain lines (no fill) can be cut at the zone edge
                    item["cuttable"] = bool(ok and fill.value == 0 and stroke.value)
                out.append(item)
            tp.close()
            page.close()
        finally:
            doc.close()
    return out


# ---------------------------------------------------------------- geometric cutting


def _clip_outside(p, q, r):
    """Parts of segment p→q outside the rectangle r = (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = r
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, p[0] - x0), (dx, x1 - p[0]), (-dy, p[1] - y0), (dy, y1 - p[1])):
        if abs(pk) < 1e-12:
            if qk < 0:
                return [(p, q)]  # parallel and outside the band: the whole segment is outside
            continue
        t = qk / pk
        if pk < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
    if t0 >= t1:
        return [(p, q)]  # does not enter the rectangle
    at = lambda t: (p[0] + dx * t, p[1] + dy * t)  # noqa: E731
    out = []
    if t0 > 1e-9:
        out.append((p, at(t0)))
    if t1 < 1 - 1e-9:
        out.append((at(t1), q))
    return out


def _bez(p0, c1, c2, p3, n=24):
    pts = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        pts.append((
            u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0],
            u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1],
        ))
    return pts


def _boxes_touch(pts, r):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return not (max(xs) < r[0] or min(xs) > r[2] or max(ys) < r[1] or min(ys) > r[3])


def _cut_runs(subpaths, r):
    """Turns subpaths (in page space) into continuous pieces outside the rectangle.
    Each piece: a list of elements ('M', p) / ('L', p) / ('B', c1, c2, p).
    Returns (pieces, cut) — cut is False if no line actually enters the zone."""
    runs = []
    cur = None
    last = None
    clipped = False

    def clip(u, v):
        nonlocal clipped
        out = _clip_outside(u, v, r)
        if len(out) != 1 or out[0] != (u, v):
            clipped = True
        return out

    def emit_line(a, b):
        nonlocal cur, last
        if cur is None or last is None or abs(last[0] - a[0]) > 1e-6 or abs(last[1] - a[1]) > 1e-6:
            cur = [("M", a)]
            runs.append(cur)
        cur.append(("L", b))
        last = b

    for sp in subpaths:
        P, K = sp["pts"], sp["kinds"]
        cur = None
        last = None
        prev = P[0]
        j = 1
        segs = []
        while j < len(P):
            if K[j] == "L":
                segs.append(("L", prev, P[j]))
                prev = P[j]
                j += 1
            else:
                c1, c2, p3 = P[j], P[min(j + 1, len(P) - 1)], P[min(j + 2, len(P) - 1)]
                segs.append(("B", prev, c1, c2, p3))
                prev = p3
                j += 3
        if sp["closed"] and (abs(prev[0] - P[0][0]) > 1e-6 or abs(prev[1] - P[0][1]) > 1e-6):
            segs.append(("L", prev, P[0]))
        for sg in segs:
            if sg[0] == "B":
                _k, a, c1, c2, b = sg
                if not _boxes_touch([a, c1, c2, b], r):
                    # the curve is completely outside the zone: it stays a curve
                    if cur is None or last is None or abs(last[0] - a[0]) > 1e-6 or abs(last[1] - a[1]) > 1e-6:
                        cur = [("M", a)]
                        runs.append(cur)
                    cur.append(("B", c1, c2, b))
                    last = b
                    continue
                pts = [a] + _bez(a, c1, c2, b)
                for u, v in zip(pts, pts[1:]):
                    for x, y in clip(u, v):
                        emit_line(x, y)
            else:
                for x, y in clip(sg[1], sg[2]):
                    emit_line(x, y)
    return [run for run in runs if len(run) > 1], clipped


def _new_cut_path(src, runs, scale):
    """New path object, in page coordinates, with the stroke style of the source object."""
    obj = R.FPDFPageObj_CreateNewPath(ctypes.c_float(runs[0][0][1][0]), ctypes.c_float(runs[0][0][1][1]))
    first = True
    for run in runs:
        for el in run:
            if el[0] == "M":
                if first:
                    first = False
                    continue
                R.FPDFPath_MoveTo(obj, ctypes.c_float(el[1][0]), ctypes.c_float(el[1][1]))
            elif el[0] == "L":
                R.FPDFPath_LineTo(obj, ctypes.c_float(el[1][0]), ctypes.c_float(el[1][1]))
            else:
                (c1, c2, p) = el[1], el[2], el[3]
                R.FPDFPath_BezierTo(obj, *[ctypes.c_float(v) for v in (c1[0], c1[1], c2[0], c2[1], p[0], p[1])])
    rr, gg, bb, aa = (ctypes.c_uint() for _ in range(4))
    if R.FPDFPageObj_GetStrokeColor(src, ctypes.byref(rr), ctypes.byref(gg), ctypes.byref(bb), ctypes.byref(aa)):
        R.FPDFPageObj_SetStrokeColor(obj, rr.value, gg.value, bb.value, aa.value)
    w = ctypes.c_float()
    if R.FPDFPageObj_GetStrokeWidth(src, ctypes.byref(w)):
        R.FPDFPageObj_SetStrokeWidth(obj, ctypes.c_float(w.value * scale))
    cap = R.FPDFPageObj_GetLineCap(src)
    if cap >= 0:
        R.FPDFPageObj_SetLineCap(obj, cap)
    join = R.FPDFPageObj_GetLineJoin(src)
    if join >= 0:
        R.FPDFPageObj_SetLineJoin(obj, join)
    n = R.FPDFPageObj_GetDashCount(src)
    if n > 0:
        arr = (ctypes.c_float * n)()
        if R.FPDFPageObj_GetDashArray(src, arr, n):
            ph = ctypes.c_float()
            R.FPDFPageObj_GetDashPhase(src, ctypes.byref(ph))
            scaled = (ctypes.c_float * n)(*[v * scale for v in arr])
            R.FPDFPageObj_SetDashArray(obj, scaled, n, ctypes.c_float(ph.value * scale))
    R.FPDFPath_SetDrawMode(obj, 0, True)
    return obj


def _apply_removals_page(page: pdfium.PdfPage, ops: list[dict]) -> dict:
    """ops: [{"mode": "objects", "ids": [...]}, {"mode": "text"|"zone", "rect": [...]}]

    In "zone" mode, lines that pass only partly through the zone are cut at its edge: they are replaced
    by a new object that keeps only the parts outside (with the same stroke style).
    Filled objects (arrows, hatches) partly in the zone cannot be cut and are reported as remaining.

    Objects inside a Form XObject (blocks) are not modified: PDFium rewrites the form's
    resources without its content, and text in the block loses its font. They are reported as
    "locked" and can only be covered."""
    g = PageGeo.of(page)
    targets = {}
    cuts = {}
    report = {"removed": 0, "cut": 0, "partial": 0, "locked": 0, "black": 0}
    all_objs = list(_walk(page.raw))
    by_id = {oid: (obj, typ, pm, cont, nested) for oid, obj, typ, pm, cont, nested in all_objs}
    recolored = False
    for op in ops:
        if op.get("mode") != "black":
            continue
        for oid in op.get("ids", []):
            if oid not in by_id:
                continue
            obj, typ, _pm, _cont, nested = by_id[oid]
            if nested:
                report["locked"] += 1
                continue
            if _blacken_obj(obj, typ):
                report["black"] += 1
                recolored = True
            else:
                report["partial"] += 1
    for op in ops:
        mode = op.get("mode")
        if mode == "objects":
            for oid in op.get("ids", []):
                if oid in by_id:
                    if by_id[oid][4]:
                        report["locked"] += 1
                        continue
                    targets[oid] = by_id[oid]
        elif mode in ("text", "zone"):
            x0, y0, x1, y1 = op["rect"]
            rx0, rx1, ry0, ry1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
            a = g.from_vis(rx0, ry0)
            b = g.from_vis(rx1, ry1)
            rpdf = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
            for oid, (obj, typ, pm, cont, nested) in by_id.items():
                if typ == R.FPDF_PAGEOBJ_FORM:
                    continue
                if mode == "text" and typ != R.FPDF_PAGEOBJ_TEXT:
                    continue
                bb = _bbox_page_space(obj, pm)
                if bb is None:
                    continue
                vb = g.bbox_to_vis(*bb)
                if nested:
                    if not (vb[2] < rx0 or vb[0] > rx1 or vb[3] < ry0 or vb[1] > ry1):
                        report["locked"] += 1
                    continue
                if typ == R.FPDF_PAGEOBJ_TEXT:
                    cx, cy = (vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2
                    hit = rx0 <= cx <= rx1 and ry0 <= cy <= ry1
                else:
                    hit = vb[0] >= rx0 and vb[2] <= rx1 and vb[1] >= ry0 and vb[3] <= ry1
                    touches = not (vb[2] < rx0 or vb[0] > rx1 or vb[3] < ry0 or vb[1] > ry1)
                    if not hit and touches and mode == "zone" and _glyph_in(vb, (rx0, ry0, rx1, ry1)):
                        hit = True  # letter (AutoCAD text as lines) with its center in the zone: taken whole
                    if not hit and touches:
                        fill = ctypes.c_int()
                        stroke = ctypes.c_int()
                        stroke_only = (
                            typ == R.FPDF_PAGEOBJ_PATH
                            and R.FPDFPath_GetDrawMode(obj, ctypes.byref(fill), ctypes.byref(stroke))
                            and fill.value == 0
                            and stroke.value
                        )
                        if stroke_only and oid not in targets:
                            cuts[oid] = (obj, pm, cont, nested, rpdf)
                        else:
                            report["partial"] += 1
                if hit:
                    targets[oid] = (obj, typ, pm, cont, nested)
                    cuts.pop(oid, None)
    # new objects (the parts outside the zone) are inserted in place of the level-1 object they
    # come from, from the highest index to the lowest, so the drawing order is preserved
    inserts = []
    for oid, (obj, pm, cont, nested, rpdf) in cuts.items():
        total = mat_mul(_obj_matrix(obj), pm)
        runs, clipped = _cut_runs(_path_points(obj, total), rpdf)
        if not clipped:
            continue  # only the bounding rectangle touches the zone; the line stays untouched
        scale = math.sqrt(abs(total[0] * total[3] - total[1] * total[2])) or 1.0
        inserts.append((int(oid.split(".")[0]), oid, runs, scale))
        targets[oid] = (obj, R.FPDF_PAGEOBJ_PATH, pm, cont, nested)
    for top_idx, oid, runs, scale in sorted(inserts, key=lambda t: -t[0]):
        if runs:
            new = _new_cut_path(targets[oid][0], runs, scale)
            R.FPDFPage_InsertObjectAtIndex(page.raw, new, top_idx + 1)
        report["cut"] += 1
    # the deepest ones are deleted first, so parent indices do not matter
    for oid in sorted(targets, key=lambda s: -s.count(".")):
        obj, _typ, _pm, cont, nested = targets[oid]
        ok = R.FPDFFormObj_RemoveObject(cont, obj) if nested else R.FPDFPage_RemoveObject(page.raw, obj)
        if ok:
            R.FPDFPageObj_Destroy(obj)
            if oid not in cuts:
                report["removed"] += 1
    if targets or recolored:
        R.FPDFPage_GenerateContent(page.raw)
    return report


def _blacken_obj(obj, typ) -> bool:
    """A level-1 object becomes black (stroke and fill); white stays white."""
    r, g, b, a = (ctypes.c_uint() for _ in range(4))

    def is_white(getter):
        if not getter(obj, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)):
            return False
        return min(r.value, g.value, b.value) >= 247

    if typ == R.FPDF_PAGEOBJ_TEXT:
        if not is_white(R.FPDFPageObj_GetFillColor):
            R.FPDFPageObj_SetFillColor(obj, 0, 0, 0, a.value or 255)
        R.FPDFPageObj_SetStrokeColor(obj, 0, 0, 0, 255)
        return True
    if typ == R.FPDF_PAGEOBJ_PATH:
        if not is_white(R.FPDFPageObj_GetStrokeColor):
            R.FPDFPageObj_SetStrokeColor(obj, 0, 0, 0, a.value or 255)
        if not is_white(R.FPDFPageObj_GetFillColor):
            R.FPDFPageObj_SetFillColor(obj, 0, 0, 0, a.value or 255)
        return True
    return False


def apply_removals(pdf_bytes: bytes, removals: dict[int, list[dict]]) -> tuple[bytes, dict]:
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            reports = {}
            for idx, ops in removals.items():
                if not ops:
                    continue
                page = doc[int(idx)]
                reports[int(idx)] = _apply_removals_page(page, ops)
                page.close()
            out = io.BytesIO()
            doc.save(out)
            return out.getvalue(), reports
        finally:
            doc.close()


# ---------------------------------------------------------------- export


COLOR_LAYERS = {"add": (0.184, 0.435, 0.839), "rev": (0.776, 0.157, 0.157)}


_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _color(key, mode):
    if key == "white":
        return (1, 1, 1)
    if isinstance(key, str) and _HEX.match(key):
        # explicitly chosen color (covers in the background color): stays that way in any mode
        return tuple(int(key[i:i + 2], 16) / 255 for i in (1, 3, 5))
    if mode == "layers" and key in COLOR_LAYERS:
        return COLOR_LAYERS[key]
    return (0, 0, 0)


def _overlay_pdf(page_specs, color_mode) -> bytes:
    """page_specs: list of (PageGeo, mediabox, primitives). A reportlab PDF with one page
    per target page; content is drawn directly in the target's PDF coordinates."""
    _register_font()
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pageCompression=1)
    c.setCreator("DrawCAD")
    for g, mb, prims in page_specs:
        c.setPageSize((max(mb[2], 1), max(mb[3], 1)))
        c.setLineJoin(1)
        c.setLineCap(0)
        # white covers first, so they do not hide the new dimensions
        ordered = sorted(prims, key=lambda p: 0 if p.get("c") == "white" or p.get("cover") else 1)
        for p in ordered:
            t = p.get("t")
            col = _color(p.get("c", "add"), color_mode)
            c.setStrokeColorRGB(*col)
            c.setFillColorRGB(*col)
            c.setLineWidth(float(p.get("w", 0.7)))
            dp = p.get("dp")
            if dp and all(isinstance(v, (int, float)) and v >= 0 for v in dp) and sum(dp) > 0:
                c.setDash([float(v) for v in dp], 0)
            else:
                c.setDash([], 0)
            if t == "L":
                x1, y1, x2, y2 = p["p"]
                a = g.from_vis(x1, y1)
                b = g.from_vis(x2, y2)
                c.line(a[0], a[1], b[0], b[1])
            elif t in ("P", "R"):
                if t == "R":
                    x0, y0, x1, y1 = p["p"]
                    coords = [x0, y0, x1, y0, x1, y1, x0, y1]
                    close, fill, stroke = True, True, False
                else:
                    coords = p["p"]
                    close = bool(p.get("close"))
                    fill = bool(p.get("fill"))
                    stroke = not p.get("nostroke", False)
                if len(coords) < 4:
                    continue
                path = c.beginPath()
                first = g.from_vis(coords[0], coords[1])
                path.moveTo(*first)
                for i in range(2, len(coords), 2):
                    path.lineTo(*g.from_vis(coords[i], coords[i + 1]))
                if close:
                    path.close()
                c.drawPath(path, stroke=1 if stroke else 0, fill=1 if fill else 0)
            elif t == "C":
                cx, cy = g.from_vis(*p["p"])
                c.circle(cx, cy, float(p["r"]), stroke=0 if p.get("fill") and p.get("nostroke") else 1,
                         fill=1 if p.get("fill") else 0)
            elif t == "O":
                # recognized text (OCR), invisible: makes the PDF searchable and allows copying the text
                txt = str(p.get("txt", ""))
                x0, y0, x1, y1 = p["p"]
                vert = p.get("rot") == 90
                bw, bh = (y1 - y0, x1 - x0) if vert else (x1 - x0, y1 - y0)
                if not txt or bw <= 0 or bh <= 0:
                    continue
                cap = float(p.get("cap") or bh * 0.75)
                size = cap / 0.74  # letter body from the cap height (osifont)
                if p.get("len"):
                    bw = float(p["len"])
                sw = pdfmetrics.stringWidth(txt, FONT_NAME, size) or 1
                if p.get("org"):
                    ox, oy = p["org"]
                else:
                    base = p.get("base")
                    if base is None:
                        base = (x1 - bh * 0.2) if vert else (y1 - bh * 0.2)
                    ox, oy = (base, y1) if vert else (x0, base)
                ang = float(p.get("ang", 90 if vert else 0))
                x, y = g.from_vis(ox, oy)
                c.saveState()
                c.translate(x, y)
                c.rotate(ang + g.rotation)
                to = c.beginText()
                to.setTextRenderMode(3)
                to.setFont(FONT_NAME, size)
                to.setHorizScale(max(10, min(400, 100 * bw / sw)))
                to.setTextOrigin(0, 0)
                to.textOut(txt)
                c.drawText(to)
                c.restoreState()
            elif t == "T":
                txt = str(p.get("txt", ""))
                if not txt:
                    continue
                x, y = g.from_vis(*p["p"])
                c.saveState()
                c.translate(x, y)
                c.rotate(float(p.get("a", 0)) + g.rotation)
                c.setFont(FONT_NAME, float(p.get("s", 10)))
                c.drawString(0, 0, txt)
                c.restoreState()
        c.showPage()
    c.save()
    return buf.getvalue()


def export_pdf(
    original: bytes,
    primitives: dict[int, list[dict]],
    removals: dict[int, list[dict]],
    color_mode: str = "black",
    state_json: bytes | None = None,
    embed_original: bool = True,
    ink: dict | None = None,
) -> tuple[bytes, dict]:
    base, reports = apply_removals(original, removals) if any(removals.values()) else (original, {})
    if ink and ink.get("all"):
        base = ink_pdf(base, None, ink.get("fills", "black"), bool(ink.get("images")))
    pk = pikepdf.open(io.BytesIO(base))
    targets = []
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(base)
        try:
            for idx, prims in primitives.items():
                idx = int(idx)
                if not prims or idx >= len(doc):
                    continue
                page = doc[idx]
                g = PageGeo.of(page)
                mb = page.get_mediabox()
                page.close()
                targets.append((idx, g, mb, prims))
        finally:
            doc.close()

    if targets:
        ov_bytes = _overlay_pdf([(g, mb, prims) for _i, g, mb, prims in targets], color_mode)
        ov = pikepdf.open(io.BytesIO(ov_bytes))
        for k, (idx, _g, mb, _p) in enumerate(targets):
            form = ov.pages[k].as_form_xobject()
            form_local = pk.copy_foreign(form)
            form_local.BBox = pikepdf.Array([mb[0], mb[1], mb[2], mb[3]])
            target = pk.pages[idx]
            name = target.add_resource(form_local, pikepdf.Name.XObject, prefix="Cot")
            target.contents_add(pikepdf.Stream(pk, b"q\n"), prepend=True)
            target.contents_add(pikepdf.Stream(pk, b"\nQ\nq " + str(name).encode() + b" Do Q\n"))

    if state_json is not None:
        pk.attachments[ATTACH_JSON] = pikepdf.AttachedFileSpec(pk, state_json, mime_type="application/json")
        if embed_original:
            pk.attachments[ATTACH_ORIGINAL] = pikepdf.AttachedFileSpec(pk, original, mime_type="application/pdf")
    out = io.BytesIO()
    pk.save(out, compress_streams=True)
    pk.close()
    return out.getvalue(), reports


# ---------------------------------------------------------------- export by pages


def subset_pdf(pdf_bytes: bytes, idxs: list[int]) -> bytes:
    """Only the given pages, in the given order (content streams are not touched)."""
    src = pikepdf.open(io.BytesIO(pdf_bytes))
    keep = set(idxs)
    for i in range(len(src.pages) - 1, -1, -1):
        if i not in keep:
            del src.pages[i]
    out = io.BytesIO()
    src.save(out, compress_streams=True)
    src.close()
    return out.getvalue()


def _remap_state(state: dict | None, idxs: list[int]) -> dict | None:
    """Editable state for a partial export: only the annotations of the chosen pages, renumbered."""
    if not isinstance(state, dict):
        return None
    pos = {p: k for k, p in enumerate(idxs)}
    annots = []
    for a in state.get("annots") or []:
        if isinstance(a, dict) and a.get("page", 0) in pos:
            annots.append({**a, "page": pos[a.get("page", 0)]})
    return {**state, "annots": annots}


def _attach(pdf_bytes: bytes, state: dict | None, original: bytes | None, rev: str | None = None, title: str | None = None) -> bytes:
    """Adds the editable layer (state + original) and the revision metadata to an exported PDF."""
    import json as _json

    if state is None and not rev:
        return pdf_bytes
    pk = pikepdf.open(io.BytesIO(pdf_bytes))
    if state is not None:
        pk.attachments[ATTACH_JSON] = pikepdf.AttachedFileSpec(pk, _json.dumps(state, ensure_ascii=False).encode("utf-8"), mime_type="application/json")
        if original is not None:
            pk.attachments[ATTACH_ORIGINAL] = pikepdf.AttachedFileSpec(pk, original, mime_type="application/pdf")
    if rev:
        set_revision_meta(pk, rev, title)
    out = io.BytesIO()
    pk.save(out, compress_streams=True)
    pk.close()
    return out.getvalue()


def set_revision_meta(pk, rev: str, title: str | None = None) -> None:
    """Revision in the document information (/DrawCADRevision, Keywords) and in XMP, where other
    programs (Acrobat → Properties, file managers) show it."""
    rev = re.sub(r"[^\w .-]", "", str(rev))[:20] or "1"
    info = pk.docinfo
    info[pikepdf.Name("/DrawCADRevision")] = rev
    old = str(info.get("/Keywords", "") or "")
    kw = re.sub(r"(^|;\s*)rev [^;]*", "", old).strip("; ")
    info[pikepdf.Name("/Keywords")] = f"{kw}; rev {rev}" if kw else f"rev {rev}"
    if title:
        info[pikepdf.Name("/Title")] = title[:200]
    info[pikepdf.Name("/Producer")] = "DrawCAD"
    try:
        with pk.open_metadata(set_pikepdf_as_editor=False) as m:
            m["pdf:Keywords"] = str(info["/Keywords"])
            m["pdf:Producer"] = "DrawCAD"
            if title:
                m["dc:title"] = title[:200]
    except Exception:  # noqa: BLE001 - damaged XMP of the original: the Info dictionary still has it
        pass


def export_pages(original, primitives, removals, color_mode, state, embed, ink, sel, split, basename="export", rev=None):
    """Export for pages `sel` (None = all): one PDF, or one PDF per page in a ZIP.
    Each file carries the editable layer for its pages, so it can be reopened."""
    import zipfile

    n_pages = len(pikepdf.open(io.BytesIO(original)).pages)
    idxs = sorted({i for i in (sel or range(n_pages)) if 0 <= i < n_pages})
    if not idxs:
        raise ValueError("nicio pagină aleasă")
    prims = {k: v for k, v in primitives.items() if k in idxs}
    rem = {k: v for k, v in removals.items() if k in idxs}
    full, reports = export_pdf(original, prims, rem, color_mode, None, embed, ink)
    whole = len(idxs) == n_pages
    if not split:
        pdf = full if whole else subset_pdf(full, idxs)
        if state is not None:
            orig = original if whole else subset_pdf(original, idxs)
            pdf = _attach(pdf, state if whole else _remap_state(state, idxs), orig if embed else None, rev, basename)
        elif rev:
            pdf = _attach(pdf, None, None, rev, basename)
        return pdf, reports, "pdf"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i in idxs:
            one = subset_pdf(full, [i])
            one = _attach(one, _remap_state(state, [i]) if state is not None else None, subset_pdf(original, [i]) if embed and state is not None else None, rev, f"{basename}_p{i + 1}")
            z.writestr(f"{basename}_p{i + 1}.pdf", one)
    return buf.getvalue(), reports, "zip"
