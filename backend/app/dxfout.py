"""DXF export: page geometry (from the vector PDF or from scan vectorization), texts,
DrawCAD annotations and recognized text (OCR), on separate layers.

Coordinates: millimeters, origin at the bottom-left corner of the page as seen on screen
(page rotation applied). With `scale` ≠ 1 the drawing gets the part's real dimensions
(e.g. a 1:2 drawing → scale 2), so dimensions measured in CAD give the real values.
"""
from __future__ import annotations

import ctypes
import io
import math
import os
import re
import tempfile

# on import ezdxf looks for ~/.config/ezdxf/ezdxf.ini: in the container the process runs as a different
# user than the owner of HOME (/root), and the lookup would fail with "Permission denied"
if not os.access(os.path.expanduser("~"), os.R_OK | os.X_OK):
    os.environ["HOME"] = tempfile.gettempdir()
os.environ.setdefault("XDG_CACHE_HOME", os.path.join(tempfile.gettempdir(), "drawcad-cache"))

import ezdxf  # noqa: E402
from ezdxf import zoom  # noqa: E402

from .pdfcore import (
    COLOR_MARK,
    PDFIUM_LOCK,
    PageGeo,
    R,
    _bez_as_arc,
    _bez_at,
    _is_hidden,
    _obj_matrix,
    _path_points,
    _text_of,
    _walk,
    _wrap_pi,
    mat_mul,
    pdfium,
)

PT_MM = 25.4 / 72
CAP_OSIFONT = 1515 / 2048  # cap height in osifont, relative to the letter body
CAP_GENERIC = 0.72
# standard DXF line weights (hundredths of a mm)
LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211]

LAYERS = {
    "PAGINA": 8,
    "PDF-GEOMETRIE": 7,
    "PDF-UMPLERI": 7,
    "PDF-TEXT": 7,
    "SCAN-IMAGINE": 8,
    "SCAN-VECTORI": 7,
    "OCR-TEXT": 7,
    "DRAWCAD-ACOPERIRI": 7,
    "DRAWCAD-COTE": 7,
    "DRAWCAD-REVIZIE": 7,
    "DRAWCAD-MARKER": 3,
    "DRAWCAD-STAMPILE": 1,
    "DRAWCAD-FILIGRAN": 8,
    "DRAWCAD-IMAGINI": 7,
}
# DXF line weights stop at 2.11 mm: wider strokes (the highlighter) get a polyline width
MAX_LINEWEIGHT_MM = 2.11


def _annot_layer(c) -> str:
    if c == "rev":
        return "DRAWCAD-REVIZIE"
    if isinstance(c, str) and c.startswith("hl"):
        return "DRAWCAD-MARKER"
    if isinstance(c, str) and c.startswith("st"):
        return "DRAWCAD-STAMPILE"
    if c == "wm":
        return "DRAWCAD-FILIGRAN"
    return "DRAWCAD-COTE"


def _lineweight(mm: float) -> int:
    v = mm * 100
    return min(LINEWEIGHTS[1:], key=lambda w: abs(w - v))


# ---------------------------------------------------------------- extraction from the PDF


def _rgb(fn, obj):
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not fn(obj, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)):
        return None
    if a.value == 0:
        return None
    return (r.value, g.value, b.value)


def _dash(obj, scale):
    try:
        n = R.FPDFPageObj_GetDashCount(obj)
    except Exception:  # noqa: BLE001
        return None
    if not n or n <= 0 or n > 16:
        return None
    arr = (ctypes.c_float * n)()
    if not R.FPDFPageObj_GetDashArray(obj, arr, n):
        return None
    vals = [max(0.0, float(v) * scale) for v in arr]
    if sum(vals) <= 0:
        return None
    if len(vals) % 2:
        vals = vals * 2
    return vals


def _segments(sp, g):
    """A subpath in visual coordinates: a list of ("L", a, b) / ("A", a, b, sweep, circle) / ("B", a, c1, c2, b)."""
    P = [g.to_vis(*p) for p in sp["pts"]]
    K = sp["kinds"]
    out = []
    if len(P) < 2:
        return out, P
    prev = P[0]
    j = 1
    while j < len(P):
        if K[j] == "L":
            p = P[j]
            if (prev[0] - p[0]) ** 2 + (prev[1] - p[1]) ** 2 > 1e-8:
                out.append(("L", prev, p))
            prev = p
            j += 1
        else:
            c1, c2 = P[j], P[min(j + 1, len(P) - 1)]
            end = P[min(j + 2, len(P) - 1)]
            arc = _bez_as_arc(prev, c1, c2, end)
            if arc and abs(arc[4]) > 1e-4:
                out.append(("A", prev, end, arc[4], arc[:3]))
            elif (prev[0] - end[0]) ** 2 + (prev[1] - end[1]) ** 2 > 1e-8 or (c1 != prev):
                out.append(("B", prev, c1, c2, end))
            prev = end
            j += 3
    if sp["closed"] and (prev[0] - P[0][0]) ** 2 + (prev[1] - P[0][1]) ** 2 > 1e-8:
        out.append(("L", prev, P[0]))
    return out, P


