"""DXF → PDF (dxfin): pages, scales, the DrawCAD round trip. Run: python -m unittest discover -s tests."""
import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

import ezdxf  # noqa: E402
import pypdfium2 as pdfium  # noqa: E402

from app import dxfin  # noqa: E402

MM = 72 / 25.4


def make_doc(layout=False):
    """A small part in mm: outline, hole, centre lines, hatch, texts in SHX and TrueType styles, an ISO
    dimension; with `layout`, an A4 sheet showing it at 1:2 through a viewport."""
    doc = ezdxf.new("R2010", setup=True, units=4)
    doc.styles.add("ISO", font="isocp.shx")
    doc.styles.add("ROM", font="romans.shx")
    doc.styles.add("AR", font="arial.ttf")
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (200, 0), (200, 120), (0, 120)], close=True, dxfattribs={"lineweight": 50})
    msp.add_circle((60, 60), 25)
    msp.add_arc((150, 60), 30, 0, 180)
    msp.add_line((20, 60), (100, 60), dxfattribs={"linetype": "CENTER"})
    h = msp.add_hatch()
    h.paths.add_polyline_path([(130, 10), (190, 10), (190, 40), (130, 40)], is_closed=True)
    h.set_pattern_fill("ANSI31", color=1, scale=0.5)
    msp.add_text("ȘURUB Ø20 ț", height=5, dxfattribs={"style": "ISO"}).set_placement((10, 130))
    msp.add_text("romans", height=3.5, dxfattribs={"style": "ROM"}).set_placement((10, 140))
    msp.add_text("arial", height=3.5, dxfattribs={"style": "AR"}).set_placement((80, 140))
    dim = msp.add_linear_dim(base=(0, -15), p1=(0, 0), p2=(200, 0), dimstyle="EZDXF",
                             override={"dimtxt": 3.5, "dimasz": 3.5, "dimlfac": 1, "dimblk": "",
                                       "dimexe": 2, "dimexo": 1, "dimgap": 1})
    dim.render()
    if layout:
        lay = doc.layouts.new("Plansa 1")
        lay.page_setup(size=(297, 210), margins=(0, 0, 0, 0), units="mm")
        lay.add_viewport(center=(148.5, 105), size=(277, 190), view_center_point=(100, 50), view_height=380)
    return doc


def to_bytes(doc):
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode("utf-8")


def pdf_pages(data):
    pdf = pdfium.PdfDocument(data)
    out = [(p.get_width() / MM, p.get_height() / MM) for p in pdf]
    pdf.close()
    return out


def red(data, page=0):
    """Pixels drawn red: none, colors are plotted black (monochrome)."""
    pdf = pdfium.PdfDocument(data)
    img = pdf[page].render(scale=1).to_pil().convert("RGB")
    pdf.close()
    return sum(1 for r, g, b in img.get_flattened_data() if r > 180 and g < 80 and b < 80)


def ink(data, page=0):
    """Share of non-white pixels of a page render (something was drawn)."""
    pdf = pdfium.PdfDocument(data)
    img = pdf[page].render(scale=1).to_pil().convert("L")
    pdf.close()
    hist = img.histogram()
    return 1 - sum(hist[250:]) / sum(hist)


def make_shx() -> bytes:
    """A tiny SHX font ("AutoCAD-86 shapes 1.0"): only an "A", drawn as a hook of three strokes."""
    import struct

    shapes = [(0, b"TEST\x00" + bytes([8, 2, 0, 0])), (65, b"A\x00" + bytes([1, 0x84, 0x80, 0x8C, 0]))]
    head = b"AutoCAD-86 shapes 1.0\r\n\x1a" + struct.pack("<HHH", 0, 65, len(shapes))
    index = b"".join(struct.pack("<HH", n, len(d)) for n, d in shapes)
    return head + index + b"".join(d for _n, d in shapes) + b"EOF"


DWG = Path(__file__).parent / "fixtures" / "piesa_r2000.dwg"  # make_doc() saved as R2000 DWG by LibreDWG


