"""Server HTTP: API pentru documente + frontend static."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import sys
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
    """DRAWCAD_<nume>, cu COTARE_<nume> acceptat în continuare (numele vechi al aplicației)."""
    return os.environ.get(f"DRAWCAD_{name}") or os.environ.get(f"COTARE_{name}") or default


DATA_DIR = Path(_env("DATA", "/data"))
FRONTEND_DIR = Path(_env("FRONTEND", Path(__file__).resolve().parents[2] / "frontend"))
MAX_UPLOAD = int(_env("MAX_UPLOAD_MB", "200")) * 1024 * 1024
MAX_RENDER_PX = int(_env("MAX_RENDER_PX", "12000"))
# documentele nefolosite atâtea zile se șterg automat (0 = niciodată)
RETENTION_DAYS = float(_env("RETENTION_DAYS", "30"))

DOCS = DATA_DIR / "docs"
_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_OID_RE = re.compile(r"^\d{1,6}(\.\d{1,6}){0,8}$")  # id-ul unui obiect din pagină: „12” sau „3.4.1”


class LRU(OrderedDict):
    """Cache LRU limitat la număr de intrări și, opțional, la memorie (octeți)."""

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
            return val  # prea mare pentru cache
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


CACHE_MB = int(_env("CACHE_MB", "512"))
_bytes_cache = LRU(8, CACHE_MB * 1024 * 1024 // 2)
_render_cache = LRU(64, CACHE_MB * 1024 * 1024 // 2)
_snap_cache = LRU(32)
_ink_cache = LRU(8, CACHE_MB * 1024 * 1024 // 4)


def _source(doc_id, n, ink):
    """PDF-ul de randat: originalul, sau originalul cu pagina n înnegrită (rezultat ținut în cache)."""
    if not (ink and ink.get("all")):
        return _original(doc_id)
    key = (doc_id, n, str(ink.get("fills", "black")), bool(ink.get("images")))
    return _ink_cache.get_or(key, lambda: pdfcore.ink_pdf(_original(doc_id), {n}, key[2], key[3]))


def _err(msg, code=400):
    return JSONResponse({"error": msg}, status_code=code)


def _doc_dir(doc_id: str) -> Path:
    if not _ID_RE.match(doc_id or ""):
        raise ValueError("id invalid")
    d = DOCS / doc_id
    if not d.is_dir():
        raise FileNotFoundError(doc_id)
    return d


def _original(doc_id: str) -> bytes:
    return _bytes_cache.get_or(doc_id, lambda: (_doc_dir(doc_id) / "original.pdf").read_bytes())


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


# ------------------------------------------------------------------ validarea datelor primite

def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e7


PRIM_TYPES = {"L", "P", "R", "C", "T"}


def _clean_prims(prims):
    """Primitivele de desenat la export: doar tipurile cunoscute, numere finite, dimensiuni rezonabile."""
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
        out.append(q)
    return out


def _clean_ops(ops):
    """Operațiile de ștergere / înnegrire: moduri cunoscute, id-uri și dreptunghiuri valide."""
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
    """Citește corpul cererii în flux, oprindu-se la `limit` octeți (fără să-l țină tot în memorie
    când merge într-un fișier). Întoarce octeții sau numărul de octeți scriși."""
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
    out_dir = INCOMING / tmp_id
    try:
        try:
            size = await _read_limited(request, MAX_UPLOAD, upload)
        except OverflowError:
            return _err(f"Fișier prea mare (limita e {MAX_UPLOAD // (1024 * 1024)} MB)", 413)
        if not size:
            return _err("Fișier gol")
        out_dir.mkdir()
        # fișierul necunoscut se citește prima dată într-un proces separat, limitat în memorie și timp
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "app.ingest", str(upload), str(out_dir), str(dpi_v or ""),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=str(Path(__file__).resolve().parents[1]),
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
        if not res.get("ok"):
            if not res and proc.returncode:
                return _err("Fișier respins: biblioteca de citire s-a oprit (fișier corupt sau construit special)")
            return _err(res.get("error") or "Fișier respins")
        doc_id = uuid.uuid4().hex
        d = DOCS / doc_id
        d.mkdir(parents=True)
        (out_dir / "original.pdf").replace(d / "original.pdf")
        state = res.get("state")
        meta = {
            "id": doc_id,
            "name": name,
            "kind": res["kind"],
            "dpi": res.get("dpi"),
            "created": time.time(),
            "updated": time.time(),
            "pages": res["pages"],
            "fromExport": state is not None,
            "removed": res.get("removed") or {},
        }
        _write_json(d / "meta.json", meta)
        if state is not None:
            _write_json(d / "state.json", state)
        return JSONResponse({**meta, "expires": _expires(meta), "state": state})
    finally:
        upload.unlink(missing_ok=True)
        shutil.rmtree(out_dir, ignore_errors=True)


async def api_docs(request: Request):
    out = []
    if DOCS.is_dir():
        for d in DOCS.iterdir():
            m = _read_json(d / "meta.json")
            if m:
                item = {k: m.get(k) for k in ("id", "name", "kind", "updated", "pages")}
                item["updated"] = _last_used(m)
                item["expires"] = _expires(m)
                out.append(item)
    out.sort(key=lambda m: m.get("updated") or 0, reverse=True)
    return JSONResponse(out[:30])


def _last_used(meta: dict) -> float:
    return max(meta.get("updated") or 0, meta.get("accessed") or 0, meta.get("created") or 0)


def _expires(meta: dict):
    if RETENTION_DAYS <= 0:
        return None
    return _last_used(meta) + RETENTION_DAYS * 86400


def cleanup_expired(now: float | None = None) -> list[str]:
    """Șterge documentele nefolosite de mai mult de RETENTION_DAYS zile."""
    if RETENTION_DAYS <= 0 or not DOCS.is_dir():
        return []
    now = now or time.time()
    removed = []
    for d in DOCS.iterdir():
        if not d.is_dir() or not _ID_RE.match(d.name):
            continue
        meta = _read_json(d / "meta.json")
        if meta is None:
            # document incomplet (încărcare întreruptă): după o zi se curăță
            last = d.stat().st_mtime
            if now - last < 86400:
                continue
        elif now < _expires(meta):
            continue
        shutil.rmtree(d, ignore_errors=True)
        _bytes_cache.pop(d.name, None)
        removed.append(d.name)
    if removed:
        logging.getLogger("drawcad").info("curățare: %d documente expirate șterse", len(removed))
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
        _bytes_cache.pop(doc_id, None)
        for c in (_render_cache, _ink_cache, _snap_cache):
            for k in [k for k in c if k[0] == doc_id or (len(k) > 1 and k[1] == doc_id)]:
                c.pop(k, None)
        return JSONResponse({"ok": True})
    meta["accessed"] = time.time()
    _write_json(d / "meta.json", meta)
    return JSONResponse({**meta, "expires": _expires(meta), "state": _read_json(d / "state.json")})


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
    max_side = max(p["w"], p["h"]) * scale
    if max_side > MAX_RENDER_PX:
        scale = MAX_RENDER_PX / max(p["w"], p["h"])
    scale = round(max(0.1, scale), 3)
    # înnegrire pentru tipărire: tot desenul (ink) și/sau obiecte anume (bk = id-uri separate prin virgulă)
    ink = None
    if request.query_params.get("ink"):
        ink = {"all": True, "fills": request.query_params.get("fills", "black"), "images": request.query_params.get("img") == "1"}
    bk = [x for x in request.query_params.get("bk", "").split(",") if _OID_RE.match(x)][:5000]
    ops = [{"mode": "black", "ids": bk}] if bk else None
    key = (doc_id, n, scale, json.dumps(ink, sort_keys=True), ",".join(bk))

    def work():
        return _render_cache.get_or(key, lambda: pdfcore.render_png(_source(doc_id, n, ink), n, scale, ops))

    png = await run_in_threadpool(work)
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600", "X-Scale": str(scale)})


def _meta_page(doc_id, n):
    try:
        return _page_index(doc_id, n)[1]["pages"][n]
    except Exception:  # noqa: BLE001
        return None


async def api_preview(request: Request):
    """Randare cu ștergerile aplicate (pentru dialogul de ștergere)."""
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
        scale = min(float(body.get("scale", 2)), 16)
    except (TypeError, ValueError):
        return _err("Scară invalidă")
    try:
        ops = _clean_ops(ops)
    except ValueError as e:
        return _err(str(e))
    if p and max(p["w"], p["h"]) * scale > MAX_RENDER_PX:
        scale = MAX_RENDER_PX / max(p["w"], p["h"])
    scale = round(max(0.1, scale), 3)
    ink = body.get("ink") or None
    key = ("pv", doc_id, n, scale, json.dumps(ops, sort_keys=True), json.dumps(ink, sort_keys=True))

    def work():
        return _render_cache.get_or(key, lambda: pdfcore.render_png(_source(doc_id, n, ink if isinstance(ink, dict) else None), n, scale, ops))

    png = await run_in_threadpool(work)
    return Response(png, media_type="image/png")


async def api_snap(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        n, _meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)

    def work():
        return _snap_cache.get_or((doc_id, n), lambda: pdfcore.snap_points(_original(doc_id), n))

    return JSONResponse(await run_in_threadpool(work))


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
    res = await run_in_threadpool(pdfcore.objects_in_rect, _original(doc_id), n, rect)
    return JSONResponse({"objects": res})


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
    filename = os.path.basename(body.get("filename") or "export.pdf")
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    try:
        prims = {int(k): _clean_prims(v) for k, v in (body.get("pages") or {}).items()}
        rem = {int(k): _clean_ops(v) for k, v in (body.get("removals") or {}).items()}
    except (ValueError, TypeError, AttributeError) as e:
        return _err(f"Date de export invalide: {e}")
    state = body.get("state")
    embed = bool(body.get("embed", True))
    color = body.get("colorMode", "black")
    ink = body.get("ink") or None

    def work():
        st = json.dumps(state, ensure_ascii=False).encode("utf-8") if (embed and state is not None) else None
        return pdfcore.export_pdf(_original(doc_id), prims, rem, color, st, embed, ink)

    try:
        pdf, reports = await run_in_threadpool(work)
    except Exception as e:  # noqa: BLE001
        return _err(f"Export eșuat: {e}", 500)
    filename = re.sub(r"[\x00-\x1f\x7f\\/]", "_", filename)[:180]
    ascii_name = re.sub(r"[^A-Za-z0-9._ ()+-]", "_", filename)
    headers = {
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}",
        "X-Removal-Report": json.dumps(reports),
    }
    meta = _read_json(d / "meta.json", {})
    meta["updated"] = time.time()
    _write_json(d / "meta.json", meta)
    return Response(pdf, media_type="application/pdf", headers=headers)


async def api_health(request: Request):
    return JSONResponse({"ok": True, "retentionDays": RETENTION_DAYS})


routes = [
    Route("/api/health", api_health),
    Route("/api/open", api_open, methods=["POST"]),
    Route("/api/docs", api_docs),
    Route("/api/doc/{doc_id}", api_doc, methods=["GET", "DELETE"]),
    Route("/api/doc/{doc_id}/state", api_state, methods=["PUT", "POST"]),  # POST pentru sendBeacon
    Route("/api/doc/{doc_id}/page/{n:int}/render", api_render),
    Route("/api/doc/{doc_id}/page/{n:int}/preview", api_preview, methods=["POST"]),
    Route("/api/doc/{doc_id}/page/{n:int}/snap", api_snap),
    Route("/api/doc/{doc_id}/page/{n:int}/objects", api_objects, methods=["POST"]),
    Route("/api/doc/{doc_id}/export", api_export, methods=["POST"]),
    Mount("/", app=StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static"),
]

@contextlib.asynccontextmanager
async def lifespan(_app):
    # încărcări întrerupte la o oprire anterioară
    shutil.rmtree(INCOMING, ignore_errors=True)
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


# ------------------------------------------------------------------ securitate HTTP
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
# parolă opțională (HTTP Basic), pentru cazul în care aplicația e accesibilă din afara rețelei locale
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


class SecurityMiddleware:
    """Antete de securitate pe toate răspunsurile și refuzul cererilor care modifică date venite
    de pe alt site (o pagină străină deschisă în browser nu poate încărca sau șterge documente)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        hdr = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
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

        async def send_wrapped(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                have = {k.lower() for k, _ in headers}
                headers += [(k, v) for k, v in SECURITY_HEADERS if k not in have]
                message["headers"] = headers
            await send(message)

        return await self.app(scope, receive, send_wrapped)


DOCS.mkdir(parents=True, exist_ok=True)
app = Starlette(
    routes=routes,
    lifespan=lifespan,
    middleware=[
        Middleware(SecurityMiddleware),
        # JSON-ul de snap și modulele JS se comprimă bine; PNG-urile și PDF-urile nu
        Middleware(GZipMiddleware, minimum_size=1024, exclude_content_types=("image/png", "application/pdf", "text/event-stream")),
    ],
)
