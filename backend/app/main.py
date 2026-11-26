"""HTTP server: document API + static frontend."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from urllib.parse import quote

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import pdfcore

def _env(name, default):
    """DRAWCAD_<name>, with COTARE_<name> still accepted (the app's old name)."""
    return os.environ.get(f"DRAWCAD_{name}") or os.environ.get(f"COTARE_{name}") or default


DATA_DIR = Path(_env("DATA", "/data"))
FRONTEND_DIR = Path(_env("FRONTEND", Path(__file__).resolve().parents[2] / "frontend"))
MAX_UPLOAD = int(_env("MAX_UPLOAD_MB", "200")) * 1024 * 1024
MAX_IMAGE_UPLOAD = int(_env("MAX_IMAGE_MB", "40")) * 1024 * 1024  # an image placed on a drawing
MAX_RENDER_PX = int(_env("MAX_RENDER_PX", "12000"))
# a whole-page render: at most this many megapixels (the bitmap has 3 bytes per pixel);
# the interface asks for at most ~20 MP, high-zoom details come separately, as tiles
MAX_RENDER_MP = float(_env("MAX_RENDER_MP", "40"))
# documents unused for this many days are deleted automatically (0 = never)
RETENTION_DAYS = float(_env("RETENTION_DAYS", "30"))

# mode:
#   private  — each browser has its own document space (permanent cookie, 1 year) (default)
#   personal — a single user: all documents are visible from any browser
#   session  — like private, but the space lasts only until the browser is closed
MODE = str(_env("MODE", "private")).strip().lower()
if MODE not in ("personal", "private", "session"):
    MODE = "private"
WS_COOKIE = "drawcad_ws"
_WS_RE = re.compile(r"^[A-Za-z0-9_-]{24,64}$")

DOCS = DATA_DIR / "docs"
# the desktop app (Windows): serves locally only and answers only to these host names
DESKTOP = str(_env("DESKTOP", "")).strip() == "1"


def _git_commit(root: Path) -> str:
    """Short commit of a git checkout (read from .git, no git program needed), or ""."""
    try:
        g = root / ".git"
        head = (g / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref:"):
            return head[:7]
        ref = head[4:].strip()
        f = g / ref
        if f.is_file():
            return f.read_text(encoding="utf-8").strip()[:7]
        for line in (g / "packed-refs").read_text(encoding="utf-8").splitlines():
            if line.endswith(" " + ref):
                return line[:7]
    except OSError:
        pass
    return ""


def _version() -> str:
    """App version, shown in Settings: frontend/version.txt written by the build (a release tag in CI,
    or VERSION + build time in an image built from source); in a checkout, VERSION + the commit."""
    try:
        v = (FRONTEND_DIR / "version.txt").read_text(encoding="utf-8").strip()[:60]
        if v and v != "dev":
            return v
    except OSError:
        pass
    root = FRONTEND_DIR.parent
    try:
        base = (root / "VERSION").read_text(encoding="utf-8").strip()[:30]
    except OSError:
        return "dev"
    sha = _git_commit(root)
    return f"{base} ({sha})" if sha else base or "dev"


VERSION = _version()
ALLOWED_HOSTS = {h.strip().lower() for h in _env("ALLOWED_HOSTS", "").split(",") if h.strip()}


def _child_cmd(module: str, *args) -> list[str]:
    """Command for a Python child process (file reading, vectorization). In the packaged
    app (PyInstaller) there is no `python -m`: the executable gets `--run-module`."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--run-module", module, *map(str, args)]
    return [sys.executable, "-m", module, *map(str, args)]


def _child_kw() -> dict:
    kw = {}
    if sys.platform == "win32":
        import subprocess as _sp

        kw["creationflags"] = _sp.CREATE_NO_WINDOW  # no console window flashing
    return kw
_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_OID_RE = re.compile(r"^\d{1,6}(\.\d{1,6}){0,8}$")  # id of an object on the page: "12" or "3.4.1"


class LRU(OrderedDict):
    """LRU cache limited by number of entries and, optionally, by memory (bytes)."""

    def __init__(self, size, max_bytes=None):
        super().__init__()
        self.size = size
        self.max_bytes = max_bytes
        self.nbytes = 0

    @staticmethod
    def _sz(val):
        return len(val) if isinstance(val, (bytes, bytearray)) else 0

    def get_or(self, key, fn):
        if key in self:
            self.move_to_end(key)
            return self[key]
        val = fn()
        if self.max_bytes and self._sz(val) > self.max_bytes // 2:
            return val  # too big for the cache
        self[key] = val
        self.nbytes += self._sz(val)
        while len(self) > self.size or (self.max_bytes and self.nbytes > self.max_bytes and len(self) > 1):
            _k, old = self.popitem(last=False)
            self.nbytes -= self._sz(old)
        return val

    def pop(self, key, default=None):
        val = super().pop(key, default)
        if val is not default:
            self.nbytes -= self._sz(val)
        return val


# total memory of the in-RAM caches (working PDFs, renders, blackened pages); it is a limit,
# not a reservation: it only fills up with what is used
CACHE_MB = int(_env("CACHE_MB", "256"))
_bytes_cache = LRU(8, CACHE_MB * 1024 * 1024 * 2 // 5)
_render_cache = LRU(64, CACHE_MB * 1024 * 1024 * 2 // 5)
# snap geometry / page texts: kept as ready-serialized JSON (a Python object with tens of thousands
# of points takes ~10× more than its text), with a memory budget
_snap_cache = LRU(32, 64 * 1024 * 1024)
_ink_cache = LRU(8, CACHE_MB * 1024 * 1024 // 5)


def _source(doc_id, n, ink):
    """The PDF to render: the original, or the original with page n blackened (result kept in cache)."""
    if not (ink and ink.get("all")):
        return _original(doc_id)
    key = (doc_id, n, str(ink.get("fills", "black")), bool(ink.get("images")))
    return _ink_cache.get_or(key, lambda: pdfcore.ink_pdf(_original(doc_id), {n}, key[2], key[3]))


def _owner_of(token: str) -> str:
    import hashlib

    return hashlib.sha256(("drawcad-ws:" + token).encode()).hexdigest()[:32]


def _req_owner(request: Request):
    """Owner of the request in the private modes (hash of the workspace code), otherwise None."""
    return request.scope.get("state", {}).get("owner") if MODE != "personal" else None


def _err(msg, code=400):
    return JSONResponse({"error": msg}, status_code=code)


def _doc_dir(doc_id: str) -> Path:
    if not _ID_RE.match(doc_id or ""):
        raise ValueError("id invalid")
    d = DOCS / doc_id
    if not d.is_dir():
        raise FileNotFoundError(doc_id)
    return d


_LAYOUTS: dict = {}  # doc_id → page order / rotation (None = as in the file)


def _layout(doc_id: str):
    if doc_id not in _LAYOUTS:
        lay = (_read_json(_doc_dir(doc_id) / "meta.json", {}) or {}).get("layout")
        _LAYOUTS[doc_id] = lay if isinstance(lay, list) and lay else None
    return _LAYOUTS[doc_id]


def _dxf_page_info(meta: dict) -> None:
    """For a drawing opened from DXF / DWG, each page says where it comes from: `src` (page of the
    uploaded file), `name` (the layout, or Model) and `dscale` (the drawing scale of that layout, after
    the sheet resizes made in the editor)."""
    dxf = meta.get("dxf")
    if not isinstance(dxf, dict) or not dxf.get("pages"):
        return
    pages = meta.get("pages") or []
    lay = meta.get("layout") if isinstance(meta.get("layout"), list) and meta.get("layout") else [{"src": i} for i in range(len(pages))]
    for i, p in enumerate(pages):
        it = lay[i] if i < len(lay) else {"src": i}
        src = int(it.get("src", i))
        k = float(it.get("scale", 1) or 1)
        dp = dxf["pages"][src] if 0 <= src < len(dxf["pages"]) else None
        p["src"] = src
        if dp:
            p["name"] = str(dp.get("name", ""))[:80]
            p["dscale"] = round(float(dp.get("scale", 1)) / k, 9)


_HIDDEN: dict = {}


def _hidden_layers(doc_id: str) -> list[str]:
    """Layers of a drawing opened from DXF / DWG hidden in the editor."""
    if doc_id not in _HIDDEN:
        dxf = (_read_json(_doc_dir(doc_id) / "meta.json", {}) or {}).get("dxf") or {}
        h = dxf.get("hidden")
        _HIDDEN[doc_id] = [x for x in h if isinstance(x, str)] if isinstance(h, list) else []
    return _HIDDEN[doc_id]


def _hidden_ids(doc_id: str, hidden: list[str]) -> dict[int, list[int]]:
    """Per page of the uploaded file: the PDF objects drawn on the hidden layers."""
    lm = _read_json(_doc_dir(doc_id) / "original.dxflayers.json", {}) or {}
    names = lm.get("names") or []
    want = {i for i, n in enumerate(names) if n in set(hidden)}
    out = {}
    for p, row in enumerate(lm.get("pages") or []):
        if row:
            out[p] = [i for i, li in enumerate(row) if li in want]
    return out


def _original(doc_id: str) -> bytes:
    """The working PDF: the uploaded file, with pages rotated / reordered / deleted in the editor (and,
    for a DXF / DWG, the hidden layers made invisible). Everything else (render, snap, removals, OCR,
    export) works on it, so rotation is kept on export too."""
    def raw():
        d = _doc_dir(doc_id)
        color = d / "original-color.pdf"
        dxf = (_read_json(d / "meta.json", {}) or {}).get("dxf") or {}
        data = (color if dxf.get("colors") and color.is_file() else d / "original.pdf").read_bytes()
        hidden = _hidden_layers(doc_id)
        return pdfcore.hide_objects(data, _hidden_ids(doc_id, hidden)) if hidden else data

    lay = _layout(doc_id)
    if not lay:
        return _bytes_cache.get_or(doc_id, raw)
    return _bytes_cache.get_or((doc_id, "L"), lambda: pdfcore.apply_layout(raw(), lay))


def _purge(doc_id: str):
    """Forgets everything computed for the document (after deletion or after rotating pages)."""
    _bytes_cache.pop(doc_id, None)
    _bytes_cache.pop((doc_id, "L"), None)
    _LAYOUTS.pop(doc_id, None)
    _HIDDEN.pop(doc_id, None)
    for c in (_render_cache, _ink_cache, _snap_cache, _text_cache):
        for k in [k for k in c if isinstance(k, tuple) and (k[0] == doc_id or (len(k) > 1 and k[1] == doc_id))]:
            c.pop(k, None)


def _pkey(doc_id: str, n: int) -> str:
    """Cache file names (OCR, vectorization) of a page: tied to the page in the uploaded
    file and to its rotation, not to its current position (which changes on reordering)."""
    lay = _layout(doc_id)
    if not lay or n >= len(lay):
        return f"p{n}"
    it = lay[n]
    rot = int(it.get("rot", 0)) % 360
    k = float(it.get("scale", 1) or 1)
    return f"p{int(it['src'])}" + (f"r{rot}" if rot else "") + (f"s{k:g}" if abs(k - 1) > 1e-9 else "")


def _read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    tmp.replace(path)


def _page_index(doc_id, n):
    meta = _read_json(_doc_dir(doc_id) / "meta.json", {})
    n = int(n)
    if n < 0 or n >= len(meta.get("pages", [])):
        raise IndexError("pagină inexistentă")
    return n, meta


# ------------------------------------------------------------------ validation of incoming data

def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e7


PRIM_TYPES = {"L", "P", "R", "C", "T", "I"}
_IMG_RE = re.compile(r"^[a-f0-9]{24}$")
_IMG_FILE_RE = re.compile(r"^[a-f0-9]{24}\.(png|jpg)$")


def _clean_prims(prims):
    """Primitives to draw on export: only known types, finite numbers, reasonable sizes."""
    if not isinstance(prims, list) or len(prims) > 200000:
        raise ValueError("prea multe primitive")
    out = []
    for p in prims:
        if not isinstance(p, dict) or p.get("t") not in PRIM_TYPES:
            continue
        pts = p.get("p")
        if not isinstance(pts, list) or len(pts) > 100000 or not all(_finite(v) for v in pts):
            continue
        q = {"t": p["t"], "p": pts, "c": str(p.get("c", "add"))[:16]}
        for k in ("w", "r", "s", "a"):
            if k in p and _finite(p[k]):
                q[k] = p[k]
        for k in ("close", "fill", "nostroke", "cover"):
            if p.get(k):
                q[k] = True
        dp = p.get("dp")
        if isinstance(dp, list) and len(dp) <= 16 and all(_finite(v) and v >= 0 for v in dp):
            q["dp"] = dp
        if p["t"] == "T":
            q["txt"] = str(p.get("txt", ""))[:2000]
        if p.get("cap") == "round":
            q["cap"] = "round"
        if p.get("blend") == "multiply":
            q["blend"] = "multiply"
        if p["t"] != "I" and _finite(p.get("op")):
            q["op"] = min(1.0, max(0.05, float(p["op"])))
        if p["t"] == "I":
            # an image annotation: its id only (the server finds the file); quarter turns; opacity
            if not _IMG_RE.match(str(p.get("img", ""))) or len(pts) != 4:
                continue
            q["img"] = p["img"]
            q["rot"] = int(p.get("rot", 0)) % 360 if _finite(p.get("rot", 0)) and int(p.get("rot", 0)) % 90 == 0 else 0
            q["op"] = min(1.0, max(0.05, float(p["op"]))) if _finite(p.get("op")) else 1.0
        out.append(q)
    return out


def _clean_ops(ops):
    """Removal / blackening operations: known modes, valid ids and rectangles."""
    if not isinstance(ops, list) or len(ops) > 2000:
        raise ValueError("prea multe operații")
    out = []
    for op in ops:
        if not isinstance(op, dict):
            continue
        mode = op.get("mode")
        if mode in ("objects", "black"):
            ids = [i for i in (op.get("ids") or []) if isinstance(i, str) and _OID_RE.match(i)][:100000]
            out.append({"mode": mode, "ids": ids})
        elif mode in ("text", "zone"):
            r = op.get("rect")
            if isinstance(r, list) and len(r) == 4 and all(_finite(v) for v in r):
                out.append({"mode": mode, "rect": r})
    return out


# ------------------------------------------------------------------ API


INGEST_TIMEOUT = float(_env("INGEST_TIMEOUT_S", "120"))
INCOMING = DATA_DIR / "incoming"


async def _read_limited(request: Request, limit: int, dest: Path | None = None):
    """Reads the request body as a stream, stopping at `limit` bytes (without keeping it all in memory
    when it goes to a file). Returns the bytes or the number of bytes written."""
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > limit:
        raise OverflowError
    n = 0
    chunks = []
    fh = dest.open("wb") if dest else None
    try:
        async for chunk in request.stream():
            n += len(chunk)
            if n > limit:
                raise OverflowError
            if fh:
                fh.write(chunk)
            else:
                chunks.append(chunk)
    finally:
        if fh:
            fh.close()
    return n if dest else b"".join(chunks)


async def _json_body(request: Request, limit: int = 16 * 1024 * 1024):
    raw = await _read_limited(request, limit)
    return json.loads(raw or b"null")


async def api_open(request: Request):
    name = request.headers.get("x-filename", "document.pdf")
    try:
        name = bytes(name, "latin-1").decode("utf-8")
    except Exception:
        pass
    name = re.sub(r"[\x00-\x1f\x7f]", "", os.path.basename(name))[:200] or "document.pdf"
    dpi_h = request.headers.get("x-dpi") or ""
    try:
        dpi_v = float(dpi_h) if dpi_h else None
        if dpi_v is not None and not (30 <= dpi_v <= 4800):
            dpi_v = None
    except ValueError:
        dpi_v = None
    INCOMING.mkdir(parents=True, exist_ok=True)
    tmp_id = uuid.uuid4().hex
    upload = INCOMING / f"{tmp_id}.bin"
    try:
        try:
            size = await _read_limited(request, MAX_UPLOAD, upload)
        except OverflowError:
            return _err(f"Fișier prea mare (limita e {MAX_UPLOAD // (1024 * 1024)} MB)", 413)
        if not size:
            return _err("Fișier gol")
        return await _ingest(request, upload, name, dpi_v)
    finally:
        upload.unlink(missing_ok=True)


async def _ingest(request: Request, upload: Path, name: str, dpi_v=None, units: int | None = None, kind: str | None = None):
    """A file read in the limited process and kept as a new document. `units`: a DXF / DWG read again in
    these drawing units ($INSUNITS code); `kind`: the kind shown (a DWG read again from its DXF)."""
    out_dir = INCOMING / uuid.uuid4().hex
    try:
        out_dir.mkdir()
        # an unknown file is first read in a separate process, limited in memory and time
        proc = await asyncio.create_subprocess_exec(
            *_child_cmd("app.ingest", upload, out_dir, dpi_v or "", units or ""),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=str(Path(__file__).resolve().parents[1]), **_child_kw(),
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), INGEST_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return _err(f"Fișier respins: citirea a durat peste {INGEST_TIMEOUT:g} s")
        try:
            res = json.loads(out.decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            res = {}
        if not res:
            # the child also writes the result to a file (on Windows, an app without a console may
            # lose its standard output)
            res = _read_json(out_dir / "result.json", {}) or {}
        if not res.get("ok"):
            if not res and proc.returncode:
                return _err("Fișier respins: biblioteca de citire s-a oprit (fișier corupt sau construit special)")
            return _err(res.get("error") or "Fișier respins")
        doc_id = uuid.uuid4().hex
        d = DOCS / doc_id
        d.mkdir(parents=True)
        (out_dir / "original.pdf").replace(d / "original.pdf")
        for f in ("original.dxf", "original.dxfmap.json", "original.dxflayers.json"):
            if (out_dir / f).is_file():
                (out_dir / f).replace(d / f)
        if (out_dir / "images").is_dir():
            (d / "images").mkdir(exist_ok=True)
            for f in (out_dir / "images").iterdir():
                if _IMG_FILE_RE.match(f.name):
                    f.replace(d / "images" / f.name)
        state = res.get("state")
        meta = {
            "id": doc_id,
            "name": name,
            "kind": kind or res["kind"],
            "dpi": res.get("dpi"),
            "created": time.time(),
            "updated": time.time(),
            "pages": res["pages"],
            "owner": _req_owner(request),
            "fromExport": state is not None,
            "removed": res.get("removed") or {},
        }
        if res.get("dxf"):
            meta["dxf"] = res["dxf"]
            _dxf_page_info(meta)
        _write_json(d / "meta.json", meta)
        if state is not None:
            _write_json(d / "state.json", state)
        return JSONResponse({**{k: v for k, v in meta.items() if k != "owner"}, "expires": _expires(meta), "state": state})
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


async def api_dxf_units(request: Request):
    """A drawing opened from DXF / DWG read again in other units (mm or inch): a new document, the
    same drawing with its $INSUNITS changed (for a drawing made from an inch template but drawn in mm)."""
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    meta = _read_json(d / "meta.json", {}) or {}
    if not meta.get("dxf") or not (d / "original.dxf").is_file():
        return _err("Documentul nu e un desen DXF / DWG")
    try:
        body = await _json_body(request, 1024)
    except (OverflowError, ValueError):
        return _err("Cerere invalidă")
    code = {"mm": 4, "in": 1}.get(str((body or {}).get("units", "")))
    if code is None:
        return _err("Unități necunoscute")
    INCOMING.mkdir(parents=True, exist_ok=True)
    upload = INCOMING / f"{uuid.uuid4().hex}.bin"
    try:
        shutil.copyfile(d / "original.dxf", upload)
        return await _ingest(request, upload, meta.get("name", "desen.dxf"), units=code, kind=meta.get("kind"))
    finally:
        upload.unlink(missing_ok=True)




async def api_docs(request: Request):
    out = []
    owner = _req_owner(request)
    if DOCS.is_dir():
        for d in DOCS.iterdir():
            m = _read_json(d / "meta.json")
            if m and (MODE == "personal" or (owner and m.get("owner") == owner)):
                item = {k: m.get(k) for k in ("id", "name", "kind", "updated", "pages")}
                item["updated"] = _last_used(m)
                item["expires"] = _expires(m)
                item.update(_state_summary(d))
                out.append(item)
    out.sort(key=lambda m: m.get("updated") or 0, reverse=True)
    return JSONResponse(out[:30])


_SUMMARIES: dict = {}  # doc dir → (state.json mtime, summary)


def _state_summary(d: Path) -> dict:
    """For the start screen: how many annotations the document has, and its revision when it has
    revision marks (read from its saved state, kept until the state changes)."""
    f = d / "state.json"
    try:
        mt = f.stat().st_mtime
    except OSError:
        return {"annots": 0, "rev": None}
    hit = _SUMMARIES.get(str(d))
    if hit and hit[0] == mt:
        return hit[1]
    st = _read_json(f, {}) or {}
    annots = st.get("annots") if isinstance(st.get("annots"), list) else []
    settings = st.get("settings") if isinstance(st.get("settings"), dict) else {}
    has_rev = any(isinstance(a, dict) and a.get("layer") == "rev" for a in annots)
    out = {"annots": len(annots), "rev": str(settings.get("revNo") or 1)[:12] if has_rev else None}
    if len(_SUMMARIES) > 2000:
        _SUMMARIES.clear()
    _SUMMARIES[str(d)] = (mt, out)
    return out


def _last_used(meta: dict) -> float:
    return max(meta.get("updated") or 0, meta.get("accessed") or 0, meta.get("created") or 0)


def _expires(meta: dict):
    if RETENTION_DAYS <= 0:
        return None
    return _last_used(meta) + RETENTION_DAYS * 86400


def cleanup_expired(now: float | None = None) -> list[str]:
    """Deletes documents unused for more than RETENTION_DAYS days."""
    if RETENTION_DAYS <= 0 or not DOCS.is_dir():
        return []
    now = now or time.time()
    removed = []
    for d in DOCS.iterdir():
        if not d.is_dir() or not _ID_RE.match(d.name):
            continue
        meta = _read_json(d / "meta.json")
        if meta is None:
            # incomplete document (interrupted upload): cleaned up after a day
            last = d.stat().st_mtime
            if now - last < 86400:
                continue
        elif now < _expires(meta):
            continue
        shutil.rmtree(d, ignore_errors=True)
        _bytes_cache.pop(d.name, None)
        removed.append(d.name)
    if removed:
        logging.getLogger("drawcad").info("cleanup: %d expired documents deleted", len(removed))
    return removed


async def api_doc(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    meta = _read_json(d / "meta.json", {})
    if request.method == "DELETE":
        shutil.rmtree(d, ignore_errors=True)
        _purge(doc_id)
        return JSONResponse({"ok": True})
    meta["accessed"] = time.time()
    _dxf_page_info(meta)
    _write_json(d / "meta.json", meta)
    pub = {k: v for k, v in meta.items() if k != "owner"}
    ocr_pages = _ocr_pages(doc_id, meta)
    return JSONResponse({**pub, "expires": _expires(meta), "state": _read_json(d / "state.json"), "ocrPages": ocr_pages})


def _doc_images(d: Path) -> dict:
    """{id: path} of the images placed on a document."""
    out = {}
    if (d / "images").is_dir():
        for f in (d / "images").iterdir():
            if _IMG_FILE_RE.match(f.name):
                out[f.name.split(".")[0]] = f
    return out


async def api_image_add(request: Request):
    """An image to place on the drawing: read and written again in the limited process (ingest.py
    --image), then kept next to the document."""
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    INCOMING.mkdir(parents=True, exist_ok=True)
    tmp_id = uuid.uuid4().hex
    upload = INCOMING / f"{tmp_id}.img"
    out_dir = INCOMING / tmp_id
    try:
        try:
            size = await _read_limited(request, MAX_IMAGE_UPLOAD, upload)
        except OverflowError:
            return _err(f"Imagine prea mare (limita e {MAX_IMAGE_UPLOAD // (1024 * 1024)} MB)", 413)
        if not size:
            return _err("Fișier gol")
        out_dir.mkdir()
        proc = await asyncio.create_subprocess_exec(
            *_child_cmd("app.ingest", "--image", upload, out_dir),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=str(Path(__file__).resolve().parents[1]), **_child_kw(),
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), INGEST_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return _err("Imagine respinsă: citirea a durat prea mult")
        try:
            res = json.loads(out.decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            res = {}
        if not res:
            res = _read_json(out_dir / "result.json", {}) or {}
        if not res.get("ok"):
            return _err(res.get("error") or "Imagine respinsă")
        iid, ext = str(res.get("id", "")), str(res.get("ext", ""))
        src = out_dir / f"{iid}.{ext}"
        if not _IMG_FILE_RE.match(src.name) or not src.is_file():
            return _err("Imagine respinsă")
        (d / "images").mkdir(exist_ok=True)
        src.replace(d / "images" / src.name)
        return JSONResponse({"img": iid, "w": int(res.get("w") or 0), "h": int(res.get("h") or 0)})
    finally:
        upload.unlink(missing_ok=True)
        shutil.rmtree(out_dir, ignore_errors=True)


async def api_image_get(request: Request):
    doc_id = request.path_params["doc_id"]
    iid = request.path_params["img"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    if not _IMG_RE.match(iid):
        return _err("Imagine inexistentă", 404)
    path = _doc_images(d).get(iid)
    if not path:
        return _err("Imagine inexistentă", 404)
    mime = "image/jpeg" if path.suffix == ".jpg" else "image/png"
    # the id is the hash of the content: the browser may keep it
    return Response(path.read_bytes(), media_type=mime, headers={"Cache-Control": "private, max-age=86400, immutable"})


async def api_compare(request: Request):
    """Revision compare: page `page` of this document (newer) over page `otherPage` of document `other`
    (older). JSON with the overlay PNG and the changed areas, or the comparison as a PDF page."""
    from . import compare

    doc_id = request.path_params["doc_id"]
    try:
        body = await _json_body(request, 64 * 1024)
    except (OverflowError, ValueError):
        return _err("Cerere invalidă")
    if not isinstance(body, dict):
        return _err("Cerere invalidă")
    other = str(body.get("other", ""))
    try:
        n, meta = _page_index(doc_id, body.get("page", 0))
        m, ometa = _page_index(other, body.get("otherPage", 0))
    except (ValueError, FileNotFoundError, IndexError, TypeError):
        return _err("Pagină sau document inexistent", 404)
    # the other document must be one this browser may open, like the one in the address
    owner = _req_owner(request)
    if owner is not None and ometa.get("owner") != owner:
        return _err("Pagină sau document inexistent", 404)
    pn = meta["pages"][n]
    po = ometa["pages"][m]
    # two-point alignment: [[new, old], [new, old]], each a point [x, y] in pt on its page
    pairs = body.get("pairs")
    if pairs is not None:
        ok = (isinstance(pairs, list) and len(pairs) == 2 and all(
            isinstance(pr, list) and len(pr) == 2 and all(
                isinstance(q, list) and len(q) == 2 and all(_finite(v) and -1e5 < v < 1e5 for v in q) for q in pr) for pr in pairs))
        if not ok:
            return _err("Puncte de aliniere invalide")
        pairs = [[[float(v) for v in q] for q in pr] for pr in pairs]
    # with the DrawCAD annotations: each page as its export would look (black), not the bare original
    try:
        layers = {}
        for key, did, idx in (("prims", doc_id, n), ("otherPrims", other, m)):
            pr = body.get(key)
            if isinstance(pr, list):
                images = _doc_images(_doc_dir(did))
                keep = []
                for p in _clean_prims(pr):
                    if p["t"] == "I":
                        if p["img"] not in images:
                            continue
                        p["src"] = str(images[p["img"]])
                    keep.append(p)
                rk = "removals" if key == "prims" else "otherRemovals"
                layers[did if key == "prims" else "other"] = ({idx: keep}, {idx: _clean_ops(body.get(rk) or [])})
    except (ValueError, TypeError) as e:
        return _err(f"Date de comparare invalide: {e}")

    def page_pdf(did, key):
        if key not in layers:
            return _original(did)
        prims, rem = layers[key]
        return pdfcore.export_pdf(_original(did), prims, rem, "black", None, False, None)[0]

    def work():
        return compare.compare_pages(page_pdf(other, "other"), m, page_pdf(doc_id, doc_id), n, (pn["w"], pn["h"]), (po["w"], po["h"]),
                                     align=bool(body.get("align", True)), pairs=pairs)

    try:
        res = await run_in_threadpool(work)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:  # noqa: BLE001
        return _err(f"Compararea a eșuat: {e}", 500)
    if body.get("format") == "pdf":
        legend = str(body.get("legend") or "only in the older revision|only in the newer revision|in both")[:300]
        pdf = await run_in_threadpool(lambda: compare.overlay_pdf(res, (pn["w"], pn["h"]), legend))
        return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="comparare.pdf"'})
    import base64

    png = await run_in_threadpool(lambda: compare.overlay_png(res))
    old = await run_in_threadpool(lambda: compare.old_png(res))
    return JSONResponse({
        "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "oldImage": "data:image/png;base64," + base64.b64encode(old).decode("ascii"),
        "regions": res["regions"], "removed": res["removed"], "added": res["added"], "shiftMm": res["shift_mm"], "fit": res.get("fit"),
    })


async def api_state(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    try:
        data = await _json_body(request, 8 * 1024 * 1024)
    except (OverflowError, ValueError):
        return _err("Stare invalidă sau prea mare", 413)
    if not isinstance(data, dict):
        return _err("Stare invalidă")
    _write_json(d / "state.json", data)
    meta = _read_json(d / "meta.json", {})
    meta["updated"] = time.time()
    _write_json(d / "meta.json", meta)
    return JSONResponse({"ok": True})


async def api_render(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        n, meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    try:
        scale = float(request.query_params.get("scale", "1"))
    except ValueError:
        return _err("Scară invalidă")
    if not (scale > 0 and scale < 1000):
        return _err("Scară invalidă")
    p = meta["pages"][n]
    scale = round(max(0.1, _cap_scale(p, scale)), 3)
    # blackening for printing: the whole drawing (ink) and/or specific objects (bk = comma-separated ids)
    ink = None
    if request.query_params.get("ink"):
        ink = {"all": True, "fills": request.query_params.get("fills", "black"), "images": request.query_params.get("img") == "1"}
    bk = [x for x in request.query_params.get("bk", "").split(",") if _OID_RE.match(x)][:5000]
    ops = [{"mode": "black", "ids": bk}] if bk else None
    clip = _clip(request.query_params.get("clip"), p)
    if clip:
        scale = round(max(0.1, min(float(request.query_params.get("scale", "1")), 64)), 3)
        if (clip[2] - clip[0]) * (clip[3] - clip[1]) * scale * scale > CLIP_MAX_PX:
            return _err("Zonă prea mare")
    key = (doc_id, n, scale, json.dumps(ink, sort_keys=True), ",".join(bk), clip)

    def work():
        return _render_cache.get_or(key, lambda: pdfcore.render_png(_source(doc_id, n, ink), n, scale, ops, clip=clip))

    png = await run_in_threadpool(work)
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600", "X-Scale": str(scale)})


# thumbnails of recent documents (UI-D7a): the first page, at most this size in pixels (twice the card's
# picture, for sharp screens), kept next to the document until the page itself changes
THUMB_W, THUMB_H = 344, 240


def _thumb_sig(d: Path, meta: dict) -> str:
    """What the first page's picture depends on: the page and its order / rotation, hidden DXF layers and
    colors, the file itself."""
    import hashlib

    dxf = meta.get("dxf") or {}
    src = d / "original.pdf"
    parts = [meta.get("layout"), dxf.get("hidden"), bool(dxf.get("colors")), (meta.get("pages") or [None])[0],
             src.stat().st_mtime if src.is_file() else 0]
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:24]


async def api_thumb(request: Request):
    """GET: a small PNG of the document's first page, as the start screen shows it (cached on disk)."""
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    meta = _read_json(d / "meta.json", {}) or {}
    if not meta.get("pages"):
        return _err("Document inexistent", 404)
    sig = _thumb_sig(d, meta)
    png_f, key_f = d / "thumb.png", d / "thumb.json"
    headers = {"Cache-Control": "private, max-age=86400", "ETag": f'"{sig}"'}
    if request.headers.get("if-none-match") == f'"{sig}"' and png_f.is_file():
        return Response(status_code=304, headers=headers)
    if png_f.is_file() and (_read_json(key_f, {}) or {}).get("sig") == sig:
        return Response(png_f.read_bytes(), media_type="image/png", headers=headers)
    p = meta["pages"][0]
    scale = min(THUMB_W / max(p["w"], 1), THUMB_H / max(p["h"], 1))

    def work():
        # the plain file when nothing changes the page (no copy of every listed PDF in the memory cache)
        dxf = meta.get("dxf") or {}
        if _layout(doc_id) or _hidden_layers(doc_id) or dxf.get("colors"):
            src = _original(doc_id)
        else:
            src = (d / "original.pdf").read_bytes()
        return pdfcore.render_png(src, 0, scale)

    try:
        png = await run_in_threadpool(work)
    except Exception:  # noqa: BLE001
        logging.getLogger("drawcad").exception("thumbnail of %s", doc_id)
        return _err("Miniatura nu poate fi făcută", 500)
    with contextlib.suppress(OSError):
        tmp = d / f"thumb.{uuid.uuid4().hex}.tmp"
        tmp.write_bytes(png)
        tmp.replace(png_f)
        _write_json(key_f, {"sig": sig})
    return Response(png, media_type="image/png", headers=headers)


CLIP_MAX_PX = 24e6  # a detail area: a few times a 4K screen


def _json_bytes(obj) -> bytes:
    """Compact JSON, as produced by JSONResponse (for caches kept as bytes)."""
    return json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _cap_scale(p, scale):
    """Scale of a whole-page render, limited to the maximum side and pixel count."""
    if max(p["w"], p["h"]) * scale > MAX_RENDER_PX:
        scale = MAX_RENDER_PX / max(p["w"], p["h"])
    if p["w"] * p["h"] * scale * scale > MAX_RENDER_MP * 1e6:
        scale = (MAX_RENDER_MP * 1e6 / (p["w"] * p["h"])) ** 0.5
    return scale


def _clip(raw, page):
    """Area to render "x0,y0,x1,y1" in visual points (detail at high zoom) or None."""
    if not raw or not page:
        return None
    try:
        v = [float(x) for x in str(raw).split(",")]
    except ValueError:
        return None
    if len(v) != 4 or not all(abs(x) < 1e6 for x in v):
        return None
    x0, y0, x1, y1 = max(0.0, v[0]), max(0.0, v[1]), min(page["w"], v[2]), min(page["h"], v[3])
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return (round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2))


def _meta_page(doc_id, n):
    try:
        return _page_index(doc_id, n)[1]["pages"][n]
    except Exception:  # noqa: BLE001
        return None


async def api_preview(request: Request):
    """Render with removals applied (for the removal dialog)."""
    doc_id = request.path_params["doc_id"]
    try:
        n, _meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    try:
        body = await _json_body(request)
    except (OverflowError, ValueError):
        return _err("Cerere invalidă sau prea mare", 413)
    if not isinstance(body, dict):
        return _err("Cerere invalidă")
    ops = body.get("ops", [])
    p = _meta_page(doc_id, n)
    try:
        scale = min(float(body.get("scale", 2)), 64)
    except (TypeError, ValueError):
        return _err("Scară invalidă")
    try:
        ops = _clean_ops(ops)
    except ValueError as e:
        return _err(str(e))
    clip = _clip(body.get("clip"), p) if isinstance(body.get("clip"), str) else None
    if clip:
        scale = round(max(0.1, min(float(body.get("scale", 2)), 64)), 3)
        if (clip[2] - clip[0]) * (clip[3] - clip[1]) * scale * scale > CLIP_MAX_PX:
            return _err("Zonă prea mare")
    elif p:
        scale = _cap_scale(p, scale)
    scale = round(max(0.1, scale), 3)
    ink = body.get("ink") or None
    key = ("pv", doc_id, n, scale, json.dumps(ops, sort_keys=True), json.dumps(ink, sort_keys=True), clip)

    def work():
        return _render_cache.get_or(key, lambda: pdfcore.render_png(_source(doc_id, n, ink if isinstance(ink, dict) else None), n, scale, ops, clip=clip))

    png = await run_in_threadpool(work)
    return Response(png, media_type="image/png")


async def api_pages(request: Request):
    """Page operations: rotate (90° left / right, 180°), delete, move, scale, or a whole layout
    (undo / redo). The uploaded file stays unchanged; order and rotation live in the metadata and are
    applied on render and export, so a deleted page can come back. The operation comes with the
    annotation state, already transformed to the new page; the answer has the layout before and after."""
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
        body = await _json_body(request)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    except OverflowError:
        return _err("Cerere prea mare", 413)
    if not isinstance(body, dict):
        return _err("Cerere invalidă")
    meta = _read_json(d / "meta.json", {})
    n = len(meta.get("pages", []))
    pages0 = meta.get("pages0") or meta.get("pages", [])
    lay = meta.get("layout") if isinstance(meta.get("layout"), list) and meta.get("layout") else [{"src": i, "rot": 0} for i in range(n)]
    lay = [dict(it) for it in lay]
    prev = [dict(it) for it in lay]
    op = body.get("op")
    sel = body.get("pages")
    if sel is None:
        sel = list(range(n))
    if not isinstance(sel, list) or not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < n for i in sel):
        return _err("Pagini invalide")
    if op == "layout":
        # a layout from the undo history: each source page at most once, quarter turns, sane scale
        new = body.get("layout")
        if not isinstance(new, list) or not 1 <= len(new) <= len(pages0):
            return _err("Pagini invalide")
        seen, lay = set(), []
        for it in new:
            src, rot, sc = (it.get("src"), it.get("rot", 0), it.get("scale", 1)) if isinstance(it, dict) else (None, 0, 1)
            if not (isinstance(src, int) and not isinstance(src, bool) and 0 <= src < len(pages0)) or src in seen:
                return _err("Pagini invalide")
            if not (isinstance(rot, int) and not isinstance(rot, bool) and rot % 90 == 0):
                return _err("Unghi invalid")
            if not (_finite(sc) and 0.01 <= float(sc) <= 100):
                return _err("Factor invalid")
            seen.add(src)
            q = {"src": src, "rot": rot % 360}
            if abs(float(sc) - 1) > 1e-9:
                q["scale"] = round(float(sc), 6)
            lay.append(q)
    elif op == "rotate":
        delta = body.get("delta")
        if delta not in (90, -90, 180, 270):
            return _err("Unghi invalid")
        for i in set(sel):
            lay[i]["rot"] = (int(lay[i].get("rot", 0)) + delta) % 360
    elif op == "delete":
        drop = set(sel)
        if len(drop) >= n:
            return _err("Documentul trebuie să păstreze cel puțin o pagină")
        lay = [it for i, it in enumerate(lay) if i not in drop]
    elif op == "scale":
        k = body.get("factor")
        if not _finite(k) or not (0.02 <= k <= 50):
            return _err("Factor invalid")
        for i in set(sel):
            v = float(lay[i].get("scale", 1) or 1) * float(k)
            if not (0.01 <= v <= 100):
                return _err("Foaie prea mică sau prea mare")
            lay[i]["scale"] = round(v, 6)
    elif op == "move":
        a, b = body.get("page"), body.get("to")
        if not all(isinstance(x, int) and not isinstance(x, bool) and 0 <= x < n for x in (a, b)):
            return _err("Pagini invalide")
        lay.insert(b, lay.pop(a))
    else:
        return _err("Operație necunoscută")
    identity = len(lay) == len(pages0) and all(
        it["src"] == i and it.get("rot", 0) % 360 == 0 and abs(float(it.get("scale", 1) or 1) - 1) < 1e-9 for i, it in enumerate(lay)
    )
    meta["pages0"] = pages0
    if identity:
        meta.pop("layout", None)
    else:
        meta["layout"] = lay
    meta["lv"] = int(meta.get("lv", 0)) + 1
    _write_json(d / "meta.json", meta)
    _purge(doc_id)
    try:
        info = await run_in_threadpool(lambda: pdfcore.open_info(_original(doc_id)))
    except Exception as e:  # noqa: BLE001
        return _err(f"Operația pe pagini a eșuat: {e}", 500)
    meta["pages"] = info["pages"]
    _dxf_page_info(meta)
    meta["updated"] = time.time()
    _write_json(d / "meta.json", meta)
    state = body.get("state")
    if isinstance(state, dict) and isinstance(state.get("annots"), list):
        _write_json(d / "state.json", state)
    return JSONResponse({"pages": meta["pages"], "lv": meta["lv"], "ocrPages": _ocr_pages(doc_id, meta), "layout": lay, "prev": prev})


