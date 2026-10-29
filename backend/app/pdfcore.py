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
FONT_PATH = os.environ.get(
    "COTARE_FONT",
    os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "fonts", "osifont.ttf"),
)
_font_registered = False

ATTACH_JSON = "cotare.json"
ATTACH_ORIGINAL = "cotare-original.pdf"

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
            if ATTACH_JSON in att and ATTACH_ORIGINAL in att:
                js = att[ATTACH_JSON].get_file().read_bytes()
                orig = att[ATTACH_ORIGINAL].get_file().read_bytes()
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


def render_png(pdf_bytes: bytes, page_index: int, scale: float, removals=None) -> bytes:
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


# ---------------------------------------------------------------- geometrie pentru snap


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
                            add((prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2, "m")
                            a = g.to_vis(*prev)
                            b = g.to_vis(*p)
                            if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > 0.25:
                                segs.append([round(a[0], 3), round(a[1], 3), round(b[0], 3), round(b[1], 3)])
                            prev = p
                            j += 1
                        else:  # Bézier: trei puncte, ultimul e capătul
                            end = P[min(j + 2, len(P) - 1)]
                            add(end[0], end[1], "e")
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
            return {"pts": pts, "segs": segs[:limit], "truncated": len(pts) > limit}
        finally:
            doc.close()


# ---------------------------------------------------------------- obiecte din zonă / ștergere


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
                }
                if typ == R.FPDF_PAGEOBJ_TEXT:
                    item["text"] = _text_of(obj, tp.raw)
                elif typ == R.FPDF_PAGEOBJ_PATH:
                    total = mat_mul(_obj_matrix(obj), parent_total)
                    poly = []
                    nseg = 0
                    for sp in _path_points(obj, total):
                        nseg += len(sp["pts"])
                        poly.append([[round(c, 2) for c in g.to_vis(*p)] for p in sp["pts"][:400]])
                    item["segments"] = nseg
                    item["poly"] = poly[:50]
                out.append(item)
            tp.close()
            page.close()
        finally:
            doc.close()
    return out


def _apply_removals_page(page: pdfium.PdfPage, ops: list[dict]) -> dict:
    """ops: [{"mode": "objects", "ids": [...]}, {"mode": "text"|"zone", "rect": [...]}]"""
    g = PageGeo.of(page)
    targets = {}
    report = {"removed": 0, "partial": 0}
    all_objs = list(_walk(page.raw))
    by_id = {oid: (obj, typ, pm, cont, nested) for oid, obj, typ, pm, cont, nested in all_objs}
    for op in ops:
        mode = op.get("mode")
        if mode == "objects":
            for oid in op.get("ids", []):
                if oid in by_id:
                    targets[oid] = by_id[oid]
        elif mode in ("text", "zone"):
            x0, y0, x1, y1 = op["rect"]
            rx0, rx1, ry0, ry1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
            for oid, (obj, typ, pm, cont, nested) in by_id.items():
                if typ == R.FPDF_PAGEOBJ_FORM:
                    continue
                if mode == "text" and typ != R.FPDF_PAGEOBJ_TEXT:
                    continue
                bb = _bbox_page_space(obj, pm)
                if bb is None:
                    continue
                vb = g.bbox_to_vis(*bb)
                if typ == R.FPDF_PAGEOBJ_TEXT:
                    cx, cy = (vb[0] + vb[2]) / 2, (vb[1] + vb[3]) / 2
                    hit = rx0 <= cx <= rx1 and ry0 <= cy <= ry1
                else:
                    hit = vb[0] >= rx0 and vb[2] <= rx1 and vb[1] >= ry0 and vb[3] <= ry1
                    if not hit and not (vb[2] < rx0 or vb[0] > rx1 or vb[3] < ry0 or vb[1] > ry1):
                        report["partial"] += 1
                if hit:
                    targets[oid] = (obj, typ, pm, cont, nested)
    # se șterg întâi cele mai adânci, ca indicii părinților să nu conteze
    for oid in sorted(targets, key=lambda s: -s.count(".")):
        obj, _typ, _pm, cont, nested = targets[oid]
        ok = R.FPDFFormObj_RemoveObject(cont, obj) if nested else R.FPDFPage_RemoveObject(page.raw, obj)
        if ok:
            R.FPDFPageObj_Destroy(obj)
            report["removed"] += 1
    if targets:
        R.FPDFPage_GenerateContent(page.raw)
    return report


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


def _color(key, mode):
    if key == "white":
        return (1, 1, 1)
    if mode == "layers" and key in COLOR_LAYERS:
        return COLOR_LAYERS[key]
    return (0, 0, 0)


def _overlay_pdf(page_specs, color_mode) -> bytes:
    """page_specs: listă de (PageGeo, mediabox, primitive). Un PDF reportlab cu câte o pagină
    pentru fiecare pagină țintă; conținutul e desenat direct în coordonatele PDF ale țintei."""
    _register_font()
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pageCompression=1)
    c.setCreator("Cotare")
    for g, mb, prims in page_specs:
        c.setPageSize((max(mb[2], 1), max(mb[3], 1)))
        c.setLineJoin(1)
        c.setLineCap(0)
        # acoperirile albe primele, ca să nu ascundă cotele noi
        ordered = sorted(prims, key=lambda p: 0 if p.get("c") == "white" else 1)
        for p in ordered:
            t = p.get("t")
            col = _color(p.get("c", "add"), color_mode)
            c.setStrokeColorRGB(*col)
            c.setFillColorRGB(*col)
            c.setLineWidth(float(p.get("w", 0.7)))
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
) -> tuple[bytes, dict]:
    base, reports = apply_removals(original, removals) if any(removals.values()) else (original, {})
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
