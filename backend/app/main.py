"""Server HTTP: API pentru documente + frontend static."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from urllib.parse import quote

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import pdfcore

DATA_DIR = Path(os.environ.get("COTARE_DATA", "/data"))
FRONTEND_DIR = Path(os.environ.get("COTARE_FRONTEND", Path(__file__).resolve().parents[2] / "frontend"))
MAX_UPLOAD = int(os.environ.get("COTARE_MAX_UPLOAD_MB", "200")) * 1024 * 1024
MAX_RENDER_PX = int(os.environ.get("COTARE_MAX_RENDER_PX", "12000"))
# documentele nefolosite atâtea zile se șterg automat (0 = niciodată)
RETENTION_DAYS = float(os.environ.get("COTARE_RETENTION_DAYS", "30"))

DOCS = DATA_DIR / "docs"
_ID_RE = re.compile(r"^[a-f0-9]{32}$")


class LRU(OrderedDict):
    def __init__(self, size):
        super().__init__()
        self.size = size

    def get_or(self, key, fn):
        if key in self:
            self.move_to_end(key)
            return self[key]
        val = fn()
        self[key] = val
        if len(self) > self.size:
            self.popitem(last=False)
        return val


_bytes_cache = LRU(8)
_render_cache = LRU(48)
_snap_cache = LRU(32)


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


# ------------------------------------------------------------------ API


async def api_open(request: Request):
    name = request.headers.get("x-filename", "document.pdf")
    try:
        name = bytes(name, "latin-1").decode("utf-8")
    except Exception:
        pass
    name = os.path.basename(name)[:200] or "document.pdf"
    dpi_h = request.headers.get("x-dpi")
    body = await request.body()
    if not body:
        return _err("Fișier gol")
    if len(body) > MAX_UPLOAD:
        return _err("Fișier prea mare", 413)

    def work():
        kind = "pdf"
        dpi = None
        state = None
        data = body
        if data[:5] != b"%PDF-":
            try:
                data, dpi = pdfcore.image_to_pdf(data, float(dpi_h) if dpi_h else None)
                kind = "image"
            except Exception as e:  # noqa: BLE001
                raise ValueError(f"Nu e PDF și nici imagine citibilă: {e}") from e
        else:
            emb = pdfcore.extract_embedded(data)
            if emb:
                data, js = emb
                try:
                    state = json.loads(js.decode("utf-8"))
                except Exception:
                    state = None
        info = pdfcore.open_info(data)
        doc_id = uuid.uuid4().hex
        d = DOCS / doc_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "original.pdf").write_bytes(data)
        meta = {
            "id": doc_id,
            "name": name,
            "kind": kind,
            "dpi": dpi,
            "created": time.time(),
            "updated": time.time(),
            "pages": info["pages"],
            "fromExport": state is not None,
        }
        _write_json(d / "meta.json", meta)
        if state is not None:
            _write_json(d / "state.json", state)
        return {**meta, "expires": _expires(meta), "state": state}

    try:
        res = await run_in_threadpool(work)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:  # noqa: BLE001
        return _err(f"PDF imposibil de citit: {e}")
    return JSONResponse(res)


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
        logging.getLogger("cotare").info("curățare: %d documente expirate șterse", len(removed))
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
    data = await request.json()
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
    scale = float(request.query_params.get("scale", "1"))
    p = meta["pages"][n]
    max_side = max(p["w"], p["h"]) * scale
    if max_side > MAX_RENDER_PX:
        scale = MAX_RENDER_PX / max(p["w"], p["h"])
    scale = round(max(0.1, scale), 3)

    def work():
        return _render_cache.get_or((doc_id, n, scale), lambda: pdfcore.render_png(_original(doc_id), n, scale))

    png = await run_in_threadpool(work)
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600", "X-Scale": str(scale)})


async def api_preview(request: Request):
    """Randare cu ștergerile aplicate (pentru dialogul de ștergere)."""
    doc_id = request.path_params["doc_id"]
    try:
        n, _meta = _page_index(doc_id, request.path_params["n"])
    except (ValueError, FileNotFoundError, IndexError):
        return _err("Pagină inexistentă", 404)
    body = await request.json()
    ops = body.get("ops", [])
    scale = min(float(body.get("scale", 2)), 6)
    png = await run_in_threadpool(pdfcore.render_png, _original(doc_id), n, scale, ops)
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
    body = await request.json()
    rect = body.get("rect")
    if not rect or len(rect) != 4:
        return _err("rect lipsă")
    res = await run_in_threadpool(pdfcore.objects_in_rect, _original(doc_id), n, rect)
    return JSONResponse({"objects": res})


async def api_export(request: Request):
    doc_id = request.path_params["doc_id"]
    try:
        d = _doc_dir(doc_id)
    except (ValueError, FileNotFoundError):
        return _err("Document inexistent", 404)
    body = await request.json()
    filename = os.path.basename(body.get("filename") or "export.pdf")
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    prims = {int(k): v for k, v in (body.get("pages") or {}).items()}
    rem = {int(k): v for k, v in (body.get("removals") or {}).items()}
    state = body.get("state")
    embed = bool(body.get("embed", True))
    color = body.get("colorMode", "black")

    def work():
        st = json.dumps(state, ensure_ascii=False).encode("utf-8") if (embed and state is not None) else None
        return pdfcore.export_pdf(_original(doc_id), prims, rem, color, st, embed)

    try:
        pdf, reports = await run_in_threadpool(work)
    except Exception as e:  # noqa: BLE001
        return _err(f"Export eșuat: {e}", 500)
    ascii_name = filename.encode("ascii", "replace").decode().replace("?", "_")
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


DOCS.mkdir(parents=True, exist_ok=True)
app = Starlette(routes=routes, lifespan=lifespan)
