// Radial menu on the held right button (as in Inventor).
// Methods of the editor (App in main.js), mixed into App.prototype.

import { K } from "../annots.js";
import { TOOL_BY_ID, finalize } from "../tools.js";
import * as dlg from "../dialogs.js";
import { markingConfig, MM_ICONS } from "../mmenu.js";
import { $ } from "./util.js";

export class RadialMenu {
  // ------------------------------------------------------------ radial menu (as in Inventor)
  /** Radial menu commands, in the order E, NE, N, NW, W, SW, S, SE (chosen in Settings). */
  markingItems() {
    return markingConfig().map((id) => this.markingAction(id)).map((it) => it || this.markingAction("dimLin"));
  }

  markingAction(id) {
    const tool = (tid) => TOOL_BY_ID[tid] && { id: tid, label: TOOL_BY_ID[tid].label, icon: TOOL_BY_ID[tid].icon, run: () => this.setTool(tid) };
    const del = { id: "del", label: "Șterge selecția", icon: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13", run: () => this.deleteSelected() };
    switch (id) {
      case "last": {
        const last = this.lastTool && TOOL_BY_ID[this.lastTool];
        return last ? tool(last.id) : tool("dimLin");
      }
      case "undo":
        return { id, label: "Anulează acțiunea", icon: MM_ICONS.undo, run: () => this.doUndo() };
      case "redo":
        return { id, label: "Refă", icon: MM_ICONS.redo, run: () => this.doRedo() };
      case "del":
        return del;
      case "seldel":
        return this.sel.size ? del : tool("line");
      case "dup":
        return { id, label: "Duplică", icon: MM_ICONS.dup, run: () => this.copySelected(true) && this.paste(true) };
      case "fit":
        return { id, label: "Potrivește", icon: MM_ICONS.fit, run: () => this.view.fit() };
      case "export":
        return { id, label: "Exportă PDF", icon: MM_ICONS.export, run: () => this.doc && dlg.exportDialog(this) };
      default:
        return tool(id);
    }
  }

  openMarkingMenu(sx, sy) {
    this.closeMarkingMenu();
    const vp = $("viewport");
    const items = this.markingItems();
    const el = document.createElement("div");
    el.className = "mmenu";
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    const rx = 118;
    const ry = 78;
    el.innerHTML = `<div class="mm-center"></div>${items.map((it, i) => {
      const a = (i * Math.PI) / 4;
      const x = Math.cos(a) * rx;
      const y = -Math.sin(a) * ry;
      const side = Math.abs(Math.cos(a)) < 0.2 ? "c" : Math.cos(a) > 0 ? "r" : "l";
      return `<button class="mm-item mm-${side}" data-i="${i}" style="left:${x}px;top:${y}px" title="${it.label}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${it.icon}"/></svg><span>${it.label}</span></button>`;
    }).join("")}`;
    vp.appendChild(el);
    // keep the menu on screen
    const r = el.getBoundingClientRect();
    const vr = vp.getBoundingClientRect();
    const pad = 150;
    el.style.left = `${Math.min(Math.max(sx, pad), vr.width - pad)}px`;
    el.style.top = `${Math.min(Math.max(sy, 110), vr.height - 110)}px`;
    void r;
    el.querySelectorAll(".mm-item").forEach((b) => b.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      this.runMarking(Number(b.dataset.i));
    }));
    this.mmenu = { el, items, cx: parseFloat(el.style.left), cy: parseFloat(el.style.top), hi: -1 };
  }

  /** With the button still pressed, the direction from the center picks the command (marking menu). */
  hoverMarking(sx, sy) {
    const m = this.mmenu;
    if (!m) return;
    const dx = sx - m.cx;
    const dy = sy - m.cy;
    let hi = -1;
    if (Math.hypot(dx, dy) > 28) {
      const a = Math.atan2(-dy, dx);
      hi = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    }
    if (hi !== m.hi) {
      m.hi = hi;
      m.el.querySelectorAll(".mm-item").forEach((b) => b.classList.toggle("hi", Number(b.dataset.i) === hi));
    }
  }

  runMarking(i) {
    const m = this.mmenu;
    if (!m || !m.items[i]) return;
    const it = m.items[i];
    this.closeMarkingMenu();
    it.run();
  }

  closeMarkingMenu() {
    if (this.mmenu) {
      this.mmenu.el.remove();
      this.mmenuClosedAt = performance.now();
    }
    this.mmenu = null;
  }

  pinchState() {
    const [a, b] = [...this.touches.values()];
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, d0: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  }

  /** One click of the active tool (dimension points, polyline vertices…). */
  toolClick(pt, raw = null, shift = false) {
    const t = TOOL_BY_ID[this.tool];
    if (this.pointMod && this.consumePointMod(pt)) return;
    if (t.kind === "pick") {
      // OFFSET, TRIM, EXTEND: an object under the cursor (a typed point picks there too)
      this.lastPick = pt;
      this.snapOverride = null;
      t.click(this, raw || pt, pt, shift);
      return;
    }
    this.lastPick = pt; // AutoCAD's LASTPOINT: what @ refers to
    this.snapOverride = null; // a typed override (END, MID…) is for one pick
    this.snapPick = null;
    if (this.dyn) this.dynReset();
    if (t.kind === "poly" && this.placing) {
      // ordinates: the last click places the row (and decides the axis)
      const pts = this.clicks;
      this.placing = false;
      this.clicks = [];
      this.view.overlay = null;
      this.setHint(t.hint);
      this.clearAcq();
      this.addMade(t.make(pts, this, false, pt));
      return;
    }
    if (t.kind === "poly") {
      const v = this.view;
      const near = (q) => {
        const [ax, ay] = v.toScreen(q);
        const [bx, by] = v.toScreen(pt);
        return Math.hypot(ax - bx, ay - by);
      };
      const n = this.clicks.length;
      // click on the first point: closed outline · second click at the same spot (double click): done
      if (n >= Math.max(3, t.min || 2) && near(this.clicks[0]) < 8) return this.finishPoly(true);
      if (n && near(this.clicks[n - 1]) < 3) return this.finishPoly(false);
      this.clicks.push(pt);
      this.updateOverlay(pt, null);
      return;
    }
    if (t.id === "measure" && this.cmdState.area) return this.areaClick(pt);
    if (t.kind === "clicks") {
      this.clicks.push(pt);
      if (this.clicks.length >= t.n) {
        const pts = this.clicks;
        this.clicks = [];
        this.view.overlay = null;
        if (t.id === "measure") {
          if (this.cmdState.multi) {
            this.measureChain(pts[0], pts[1]);
            return;
          }
          this.showMeasure(pts[0], pts[1]);
          return;
        }
        if (t.id === "calib") {
          const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / K;
          if (d > 0.1) dlg.calibDialog(this, d);
          return;
        }
        const made = t.make(pts, this);
        if (!made) return; // nothing to make (the tool says why)
        this.addMade(made);
        if (!t.chain) this.clearAcq();
        if (t.chain) {
          // like LINE in CAD: the next segment starts at the end of the one just drawn
          if (!this.chain) this.chain = { first: pts[0], ids: [] };
          this.chain.ids.push(this.annots[this.annots.length - 1].id);
          this.clicks = [pts[pts.length - 1]];
          this.updateOverlay(pt, null);
        }
      } else {
        this.updateOverlay(pt, null);
      }
    }
  }

  /** A rectangle of a drag tool (strike, cover, remove, blacken), dragged or typed. */
  commitRect(r, e = null) {
    this.snapOverride = null;
    const t0 = TOOL_BY_ID[this.tool];
    if (t0.id === "image") {
      this.commitImage(r, !!(e && e.shiftKey));
      return;
    }
    if (Math.abs(r[2] - r[0]) < 2 || Math.abs(r[3] - r[1]) < 2) return;
    this.lastPick = [r[2], r[3]];
    const t = TOOL_BY_ID[this.tool];
    const a = t.make(r, this);
    if (a.type === "redact") {
      a.page = this.page;
      dlg.redactDialog(this, a, true);
    } else if (a.type === "ink") {
      a.page = this.page;
      dlg.inkDialog(this, a, true);
    } else {
      if (a.type === "strike") a.side = this.freeStrikeSide(a);
      this.addAnnot(finalize(a));
    }
  }
}
