# -*- mode: python ; coding: utf-8 -*-
# PyInstaller: DrawCAD for Windows, as a folder (starts faster than a single .exe).
# Run (from the repo root):  pyinstaller desktop/drawcad.spec --noconfirm
# The TESSERACT_DIR variable (optional) points to the folder with tesseract.exe, its DLLs and tessdata.
import os
import sys

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
sys.path.insert(0, os.path.join(ROOT, "backend"))

datas = [(os.path.join(ROOT, "frontend"), "frontend")]
binaries = []
hiddenimports = [
    "app.main", "app.ingest", "app.vectorize", "app.ocr", "app.dxfout", "app.dxfin", "app.pdfcore", "app.sanitize",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.loops.asyncio", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
]
for pkg in ("pypdfium2", "pypdfium2_raw", "ezdxf", "reportlab", "webview", "pikepdf", "img2pdf"):
    try:
        d, b, h = collect_all(pkg)
    except Exception as e:  # noqa: BLE001
        print(f"collect_all({pkg}) failed: {e}")
        continue
    datas += d
    binaries += b
    hiddenimports += h

tess = os.environ.get("TESSERACT_DIR")
if tess and os.path.isdir(tess):
    datas.append((tess, "tesseract"))
# LIBREDWG_DIR (optional): dwg2dxf.exe and libredwg-0.dll, for opening DWG drawings
ldwg = os.environ.get("LIBREDWG_DIR")
if ldwg and os.path.isdir(ldwg):
    datas.append((ldwg, "libredwg"))

a = Analysis(
    [os.path.join(SPECPATH, "drawcad_desktop.py")],
    pathex=[os.path.join(ROOT, "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["matplotlib", "scipy", "pytest", "IPython", "playwright", "pandas"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DrawCAD",
    console=False,
    icon=os.path.join(SPECPATH, "drawcad.ico"),
    version=os.path.join(SPECPATH, "version_info.txt") if os.path.exists(os.path.join(SPECPATH, "version_info.txt")) else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="DrawCAD")
