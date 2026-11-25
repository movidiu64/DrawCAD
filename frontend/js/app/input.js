// Typed points and the dynamic input next to the cursor.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { hit, K, fmtNum } from "../annots.js";
import { TOOL_BY_ID } from "../tools.js";
import { toUser, defaultOrigin } from "../pointin.js";
import * as dlg from "../dialogs.js";
import { tr } from "../i18n.js";
import { esc, $ } from "./util.js";

export class PointInput {
  // ------------------------------------------------------------ typed points (CMD-D1…D4)
  /** A command that asks for points is running (any drawing or annotation tool). */
  cmdActive() {
    return !!(this.doc && (this.hotGrip || (this.tool !== "select" && this.tool !== "pan")));
  }

  /** Origin of typed coordinates on a page: its UCS annotation, or the bottom-left corner. */
  originOf(page = this.page) {
    const u = this.annots.find((a) => a.type === "ucs" && a.page === page && Array.isArray(a.p));
    if (u) return u.p;
    const pg = this.doc && this.doc.pages[page];
    return defaultOrigin(pg ? pg.h : 0);
  }

  /** Where the rubber band, polar and ortho start: the last tracking point during TK, else the last click. */
  pickAnchor() {
    if (this.hotGrip) return this.hotGrip.base;
    const m = this.pointMod;
    if (m && m.kind === "tk" && m.pts.length) return m.pts[m.pts.length - 1];
    return this.clicks[this.clicks.length - 1];
  }

  /** The point @ and a lone distance are measured from. */
  lastPoint() {
    if (this.hotGrip) return this.hotGrip.base;
    if (this.pointMod && this.pointMod.kind === "from" && this.pointMod.base) return this.pointMod.base;
    if (this.pointMod && this.pointMod.kind === "tk" && this.pointMod.pts.length) return this.pickAnchor();
    if (this.rectStart) return this.rectStart;
    if (this.clicks.length) return this.clicks[this.clicks.length - 1];
    return this.lastPick || null;
  }

  /**
   * FROM, M2P and option S of DCO / DBA take the next picks before the tool does.
   * Returns true when the pick was used here.
   */
  /** TK: the end of tracking (Enter); the last tracking point goes to the command. */
  finishTracking() {
    const m = this.pointMod;
    this.pointMod = null;
    this.updateCmdPrompt();
    if (m && m.pts.length) this.toolClick(m.pts[m.pts.length - 1]);
  }

  /** TK: the tracking path drawn so far stays on screen. */
  updateTkOverlay() {
    const m = this.pointMod;
    if (!m || m.kind !== "tk") return;
    this.view.redraw(); // view.js draws the path from pointMod.pts
  }

  consumePointMod(pt) {
    const m = this.pointMod;
    if (m.kind === "from") {
      if (!m.base) {
        m.base = pt;
        this.lastPick = pt;
        this.snapOverride = null;
        this.updateCmdPrompt();
        return true;
      }
      this.pointMod = null; // the offset point (typed @ from the base, or picked) goes to the tool
      return false;
    }
    if (m.kind === "tk") {
      // TK (tracking): each point is taken horizontally or vertically from the previous one;
      // Enter ends and the last one goes to the command
      if (m.pts.length) {
        const q = m.pts[m.pts.length - 1];
        pt = Math.abs(pt[0] - q[0]) >= Math.abs(pt[1] - q[1]) ? [pt[0], q[1]] : [q[0], pt[1]];
      }
      m.pts.push(pt);
      this.lastPick = pt;
      this.snapOverride = null;
      this.updateCmdPrompt();
      this.updateTkOverlay();
      return true;
    }
    if (m.kind === "m2p") {
      if (!m.a) {
        m.a = pt;
        this.snapOverride = null;
        this.updateCmdPrompt();
        return true;
      }
      this.pointMod = null;
      this.toolClick([(m.a[0] + pt[0]) / 2, (m.a[1] + pt[1]) / 2]);
      return true;
    }
    if (m.kind === "fx" || m.kind === "fy") {
      // .X / .Y: the first pick gives one coordinate, the next one the other
      if (!m.first) {
        m.first = pt;
        this.snapOverride = null;
        this.updateCmdPrompt();
        return true;
      }
      this.pointMod = null;
      this.toolClick(m.kind === "fx" ? [m.first[0], pt[1]] : [pt[0], m.first[1]]);
      return true;
    }
    if (m.kind === "pickDim") {
      this.pointMod = null;
      const tol = 6 / this.view.zoom;
      const hitDim = [...this.visibleBuilt()].reverse().find(({ a, built }) => a.type === "dim" && a.kind === "lin" && hit(built, a, pt, tol));
      if (!hitDim) {
        dlg.toast("Acolo nu e o cotă liniară");
        this.updateCmdPrompt();
        return true;
      }
      this.seriesFrom(hitDim.a);
      return true;
    }
    return false;
  }