class DwgTest(unittest.TestCase):
    @unittest.skipUnless(dxfin.dwg_exe(), "LibreDWG dwg2dxf not installed")
    def test_dwg_opens(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            dxf = dxfin.dwg_to_dxf(DWG.read_bytes(), d)
            self.assertEqual(list(Path(d).iterdir()), [])  # its temporary files are gone
        pdf, info = dxfin.dxf_to_pdf(dxf)
        self.assertEqual(info["pages"][0]["iso"], "A4")
        doc = pdfium.PdfDocument(pdf)
        txt = doc[0].get_textpage().get_text_range()
        doc.close()
        self.assertIn("ȘURUB Ø20", txt)  # R2000 code page and \U+ escapes come through

    @unittest.skipUnless(dxfin.dwg_exe(), "LibreDWG dwg2dxf not installed")
    def test_bad_dwg(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d, self.assertRaises(ValueError):
            dxfin.dwg_to_dxf(b"AC1032" + bytes(range(256)) * 40, d)

    def test_missing_converter(self):
        from app import ingest

        old = dxfin.dwg_exe
        dxfin.dwg_exe = lambda: None
        try:
            with self.assertRaises(ingest.Rejected) as cm:
                ingest.dwg_dxf(DWG.read_bytes(), ".")
            self.assertIn("LibreDWG", str(cm.exception))
        finally:
            dxfin.dwg_exe = old


def inventor_doc():
    """Like a DWG saved by Inventor once LibreDWG has read it: border and views in anonymous *I blocks
    that nothing references (Inventor's own block references are gone), an A3 layout whose viewports
    are only frames looking at an empty model space far away."""
    doc = ezdxf.new("R2018", units=4)
    from ezdxf.entities import DXFClass

    cls = DXFClass.new(doc=doc)
    cls.update_dxf_attribs({"name": "ACIDBLOCKREFERENCE", "cpp_class_name": "AcIdBlockReference",
                            "app_name": "AcIdViewObj | Product: Inventor Drawing Enabler", "flags": 1153,
                            "was_a_proxy": 0, "is_an_entity": 1})
    doc.classes.register(cls)
    border = doc.blocks.new("*I1")
    border.add_lwpolyline([(10, 10), (410, 10), (410, 287), (10, 287)], close=True)
    border.add_text("CAPAC", height=5).set_placement((300, 20))
    view = doc.blocks.new("PIESA_VIEW1")
    view.add_circle((0, 0), 40)
    view.add_circle((0, 0), 10)
    ref = doc.blocks.new("*I2")
    ref.add_blockref("PIESA_VIEW1", (0, 0))
    side = doc.blocks.new("*I3")
    side.add_lwpolyline([(-10, -40), (10, -40), (10, 40), (-10, 40)], close=True)
    lay = doc.layouts.new("Sheet")
    lay.page_setup(size=(420, 297), margins=(0, 0, 0, 0), units="mm")
    lay.add_viewport(center=(120, 150), size=(100, 100), view_center_point=(-10050, -10050), view_height=100)
    lay.add_viewport(center=(250, 150), size=(40, 100), view_center_point=(-10020, -10050), view_height=100)
    return doc


class InventorTest(unittest.TestCase):
    def test_views_placed_again(self):
        doc = inventor_doc()
        self.assertEqual(dxfin.rebuild_inventor(doc), 3)
        refs = {e.dxf.name: e for e in doc.layouts.get("Sheet").query("INSERT")}
        self.assertEqual(set(refs), {"*I1", "*I2", "*I3"})
        self.assertEqual(tuple(refs["*I1"].dxf.insert)[:2], (0, 0))
        self.assertEqual(tuple(refs["*I2"].dxf.insert)[:2], (120, 150))  # the round view in the square frame
        self.assertEqual(tuple(refs["*I3"].dxf.insert)[:2], (250, 150))  # the narrow one in the narrow frame
        self.assertEqual(dxfin.rebuild_inventor(doc), 0)  # once placed, not again (a reopened export)
        self.assertEqual(dxfin.rebuild_inventor(ezdxf.new()), 0)  # not an Inventor file: untouched

    def test_opens(self):
        pdf, info = dxfin.dxf_to_pdf(to_bytes(inventor_doc()))
        self.assertEqual(info["inventor"], 3)
        p = info["pages"][0]
        self.assertEqual((p["name"], p["sheet"]), ("Sheet", [420, 297]))
        self.assertIn(b"*I2", info["fixed_dxf"])  # the DXF kept for export has the views too
        self.assertGreater(ink(pdf), 0.005)


    def test_scale_two_to_one(self):
        """Views at 2:1 (the model window half the frame) are drawn at 2:1 and the page gets that scale, even
        with every viewport written with status 1 (as LibreDWG writes them)."""
        doc = inventor_doc()
        for v in doc.layouts.get("Sheet").query("VIEWPORT"):  # frames twice the model windows
            v.dxf.width *= 2
            v.dxf.height *= 2
            v.dxf.status = 1
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        self.assertEqual(info["pages"][0]["scale"], 0.5)
        refs = {e.dxf.name: e for e in dxfin.load(info["fixed_dxf"])[0].layouts.get("Sheet").query("INSERT")}
        self.assertEqual(refs["*I2"].dxf.xscale, 2)

    def test_older_copy_left_out(self):
        """An older copy of the border / title block (same lines, other texts) is not drawn over the current one."""
        doc = inventor_doc()
        old = doc.blocks.new("*I0")
        old.add_lwpolyline([(10, 10), (410, 10), (410, 287), (10, 287)], close=True)
        old.add_text("VECHI", height=5).set_placement((300, 20))
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        self.assertEqual(info["inventor"], 3)
        d = pdfium.PdfDocument(pdf)
        txt = d[0].get_textpage().get_text_range()
        d.close()
        self.assertIn("CAPAC", txt)
        self.assertNotIn("VECHI", txt)

    def test_two_sheets(self):
        """Two sheets: each gets its own border and the blocks that came after it."""
        doc = inventor_doc()
        b2 = doc.blocks.new("*I4")
        b2.add_lwpolyline([(10, 10), (410, 10), (410, 287), (10, 287)], close=True)
        b2.add_text("FOAIA 2", height=5).set_placement((300, 20))
        doc.blocks.new("*I5").add_text("NOTA 2", height=3.5).set_placement((30, 250))
        doc.blocks.new("*I6").add_circle((0, 0), 30)
        lay2 = doc.layouts.new("Sheet2")
        lay2.page_setup(size=(420, 297), margins=(0, 0, 0, 0), units="mm")
        lay2.add_viewport(center=(200, 150), size=(80, 80), view_center_point=(-20000, 0), view_height=80)
        self.assertEqual(dxfin.rebuild_inventor(doc), 6)
        names = lambda n: {e.dxf.name for e in doc.layouts.get(n).query("INSERT")}  # noqa: E731
        self.assertEqual(names("Sheet"), {"*I1", "*I2", "*I3"})
        self.assertEqual(names("Sheet2"), {"*I4", "*I5", "*I6"})


class SheetFrameTest(unittest.TestCase):
    """Drawings that bring their sheet in model space (SolidWorks, Solid Edge…): that sheet is the page."""

    def frame_doc(self, w, h, text_h, lines=True, stray=True):
        doc = ezdxf.new("R2010", units=4)
        msp = doc.modelspace()
        if lines:
            for a, b in (((0, 0), (w, 0)), ((w, 0), (w, h)), ((w, h), (0, h)), ((0, h), (0, 0))):
                msp.add_line(a, b)
        else:
            msp.add_lwpolyline([(0, 0), (w, 0), (w, h), (0, h)], close=True)
        msp.add_circle((w / 2, h / 2), w / 8)
        for k in range(5):
            msp.add_text("INDICATOR", height=text_h).set_placement((w * 0.6, h * 0.05 + k * 2 * text_h))
        if stray:
            msp.add_text("în afara foii", height=text_h).set_placement((w * 0.2, -3 * text_h))  # a stray below
        return doc

    def page(self, doc):
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        (w, h), = pdf_pages(pdf)
        return info["pages"][0], round(w), round(h)

    def test_solidworks_half_sheet(self):
        """A4 exported at half size around a 2:1 drawing (A6-sized frame, 1.25 mm texts): A4 at 2:1."""
        p, w, h = self.page(self.frame_doc(105, 148.5, 1.25))
        self.assertEqual((p["iso"], p["scale"], p["frame"], w, h), ("A4", 0.5, True, 210, 297))

    def test_full_size_sheet(self):
        p, w, h = self.page(self.frame_doc(420, 297, 3.5, lines=False))
        self.assertEqual((p["iso"], p["scale"], w, h), ("A3", 1.0, 420, 297))

    def test_frame_inside_margins(self):
        """Only the border inside the sheet's margins (ISO 5457: 20 mm left, 10 mm elsewhere): the A3
        sheet around it, the border where it belongs."""
        doc = self.frame_doc(390, 277, 3.5, stray=False)
        p, w, h = self.page(doc)
        self.assertEqual((p["iso"], p["scale"], p["frame"], w, h), ("A3", 1.0, True, 420, 297))
        a, _b, _c, d, e, f = p["tf"]
        self.assertAlmostEqual(e / a, 20 * MM / a, 3)  # the border's left edge 20 mm from the sheet's
        self.assertAlmostEqual(f / d, 10 * MM / d, 3)

    def test_sheet_corners(self):
        """The drawing's extents are an A4 sheet (its corners drawn), the border inside: A4, edge to edge."""
        doc = self.frame_doc(190, 277, 1.8, stray=False)
        msp = doc.modelspace()
        for e in msp:
            e.translate(10, 10, 0)
        msp.add_point((0, 0))
        msp.add_point((210, 297))
        p, w, h = self.page(doc)
        self.assertEqual((p["iso"], p["scale"], w, h), ("A4", 1.0, 210, 297))

    def test_no_frame(self):
        """No frame: fitted as before, with a margin."""
        doc = ezdxf.new("R2010", units=4)
        doc.modelspace().add_circle((0, 0), 50)
        doc.modelspace().add_text("Ø100", height=3.5).set_placement((0, 60))
        p, w, h = self.page(doc)
        self.assertNotIn("frame", p)
        self.assertEqual((p["iso"], w, h), ("A4", 297, 210))


class FitSheetTest(unittest.TestCase):
    def test_choice(self):
        self.assertEqual(dxfin.fit_sheet(220, 175)[0::3], ("A4", 1))
        self.assertEqual(dxfin.fit_sheet(20, 10)[0::3], ("A4", 10))
        self.assertEqual(dxfin.fit_sheet(3000, 1500)[0::3], ("A1", 1 / 5))
        # portrait part → portrait sheet
        name, w, h, sc = dxfin.fit_sheet(170, 260)
        self.assertEqual((name, w < h, sc), ("A4", True, 1))
        # beyond A0 at 1:1000: still a page
        self.assertEqual(dxfin.fit_sheet(2e6, 1e6)[0], "A0")


class DxfToPdfTest(unittest.TestCase):
    def test_model_space(self):
        pdf, info = dxfin.dxf_to_pdf(to_bytes(make_doc()))
        self.assertEqual(len(info["pages"]), 1)
        p = info["pages"][0]
        self.assertEqual((p["space"], p["iso"], p["scale"]), ("model", "A4", 1.0))
        (w, h), = pdf_pages(pdf)
        self.assertAlmostEqual(w, 297, 0)
        self.assertAlmostEqual(h, 210, 0)
        self.assertGreater(ink(pdf), 0.01)
        self.assertEqual(red(pdf), 0)

    def test_layout_with_viewport(self):
        pdf, info = dxfin.dxf_to_pdf(to_bytes(make_doc(layout=True)))
        p = info["pages"][0]
        self.assertEqual((p["name"], p["space"]), ("Plansa 1", "paper"))
        self.assertAlmostEqual(p["scale"], 2.0, 3)
        self.assertEqual(p["sheet"], [297, 210])
        self.assertGreater(ink(pdf), 0.005)

    def test_vector_geometry(self):
        """Lines come out as PDF paths (DrawCAD snaps on them), the 200 mm edge at 200 mm on paper."""
        pdf, _ = dxfin.dxf_to_pdf(to_bytes(make_doc()))
        doc = pdfium.PdfDocument(pdf)
        page = doc[0]
        kinds = [o.type for o in page.get_objects(max_depth=4)]
        doc.close()
        self.assertIn(pdfium.raw.FPDF_PAGEOBJ_PATH, kinds)
        self.assertNotIn(pdfium.raw.FPDF_PAGEOBJ_IMAGE, kinds)

    def test_texts_are_text(self):
        """Texts in SHX fonts (drawn in osifont) are PDF text: searchable, no glyph outlines to snap on;
        the dimension value too, also through a viewport."""
        from app import pdfcore

        for lay in (False, True):
            pdf, _ = dxfin.dxf_to_pdf(to_bytes(make_doc(layout=lay)))
            doc = pdfium.PdfDocument(pdf)
            txt = doc[0].get_textpage().get_text_range()
            doc.close()
            for s in ("ȘURUB Ø20", "romans", "200"):
                self.assertIn(s, txt)
            snap = pdfcore.snap_points(pdf, 0)
            self.assertLessEqual(len(snap["arcs"]), 4)  # the circle and the arc, not letters

    def test_truetype_text(self):
        """A text in a TrueType font found on this machine is PDF text in that font (embedded), not outlines."""
        from ezdxf.fonts import fonts

        if not fonts.font_manager.has_font("DejaVuSans.ttf"):
            self.skipTest("DejaVu Sans not installed")
        doc = ezdxf.new("R2010", units=4)
        doc.styles.add("DV", font="DejaVuSans.ttf")
        doc.modelspace().add_text("Indicator ȘĂ Ø20", height=5, dxfattribs={"style": "DV"}).set_placement((0, 0))
        doc.modelspace().add_line((0, -5), (100, -5))
        pdf, _ = dxfin.dxf_to_pdf(to_bytes(doc))
        d = pdfium.PdfDocument(pdf)
        self.assertIn("Indicator ȘĂ Ø20", d[0].get_textpage().get_text_range())
        d.close()
        self.assertIn(b"DejaVuSans", pdf)

    def test_colors(self):
        """Colors: black by default (monochrome plot), the drawing's own on request, same objects."""
        data = to_bytes(make_doc())
        mono, _ = dxfin.dxf_to_pdf(data)
        color, _ = dxfin.dxf_to_pdf(data, colors=True)
        self.assertEqual(red(mono), 0)
        self.assertGreater(red(color), 50)
        counts = []
        for b in (mono, color):
            d = pdfium.PdfDocument(b)
            counts.append(pdfium.raw.FPDFPage_CountObjects(d[0].raw))
            d.close()
        self.assertEqual(counts[0], counts[1])

    def test_binary_dxf(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "b.dxf"
            make_doc().saveas(f, fmt="bin")
            pdf, info = dxfin.dxf_to_pdf(f.read_bytes())
        self.assertEqual(info["pages"][0]["iso"], "A4")

    def test_inches(self):
        doc = ezdxf.new("R2010", units=1)
        doc.modelspace().add_lwpolyline([(0, 0), (12, 0), (12, 8), (0, 8)], close=True)  # 305 × 203 mm
        _, info = dxfin.dxf_to_pdf(to_bytes(doc))
        p = info["pages"][0]
        self.assertEqual((p["iso"], p["scale"]), ("A3", 1.0))
        self.assertEqual(info["units_mm"], 25.4)

    def test_set_units(self):
        """A drawing made from an inch template but drawn in mm, read again in mm: ASCII (header value
        replaced or added) and binary DXF; nothing else changes."""
        import tempfile

        doc = ezdxf.new("R2010", units=1)
        doc.modelspace().add_lwpolyline([(0, 0), (250, 0), (250, 150), (0, 150)], close=True)
        data = to_bytes(doc)
        _, info = dxfin.dxf_to_pdf(data)
        self.assertEqual((info["insunits"], info["units_mm"]), (1, 25.4))
        mm = dxfin.set_insunits(data, 4)
        self.assertEqual(len(mm.splitlines()), len(data.splitlines()))
        _, info = dxfin.dxf_to_pdf(mm)
        self.assertEqual((info["insunits"], info["units_mm"], info["pages"][0]["iso"], info["pages"][0]["scale"]), (4, 1.0, "A4", 1.0))
        no_var = data.replace(b"  9\n$INSUNITS\n 70\n1\n", b"")
        self.assertFalse(b"$INSUNITS" in no_var)
        self.assertEqual(dxfin.dxf_to_pdf(dxfin.set_insunits(no_var, 4))[1]["units_mm"], 1.0)
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "b.dxf"
            doc.saveas(f, fmt="bin")
            binary = dxfin.set_insunits(f.read_bytes(), 4)
        self.assertTrue(binary.startswith(b"AutoCAD Binary DXF"))
        self.assertEqual(dxfin.dxf_to_pdf(binary)[1]["units_mm"], 1.0)

    def test_not_drawn(self):
        """ACIS solids and 3D layout views are counted (the opening message says they are not drawn)."""
        doc = make_doc(layout=True)
        doc.modelspace().add_3dsolid().sat = ["700 0 1 0", "@4 test @12 ACIS 7.0 NT @24 Thu Nov 26 12:00:00 2026",
                                              "1 9.9999999999999995e-07 1e-10", "End-of-ACIS-data"]
        lay = doc.layouts.get("Plansa 1")
        vp = lay.add_viewport(center=(60, 60), size=(80, 60), view_center_point=(0, 0), view_height=100)
        vp.dxf.view_direction_vector = (1, -1, 1)
        _, info = dxfin.dxf_to_pdf(to_bytes(doc))
        self.assertEqual((info["acis"], info["views_3d"]), (1, 1))

    def test_drawcad_round_trip(self):
        """A DXF exported by DrawCAD opens on its own page: same sheet, same scale."""
        from app.dxfout import DxfPage

        W, H = 420 * MM, 297 * MM
        out = DxfPage(W, H, scale=2)
        out.frame()
        out.msp.add_circle(out.xy((W / 2, H / 2)), 100)
        pdf, info = dxfin.dxf_to_pdf(out.bytes())
        p = info["pages"][0]
        self.assertEqual((p["sheet"], p["scale"]), ([420, 297], 2))
        (w, h), = pdf_pages(pdf)
        self.assertAlmostEqual(w, 420, 0)
        self.assertAlmostEqual(h, 297, 0)
        self.assertIsNone(dxfin.drawcad_page(ezdxf.new()))

    def test_viewports_written_off(self):
        """Viewports as LibreDWG writes them (id 0, status 0) still show the view."""
        doc = make_doc(layout=True)
        for v in doc.layouts.get("Plansa 1").query("VIEWPORT"):
            v.dxf.id = 0
            v.dxf.status = 0
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        self.assertEqual(info["pages"][0]["space"], "paper")
        self.assertGreater(ink(pdf), 0.005)

    def test_null_dictionary_entry(self):
        """A root dictionary entry pointing to handle 0 (LibreDWG, R2000 / R2004) is left out; a text
        whose value is "3" followed by a height of 350 is kept as it is."""
        doc = make_doc()
        doc.modelspace().add_text("3", height=350).set_placement((0, -500))
        data = to_bytes(doc).replace(b"  3\nACAD_COLOR\n", b"  3\n\n350\n0\n  3\nACAD_COLOR\n", 1)
        data = data.replace(b"\n", b"\r\n")  # as dwg2dxf writes it
        pdf, info = dxfin.dxf_to_pdf(data)
        self.assertGreater(ink(pdf), 0.005)
        clean = to_bytes(doc)
        self.assertEqual(dxfin._drop_null_entries(clean), clean)

    def test_degenerate_lines(self):
        """Zero-length lines and points (dots on paper): the handle map still matches the PDF objects."""
        doc = make_doc()
        msp = doc.modelspace()
        msp.add_line((50, 50), (50, 50))
        msp.add_point((70, 70))
        msp.add_lwpolyline([(10, 10), (10, 10)])
        _, info = dxfin.dxf_to_pdf(to_bytes(doc))
        self.assertIsNotNone(info["handles"][0])

    def test_family_only_styles(self):
        """Styles that name only a font family (Inventor: the file name empty, the family in XDATA) are
        drawn in osifont, not a generic sans-serif, and listed as missing; the GD&T font's letters
        become the symbols (n → Ø)."""
        doc = ezdxf.new("R2010", units=4)
        for name, fam in (("ISO$0", "ISOCPEUR"), ("GDT$0", "AIGDT")):
            doc.styles.add(name, font="").set_extended_font_data(fam)
        msp = doc.modelspace()
        msp.add_text("Bohrung 20", height=3.5, dxfattribs={"style": "ISO$0"}).set_placement((0, 0))
        msp.add_text("n", height=3.5, dxfattribs={"style": "GDT$0"}).set_placement((0, 10))
        msp.add_text("6", height=3.5, dxfattribs={"style": "ISO$0"}).set_placement((3, 10))
        msp.add_line((0, -5), (100, -5))
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        self.assertEqual(info["fonts_missing"], ["ISOCPEUR", "AIGDT"])
        self.assertTrue(info["gdt_symbols"])
        d = pdfium.PdfDocument(pdf)
        txt = d[0].get_textpage().get_text_range()
        d.close()
        self.assertIn("Bohrung 20", txt)
        self.assertIn("Ø", txt)
        self.assertNotIn("n", txt.replace("Bohrung", ""))  # the letter became the symbol
        self.assertNotIn(b"DejaVu", pdf)
        self.assertNotIn(b"Liberation", pdf)

    def test_mtext_gdt(self):
        """An MTEXT switching to the GD&T font (\\Fgdt;) and to a missing family: symbols, osifont."""
        doc = ezdxf.new("R2010", units=4)
        msp = doc.modelspace()
        msp.add_mtext("{\\Fgdt;j}0,1 A {\\FISOCPEUR|b0|i0;Text}", dxfattribs={"char_height": 3.5}).set_location((0, 20))
        msp.add_line((0, 0), (100, 0))
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        d = pdfium.PdfDocument(pdf)
        txt = d[0].get_textpage().get_text_range()
        d.close()
        self.assertIn("\u2316", txt)  # position
        self.assertIn("0,1", txt)
        self.assertIn("ISOCPEUR", info["fonts_missing"])
        self.assertNotIn(b"Liberation", pdf)

    def test_added_font(self):
        """A font the user added (a folder in DRAWCAD_FONTS) is used: a GD&T font present here keeps
        its letters, and it is not reported missing."""
        import os
        import shutil
        import tempfile

        from app import pdfcore

        with tempfile.TemporaryDirectory() as d:
            shutil.copy(pdfcore.FONT_PATH, Path(d) / "amgdt.ttf")
            (Path(d) / "drawcadt.shx").write_bytes(make_shx())
            old = os.environ.get("DRAWCAD_FONTS")
            os.environ["DRAWCAD_FONTS"] = d
            dxfin._FONTS_READY = False
            try:
                doc = ezdxf.new("R2010", units=4)
                doc.styles.add("G", font="amgdt.ttf")
                doc.styles.add("S", font="drawcadt.shx")
                doc.modelspace().add_text("n", height=3.5, dxfattribs={"style": "G"}).set_placement((0, 0))
                doc.modelspace().add_text("A", height=3.5, dxfattribs={"style": "S"}).set_placement((20, 0))
                doc.modelspace().add_line((0, -5), (100, -5))
                pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
            finally:
                if old is None:
                    os.environ.pop("DRAWCAD_FONTS", None)
                else:
                    os.environ["DRAWCAD_FONTS"] = old
                dxfin._FONTS_READY = False
        d = pdfium.PdfDocument(pdf)
        txt = d[0].get_textpage().get_text_range()
        d.close()
        self.assertEqual(info["fonts_missing"], [])
        self.assertFalse(info["gdt_symbols"])
        self.assertIn("n", txt)
        self.assertNotIn("A", txt)  # drawn by the SHX font: strokes, not PDF text

    def test_canvas_generators(self):
        """The backend gets generators from ezdxf: an empty one draws nothing (no empty path for PDFium
        to drop, the entity map stays aligned); every filled path is drawn, the first one too."""
        from ezdxf.addons.drawing.properties import BackendProperties
        from ezdxf.path import from_vertices
        from reportlab.pdfgen import canvas as rl

        buf = io.BytesIO()
        c = rl.Canvas(buf, pagesize=(200, 200))
        cv = dxfin._Canvas(c, 200, 200)
        props = BackendProperties(handle="A1")
        cv.draw_solid_lines(iter([]), props)
        squares = [from_vertices([(x, 10), (x + 20, 10), (x + 20, 30), (x, 30)], close=True) for x in (10, 100)]
        cv.draw_filled_paths(iter(squares), props)
        c.showPage()
        c.save()
        self.assertEqual(cv.handles, ["A1"])
        d = pdfium.PdfDocument(buf.getvalue())
        objs = list(d[0].get_objects())
        self.assertEqual(len(objs), 1)
        left, _b, right, _t = objs[0].get_bounds()
        d.close()
        self.assertLess(left, 15)  # the first square is there
        self.assertGreater(right, 115)

    def test_empty(self):
        with self.assertRaises(ValueError):
            dxfin.dxf_to_pdf(to_bytes(ezdxf.new("R2010")))

    def test_garbage(self):
        with self.assertRaises(Exception):
            dxfin.dxf_to_pdf(b"0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nabc\n")


if __name__ == "__main__":
    unittest.main()
