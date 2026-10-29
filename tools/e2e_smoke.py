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

        # 7. cotă unghiulară de 30°
        page.keyboard.press("Escape")
        page.keyboard.press("u")
        click(30, 150)
        click(70, 150)
        click(64.641, 130)
        click(54.15, 143.53)
        ang = page.evaluate("(() => { const a = window.cotare.selected(); return window.cotare.builtOf(a).measured; })()")
        assert abs(ang - 30) < 0.01, ang

        # 8. rugozitate Ra 1,6 pe suprafața de sus a treptei Ø40, direct pe contur
        page.keyboard.press("Escape")
        page.keyboard.press("q")
        click(125, 75)
        click(125, 75)
        page.click("[data-act=rval][data-v='Ra 1,6']")
        page.click("[data-act=scale][data-v='0.7']")
        assert page.evaluate("window.cotare.selected().scale") == 0.7
        # 9. copiere + lipire: a doua rugozitate pe treapta Ø30
        page.keyboard.press("v")  # rugozitatea nou creată rămâne selectată
        page.keyboard.press("Control+c")
        x, y = scr(160, 80)
        page.mouse.move(x, y)
        page.keyboard.press("Control+v")
        page.wait_for_timeout(100)
        n_rough = page.evaluate("window.cotare.annots.filter(a => a.type === 'rough').length")
        assert n_rough == 2, n_rough
        # 10. snap pe intersecție: axa cu muchia de la x = 90
        snap = page.evaluate("(() => { const s = window.cotare.snapIdx.nearest(90*72/25.4 + 0.6, 95*72/25.4 + 0.6, 3); return s && [s.kind, s.p]; })()")
        assert snap and snap[0] == "x" and abs(snap[1][0] - 90 * MM) < 0.05, snap

        # 11. note tehnice
        page.keyboard.press("Escape")
        page.keyboard.press("n")
        click(95, 135)
        page.fill("#nTxt", "Muchiile nespecificate se teșesc 0,5×45°\nToleranțe generale ISO 2768-mK")
        page.click("[data-act=ntpl][data-v='Călire + revenire 48–52 HRC']")
        page.press("#nTxt", "Escape")

        # 12. tabel de revizii deasupra cartușului, completat din cota tăiată
        page.keyboard.press("f")
        page.wait_for_timeout(300)
        page.keyboard.press("e")
        click(287, 170)
        rows = page.evaluate("window.cotare.selected().rows")
        assert rows and rows[0]["rev"] == "1" and "120" in rows[0]["desc"], rows
        page.fill("[data-row='0'][data-col='name']", "OV")
        page.press("[data-row='0'][data-col='name']", "Escape")
        # micșorare prin tragere de pătrățelul din colț, spre ancoră (colțul cartușului)
        hx, hy, ax, ay = page.evaluate("""(() => { const app = window.cotare, a = app.selected();
            const h = app.builtOf(a).handles.find(q => q.k === 'sc'); const r = document.getElementById('canvas').getBoundingClientRect();
            const s1 = app.view.toScreen(h.p), s2 = app.view.toScreen(a.p);
            return [s1[0] + r.left, s1[1] + r.top, s2[0] + r.left, s2[1] + r.top]; })()""")
        page.mouse.move(hx, hy)
        page.mouse.down()
        page.mouse.move((hx + ax) / 2, (hy + ay) / 2, steps=6)
        page.mouse.up()
        sc = page.evaluate("window.cotare.selected().scale")
        assert 0.4 <= sc <= 0.6, sc
        page.keyboard.press("Escape")
        # text pe două rânduri
        page.keyboard.press("t")
        click(25, 112)
        page.fill("#tTxt", "Text pe\ndouă rânduri")
        page.press("#tTxt", "Escape")
        n_lines = page.evaluate("window.cotare.builtOf(window.cotare.selected()).prims.filter(p => p.t === 'T').length")
        assert n_lines == 2, n_lines
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -25*72/25.4*2.2; v.panY = -38*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)

        # selecție multiplă: Ctrl+A, apoi dreptunghi peste detaliul cu unghi și deplasare cu săgeata
        page.keyboard.press("v")
        page.keyboard.press("Control+a")
        n_all = page.evaluate("window.cotare.sel.size")
        assert n_all == page.evaluate("window.cotare.annots.filter(a => a.page === 0).length"), n_all
        page.keyboard.press("Escape")
        x0, y0 = scr(45, 130)
        x1, y1 = scr(78, 156)
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=5)
        page.mouse.up()
        kinds_sel = page.evaluate("window.cotare.selectedAll().map(a => a.type)")
        assert "ang" in kinds_sel, kinds_sel
        v_before = page.evaluate("window.cotare.annots.find(a => a.type === 'ang').v[0]")
        page.keyboard.press("ArrowRight")
        v_after = page.evaluate("window.cotare.annots.find(a => a.type === 'ang').v[0]")
        assert abs((v_after - v_before) - 0.5 * MM) < 1e-6, (v_before, v_after)
        page.keyboard.press("Control+z")
        page.keyboard.press("Escape")

        # 13. ștergere reală: textul Ø30 și linia lui de cotă
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

        # 14. desen: o linie întreruptă și axele cercului din vederea laterală
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(300)
        page.keyboard.press("i")
        page.click('[data-st="preset"][data-v="hid"]')
        click(40, 172)
        click(80, 172)
        page.keyboard.press("Escape")
        page.click('[data-tool="cross"]')
        click(240, 95)
        click(260, 95)
        page.keyboard.press("Escape")
        shapes = page.evaluate("window.cotare.annots.filter(a => a.type === 'shape').map(a => a.kind + ':' + a.ltype)")
        assert shapes == ["line:dash", "cross:chain"], shapes

        # selectează cota Ø25 pentru captură
        page.keyboard.press("v")
        click(75, 90)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / "editor.png"))

        kinds = page.evaluate("window.cotare.annots.map(a => a.type)")
        assert len(kinds) == 15, kinds

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
        page.wait_for_function("window.cotare.annots.length === 15")
        # închidere fără modificări: direct la pagina de start
        page.click("#btnClose")
        page.wait_for_function("window.cotare.doc === null && !document.getElementById('emptyState').hidden")
        page.wait_for_function("document.querySelectorAll('#recentList [data-doc]').length >= 1", timeout=5000)
        # redeschidere din Recente, o modificare, apoi închidere cu întrebare
        page.click("#recentList [data-doc]")
        page.wait_for_function("window.cotare.doc !== null && window.cotare.annots.length === 15")
        page.wait_for_timeout(300)
        page.keyboard.press("t")
        click(100, 30)
        page.press("#tTxt", "Escape")
        page.click("#btnClose")
        page.wait_for_selector("#cClose")
        page.click("#cClose")
        page.wait_for_function("window.cotare.doc === null")
        b.close()

    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(path))
    img = doc[0].render(scale=3).to_pil()
    img.save(out / "export_p1.png")
    # decupaj pe zona arborelui
    img.crop((int(20 * MM * 3), int(38 * MM * 3), int(195 * MM * 3), int(160 * MM * 3))).save(out / "export_zoom.png")
    img.crop((int(80 * MM * 3), int(115 * MM * 3), int(292 * MM * 3), int(205 * MM * 3))).save(out / "export_note_cartus.png")
    txt = doc[0].get_textpage().get_text_range()
    print("TEXT:", " | ".join(t for t in txt.split() if t))
    print("ERORI CONSOLĂ:", errors or "niciuna")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765", sys.argv[2] if len(sys.argv) > 2 else "e2e_out")
