"""Generează un PDF de test asemănător cu un export CAD: arbore în trepte, cote, cartuș
într-un Form XObject, un cerc (curbe Bézier) și o a doua pagină cu /Rotate 90."""
import io
import sys

import pikepdf
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

MM = 72 / 25.4


def mm(v):
    return v * MM


def build(path):
    buf = io.BytesIO()
    W, H = landscape(A4)
    c = canvas.Canvas(buf, pagesize=(W, H))

    def Y(y):  # coordonate desen cu y în jos, ca pe hârtie
        return H - mm(y)

    def line(x1, y1, x2, y2, w=0.25):
        c.setLineWidth(mm(w))
        c.line(mm(x1), Y(y1), mm(x2), Y(y2))

    def arrow(x, y, ang_deg, size=3):
        import math
        a = math.radians(ang_deg)
        p = c.beginPath()
        p.moveTo(mm(x), Y(y))
        for s in (+1, -1):
            pass
        bx = x - size * math.cos(a)
        by = y - size * math.sin(a)
        nx, ny = -math.sin(a) * size * 0.18, math.cos(a) * size * 0.18
        p.lineTo(mm(bx + nx), Y(by + ny))
        p.lineTo(mm(bx - nx), Y(by - ny))
        p.close()
        c.drawPath(p, stroke=0, fill=1)

    # chenar
    c.setLineWidth(mm(0.5))
    c.rect(mm(20), Y(200), mm(267), mm(190))

    # cartuș ca Form XObject (ca la multe exporturi CAD)
    c.beginForm("cartus")
    c.setLineWidth(mm(0.35))
    c.rect(mm(207), Y(200), mm(80), mm(30))
    c.setLineWidth(mm(0.18))
    for yy in (177, 184, 191):
        c.line(mm(207), Y(yy), mm(287), Y(yy))
    c.line(mm(247), Y(177), mm(247), Y(200))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(mm(209), Y(175), "Arbore intermediar")
    c.setFont("Helvetica", 7)
    c.drawString(mm(209), Y(182), "Material: 42CrMo4")
    c.drawString(mm(249), Y(182), "Scara 1:1")
    c.drawString(mm(209), Y(189), "Tol. gen. ISO 2768-mK")
    c.endForm()
    c.doForm("cartus")

    # contur arbore: un singur path închis
    c.setLineWidth(mm(0.5))
    p = c.beginPath()
    pts = [(60, 83.5), (61, 82.5), (90, 82.5), (90, 75), (140, 75), (140, 80), (180, 80), (180, 110),
           (140, 110), (140, 115), (90, 115), (90, 107.5), (61, 107.5), (60, 106.5)]
    p.moveTo(mm(pts[0][0]), Y(pts[0][1]))
    for x, y in pts[1:]:
        p.lineTo(mm(x), Y(y))
    p.close()
    c.drawPath(p, stroke=1, fill=0)
    # muchii interioare: linii separate
    line(61, 82.5, 61, 107.5, 0.5)
    line(90, 82.5, 90, 107.5, 0.5)
    line(140, 80, 140, 110, 0.5)
    # axa
    c.setDash([mm(8), mm(1.5), mm(1), mm(1.5)])
    line(52, 95, 188, 95, 0.18)
    c.setDash([])

    # cote originale: linii + săgeți pline + text
    c.setFont("Helvetica", 10)
    line(115, 75, 115, 115)
    arrow(115, 75, -90)
    arrow(115, 115, 90)
    c.saveState()
    c.translate(mm(113.5), Y(95))
    c.rotate(90)
    c.drawCentredString(0, 0, "Ø40 h6")
    c.restoreState()

    line(165, 80, 165, 110)
    arrow(165, 80, -90)
    arrow(165, 110, 90)
    c.saveState()
    c.translate(mm(163.5), Y(95))
    c.rotate(90)
    c.drawCentredString(0, 0, "Ø30")
    c.restoreState()

    line(90, 74, 90, 64)
    line(140, 74, 140, 64)
    line(90, 66, 140, 66)
    arrow(90, 66, 180)
    arrow(140, 66, 0)
    c.drawCentredString(mm(115), Y(64.8), "50")

    line(60, 82, 60, 48)
    line(180, 79, 180, 48)
    line(60, 50, 180, 50)
    arrow(60, 50, 180)
    arrow(180, 50, 0)
    c.drawCentredString(mm(120), Y(48.8), "118")

    # vedere laterală: cerc Ø40 (Bézier)
    c.setLineWidth(mm(0.5))
    c.circle(mm(240), Y(95), mm(20))
    c.circle(mm(240), Y(95), mm(15))
    c.showPage()

    # pagina 2: portret, va primi /Rotate 90
    c.setPageSize(A4)
    c.setLineWidth(mm(0.5))
    c.rect(mm(30), mm(30), mm(100), mm(60))
    c.setFont("Helvetica", 12)
    c.drawString(mm(35), mm(95), "Pagina 2 - rotita 90")
    c.line(mm(30), mm(30), mm(130), mm(90))
    c.showPage()
    c.save()

    pk = pikepdf.open(io.BytesIO(buf.getvalue()))
    pk.pages[1].Rotate = 90
    pk.save(path)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "sample.pdf")