  /** DCO / DBA from a linear dimension: the chain (or the baseline) goes on from it. */
  seriesFrom(d) {
    const orient = d.orient === "v" ? "v" : "h";
    this.cmdState.orient = orient;
    if (this.tool === "dimCont") {
      // as DIMCONTINUE: from the second extension line, on the same dimension line
      this.clicks = [[...d.p2]];
      this.cmdState.seriesAt = [...d.p3];
    } else {
      // as DIMBASELINE: from the first extension line, one step further out
      const S = this.S();
      const step = Math.max(7 * K, S.h * 2.4);
      const ax = orient === "h" ? 1 : 0;
      const dir = Math.sign(d.p3[ax] - (d.p1[ax] + d.p2[ax]) / 2) || 1;
      const at = [...d.p3];
      at[ax] += dir * step;
      this.clicks = [[...d.p1]];
      this.cmdState.seriesAt = at;
    }
    this.lastPick = this.clicks[0];
    this.updateCmdPrompt();
    if (this._dynPt) this.updateOverlay(this._dynPt, null);
  }

  // ------------------------------------------------------------ dynamic input (DYN)
  /** The tool expects a point relative to the last click: values can be typed on the keyboard. */
  dynTool() {
    const t = TOOL_BY_ID[this.tool];
    // a hot grip in Stretch or Move: length and angle from the base point, as for the next point of a line
    const g = this.hotGrip;
    if (g) return !!(this.doc && this.dyn.on && !g.pickBase && (g.mode === "stretch" || g.mode === "move"));
    return !!(this.doc && this.dyn.on && this.clicks.length && !this.placing && t && (t.kind === "clicks" || t.kind === "poly"));
  }

  dynReset() {
    this.dyn.vals = {};
    this.dyn.active = null;
    this.dyn.text = "";
  }

  /** The cursor point, with the typed values applied (in real mm, Y up as in CAD). */
  dynPoint(pt, anchor) {
    const v = this.dyn.vals;
    if (!anchor || !Object.keys(v).length) return pt;
    const k = Number(this.settings.scale) || 1;
    const toPt = (mm) => (mm / k) * K;
    const lx = ((pt[0] - anchor[0]) / K) * k;
    const ly = (-(pt[1] - anchor[1]) / K) * k;
    if (v.len != null || v.ang != null) {
      const L = v.len ?? Math.hypot(lx, ly);
      const th = ((v.ang != null ? v.ang : (Math.atan2(ly, lx) * 180) / Math.PI) * Math.PI) / 180;
      return [anchor[0] + toPt(L * Math.cos(th)), anchor[1] - toPt(L * Math.sin(th))];
    }
    return [anchor[0] + toPt(v.dx ?? lx), anchor[1] - toPt(v.dy ?? ly)];
  }

  defaultDynField() {
    // length along the cursor direction first; Tab → angle
    return "len";
  }

  dynParse() {
    const d = this.dyn;
    if (!d.active) return;
    const group = d.active === "len" || d.active === "ang" ? ["dx", "dy"] : ["len", "ang"];
    const v = Number(d.text);
    if (d.text === "" || d.text === "-" || d.text === ".") delete d.vals[d.active];
    else if (Number.isFinite(v)) {
      d.vals[d.active] = v;
      for (const g of group) delete d.vals[g]; // cartesian or polar, not mixed
    }
  }

  /** Keys for dynamic input; returns true if the key was used here. */
  dynKey(e) {
    if (!this.dynTool()) return false;
    const d = this.dyn;
    // the comma (including the numeric keypad one) is the decimal separator: 12,5 = 12.5
    const k = e.code === "NumpadDecimal" || e.key === "," ? "." : e.key;
    const has = d.active || Object.keys(d.vals).length;
    if (/^[0-9.\-]$/.test(k)) {
      if (!d.active) {
        d.active = this.defaultDynField();
        d.text = "";
      }
      if (k === "-" && d.text) return true;
      if (k === "." && d.text.includes(".")) return true;
      d.text += k;
      this.dynParse();
      this.dynRefresh();
      return true;
    }
    if (k === "Tab" && !has && this.cycleSnap(e.shiftKey)) return true;
    if (k === "Tab") {
      // Tab switches between length and angle; the typed value stays locked
      d.active = (d.active || this.defaultDynField()) === "len" ? "ang" : "len";
      d.text = d.vals[d.active] != null ? String(d.vals[d.active]) : "";
      this.dynRefresh();
      return true;
    }
    if (k === "Backspace" && has) {
      if (d.text) d.text = d.text.slice(0, -1);
      else if (d.active) delete d.vals[d.active];
      this.dynParse();
      this.dynRefresh();
      return true;
    }
    if ((k === "Enter" || k === " ") && has) {
      const anchor = this.pickAnchor();
      const p = this.dynPoint(this._dynPt || this.lastPt || anchor, anchor);
      this.dynReset();
      if (this.hotGrip) this.applyHotGrip(p);
      else this.toolClick(p);
      this.dynRefresh();
      return true;
    }
    if (k === "Escape" && has) {
      this.dynReset();
      this.dynRefresh();
      return true;
    }
    return false;
  }