async def _dxf_colors(d: Path) -> str | None:
    """The drawing plotted again in its own colors, in the limited child process (original-color.pdf).
    → an error message, or None."""
    proc = await asyncio.create_subprocess_exec(
        *_child_cmd("app.ingest", "--dxf-colors", d),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        cwd=str(Path(__file__).resolve().parents[1]), **_child_kw(),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), INGEST_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return "Desenul color a durat prea mult"
    finally:
        (d / "result.json").unlink(missing_ok=True)
    try:
        res = json.loads(out.decode("utf-8") or "{}")
    except Exception:  # noqa: BLE001
        res = {}
    return None if res.get("ok") else (res.get("error") or "Desenul nu poate fi refăcut color")


async def api_dxf_layers(request: Request):
    """Layers of a drawing opened from DXF / DWG shown or hidden: {"hidden": [names], "colors": bool}.
    Hidden layers are left out of the page, snap, search and every export (in the DXF of the original
    drawing they are turned off). `colors`: the drawing in its own colors instead of black."""
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
        body = await _json_body(request)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    except OverflowError:
        return _err("Cerere prea mare", 413)
    meta = _read_json(d / "meta.json", {})
    dxf = meta.get("dxf")
    if not isinstance(dxf, dict) or not isinstance(body, dict) or not isinstance(body.get("hidden"), list):
        return _err("Cerere invalidă")
    known = {la["name"] for la in dxf.get("layers") or []}
    hidden = sorted({h for h in body["hidden"] if isinstance(h, str) and h in known})
    dxf["hidden"] = hidden
    if isinstance(body.get("colors"), bool):
        if body["colors"] and not (d / "original-color.pdf").is_file():
            err = await _dxf_colors(d)
            if err:
                return _err(err)
        dxf["colors"] = body["colors"]
    meta["lv"] = int(meta.get("lv", 0)) + 1
    meta["updated"] = time.time()
    _write_json(d / "meta.json", meta)
    _purge(doc_id)
    return JSONResponse({"hidden": hidden, "colors": bool(dxf.get("colors")), "lv": meta["lv"]})


