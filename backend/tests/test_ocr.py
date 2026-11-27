"""OCR preparation and vectorization worked in strips give the same result as on the whole page."""
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import ocr  # noqa: E402
from app.vectorize import otsu_hist  # noqa: E402


def drawing(w=700, h=520, seed=3):
    """Lines (some ragged, some crossing), letters touching lines, specks."""
    rng = np.random.default_rng(seed)
    im = Image.new("L", (w, h), 235)
    d = ImageDraw.Draw(im)
    for y in range(30, h, 47):
        d.line([(10, y), (w - 10, y)], fill=20, width=int(rng.integers(1, 4)))
    for x in range(25, w, 61):
        d.line([(x, 5), (x, h - 5)], fill=30, width=int(rng.integers(1, 4)))
    for _ in range(60):
        x, y = int(rng.integers(0, w - 30)), int(rng.integers(0, h - 20))
        d.text((x, y), "Ø25", fill=10)
    a = np.array(im)
    noise = rng.random(a.shape) < 0.01
    a[noise] = rng.integers(0, 255, int(noise.sum()), dtype=np.uint8)
    # ragged edges along some lines
    for y in range(30, h, 94):
        cols = rng.random(w) < 0.2
        a[y + 2, cols] = 40
    return a


def denoise_whole(gray):
    """The filter on the whole page at once (the reference)."""
    f = np.asarray(Image.fromarray(gray).filter(ImageFilter.MedianFilter(3)))
    t = otsu_hist(np.bincount(f.ravel(), minlength=256))
    return np.where(f < t, np.uint8(0), np.uint8(255))


class OcrStripsTest(unittest.TestCase):
    def test_lines_removed_the_same_in_strips(self):
        g = drawing()
        for ragged in (False, True):
            whole = ocr.remove_long_lines(g, 3.0, ragged=ragged, strip=10**6)
            self.assertFalse(np.array_equal(whole, g), "something is removed")
            for strip in (16, 37, 100):
                part = ocr.remove_long_lines(g, 3.0, ragged=ragged, strip=strip)
                self.assertTrue(np.array_equal(whole, part), (ragged, strip, int((whole != part).sum())))

    def test_denoise_in_place_same_as_whole(self):
        g = drawing(1300, 2300, seed=5)  # more than two strips of 1024 rows
        ref = denoise_whole(g)
        work = g.copy()
        out = ocr._denoise(work)
        self.assertTrue(np.array_equal(out, ref), int((out != ref).sum()))
        self.assertIs(out, work)
        ro = g.copy()
        ro.flags.writeable = False
        self.assertTrue(np.array_equal(ocr._denoise(ro), ref))


class VectorizeStripsTest(unittest.TestCase):
    def test_same_result_in_bands(self):
        from app import vectorize as V

        im = Image.new("L", (420, 300), 255)
        d = ImageDraw.Draw(im)
        d.rectangle([20, 20, 400, 280], outline=0, width=3)
        d.ellipse([120, 80, 220, 180], outline=0, width=3)
        d.line([(20, 150), (400, 150)], fill=0, width=2)
        d.line([(300, 20), (330, 280)], fill=0, width=4)
        d.arc([250, 60, 380, 190], 20, 160, fill=0, width=3)
        g = np.array(im)
        old = V._STRIP
        try:
            V._STRIP = 10**6
            whole = V.vectorize(g.copy(), 2.0)
            V._STRIP = 7  # many bands, each one with its margin rows
            bands = V.vectorize(g.copy(), 2.0)
        finally:
            V._STRIP = old
        self.assertTrue(whole["polys"] or whole["circles"])
        self.assertEqual(whole, bands)
        b = g < 128
        sk = V.thin(b)
        self.assertIs(sk.base, b, "a writable bool image is thinned in place")


if __name__ == "__main__":
    unittest.main()