def _as_circle(segs):
    """A subpath made only of arcs of the same circle, which closes: (cx, cy, r)."""
    if not segs or any(s[0] != "A" for s in segs):
        return None
    cx, cy, r = segs[0][4]
    tol = max(0.05, r * 0.01)
    total = 0.0
    for s in segs:
        c = s[4]
        if abs(c[0] - cx) > tol or abs(c[1] - cy) > tol or abs(c[2] - r) > tol:
            return None
        total += s[3]
    if abs(abs(total) - 2 * math.pi) > 0.02:
        return None
    a, b = segs[0][1], segs[-1][2]
    if math.hypot(a[0] - b[0], a[1] - b[1]) > tol:
        return None
    return cx, cy, r


def page_content(pdf_bytes: bytes, page_index: int) -> dict:
    """Everything that can go into the DXF from a PDF page, in visual coordinates (points, y down)."""
    with PDFIUM_LOCK:
        doc = pdfium.PdfDocument(pdf_bytes)
        try:
            page = doc[page_index]
            g = PageGeo.of(page)
            W, H = g.visual_size
            tp = page.get_textpage()
            paths, texts, images = [], [], []
            for _oid, obj, typ, parent_total, _c, _n in _walk(page.raw):
                if _is_hidden(obj, typ):
                    continue  # a layer hidden in the editor (drawing opened from DXF)
                if typ == R.FPDF_PAGEOBJ_PATH:
                    total = mat_mul(_obj_matrix(obj), parent_total)
                    fill = ctypes.c_int()
                    stroke = ctypes.c_int()
                    if not R.FPDFPath_GetDrawMode(obj, ctypes.byref(fill), ctypes.byref(stroke)):
                        continue
                    if not fill.value and not stroke.value:
                        continue  # clipping / invisible path
                    det = abs(total[0] * total[3] - total[1] * total[2])
                    sc = math.sqrt(det) if det > 0 else 1.0
                    w = ctypes.c_float()
                    R.FPDFPageObj_GetStrokeWidth(obj, ctypes.byref(w))
                    subs = []
                    for sp in _path_points(obj, total):
                        segs, pts = _segments(sp, g)
                        if segs:
                            subs.append({"segs": segs, "closed": bool(sp["closed"])})
                    if not subs:
                        continue
                    paths.append({
                        "subs": subs,
                        "stroke": bool(stroke.value),
                        "fill": bool(fill.value),
                        "w": float(w.value) * sc,
                        "sc": _rgb(R.FPDFPageObj_GetStrokeColor, obj),
                        "fc": _rgb(R.FPDFPageObj_GetFillColor, obj),
                        "dash": _dash(obj, sc) if stroke.value else None,
                    })
                elif typ == R.FPDF_PAGEOBJ_TEXT:
                    try:
                        if R.FPDFTextObj_GetTextRenderMode(obj) == 3:
                            continue  # invisible text (another program's OCR layer)
                    except Exception:  # noqa: BLE001
                        pass
                    txt = _text_of(obj, tp.raw).replace("\r", " ").replace("\n", " ")
                    txt = re.sub(r"[\x00-\x08\x0b-\x1f￾￿]", "", txt)
                    if not txt.strip():
                        continue
                    size = ctypes.c_float()
                    R.FPDFTextObj_GetFontSize(obj, ctypes.byref(size))
                    m = mat_mul(_obj_matrix(obj), parent_total)
                    ox, oy = m[4], m[5]
                    o = g.to_vis(ox, oy)
                    ux = g.to_vis(ox + m[0], oy + m[1])
                    vy = math.hypot(m[2], m[3])
                    ang = math.degrees(math.atan2(-(ux[1] - o[1]), ux[0] - o[0]))
                    h = float(size.value) * (vy if vy > 0 else 1.0)
                    col = _rgb(R.FPDFPageObj_GetFillColor, obj)
                    texts.append({"txt": txt, "p": o, "h": h, "a": ang, "c": col})
                elif typ == R.FPDF_PAGEOBJ_IMAGE:
                    from .pdfcore import _bbox_page_space

                    bb = _bbox_page_space(obj, parent_total)
                    if bb:
                        images.append(g.bbox_to_vis(*bb))
            tp.close()
            page.close()
            return {"W": W, "H": H, "paths": paths, "texts": texts, "images": images}
        finally:
            doc.close()


