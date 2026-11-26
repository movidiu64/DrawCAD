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

    def test_empty(self):
        with self.assertRaises(ValueError):
            dxfin.dxf_to_pdf(to_bytes(ezdxf.new("R2010")))

    def test_garbage(self):
        with self.assertRaises(Exception):
            dxfin.dxf_to_pdf(b"0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nabc\n")


if __name__ == "__main__":
    unittest.main()