async def api_snap(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        n, _meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)

    def work():
        return _snap_cache.get_or((doc_id, n), lambda: _json_bytes(pdfcore.snap_points(_original(doc_id), n)))

    # geometry comes only from the original, which does not change: the browser may keep it
    return Response(await run_in_threadpool(work), media_type="application/json", headers={"Cache-Control": "private, max-age=3600"})


async def api_objects(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        n, _meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    try:
        body = await _json_body(request)
    except (OverflowError, ValueError):
        return _err("Cerere invalidă sau prea mare", 413)
    if not isinstance(body, dict):
        return _err("Cerere invalidă")
    rect = body.get("rect")
    if not isinstance(rect, list) or len(rect) != 4 or not all(_finite(v) for v in rect):
        return _err("rect lipsă")
    res = await run_in_threadpool(lambda: pdfcore.objects_in_rect(_original(doc_id), n, rect))
    return JSONResponse({"objects": res})


# ------------------------------------------------------------------ OCR, text, vectorization

# OCR and vectorization keep the CPU busy for tens of seconds: one at a time
_HEAVY = asyncio.Semaphore(1)
_text_cache = LRU(32, 32 * 1024 * 1024)
VECTOR_TIMEOUT = float(_env("VECTOR_TIMEOUT", "240"))
VECTOR_PX_MM = 8.0  # vectorization resolution (≈ 200 DPI): enough for 0.25 mm lines


def _cache_dir(doc_id, sub):
    d = _doc_dir(doc_id) / sub
    d.mkdir(exist_ok=True)
    return d


def _ocr_cached(doc_id, n):
    return _read_json(_doc_dir(doc_id) / "ocr" / f"{_pkey(doc_id, n)}.json", None)


def _ocr_pages(doc_id, meta):
    d = _doc_dir(doc_id) / "ocr"
    if not d.is_dir():
        return []
    return [n for n in range(len(meta.get("pages", []))) if (d / f"{_pkey(doc_id, n)}.json").exists()]


async def _ocr_run(doc_id, n, meta_page):
    from . import ocr as ocrmod

    async with _HEAVY:
        cached = _ocr_cached(doc_id, n)
        if cached is not None:
            return cached
        scan = True if meta_page.get("paths", 1) == 0 else None  # no vector lines = image
        res = await run_in_threadpool(lambda: ocrmod.ocr_page(_original(doc_id), n, (meta_page["w"], meta_page["h"]), scan=scan))
        await run_in_threadpool(pdfcore.release_memory)  # OCR arrays are tens to hundreds of MB
        _write_json(_cache_dir(doc_id, "ocr") / f"{_pkey(doc_id, n)}.json", res)
        return res


async def api_ocr(request: Request):
    """GET: the text already recognized (or null); POST: recognizes the page (the result stays on the server)."""
    from . import ocr as ocrmod

    doc_id = request.path_params["doc_id"]
    try:
        n, meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    if request.method == "GET":
        return JSONResponse({"ocr": _ocr_cached(doc_id, n), "lang": await _ocr_lang()})
    if not await _ocr_lang():
        return _err("OCR indisponibil: Tesseract nu e instalat pe server", 501)
    try:
        body = await _json_body(request, 4096)
    except (OverflowError, ValueError):
        body = {}
    if isinstance(body, dict) and body.get("force"):
        with contextlib.suppress(FileNotFoundError):
            (_doc_dir(doc_id) / "ocr" / f"{_pkey(doc_id, n)}.json").unlink()
    try:
        res = await _ocr_run(doc_id, n, meta["pages"][n])
    except subprocess.TimeoutExpired:
        return _err("OCR: pagina a durat prea mult", 504)
    except Exception as e:  # noqa: BLE001
        return _err(f"OCR eșuat: {e}", 500)
    return JSONResponse({"ocr": res, "lang": res.get("lang")})


async def api_snap_scan(request: Request):
    """Snap geometry of a scanned page, from its vectorization (on request: it takes a while)."""
    from . import scansnap

    doc_id = request.path_params["doc_id"]
    try:
        n, meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    if meta["pages"][n].get("paths", 1) != 0:
        return _err("Pagina are geometrie vectorială: snap-ul obișnuit o folosește deja", 400)
    cached = _snap_cache.get((doc_id, n, "scan"))
    if cached is not None:
        return Response(cached, media_type="application/json")
    # text read confidently by OCR (if it was already run) is kept out: letters are not geometry
    ocr = _ocr_cached(doc_id, n) or {}
    masks = [ln["box"] for ln in ocr.get("lines", []) if ln.get("conf", 0) >= 60 and len(ln.get("text", "").replace(" ", "")) >= 2]
    try:
        vec = await _vectorize(doc_id, n, _original(doc_id), masks, "snap1", deskew=False)
    except ValueError as e:
        return _err(str(e), 500)
    body = _json_bytes(scansnap.to_snap(vec))
    _snap_cache.get_or((doc_id, n, "scan"), lambda: body)
    return Response(body, media_type="application/json")


async def api_text(request: Request):
    """Real texts of the page (for search), with their bounding boxes."""
    from . import ocr as ocrmod

    doc_id = request.path_params["doc_id"]
    try:
        n, _meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    body = await run_in_threadpool(lambda: _text_cache.get_or((doc_id, n), lambda: _json_bytes({"items": ocrmod.native_text(_original(doc_id), n)})))
    return Response(body, media_type="application/json", headers={"Cache-Control": "private, max-age=3600"})


async def _vectorize(doc_id, n, pdf_bytes, masks, key, deskew=True):
    """Vectorization of a scanned page, in a separate process; the result stays in cache."""
    import hashlib
    import tempfile

    h = hashlib.sha1((key + json.dumps(masks) + ("" if deskew else "|nodeskew")).encode()).hexdigest()[:16]
    path = _doc_dir(doc_id) / "vec" / f"{_pkey(doc_id, n)}_{h}.json"
    cached = _read_json(path, None)
    if cached is not None:
        return cached
    async with _HEAVY:
        cached = _read_json(path, None)
        if cached is not None:
            return cached
        info = _meta_page(doc_id, n) or {"w": 842, "h": 595}
        scale = VECTOR_PX_MM * 25.4 / 72
        if info["w"] * info["h"] * scale * scale > 45e6:
            scale = (45e6 / (info["w"] * info["h"])) ** 0.5
        png = await run_in_threadpool(lambda: pdfcore.render_png(pdf_bytes, n, scale, gray=True))
        with tempfile.TemporaryDirectory(prefix="drawcad-vec-") as td:
            ip, op, mp = (os.path.join(td, f) for f in ("in.png", "out.json", "masks.json"))
            with open(ip, "wb") as f:
                f.write(png)
            with open(mp, "w", encoding="utf-8") as f:
                json.dump(masks, f)
            proc = await asyncio.create_subprocess_exec(
                *_child_cmd("app.vectorize", ip, op, scale, mp, *([] if deskew else ["nodeskew"])),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                cwd=str(Path(__file__).resolve().parents[1]), **_child_kw(),
            )
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), VECTOR_TIMEOUT)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise ValueError(f"Vectorizarea paginii {n + 1} a durat peste {VECTOR_TIMEOUT:g} s")
            try:
                res = json.loads(out.decode("utf-8") or "{}")
            except Exception:  # noqa: BLE001
                res = {}
            if not res and os.path.exists(op + ".status"):
                res = _read_json(Path(op + ".status"), {}) or {}
            if not res.get("ok"):
                raise ValueError(res.get("error") or f"Vectorizarea paginii {n + 1} a eșuat")
            data = _read_json(Path(op), None)
        if data is None:
            raise ValueError("Vectorizare fără rezultat")
        _cache_dir(doc_id, "vec")
        _write_json(path, data)
        return data


