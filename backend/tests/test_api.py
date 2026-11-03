"""End-to-end API tests. Run: python -m unittest discover -s tests (from backend/)."""
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TMP = tempfile.mkdtemp(prefix="drawcad-test-")
os.environ["DRAWCAD_DATA"] = TMP
os.environ.setdefault("DRAWCAD_MODE", "personal")  # the general tests use a single space
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tools"))

import uvicorn  # noqa: E402

import make_sample  # noqa: E402
from app import pdfcore  # noqa: E402
from app.main import app  # noqa: E402

MM = 72 / 25.4


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cfg = uvicorn.Config(app, host="127.0.0.1", port=cls.port, log_level="warning")
        cls.server = uvicorn.Server(cfg)
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        for _ in range(100):
            if cls.server.started:
                break
            time.sleep(0.05)
        cls.sample = Path(TMP) / "sample.pdf"
        make_sample.build(str(cls.sample))

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=5)

    def req(self, method, path, data=None, headers=None, raw=False):
        url = f"http://127.0.0.1:{self.port}{path}"
        body = data
        h = dict(headers or {})
        if isinstance(data, (dict, list)):
            body = json.dumps(data).encode()
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(url, data=body, method=method, headers=h)
        with urllib.request.urlopen(r) as resp:
            content = resp.read()
            return (content, resp.headers) if raw else json.loads(content)

    def open_sample(self):
        return self.req("POST", "/api/open", self.sample.read_bytes(), {"X-Filename": "arbore.pdf"})

    def test_open_render_snap(self):
        meta = self.open_sample()
        self.assertEqual(len(meta["pages"]), 2)
        self.assertEqual(meta["pages"][1]["rot"], 90)
        png, h = self.req("GET", f"/api/doc/{meta['id']}/page/0/render?scale=1", raw=True)
        self.assertTrue(png.startswith(b"\x89PNG"))
        snap = self.req("GET", f"/api/doc/{meta['id']}/page/0/snap")
        # outline corner at (90, 75) mm
        self.assertTrue(any(abs(p[0] - 90 * MM) < 0.05 and abs(p[1] - 75 * MM) < 0.05 for p in snap["pts"]))
        # center of the circle in the side view
        self.assertTrue(any(p[2] == "c" and abs(p[0] - 240 * MM) < 0.1 for p in snap["pts"]))

    def test_objects_and_export_roundtrip(self):
        meta = self.open_sample()
        doc = meta["id"]
        objs = self.req("POST", f"/api/doc/{doc}/page/0/objects", {"rect": [160 * MM, 78 * MM, 167.5 * MM, 112 * MM]})
        texts = [o for o in objs["objects"] if o["type"] == "text"]
        self.assertEqual([t["text"] for t in texts], ["Ø30"])
        ids = [o["id"] for o in objs["objects"] if o["inside"]]
        state = {"v": 1, "annots": [{"id": "a1", "type": "text"}]}
        prims = {"0": [{"t": "T", "p": [100, 100], "s": 12, "a": 0, "txt": "Ø25 k6 ±", "c": "add"}]}
        pdf, h = self.req(
            "POST",
            f"/api/doc/{doc}/export",
            {"filename": "arbore_rev1.pdf", "pages": prims, "removals": {"0": [{"mode": "objects", "ids": ids}]},
             "state": state, "embed": True, "colorMode": "black"},
            raw=True,
        )
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertIn("arbore_rev1.pdf", h["Content-Disposition"])
        rep = json.loads(h["X-Removal-Report"])
        self.assertEqual(rep["0"]["removed"], len(ids))
        # reopening the export: the original and the state are recovered
        meta2 = self.req("POST", "/api/open", pdf, {"X-Filename": "arbore_rev1.pdf"})
        self.assertTrue(meta2["fromExport"])
        self.assertEqual(meta2["state"], state)
        orig = (Path(TMP) / "docs" / meta2["id"] / "original.pdf").read_bytes()
        self.assertEqual(orig, self.sample.read_bytes())
        # the text Ø30 is gone from the export, the new one appears
        import pypdfium2 as pdfium
        d = pdfium.PdfDocument(pdf)
        txt = d[0].get_textpage().get_text_range()
        self.assertNotIn("Ø30", txt)
        self.assertIn("Ø25 k6", txt)

    def test_zone_cuts_lines_at_border(self):
        import ctypes

        import pypdfium2 as pdfium
        import pypdfium2.raw as R

        src = self.sample.read_bytes()
        # the zone crosses the top outline (y = 110) and the end of the Ø30 dimension (x = 165)
        rect = [160 * MM, 105 * MM, 170 * MM, 113 * MM]
        x0, y0, x1, y1 = rect
        pdf, rep = pdfcore.apply_removals(src, {0: [{"mode": "zone", "rect": rect}]})
        self.assertGreaterEqual(rep[0]["cut"], 2)  # the outline + the dimension line
        d = pdfium.PdfDocument(pdf)
        page = d[0]
        g = pdfcore.PageGeo.of(page)
        corner_kept = False
        eps = 0.3 * MM
        for oid, obj, typ, pm, _c, nested in pdfcore._walk(page.raw):
            if typ != R.FPDF_PAGEOBJ_PATH or nested:
                continue
            fill, stroke = ctypes.c_int(), ctypes.c_int()
            R.FPDFPath_GetDrawMode(obj, ctypes.byref(fill), ctypes.byref(stroke))
            if fill.value:
                continue  # filled arrows remain (only covered)
            total = pdfcore.mat_mul(pdfcore._obj_matrix(obj), pm)
            for sp in pdfcore._path_points(obj, total):
                vis = [g.to_vis(*q) for q in sp["pts"]]
                for (ax, ay), (bx, by) in zip(vis, vis[1:]):
                    mx, my = (ax + bx) / 2, (ay + by) / 2
                    inside = x0 + eps < mx < x1 - eps and y0 + eps < my < y1 - eps
                    self.assertFalse(inside, f"segment left in the zone: {oid} {(ax, ay)}–{(bx, by)}")
                if any(abs(px - 180 * MM) < 0.05 and abs(py - 80 * MM) < 0.05 for px, py in vis):
                    corner_kept = True
        self.assertTrue(corner_kept, "the rest of the outline must remain")
        # the title block (Form XObject) is not modified: its objects show up as locked
        objs = pdfcore.objects_in_rect(src, 0, [240 * MM, 180 * MM, 260 * MM, 195 * MM])
        self.assertTrue(objs and all(o["locked"] for o in objs))
        _pdf, rep2 = pdfcore.apply_removals(src, {0: [{"mode": "zone", "rect": [240 * MM, 180 * MM, 260 * MM, 195 * MM]}]})
        self.assertEqual(rep2[0]["removed"] + rep2[0]["cut"], 0)
        self.assertGreater(rep2[0]["locked"], 0)

    def test_snap_arcs(self):
        d = pdfcore.snap_points(self.sample.read_bytes(), 0)
        arcs = [[round(v / MM, 2) for v in a[:3]] + [round(a[4] * 180 / 3.141592653589793, 1)] for a in d["arcs"]]
        # the Ø40 circle of the side view and the R5 fillets of the plate (quarter circles, clockwise on screen)
        self.assertIn([240.0, 95.0, 20.0, 360.0], arcs)
        self.assertIn([165.0, 155.0, 5.0, -90.0], arcs)
        self.assertIn([125.0, 155.0, 5.0, -90.0], arcs)
        # the fillet center becomes a snap point
        self.assertTrue(any(abs(p[0] - 165 * MM) < 0.05 and abs(p[1] - 155 * MM) < 0.05 and p[2] == "c" for p in d["pts"]))

    def test_ink_for_print(self):
        """Colored lines and text become black; white stays; blocks and images on request."""
        import pypdfium2 as pdfium
        from PIL import Image
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(400, 300))
        c.setStrokeColorRGB(0.55, 0.95, 0.55)
        c.setLineWidth(3)
        c.line(20, 250, 380, 250)
        c.setFillColorRGB(0.95, 0.9, 0.2)
        c.setFont("Helvetica-Bold", 40)
        c.drawString(20, 190, "IIII")
        c.setFillColorRGB(0.7, 1, 0.7)
        c.rect(20, 120, 100, 50, stroke=0, fill=1)
        c.setFillColorRGB(1, 1, 1)
        c.rect(60, 130, 20, 20, stroke=0, fill=1)
        c.beginForm("blk")
        c.setStrokeColorCMYK(0.4, 0, 0.4, 0)
        c.setLineWidth(3)
        c.line(200, 150, 380, 150)
        c.endForm()
        c.doForm("blk")
        im = Image.new("RGB", (60, 40), (255, 255, 255))
        for x in range(60):
            for y in range(18, 22):
                im.putpixel((x, y), (150, 240, 150))
        c.drawImage(ImageReader(im), 200, 30, 120, 80)
        c.showPage()
        c.save()
        src = buf.getvalue()

        def px(pdf, x, y):
            img = pdfium.PdfDocument(pdf)[0].render(scale=1).to_pil().convert("RGB")
            return img.getpixel((x, 300 - y))

        out = pdfcore.ink_pdf(src, None, "black", True)
        self.assertEqual(px(out, 100, 250), (0, 0, 0))  # line
        self.assertEqual(px(out, 300, 150), (0, 0, 0))  # a line in a block (Form XObject)
        self.assertEqual(px(out, 40, 160), (0, 0, 0))  # colored fill → black
        self.assertEqual(px(out, 70, 140), (255, 255, 255))  # white stays
        self.assertEqual(px(out, 260, 70), (0, 0, 0))  # the green line in the image
        self.assertEqual(px(out, 260, 100), (255, 255, 255))  # the image background
        keep = pdfcore.ink_pdf(src, None, "keep", False)
        self.assertNotEqual(px(keep, 40, 160), (0, 0, 0))  # the fill stays colored
        self.assertNotEqual(px(keep, 260, 70), (0, 0, 0))  # image unchanged
        text_dark = min(sum(px(keep, x, 200)) for x in range(22, 60))
        self.assertLess(text_dark, 60)  # text all black
        # a single object: only the top line (the first object on the page)
        objs = pdfcore.objects_in_rect(src, 0, [50, 40, 150, 60])
        ids = [o["id"] for o in objs if o["type"] == "path"]
        one, rep = pdfcore.apply_removals(src, {0: [{"mode": "black", "ids": ids}]})
        self.assertEqual(rep[0]["black"], 1)
        self.assertEqual(px(one, 100, 250), (0, 0, 0))
        self.assertNotEqual(px(one, 300, 150), (0, 0, 0))

    def test_legacy_attachment_names(self):
        """PDFs exported before the rename (cotare.* attachments) are reopened."""
        import pikepdf

        pk = pikepdf.open(self.sample)
        pk.attachments["cotare.json"] = pikepdf.AttachedFileSpec(pk, b'{"v":1,"annots":[]}', mime_type="application/json")
        pk.attachments["cotare-original.pdf"] = pikepdf.AttachedFileSpec(pk, self.sample.read_bytes(), mime_type="application/pdf")
        b = io.BytesIO()
        pk.save(b)
        got = pdfcore.extract_embedded(b.getvalue())
        self.assertIsNotNone(got)
        self.assertEqual(got[0], self.sample.read_bytes())

    def test_fraction_inside(self):
        # the zone catches 95% of the Ø30 dimension line (x = 165, y 80…110) and only the end of the outline
        objs = pdfcore.objects_in_rect(self.sample.read_bytes(), 0, [160 * MM, 81.5 * MM, 168 * MM, 113 * MM])
        fr = sorted(round(o["frac"], 2) for o in objs if o["type"] == "path" and not o["inside"])
        self.assertTrue(any(abs(f - 0.95) < 0.01 for f in fr), fr)
        self.assertTrue(all(o["frac"] == 1.0 for o in objs if o["inside"]))

    def test_zone_takes_whole_glyphs(self):
        """AutoCAD text exported as lines: a letter with its center in the zone is removed whole (the tail of g)."""
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(150 * MM, 60 * MM))
        y = lambda v: 60 * MM - v * MM  # noqa: E731
        p = c.beginPath()
        for i, (gx, gy) in enumerate([(3, 25), (0, 25), (0, 29), (3, 29), (3, 25), (3, 32.5), (0.5, 33.5), (0, 32.5)]):
            (p.lineTo if i else p.moveTo)((37 + gx) * MM, y(gy))
        c.drawPath(p, stroke=1, fill=0)
        c.line(10 * MM, y(28), 140 * MM, y(28))  # long line through the zone: it is cut, it does not disappear
        c.showPage()
        c.save()
        src = buf.getvalue()
        rect = [18 * MM, 20 * MM, 42 * MM, 31 * MM]
        g = [o for o in pdfcore.objects_in_rect(src, 0, rect) if o["bbox"][2] - o["bbox"][0] < 20][0]
        self.assertLess(g["frac"], 0.9)
        _out, rep = pdfcore.apply_removals(src, {0: [{"mode": "zone", "rect": rect}]})
        self.assertEqual(rep[0]["removed"], 1)
        self.assertEqual(rep[0]["cut"], 1)

    def test_export_selected_pages(self):
        import pypdfium2 as pdfium
        import zipfile

        meta = self.open_sample()
        doc = meta["id"]
        state = {"v": 1, "annots": [{"id": "a", "type": "text", "page": 0}, {"id": "b", "type": "text", "page": 1}]}
        prims = {"0": [{"t": "T", "p": [100, 100], "s": 12, "a": 0, "txt": "PAG1", "c": "add"}],
                 "1": [{"t": "T", "p": [100, 100], "s": 12, "a": 0, "txt": "PAG2", "c": "add"}]}
        pdf, h = self.req("POST", f"/api/doc/{doc}/export", {"filename": "x.pdf", "pages": prims, "removals": {}, "state": state, "pageSel": [1]}, raw=True)
        d = pdfium.PdfDocument(pdf)
        self.assertEqual(len(d), 1)
        self.assertIn("PAG2", d[0].get_textpage().get_text_range())
        # reopened: one page, the page 2 annotation ends up on page 1
        m2 = self.req("POST", "/api/open", pdf, {"X-Filename": "x.pdf"})
        self.assertEqual(len(m2["pages"]), 1)
        self.assertEqual([a["id"] for a in m2["state"]["annots"]], ["b"])
        self.assertEqual(m2["state"]["annots"][0]["page"], 0)
        # each page separately: an archive with one editable PDF each
        z, h = self.req("POST", f"/api/doc/{doc}/export", {"filename": "x.pdf", "pages": prims, "removals": {}, "state": state, "split": True}, raw=True)
        self.assertEqual(h["X-Export-Kind"], "zip")
        self.assertIn("x.zip", h["Content-Disposition"])
        zf = zipfile.ZipFile(io.BytesIO(z))
        self.assertEqual(sorted(zf.namelist()), ["x_p1.pdf", "x_p2.pdf"])
        p2 = zf.read("x_p2.pdf")
        self.assertEqual(len(pdfium.PdfDocument(p2)), 1)
        self.assertIsNotNone(pdfcore.extract_embedded(p2))

    def test_dxf_export_vector(self):
        import zipfile

        import ezdxf

        meta = self.open_sample()
        prims = {"0": [{"t": "L", "p": [10 * MM, 10 * MM, 50 * MM, 10 * MM], "w": 0.5, "c": "add"},
                       {"t": "R", "p": [20 * MM, 20 * MM, 40 * MM, 30 * MM], "c": "white", "cover": True},
                       {"t": "T", "p": [60 * MM, 20 * MM], "txt": "Ø25 H7", "s": 10, "c": "add"}]}
        body = {"format": "dxf", "filename": "arbore.pdf", "pages": prims, "pageSel": [0], "dxf": {"scale": 2}}
        data, h = self.req("POST", f"/api/doc/{meta['id']}/export", body, raw=True)
        self.assertEqual(h["X-Export-Kind"], "dxf")
        self.assertIn("arbore.dxf", h["Content-Disposition"])
        doc = ezdxf.read(io.StringIO(data.decode("utf-8")))
        self.assertEqual(len(doc.audit().errors), 0)
        msp = doc.modelspace()
        # at scale 2 the Ø40 circle of the side view has radius 40, center at (480, (210 − 95) × 2)
        circ = [(round(e.dxf.center.x, 2), round(e.dxf.center.y, 2), round(e.dxf.radius, 3)) for e in msp.query("CIRCLE")]
        self.assertIn((480.0, 230.0, 40.0), circ)
        # the plate: one closed polyline, with the R5 fillets as true arcs (bulge = tan(90°/4))
        plates = [e for e in msp.query("LWPOLYLINE") if e.closed and any(abs(abs(b) - 0.41421) < 1e-3 for *_xy, b in e.get_points("xyb"))]
        self.assertTrue(plates)
        texts = {t.dxf.text: t for t in msp.query("TEXT")}
        self.assertIn("Arbore intermediar", texts)
        self.assertEqual(texts["Arbore intermediar"].dxf.layer, "PDF-TEXT")
        self.assertEqual(texts["Ø25 H7"].dxf.layer, "DRAWCAD-COTE")
        lines = [e for e in msp.query("LINE") if e.dxf.layer == "DRAWCAD-COTE"]
        self.assertTrue(any(abs(e.dxf.start.x - 20) < 1e-6 and abs(e.dxf.end.x - 100) < 1e-6 for e in lines))
        self.assertEqual(len(msp.query("WIPEOUT")), 1)
        self.assertEqual(doc.header["$INSUNITS"], 4)
        # all pages → an archive with one DXF each; the rotated page keeps its on-screen orientation
        data, h = self.req("POST", f"/api/doc/{meta['id']}/export", {"format": "dxf", "filename": "arbore"}, raw=True)
        self.assertEqual(h["X-Export-Kind"], "zip")
        z = zipfile.ZipFile(io.BytesIO(data))
        self.assertEqual(sorted(z.namelist()), ["arbore_p1.dxf", "arbore_p2.dxf"])
        d2 = ezdxf.read(io.StringIO(z.read("arbore_p2.dxf").decode("utf-8")))
        frame = [e for e in d2.modelspace().query("LWPOLYLINE") if e.dxf.layer == "PAGINA"][0]
        xs = [p[0] for p in frame.get_points("xy")]
        ys = [p[1] for p in frame.get_points("xy")]
        w2, h2 = meta["pages"][1]["w"] / MM, meta["pages"][1]["h"] / MM
        self.assertAlmostEqual(max(xs) - min(xs), w2, places=2)
        self.assertAlmostEqual(max(ys) - min(ys), h2, places=2)

    def test_native_text_search(self):
        meta = self.open_sample()
        items = self.req("GET", f"/api/doc/{meta['id']}/page/0/text")["items"]
        self.assertTrue(any(it["text"].startswith("Material: 42CrMo4") for it in items))
        got = self.req("GET", f"/api/doc/{meta['id']}/page/0/ocr")
        self.assertIsNone(got["ocr"])

    @unittest.skipUnless(__import__("shutil").which("tesseract"), "Tesseract missing")
    def test_ocr_and_searchable_pdf(self):
        import pypdfium2 as pdfium

        meta = self.open_sample()
        res = self.req("POST", f"/api/doc/{meta['id']}/page/0/ocr", {})["ocr"]
        texts = [ln["text"] for ln in res["lines"]]
        self.assertIn("Material: 42CrMo4", texts)
        self.assertIn("118", texts)
        line = next(ln for ln in res["lines"] if ln["text"] == "118")
        self.assertAlmostEqual(line["cap"] / MM, 2.5, delta=0.3)
        # the result stays on the server and shows up in the document metadata
        self.assertEqual(self.req("GET", f"/api/doc/{meta['id']}")["ocrPages"], [0])
        pdf, _h = self.req("POST", f"/api/doc/{meta['id']}/export", {"filename": "a.pdf", "pageSel": [0], "ocrLayer": True}, raw=True)
        doc = pdfium.PdfDocument(pdf)
        txt = doc[0].get_textpage().get_text_range()
        self.assertGreaterEqual(txt.count("42CrMo4"), 2)  # the original text and the invisible OCR layer

    def test_vectorize_scan(self):
        """A skewed scan of the drawing: circles, fillets and the skew are recovered."""
        import numpy as np
        from PIL import Image

        from app import vectorize

        scale = 8 * 25.4 / 72
        png = pdfcore.render_png(self.sample.read_bytes(), 0, scale)
        im = Image.open(io.BytesIO(png)).convert("L").rotate(0.6, resample=Image.BICUBIC, fillcolor=255)
        a = np.asarray(im).astype(np.int16) + np.random.default_rng(3).normal(0, 10, (im.height, im.width))
        gray = np.clip(a, 0, 255).astype(np.uint8)
        res = vectorize.vectorize(gray, scale)
        self.assertAlmostEqual(res["skew"], -0.6, delta=0.1)
        radii = sorted(round(c[2] / MM, 1) for c in res["circles"] if c[2] / MM > 2)
        for r in (5.0, 15.0, 20.0):
            self.assertTrue(any(abs(x - r) <= 0.15 for x in radii), (r, radii))
        # the plate (120…170 × 150…185 mm): one closed outline, with the two R5 fillets as arcs
        plates = [pl for pl in res["polys"] if pl["closed"] and all(115 < x / MM < 175 and 145 < y / MM < 190 for x, y in pl["pts"])]
        self.assertEqual(len(plates), 1)
        plate = plates[0]
        self.assertEqual(sum(1 for b in plate["bulges"] if abs(abs(b) - 0.4142) < 0.02), 2)
        # the chamfer corner (170, 180) stays within 0.4 mm, after straightening the scan
        self.assertTrue(any(abs(x / MM - 170) < 0.4 and abs(y / MM - 180) < 0.4 for x, y in plate["pts"]))

    def test_page_rotate_delete_move(self):
        """Rotating, deleting and moving pages shows everywhere and is kept on export."""
        import pikepdf
        import pypdfium2 as pdfium

        meta = self.open_sample()
        doc = meta["id"]
        w0, h0 = meta["pages"][0]["w"], meta["pages"][0]["h"]
        snap0 = self.req("GET", f"/api/doc/{doc}/page/0/snap")
        corner = next(p for p in snap0["pts"] if abs(p[0] - 90 * MM) < 0.05 and abs(p[1] - 75 * MM) < 0.05)
        state = {"v": 1, "annots": [{"id": "a1", "type": "text", "page": 0, "p": [10, 20], "txt": "x"}]}
        r = self.req("POST", f"/api/doc/{doc}/pages", {"op": "rotate", "pages": [0], "delta": 90, "state": state})
        self.assertEqual(r["lv"], 1)
        self.assertAlmostEqual(r["pages"][0]["w"], h0, places=2)
        self.assertAlmostEqual(r["pages"][0]["h"], w0, places=2)
        # the corner (90, 75) mm ends up, after rotating right, at (H − 75, 90)
        snap = self.req("GET", f"/api/doc/{doc}/page/0/snap?v=1")
        want = (h0 - corner[1], corner[0])
        self.assertTrue(any(abs(p[0] - want[0]) < 0.05 and abs(p[1] - want[1]) < 0.05 for p in snap["pts"]))
        self.assertEqual(self.req("GET", f"/api/doc/{doc}")["state"]["annots"][0]["id"], "a1")
        pdf, _h = self.req("POST", f"/api/doc/{doc}/export", {"filename": "r.pdf", "pageSel": [0]}, raw=True)
        with pikepdf.open(io.BytesIO(pdf)) as pk:
            self.assertEqual(int(pk.pages[0].obj.get("/Rotate", 0)), 90)
        # move: page 2 (already rotated in the file) comes first; deleting leaves it alone
        r = self.req("POST", f"/api/doc/{doc}/pages", {"op": "move", "page": 1, "to": 0})
        self.assertEqual(r["pages"][0]["rot"], 90)
        r = self.req("POST", f"/api/doc/{doc}/pages", {"op": "delete", "pages": [1]})
        self.assertEqual(len(r["pages"]), 1)
        pdf, _h = self.req("POST", f"/api/doc/{doc}/export", {"filename": "r.pdf"}, raw=True)
        self.assertEqual(len(pdfium.PdfDocument(pdf)), 1)
        # not all pages can be deleted
        with self.assertRaises(urllib.error.HTTPError):
            self.req("POST", f"/api/doc/{doc}/pages", {"op": "delete", "pages": [0]})

    def test_page_scale_and_low_dpi_image(self):
        """Sheet size: the page and the content grow together, the objects stay the same."""
        from PIL import Image

        meta = self.open_sample()
        w0 = meta["pages"][0]["w"]
        objs0 = self.req("POST", f"/api/doc/{meta['id']}/page/0/objects", {"rect": [0, 0, 5000, 5000]})["objects"]
        r = self.req("POST", f"/api/doc/{meta['id']}/pages", {"op": "scale", "pages": [0], "factor": 2})
        self.assertAlmostEqual(r["pages"][0]["w"], 2 * w0, places=2)
        objs = self.req("POST", f"/api/doc/{meta['id']}/page/0/objects", {"rect": [0, 0, 5000, 5000]})["objects"]
        self.assertEqual([o["id"] for o in objs], [o["id"] for o in objs0])
        a, b = objs0[0]["bbox"], objs[0]["bbox"]
        self.assertTrue(all(abs(2 * x - y) < 0.2 for x, y in zip(a, b)), (a, b))
        # a 3300 px image at 72 DPI: the sheet would be 1.16 m; it is brought to A3
        im = Image.new("L", (3300, 2300), 255)
        buf = io.BytesIO()
        im.save(buf, format="PNG", dpi=(72, 72))
        m2 = self.req("POST", "/api/open", buf.getvalue(), {"X-Filename": "poza.png"})
        self.assertAlmostEqual(max(m2["pages"][0]["w"], m2["pages"][0]["h"]) / MM, 420, delta=1)

    def test_render_clip(self):
        """High zoom: only the visible area, at high resolution."""
        from PIL import Image

        meta = self.open_sample()
        png, _h = self.req("GET", f"/api/doc/{meta['id']}/page/0/render?scale=20&clip=100,100,140,130", raw=True)
        im = Image.open(io.BytesIO(png))
        self.assertEqual(im.size, (800, 600))

    def test_image_open(self):
        from PIL import Image
        import io
        im = Image.new("L", (2480, 3508), 255)  # A4 at 300 DPI
        b = io.BytesIO()
        im.save(b, format="PNG", dpi=(300, 300))
        meta = self.req("POST", "/api/open", b.getvalue(), {"X-Filename": "scan.png"})
        self.assertEqual(meta["kind"], "image")
        self.assertAlmostEqual(meta["pages"][0]["w"], 595.2, delta=0.5)

    def test_retention_cleanup(self):
        from app import main as m
        meta = self.open_sample()
        self.assertIsNotNone(meta["expires"])
        keep = self.open_sample()
        d = Path(TMP) / "docs" / meta["id"]
        mj = json.loads((d / "meta.json").read_text("utf-8"))
        old = time.time() - (m.RETENTION_DAYS + 1) * 86400
        mj["updated"] = mj["created"] = old
        mj.pop("accessed", None)
        (d / "meta.json").write_text(json.dumps(mj), "utf-8")
        removed = m.cleanup_expired()
        self.assertIn(meta["id"], removed)
        self.assertFalse(d.exists())
        self.assertTrue((Path(TMP) / "docs" / keep["id"]).exists())
        # opening extends the retention
        got = self.req("GET", f"/api/doc/{keep['id']}")
        self.assertGreater(got["expires"], time.time() + (m.RETENTION_DAYS - 1) * 86400)

    def test_state_save(self):
        meta = self.open_sample()
        self.req("PUT", f"/api/doc/{meta['id']}/state", {"v": 1, "annots": []})
        got = self.req("GET", f"/api/doc/{meta['id']}")
        self.assertEqual(got["state"], {"v": 1, "annots": []})


if __name__ == "__main__":
    unittest.main()
