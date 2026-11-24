"""Images placed on a drawing (logos, photos, sketches): decoded and written again from scratch.

Only PNG, JPEG and WebP are accepted. The pixels are decoded and saved into a new file, so nothing
else from the upload survives (metadata, comments, extra chunks, a second payload after the image).
Runs inside the limited reading process (ingest.py), never in the web server.
"""
from __future__ import annotations

import hashlib
import io

FORMATS = {"PNG", "JPEG", "WEBP"}
MAX_SIDE = 4000  # px, the long side after cleaning (enough for a logo or a photo on an A0 sheet)


class BadImage(Exception):
    pass


def clean_image(data: bytes, max_mpx: float = 100.0, max_side: int = MAX_SIDE) -> tuple[bytes, str, int, int]:
    """Returns (bytes, extension "png"/"jpg", width, height) of a clean copy of the image."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = int(max_mpx * 1e6)
    try:
        im = Image.open(io.BytesIO(data))
        fmt = im.format
        if fmt not in FORMATS:
            raise BadImage(f"format neacceptat ({fmt or 'necunoscut'}); doar PNG, JPG sau WebP")
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        w, h = im.size
        if w * h > max_mpx * 1e6:
            raise BadImage(f"imagine prea mare ({w}×{h} px)")
        im.load()
    except BadImage:
        raise
    except Image.DecompressionBombError as e:
        raise BadImage("imagine prea mare") from e
    except Exception as e:  # noqa: BLE001
        raise BadImage(f"imagine imposibil de citit: {e}") from e
    alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
    im = im.convert("RGBA" if alpha else ("L" if im.mode in ("1", "L", "I;16") else "RGB"))
    if max(im.size) > max_side:
        k = max_side / max(im.size)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    out = io.BytesIO()
    # photos stay JPEG; drawings, logos and anything with transparency are PNG (no blurred edges)
    if fmt == "JPEG" and not alpha:
        im.save(out, "JPEG", quality=90, optimize=True)
        ext = "jpg"
    else:
        im.save(out, "PNG", optimize=True)
        ext = "png"
    return out.getvalue(), ext, im.width, im.height


def image_id(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:24]