def is_scan(content: dict) -> bool:
    """Scanned page: an image covers most of the sheet and vector lines are missing."""
    area = content["W"] * content["H"]
    img = max(((b[2] - b[0]) * (b[3] - b[1]) for b in content["images"]), default=0)
    n_segs = sum(len(s["segs"]) for p in content["paths"] for s in p["subs"])
    return img > 0.5 * area and n_segs < 200


# ---------------------------------------------------------------- DXF writing


def _gray_dark(c):
    return c is None or (max(c) - min(c) < 24 and max(c) < 110)


def _whiteish(c):
    return c is not None and min(c) > 242


class DxfPage:
    def __init__(self, W: float, H: float, scale: float = 1.0):
        self.W, self.H = W, H
        self.k = PT_MM * (scale if scale and scale > 0 else 1.0)
        self.doc = ezdxf.new("R2010", setup=False, units=4)
        self.doc.header["$MEASUREMENT"] = 1
        self.doc.header["$LUNITS"] = 2
        self.doc.header["$LTSCALE"] = 1.0
        self.doc.header["$LWDISPLAY"] = 1
        # the page, for reopening in DrawCAD (dxfin): paper size in mm and drawing scale; the page spans
        # (0, 0)…(W, H) × scale in model space
        for name, val in (("DRAWCAD_SHEET_W", W * PT_MM), ("DRAWCAD_SHEET_H", H * PT_MM), ("DRAWCAD_SCALE", self.k / PT_MM)):
            self.doc.header.custom_vars.append(name, f"{val:.6g}")
        self.doc.styles.add("ISO", font="isocpeur.ttf")
        for name, col in LAYERS.items():
            self.doc.layers.add(name, color=col)
        self.msp = self.doc.modelspace()
        self._lt = {}
        self.counts = {}

    def _count(self, key, n=1):
        self.counts[key] = self.counts.get(key, 0) + n

    def xy(self, p):
        return (round(p[0] * self.k, 5), round((self.H - p[1]) * self.k, 5))

    def linetype(self, dash_pt):
        """Line type from the PDF dash pattern (lengths in points, on paper)."""
        if not dash_pt:
            return None
        vals = [round(v * self.k, 3) for v in dash_pt]
        key = tuple(vals)
        if key in self._lt:
            return self._lt[key]
        n = len(self._lt) + 1
        while f"DRAWCAD_{n}" in self.doc.linetypes:
            n += 1
        name = f"DRAWCAD_{n}"
        pattern = [round(sum(vals), 4)]
        for i, v in enumerate(vals):
            pattern.append(v if i % 2 == 0 else -v)
        desc = " ".join("__" if i % 2 == 0 and v > 0.5 else ("." if i % 2 == 0 else " ") for i, v in enumerate(vals))
        self.doc.linetypes.add(name, pattern=pattern, description=desc)
        self._lt[key] = name
        return name

    def attribs(self, layer, w_pt=None, rgb=None, dash=None):
        a = {"layer": layer}
        if w_pt is not None and w_pt > 0:
            a["lineweight"] = _lineweight(w_pt * PT_MM)
        if rgb is not None and not _gray_dark(rgb):
            a["true_color"] = ezdxf.rgb2int(rgb)
        lt = self.linetype(dash)
        if lt:
            a["linetype"] = lt
        return a

    # --- geometry
    def frame(self):
        self.msp.add_lwpolyline([self.xy((0, 0)), self.xy((self.W, 0)), self.xy((self.W, self.H)), self.xy((0, self.H))],
                                close=True, dxfattribs={"layer": "PAGINA"})

    def _poly_run(self, run, closed, attribs):
        """Consecutive lines and arcs → LWPOLYLINE with "bulge" (arcs stay true arcs in CAD)."""
        pts = []
        for s in run:
            x, y = self.xy(s[1])
            bulge = math.tan(s[3] / 4) if s[0] == "A" else 0.0
            pts.append((x, y, 0, 0, round(bulge, 9)))
        if not closed:
            x, y = self.xy(run[-1][2])
            pts.append((x, y, 0, 0, 0))
        if len(pts) == 2 and not closed and pts[0][4] == 0:
            self.msp.add_line(pts[0][:2], pts[1][:2], dxfattribs=attribs)
            self._count("linii")
        else:
            self.msp.add_lwpolyline(pts, format="xyseb", close=closed, dxfattribs=attribs)
            self._count("polilinii")

    def add_segments(self, segs, closed, attribs):
        circ = _as_circle(segs) if closed or segs else None
        if circ:
            cx, cy, r = circ
            self.msp.add_circle(self.xy((cx, cy)), r * self.k, dxfattribs=attribs)
            self._count("cercuri")
            return
        # a single arc → ARC (exact center and radius, useful for dimensioning in CAD)
        if len(segs) == 1 and segs[0][0] == "A":
            _t, a, b, sw, (cx, cy, r) = segs[0]
            a0 = math.degrees(math.atan2(-(a[1] - cy), a[0] - cx))
            a1 = a0 + math.degrees(sw)
            if sw < 0:
                a0, a1 = a1, a0
            self.msp.add_arc(self.xy((cx, cy)), r * self.k, a0 % 360, a1 % 360, dxfattribs=attribs)
            self._count("arce")
            return
        run = []
        all_closed = closed and not any(s[0] == "B" for s in segs)
        for s in segs:
            if s[0] == "B":
                if run:
                    self._poly_run(run, False, attribs)
                    run = []
                self.msp.add_open_spline([self.xy(q) for q in s[1:]], degree=3, dxfattribs=attribs)
                self._count("curbe")
            else:
                run.append(s)
        if run:
            self._poly_run(run, all_closed, attribs)

    def add_hatch(self, subs, attribs):
        h = self.msp.add_hatch(color=7, dxfattribs=attribs)
        n = 0
        for sub in subs:
            pts = []
            for s in sub["segs"]:
                if s[0] == "B":
                    _t, a, c1, c2, b = s
                    pts.append((*self.xy(a), 0))
                    for t in (0.25, 0.5, 0.75):
                        pts.append((*self.xy(_bez_at(a, c1, c2, b, t)), 0))
                else:
                    pts.append((*self.xy(s[1]), math.tan(s[3] / 4) if s[0] == "A" else 0))
            if len(pts) >= 2:
                h.paths.add_polyline_path(pts, is_closed=True)
                n += 1
        if not n:
            self.msp.delete_entity(h)
        else:
            self._count("hașuri")

    def add_text(self, txt, p, h_mm, ang, layer, rgb=None):
        if not txt.strip() or h_mm <= 0:
            return
        a = {"layer": layer, "style": "ISO", "insert": self.xy(p)}
        if rgb is not None and not _gray_dark(rgb):
            a["true_color"] = ezdxf.rgb2int(rgb)
        e = self.msp.add_text(txt, height=round(h_mm, 4), rotation=round(ang % 360, 4), dxfattribs=a)
        self._count("texte")
        return e

    # --- sources
    def add_pdf(self, content, text=True):
        for p in content["paths"]:
            if p["fill"] and not _whiteish(p["fc"]):
                closed_subs = [s for s in p["subs"] if len(s["segs"]) >= 2]
                if closed_subs:
                    self.add_hatch(closed_subs, self.attribs("PDF-UMPLERI", rgb=p["fc"]))
            if p["stroke"] and not _whiteish(p["sc"]):
                at = self.attribs("PDF-GEOMETRIE", p["w"], p["sc"], p["dash"])
                for s in p["subs"]:
                    self.add_segments(s["segs"], s["closed"], at)
        if text:
            for t in content["texts"]:
                if _whiteish(t["c"]):
                    continue
                self.add_text(t["txt"], t["p"], t["h"] * CAP_GENERIC * self.k, t["a"], "PDF-TEXT", t["c"])

    def add_prims(self, prims, color_mode="black"):
        """DrawCAD annotations (the same primitives as for the PDF export)."""
        covers = [p for p in prims if p.get("cover") or p.get("c") == "white"]
        rest = [p for p in prims if not (p.get("cover") or p.get("c") == "white")]
        for p in covers:
            if p.get("t") == "R":
                x0, y0, x1, y1 = p["p"]
                self.msp.add_wipeout([self.xy((x0, y0)), self.xy((x1, y1))], dxfattribs={"layer": "DRAWCAD-ACOPERIRI"})
                self._count("acoperiri")
        for p in rest:
            t = p.get("t")
            c = p.get("c", "add")
            layer = _annot_layer(c)
            rgb = None
            if c in COLOR_MARK:
                rgb = tuple(round(v * 255) for v in COLOR_MARK[c])
            elif isinstance(c, str) and re.match(r"^#[0-9a-fA-F]{6}$", c):
                rgb = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
            elif color_mode == "layers":
                rgb = (47, 111, 214) if c != "rev" else (198, 40, 40)
            w_pt = float(p.get("w", 0.7))
            wide = w_pt * PT_MM > MAX_LINEWEIGHT_MM
            at = self.attribs(layer, None if wide else w_pt, rgb, p.get("dp"))
            fat = self.attribs(layer, None, rgb)
            op = p.get("op")
            if isinstance(op, (int, float)) and 0 <= op < 1:
                # see-through like on the sheet (highlighter, watermark)
                at["transparency"] = fat["transparency"] = ezdxf.colors.float2transparency(1 - max(0.05, float(op)))
            if t == "L":
                x1, y1, x2, y2 = p["p"]
                self.msp.add_line(self.xy((x1, y1)), self.xy((x2, y2)), dxfattribs=at)
                self._count("linii")
            elif t in ("P", "R"):
                if t == "R":
                    x0, y0, x1, y1 = p["p"]
                    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
                    close, fill, stroke = True, True, False
                else:
                    q = p["p"]
                    pts = [(q[i], q[i + 1]) for i in range(0, len(q) - 1, 2)]
                    close, fill, stroke = bool(p.get("close")), bool(p.get("fill")), not p.get("nostroke")
                if len(pts) < 2:
                    continue
                if fill and len(pts) >= 3:
                    h = self.msp.add_hatch(color=7, dxfattribs=fat)
                    h.paths.add_polyline_path([self.xy(q) for q in pts], is_closed=True)
                    self._count("hașuri")
                if stroke:
                    pat = {**at, "const_width": round(w_pt * self.k, 4)} if wide else at
                    self.msp.add_lwpolyline([self.xy(q) for q in pts], format="xy", close=close, dxfattribs=pat)
                    self._count("polilinii")
            elif t == "C":
                cx, cy = p["p"]
                r = float(p.get("r", 1))
                if p.get("fill"):
                    h = self.msp.add_hatch(color=7, dxfattribs=fat)
                    x, y = self.xy((cx, cy))
                    rr = r * self.k
                    h.paths.add_polyline_path([(x - rr, y, 1), (x + rr, y, 1)], is_closed=True)
                    self._count("hașuri")
                if not (p.get("fill") and p.get("nostroke")):
                    self.msp.add_circle(self.xy((cx, cy)), r * self.k, dxfattribs=at)
                    self._count("cercuri")
            elif t == "T":
                s = float(p.get("s", 10))
                e = self.add_text(str(p.get("txt", "")), p["p"], s * CAP_OSIFONT * self.k, float(p.get("a", 0)), layer, rgb)
                if e is not None and "transparency" in at:
                    e.dxf.transparency = at["transparency"]

    def add_annot_image(self, filename, px_size, rect, rot=0, op=1.0):
        """An image placed in DrawCAD: IMAGE entity that references the file saved next to the DXF."""
        x0, y0, x1, y1 = rect
        w, h = abs(x1 - x0) * self.k, abs(y1 - y0) * self.k
        rot = int(rot or 0) % 360
        iw, ih = (h, w) if rot in (90, 270) else (w, h)
        cx, cy = self.xy(((x0 + x1) / 2, (y0 + y1) / 2))
        # quarter turns clockwise on the sheet; the insert point is the image's own lower left corner
        a = math.radians(-rot)
        ca, sa = math.cos(a), math.sin(a)
        ins = (cx + (-iw / 2) * ca - (-ih / 2) * sa, cy + (-iw / 2) * sa + (-ih / 2) * ca)
        idef = self.doc.add_image_def(filename=filename, size_in_pixel=px_size)
        img = self.msp.add_image(idef, insert=ins, size_in_units=(iw, ih), rotation=-rot, dxfattribs={"layer": "DRAWCAD-IMAGINI"})
        if op is not None and op < 1:
            img.dxf.fade = max(0, min(100, round((1 - op) * 100)))
        self._count("imagini")

    def add_ocr(self, lines, skew=None):
        for ln in lines:
            x0, y0, x1, y1 = ln["box"]
            vert = ln.get("rot") == 90
            cap = ln.get("cap") or ((x1 - x0) if vert else (y1 - y0)) * 0.8
            base = ln.get("base")
            if ln.get("org"):
                p = tuple(ln["org"])
                ang = float(ln.get("ang", 90 if vert else 0))
            elif vert:
                # text read bottom to top: the baseline is vertical, at the right of the box
                p = (base if base is not None else x1, y1)
                ang = 90
            else:
                p = (x0, base if base is not None else y1)
                ang = 0
            if skew:
                p = skew(p)
                ang += skew.deg
            self.add_text(ln["text"], p, cap * self.k, ang, "OCR-TEXT")

    def add_vectors(self, vec, skew=None):
        """Result of a scan vectorization (polylines with arcs, and circles)."""
        at = {"layer": "SCAN-VECTORI"}
        T = skew or (lambda q: q)
        for c in vec.get("circles", []):
            cx, cy, r = c
            self.msp.add_circle(self.xy(T((cx, cy))), r * self.k, dxfattribs=at)
            self._count("cercuri")
        for pl in vec.get("polys", []):
            pts = pl["pts"]
            bul = pl.get("bulges") or [0] * len(pts)
            if len(pts) < 2:
                continue
            if len(pts) == 2 and not bul[0]:
                self.msp.add_line(self.xy(T(pts[0])), self.xy(T(pts[1])), dxfattribs=at)
                self._count("linii")
                continue
            # bulges already come in the DXF sense (counter-clockwise angles with y up)
            v = [(*self.xy(T(q)), 0, 0, b) for q, b in zip(pts, bul)]
            self.msp.add_lwpolyline(v, format="xyseb", close=bool(pl.get("closed")), dxfattribs=at)
            self._count("polilinii")

    def add_image(self, filename, px_size, skew=None):
        W, H = self.W * self.k, self.H * self.k
        idef = self.doc.add_image_def(filename=filename, size_in_pixel=px_size)
        insert = (0.0, 0.0)
        rot = 0.0
        if skew:
            insert = self.xy(skew((0, self.H)))
            rot = skew.deg
        self.msp.add_image(idef, insert=insert, size_in_units=(W, H), rotation=rot, dxfattribs={"layer": "SCAN-IMAGINE"})

    def bytes(self) -> bytes:
        try:
            zoom.extents(self.msp)
        except Exception:  # noqa: BLE001
            pass
        s = io.StringIO()
        self.doc.write(s)
        return s.getvalue().encode("utf-8")


