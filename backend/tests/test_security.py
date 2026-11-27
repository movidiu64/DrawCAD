"""Security tests: crafted files, limits, cross-site requests.
Run: python -m unittest discover -s tests (from backend/)."""
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
if "DRAWCAD_DATA" not in os.environ:
    os.environ["DRAWCAD_DATA"] = tempfile.mkdtemp(prefix="drawcad-sec-")
os.environ.setdefault("DRAWCAD_MODE", "personal")  # the general tests use a single space
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tools"))

import pikepdf  # noqa: E402
import uvicorn  # noqa: E402
from PIL import Image  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

import make_sample  # noqa: E402
from app import main as appmain  # noqa: E402
from app.sanitize import sanitize_pdf  # noqa: E402


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def malicious_pdf() -> bytes:
    """A PDF with JavaScript on open, automatic actions, a link that starts a program and an
    attached file — everything a "trojan" PDF can do in an ordinary reader."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(300, 200))
    c.line(20, 20, 280, 180)
    c.drawString(30, 100, "desen")
    c.showPage()
    c.save()
    pk = pikepdf.open(io.BytesIO(buf.getvalue()))
    js = pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=pikepdf.String("app.alert('x')"))
    pk.Root.OpenAction = pk.make_indirect(js)
    pk.Root.AA = pikepdf.Dictionary(WC=pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=pikepdf.String("1")))
    names = pikepdf.Dictionary(JavaScript=pikepdf.Dictionary(Names=pikepdf.Array([pikepdf.String("a"), pk.make_indirect(js)])))
    pk.Root.Names = names
    pk.attachments["payload.exe"] = pikepdf.AttachedFileSpec(pk, b"MZ\x90\x00 nu e chiar un exe", mime_type="application/octet-stream")
    page = pk.pages[0].obj
    page.AA = pikepdf.Dictionary(O=pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=pikepdf.String("2")))
    launch = pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[0, 0, 50, 50],
                                A=pikepdf.Dictionary(S=pikepdf.Name.Launch, F=pikepdf.String("cmd.exe")))
    uri = pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[60, 0, 110, 50],
                             A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI=pikepdf.String("https://example.com")))
    att = pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.FileAttachment, Rect=[120, 0, 140, 20])
    page.Annots = pikepdf.Array([pk.make_indirect(launch), pk.make_indirect(uri), pk.make_indirect(att)])
    out = io.BytesIO()
    pk.save(out)
    return out.getvalue()


class SecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.server = uvicorn.Server(uvicorn.Config(appmain.app, host="127.0.0.1", port=cls.port, log_level="warning"))
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        for _ in range(100):
            if cls.server.started:
                break
            time.sleep(0.05)
        cls.tmp = Path(tempfile.mkdtemp())
        cls.sample = cls.tmp / "s.pdf"
        make_sample.build(str(cls.sample))

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=5)

    def call(self, method, path, data=None, headers=None):
        h = dict(headers or {})
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def upload(self, data, name="x.pdf"):
        st, _h, body = self.call("POST", "/api/open", data, {"X-Filename": name})
        return st, json.loads(body)

    def test_active_content_removed(self):
        st, meta = self.upload(malicious_pdf(), "troian.pdf")
        self.assertEqual(st, 200, meta)
        self.assertTrue(meta["removed"])
        orig = (Path(os.environ["DRAWCAD_DATA"]) / "docs" / meta["id"] / "original.pdf").read_bytes()
        pk = pikepdf.open(io.BytesIO(orig))
        self.assertNotIn("/OpenAction", pk.Root)
        self.assertNotIn("/AA", pk.Root)
        self.assertFalse("/Names" in pk.Root and "/JavaScript" in pk.Root.Names)
        self.assertEqual(len(pk.attachments), 0)
        page = pk.pages[0].obj
        self.assertNotIn("/AA", page)
        subtypes = [str(a.Subtype) for a in page.Annots]
        self.assertEqual(subtypes, ["/Link", "/Link"])  # the attachment is gone
        self.assertNotIn("/A", page.Annots[0])  # Launch removed
        self.assertEqual(str(page.Annots[1].A.S), "/URI")  # the web link stays
        # the export does not reintroduce anything
        st, _h, pdf = self.call("POST", f"/api/doc/{meta['id']}/export", {"filename": "e.pdf", "pages": {}, "removals": {}, "state": {"v": 1, "annots": []}})
        self.assertEqual(st, 200)
        self.assertNotIn(b"/JavaScript", pdf)
        self.assertNotIn(b"cmd.exe", pdf)

    def test_warm_reader_one_file_per_process(self):
        """The reader started ahead takes one file and ends; the next file gets another process."""
        def waiting_pid():
            for _ in range(200):
                p = appmain._warm.proc
                if p is not None:
                    return p.pid
                time.sleep(0.05)
            self.fail("no reader waiting")

        pid1 = waiting_pid()
        st, meta = self.upload(self.sample.read_bytes(), "a.pdf")
        self.assertEqual(st, 200, meta)
        pid2 = waiting_pid()
        self.assertNotEqual(pid1, pid2)
        for _ in range(100):  # the used one has ended
            try:
                os.kill(pid1, 0)
            except OSError:
                break
            time.sleep(0.05)
        else:
            self.fail("the reader that took the file is still running")
        st, meta = self.upload(self.sample.read_bytes(), "b.pdf")
        self.assertEqual(st, 200, meta)
        self.assertNotEqual(waiting_pid(), pid2)

    def test_warm_reader_without_job_falls_back(self):
        """A reader that cannot read its job (no stdin in some builds): the file is read cold, and the
        server stops starting readers ahead."""
        import sys

        real = appmain._child_cmd

        def fake(module, *args):
            if args[:1] == ("--serve",):
                return [sys.executable, "-c", f"import sys, time; time.sleep(2); sys.exit({appmain.NO_JOB})"]  # alive, never reads
            return real(module, *args)

        appmain._child_cmd = fake
        try:
            st, meta = self.upload(self.sample.read_bytes(), "c.pdf")  # takes a real reader; a fake one starts
            self.assertEqual(st, 200, meta)
            st, meta = self.upload(self.sample.read_bytes(), "d.pdf")  # the fake one: read again, cold
            self.assertEqual(st, 200, meta)
            self.assertTrue(appmain._warm.broken)
        finally:
            appmain._child_cmd = real
            appmain._warm.broken = False

    def test_allowed_hosts_and_health(self):
        """With DRAWCAD_ALLOWED_HOSTS other host names get 421, except the health check (the container's
        own check calls it as 127.0.0.1); the interface is served with Cache-Control: no-cache."""
        from starlette.testclient import TestClient

        old = appmain.ALLOWED_HOSTS
        appmain.ALLOWED_HOSTS = {"192.168.1.10", "unraid.local"}
        try:
            local = TestClient(appmain.app, base_url="http://127.0.0.1:8080")
            self.assertEqual(local.get("/api/health").status_code, 200)
            self.assertEqual(local.get("/api/docs").status_code, 421)
            ok = TestClient(appmain.app, base_url="http://unraid.local:8080")
            self.assertEqual(ok.get("/api/docs").status_code, 200)
            r = ok.get("/js/main.js")
            self.assertEqual(r.headers.get("cache-control"), "no-cache")
            self.assertEqual(ok.get("/js/main.js", headers={"If-None-Match": r.headers["etag"]}).status_code, 304)
        finally:
            appmain.ALLOWED_HOSTS = old

    def test_serve_job_checked(self):
        """--serve runs exactly one job of the usual arguments; anything else is refused."""
        import subprocess
        import sys

        run = lambda job: subprocess.run([sys.executable, "-m", "app.ingest", "--serve"], input=job, capture_output=True,  # noqa: E731
                                         text=True, cwd=str(Path(appmain.__file__).resolve().parents[1]), timeout=120)
        self.assertEqual(run("").returncode, appmain.NO_JOB)
        self.assertEqual(run('["--serve"]\n').returncode, appmain.NO_JOB)
        self.assertEqual(run('{"a": 1}\n').returncode, appmain.NO_JOB)
        out = self.tmp / "serve_out"
        out.mkdir(exist_ok=True)
        r = run(json.dumps([str(self.sample), str(out)]) + "\n")
        self.assertEqual(r.returncode, 0)
        self.assertTrue(json.loads(r.stdout)["ok"])
        self.assertTrue((out / "original.pdf").is_file())

    def test_clean_pdf_untouched(self):
        src = self.sample.read_bytes()
        out, rep = sanitize_pdf(src)
        self.assertEqual(rep, {})
        self.assertIs(out, src)

    def test_rejects_garbage_and_bombs(self):
        st, res = self.upload(b"MZ\x90\x00 executabil, nu desen" * 100, "virus.exe")
        self.assertEqual(st, 400)
        self.assertIn("error", res)
        st, res = self.upload(b"%PDF-1.7\n" + os.urandom(5000), "stricat.pdf")
        self.assertEqual(st, 400)
        # image over the megapixel limit (decompression bomb): rejected without decoding
        # (a reader started now sees the lowered limit; the one waiting was started with the old one)
        os.environ["DRAWCAD_MAX_IMAGE_MPX"] = "1"
        warm = appmain.WARM_WORKER
        appmain.WARM_WORKER = False
        try:
            b = io.BytesIO()
            Image.new("1", (3000, 2000)).save(b, format="PNG")
            st, res = self.upload(b.getvalue(), "bomba.png")
            self.assertEqual(st, 400)
            self.assertIn("prea mare", res["error"])
        finally:
            del os.environ["DRAWCAD_MAX_IMAGE_MPX"]
            appmain.WARM_WORKER = warm

    def test_dxf_inputs(self):
        """DXF uploads: a broken one is refused, a block bomb (nested inserts standing for 10^8 lines) and a
        block that contains itself are refused before drawing; a good one keeps its DXF next to the PDF."""
        import ezdxf

        st, res = self.upload(b"0\nSECTION\n2\nENTITIES\n" + os.urandom(5000), "stricat.dxf")
        self.assertEqual(st, 400)
        self.assertIn("error", res)
        # a "DWG" that is not one: refused (converted or not, depending on LibreDWG being here)
        st, res = self.upload(b"AC1032" + os.urandom(20000), "stricat.dwg")
        self.assertEqual(st, 400)

        def text(doc):
            s = io.StringIO()
            doc.write(s)
            return s.getvalue().encode()

        bomb = ezdxf.new()
        prev = None
        for i in range(8):
            b = bomb.blocks.new(f"B{i}")
            for k in range(10):
                if prev:
                    b.add_blockref(prev, (k, 0))
                else:
                    b.add_line((k, 0), (k, 1))
            prev = f"B{i}"
        bomb.modelspace().add_blockref(prev, (0, 0))
        st, res = self.upload(text(bomb), "bomba.dxf")
        self.assertEqual(st, 400)
        self.assertIn("prea mare", res["error"])
        loop = ezdxf.new()
        loop.blocks.new("A").add_blockref("A", (1, 0))
        loop.modelspace().add_blockref("A", (0, 0))
        st, res = self.upload(text(loop), "bucla.dxf")
        self.assertEqual(st, 400)
        good = ezdxf.new(units=4)
        good.modelspace().add_circle((0, 0), 20)
        st, meta = self.upload(text(good), "bun.dxf")
        self.assertEqual(st, 200, meta)
        self.assertEqual(meta["kind"], "dxf")
        self.assertEqual(meta["dxf"]["pages"][0]["scale"], 0.5)  # Ø40 on A4 at 2:1
        self.assertTrue((Path(os.environ["DRAWCAD_DATA"]) / "docs" / meta["id"] / "original.dxf").is_file())

    def test_upload_limits(self):
        old = appmain.MAX_UPLOAD
        appmain.MAX_UPLOAD = 1000
        try:
            st, res = self.upload(b"%PDF-" + b"0" * 5000)
            self.assertEqual(st, 413)
        finally:
            appmain.MAX_UPLOAD = old
        old_t = appmain.INGEST_TIMEOUT
        appmain.INGEST_TIMEOUT = 0.01
        try:
            st, res = self.upload(self.sample.read_bytes())
            self.assertEqual(st, 400)
            self.assertIn("durat", res["error"])
        finally:
            appmain.INGEST_TIMEOUT = old_t
        # nothing left in the upload folder
        inc = Path(os.environ["DRAWCAD_DATA"]) / "incoming"
        time.sleep(0.2)
        self.assertEqual([p for p in inc.iterdir()] if inc.exists() else [], [])

    def test_cross_site_requests_refused(self):
        st, _h, _b = self.call("POST", "/api/open", self.sample.read_bytes(), {"X-Filename": "a.pdf", "Origin": "http://rau.example"})
        self.assertEqual(st, 403)
        st, _h, _b = self.call("POST", "/api/open", self.sample.read_bytes(), {"X-Filename": "a.pdf", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(st, 403)
        st, _h, _b = self.call("POST", "/api/open", self.sample.read_bytes(), {"X-Filename": "a.pdf", "Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(st, 200)

    def test_security_headers(self):
        st, h, _b = self.call("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn("script-src 'self'", h["Content-Security-Policy"])
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        st, h, _b = self.call("GET", "/api/docs")
        self.assertIn("Content-Security-Policy", h)

    def test_optional_password(self):
        import base64

        old = appmain.AUTH_PASSWORD
        appmain.AUTH_PASSWORD = "secret"
        try:
            st, h, _b = self.call("GET", "/api/docs")
            self.assertEqual(st, 401)
            self.assertIn("Basic", h["WWW-Authenticate"])
            bad = base64.b64encode(b"drawcad:gresit").decode()
            self.assertEqual(self.call("GET", "/api/docs", headers={"Authorization": f"Basic {bad}"})[0], 401)
            good = base64.b64encode(b"drawcad:secret").decode()
            self.assertEqual(self.call("GET", "/api/docs", headers={"Authorization": f"Basic {good}"})[0], 200)
            self.assertEqual(self.call("GET", "/api/health")[0], 200)  # the container health check
        finally:
            appmain.AUTH_PASSWORD = old

    def test_allowed_hosts_block_dns_rebinding(self):
        """The desktop app: a site whose name points to 127.0.0.1 does not reach the server."""
        old = appmain.ALLOWED_HOSTS
        appmain.ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
        try:
            self.assertEqual(self.call("GET", "/api/docs")[0], 200)
            st, _h, _b = self.call("GET", "/api/docs", headers={"Host": "rebind.example.com:8080"})
            self.assertEqual(st, 421)
        finally:
            appmain.ALLOWED_HOSTS = old

    def test_private_mode_isolates_browsers(self):
        """In private mode, each browser sees only its own documents."""
        old = appmain.MODE
        appmain.MODE = "private"
        try:
            def cookie_of(h):
                for k, v in h.items():
                    if k.lower() == "set-cookie" and v.startswith("drawcad_ws="):
                        return v.split(";")[0]
                return None

            st, h, _b = self.call("GET", "/api/docs")
            ca = cookie_of(h)
            self.assertIsNotNone(ca)
            self.assertIn("HttpOnly", h["Set-Cookie"])
            self.assertIn("SameSite=Strict", h["Set-Cookie"])
            st, h, _b = self.call("GET", "/api/docs")
            cb = cookie_of(h)
            self.assertNotEqual(ca, cb)
            # A uploads a document
            st, _h, body = self.call("POST", "/api/open", self.sample.read_bytes(), {"X-Filename": "al-lui-A.pdf", "Cookie": ca})
            self.assertEqual(st, 200)
            doc = json.loads(body)
            self.assertNotIn("owner", doc)
            # A sees it, B does not
            names_a = [d["name"] for d in json.loads(self.call("GET", "/api/docs", headers={"Cookie": ca})[2])]
            names_b = [d["name"] for d in json.loads(self.call("GET", "/api/docs", headers={"Cookie": cb})[2])]
            self.assertIn("al-lui-A.pdf", names_a)
            self.assertNotIn("al-lui-A.pdf", names_b)
            for path in (f"/api/doc/{doc['id']}", f"/api/doc/{doc['id']}/page/0/render?scale=0.3", f"/api/doc/{doc['id']}/page/0/snap",
                         f"/api/doc/{doc['id']}/thumb"):
                self.assertEqual(self.call("GET", path, headers={"Cookie": cb})[0], 404, path)
                self.assertEqual(self.call("GET", path, headers={"Cookie": ca})[0], 200, path)
            self.assertEqual(self.call("DELETE", f"/api/doc/{doc['id']}", headers={"Cookie": cb})[0], 404)
            self.assertEqual(self.call("GET", f"/api/doc/{doc['id']}", headers={"Cookie": ca})[0], 200)
            # without a cookie (another new browser): not even that
            self.assertEqual(self.call("GET", f"/api/doc/{doc['id']}")[0], 404)
            # the space code can be moved to another browser, on request
            code = json.loads(self.call("GET", "/api/workspace", headers={"Cookie": ca})[2])["code"]
            st, h, _b = self.call("POST", "/api/workspace", {"code": code}, {"Cookie": cb})
            self.assertEqual(st, 200)
            moved = cookie_of(h)
            self.assertEqual(moved, ca)
            self.assertEqual(self.call("POST", "/api/workspace", {"code": "scurt"}, {"Cookie": cb})[0], 400)
        finally:
            appmain.MODE = old

    def test_bad_inputs_do_not_crash(self):
        st, meta = self.upload(self.sample.read_bytes(), "a.pdf")
        doc = meta["id"]
        st, _h, _b = self.call("GET", f"/api/doc/{doc}/page/0/render?scale=abc")
        self.assertEqual(st, 400)
        st, _h, _b = self.call("GET", f"/api/doc/{doc}/page/0/render?scale=0.5&bk=../../etc,1;rm")
        self.assertEqual(st, 200)
        bad = {"filename": 'a"\r\nSet-Cookie: x=1.pdf', "pages": {"0": [{"t": "T", "p": ["x", 1], "txt": 5}, {"t": "Q"}, "nu", {"t": "L", "p": [0, 0, 1e300, 1]}]},
               "removals": {"0": [{"mode": "objects", "ids": ["1", "../x"]}, {"mode": "zone", "rect": ["a"]}]}}
        st, h, pdf = self.call("POST", f"/api/doc/{doc}/export", bad)
        self.assertEqual(st, 200)
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertNotIn("\n", h["Content-Disposition"])
        self.assertIsNone(h.get("Set-Cookie"))
        st, _h, _b = self.call("POST", f"/api/doc/{doc}/state", b"[1,2", {"Content-Type": "application/json"})
        self.assertGreaterEqual(st, 400)
        st, _h, _b = self.call("GET", "/api/doc/..%2F..%2Fetc/state")
        self.assertGreaterEqual(st, 400)


if __name__ == "__main__":
    unittest.main()