  dynRefresh() {
    const anchor = this.pickAnchor();
    if (!anchor || !this._dynPt) {
      this.renderDyn(null, null);
      return;
    }
    const p = this.dynPoint(this._dynPt, anchor);
    if (this.hotGrip) this.previewHotGrip(p, this._dynSn);
    else this.updateOverlay(p, this._dynSn);
    this.showCoords(p, anchor);
    this.renderDyn(p, anchor);
  }

  renderDyn(pt, anchor) {
    const box = $("dynBox");
    if (!box) return;
    // as AutoCAD's dynamic prompt: what the command asks, next to the cursor (F12 turns it off)
    const promptOn = !!(pt && this.dyn.on && this.cmdActive() && !this.cmdAsk);
    const fields = !!(pt && anchor && this.dynTool());
    if (!promptOn && !fields) {
      box.hidden = true;
      this.dynMenu = null;
      return;
    }
    let head = "";
    if (promptOn) {
      const pr = this.currentPrompt();
      if (this.dynMenu && pr.opts.length) {
        const i = Math.min(this.dynMenu.i, pr.opts.length - 1);
        head = `<div class="dmenu">${pr.opts.map((o, j) => `<div class="${j === i ? "on" : ""}">${esc(tr(o.label))} <i>${o.key}</i></div>`).join("")}</div>`;
      } else {
        head = `<div class="dp">${esc(tr(pr.text))}${pr.opts.length ? ` <i>↓ ${pr.opts.map((o) => o.key).join(" ")}</i>` : ""}</div>`;
      }
    }
    if (!fields) {
      box.innerHTML = head;
      this.placeDyn(box, pt);
      return;
    }
    const d = this.dyn;
    const k = Number(this.settings.scale) || 1;
    const sep = this.settings.sep || ",";
    const dx = ((pt[0] - anchor[0]) / K) * k;
    const dy = (-(pt[1] - anchor[1]) / K) * k;
    const live = { dx, dy, len: Math.hypot(dx, dy), ang: ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360 };
    const names = { dx: "X", dy: "Y", len: "L", ang: "∠" };
    const row = ["len", "ang"].map((f) => {
      const on = d.active === f;
      const lock = !on && d.vals[f] != null;
      const txt = on ? d.text.replace(".", sep) : fmtNum(lock ? d.vals[f] : live[f], sep, f === "ang" ? 1 : 2) + (f === "ang" ? "°" : "");
      return `<span class="df${on ? " on" : ""}${lock ? " lock" : ""}"><i>${names[f]}</i><b>${txt}</b></span>`;
    }).join("");
    box.innerHTML = `${head}<div class="drow">${row}</div>`;
    this.placeDyn(box, pt);
  }

  /** Next to the cursor, below the snap / polar label (that one is at +16, +18 and is 20 px tall). */
  placeDyn(box, pt) {
    const [sx, sy] = this.view.toScreen(this._dynPt || pt);
    const vp = $("viewport");
    box.hidden = false;
    const h = box.offsetHeight || 28;
    const w = box.offsetWidth || 190;
    box.style.left = `${Math.max(4, Math.min(sx + 16, vp.clientWidth - w - 4))}px`;
    box.style.top = `${Math.min(sy + 42, vp.clientHeight - h - 4)}px`;
  }

  showCoords(pt, anchor) {
    // from the origin of typed coordinates (UCS or the bottom-left corner), Y up, real mm
    const [ux, uy] = this.doc ? toUser(pt, this.originOf(), this.settings.scale) : [pt[0] / K, pt[1] / K];
    let s = `X ${fmtNum(ux, ",", 2)} · Y ${fmtNum(uy, ",", 2)} mm`;
    if (anchor) {
      const dx = ((pt[0] - anchor[0]) / K) * this.settings.scale;
      const dy = ((pt[1] - anchor[1]) / K) * this.settings.scale;
      s += ` · Δx ${fmtNum(Math.abs(dx), ",", 2)} · Δy ${fmtNum(Math.abs(dy), ",", 2)} · L ${fmtNum(Math.hypot(dx, dy), ",", 2)}`;
    }
    $("stCoords").textContent = s;
  }
}
