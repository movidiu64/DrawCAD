"""DrawCAD for the desktop (Windows): the app server starts locally, on 127.0.0.1, and
the interface opens in a native window (WebView2, via pywebview). Everything runs on the
computer, without internet; working documents live in %LOCALAPPDATA%\\DrawCAD.

Arguments:
  DrawCAD.exe [file.pdf]          opens the app (and the given file, e.g. from "Open with")
  DrawCAD.exe --server-only [--port N]   the server only (tests, or use from a browser)
  DrawCAD.exe --selftest [--report f.json]  full check without a window (CI)
  DrawCAD.exe --run-module app.ingest …   internal: the server's child processes
"""
from __future__ import annotations

import base64
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

APP = "DrawCAD"
PREFERRED_PORT = 47878  # fixed, so the settings kept by the window (localStorage) stay the same


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[1]


def data_root() -> Path:
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "drawcad"
    root.mkdir(parents=True, exist_ok=True)
    return root


def setup_env():
    base = base_dir()
    root = data_root()
    env = {
        "DRAWCAD_DATA": str(root / "data"),
        "DRAWCAD_MODE": "personal",
        "DRAWCAD_DESKTOP": "1",
        "DRAWCAD_ALLOWED_HOSTS": "127.0.0.1,localhost",
        # documents stay until you delete them from Recent
        "DRAWCAD_RETENTION_DAYS": "0",
        "OMP_THREAD_LIMIT": "1",
    }
    for k, v in env.items():
        os.environ.setdefault(k, v)
    if (base / "frontend").is_dir():
        os.environ.setdefault("DRAWCAD_FRONTEND", str(base / "frontend"))
        os.environ.setdefault("DRAWCAD_FONT", str(base / "frontend" / "fonts" / "osifont.ttf"))
    tess = base / "tesseract"
    exe = tess / ("tesseract.exe" if sys.platform == "win32" else "tesseract")
    if exe.is_file():
        os.environ.setdefault("DRAWCAD_TESSERACT", str(exe))
        os.environ.setdefault("TESSDATA_PREFIX", str(tess / "tessdata"))
        os.environ["PATH"] = str(tess) + os.pathsep + os.environ.get("PATH", "")
    dwg = base / "libredwg" / ("dwg2dxf.exe" if sys.platform == "win32" else "dwg2dxf")
    if dwg.is_file():
        os.environ.setdefault("DRAWCAD_DWG2DXF", str(dwg))
    backend = base / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def redirect_output():
    """A Windows app without a console has no standard output: messages go to a log file."""
    if sys.stdout is None or sys.stderr is None:
        log = open(data_root() / "drawcad.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log


# ---------------------------------------------------------------- server


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def health(port: int, timeout=1.5):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LocalServer:
    def __init__(self, port: int):
        import uvicorn

        from app.main import app

        self.port = port
        cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on", access_log=False)
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, name="drawcad-server", daemon=True)

    def start(self, timeout=30):
        self.thread.start()
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.server.started:
                return
            if not self.thread.is_alive():
                raise RuntimeError("serverul local nu a pornit")
            time.sleep(0.05)
        raise RuntimeError("serverul local nu a pornit la timp")

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=5)


def choose_port(requested: int | None):
    """(port, existing_server): the fixed port if it is free; if DrawCAD already runs on it,
    the new window connects to the same server; otherwise any free port."""
    port = requested or PREFERRED_PORT
    if port_free(port):
        return port, False
    h = health(port)
    if h and h.get("desktop"):
        return port, True
    return free_port(), False


def upload(port: int, path: str) -> str | None:
    p = Path(path)
    if not p.is_file():
        return None
    # the name (possibly with diacritics) goes as UTF-8 bytes in the header, as the page sends it
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/open", data=p.read_bytes(), method="POST",
        headers={"X-Filename": p.name.encode("utf-8").decode("latin-1")},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8")).get("id")
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- the window