def _inside(box, rects):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    for r in rects:
        x0, x1 = min(r[0], r[2]), max(r[0], r[2])
        y0, y1 = min(r[1], r[3]), max(r[1], r[3])
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            return True
    return False


def _overlaps(box, boxes):
    for b in boxes:
        ix = min(box[2], b[2]) - max(box[0], b[0])
        iy = min(box[3], b[3]) - max(box[1], b[1])
        if ix > 0 and iy > 0 and ix * iy > 0.3 * (box[2] - box[0]) * (box[3] - box[1]):
            return True
    return False


def _source_dxf_ok(doc_id, meta, idxs) -> bool:
    """A drawing opened from DXF / DWG whose chosen pages can take DrawCAD's work in the original DXF
    (pages made by this version, which records each page's drawing → page transform)."""
    d = _doc_dir(doc_id)
    dxf = meta.get("dxf") or {}
    if not (d / "original.dxf").is_file() or not dxf.get("pages"):
        return False
    lay = _layout(doc_id) or [{"src": i} for i in range(len(meta.get("pages", [])))]
    for i in idxs:
        it = lay[i] if i < len(lay) else {}
        src = int(it.get("src", i))
        if src >= len(dxf["pages"]) or "tf" not in dxf["pages"][src]:
            return False
    return True