class Rotation:
    """The rotation that straightens a skewed scan (about the page center, visual coordinates)."""

    def __init__(self, deg, W, H):
        self.deg = deg
        self.cx, self.cy = W / 2, H / 2
        a = math.radians(deg)
        # counter-clockwise angle on screen (y down)
        self.c, self.s = math.cos(a), math.sin(a)

    def __call__(self, p):
        dx, dy = p[0] - self.cx, -(p[1] - self.cy)
        x = dx * self.c - dy * self.s
        y = dx * self.s + dy * self.c
        return (self.cx + x, self.cy - y)


__all__ = ["DxfPage", "page_content", "is_scan", "Rotation", "_wrap_pi"]


class DxfOnto(DxfPage):
    """DrawCAD annotations written into an existing drawing: a DXF or DWG opened in DrawCAD gets them
    on DrawCAD's layers, in the space its page shows (model space, or the paper-space layout), at the
    drawing's own units. `tf`: drawing → PDF points of the page ([a, b, c, d, e, f], uniform scale, as
    dxfin placed it); `H`: page height in points; `kp`: the page's resize in the editor."""

    def __init__(self, doc, space, tf, H: float, kp: float = 1.0):
        a, _b, _c, d, e, f = tf
        self.doc, self.msp = doc, space
        self.W, self.H = None, H
        self._a, self._d, self._e, self._f, self._kp = a, d, e, f, kp or 1.0
        self.k = 1 / (a * self._kp)
        if "ISO" not in doc.styles:
            doc.styles.add("ISO", font="isocpeur.ttf")
        for name, col in LAYERS.items():
            if name not in doc.layers:
                doc.layers.add(name, color=col)
        self._lt = {}
        self.counts = {}

    def xy(self, p):
        x, y = p[0] / self._kp, self.H - p[1] / self._kp
        return (round((x - self._e) / self._a, 6), round((y - self._f) / self._d, 6))

    def frame(self):
        pass