class Bridge:
    """Functions called from the page (window.pywebview.api): saving with the system dialog."""

    def __init__(self):
        # prefixed with "_": pywebview exposes to the page everything public in this object and walks
        # attributes recursively; through the window it reached the window's .NET objects (thousands of
        # levels, "maximum recursion depth"), which froze startup and every page load
        self._window = None

    def save_file(self, name, b64):
        import webview

        ext = os.path.splitext(name)[1].lower()
        types = {
            ".pdf": ("Document PDF (*.pdf)",),
            ".dxf": ("Desen DXF (*.dxf)",),
            ".zip": ("Arhivă ZIP (*.zip)",),
        }.get(ext, ("Toate fișierele (*.*)",))
        kind = getattr(getattr(webview, "FileDialog", None), "SAVE", None)
        if kind is None:
            kind = webview.SAVE_DIALOG
        try:
            res = self._window.create_file_dialog(kind, save_filename=name, file_types=types)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Dialogul de salvare nu s-a deschis: {e}"}
        if not res:
            return {"ok": False}
        path = res[0] if isinstance(res, (list, tuple)) else res
        if ext and not str(path).lower().endswith(ext):
            path = f"{path}{ext}"
        try:
            with open(path, "wb") as f:
                f.write(base64.b64decode(b64))
        except OSError as e:
            return {"ok": False, "error": f"Nu s-a putut scrie fișierul: {e}"}
        return {"ok": True, "name": os.path.basename(path), "path": str(path)}


def open_window(url: str) -> bool:
    """The native window. Returns False if it could not be opened (e.g. WebView2 is missing)."""
    try:
        import webview
    except Exception:  # noqa: BLE001
        return False
    try:
        webview.settings["ALLOW_DOWNLOADS"] = True
    except Exception:  # noqa: BLE001
        pass
    bridge = Bridge()
    try:
        win = webview.create_window(APP, url, js_api=bridge, width=1440, height=900, min_size=(900, 600))
        bridge._window = win
        kw = {"private_mode": False, "storage_path": str(data_root() / "webview")}
        if sys.platform == "win32":
            kw["gui"] = "edgechromium"  # never the old IE engine: it does not understand the interface
        webview.start(**kw)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"native window failed: {e}", file=sys.stderr)
        return False


def browser_fallback(url: str):
    """Without WebView2: the interface opens in the default browser, and a small window keeps
    the server running until you close it."""
    import webbrowser

    webbrowser.open(url)
    try:
        import tkinter as tk

        root = tk.Tk()
        root.title(APP)
        root.geometry("420x150")
        tk.Label(root, text="DrawCAD rulează în browser.", font=("Segoe UI", 11, "bold")).pack(pady=(18, 4))
        tk.Label(root, text=f"Adresa: {url}\nÎnchide această fereastră ca să oprești aplicația.").pack()
        tk.Button(root, text="Deschide din nou", command=lambda: webbrowser.open(url)).pack(pady=8)
        root.mainloop()
    except Exception:  # noqa: BLE001
        while True:  # no GUI: the server keeps running
            time.sleep(3600)


# ---------------------------------------------------------------- autotest


def _sample_pdf() -> bytes:
    import io

    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=landscape(A4))
    c.setLineWidth(0.7)
    c.rect(56, 56, 730, 480)
    c.circle(420, 300, 80)
    c.line(300, 300, 540, 300)
    c.setFont("Helvetica", 14)
    c.drawString(600, 90, "Material: 42CrMo4")
    c.drawString(600, 70, "Scara 1:1")
    c.showPage()
    c.save()
    return buf.getvalue()