async def _export_dxf_source(doc_id, meta, original, prims, rem, idxs, opts, color, base_name):
    """DXF export of a drawing opened from DXF / DWG: the original DXF with DrawCAD's annotations on
    their layers, in the space each page shows, and the removals made in DrawCAD (dxfin.export_source)."""
    from . import dxfin

    d = _doc_dir(doc_id)
    lay = _layout(doc_id) or [{"src": i} for i in range(len(meta.get("pages", [])))]
    rem_sel = {k: v for k, v in rem.items() if k in idxs}
    reports = {}
    if any(rem_sel.values()):
        _base, reports = await run_in_threadpool(pdfcore.apply_removals, original, rem_sel)
    maps = _read_json(d / "original.dxfmap.json", [])
    want_annots = bool(opts.get("annots", True))
    pages = []
    files = []
    stem = base_name or "desen"
    for i in idxs:
        it = lay[i]
        src = int(it.get("src", i))
        info = meta["dxf"]["pages"][src]
        page_prims = [p for p in prims.get(i, []) if p.get("t") != "I"] if want_annots else []
        # images placed in DrawCAD: saved next to the DXF (a ZIP), which references them
        images = []
        for p in (q for q in prims.get(i, []) if want_annots and q.get("t") == "I" and q.get("src")):
            srcf = Path(p["src"])
            try:
                from PIL import Image

                with Image.open(srcf) as im:
                    px = im.size
            except Exception:  # noqa: BLE001
                continue
            name = f"{stem}_p{i + 1}_img{len(images) + 1}{srcf.suffix}"
            images.append((name, px, p))
            files.append((name, srcf.read_bytes()))
        rep = reports.get(i, {})
        pages.append({
            "page": info, "W": info["sheet"][0] * 72 / 25.4, "H": info["sheet"][1] * 72 / 25.4,
            "kp": float(it.get("scale", 1) or 1), "rot": int(it.get("rot", 0)) % 360, "images": images,
            "prims": page_prims, "handles": maps[src] if isinstance(maps, list) and src < len(maps) else None,
            "gone": rep.get("_gone", []), "cut": rep.get("_cut", []),
            "zones": [op["rect"] for op in rem.get(i, []) if op.get("mode") == "zone"],
        })
    hidden = (meta.get("dxf") or {}).get("hidden") or []
    data, counts = await run_in_threadpool(dxfin.export_source, (d / "original.dxf").read_bytes(), pages, color, hidden)
    stats = {"source": {**counts, "source": True, "from": meta.get("kind", "dxf")}}
    if not files:
        return data, reports, "dxf", stats
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{stem}.dxf", data)
        for name, b in files:
            z.writestr(name, b)
    return buf.getvalue(), reports, "zip", stats


