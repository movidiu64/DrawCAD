"""Security check on the running container: crafted files and cross-site requests.
Run: python tools/security_smoke.py http://127.0.0.1:8080"""
import io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from tests.test_security import malicious_pdf  # noqa: E402

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8080"


import http.cookiejar  # noqa: E402

# like a browser: keeps the workspace cookie (the default mode is "private")
_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))


def call(method, path, data=None, headers=None, opener=None):
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with (opener or _opener).open(r, timeout=180) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


st, h, _ = call("GET", "/")
assert st == 200 and "script-src 'self'" in h.get("Content-Security-Policy", ""), "CSP missing"
st, _h, body = call("POST", "/api/open", malicious_pdf(), {"X-Filename": "troian.pdf"})
meta = json.loads(body)
assert st == 200 and meta.get("removed"), meta
st, _h, pdf = call("POST", f"/api/doc/{meta['id']}/export", json.dumps({"filename": "e.pdf", "pages": {}, "removals": {}}).encode(), {"Content-Type": "application/json"})
assert st == 200 and b"/JavaScript" not in pdf and b"cmd.exe" not in pdf, "active content in the export"
st, _h, _ = call("POST", "/api/open", b"MZ" + os.urandom(4000), {"X-Filename": "virus.exe"})
assert st == 400, st
st, _h, _ = call("POST", "/api/open", b"%PDF-1.7\n" + os.urandom(20000), {"X-Filename": "stricat.pdf"})
assert st == 400, st
st, _h, _ = call("POST", "/api/open", b"0\nSECTION\n2\nENTITIES\n" + os.urandom(20000), {"X-Filename": "stricat.dxf"})
assert st == 400, st
# a DXF block bomb: 8 levels of 10 nested inserts (10^8 lines), refused before drawing
_dxf = ["0\nSECTION\n2\nBLOCKS"]
for _i in range(8):
    _dxf.append(f"0\nBLOCK\n8\n0\n2\nB{_i}\n70\n0\n10\n0\n20\n0\n30\n0\n3\nB{_i}")
    for _k in range(10):
        _dxf.append(f"0\nINSERT\n8\n0\n2\nB{_i - 1}\n10\n{_k}\n20\n0\n30\n0" if _i else f"0\nLINE\n8\n0\n10\n{_k}\n20\n0\n30\n0\n11\n{_k}\n21\n1\n31\n0")
    _dxf.append("0\nENDBLK\n8\n0")
_dxf += ["0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n8\n0\n2\nB7\n10\n0\n20\n0\n30\n0\n0\nENDSEC\n0\nEOF\n"]
st, _h, body = call("POST", "/api/open", "\n".join(_dxf).encode(), {"X-Filename": "bomba.dxf"})
assert st == 400 and b"prea mare" in body, (st, body[:200])
st, _h, _ = call("POST", "/api/open", malicious_pdf(), {"X-Filename": "a.pdf", "Origin": "http://rau.example"})
assert st == 403, st
# images placed on a drawing: SVG (active content), a decompression bomb and a renamed executable are refused
_bomb = io.BytesIO()
from PIL import Image  # noqa: E402

Image.new("1", (40000, 40000)).save(_bomb, "PNG")
for bad in (b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", _bomb.getvalue(), b"MZ" + os.urandom(3000)):
    st, _h, _ = call("POST", f"/api/doc/{meta['id']}/images", bad)
    assert st == 400, f"image accepted: {st}"
st, _h, _ = call("POST", f"/api/doc/{meta['id']}/images", b"\x89PNG\r\n\x1a\n", {"Origin": "http://rau.example"})
assert st == 403, st
st, _h, _ = call("GET", f"/api/doc/{meta['id']}/image/../../meta.json")
assert st == 404, st
# fonts for DXF / DWG: a cross-site upload is refused; a font that is not one (or a renamed executable)
# is refused by the limited process; on a shared server nobody adds fonts from the browser
st, _h, _ = call("POST", "/api/fonts", b"\x00\x01\x00\x00", {"X-Filename": "a.ttf", "Origin": "http://rau.example"})
assert st == 403, st
_fonts = json.loads(call("GET", "/api/fonts")[2])
for name, bad in (("a.ttf", b"\x00\x01\x00\x00" + os.urandom(3000)), ("b.shx", b"MZ" + os.urandom(3000)), ("c.exe", b"MZ")):
    st, _h, _ = call("POST", "/api/fonts", bad, {"X-Filename": name})
    assert st == (400 if _fonts["editable"] else 403), f"font accepted: {name} {st}"
st, _h, _ = call("DELETE", "/api/fonts?name=../meta.json")
assert st in (403, 404), st
st, _h, _ = call("GET", "/api/health")
assert st == 200, "the server must keep working"
mode = json.loads(call("GET", "/api/health")[2]).get("mode")
if mode in ("private", "session"):
    # another browser (without the first one's cookie) does not see and cannot open the document
    other = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    st, _h, _ = call("GET", f"/api/doc/{meta['id']}", opener=other)
    assert st == 404, f"document visible from another browser: {st}"
    st, _h, lst = call("GET", "/api/docs", opener=other)
    assert meta["id"] not in lst.decode(), "document listed for another browser"
    print(f"isolation between browsers ({mode}): OK")
print("security: OK", meta["removed"])
_ = io

# the interface works with the strict CSP (no eval, no inline scripts): opens a drawing,
# adds a dimension and checks that no console errors appear
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None
if sync_playwright:
    import tempfile

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import make_sample

    tmp = Path(tempfile.mkdtemp()) / "s.pdf"
    make_sample.build(str(tmp))
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1400, "height": 900})
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(BASE + "/")
        pg.set_input_files("#fileInput", str(tmp))
        pg.wait_for_selector("#docName:has-text('s.pdf')", timeout=30000)
        pg.wait_for_timeout(1500)
        pg.keyboard.press("t")
        pg.mouse.click(700, 450)
        pg.wait_for_timeout(500)
        b.close()
    assert not errors, errors
    print("interface under CSP: OK")
