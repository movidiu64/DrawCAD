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
st, _h, _ = call("POST", "/api/open", malicious_pdf(), {"X-Filename": "a.pdf", "Origin": "http://rau.example"})
assert st == 403, st
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
