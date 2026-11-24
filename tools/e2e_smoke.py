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
        page.click("[data-act=scale][data-v='0.7']")
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
        # shrink by dragging the corner handle towards the anchor (the title block corner)
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
        page.click('[data-tool="cross"]')
        click(240, 95)
        click(260, 95)
        page.keyboard.press("Escape")
        shapes = page.evaluate("window.cotare.annots.filter(a => a.type === 'shape').map(a => a.kind + ':' + a.ltype)")
        assert shapes == ["line:dash", "cross:chain"], shapes

        # 15. ordinate dimensions from the center of the Ø10 hole, a corrected value, then the hole table
        page.evaluate("() => { const v = window.cotare.view; v.zoom = 2.2; v.panX = -125*72/25.4*2.2; v.panY = -80*72/25.4*2.2; v.afterZoom(); }")
        page.wait_for_timeout(300)
        page.click('[data-tool="dimOrd"]')
        click(145, 167.5)
        click(240, 95)
        page.keyboard.press("Enter")
        click(190, 182)  # below the points: values on X
        page.click('[data-tool="dimOrd"]')
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
        page.click('[data-tool="holes"]')
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
        page.click('[data-tool="dimCont"]')
        for q in [(240, 95), (145, 167.5), (260, 95)]:
            click(*q)
        page.keyboard.press("Enter")
        click(200, 192)
        page.click('[data-tool="dimBase"]')
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
        page.click('[data-tool="ucs"]')
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
        page.click('[data-tool="ucs"]')
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
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(300)

        # select the Ø25 dimension for the screenshot
        page.keyboard.press("v")
        click(75, 90)
        page.wait_for_timeout(300)
        page.screenshot(path=str(out / "editor.png"))

        kinds = page.evaluate("window.cotare.annots.map(a => a.type)")
        assert len(kinds) == 35, kinds

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
        dxf_path = out / "export.dxf"
        dl.value.save_as(str(dxf_path))
        assert dl.value.suggested_filename.endswith(".dxf"), dl.value.suggested_filename
        dxf = dxf_path.read_text("utf-8")
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
        # wait for the new document (loading takes time), not the old one which already had 35 annotations
        page.wait_for_function(f"window.cotare.doc && window.cotare.doc.id !== '{prev_id}' && window.cotare.doc.fromExport && window.cotare.annots.length === 35")
        # closing without changes: straight to the start page
        page.click("#btnClose")
        page.wait_for_function("window.cotare.doc === null && !document.getElementById('emptyState').hidden")
        page.wait_for_function("document.querySelectorAll('#recentList [data-doc]').length >= 1", timeout=5000)
        # reopen from Recent, one change, then close with the prompt
        page.click("#recentList [data-doc]")
        page.wait_for_function("window.cotare.doc !== null && window.cotare.annots.length === 35")
        page.wait_for_timeout(300)
        page.keyboard.press("t")
        click(100, 30)
        page.press("#tTxt", "Escape")
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