async def _export_dxf(doc_id, prims, rem, sel, opts, color, base_name):
    """DXF for the chosen pages: one file, or a ZIP when there are several pages or background images."""
    import io
    import zipfile

    from . import dxfout, ocr as ocrmod

    original = await run_in_threadpool(_original, doc_id)  # first time: read + page arrangement
    meta = _read_json(_doc_dir(doc_id) / "meta.json", {})
    n_pages = len(meta.get("pages", []))
    idxs = sorted({i for i in (sel or range(n_pages)) if 0 <= i < n_pages})
    if not idxs:
        raise ValueError("nicio pagină aleasă")
    if opts.get("source", True) and _source_dxf_ok(doc_id, meta, idxs):
        return await _export_dxf_source(doc_id, meta, original, prims, rem, idxs, opts, color, base_name)
    scale = opts.get("scale", 1)
    scale = float(scale) if _finite(scale) and 1e-4 < scale < 1e4 else 1.0
    want = {k: bool(opts.get(k, d)) for k, d in (("geom", True), ("text", True), ("annots", True), ("ocr", True), ("vectorize", True), ("image", False))}
    rem_sel = {k: v for k, v in rem.items() if k in idxs}
    if any(rem_sel.values()):
        base, reports = await run_in_threadpool(pdfcore.apply_removals, original, rem_sel)
    else:
        base, reports = original, {}
    files = []
    stats = {}
    for i in idxs:
        content = await run_in_threadpool(dxfout.page_content, base, i)
        scan = dxfout.is_scan(content)
        page_prims = prims.get(i, []) if want["annots"] else []
        covers = [p["p"] for p in prims.get(i, []) if p.get("t") == "R" and (p.get("cover") or p.get("c") == "white")]
        zones = [op["rect"] for op in rem.get(i, []) if op.get("mode") in ("text", "zone")]
        lines = []
        if want["ocr"]:
            cached = _ocr_cached(doc_id, i)
            if cached is None and scan and await _ocr_lang():
                cached = await _ocr_run(doc_id, i, meta["pages"][i])
            native = [t for t in content["texts"]]
            nboxes = []
            for t in native:
                # approximate box of the PDF text, so it is not duplicated by OCR
                hh = t["h"]
                nboxes.append([t["p"][0], t["p"][1] - hh, t["p"][0] + hh * 0.6 * len(t["txt"]), t["p"][1] + hh * 0.25])
            for ln in (cached or {}).get("lines", []):
                if _inside(ln["box"], covers + zones) or _overlaps(ln["box"], nboxes):
                    continue
                lines.append(ln)
        vec = None
        if scan and want["vectorize"]:
            # only confidently read text is removed from the image; the rest also stays as lines
            masks = [ln["box"] for ln in lines
                     if (ln.get("conf", 0) >= 60 and len(ln["text"].replace(" ", "")) >= 2) or ln.get("conf", 0) >= 85]
            masks += [list(c) for c in covers]
            vec = await _vectorize(doc_id, i, base, masks, "v1" + json.dumps(rem_sel.get(i, [])))
        rot = dxfout.Rotation(vec["skew"], content["W"], content["H"]) if vec and vec.get("skew") else None
        img = None
        stem = f"{base_name}_p{i + 1}" if len(idxs) > 1 else base_name
        if scan and want["image"]:
            sc = min(200 / 72, (40e6 / (content["W"] * content["H"])) ** 0.5)
            png = await run_in_threadpool(pdfcore.render_png, base, i, sc)
            from PIL import Image

            with Image.open(io.BytesIO(png)) as im:
                img = (f"{stem}.png", png, im.size)

        # images placed in DrawCAD: saved next to the DXF, which references them
        pimgs = []
        for n, p in enumerate(q for q in page_prims if q.get("t") == "I" and q.get("src")):
            src = Path(p["src"])
            try:
                from PIL import Image

                with Image.open(src) as im:
                    px = im.size
            except Exception:  # noqa: BLE001
                continue
            pimgs.append((f"{stem}_img{n + 1}{src.suffix}", src.read_bytes(), px, p))

        def build():
            d = dxfout.DxfPage(content["W"], content["H"], scale)
            d.frame()
            if img:
                d.add_image(img[0], img[2], rot)
            if want["geom"]:
                d.add_pdf(content, text=want["text"])
            if vec:
                d.add_vectors(vec)
            if lines:
                d.add_ocr(lines, rot)
            for name, _, px, p in pimgs:
                d.add_annot_image(name, px, p["p"], p.get("rot", 0), float(p.get("op", 1) or 1))
            if page_prims:
                d.add_prims(page_prims, color)
            return d.bytes(), d.counts

        data, counts = await run_in_threadpool(build)
        stats[i] = {**counts, "scan": scan, "skew": (vec or {}).get("skew", 0)}
        files.append((f"{stem}.dxf", data))
        if img:
            files.append((img[0], img[1]))
        files += [(name, data) for name, data, _, _ in pimgs]
    if len(files) == 1:
        return files[0][1], reports, "dxf", stats
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)
    return buf.getvalue(), reports, "zip", stats


