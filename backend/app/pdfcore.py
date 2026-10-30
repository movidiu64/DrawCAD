"""Operații PDF: randare, geometrie pentru snap, obiecte din zonă, ștergere obiecte, export.

Coordonate „vizuale”: puncte PDF (1/72"), originea în colțul stânga-sus al paginii
așa cum se vede (CropBox + /Rotate aplicate), y în jos. Frontend-ul lucrează numai în
acest sistem; conversia în spațiul PDF se face aici.
"""
from __future__ import annotations

import ctypes
import io
import math
import os
import re
import threading
from dataclasses import dataclass

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as R
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

# pdfium nu e thread-safe: toate apelurile trec prin acest lock
PDFIUM_LOCK = threading.RLock()

FONT_NAME = "osifont"
FONT_PATH = os.environ.get("DRAWCAD_FONT") or os.environ.get(
    "COTARE_FONT",
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "fonts", "osifont.ttf"),
)
_font_registered = False

ATTACH_JSON = "drawcad.json"
ATTACH_ORIGINAL = "drawcad-original.pdf"
# exporturile făcute înainte de redenumire (Cotare) se redeschid în continuare
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
    """Aplică m1, apoi m2 (convenție PDF, vector-rând)."""
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
    """Conversie între spațiul PDF al paginii și coordonatele vizuale."""

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
    """Parcurge recursiv obiectele paginii (inclusiv din Form XObject).

    Produce (id, handle, tip, matrice_părinte, container, este_imbricat).
    id = indici separați prin '.', stabil cât timp fișierul original nu se schimbă.
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
    """Segmentele unui path, în spațiul paginii: listă de subpath-uri (liste de puncte)
    plus indicatori dacă subpath-ul conține curbe."""
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


# ---------------------------------------------------------------- deschidere


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
    """Dacă PDF-ul a fost exportat de aplicație cu strat editabil, întoarce (original, json)."""
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
    """Convertește o imagine (PNG/JPG/TIFF) într-o pagină PDF la DPI-ul dat sau citit din fișier."""
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
    frames = []
    n_frames = getattr(im, "n_frames", 1)
    for i in range(n_frames):
        im.seek(i)
        # img2pdf nu acceptă canal alfa: alb-negru/gri rămân gri, restul RGB
        fr = im.convert("L") if im.mode in ("1", "L", "LA", "I", "I;16") else im.convert("RGB")
        b = io.BytesIO()
        fr.save(b, format="PNG")
        frames.append(b.getvalue())
    layout = img2pdf.get_fixed_dpi_layout_fun((use_dpi, use_dpi))
    return img2pdf.convert(frames, layout_fun=layout), use_dpi


# ---------------------------------------------------------------- randare


def render_png(pdf_bytes: bytes, page_index: int, scale: float, removals=None, ink=None) -> bytes:
    if ink and ink.get("all"):
        pdf_bytes = ink_pdf(pdf_bytes, {page_index}, ink.get("fills", "black"), bool(ink.get("images")))
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[page_index]
            if removals:
                _apply_removals_page(page, removals)
            bmp = page.render(scale=scale, rotation=0, may_draw_forms=True, draw_annots=True)
            img = bmp.to_pil()
            out = io.BytesIO()
            img.save(out, format="PNG", compress_level=1)
            page.close()
            return out.getvalue()
        finally:
            doc.close()


# ---------------------------------------------------------------- înnegrire pentru tipărire
# Desenele colorate (verde deschis, galben…) ies aproape invizibile la imprimantă. Liniile și textul
# se fac negre rescriind operatorii de culoare din fluxurile de conținut (pagină și blocuri), deci
# geometria, fonturile și ordinea obiectelor rămân neatinse. Albul (hârtia, mascările) rămâne alb.

INK_FILLS = ("black", "gray", "keep")


def _num(v):
    try:
        return float(v)
    except Exception:  # noqa: BLE001
        return 0.0


def _cs_kind(name, resources, depth=0):
    """Tipul unui spațiu de culoare: (familie, nr. componente, extra)."""
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
    """(e_alb, luminozitate 0…1) pentru o culoare."""
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
    """Rescrie operatorii de culoare: contururile și textul devin negre, umplerile după `fills`."""
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
                # textul e întotdeauna negru (sau alb, dacă era alb)
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
    """Imagine → alb-negru pentru tipărire: tot ce nu e hârtie (închis sau colorat) devine negru."""
    from PIL import Image, ImageChops  # noqa: PLC0415

    if obj.get("/ImageMask", False):
        return False  # mască: se desenează cu culoarea de umplere, deja înnegrită
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
    """Face negre liniile și textul originalului (opțional și imaginile) pe paginile date."""
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


# ---------------------------------------------------------------- geometrie pentru snap


def _bez_at(p0, c1, c2, p3, t):
    u = 1 - t
    return (
        u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0],
        u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1],
    )


def _circle3(a, b, c):
    """Cercul prin trei puncte: (cx, cy, r) sau None dacă sunt coliniare."""
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
    """Dacă o curbă Bézier (în coordonate vizuale) e un arc de cerc, întoarce (cx, cy, r, a0, sweep)
    cu unghiuri pe ecran în sens trigonometric (y în jos), altfel None."""
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


def snap_points(pdf_bytes: bytes, page_index: int, limit: int = 60000) -> dict:
    """Puncte caracteristice: capete și mijloace de segmente, centre de cercuri.

    Întoarce și segmentele de dreaptă (pentru snap pe linie / perpendicular)."""
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
                if typ != R.FPDF_PAGEOBJ_PATH:
                    continue
                total = mat_mul(_obj_matrix(obj), parent_total)
                for sp in _path_points(obj, total):
                    P = sp["pts"]
                    K = sp["kinds"]
                    if len(P) < 2:
                        continue
                    # cerc / arc închis aproximat din curbe Bézier → centru
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
                        else:  # Bézier: trei puncte, ultimul e capătul
                            c1, c2 = P[j], P[min(j + 1, len(P) - 1)]
                            end = P[min(j + 2, len(P) - 1)]
                            add(end[0], end[1], "e")
                            vp = [g.to_vis(*q) for q in (prev, c1, c2, end)]
                            arc = _bez_as_arc(*vp)
                            if arc:
                                # arcele consecutive ale aceluiași cerc (racordări din mai multe curbe) se unesc
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
                                # curbă oarecare: aproximată din segmente, pentru „pe obiect” și intersecții
                                qs = [vp[0]] + [_bez_at(*vp, k / 8) for k in range(1, 9)]
                                for a, b in zip(qs, qs[1:]):
                                    segs.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3), 1])
                            prev = end
                            j += 3
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
            # centrele și mijloacele arcelor (racordări): utile pentru cote de rază și axe
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


# ---------------------------------------------------------------- obiecte din zonă / ștergere


GLYPH_MAX = 12 * 72 / 25.4  # 12 mm


def _glyph_in(b, r):
    """Obiect mic (literă) cu centrul casetei în zonă."""
    cx = (b[0] + b[2]) / 2
    cy = (b[1] + b[3]) / 2
    w, h = b[2] - b[0], b[3] - b[1]
    # liniile drepte (o dimensiune ~0) nu sunt litere: acelea se taie la margine
    return max(w, h) <= GLYPH_MAX and min(w, h) >= 2.3 and r[0] <= cx <= r[2] and r[1] <= cy <= r[3]


def _area_frac(b, r):
    w = max(b[2] - b[0], 1e-6)
    h = max(b[3] - b[1], 1e-6)
    iw = max(0.0, min(b[2], r[2]) - max(b[0], r[0]))
    ih = max(0.0, min(b[3], r[3]) - max(b[1], r[1]))
    # obiect foarte subțire (linie orizontală/verticală): contează doar dimensiunea lungă
    if b[2] - b[0] < 0.5:
        return round(ih / h, 3)
    if b[3] - b[1] < 0.5:
        return round(iw / w, 3)
    return round(iw * ih / (w * h), 3)


def _frac_inside(subpaths, r):
    """Fracțiunea din lungimea unui path aflată în dreptunghiul r (în spațiul paginii)."""
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
                    continue  # se listează copiii
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
                    "locked": "." in oid,  # în interiorul unui bloc (Form XObject): doar acoperire
                }
                # cât din obiect e în zonă (lungimea liniilor, sau aria casetei pentru text și imagini)
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
                            continue  # doar încadrarea atinge zona (ex. chenarul foii)
                        item["frac"] = round(_frac_inside(sps, rpdf), 3)
                    for sp in sps:
                        nseg += len(sp["pts"])
                        poly.append([[round(c, 2) for c in g.to_vis(*p)] for p in sp["pts"][:400]])
                    item["segments"] = nseg
                    item["poly"] = poly[:50]
                    fill = ctypes.c_int()
                    stroke = ctypes.c_int()
                    ok = R.FPDFPath_GetDrawMode(obj, ctypes.byref(fill), ctypes.byref(stroke))
                    # doar liniile simple (fără umplere) se pot tăia la marginea zonei
                    item["cuttable"] = bool(ok and fill.value == 0 and stroke.value)
                out.append(item)
            tp.close()
            page.close()
        finally:
            doc.close()
    return out


# ---------------------------------------------------------------- tăiere geometrică


def _clip_outside(p, q, r):
    """Părțile segmentului p→q aflate în afara dreptunghiului r = (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = r
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, p[0] - x0), (dx, x1 - p[0]), (-dy, p[1] - y0), (dy, y1 - p[1])):
        if abs(pk) < 1e-12:
            if qk < 0:
                return [(p, q)]  # paralel și în afara benzii: tot segmentul e afară
            continue
        t = qk / pk
        if pk < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
    if t0 >= t1:
        return [(p, q)]  # nu intră în dreptunghi
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
    """Transformă subpath-urile (în spațiul paginii) în porțiuni continue din afara dreptunghiului.
    Fiecare porțiune: listă de elemente ('M', p) / ('L', p) / ('B', c1, c2, p).
    Întoarce (porțiuni, tăiat) — tăiat e False dacă nicio linie nu intră efectiv în zonă."""
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
                    # curba e complet în afara zonei: rămâne curbă
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
    """Obiect path nou, în coordonatele paginii, cu stilul de contur al obiectului sursă."""
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

    În modul „zone”, liniile care trec doar parțial prin zonă se taie la marginea ei: se înlocuiesc
    cu un obiect nou care păstrează numai porțiunile din afară (cu același stil de contur).
    Obiectele pline (săgeți, hașuri) parțial în zonă nu se pot tăia și sunt raportate ca rămase.

    Obiectele din interiorul unui Form XObject (blocuri) nu se modifică: PDFium rescrie resursele
    formularului fără conținutul lui, iar textul din bloc își pierde fontul. Ele se raportează ca
    „locked” și se pot doar acoperi."""
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
                        hit = True  # literă (text AutoCAD ca linii) cu centrul în zonă: se ia întreagă
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
    # obiectele noi (porțiunile din afara zonei) se inserează pe locul obiectului de nivel 1 din care
    # provin, de la indicele cel mai mare la cel mai mic, ca ordinea de desenare să se păstreze
    inserts = []
    for oid, (obj, pm, cont, nested, rpdf) in cuts.items():
        total = mat_mul(_obj_matrix(obj), pm)
        runs, clipped = _cut_runs(_path_points(obj, total), rpdf)
        if not clipped:
            continue  # doar dreptunghiul încadrator atinge zona; linia rămâne neatinsă
        scale = math.sqrt(abs(total[0] * total[3] - total[1] * total[2])) or 1.0
        inserts.append((int(oid.split(".")[0]), oid, runs, scale))
        targets[oid] = (obj, R.FPDF_PAGEOBJ_PATH, pm, cont, nested)
    for top_idx, oid, runs, scale in sorted(inserts, key=lambda t: -t[0]):
        if runs:
            new = _new_cut_path(targets[oid][0], runs, scale)
            R.FPDFPage_InsertObjectAtIndex(page.raw, new, top_idx + 1)
        report["cut"] += 1
    # se șterg întâi cele mai adânci, ca indicii părinților să nu conteze
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
    """Un obiect de nivel 1 devine negru (contur și umplere); albul rămâne alb."""
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
        # culoare aleasă explicit (acoperiri în culoarea fundalului): rămâne așa în orice mod
        return tuple(int(key[i:i + 2], 16) / 255 for i in (1, 3, 5))
    if mode == "layers" and key in COLOR_LAYERS:
        return COLOR_LAYERS[key]
    return (0, 0, 0)


def _overlay_pdf(page_specs, color_mode) -> bytes:
    """page_specs: listă de (PageGeo, mediabox, primitive). Un PDF reportlab cu câte o pagină
    pentru fiecare pagină țintă; conținutul e desenat direct în coordonatele PDF ale țintei."""
    _register_font()
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pageCompression=1)
    c.setCreator("DrawCAD")
    for g, mb, prims in page_specs:
        c.setPageSize((max(mb[2], 1), max(mb[3], 1)))
        c.setLineJoin(1)
        c.setLineCap(0)
        # acoperirile albe primele, ca să nu ascundă cotele noi
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
