"""Test de fum în browser (Playwright + Chromium): deschide PDF-ul de test, cotează,
adaugă toleranțe, GD&T, bază, revizie, ștergere, exportă și randează rezultatul.

Rulare (cu serverul pornit):  python tools/e2e_smoke.py http://127.0.0.1:8765 out_dir
"""
import io
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import make_sample  # noqa: E402

MM = 72 / 25.4


def main(url, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    sample = out / "arbore_intermediar_rev0.pdf"
    make_sample.build(str(sample))
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1600, "height": 1000}, accept_downloads=True)
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.evaluate("localStorage.clear()")
        page.goto(url)
        page.set_input_files("#fileInput", str(sample))
        page.wait_for_function("document.getElementById('docName').textContent.includes('arbore')")
        page.wait_for_timeout(800)

        def scr(mmx, mmy):
            return page.evaluate(
                "([x,y]) => { const v = window.cotare.view; const r = document.getElementById('canvas').getBoundingClientRect();"
                " const s = v.toScreen([x,y]); return [s[0]+r.left, s[1]+r.top]; }",
                [mmx * MM, mmy * MM],
            )

        def click(mmx, mmy):
            x, y = scr(mmx, mmy)
            page.mouse.move(x, y)
            page.mouse.click(x, y)
            page.wait_for_timeout(60)

        # zoom pe zona arborelui, ca snap-ul să fie precis
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -25*72/25.4*2.2; v.panY = -38*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(500)

        # 1. cotă Ø25 cu k6
        page.keyboard.press("o")
        click(75, 82.6)
        click(75, 107.4)
        click(75, 95)
        page.click("[data-act=tolmode][data-v=iso]")
        page.fill("#tFit", "k6")
        page.press("#tFit", "Escape")
        page.wait_for_timeout(100)
        kv = page.inner_text(".kv")
        assert "+0,015" in kv and "+0,002" in kv, kv

        # 2. cotă liniară 40 sub treapta Ø30
        page.keyboard.press("d")
        click(140, 110)
        click(180, 110)
        click(160, 127)

        # 3. GD&T coaxialitate spre linia de cotă Ø25
        page.keyboard.press("g")
        click(75, 107.5)
        click(36, 122)

        # 4. bază A pe Ø40
        page.keyboard.press("b")
        click(115, 115)
        click(115, 127)

        # 5. revizie: 118 → 120
        page.keyboard.press("s")
        x0, y0 = scr(116.2, 45.8)
        x1, y1 = scr(123.8, 49.6)
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=4)
        page.mouse.up()
        page.wait_for_timeout(100)
        page.fill("#sNew", "120")
        page.press("#sNew", "Escape")

        # 6. teșitură
        page.keyboard.press("Escape")
        page.keyboard.press("c")
        click(60.5, 83)
        click(48, 72)

        # 7. ștergere reală: textul Ø30 și linia lui de cotă
        page.keyboard.press("x")
        x0, y0 = scr(160, 77)
        x1, y1 = scr(167.5, 113)
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=4)
        page.mouse.up()
        page.wait_for_selector("#rOk")
        page.wait_for_timeout(900)
        page.screenshot(path=str(out / "dialog_stergere.png"))
        page.click("#rOk")
        page.wait_for_timeout(200)

        # selectează cota Ø25 pentru captură
        page.keyboard.press("v")
        click(75, 90)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / "editor.png"))

        kinds = page.evaluate("window.cotare.annots.map(a => a.type)")
        assert len(kinds) == 7, kinds

        # export
        page.click("#btnExport")
        page.wait_for_selector("#eGo")
        with page.expect_download() as dl:
            page.click("#eGo")
        path = out / "export.pdf"
        dl.value.save_as(str(path))
        page.wait_for_timeout(300)

        # redeschidere: cotele revin editabile
        page.set_input_files("#fileInput", str(path))
        page.wait_for_function("window.cotare.annots.length === 7")
        b.close()

    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(path))
    img = doc[0].render(scale=3).to_pil()
    img.save(out / "export_p1.png")
    # decupaj pe zona arborelui
    img.crop((int(25 * MM * 3), int(38 * MM * 3), int(195 * MM * 3), int(135 * MM * 3))).save(out / "export_zoom.png")
    txt = doc[0].get_textpage().get_text_range()
    print("TEXT:", " | ".join(t for t in txt.split() if t))
    print("ERORI CONSOLĂ:", errors or "niciuna")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765", sys.argv[2] if len(sys.argv) > 2 else "e2e_out")