def selftest(report: str | None) -> int:
    """Checks the whole chain in the package: reading in a separate process, rendering, OCR with the bundled
    Tesseract, PDF and DXF export, vectorization of a scan."""
    import io

    out = {"ok": False, "steps": {}}
    srv = None
    try:
        port = free_port()
        srv = LocalServer(port)
        srv.start()
        base = f"http://127.0.0.1:{port}"

        def call(method, path, data=None, headers=None, raw=False):
            h = dict(headers or {})
            body = data
            if isinstance(data, (dict, list)):
                body = json.dumps(data).encode()
                h["Content-Type"] = "application/json"
            r = urllib.request.Request(base + path, data=body, method=method, headers=h)
            with urllib.request.urlopen(r, timeout=300) as resp:
                b = resp.read()
                return (b, resp.headers) if raw else json.loads(b.decode("utf-8"))

        st = out["steps"]
        st["health"] = call("GET", "/api/health")
        for _ in range(90):  # OCR language detection runs in the background at startup
            if not st["health"].get("ocrPending"):
                break
            time.sleep(1)
            st["health"] = call("GET", "/api/health")
        pdf = _sample_pdf()
        meta = call("POST", "/api/open", pdf, {"X-Filename": "autotest.pdf"})
        st["open"] = {"id": meta["id"], "pages": len(meta["pages"])}
        png, _h = call("GET", f"/api/doc/{meta['id']}/page/0/render?scale=1", raw=True)
        st["render"] = png[:4] == b"\x89PNG"
        if st["health"].get("ocr"):
            res = call("POST", f"/api/doc/{meta['id']}/page/0/ocr", {})["ocr"]
            texts = [ln["text"] for ln in res["lines"]]
            st["ocr"] = {"lang": res["lang"], "texts": texts, "ok": any("42CrMo4" in t for t in texts)}
        else:
            st["ocr"] = {"ok": False, "error": "Tesseract missing"}
        data, h = call("POST", f"/api/doc/{meta['id']}/export", {"filename": "a.pdf", "ocrLayer": True}, raw=True)
        st["export_pdf"] = data[:5] == b"%PDF-"
        data, h = call("POST", f"/api/doc/{meta['id']}/export", {"format": "dxf", "filename": "a"}, raw=True)
        st["export_dxf"] = data.startswith(b"  0\nSECTION") and h.get("X-Export-Kind") == "dxf"
        # a "scan": the page rendered as an image → read as an image, then DXF with vectorization
        import pypdfium2 as pdfium

        img = pdfium.PdfDocument(pdf)[0].render(scale=200 / 72).to_pil().convert("L")
        b = io.BytesIO()
        img.save(b, format="PNG", dpi=(200, 200))
        smeta = call("POST", "/api/open", b.getvalue(), {"X-Filename": "scan.png"})
        data, h = call("POST", f"/api/doc/{smeta['id']}/export", {"format": "dxf", "filename": "s"}, raw=True)
        stats = json.loads(h.get("X-Dxf-Stats") or "{}").get("0", {})
        st["scan_dxf"] = {"ok": bool(stats.get("scan")) and stats.get("cercuri", 0) >= 1, "stats": stats}
        try:
            import webview  # noqa: F401

            st["webview"] = True
        except Exception as e:  # noqa: BLE001
            st["webview"] = f"missing: {e}"
        out["ok"] = all([
            st["render"], st["ocr"]["ok"], st["export_pdf"], st["export_dxf"], st["scan_dxf"]["ok"], st["webview"] is True,
        ])
    except Exception as e:  # noqa: BLE001
        import traceback

        out["error"] = f"{e}\n{traceback.format_exc()}"
    finally:
        if srv:
            srv.stop()
    txt = json.dumps(out, ensure_ascii=False, indent=2)
    if report:
        Path(report).write_text(txt, "utf-8")
    if sys.stdout is not None:
        print(txt)
    return 0 if out["ok"] else 1


# ---------------------------------------------------------------- entry point


def run_module(name: str, args: list[str]) -> int:
    import importlib

    if name not in ("app.ingest", "app.vectorize"):
        return 2
    mod = importlib.import_module(name)
    return int(mod.main([name, *args]) or 0)


def main(argv: list[str]) -> int:
    # the server's child processes: first thing, nothing graphical
    if len(argv) > 2 and argv[1] == "--run-module":
        setup_env()
        return run_module(argv[2], argv[3:])
    redirect_output()
    import logging

    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s: %(message)s", stream=sys.stderr)
    log = logging.getLogger("drawcad")
    t_start = time.time()
    setup_env()
    args = argv[1:]
    if "--selftest" in args:
        rep = args[args.index("--report") + 1] if "--report" in args else None
        return selftest(rep)
    port_arg = int(args[args.index("--port") + 1]) if "--port" in args else None
    if "--server-only" in args:
        srv = LocalServer(port_arg or PREFERRED_PORT)
        srv.start()
        print(f"DrawCAD: http://127.0.0.1:{srv.port}/", flush=True)
        try:
            while srv.thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            srv.stop()
        return 0
    files = [a for a in args if not a.startswith("--")]
    port, existing = choose_port(port_arg)
    srv = None
    if not existing:
        srv = LocalServer(port)
        srv.start()
    took = time.time() - t_start
    if took > 5:
        log.warning("slow start: the server was ready after %.1f s", took)
    url = f"http://127.0.0.1:{port}/"
    if files:
        doc_id = upload(port, files[0])
        if doc_id:
            url += f"#doc={doc_id}"
    try:
        if not open_window(url):
            browser_fallback(url)
    finally:
        if srv:
            time.sleep(0.4)  # the last save sent when the window closes
            srv.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
