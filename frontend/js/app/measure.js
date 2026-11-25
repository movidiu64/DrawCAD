// Measure, option Area (V13-4): area and perimeter of an outline picked point by point, or of a closed
// drawn shape (rectangle, circle, closed polyline, hatch). Nothing is added to the drawing.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { K, fmtNum } from "../annots.js";
import * as dlg from "../dialogs.js";
import { closedOutline, polygonMetrics } from "../shapes.js";

export class MeasureArea {
  /** A click of DI in Area mode: a vertex, the first vertex again (closes), or the object picked. */
  areaClick(pt) {
    const st = this.cmdState;
    if (st.areaObj) {
      const a = this.annotAt(pt);
      const o = closedOutline(a);
      if (!o) {
        dlg.toast("Alege un contur închis desenat: dreptunghi, cerc, polilinie închisă sau hașură");
        return;
      }
      this.showArea(o);
      return;
    }
    const n = this.clicks.length;
    if (n >= 3) {
      const [ax, ay] = this.view.toScreen(this.clicks[0]);
      const [bx, by] = this.view.toScreen(pt);
      if (Math.hypot(ax - bx, ay - by) < 8) return this.finishArea();
    }
    this.clicks.push(pt);
    this.updateOverlay(pt, null);
    this.updateCmdPrompt();
  }

  /** Enter (or C, or a click on the first point) closes the outline picked so far. */
  finishArea() {
    const pts = this.clicks;
    this.clicks = [];
    if (pts.length < 3) {
      this.view.overlay = null;
      this.view.redraw();
      return;
    }
    this.showArea({ pts });
  }

  /** Area and perimeter in real units (drawing scale), the outline highlighted until the next pick. */
  showArea(o) {
    const k = Number(this.settings.scale) || 1;
    let area;
    let per;
    let prims;
    if (o.c) {
      area = Math.PI * o.r * o.r;
      per = 2 * Math.PI * o.r;
      prims = [{ t: "C", p: [...o.c], r: o.r, w: 0.8, c: "sel" }];
    } else {
      ({ area, perimeter: per } = polygonMetrics(o.pts));
      prims = [{ t: "P", p: o.pts.flat(), close: true, w: 0.8, c: "sel" }, ...o.pts.map((p) => ({ t: "C", p: [...p], r: 1.2, w: 0.6, c: "sel" }))];
    }
    const mm2 = (area / (K * K)) * k * k;
    const mm = (per / K) * k;
    this.lastMeasure = prims;
    this.view.overlay = { prims };
    this.view.redraw();
    const cm2 = mm2 >= 10000 ? ` (${fmtNum(mm2 / 100, ",", 2)} cm²)` : "";
    const msg = `A = ${fmtNum(mm2, ",", 2)} mm²${cm2} · P = ${fmtNum(mm, ",", 3)} mm${Math.abs(k - 1) > 1e-9 ? ` (scara ${this.scaleLabel()})` : ""}`;
    this.logCmd(msg);
    dlg.toast(msg, 10000);
    this.updateCmdPrompt();
  }
}