async def api_export(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    try:
        body = await _json_body(request)
    except (OverflowError, ValueError):
        return _err("Cerere invalidă sau prea mare", 413)
    if not isinstance(body, dict):
        return _err("Cerere invalidă")
    fmt = "dxf" if body.get("format") == "dxf" else "pdf"
    filename = re.sub(r"[\x00-\x1f\x7f\\/:*?\"<>|]", "_", os.path.basename(str(body.get("filename") or "export.pdf")))[:180]
    filename = re.sub(r"\.(pdf|dxf|zip)$", "", filename, flags=re.I) + "." + fmt
    try:
        prims = {int(k): _clean_prims(v) for k, v in (body.get("pages") or {}).items()}
        rem = {int(k): _clean_ops(v) for k, v in (body.get("removals") or {}).items()}
    except (ValueError, TypeError, AttributeError) as e:
        return _err(f"Date de export invalide: {e}")
    state = body.get("state")
    if state is not None and not isinstance(state, dict):
        state = None
    images = _doc_images(d)
    for k in list(prims):
        keep = []
        for p in prims[k]:
            if p["t"] == "I":
                if p["img"] not in images:
                    continue
                p["src"] = str(images[p["img"]])
            keep.append(p)
        prims[k] = keep
    embed = bool(body.get("embed", True))
    color = body.get("colorMode", "black")
    ink = body.get("ink") if isinstance(body.get("ink"), dict) else None
    sel = body.get("pageSel")
    if sel is not None:
        if not isinstance(sel, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in sel):
            return _err("Pagini invalide")
        sel = sel[:5000]
    split = bool(body.get("split"))
    rev = re.sub(r"[^\w .-]", "", str(body.get("rev") or ""))[:20] or None
    notes = {}
    raw_notes = body.get("notes") if isinstance(body.get("notes"), dict) else {}
    try:
        for k, items in list(raw_notes.items())[:5000]:
            if not isinstance(items, list):
                continue
            keep = []
            for n in items[:500]:
                if isinstance(n, dict) and isinstance(n.get("p"), list) and len(n["p"]) == 2 and all(_finite(v) for v in n["p"]):
                    keep.append({"p": n["p"], "text": str(n.get("text", ""))[:4000], "author": str(n.get("author", ""))[:80],
                                 "date": str(n.get("date", ""))[:40], "done": bool(n.get("done"))})
            if keep:
                notes[int(k)] = keep
    except (ValueError, TypeError):
        notes = {}
    base = re.sub(r"\.(pdf|dxf)$", "", filename, flags=re.I)
    stats = None
    if fmt == "pdf" and body.get("ocrLayer"):
        # searchable PDF: the recognized text, invisible, over the image
        for i in range(len(_read_json(d / "meta.json", {}).get("pages", []))):
            if sel is not None and i not in sel:
                continue
            res = _ocr_cached(doc_id, i)
            for ln in (res or {}).get("lines", []):
                prims.setdefault(i, []).append({"t": "O", "p": ln["box"], "txt": ln["text"], "rot": ln.get("rot", 0),
                                                **{k: ln[k] for k in ("cap", "base", "org", "ang", "len") if k in ln}})

    # a drawing opened from DXF / DWG: what is on hidden layers is left out of the PDF (not only made
    # invisible, so it cannot be found or copied there either)
    hidden = _hidden_layers(doc_id)
    hidden_n = {}
    if fmt == "pdf" and hidden:
        hid = _hidden_ids(doc_id, hidden)
        lay = _layout(doc_id) or [{"src": i} for i in range(len(_read_json(d / "meta.json", {}).get("pages", [])))]
        for i, it in enumerate(lay):
            ids = hid.get(int(it.get("src", i)))
            if ids:
                rem[i] = [*rem.get(i, []), {"mode": "objects", "ids": [str(x) for x in ids]}]
                hidden_n[i] = len(ids)

    def work():
        return pdfcore.export_pages(_original(doc_id), prims, rem, color, state if embed else None, embed, ink, sel, split, base, rev,
                                    {k: str(v) for k, v in images.items()}, notes)

    try:
        if fmt == "dxf":
            dopts = body.get("dxf") if isinstance(body.get("dxf"), dict) else {}
            data, reports, kind, stats = await _export_dxf(doc_id, prims, rem, sel, dopts, color, base)
        else:
            data, reports, kind = await run_in_threadpool(work)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:  # noqa: BLE001
        return _err(f"Export eșuat: {e}", 500)
    for i, k in hidden_n.items():
        if isinstance(reports.get(i), dict):
            reports[i]["removed"] = max(0, reports[i].get("removed", 0) - k)  # hidden layers: not "removed"
    if kind == "zip":
        filename = f"{base}.zip"
    elif kind == "dxf":
        filename = f"{base}.dxf"
    filename = re.sub(r"[\x00-\x1f\x7f\\/]", "_", filename)[:180]
    ascii_name = re.sub(r"[^A-Za-z0-9._ ()+-]", "_", filename)
    headers = {
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}",
        "X-Removal-Report": json.dumps({k: {n: v for n, v in r.items() if not n.startswith("_")} for k, r in reports.items()}),
        "X-Export-Kind": kind,
    }
    if stats is not None:
        headers["X-Dxf-Stats"] = json.dumps(stats, ensure_ascii=True)
    meta = _read_json(d / "meta.json", {})
    meta["updated"] = time.time()
    _write_json(d / "meta.json", meta)
    media = {"zip": "application/zip", "dxf": "application/dxf"}.get(kind, "application/pdf")
    return Response(data, media_type=media, headers=headers)


async def _ocr_lang(wait: float | None = None):
    """OCR languages without blocking the server: detection runs Tesseract (on first start on
    Windows it may take tens of seconds). With `wait`, after that many seconds it returns "don't know yet"."""
    from . import ocr as ocrmod

    fut = run_in_threadpool(ocrmod.lang)
    if wait is None:
        return await fut
    try:
        return await asyncio.wait_for(asyncio.shield(asyncio.ensure_future(fut)), wait)
    except asyncio.TimeoutError:
        return None


def _dwg_available() -> bool:
    """LibreDWG's dwg2dxf is here (Docker image, desktop app): DWG files can be opened."""
    p = os.environ.get("DRAWCAD_DWG2DXF")
    return bool((p and os.path.isfile(p)) or shutil.which("dwg2dxf"))


async def api_health(request: Request):
    from . import ocr as ocrmod

    # the interface waits for this answer at startup: no more than one second for OCR
    lang = await _ocr_lang(wait=1.0)
    return JSONResponse({"ok": True, "retentionDays": RETENTION_DAYS, "mode": MODE, "ocr": lang,
                         "ocrPending": lang is None and not ocrmod.langs_known(), "dxf": True, "dwg": _dwg_available(), "desktop": DESKTOP,
                         "version": VERSION})


# fonts for DXF / DWG texts (ISOCPEUR, AIGDT, SHX files…), shared by every drawing opened on this server:
# added from the interface only where one person uses the server (personal mode, the desktop app),
# otherwise by whoever runs it, in <data>/fonts
FONTS_DIR = DATA_DIR / "fonts"
MAX_FONT = 30 * 1024 * 1024
MAX_FONTS = 300
_FONT_NAME = re.compile(r"^[\w][\w .()+&-]{0,95}\.(ttf|otf|ttc|shx)$", re.IGNORECASE)


def _fonts_editable() -> bool:
    return MODE == "personal" or DESKTOP


def _font_list() -> list[dict]:
    out = []
    if FONTS_DIR.is_dir():
        for f in sorted(FONTS_DIR.iterdir(), key=lambda x: x.name.lower()):
            if f.is_file() and _FONT_NAME.match(f.name):
                out.append({"name": f.name, "size": f.stat().st_size})
    return out


