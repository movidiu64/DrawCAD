"""Browser smoke test (Playwright + Chromium): opens the test PDF, adds dimensions,
tolerances, GD&T, a datum, a revision, a removal, exports and renders the result.

Run (with the server started):  python tools/e2e_smoke.py http://127.0.0.1:8765 out_dir
"""
import io
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import make_sample  # noqa: E402

MM = 72 / 25.4
_STATE = {}  # the page and the console errors, for the failure report


def main(url, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    sample = out / "arbore_intermediar_rev0.pdf"
    make_sample.build(str(sample))
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        # the app's CSP forbids eval; Playwright uses it for wait_for_function, so it is bypassed here
        page = b.new_page(viewport={"width": 1600, "height": 1000}, accept_downloads=True, bypass_csp=True)
        page.set_default_timeout(60000)  # CI can be slow (the isolated file read takes a few seconds)
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        _STATE.update(page=page, errors=errors, out=out)
        page.goto(url)
        page.evaluate("localStorage.clear()")
        # Romanian interface (by default it would follow the browser language, which in CI is English)
        page.evaluate("localStorage.setItem('drawcad.lang', 'ro')")
        page.goto(url)
        page.set_input_files("#fileInput", str(sample))
        page.wait_for_function("document.getElementById('docName').textContent.includes('arbore')")
        page.wait_for_timeout(800)
        # first document: three tips, one after the other, then never again
        for n in range(3):
            page.wait_for_selector(".tipbub")
            assert page.inner_text(".tipbub .tipn").strip() == f"{n + 1} / 3"
            page.click(".tipbub [data-tip=ok]")
        assert page.query_selector(".tipbub") is None
        assert page.evaluate("localStorage.getItem('drawcad.tips')") == "1"

        def scr(mmx, mmy):
            return page.evaluate(
                "([x,y]) => { const v = window.cotare.view; const r = document.getElementById('canvas').getBoundingClientRect();"
                " const s = v.toScreen([x,y]); return [s[0]+r.left, s[1]+r.top]; }",
                [mmx * MM, mmy * MM],
            )

        def pick(tid):
            # the tool rail (UI-D1): a right click on the family's slot opens its flyout, then the row
            fam = page.evaluate(f"window.cotare.familyOf('{tid}')")
            page.click(f'[data-fam="{fam}"]', button="right")
            page.click(f'#railFly [data-tool="{tid}"]')

        def click(mmx, mmy):
            x, y = scr(mmx, mmy)
            page.mouse.move(x, y)
            page.mouse.click(x, y)
            page.wait_for_timeout(60)

        # zoom on the shaft area, so snapping is precise
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -25*72/25.4*2.2; v.panY = -38*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(500)

        # 1. Ø25 dimension with k6
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

        # 2. linear dimension 40 below the Ø30 step
        page.keyboard.press("d")
        click(140, 110)
        click(180, 110)
        click(160, 127)

        # 3. GD&T coaxiality towards the Ø25 dimension line
        page.keyboard.press("g")
        click(75, 107.5)
        click(36, 122)

        # 4. datum A on Ø40
        page.keyboard.press("b")
        click(115, 115)
        click(115, 127)

        # 5. revision: 118 → 120
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

        # 6. chamfer
        page.keyboard.press("Escape")
        page.keyboard.press("c")
        click(60.5, 83)
        click(48, 72)

        # 7. 30° angular dimension
        page.keyboard.press("Escape")
        page.keyboard.press("u")
        click(30, 150)
        click(70, 150)
        click(64.641, 130)
        click(54.15, 143.53)
        ang = page.evaluate("(() => { const a = window.cotare.selected(); return window.cotare.builtOf(a).measured; })()")
        assert abs(ang - 30) < 0.01, ang

        # 8. roughness Ra 1.6 on the top surface of the Ø40 step, directly on the outline
        page.keyboard.press("Escape")
        page.keyboard.press("q")
        click(125, 75)
        click(125, 75)
        page.click("[data-act=rval][data-v='Ra 1,6']")
        # Size is a secondary section (UI-D13): open it, then pick from the list
        page.locator(".sec.col > .h", has_text="Mărime").click()
        page.select_option("#scaleSel", "0.7")
        assert page.evaluate("window.cotare.selected().scale") == 0.7
        # 9. copy + paste: a second roughness on the Ø30 step
        page.keyboard.press("v")  # the newly created roughness stays selected
        page.keyboard.press("Control+c")
        x, y = scr(160, 80)
        page.mouse.move(x, y)
        page.keyboard.press("Control+v")
        page.wait_for_timeout(100)
        n_rough = page.evaluate("window.cotare.annots.filter(a => a.type === 'rough').length")
        assert n_rough == 2, n_rough
        # 10. intersection snap: the axis with the edge at x = 90
        snap = page.evaluate("(() => { const s = window.cotare.snapper.snap([90*72/25.4 + 0.6, 95*72/25.4 + 0.6], { tol: 3, modes: new Set(['e','m','c','q','x','n']) }); return s && [s.kind, s.p]; })()")
        assert snap and snap[0] == "x" and abs(snap[1][0] - 90 * MM) < 0.05, snap
        # 10b. apparent intersection: the theoretical corner of the plate chamfer (170, 185)
        snap = page.evaluate("(() => { const s = window.cotare.snapper.snap([169.6*72/25.4, 184.6*72/25.4], { tol: 3, modes: new Set(['e','x','ax']) }); return s && [s.kind, s.p]; })()")
        assert snap and snap[0] == "ax" and abs(snap[1][0] - 170 * MM) < 0.05 and abs(snap[1][1] - 185 * MM) < 0.05, snap

        # 11. technical notes
        page.keyboard.press("Escape")
        page.keyboard.press("n")
        click(95, 135)
        page.fill("#nTxt", "Muchiile nespecificate se teșesc 0,5×45°\nToleranțe generale ISO 2768-mK")
        page.click("[data-act=ntpl][data-v='Călire + revenire 48–52 HRC']")
        page.press("#nTxt", "Escape")

        # 12. revision table above the title block, filled in from the struck dimension
        page.keyboard.press("f")
        page.wait_for_timeout(300)
        page.keyboard.press("e")
        click(287, 170)
        rows = page.evaluate("window.cotare.selected().rows")
        assert rows and rows[0]["rev"] == "1" and "120" in rows[0]["desc"], rows
        page.fill("[data-row='0'][data-col='name']", "OV")
        page.press("[data-row='0'][data-col='name']", "Escape")
        # shrink by dragging the corner handle towards the anchor (the title block corner); handles are
        # grabbed in Select only (inside a tool the next click starts a new object)
        page.evaluate("window.cotare.setTool('select')")
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
        # two-line text
        page.keyboard.press("t")
        click(25, 112)
        page.fill("#tTxt", "Text pe\ndouă rânduri")
        page.press("#tTxt", "Escape")
        n_lines = page.evaluate("window.cotare.builtOf(window.cotare.selected()).prims.filter(p => p.t === 'T').length")
        assert n_lines == 2, n_lines
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -25*72/25.4*2.2; v.panY = -38*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)

        # multiple selection: Ctrl+A, then a rectangle over the angle detail and a nudge with the arrow key
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

        # 13. real removal: the Ø30 text and its dimension line
        page.keyboard.press("x")
        x0, y0 = scr(160, 77)
        x1, y1 = scr(167.5, 113)
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=4)
        page.mouse.up()
        page.wait_for_selector("#rOk")
        page.wait_for_timeout(600)
        assert page.evaluate("document.querySelector('[data-mode].on').dataset.mode") == "cover"
        page.click("[data-mode=objects]")  # real removal of the checked objects (≥ 90% in the zone)
        page.wait_for_timeout(700)
        page.screenshot(path=str(out / "dialog_stergere.png"))
        page.click("#rOk")
        page.wait_for_timeout(200)

        # 14. drawing: a dashed line and the center lines of the side-view circle
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(300)
        page.keyboard.press("i")
        page.click('[data-st="preset"][data-v="hid"]')
        click(40, 172)
        click(80, 172)
        page.keyboard.press("Escape")
        pick("cross")
        click(240, 95)
        click(260, 95)
        page.keyboard.press("Escape")
        shapes = page.evaluate("window.cotare.annots.filter(a => a.type === 'shape').map(a => a.kind + ':' + a.ltype)")
        assert shapes == ["line:dash", "cross:chain"], shapes

        # 15. ordinate dimensions from the center of the Ø10 hole, a corrected value, then the hole table
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -125*72/25.4*2.2; v.panY = -80*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)
        pick("dimOrd")
        click(145, 167.5)
        click(240, 95)
        page.keyboard.press("Enter")
        click(190, 182)  # below the points: values on X
        pick("dimOrd")
        click(145, 167.5)
        click(240, 95)
        page.keyboard.press("Enter")
        click(132, 130)  # left of the points: values on Y
        ords = page.evaluate("window.cotare.annots.filter(a => a.type === 'ord').map(a => [a.axis, window.cotare.builtOf(a).values])")
        assert [o[0] for o in ords] == ["x", "y"] and sorted(ords[0][1]) == [0, 95] and sorted(ords[1][1]) == [0, 72.5], ords
        # the X value typed over the measured one (as on a scan, where it is never round)
        page.keyboard.press("Escape")
        page.evaluate("window.cotare.select(window.cotare.annots.find(a => a.type === 'ord' && a.axis === 'x').id)")
        page.wait_for_selector("[data-ord='1']")
        page.fill("[data-ord='1']", "95,05")
        page.press("[data-ord='1']", "Tab")
        assert page.evaluate("window.cotare.builtOf(window.cotare.annots.find(a => a.type === 'ord')).values") == [0, 95.05]
        page.keyboard.press("Escape")
        pick("holes")
        click(290, 110)
        rows = page.evaluate("window.cotare.selected().rows")
        assert [(r["tag"], r["x"], r["y"], r["d"]) for r in rows] == [("A1", "0", "0", "10"), ("B1", "95,05", "72,5", "30")], rows
        page.fill("[data-row='1'][data-col='d']", "M30")
        page.press("[data-row='1'][data-col='d']", "Escape")
        page.click("[data-act=hlsync]")
        assert page.evaluate("window.cotare.selected().rows[1].d") == "M30"
        page.screenshot(path=str(out / "tabel_gauri.png"))
        # 16. chain and baseline dimensions over the same centers (+ the quadrant of the Ø40 circle)
        page.keyboard.press("Escape")
        pick("dimCont")
        for q in [(240, 95), (145, 167.5), (260, 95)]:
            click(*q)
        page.keyboard.press("Enter")
        click(200, 192)
        pick("dimBase")
        for q in [(145, 167.5), (260, 95), (240, 95)]:
            click(*q)
        page.keyboard.press("Enter")
        click(200, 86)
        dims = page.evaluate("""window.cotare.annots.filter(a => a.type === 'dim').slice(-4)
            .map(a => [Math.round(window.cotare.builtOf(a).measured * 100) / 100, Math.round(a.p3[1] / (72/25.4))])""")
        assert sorted(dims) == [[20, 192], [95, 86], [95, 192], [115, 78]], dims
        page.screenshot(path=str(out / "cote_lant_baza.png"))
        # 17. typed points (as at AutoCAD's prompt): a line from 20,30 (bottom-left origin, Y up),
        # then @40,0 and @20<90; then an origin (UCS) on the Ø10 hole and a line from 0,0 there
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.keyboard.press("i")
        for txt in ["20,30", "@40,0", "@20<90"]:
            page.keyboard.type(txt)
            page.keyboard.press("Enter")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        lines = page.evaluate("""window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-2)
            .map(a => a.pts.map(p => [Math.round(p[0] / (72/25.4) * 100) / 100, Math.round(p[1] / (72/25.4) * 100) / 100]))""")
        h = page.evaluate("window.cotare.doc.pages[0].h / (72/25.4)")
        assert lines == [[[20, round(h - 30, 2)], [60, round(h - 30, 2)]], [[60, round(h - 30, 2)], [60, round(h - 50, 2)]]], (lines, h)
        pick("ucs")
        click(145, 167.5)
        page.keyboard.press("Escape")
        page.keyboard.press("i")
        for txt in ["0,0", "@0,-10"]:
            page.keyboard.type(txt)
            page.keyboard.press("Enter")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        last = page.evaluate("window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-1)[0].pts.map(p => p.map(v => Math.round(v / (72/25.4) * 100) / 100))")
        assert last == [[145, 167.5], [145, 177.5]], last
        # 18. prompts and options (direct keys: an option letter of the prompt goes to the command
        # line): DLI forced vertical with a typed value, a line chain with Undo and Close, a circle
        # by its diameter, then the F2 history
        def typed(*items):
            for txt in items:
                page.keyboard.type(txt)
                page.keyboard.press("Enter")
        pick("ucs")
        typed("w")  # World: back to the page corner
        page.keyboard.press("d")
        typed("20,40", "@30,20", "v", "t", "25", "@-15,0")
        dim = page.evaluate("(() => { const a = window.cotare.annots.filter(a => a.type === 'dim').slice(-1)[0]; return [a.orient, a.nominal, Math.round(window.cotare.builtOf(a).measured * 100) / 100]; })()")
        assert dim == ["v", 25, 20], dim
        page.keyboard.press("Escape")
        page.keyboard.press("i")
        typed("100,100", "@20,0", "@0,20", "u", "@0,30", "c")
        chain = page.evaluate("""window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-3)
            .map(a => a.pts.map(p => [Math.round(p[0] / (72/25.4) * 10) / 10, Math.round(((window.cotare.doc.pages[0].h - p[1]) / (72/25.4)) * 10) / 10]))""")
        assert chain == [[[100, 100], [120, 100]], [[120, 100], [120, 130]], [[120, 130], [100, 100]]], chain
        page.keyboard.press("Escape")
        page.keyboard.press("y")
        typed("150,100", "d", "16")
        r = page.evaluate("(() => { const a = window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'circle').slice(-1)[0]; return Math.round(Math.hypot(a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]) / (72/25.4) * 100) / 100; })()")
        assert r == 8, r
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.keyboard.press("F2")
        page.wait_for_selector("#hLog")
        hist = page.inner_text("#hLog")
        assert "@0,30" in hist and "[C]" in hist and "Diametrul" in hist, hist
        page.screenshot(path=str(out / "istoric_f2.png"))
        page.keyboard.press("F2")
        # 18b. TRIM, EXTEND (and Shift in TRIM), OFFSET with a typed distance, on drawn lines (CMD-D17)
        H = page.evaluate("window.cotare.doc.pages[0].h") / MM

        def cl_up(x, y, shift=False):  # mm from the bottom-left corner, as typed points
            if shift:
                page.keyboard.down("Shift")
            click(x, H - y)
            if shift:
                page.keyboard.up("Shift")

        def last_lines(n):
            return page.evaluate(f"""window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-{n})
                .map(a => a.pts.map(p => [Math.round(p[0] / (72/25.4) * 10) / 10, Math.round(((window.cotare.doc.pages[0].h - p[1]) / (72/25.4)) * 10) / 10]))""")

        for pts in (("100,80", "@40,0"), ("130,70", "@0,20"), ("110,85", "@10,0")):
            page.keyboard.press("i")
            typed(*pts)
            page.keyboard.press("Escape")
            page.keyboard.press("Escape")
        page.evaluate(f"() => {{ const h = window.cotare.doc.pages[0].h; window.cotare.view.zoomToBox([90*{MM}, h - 100*{MM}, 145*{MM}, h - 60*{MM}]); }}")
        page.wait_for_timeout(300)
        page.click("#cmdIn")
        typed("TR")
        cl_up(135, 80)
        assert last_lines(3)[0] == [[100, 80], [130, 80]], last_lines(3)
        cl_up(119, 85, shift=True)  # Shift: extend instead
        assert last_lines(3)[2] == [[110, 85], [130, 85]], last_lines(3)
        page.keyboard.press("Enter")
        assert page.evaluate("window.cotare.tool") == "select"
        page.click("#cmdIn")
        typed("O", "5")
        cl_up(110, 80)
        cl_up(110, 70)
        page.keyboard.press("Enter")
        assert last_lines(4)[1] == [[100, 75], [130, 75]], last_lines(4)  # the copy goes right after its source
        # EXTEND along a fence: a click beside the objects, a click across two short lines
        for pts in (("105,76.5", "@10,0"), ("105,78.5", "@10,0")):
            page.keyboard.press("i")
            typed(*pts)
            page.keyboard.press("Escape")
            page.keyboard.press("Escape")
        page.click("#cmdIn")
        typed("EX")
        cl_up(113, 79.3)
        cl_up(113, 75.8)
        assert last_lines(2) == [[[105, 76.5], [130, 76.5]], [[105, 78.5], [130, 78.5]]], last_lines(2)
        page.keyboard.press("Escape")
        # one undo step for the whole fence, then the two lines go (the later steps work on the last lines)
        page.keyboard.press("Control+z")
        assert last_lines(2) == [[[105, 76.5], [115, 76.5]], [[105, 78.5], [115, 78.5]]], last_lines(2)
        page.keyboard.press("Control+z")
        page.keyboard.press("Control+z")
        assert last_lines(1) == [[[110, 85], [130, 85]]], last_lines(1)
        page.screenshot(path=str(out / "taie_prelungeste.png"))
        # 19. typed snap override: CEN, then a click on the edge of the Ø10 hole takes its center
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -125*72/25.4*2.2; v.panY = -80*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)
        page.keyboard.press("i")
        # direct keys mode: letters are tools, so the override goes through the command line
        page.click("#cmdIn")
        typed("cen")
        click(149.6, 169.5)
        typed("@10,0")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        cen = page.evaluate("window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-1)[0].pts[0].map(v => Math.round(v / (72/25.4) * 100) / 100)")
        assert cen == [145, 167.5], cen
        # 20. acad.pgp import in the Keys dialog, then a transparent 'Z during a command
        pgp = out / "test.pgp"
        pgp.write_text("; test\nLI, *LINE\nLA, *LAYER\n", encoding="utf-8")
        page.evaluate("window.cotare.runCommand('keys')")
        page.wait_for_selector("#kImport")
        page.set_input_files("#kPgp", str(pgp))
        page.wait_for_selector("#kImp:not([hidden])")
        imp = page.inner_text("#kImp")
        assert "1 adăugate" in imp and "LAYER" in page.inner_html("#kImp"), imp
        page.click("#kSave")
        page.wait_for_timeout(200)
        page.click("#cmdIn")
        typed("LI")
        assert page.evaluate("window.cotare.tool") == "line"
        typed("10,10")
        page.click("#cmdIn")
        typed("'Z")
        assert page.evaluate("[window.cotare.tool, window.cotare.clicks.length]") == ["line", 1], "'Z keeps the command"
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        # 21. ERASE asks for objects (L = the last one), MOVE and COPY with a base point
        n0 = page.evaluate("window.cotare.annots.length")
        last_id = page.evaluate("window.cotare.annots[window.cotare.annots.length - 1].id")
        page.click("#cmdIn")
        typed("E")
        assert page.evaluate("!!window.cotare.selPrompt")
        page.click("#cmdIn")
        typed("L")
        page.click("#cmdIn")
        page.keyboard.press("Enter")
        assert page.evaluate("window.cotare.annots.length") == n0 - 1
        assert not page.evaluate(f"window.cotare.annots.some(a => a.id === '{last_id}')")
        ln = page.evaluate("window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-1)[0]")
        page.evaluate(f"window.cotare.select('{ln['id']}')")
        page.click("#cmdIn")
        typed("M", "0,0", "@10,0")
        moved = page.evaluate(f"window.cotare.annots.find(a => a.id === '{ln['id']}').pts[0][0] - {ln['pts'][0][0]}")
        assert abs(moved - 10 * 72 / 25.4) < 1e-6, moved
        page.click("#cmdIn")
        typed("CO", "0,0", "@0,10", "@0,20")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        assert page.evaluate("window.cotare.annots.length") == n0 + 1
        # 22. FROM and M2P while picking; DCO continuing an existing linear dimension (option S)
        uy = lambda v: page.evaluate(f"window.cotare.doc.pages[0].h / (72/25.4) - ({v})")
        lastln = "window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-1)[0].pts.map(p => [Math.round(p[0] / (72/25.4) * 100) / 100, Math.round((window.cotare.doc.pages[0].h - p[1]) / (72/25.4) * 100) / 100])"
        page.keyboard.press("i")
        page.click("#cmdIn")
        typed("FROM", "100,50", "@10,0", "@0,10")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        assert page.evaluate(lastln) == [[110, 50], [110, 60]], page.evaluate(lastln)
        page.keyboard.press("i")
        page.click("#cmdIn")
        typed("M2P", "0,0", "20,0", "@0,5")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        assert page.evaluate(lastln) == [[10, 0], [10, 5]], page.evaluate(lastln)
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -10*72/25.4*2.2; v.panY = -40*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)
        page.click("#cmdIn")
        typed("DLI", "20,150", "@30,0", "@0,-10")
        page.keyboard.press("Escape")
        page.click("#cmdIn")
        typed("DCO", "S")
        click(35, uy(140))
        page.click("#cmdIn")
        typed("@20,0")
        page.click("#cmdIn")
        page.keyboard.press("Enter")
        dco = page.evaluate("(() => { const a = window.cotare.annots.filter(a => a.type === 'dim').slice(-1)[0]; return [Math.round(window.cotare.builtOf(a).measured * 100) / 100, a.orient, Math.round((window.cotare.doc.pages[0].h - a.p3[1]) / (72/25.4) * 100) / 100, Math.round(a.p1[0] / (72/25.4) * 100) / 100]; })()")
        assert dco == [20, "h", 140, 50], dco
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        # 23. Select objects with F (fence): the line crossed by it is erased; DIST Multiple
        n1 = page.evaluate("window.cotare.annots.length")
        page.evaluate("window.cotare.select(null)")
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = 0; v.panY = -100*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)
        page.click("#cmdIn")
        typed("E", "F")
        click(5, uy(2))  # across the M2P line (10,0)-(10,5)
        click(15, uy(2))
        page.click("#cmdIn")
        page.keyboard.press("Enter")  # ends the fence
        assert page.evaluate("window.cotare.sel.size") == 1, page.evaluate("[...window.cotare.sel].map(id => window.cotare.annots.find(x => x.id === id).type)")
        page.click("#cmdIn")
        page.keyboard.press("Enter")  # erases
        assert page.evaluate("window.cotare.annots.length") == n1 - 1
        page.click("#cmdIn")
        typed("DI", "M", "0,0", "@30,0", "@0,40")
        tot = page.evaluate("Math.round(window.cotare.cmdState.total * 100) / 100")
        assert tot == 70, tot
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        # 24. dynamic prompt: ↓ opens the options next to the cursor, Enter picks one
        page.evaluate("window.cotare.select(null)")
        page.click("#cmdIn")
        typed("DLI", "30,100", "@20,0")
        sx, sy = scr(60, uy(90))
        page.mouse.move(sx, sy)
        page.wait_for_selector("#dynBox .dp")
        for key in ["ArrowDown", "ArrowDown", "ArrowDown", "Enter"]:
            page.keyboard.press(key)
        assert page.evaluate("window.cotare.cmdState.orient") == "v", page.evaluate("window.cotare.cmdState")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        # 25. point filter .X: X from one point, Y from the next
        page.keyboard.press("i")
        page.click("#cmdIn")
        typed(".X", "30,40", "70,80", "@5,0")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        assert page.evaluate(lastln) == [[30, 80], [35, 80]], page.evaluate(lastln)
        page.keyboard.press("Escape")
        # 26. hot grips: click on a grip, Space → MOVE, a typed point; Enter twice → ROTATE, 90
        page.keyboard.press("v")
        page.evaluate(f"() => {{ const v = window.cotare.view; v.zoom = 2.2; v.panX = 0; v.panY = -({uy(80)} - 40)*72/25.4*2.2; v.afterZoom(); }}")
        page.wait_for_timeout(300)
        lnid = "window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-1)[0].id"
        page.evaluate(f"window.cotare.select({lnid})")
        click(35, uy(80))
        assert page.evaluate("window.cotare.hotGrip && window.cotare.hotGrip.mode") == "stretch"
        page.keyboard.press(" ")
        assert page.evaluate("window.cotare.hotGrip.mode") == "move"
        page.click("#cmdIn")
        typed("@0,-10")
        assert page.evaluate("window.cotare.hotGrip") is None
        assert page.evaluate(lastln) == [[30, 70], [35, 70]], page.evaluate(lastln)
        page.evaluate(f"window.cotare.select({lnid})")
        click(35, uy(70))
        page.click("#cmdIn")
        typed("", "")  # STRETCH → MOVE → ROTATE
        assert page.evaluate("window.cotare.hotGrip.mode") == "rotate"
        typed("90")
        assert page.evaluate(lastln) == [[35, 65], [35, 70]], page.evaluate(lastln)
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        # 27. grips on two selected lines: Shift+click makes both grips hot, a click on one stretches both
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 1.2; v.panX = 0; v.panY = 0; v.afterZoom(); }")
        page.wait_for_timeout(300)
        lines = "window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line')"
        ptsof = "(a => a.pts.map(p => [Math.round(p[0] / (72/25.4) * 100) / 100, Math.round((window.cotare.doc.pages[0].h - p[1]) / (72/25.4) * 100) / 100]))"
        two = f"(() => {{ const ls = {lines}; return [ls.find(a => Math.round(a.pts[0][0] / (72/25.4)) === 110), ls[ls.length - 1]]; }})()"
        page.evaluate(f"window.cotare.selectMany({two}.map(a => a.id))")
        page.keyboard.down("Shift")
        click(110, uy(60))
        click(35, uy(70))
        page.keyboard.up("Shift")
        assert page.evaluate("window.cotare.hotSet && window.cotare.hotSet.size") == 2
        click(35, uy(70))
        assert page.evaluate("window.cotare.hotGrip.grips.length") == 2
        page.click("#cmdIn")
        typed("@5,0")
        got = page.evaluate(f"{two}.map({ptsof})")
        assert got == [[[110, 50], [115, 60]], [[35, 65], [40, 70]]], got
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        # 28. selection cycling: a line drawn on top of another; Tab over them, the click takes the one below
        page.evaluate("window.cotare.select(null)")
        old_id = page.evaluate(f"{lines}.slice(-1)[0].id")
        page.keyboard.press("i")
        page.click("#cmdIn")
        typed("35,65", "40,70")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        new_id = page.evaluate(f"{lines}.slice(-1)[0].id")
        assert new_id != old_id
        page.keyboard.press("v")
        page.evaluate("document.activeElement && document.activeElement.blur()")
        mx, my = scr(37.5, uy(67.5))
        page.mouse.move(mx, my)
        page.mouse.move(mx + 1, my)
        assert page.evaluate("window.cotare.hover && window.cotare.hover.a.id") == new_id
        page.keyboard.press("Tab")
        assert page.evaluate("window.cotare.hover.a.id") == old_id
        page.mouse.click(mx + 1, my)
        assert page.evaluate("[...window.cotare.sel]") == [old_id], page.evaluate("[...window.cotare.sel]")
        page.evaluate(f"window.cotare.select('{new_id}')")
        page.click("#cmdIn")
        typed("E")
        assert page.evaluate(f"window.cotare.annots.some(a => a.id === '{new_id}')") is False
        page.keyboard.press("Escape")
        # 30. dynamic input on a hot grip: the cursor gives the direction, 5 typed at the cursor the length
        page.evaluate(f"window.cotare.select({lines}.slice(-1)[0].id)")
        click(40, uy(70))
        assert page.evaluate("window.cotare.hotGrip && window.cotare.hotGrip.mode") == "stretch"
        page.mouse.move(*scr(55, uy(70.4)))
        page.mouse.move(*scr(60, uy(70.2)))
        page.keyboard.type("5")
        assert page.evaluate("window.cotare.dynTool()") is True
        page.keyboard.press("Tab")  # to the angle field
        page.keyboard.type("0")
        page.keyboard.press("Enter")
        assert page.evaluate("window.cotare.hotGrip") is None
        assert page.evaluate(lastln) == [[35, 65], [45, 70]], page.evaluate(lastln)
        page.keyboard.press("Escape")
        # 31. grip menu: resting on a polyline vertex opens it; Add vertex places a new one, Remove vertex deletes it
        page.click("#cmdIn")
        typed("PL", "20,150", "@20,0", "@0,10", "")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        plq = "window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'poly').slice(-1)[0]"
        plpts = f"(a => a.pts.map(p => [Math.round(p[0] / (72/25.4) * 100) / 100, Math.round((window.cotare.doc.pages[0].h - p[1]) / (72/25.4) * 100) / 100]))({plq})"
        assert page.evaluate(plpts) == [[20, 150], [40, 150], [40, 160]], page.evaluate(plpts)
        page.keyboard.press("v")
        page.evaluate(f"() => {{ const v = window.cotare.view; v.zoom = 2.2; v.panX = 0; v.panY = -({uy(160)} - 30)*72/25.4*2.2; v.afterZoom(); }}")
        page.wait_for_timeout(300)
        page.evaluate(f"window.cotare.select({plq}.id)")
        gx, gy = scr(40, uy(150))
        page.mouse.move(gx + 2, gy)
        page.mouse.move(gx, gy)
        page.wait_for_selector("#gripMenu:not([hidden]) [data-gm=addVertex]", timeout=3000)
        page.click("#gripMenu [data-gm=addVertex]")
        assert page.evaluate("window.cotare.hotGrip && window.cotare.hotGrip.k") == "pts.2"
        page.click("#cmdIn")
        typed("@5,0")
        assert page.evaluate(plpts) == [[20, 150], [40, 150], [45, 155], [40, 160]], page.evaluate(plpts)
        gx, gy = scr(45, uy(155))
        page.mouse.move(gx + 2, gy)
        page.mouse.move(gx, gy)
        page.wait_for_selector("#gripMenu:not([hidden]) [data-gm=removeVertex]", timeout=3000)
        page.click("#gripMenu [data-gm=removeVertex]")
        assert page.evaluate(plpts) == [[20, 150], [40, 150], [40, 160]], page.evaluate(plpts)
        page.click("#cmdIn")
        typed("E")
        assert page.evaluate("window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'poly').length") == 0
        page.keyboard.press("Escape")
        # 29. TK tracking: two tracking points (the second only vertical), Enter, then the line from there
        page.keyboard.press("i")
        page.click("#cmdIn")
        typed("TK", "50,100", "@20,0", "@3,15", "", "@10,0")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        assert page.evaluate(lastln) == [[70, 115], [80, 115]], page.evaluate(lastln)
        page.evaluate(f"window.cotare.select({lines}.slice(-1)[0].id)")
        page.click("#cmdIn")
        typed("E")
        page.keyboard.press("Escape")
        # 32. context bar (UI-D10): a linear dimension selected offers "Chain from here", which starts DCO from it
        page.keyboard.press("v")
        page.evaluate("window.cotare.select(window.cotare.annots.find(a => a.type === 'dim' && a.kind === 'lin').id)")
        page.click('#ctxTool [data-ctx="dco"]')
        assert page.evaluate("[window.cotare.tool, window.cotare.clicks.length]") == ["dimCont", 1], page.evaluate("[window.cotare.tool, window.cotare.clicks.length]")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(300)

        # select the Ø25 dimension for the screenshot
        page.keyboard.press("v")
        click(75, 90)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / "editor.png"))

        kinds = page.evaluate("window.cotare.annots.map(a => a.type)")
        assert len(kinds) == 40, kinds

        # an image (a logo): the tool asks for the file, a drag places it with its proportions
        from PIL import Image as _Image
        _Image.new("RGB", (300, 100), (30, 80, 160)).save(out / "logo.png")
        with page.expect_file_chooser() as fc:
            page.evaluate("window.cotare.setTool('image')")
        fc.value.set_files(str(out / "logo.png"))
        page.wait_for_function("!!window.cotare.pendingImage", timeout=20000)
        x0, y0 = scr(200, 15)
        x1, y1 = scr(230, 20)
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=4)
        page.mouse.up()
        page.wait_for_function("window.cotare.annots.length === 41 && window.cotare.selected().type === 'image'")
        r = page.evaluate("window.cotare.selected().r")
        assert abs((r[2] - r[0]) / (r[3] - r[1]) - 3) < 0.05, r  # 300 × 100 px → 3:1

        # a title block from the library (ISO 7200, made by the generator), placed by its corner
        page.evaluate("window.cotare.setTool('tblock')")
        page.wait_for_selector("#tbNew")
        page.click("#tbNew")
        page.wait_for_selector("#tgMake")
        page.click("#tgMake")
        page.wait_for_selector("[data-tbput='0']")
        page.click("[data-tbput='0']")
        click(270, 200)
        page.wait_for_function("window.cotare.annots.length === 42 && window.cotare.selected() && window.cotare.selected().type === 'tblock'")
        page.fill("#tbf_titlu", "Arbore")
        page.press("#tbf_titlu", "Escape")
        txt = page.evaluate("window.cotare.builtOf(window.cotare.annots.find(a => a.type === 'tblock')).prims.filter(p => p.t === 'T').map(p => p.txt)")
        assert "Arbore" in txt and "1:1" in txt, txt

        # markup: a revision cloud around the struck 118 and a review comment (a PDF note on export)
        page.evaluate("window.cotare.setTool('cloud')")
        x0, y0 = scr(112, 41)
        x1, y1 = scr(128, 52)
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x1, y1, steps=4)
        page.mouse.up()
        page.wait_for_function("window.cotare.annots.length === 43 && window.cotare.selected().type === 'cloud'")
        page.evaluate("window.cotare.setTool('comment')")
        click(150, 40)
        page.wait_for_selector("#cTxt")
        page.fill("#cTxt", "De verificat cu clientul")
        page.press("#cTxt", "Escape")
        page.wait_for_function("window.cotare.annots.length === 44")
        page.evaluate("window.cotare.setTool('select')")

        # a stamp from the list and a QR code with the drawing number from the title block
        page.evaluate("window.cotare.setTool('stamp')")
        page.wait_for_selector("[data-st]")
        page.click("[data-st='VERIFICAT']")
        click(150, 60)
        page.wait_for_function("window.cotare.annots.length === 45 && window.cotare.tool === 'select'")
        page.evaluate("window.cotare.setTool('qr')")
        click(240, 150)
        page.wait_for_function("window.cotare.annots.length === 46 && window.cotare.selected().type === 'qr'")
        page.fill("#qNr", "ARB-01")
        page.press("#qNr", "Enter")
        assert "ARB-01" in page.inner_text(".qrtext"), page.inner_text(".qrtext")

        # export
        page.click("#btnExport")
        page.wait_for_selector("#eGo")
        with page.expect_download() as dl:
            page.click("#eGo")
        path = out / "export.pdf"
        dl.value.save_as(str(path))
        page.wait_for_timeout(300)

        # DXF export of the current page: dimensions land on their layer
        page.click("#btnExport")
        page.wait_for_selector("#eGo")
        page.click("[data-fmt=dxf]")
        if page.query_selector("[data-pg=cur]"):
            page.click("[data-pg=cur]")
        with page.expect_download() as dl:
            page.click("#eGo")
        # the logo placed on this page goes next to the DXF: a ZIP with the DXF and the image
        zip_path = out / "export_dxf.zip"
        dl.value.save_as(str(zip_path))
        assert dl.value.suggested_filename.endswith(".zip"), dl.value.suggested_filename
        import zipfile
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            assert sorted(n.rsplit(".", 1)[1] for n in names) == ["dxf", "png"], names
            dxf = z.read([n for n in names if n.endswith(".dxf")][0]).decode("utf-8")
        assert "DRAWCAD-IMAGINI" in dxf and "DRAWCAD-STAMPILE" in dxf
        (out / "export.dxf").write_text(dxf, "utf-8")
        assert dxf.startswith("  0\nSECTION") and "DRAWCAD-COTE" in dxf and "PDF-GEOMETRIE" in dxf
        page.wait_for_timeout(300)

        # text search (Ctrl+F) on the PDF texts
        page.keyboard.press("Control+f")
        page.wait_for_selector("#tQ")
        page.fill("#tQ", "42crmo")
        page.wait_for_selector("#tList [data-i]")
        page.click("#tList [data-i]")
        page.wait_for_function("window.cotare.hit !== null")
        # OCR on the current page, if the server has Tesseract (in the Docker image: yes)
        if page.evaluate("!!window.cotare.ocrLang"):
            page.click("#tRun")
            page.wait_for_function("document.querySelector('#tStat').textContent.includes('recunoscute')", timeout=120000)
            got = page.evaluate("(window.cotare.ocr.get(window.cotare.page) || {lines: []}).lines.map(l => l.text)")
            assert any("42CrMo4" in t for t in got), got
        page.keyboard.press("Escape")

        # reopen: dimensions come back editable
        prev_id = page.evaluate("window.cotare.doc.id")
        page.set_input_files("#fileInput", str(path))
        # wait for the new document (loading takes time), not the old one which already had 40 annotations
        page.wait_for_function(f"window.cotare.doc && window.cotare.doc.id !== '{prev_id}' && window.cotare.doc.fromExport && window.cotare.annots.length === 46")
        # the export knows its revision; opening it does not change the number yet
        rev0 = page.evaluate("[window.cotare.settings.revNo, window.cotare.settings.exportedRev]")
        assert rev0[0] == rev0[1], rev0
        # revision compare with the document it came from: the same drawing, no changed areas
        page.click("#ptabs [data-ptab='layers']")
        page.click("[data-act='compare']")
        page.wait_for_selector("#cmpGo:not([disabled])")
        page.click("#cmpGo")
        page.wait_for_function("!!window.cotare.compare", timeout=60000)
        assert page.evaluate("window.cotare.compare.regions.length") == 0, page.evaluate("JSON.stringify(window.cotare.compare.regions)")
        assert "Compar" in page.inner_text("#ctxTool")
        # the other views: side by side, then the curtain, whose line follows the slider
        page.click("[data-cmpmode=side]")
        assert page.evaluate("window.cotare.compare.mode") == "side"
        page.click("[data-cmpmode=swipe]")
        page.wait_for_selector("#cmpSplit")
        page.eval_on_selector("#cmpSplit", "el => { el.value = '25'; el.dispatchEvent(new Event('input')); }")
        assert abs(page.evaluate("window.cotare.compare.split") - 0.25) < 1e-9
        page.click("[data-cmp='close']")
        page.click("#ptabs [data-ptab='props']")
        # a DXF (V14): opened as a drawing, on an ISO sheet at its scale; the 1:2 layout sets the scale
        dxf = out / "placa.dxf"
        _make_dxf(dxf)
        export_id = prev_id = page.evaluate("window.cotare.doc.id")
        page.set_input_files("#fileInput", str(dxf))
        page.wait_for_function(f"window.cotare.doc && window.cotare.doc.id !== '{prev_id}' && window.cotare.doc.kind === 'dxf'")
        assert "DXF" in page.inner_text("#docMeta"), page.inner_text("#docMeta")
        assert page.evaluate("window.cotare.settings.scale") == 2, page.evaluate("window.cotare.settings.scale")
        # snap comes from the DXF geometry: the Ø30 hole at 1:2 is a 7.5 mm radius on the sheet
        page.wait_for_function("window.cotare.snapper.arcs.some((a) => Math.abs(a[2] - 7.5 * 72 / 25.4) < 0.2)")
        # the layouts are the page tabs, each with its own scale (the second one is 1:1)
        tabs = page.inner_text("#pageTabs")
        assert "Plansa" in tabs and "Detaliu" in tabs, tabs
        page.click("#pageTabs [data-pg='1']")
        page.wait_for_function("window.cotare.page === 1 && window.cotare.settings.scale === 1")
        page.click("#pageTabs [data-pg='0']")
        page.wait_for_function("window.cotare.page === 0 && window.cotare.settings.scale === 2")
        page.screenshot(path=str(out / "dxf_open.png"))
        # the drawing's layers: TEXT hidden, its text is no longer on the page, then shown again
        page.click("#ptabs [data-ptab='layers']")
        page.wait_for_selector("[data-act='dxflayer'][data-v='TEXT']")
        page.screenshot(path=str(out / "dxf_layers.png"))
        page.click("[data-act='dxflayer'][data-v='TEXT']")
        page.wait_for_function("(window.cotare.doc.dxf.hidden || []).includes('TEXT')")
        page.wait_for_selector(".layer.off [data-v='TEXT']")
        page.click("[data-act='dxfall']")
        page.wait_for_function("(window.cotare.doc.dxf.hidden || []).length === 0")
        # the drawing's own colors (plotted again on the server), then black again
        page.click("[data-act='dxfcolors'][data-v='1']")
        page.wait_for_function("window.cotare.doc.dxf.colors === true", timeout=60000)
        page.click("[data-act='dxfcolors'][data-v='0']")
        page.wait_for_function("window.cotare.doc.dxf.colors === false")
        page.click("#ptabs [data-ptab='props']")
        # a DWG, where LibreDWG is installed (Docker image, desktop app): converted, then like a DXF
        if page.evaluate("fetch('api/health').then((r) => r.json()).then((h) => !!h.dwg)"):
            prev_id = page.evaluate("window.cotare.doc.id")
            page.set_input_files("#fileInput", str(Path(__file__).resolve().parents[1] / "backend" / "tests" / "fixtures" / "piesa_r2000.dwg"))
            page.wait_for_function(f"window.cotare.doc && window.cotare.doc.id !== '{prev_id}' && window.cotare.doc.kind === 'dwg'")
            assert "DWG" in page.inner_text("#docMeta"), page.inner_text("#docMeta")
            page.wait_for_function("window.cotare.snapper.arcs.some((a) => Math.abs(a[2] - 25 * 72 / 25.4) < 0.2)")
            print("DWG: OK")
        else:
            print("DWG: LibreDWG not installed, skipped")
        # the documents opened one after another stayed open as tabs (UI-D4a): one click shows another
        # one again, × closes a tab; with the others closed, closing goes to the start page
        tabs = page.evaluate("window.cotare.tabs.map((t) => t.id)")
        assert len(tabs) >= 2, tabs
        cur = page.evaluate("window.cotare.doc.id")
        other = [t for t in tabs if t != cur][-1]

        def crowd():  # little room: the other tabs are behind the "N ▾" button
            return page.evaluate("document.getElementById('docTabs').classList.contains('crowd')")

        def show_tab(doc_id):
            if crowd():
                page.click("#docTabs .tabmore")
                page.click(f'#docTabs .tabmenu [data-tab="{doc_id}"]')
            else:
                page.click(f'#docTabs .doctab [data-tab="{doc_id}"]')
            page.wait_for_function(f"window.cotare.doc && window.cotare.doc.id === '{doc_id}'")

        show_tab(other)
        show_tab(cur)
        # a save that fails (server not answering) is not lost when another tab is shown: it is kept,
        # shown again with its document, and sent once the server answers
        show_tab(other)
        k_err = len(errors)
        page.route("**/api/doc/*/state", lambda r: r.abort() if r.request.method == "PUT" else r.continue_())
        n0 = page.evaluate("window.cotare.annots.length")
        page.keyboard.press("i")
        typed("20,20", "@30,0")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.wait_for_function("document.getElementById('saveState').textContent.includes('Nesalvat')", timeout=10000)
        show_tab(cur)
        show_tab(other)
        assert page.evaluate("window.cotare.annots.length") == n0 + 1
        show_tab(cur)
        page.unroute("**/api/doc/*/state")
        page.wait_for_function("!(window.cotare.unsaved && window.cotare.unsaved.size)", timeout=15000)
        errors[k_err:] = [e for e in errors[k_err:] if "ERR_FAILED" not in e]  # the saves refused on purpose
        saved = page.evaluate(f"fetch('api/doc/{other}').then(r => r.json()).then(j => j.state.annots.length)")
        assert saved == n0 + 1, (saved, n0)
        while page.evaluate("window.cotare.tabs.length") > 1:
            if crowd():
                page.click("#docTabs .tabmore")
                page.click("#docTabs .tabmenu [data-tabclose] >> nth=0")
            else:
                page.click("#docTabs .doctab [data-tabclose] >> nth=0")
        assert page.evaluate("window.cotare.tabs.length") == 1
        print("Tabs: OK")
        # closing without changes: straight to the start page
        page.click("#btnClose")
        page.wait_for_function("window.cotare.doc === null && !document.getElementById('emptyState').hidden")
        page.wait_for_function("document.querySelectorAll('#recentList [data-doc]').length >= 1", timeout=5000)
        # reopen the export from Recent (the DXF is the newest), one change, then close with the prompt
        page.click(f'#recentList [data-doc="{export_id}"]')
        page.wait_for_function("window.cotare.doc !== null && window.cotare.annots.length === 46")
        page.wait_for_timeout(300)
        # page operations are history steps: rotate, Ctrl+Z; delete a page, Ctrl+Z, Ctrl+Y, Ctrl+Z
        snap_a = page.evaluate("JSON.stringify(window.cotare.annots)")
        w0 = page.evaluate("window.cotare.doc.pages[0].w")
        lv = lambda: page.evaluate("window.cotare.doc.lv || 0")
        def page_step(js_or_key):
            v = lv()
            if js_or_key.startswith("Control"):
                page.keyboard.press(js_or_key)
            else:
                page.evaluate(js_or_key)
            page.wait_for_function(f"(window.cotare.doc.lv || 0) > {v} && !window.cotare._pageBusy", timeout=20000)
        page_step("window.cotare.runCommand('rotR')")
        assert abs(page.evaluate("window.cotare.doc.pages[0].w") - w0) > 1
        assert page.evaluate("JSON.stringify(window.cotare.annots)") != snap_a
        page_step("Control+z")
        assert abs(page.evaluate("window.cotare.doc.pages[0].w") - w0) < 0.01
        assert page.evaluate("JSON.stringify(window.cotare.annots)") == snap_a
        page_step("window.cotare.pageOp({ op: 'delete', pages: [1] })")
        assert page.evaluate("window.cotare.doc.pages.length") == 1
        page_step("Control+z")
        assert page.evaluate("window.cotare.doc.pages.length") == 2
        assert page.evaluate("JSON.stringify(window.cotare.annots)") == snap_a
        page_step("Control+y")
        assert page.evaluate("window.cotare.doc.pages.length") == 1
        page_step("Control+z")
        assert page.evaluate("window.cotare.doc.pages.length") == 2 and page.evaluate("window.cotare.annots.length") == 46
        # Ctrl+K: command search by name (Romanian, without diacritics), Enter runs it; ? opens the sheet
        page.keyboard.press("Control+k")
        page.wait_for_selector("#pkQ")
        page.fill("#pkQ", "raza")
        page.wait_for_selector(".pkrow.on")
        page.keyboard.press("Enter")
        page.wait_for_function("window.cotare.tool === 'dimRad' && !document.getElementById('pkQ')")
        page.keyboard.press("Escape")
        page.keyboard.press("Control+k")
        page.fill("#pkQ", "foaie")
        page.wait_for_selector(".pkrow.on")
        page.keyboard.press("Enter")
        page.wait_for_selector("#spane-sheet:not([hidden])")
        page.keyboard.press("Escape")
        page.wait_for_function("document.getElementById('modal').hidden")
        # rectangle: typed sizes are its length on X and width on Y (Tab), the cursor picks the side
        page.evaluate("window.cotare.setTool('rect')")
        page.mouse.click(*scr(150, 100))
        page.mouse.move(*scr(190, 160), steps=4)
        for k in ("5", "0", "Tab", "3", "0", "Enter"):
            page.keyboard.press(k)
        rect = page.evaluate("(() => { const a = window.cotare.annots[window.cotare.annots.length - 1]; return [a.kind, (a.pts[1][0] - a.pts[0][0]) / (72/25.4), (a.pts[1][1] - a.pts[0][1]) / (72/25.4)]; })()")
        assert rect[0] == "rect" and abs(rect[1] - 50) < 1e-6 and abs(rect[2] - 30) < 1e-6, rect
        page.keyboard.press("Control+z")
        page.evaluate("window.cotare.setTool('select')")
        # own symbols: B saves two annotations with a base point and a name, I places them, L opens the library
        n_before = page.evaluate("window.cotare.annots.length")
        page.evaluate("window.cotare.selectMany(window.cotare.annots.filter(a => a.type === 'shape' && a.kind === 'line').slice(-2).map(a => a.id))")
        page.click("#cmdIn")
        typed("B")
        assert page.evaluate("window.cotare.tool") == "symSave"
        click(100, 40)
        page.wait_for_function("!!window.cotare.cmdAsk")
        page.keyboard.type("Doua linii")
        page.keyboard.press("Enter")
        page.wait_for_function("(JSON.parse(localStorage.getItem('drawcad.symbols') || '[]')).some(s => s.name === 'Doua linii' && s.items.length === 2)")
        page.click("#cmdIn")
        typed("I")
        assert page.evaluate("window.cotare.tool") == "symbol"
        click(150, 60)
        page.wait_for_function(f"window.cotare.annots.length === {n_before + 2}")
        page.click("#cmdIn")
        typed("L")
        page.wait_for_selector(".symcard.cur")
        page.screenshot(path=str(out / "simboluri.png"))
        page.keyboard.press("Escape")
        page.wait_for_function("document.getElementById('modal').hidden")
        page.keyboard.press("Enter")
        page.wait_for_function("window.cotare.tool === 'select'")
        page.keyboard.press("Control+z")
        page.wait_for_function(f"window.cotare.annots.length === {n_before}")
        # F1 opens the sheet wherever the focus is (? too, unless something is typed in a field)
        page.keyboard.press("F1")
        page.wait_for_selector("#ssGrid")
        page.fill("#ssQ", "cerc")
        assert page.evaluate("[...document.querySelectorAll('.ssrow')].filter(r => !r.hidden).length") >= 1
        page.keyboard.press("Escape")
        page.wait_for_function("document.getElementById('modal').hidden")
        page.evaluate("window.cotare.setTool('select')")
        page.keyboard.press("t")
        click(100, 30)
        page.press("#tTxt", "Escape")
        # the first change after an exported revision starts the next one
        rev1 = page.evaluate("window.cotare.settings.revNo")
        assert int(rev1) == int(rev0[0]) + 1, (rev0, rev1)
        page.click("#btnClose")
        page.wait_for_selector("#cClose")
        page.click("#cClose")
        page.wait_for_function("window.cotare.doc === null")

        # English interface
        page.evaluate("localStorage.setItem('drawcad.lang', 'en')")
        page.goto(url)
        page.wait_for_function("document.querySelector('[data-tool=dimLin] span') && document.querySelector('[data-tool=dimLin] span').textContent === 'Linear'")
        assert page.inner_text("#btnOpen").strip() == "Open", page.inner_text("#btnOpen")
        page.evaluate("localStorage.setItem('drawcad.lang', 'ro')")
        b.close()

    import pikepdf
    with pikepdf.open(str(path)) as pk:
        assert str(pk.docinfo.get("/DrawCADRevision", "")) == "1", dict(pk.docinfo)
        notes = [a for pg in pk.pages for a in pg.obj.get("/Annots", []) if a.get("/Subtype") == "/Text"]
        assert any("De verificat" in str(a.get("/Contents", "")) for a in notes), notes
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(path))
    img = doc[0].render(scale=3).to_pil()
    img.save(out / "export_p1.png")
    # crop on the shaft area
    img.crop((int(20 * MM * 3), int(38 * MM * 3), int(195 * MM * 3), int(160 * MM * 3))).save(out / "export_zoom.png")
    img.crop((int(80 * MM * 3), int(115 * MM * 3), int(292 * MM * 3), int(205 * MM * 3))).save(out / "export_note_cartus.png")
    txt = doc[0].get_textpage().get_text_range()
    print("TEXT:", " | ".join(t for t in txt.split() if t))
    assert "Ø30" not in txt.split(), "the Ø30 text should have been removed from the original"
    print("CONSOLE ERRORS:", errors or "none")


