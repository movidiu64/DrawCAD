"""Iconița aplicației desktop (drawcad.ico): semnul de cotă din antet, portocaliu pe fond închis."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).with_name("drawcad.ico")
ORANGE = (242, 169, 59, 255)
BG = (30, 34, 41, 255)


def draw(size: int) -> Image.Image:
    k = 4  # desenat mare și micșorat, pentru margini netede
    S = size * k
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.2), fill=BG)
    w = max(k * 2, int(S * 0.085))
    m = S * 0.22
    y = S / 2
    # liniile de extindere, linia de cotă și săgețile (ca în favicon: M3 5v14 M21 5v14 M3 12h18 …)
    d.line([(m, S * 0.25), (m, S * 0.75)], fill=ORANGE, width=w)
    d.line([(S - m, S * 0.25), (S - m, S * 0.75)], fill=ORANGE, width=w)
    d.line([(m, y), (S - m, y)], fill=ORANGE, width=w)
    a = S * 0.14
    d.polygon([(m + w / 2, y), (m + a, y - a * 0.6), (m + a, y + a * 0.6)], fill=ORANGE)
    d.polygon([(S - m - w / 2, y), (S - m - a, y - a * 0.6), (S - m - a, y + a * 0.6)], fill=ORANGE)
    return im.resize((size, size), Image.LANCZOS)


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    big = draw(256)
    big.save(OUT, sizes=[(s, s) for s in sizes], append_images=[draw(s) for s in sizes[:-1]])
    big.save(OUT.with_suffix(".png"))
    print(OUT)


if __name__ == "__main__":
    main()
