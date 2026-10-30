"""Teste cap-coadă pentru API. Rulează: python -m unittest discover -s tests (din backend/)."""
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TMP = tempfile.mkdtemp(prefix="drawcad-test-")
os.environ["DRAWCAD_DATA"] = TMP
os.environ.setdefault("DRAWCAD_MODE", "personal")  # testele generale folosesc un singur spațiu
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
        # colțul conturului la (90, 75) mm
        self.assertTrue(any(abs(p[0] - 90 * MM) < 0.05 and abs(p[1] - 75 * MM) < 0.05 for p in snap["pts"]))
        # centrul cercului din vederea laterală
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
        # redeschiderea exportului: originalul și starea sunt recuperate
        meta2 = self.req("POST", "/api/open", pdf, {"X-Filename": "arbore_rev1.pdf"})
        self.assertTrue(meta2["fromExport"])
        self.assertEqual(meta2["state"], state)
        orig = (Path(TMP) / "docs" / meta2["id"] / "original.pdf").read_bytes()
        self.assertEqual(orig, self.sample.read_bytes())
        # textul Ø30 a dispărut din export, cel nou apare
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
        # zona trece peste conturul de sus (y = 110) și peste capătul cotei Ø30 (x = 165)
        rect = [160 * MM, 105 * MM, 170 * MM, 113 * MM]
        x0, y0, x1, y1 = rect
        pdf, rep = pdfcore.apply_removals(src, {0: [{"mode": "zone", "rect": rect}]})
        self.assertGreaterEqual(rep[0]["cut"], 2)  # conturul + linia de cotă
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
                continue  # săgețile pline rămân (doar acoperite)
            total = pdfcore.mat_mul(pdfcore._obj_matrix(obj), pm)
            for sp in pdfcore._path_points(obj, total):
                vis = [g.to_vis(*q) for q in sp["pts"]]
                for (ax, ay), (bx, by) in zip(vis, vis[1:]):
                    mx, my = (ax + bx) / 2, (ay + by) / 2
                    inside = x0 + eps < mx < x1 - eps and y0 + eps < my < y1 - eps
                    self.assertFalse(inside, f"segment rămas în zonă: {oid} {(ax, ay)}–{(bx, by)}")
                if any(abs(px - 180 * MM) < 0.05 and abs(py - 80 * MM) < 0.05 for px, py in vis):
                    corner_kept = True
        self.assertTrue(corner_kept, "restul conturului trebuie să rămână")
        # indicatorul (Form XObject) nu se modifică: obiectele lui apar ca blocate
        objs = pdfcore.objects_in_rect(src, 0, [240 * MM, 180 * MM, 260 * MM, 195 * MM])
        self.assertTrue(objs and all(o["locked"] for o in objs))
        _pdf, rep2 = pdfcore.apply_removals(src, {0: [{"mode": "zone", "rect": [240 * MM, 180 * MM, 260 * MM, 195 * MM]}]})
        self.assertEqual(rep2[0]["removed"] + rep2[0]["cut"], 0)
        self.assertGreater(rep2[0]["locked"], 0)

    def test_snap_arcs(self):
        d = pdfcore.snap_points(self.sample.read_bytes(), 0)
        arcs = [[round(v / MM, 2) for v in a[:3]] + [round(a[4] * 180 / 3.141592653589793, 1)] for a in d["arcs"]]
        # cercul Ø40 din vederea laterală și racordările R5 ale plăcii (sferturi de cerc, sens orar pe ecran)
        self.assertIn([240.0, 95.0, 20.0, 360.0], arcs)
        self.assertIn([165.0, 155.0, 5.0, -90.0], arcs)
        self.assertIn([125.0, 155.0, 5.0, -90.0], arcs)
        # centrul racordării devine punct de snap
        self.assertTrue(any(abs(p[0] - 165 * MM) < 0.05 and abs(p[1] - 155 * MM) < 0.05 and p[2] == "c" for p in d["pts"]))

    def test_ink_for_print(self):
        """Liniile și textul colorate devin negre; albul rămâne; blocurile și imaginile la cerere."""
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
        self.assertEqual(px(out, 100, 250), (0, 0, 0))  # linie
        self.assertEqual(px(out, 300, 150), (0, 0, 0))  # linie din bloc (Form XObject)
        self.assertEqual(px(out, 40, 160), (0, 0, 0))  # umplere colorată → neagră
        self.assertEqual(px(out, 70, 140), (255, 255, 255))  # albul rămâne
        self.assertEqual(px(out, 260, 70), (0, 0, 0))  # linia verde din imagine
        self.assertEqual(px(out, 260, 100), (255, 255, 255))  # fundalul imaginii
        keep = pdfcore.ink_pdf(src, None, "keep", False)
        self.assertNotEqual(px(keep, 40, 160), (0, 0, 0))  # umplerea rămâne colorată
        self.assertNotEqual(px(keep, 260, 70), (0, 0, 0))  # imaginea neschimbată
        text_dark = min(sum(px(keep, x, 200)) for x in range(22, 60))
        self.assertLess(text_dark, 60)  # textul tot negru
        # un singur obiect: doar linia de sus (primul obiect de pe pagină)
        objs = pdfcore.objects_in_rect(src, 0, [50, 40, 150, 60])
        ids = [o["id"] for o in objs if o["type"] == "path"]
        one, rep = pdfcore.apply_removals(src, {0: [{"mode": "black", "ids": ids}]})
        self.assertEqual(rep[0]["black"], 1)
        self.assertEqual(px(one, 100, 250), (0, 0, 0))
        self.assertNotEqual(px(one, 300, 150), (0, 0, 0))

    def test_legacy_attachment_names(self):
        """PDF-urile exportate înainte de redenumire (atașamente cotare.*) se redeschid."""
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
        # zona prinde 95% din linia de cotă Ø30 (x = 165, y 80…110) și doar capătul conturului
        objs = pdfcore.objects_in_rect(self.sample.read_bytes(), 0, [160 * MM, 81.5 * MM, 168 * MM, 113 * MM])
        fr = sorted(round(o["frac"], 2) for o in objs if o["type"] == "path" and not o["inside"])
        self.assertTrue(any(abs(f - 0.95) < 0.01 for f in fr), fr)
        self.assertTrue(all(o["frac"] == 1.0 for o in objs if o["inside"]))

    def test_zone_takes_whole_glyphs(self):
        """Text AutoCAD exportat ca linii: litera cu centrul în zonă se elimină întreagă (codița lui g)."""
        from reportlab.pdfgen import canvas

        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(150 * MM, 60 * MM))
        y = lambda v: 60 * MM - v * MM  # noqa: E731
        p = c.beginPath()
        for i, (gx, gy) in enumerate([(3, 25), (0, 25), (0, 29), (3, 29), (3, 25), (3, 32.5), (0.5, 33.5), (0, 32.5)]):
            (p.lineTo if i else p.moveTo)((37 + gx) * MM, y(gy))
        c.drawPath(p, stroke=1, fill=0)
        c.line(10 * MM, y(28), 140 * MM, y(28))  # linie lungă prin zonă: se taie, nu dispare
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
        # redeschis: o pagină, adnotarea paginii 2 devine pe pagina 1
        m2 = self.req("POST", "/api/open", pdf, {"X-Filename": "x.pdf"})
        self.assertEqual(len(m2["pages"]), 1)
        self.assertEqual([a["id"] for a in m2["state"]["annots"]], ["b"])
        self.assertEqual(m2["state"]["annots"][0]["page"], 0)
        # fiecare pagină separat: arhivă cu câte un PDF editabil
        z, h = self.req("POST", f"/api/doc/{doc}/export", {"filename": "x.pdf", "pages": prims, "removals": {}, "state": state, "split": True}, raw=True)
        self.assertEqual(h["X-Export-Kind"], "zip")
        self.assertIn("x.zip", h["Content-Disposition"])
        zf = zipfile.ZipFile(io.BytesIO(z))
        self.assertEqual(sorted(zf.namelist()), ["x_p1.pdf", "x_p2.pdf"])
        p2 = zf.read("x_p2.pdf")
        self.assertEqual(len(pdfium.PdfDocument(p2)), 1)
        self.assertIsNotNone(pdfcore.extract_embedded(p2))

    def test_image_open(self):
        from PIL import Image
        import io
        im = Image.new("L", (2480, 3508), 255)  # A4 la 300 DPI
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
        # deschiderea prelungește durata
        got = self.req("GET", f"/api/doc/{keep['id']}")
        self.assertGreater(got["expires"], time.time() + (m.RETENTION_DAYS - 1) * 86400)

    def test_state_save(self):
        meta = self.open_sample()
        self.req("PUT", f"/api/doc/{meta['id']}/state", {"v": 1, "annots": []})
        got = self.req("GET", f"/api/doc/{meta['id']}")
        self.assertEqual(got["state"], {"v": 1, "annots": []})


if __name__ == "__main__":
    unittest.main()
