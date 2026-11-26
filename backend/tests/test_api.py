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
from PIL import Image  # noqa: E402

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

    def test_export_writes_the_revision(self):
        meta = self.open_sample()
        doc = meta["id"]
        for embed in (True, False):
            pdf, _h = self.req(
                "POST",
                f"/api/doc/{doc}/export",
                {"filename": "arbore_rev3.pdf", "pages": {}, "removals": {}, "rev": "3<x>",
                 "state": {"v": 1, "annots": [], "settings": {"revNo": "3"}}, "embed": embed, "colorMode": "black"},
                raw=True,
            )
            import pikepdf

            with pikepdf.open(io.BytesIO(pdf)) as pk:
                self.assertEqual(str(pk.docinfo["/DrawCADRevision"]), "3x")
                self.assertIn("rev 3x", str(pk.docinfo["/Keywords"]))
                self.assertEqual(str(pk.docinfo["/Title"]), "arbore_rev3")
                with pk.open_metadata() as m:
                    self.assertIn("rev 3x", m.get("pdf:Keywords", ""))

    def test_image_annotation_roundtrip(self):
        from PIL import Image

        meta = self.open_sample()
        doc = meta["id"]
        buf = io.BytesIO()
        im = Image.new("RGBA", (120, 60), (200, 30, 30, 255))
        im.info["comment"] = "secret"
        im.save(buf, "PNG")
        res = self.req("POST", f"/api/doc/{doc}/images", buf.getvalue() + b"trailing payload")
        self.assertEqual((res["w"], res["h"]), (120, 60))
        png, h = self.req("GET", f"/api/doc/{doc}/image/{res['img']}", raw=True)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertNotIn(b"trailing payload", png)
        # SVG and garbage are refused
        for bad in (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", b"\x89PNG\r\n\x1a\nnot really"):
            with self.assertRaises(urllib.error.HTTPError):
                self.req("POST", f"/api/doc/{doc}/images", bad)
        # export with the image, then reopen: the image annotation comes back, with its file
        ann = {"id": "i1", "type": "image", "r": [100, 100, 220, 160], "img": res["img"], "page": 0}
        prims = {"0": [{"t": "I", "p": [100, 100, 220, 160], "img": res["img"], "rot": 90, "op": 0.5, "c": "add"}]}
        pdf, _h = self.req("POST", f"/api/doc/{doc}/export",
                           {"filename": "img.pdf", "pages": prims, "removals": {}, "state": {"v": 1, "annots": [ann]}, "embed": True},
                           raw=True)
        import pypdfium2 as pdfium

        d = pdfium.PdfDocument(pdf)
        kinds = [o.type for o in d[0].get_objects(max_depth=3)]
        self.assertIn(pdfium.raw.FPDF_PAGEOBJ_IMAGE, kinds)
        # DXF: the image is saved next to the DXF (ZIP) and referenced by an IMAGE entity; the
        # highlighter keeps its width and transparency, stamps and the watermark their layers
        import zipfile

        import ezdxf

        dprims = {"0": prims["0"] + [
            {"t": "P", "p": [50, 300, 200, 300], "w": 12, "c": "hlGreen", "op": 0.38, "cap": "round", "blend": "multiply"},
            {"t": "T", "p": [60, 400], "txt": "APROBAT", "s": 14, "c": "stRed"},
            {"t": "T", "p": [80, 500], "txt": "CONFIDENTIAL", "s": 60, "a": 30, "c": "wm", "op": 0.12}]}
        zdata, h = self.req("POST", f"/api/doc/{doc}/export",
                            {"filename": "img.dxf", "format": "dxf", "pages": dprims, "removals": {}, "pageSel": [0]}, raw=True)
        self.assertEqual(h["X-Export-Kind"], "zip")
        z = zipfile.ZipFile(io.BytesIO(zdata))
        self.assertEqual(sorted(z.namelist()), ["img.dxf", "img_img1.png"])
        msp = ezdxf.read(io.StringIO(z.read("img.dxf").decode("utf-8"))).modelspace()
        images = msp.query("IMAGE")
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].image_def.dxf.filename, "img_img1.png")
        self.assertEqual(images[0].dxf.layer, "DRAWCAD-IMAGINI")
        # turned a quarter: the 120×60 pt rectangle holds the image standing up
        sx, sy = images[0].dxf.u_pixel.magnitude * 120, images[0].dxf.v_pixel.magnitude * 60
        self.assertAlmostEqual(sx, 60 * 25.4 / 72, 2)
        self.assertAlmostEqual(sy, 120 * 25.4 / 72, 2)
        mark = [e for e in msp.query("LWPOLYLINE") if e.dxf.layer == "DRAWCAD-MARKER"][0]
        self.assertAlmostEqual(mark.dxf.const_width, 12 * 25.4 / 72, 3)
        self.assertAlmostEqual(mark.transparency, 0.62, 2)
        texts = {t.dxf.text: t for t in msp.query("TEXT")}
        self.assertEqual(texts["APROBAT"].dxf.layer, "DRAWCAD-STAMPILE")
        self.assertEqual(texts["APROBAT"].rgb, (198, 40, 40))
        self.assertEqual(texts["CONFIDENTIAL"].dxf.layer, "DRAWCAD-FILIGRAN")
        self.assertAlmostEqual(texts["CONFIDENTIAL"].transparency, 0.88, 2)
        meta2 = self.req("POST", "/api/open", pdf, {"X-Filename": "img.pdf"})
        imgs = [a for a in meta2["state"]["annots"] if a["type"] == "image"]
        self.assertEqual(len(imgs), 1)
        back, _h = self.req("GET", f"/api/doc/{meta2['id']}/image/{imgs[0]['img']}", raw=True)
        self.assertTrue(back.startswith(b"\x89PNG"))

    def test_highlighter_and_comment_notes(self):
        meta = self.open_sample()
        doc = meta["id"]
        prims = {"0": [{"t": "P", "p": [100, 100, 200, 100, 250, 140], "w": 17, "c": "hlGreen", "op": 0.38, "cap": "round", "blend": "multiply"}]}
        notes = {"0": [{"p": [150, 150], "text": "Verifică raza", "author": "OV", "date": "24.11.2026"},
                       {"p": [300, 150], "text": "Gata", "done": True}]}
        pdf, _h = self.req("POST", f"/api/doc/{doc}/export",
                           {"filename": "rev.pdf", "pages": prims, "removals": {}, "notes": notes, "colorMode": "black"}, raw=True)
        import pikepdf

        with pikepdf.open(io.BytesIO(pdf)) as pk:
            ann = [a for a in pk.pages[0].obj.get("/Annots", []) if a.get("/Subtype") == "/Text"]
            self.assertEqual(len(ann), 2)
            self.assertIn("Verifică raza", str(ann[0]["/Contents"]))
            self.assertEqual(str(ann[0]["/T"]), "OV")
            self.assertTrue(str(ann[1]["/Contents"]).startswith("[Rezolvat]"))
        # the highlighter keeps its color in black mode, with transparency and multiply
        import pypdfium2 as pdfium

        img = pdfium.PdfDocument(pdf)[0].render(scale=1).to_pil().convert("RGB")
        px = img.getpixel((int(150), int(100)))
        self.assertTrue(px[1] > px[0] + 30 and px[1] > px[2] + 30, px)  # green, not black

    def test_compare_revisions(self):
        from reportlab.pdfgen import canvas as rl

        def drawing(hole_x, shift=0.0, extra=False):
            buf = io.BytesIO()
            c = rl.Canvas(buf, pagesize=(842, 595))
            c.translate(shift, -shift)
            c.rect(100, 100, 500, 300)
            c.circle(hole_x, 250, 30)
            c.drawString(120, 420, "Flansa rev")
            if extra:
                c.line(650, 150, 750, 150)
            c.showPage()
            c.save()
            return buf.getvalue()

        old = self.req("POST", "/api/open", drawing(300), {"X-Filename": "flansa_rev1.pdf"})
        same = self.req("POST", "/api/open", drawing(300, shift=5.0), {"X-Filename": "flansa_rev1b.pdf"})
        new = self.req("POST", "/api/open", drawing(340, extra=True), {"X-Filename": "flansa_rev2.pdf"})
        # the same drawing, exported 5 pt off: aligned, nothing changed
        r0 = self.req("POST", f"/api/doc/{same['id']}/compare", {"other": old["id"], "page": 0, "otherPage": 0})
        self.assertEqual(r0["regions"], [], r0["shiftMm"])
        # the hole moved and a line was added: removed and added ink, areas around them
        r1 = self.req("POST", f"/api/doc/{new['id']}/compare", {"other": old["id"], "page": 0, "otherPage": 0})
        self.assertGreater(r1["removed"], 0)
        self.assertGreater(r1["added"], 0)
        self.assertTrue(r1["image"].startswith("data:image/png;base64,"))
        # the older page, aligned, for side by side and the curtain: same size as the overlay
        import base64

        from PIL import Image

        im_o = Image.open(io.BytesIO(base64.b64decode(r1["oldImage"].split(",", 1)[1])))
        im_c = Image.open(io.BytesIO(base64.b64decode(r1["image"].split(",", 1)[1])))
        self.assertEqual(im_o.size, im_c.size)
        boxes = r1["regions"]
        self.assertTrue(any(b[0] < 300 < b[2] and b[1] < 595 - 250 < b[3] for b in boxes), boxes)  # the hole
        self.assertTrue(any(b[0] < 700 < b[2] for b in boxes), boxes)  # the new line
        # with annotations: the same original, a dimension line added in DrawCAD on the newer one shows green
        line = [{"t": "L", "p": [150, 550, 450, 550], "w": 0.7, "c": "add"}]
        r2 = self.req("POST", f"/api/doc/{same['id']}/compare",
                      {"other": old["id"], "page": 0, "otherPage": 0, "prims": line, "otherPrims": []})
        self.assertGreater(r2["added"], 0)
        self.assertTrue(any(b[0] < 300 < b[2] and b[1] <= 550 <= b[3] for b in r2["regions"]), r2["regions"])
        pdf, h = self.req("POST", f"/api/doc/{new['id']}/compare",
                          {"other": old["id"], "page": 0, "otherPage": 0, "format": "pdf", "legend": "vechi|nou|ambele"}, raw=True)
        self.assertTrue(pdf.startswith(b"%PDF"))
        with self.assertRaises(urllib.error.HTTPError):
            self.req("POST", f"/api/doc/{new['id']}/compare", {"other": "f" * 32, "page": 0, "otherPage": 0})

    def test_compare_two_point_alignment(self):
        """The older revision exported at 0.7× and turned by 20°: two pairs of points line it up."""
        import math

        from reportlab.pdfgen import canvas as rl

        def drawing(k=1.0, ang=0.0, tx=0.0, ty=0.0):
            buf = io.BytesIO()
            c = rl.Canvas(buf, pagesize=(842, 595))
            c.translate(tx, ty)
            c.rotate(ang)
            c.scale(k, k)
            c.setLineWidth(1.0 / k)
            c.rect(100, 100, 500, 300)
            c.circle(300, 250, 30)
            c.line(150, 150, 550, 350)
            c.showPage()
            c.save()
            return buf.getvalue()

        k, ang, tx, ty = 0.7, 20.0, 200.0, 40.0
        new = self.req("POST", "/api/open", drawing(), {"X-Filename": "rev2.pdf"})
        old = self.req("POST", "/api/open", drawing(k, ang, tx, ty), {"X-Filename": "rev1_scaled.pdf"})

        def vis_old(x, y):
            a = math.radians(ang)
            px, py = tx + k * (x * math.cos(a) - y * math.sin(a)), ty + k * (x * math.sin(a) + y * math.cos(a))
            return [px, 595 - py]

        pairs = [[[100, 595 - 100], vis_old(100, 100)], [[600, 595 - 400], vis_old(600, 400)]]
        base = {"other": old["id"], "page": 0, "otherPage": 0, "align": True}
        r0 = self.req("POST", f"/api/doc/{new['id']}/compare", base)
        self.assertGreater(len(r0["regions"]), 0)  # without the points everything differs
        r1 = self.req("POST", f"/api/doc/{new['id']}/compare", {**base, "pairs": pairs})
        self.assertEqual(r1["regions"], [], (r1["removed"], r1["added"]))
        self.assertAlmostEqual(r1["fit"]["scale"], 1 / k, places=3)
        self.assertAlmostEqual(r1["fit"]["angle"], ang, places=1)  # y down on the page: turned back by +20°
        for bad in ([[[0, 0], [0, 0]], [[0, 0], [0, 0]]], [[1, 2]], "x", [[[0, 0], [0, "a"]], [[9, 9], [9, 9]]]):
            with self.assertRaises(urllib.error.HTTPError):
                self.req("POST", f"/api/doc/{new['id']}/compare", {**base, "pairs": bad})

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

    def test_snap_geometric_center_and_insertion(self):
        """Closed polygons give their centroid (g), text runs their baseline origin (i)."""
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(400, 300))
        c.rect(100, 100, 80, 40)  # closed rectangle: center (140, 120) in PDF coordinates
        p = c.beginPath()  # an L-shaped closed outline: centroid off the bounding-box center
        p.moveTo(250, 50)
        p.lineTo(310, 50)
        p.lineTo(310, 70)
        p.lineTo(270, 70)
        p.lineTo(270, 110)
        p.lineTo(250, 110)
        p.close()
        c.drawPath(p)
        c.line(20, 20, 60, 20)  # an open line: no centroid
        c.setFont("Helvetica", 12)
        c.drawString(30, 250, "Ø25 H7")
        c.showPage()
        c.save()
        d = pdfcore.snap_points(buf.getvalue(), 0)
        near = lambda kind, x, y: any(q[2] == kind and abs(q[0] - x) < 0.05 and abs(q[1] - y) < 0.05 for q in d["pts"])  # noqa: E731
        self.assertTrue(near("g", 140, 300 - 120), "rectangle center")
        # L shape: 60×20 (centroid 280, 60) and 20×40 (centroid 260, 90), areas 1200 and 800 → (272, 72)
        self.assertTrue(near("g", 272, 300 - 72), [q for q in d["pts"] if q[2] == "g"])
        self.assertEqual(len([q for q in d["pts"] if q[2] == "g"]), 2, "the open line has no center")
        self.assertTrue(near("i", 30, 300 - 250), "text insertion point")

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

    def test_dxf_source_export(self):
        """A drawing opened from DXF exports as itself: every original entity, DrawCAD's line on its layer
        in the space the page shows (model space 1:1 / the 1:2 layout's paper space), the circle deleted
        in DrawCAD gone from the DXF."""
        import ezdxf

        sys.path.insert(0, str(Path(__file__).parent))
        import test_dxfin

        for lay in (False, True):
            src = test_dxfin.make_doc(layout=lay)
            data = test_dxfin.to_bytes(src)
            meta = self.req("POST", "/api/open", data, {"X-Filename": "piesa.dxf"})
            self.assertEqual(meta["kind"], "dxf")
            hmap = json.loads((Path(TMP) / "docs" / meta["id"] / "original.dxfmap.json").read_text())[0]
            circle = src.modelspace().query("CIRCLE")[0].dxf.handle
            ids = [str(n) for n, h in enumerate(hmap) if h == circle]
            self.assertTrue(ids)
            prims = {"0": [{"t": "L", "p": [10 * MM, 10 * MM, 50 * MM, 10 * MM], "w": 0.5, "c": "add"}]}
            body = {"format": "dxf", "filename": "piesa.dxf", "pages": prims, "removals": {"0": [{"mode": "objects", "ids": ids}]}}
            out, h = self.req("POST", f"/api/doc/{meta['id']}/export", body, raw=True)
            self.assertEqual(h["X-Export-Kind"], "dxf")
            self.assertEqual(json.loads(h["X-Dxf-Stats"])["source"]["deleted"], 1)
            doc = ezdxf.read(io.StringIO(out.decode("utf-8")))
            msp = doc.modelspace()
            self.assertEqual(len(msp.query("CIRCLE")), 0)
            self.assertEqual(len(msp.query("ARC")), 1)
            self.assertEqual(len(msp.query("DIMENSION")), 1)
            self.assertEqual(len(msp.query("HATCH")), 1)
            if lay:
                ln = doc.layouts.get("Plansa 1").query("LINE[layer=='DRAWCAD-COTE']")[0]
                self.assertAlmostEqual(ln.dxf.start.x, 10, 3)
                self.assertAlmostEqual(ln.dxf.start.y, 200, 3)
                self.assertAlmostEqual(ln.dxf.end.x, 50, 3)
            else:
                a, _b, _c, d, e, f = meta["dxf"]["pages"][0]["tf"]
                ln = msp.query("LINE[layer=='DRAWCAD-COTE']")[0]
                self.assertAlmostEqual(ln.dxf.start.x, (10 * MM - e) / a, 3)
                self.assertAlmostEqual(ln.dxf.start.y, (210 * MM - 10 * MM - f) / d, 3)
                self.assertAlmostEqual(ln.dxf.end.x - ln.dxf.start.x, 40, 3)  # 1:1 on the sheet
            # the page rebuilt instead (option): DrawCAD's own layers, the page frame
            body["dxf"] = {"source": False}
            out, _h = self.req("POST", f"/api/doc/{meta['id']}/export", body, raw=True)
            doc = ezdxf.read(io.StringIO(out.decode("utf-8")))
            self.assertTrue(doc.modelspace().query("LWPOLYLINE[layer=='PAGINA']"))

    def test_dxf_source_turned_page_and_image(self):
        """The original-DXF export of a page turned in the editor: a line drawn along the turned page lands
        where it was drawn on the drawing; an image placed in DrawCAD comes in a ZIP next to the DXF."""
        import zipfile

        import ezdxf

        sys.path.insert(0, str(Path(__file__).parent))
        import test_dxfin

        meta = self.req("POST", "/api/open", test_dxfin.to_bytes(test_dxfin.make_doc()), {"X-Filename": "rot.dxf"})
        doc_id = meta["id"]
        r = self.req("POST", f"/api/doc/{doc_id}/pages", {"op": "rotate", "pages": [0], "delta": 90})
        W, H = 297 * MM, 210 * MM  # the sheet before the turn; shown 210 wide, 297 tall
        self.assertAlmostEqual(r["pages"][0]["w"], H, 0)
        a, _b, _c, d, e, f = meta["dxf"]["pages"][0]["tf"]
        # a vertical line on the turned page (10 → 50 mm down, 20 mm from the left) ...
        line = {"t": "L", "p": [20 * MM, 10 * MM, 20 * MM, 50 * MM], "w": 0.5, "c": "add"}
        buf = io.BytesIO()
        Image.new("RGB", (40, 20), (0, 0, 200)).save(buf, "PNG")
        img = self.req("POST", f"/api/doc/{doc_id}/images", buf.getvalue())
        pic = {"t": "I", "p": [60 * MM, 60 * MM, 100 * MM, 80 * MM], "img": img["img"], "rot": 0, "op": 1, "c": "add"}
        body = {"format": "dxf", "filename": "rot.dxf", "pages": {"0": [line, pic]}, "removals": {}}
        out, h = self.req("POST", f"/api/doc/{doc_id}/export", body, raw=True)
        self.assertEqual(h["X-Export-Kind"], "zip")
        z = zipfile.ZipFile(io.BytesIO(out))
        dxf_name = [n for n in z.namelist() if n.endswith(".dxf")][0]
        self.assertEqual(len(z.namelist()), 2)
        dx = ezdxf.read(io.StringIO(z.read(dxf_name).decode("utf-8")))
        ln = dx.modelspace().query("LINE[layer=='DRAWCAD-COTE']")[0]
        # ... is horizontal on the drawing: turned 90° clockwise, the page's top edge is its left edge
        # (PDF /Rotate 90: visual (vx, vy) = (H - v, u) with u, v from the unturned top left corner)
        def drawing(vx, vy):
            u, v = vy, H - vx
            return ((u - e) / a, ((H - v) - f) / d)

        sx, sy = drawing(20 * MM, 10 * MM)
        ex, ey = drawing(20 * MM, 50 * MM)
        self.assertAlmostEqual(ln.dxf.start.x, sx, 3)
        self.assertAlmostEqual(ln.dxf.start.y, sy, 3)
        self.assertAlmostEqual(ln.dxf.end.x, ex, 3)
        self.assertAlmostEqual(ln.dxf.start.y, ln.dxf.end.y, 3)
        import math

        u = dx.modelspace().query("IMAGE")[0].dxf.u_pixel
        self.assertAlmostEqual(math.degrees(math.atan2(u.y, u.x)) % 360, 90, 3)  # upright on the turned page

    def test_dxf_layers_hidden(self):
        """Layers of an opened DXF: listed with their color; a hidden layer is gone from the page, the
        text search and the PDF export, turned off in the DXF of the original drawing, and back when shown."""
        import ezdxf
        import pypdfium2 as pdfium

        sys.path.insert(0, str(Path(__file__).parent))
        import test_dxfin

        src = test_dxfin.make_doc()
        src.layers.add("COTE", color=3)
        src.layers.add("TEXTE", color=2)
        for e in src.modelspace():
            if e.dxftype() == "DIMENSION":
                e.dxf.layer = "COTE"
            elif e.dxftype() == "TEXT":
                e.dxf.layer = "TEXTE"
        meta = self.req("POST", "/api/open", test_dxfin.to_bytes(src), {"X-Filename": "straturi.dxf"})
        layers = {la["name"]: la for la in meta["dxf"]["layers"]}
        self.assertEqual(set(layers), {"0", "COTE", "TEXTE"})
        self.assertEqual(layers["COTE"]["color"], "#00ff00")
        self.assertIsNone(layers["0"]["color"])  # ACI 7: shown in the text color
        self.assertEqual((meta["pages"][0]["name"], meta["pages"][0]["dscale"]), ("Model", 1.0))
        doc_id = meta["id"]

        def texts():
            return " ".join(t["text"] for t in self.req("GET", f"/api/doc/{doc_id}/page/0/text?v={time.time()}")["items"])

        self.assertIn("ȘURUB", texts())
        before, _h = self.req("GET", f"/api/doc/{doc_id}/page/0/render?scale=1", raw=True)
        res = self.req("POST", f"/api/doc/{doc_id}/dxf-layers", {"hidden": ["TEXTE", "NU-EXISTA"]})
        self.assertEqual(res["hidden"], ["TEXTE"])
        self.assertNotIn("ȘURUB", texts())
        self.assertIn("200", texts())  # the dimension's value, on COTE, stays
        after, _h = self.req("GET", f"/api/doc/{doc_id}/page/0/render?scale=1&v={res['lv']}", raw=True)
        self.assertNotEqual(before, after)
        pdf, _h = self.req("POST", f"/api/doc/{doc_id}/export", {"filename": "x.pdf", "pages": {}, "removals": {}}, raw=True)
        d = pdfium.PdfDocument(pdf)
        self.assertNotIn("ȘURUB", d[0].get_textpage().get_text_range())
        d.close()
        out, _h = self.req("POST", f"/api/doc/{doc_id}/export", {"format": "dxf", "filename": "x.dxf", "pages": {}}, raw=True)
        dx = ezdxf.read(io.StringIO(out.decode("utf-8")))
        self.assertTrue(dx.layers.get("TEXTE").is_off())
        self.assertEqual(len(dx.modelspace().query("TEXT")), 3)  # still there, on a layer turned off
        self.req("POST", f"/api/doc/{doc_id}/dxf-layers", {"hidden": []})
        self.assertIn("ȘURUB", texts())

        # the drawing's own colors (the red hatch), then black again
        def reds(v):
            png, _h = self.req("GET", f"/api/doc/{doc_id}/page/0/render?scale=1&v={v}", raw=True)
            img = Image.open(io.BytesIO(png)).convert("RGB")
            return sum(1 for r, g, b in img.get_flattened_data() if r > 180 and g < 80 and b < 80)

        res = self.req("POST", f"/api/doc/{doc_id}/dxf-layers", {"hidden": [], "colors": True})
        self.assertTrue(res["colors"])
        self.assertGreater(reds(res["lv"]), 50)
        self.assertIn("ȘURUB", texts())  # same objects: search, snap and removals still match
        res = self.req("POST", f"/api/doc/{doc_id}/dxf-layers", {"hidden": [], "colors": False})
        self.assertEqual(reds(res["lv"]), 0)

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
    def test_ocr_skewed_photo(self):
        """A skewed photo: OCR straightens it first (regression: the rotated image is read-only)."""
        from PIL import Image, ImageDraw

        from app import ocr

        img = Image.new("L", (2400, 1700), 255)
        d = ImageDraw.Draw(img)
        d.rectangle([100, 100, 2300, 1600], outline=0, width=4)
        d.line([300, 900, 2100, 900], fill=0, width=3)
        img = img.rotate(1.5, fillcolor=255)
        b = io.BytesIO()
        img.save(b, format="PNG", dpi=(200, 200))
        pdf = pdfcore.image_to_pdf(b.getvalue(), None)[0]
        res = ocr.ocr_page(pdf, 0, (2400 * 72 / 200, 1700 * 72 / 200), scan=True)
        self.assertNotEqual(res["skew"], 0)

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

    def test_snap_on_scan(self):
        """A scanned page gets snap geometry from its vectorization (not straightened)."""
        from app import scansnap

        png = pdfcore.render_png(self.sample.read_bytes(), 0, 200 / 72)
        meta = self.req("POST", "/api/open", png, {"X-Filename": "scan.png"})
        self.assertEqual(meta["pages"][0]["paths"], 0)
        # the image page has the size of the PNG at 72 DPI: drawing mm → page points × (200 / 72) / (200 / 72)
        snap = self.req("GET", f"/api/doc/{meta['id']}/page/0/snapscan")
        k = meta["pages"][0]["w"] / (297 * MM)  # page points per drawing point
        arcs = [[a[0] / k / MM, a[1] / k / MM, a[2] / k / MM] for a in snap["arcs"]]
        self.assertTrue(any(abs(x - 240) < 0.4 and abs(y - 95) < 0.4 and abs(r - 20) < 0.3 for x, y, r in arcs), "the Ø40 circle")
        self.assertTrue(any(p[2] == "c" and abs(p[0] / k / MM - 240) < 0.4 and abs(p[1] / k / MM - 95) < 0.4 for p in snap["pts"]))
        # the chamfer corner (170, 180) of the plate is an endpoint
        self.assertTrue(any(p[2] == "e" and abs(p[0] / k / MM - 170) < 0.5 and abs(p[1] / k / MM - 180) < 0.5 for p in snap["pts"]))
        self.assertTrue(snap["segs"])
        # a vector PDF does not need it
        doc = self.open_sample()["id"]
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.req("GET", f"/api/doc/{doc}/page/0/snapscan")
        self.assertEqual(e.exception.code, 400)
        # an arc given by its bulge: center, radius, sweep (counter-clockwise, Y up)
        cx, cy, r, a0, sw = scansnap._bulge_arc([120, 100], [100, 80], 0.41421356)
        self.assertAlmostEqual(cx, 100, places=3)
        self.assertAlmostEqual(cy, 100, places=3)
        self.assertAlmostEqual(r, 20, places=3)
        self.assertAlmostEqual(sw, 3.14159265 / 2, places=4)

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
        # undo: the layout before the deletion comes back whole, the deleted page included
        self.assertEqual(r["prev"], [{"src": 1, "rot": 0}, {"src": 0, "rot": 90}])
        r2 = self.req("POST", f"/api/doc/{doc}/pages", {"op": "layout", "layout": r["prev"]})
        self.assertEqual(len(r2["pages"]), 2)
        self.assertEqual(r2["layout"], r["prev"])
        self.assertEqual(r2["prev"], r["layout"])
        self.assertAlmostEqual(r2["pages"][1]["w"], h0, places=2)
        # back to the original order and rotation: no layout left in the metadata
        r3 = self.req("POST", f"/api/doc/{doc}/pages", {"op": "layout", "layout": [{"src": 0, "rot": 0}, {"src": 1, "rot": 0}]})
        self.assertEqual(r3["layout"], [{"src": 0, "rot": 0}, {"src": 1, "rot": 0}])
        self.assertAlmostEqual(r3["pages"][0]["w"], w0, places=2)
        # invalid layouts: a page twice, an unknown page, a turn that is not a quarter, empty
        for bad in ([{"src": 0}, {"src": 0}], [{"src": 7}], [{"src": 0, "rot": 45}], [], [{"src": 0, "scale": 0}]):
            with self.assertRaises(urllib.error.HTTPError):
                self.req("POST", f"/api/doc/{doc}/pages", {"op": "layout", "layout": bad})

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