async def api_fonts(request: Request):
    """GET: the fonts added; POST (a file, its name in X-Filename): checked in the limited process,
    then kept; DELETE ?name=…: removed."""
    if request.method == "GET":
        from . import dxfin

        auto = [str(d) for d in dxfin.font_dirs() if d.resolve() != FONTS_DIR.resolve()] if DESKTOP else []
        return JSONResponse({"fonts": _font_list(), "editable": _fonts_editable(),
                             "dir": str(FONTS_DIR) if DESKTOP else None, "auto": auto})
    if not _fonts_editable():
        return _err("Pe acest server fonturile se adaugă în folderul fonts al datelor", 403)
    if request.method == "DELETE":
        name = os.path.basename(request.query_params.get("name", ""))
        f = FONTS_DIR / name
        if not _FONT_NAME.match(name) or not f.is_file():
            return _err("Font inexistent", 404)
        f.unlink()
        return JSONResponse({"fonts": _font_list()})
    name = request.headers.get("x-filename", "")
    with contextlib.suppress(UnicodeError):
        name = bytes(name, "latin-1").decode("utf-8")
    name = os.path.basename(name).strip()
    if not _FONT_NAME.match(name):
        return _err("Se acceptă fonturi .ttf, .otf, .ttc și .shx (nume fără caractere speciale)")
    if len(_font_list()) >= MAX_FONTS:
        return _err(f"Prea multe fonturi (limita e {MAX_FONTS})")
    INCOMING.mkdir(parents=True, exist_ok=True)
    tmp_id = uuid.uuid4().hex
    upload = INCOMING / f"{tmp_id}{os.path.splitext(name)[1].lower()}"
    out_dir = INCOMING / tmp_id
    try:
        try:
            size = await _read_limited(request, MAX_FONT, upload)
        except OverflowError:
            return _err(f"Font prea mare (limita e {MAX_FONT // (1024 * 1024)} MB)", 413)
        if not size:
            return _err("Fișier gol")
        out_dir.mkdir()
        proc = await asyncio.create_subprocess_exec(
            *_child_cmd("app.ingest", "--font", upload, out_dir),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=str(Path(__file__).resolve().parents[1]), **_child_kw(),
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), INGEST_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return _err("Font respins: citirea a durat prea mult")
        try:
            res = json.loads(out.decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            res = {}
        if not res:
            res = _read_json(out_dir / "result.json", {}) or {}
        if not res.get("ok"):
            return _err(res.get("error") or "Font respins")
        FONTS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(upload), FONTS_DIR / name)
        return JSONResponse({"fonts": _font_list(), "added": {"name": name, "family": res.get("family", ""), "kind": res.get("kind", "")}})
    finally:
        with contextlib.suppress(OSError):
            upload.unlink()
        shutil.rmtree(out_dir, ignore_errors=True)


async def api_workspace(request: Request):
    """Workspace code (private modes only): copy it to continue in another
    browser; POST with another code moves this browser to that space."""
    if MODE == "personal":
        return JSONResponse({"mode": MODE})
    if request.method == "POST":
        try:
            body = await _json_body(request, 4096)
        except (OverflowError, ValueError):
            return _err("Cerere invalidă")
        code = str((body or {}).get("code", "")).strip()
        if not _WS_RE.match(code):
            return _err("Cod invalid")
        resp = JSONResponse({"mode": MODE, "ok": True})
        _set_ws_cookie(resp, request, code)
        return resp
    return JSONResponse({"mode": MODE, "code": request.scope.get("state", {}).get("ws")})


def _set_ws_cookie(resp, request, token):
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(WS_COOKIE, token, max_age=None if MODE == "session" else 365 * 86400, httponly=True, samesite="strict", secure=secure, path="/")


routes = [
    Route("/api/health", api_health),
    Route("/api/fonts", api_fonts, methods=["GET", "POST", "DELETE"]),
    Route("/api/open", api_open, methods=["POST"]),
    Route("/api/docs", api_docs),
    Route("/api/workspace", api_workspace, methods=["GET", "POST"]),
    Route("/api/doc/{doc_id}", api_doc, methods=["GET", "DELETE"]),
    Route("/api/doc/{doc_id}/state", api_state, methods=["PUT", "POST"]),  # POST for sendBeacon
    Route("/api/doc/{doc_id}/page/{n:int}/render", api_render),
    Route("/api/doc/{doc_id}/thumb", api_thumb),
    Route("/api/doc/{doc_id}/page/{n:int}/preview", api_preview, methods=["POST"]),
    Route("/api/doc/{doc_id}/page/{n:int}/snap", api_snap),
    Route("/api/doc/{doc_id}/page/{n:int}/snapscan", api_snap_scan),
    Route("/api/doc/{doc_id}/page/{n:int}/objects", api_objects, methods=["POST"]),
    Route("/api/doc/{doc_id}/page/{n:int}/ocr", api_ocr, methods=["GET", "POST"]),
    Route("/api/doc/{doc_id}/page/{n:int}/text", api_text),
    Route("/api/doc/{doc_id}/pages", api_pages, methods=["POST"]),
    Route("/api/doc/{doc_id}/dxf-layers", api_dxf_layers, methods=["POST"]),
    Route("/api/doc/{doc_id}/dxf-units", api_dxf_units, methods=["POST"]),
    Route("/api/doc/{doc_id}/export", api_export, methods=["POST"]),
    Route("/api/doc/{doc_id}/images", api_image_add, methods=["POST"]),
    Route("/api/doc/{doc_id}/compare", api_compare, methods=["POST"]),
    Route("/api/doc/{doc_id}/image/{img}", api_image_get),
    Mount("/", app=StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static"),
]

@contextlib.asynccontextmanager
async def lifespan(_app):
    # uploads interrupted by a previous shutdown
    shutil.rmtree(INCOMING, ignore_errors=True)

    def warm():
        # OCR language detection (runs Tesseract) happens right at startup, not on the first request
        with contextlib.suppress(Exception):
            from . import ocr as ocrmod

            ocrmod.available_langs()

    threading.Thread(target=warm, name="drawcad-warmup", daemon=True).start()

    async def periodic():
        while True:
            with contextlib.suppress(Exception):
                await run_in_threadpool(cleanup_expired)
            await asyncio.sleep(6 * 3600)

    task = asyncio.create_task(periodic())
    try:
        yield
    finally:
        task.cancel()


# ------------------------------------------------------------------ HTTP security
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; "
    "form-action 'self'"
)
SECURITY_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"SAMEORIGIN"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
]
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in _env("ALLOWED_ORIGINS", "").split(",") if o.strip()}
# optional password (HTTP Basic), for when the app is reachable from outside the local network
AUTH_USER = _env("USER", "drawcad")
AUTH_PASSWORD = _env("PASSWORD", "")


def _auth_ok(header: str) -> bool:
    import base64
    import hmac

    if not header.lower().startswith("basic "):
        return False
    try:
        user, _, pw = base64.b64decode(header[6:].strip()).decode("utf-8").partition(":")
    except Exception:  # noqa: BLE001
        return False
    return hmac.compare_digest(user.encode(), AUTH_USER.encode()) & hmac.compare_digest(pw.encode(), AUTH_PASSWORD.encode())


_DOC_PATH = re.compile(r"^/api/doc/([a-f0-9]{32})(/|$)")


class SecurityMiddleware:
    """Security headers on all responses and rejection of data-changing requests coming
    from another site (a foreign page open in the browser cannot upload or delete documents)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        hdr = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if ALLOWED_HOSTS:
            # protects the local server from "DNS rebinding": a foreign site whose name points to
            # 127.0.0.1 would pass the origin check, but not the host name check
            hname = hdr.get("host", "").rsplit(":", 1)[0].strip("[]").lower()
            if hname not in ALLOWED_HOSTS:
                resp = Response("Gazdă nepermisă", status_code=421)
                return await resp(scope, receive, send)
        if AUTH_PASSWORD and scope.get("path") != "/api/health" and not _auth_ok(hdr.get("authorization", "")):
            resp = Response("Autentificare necesară", status_code=401, headers={"WWW-Authenticate": 'Basic realm="DrawCAD", charset="UTF-8"'})
            return await resp(scope, receive, send)
        if scope["method"] not in ("GET", "HEAD", "OPTIONS"):
            origin = hdr.get("origin", "").rstrip("/")
            host = hdr.get("x-forwarded-host") or hdr.get("host", "")
            same = origin and origin.split("://", 1)[-1] == host
            if hdr.get("sec-fetch-site") == "cross-site" or (origin and origin != "null" and not same and origin not in ALLOWED_ORIGINS):
                resp = JSONResponse({"error": "Cerere refuzată: vine de pe alt site"}, status_code=403)
                return await resp(scope, receive, send)

        new_cookie = None
        if MODE != "personal":
            # each browser has a secret code (HttpOnly cookie); its documents carry the hash of the code
            token = None
            for part in hdr.get("cookie", "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == WS_COOKIE and _WS_RE.match(v):
                    token = v
            if not token:
                import secrets

                token = secrets.token_urlsafe(24)
                new_cookie = token
            st = scope.setdefault("state", {})
            st["ws"] = token
            st["owner"] = _owner_of(token)
            m = _DOC_PATH.match(scope.get("path", ""))
            if m:
                meta = _read_json(DOCS / m.group(1) / "meta.json") or {}
                if meta.get("owner") != st["owner"]:
                    # someone else's document (or one from personal mode): for this browser it does not exist
                    resp = JSONResponse({"error": "Document inexistent"}, status_code=404)
                    return await resp(scope, receive, send)

        async def send_wrapped(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                have = {k.lower() for k, _ in headers}
                headers += [(k, v) for k, v in SECURITY_HEADERS if k not in have]
                if new_cookie and b"set-cookie" not in have:
                    secure = scope.get("scheme") == "https" or hdr.get("x-forwarded-proto") == "https"
                    c = f"{WS_COOKIE}={new_cookie}; Path=/; HttpOnly; SameSite=Strict"
                    if MODE != "session":
                        c += f"; Max-Age={365 * 86400}"
                    if secure:
                        c += "; Secure"
                    headers.append((b"set-cookie", c.encode("latin-1")))
                message["headers"] = headers
            await send(message)

        if not DESKTOP:
            return await self.app(scope, receive, send_wrapped)
        # desktop app: slow requests are logged (%LOCALAPPDATA%\\DrawCAD\\drawcad.log)
        t0 = time.monotonic()
        try:
            return await self.app(scope, receive, send_wrapped)
        finally:
            dt = time.monotonic() - t0
            if dt > 3:
                logging.getLogger("drawcad").warning("slow request: %s %s %.1f s", scope["method"], scope.get("path"), dt)


DOCS.mkdir(parents=True, exist_ok=True)
app = Starlette(
    routes=routes,
    lifespan=lifespan,
    middleware=[
        Middleware(SecurityMiddleware),
        # snap JSON and JS modules compress well; PNGs and PDFs do not
        Middleware(GZipMiddleware, minimum_size=1024, exclude_content_types=("image/png", "application/pdf", "text/event-stream")),
    ],
)