def _make_dxf(path):
    """A 120 × 80 plate with a hole and a label (layer TEXT), on an A4 layout at 1:2 and a detail
    layout at 1:1."""
    import ezdxf

    doc = ezdxf.new("R2010", setup=True, units=4)
    doc.styles.add("ISO", font="isocp.shx")
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (120, 0), (120, 80), (0, 80)], close=True)
    msp.add_circle((60, 40), 15)
    doc.layers.add("TEXT", color=1)
    msp.add_text("PLACĂ", height=7, dxfattribs={"style": "ISO", "layer": "TEXT"}).set_placement((5, 85))
    lay = doc.layouts.new("Plansa")
    lay.page_setup(size=(297, 210), margins=(0, 0, 0, 0), units="mm")
    lay.add_viewport(center=(148.5, 105), size=(277, 190), view_center_point=(60, 45), view_height=380)
    det = doc.layouts.new("Detaliu")  # the hole at 1:1
    det.page_setup(size=(297, 210), margins=(0, 0, 0, 0), units="mm")
    det.add_viewport(center=(148.5, 105), size=(100, 100), view_center_point=(60, 40), view_height=100)
    doc.saveas(path)


def _report_failure(exc):
    """One clear line about which step failed (the line in this file and the message), plus a screenshot."""
    import traceback

    tb = traceback.extract_tb(exc.__traceback__)
    here = [f for f in tb if f.filename.endswith("e2e_smoke.py")]
    where = f"e2e_smoke.py:{here[-1].lineno} `{(here[-1].line or '').strip()}`" if here else "?"
    msg = str(exc).strip().splitlines()
    print(f"E2E FAILED at {where}: {type(exc).__name__}: {msg[0] if msg else ''}", flush=True)
    for ln in msg[1:8]:
        print(f"  » {ln}", flush=True)
    if _STATE.get("errors"):
        print("CONSOLE ERRORS:", " | ".join(_STATE["errors"][-10:]), flush=True)
    page = _STATE.get("page")
    if page is not None:
        try:
            page.screenshot(path=str(Path(_STATE["out"]) / "failure.png"))
            print("screenshot: failure.png", flush=True)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    try:
        main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765", sys.argv[2] if len(sys.argv) > 2 else "e2e_out")
    except Exception as e:  # noqa: BLE001
        _report_failure(e)
        raise
