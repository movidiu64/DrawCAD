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
    """Pixels drawn red (the hatch, ACI 1): colors come through."""
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
        self.assertGreater(red(pdf), 50)

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
        """A DXF exported by DrawCAD opens on its own page: the PAGINA frame on the sheet edge."""
        doc = ezdxf.new("R2010", units=4)
        msp = doc.modelspace()
        doc.layers.add("PAGINA")
        msp.add_lwpolyline([(0, 0), (840, 0), (840, 594), (0, 594)], close=True, dxfattribs={"layer": "PAGINA"})
        msp.add_circle((420, 297), 100)
        for k, v in (("DRAWCAD_SHEET_W", "420"), ("DRAWCAD_SHEET_H", "297"), ("DRAWCAD_SCALE", "2")):
            doc.header.custom_vars.append(k, v)
        pdf, info = dxfin.dxf_to_pdf(to_bytes(doc))
        p = info["pages"][0]
        self.assertEqual((p["sheet"], p["scale"]), ([420, 297], 2))
        self.assertEqual(dxfin.drawcad_page(ezdxf.new()), None)
        (w, h), = pdf_pages(pdf)
        self.assertAlmostEqual(w, 420, 0)

    def test_empty(self):
        with self.assertRaises(ValueError):
            dxfin.dxf_to_pdf(to_bytes(ezdxf.new("R2010")))

    def test_garbage(self):
        with self.assertRaises(Exception):
            dxfin.dxf_to_pdf(b"0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nabc\n")


if __name__ == "__main__":
    unittest.main()
