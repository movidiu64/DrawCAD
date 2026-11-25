// Mouse and touch on the canvas: tools, selection, dragging.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { build, hit, setHandle, moveAnnot, annotSnapPoints, K, fmtNum, SCALE_MIN, SCALE_MAX, annotSnapSegs, imageRect } from "../annots.js";
import { COLORS } from "../view.js";
import { Snapper, MODES, overrideModes, LABELS } from "../osnap.js";
import { TOOL_BY_ID, finalize } from "../tools.js";
import { clickSelection, windowSelection } from "../selection.js";
import { orthoActive } from "../pointin.js";
import { round2, simplifyPath, esc, $, gripKey } from "./util.js";

export class Mouse {
  // ------------------------------------------------------------ mouse
  snapPoint(raw, e, anchor) {
    const v = this.view;
    const cfg = this.snapCfg;
    // TK: every tracking point goes horizontally or vertically from the previous one
    const tk = this.pointMod && this.pointMod.kind === "tk" && this.pointMod.pts.length;
    const ortho = tk || orthoActive(cfg.ortho, e.shiftKey);
    // a candidate chosen with Tab stays while the cursor stays
    if (this.snapPick) {
      if (Math.hypot(raw[0] - this.snapPick.raw[0], raw[1] - this.snapPick.raw[1]) * v.zoom < 3) return { pt: this.snapPick.p, sn: this.snapPick.sn };
      this.snapPick = null;
    }
    let pt = raw;
    let sn = null;
    if (!e.altKey) {
      // a typed override (END, MID… NON) works for one pick, even with snap off
      const ov = this.snapOverride;
      const on = cfg.on || !!ov;
      const extra = { pts: [], segs: [], arcs: [] };
      if (on) {
        for (const { a, built } of this.visibleBuilt()) {
          if (this.drag && this.drag.id === a.id) continue;
          if (built.snap) {
            extra.pts.push(...built.snap.pts);
            extra.segs.push(...built.snap.segs);
            if (built.snap.arcs) extra.arcs.push(...built.snap.arcs);
          } else {
            extra.pts.push(...annotSnapPoints(built));
            extra.segs.push(...annotSnapSegs(built));
          }
        }
      }
      this._extra = extra;
      // an original hidden on screen no longer "catches" the cursor
      const sp = on && !this.hidden.has("orig") ? this.snapper : this.noSnapper;
      sn = sp.snap(raw, {
        tol: 10 / v.zoom,
        modes: ov ? overrideModes(ov) : on ? new Set(cfg.modes) : new Set(),
        anchor,
        extra,
        acq: on ? this.acq : [],
        parDir: this.parDir,
        polarInc: !ortho && cfg.polar ? cfg.polarInc : 0,
        polarExtra: !ortho && cfg.polar ? cfg.polarExtra || [] : [],
        polarBase: cfg.polarRel ? this.lastSegAngle() : 0,
        polarStep: cfg.polarStep > 0 ? (cfg.polarStep / (Number(this.settings.scale) || 1)) * K : 0,
        tracking: on && cfg.tracking,
        trackPolar: on && cfg.tracking && !!cfg.trackPolar,
      });
      if (sn) {
        pt = sn.p;
        sn.label = this.snapLabel(sn, anchor);
      }
    }
    if ((!sn || sn.kind === "n") && anchor && ortho) {
      const dx = Math.abs(raw[0] - anchor[0]);
      const dy = Math.abs(raw[1] - anchor[1]);
      pt = dx >= dy ? [raw[0], anchor[1]] : [anchor[0], raw[1]];
      sn = null;
    }
    return { pt, sn };
  }

  snapLabel(sn, anchor) {
    let s = LABELS[sn.kind] || "";
    if (sn.d2 && sn.d2 !== sn.kind) s += ` + ${LABELS[sn.d2].toLowerCase()}`;
    if (sn.onObj) s += " ∩ obiect";
    const from = sn.from || (sn.kind === "pol" || sn.kind === "par" ? anchor : null);
    if (from && (sn.kind === "pol" || sn.kind === "par" || sn.kind === "trk" || sn.kind === "ext")) {
      const L = (Math.hypot(sn.p[0] - from[0], sn.p[1] - from[1]) / K) * (this.settings.scale || 1);
      const ang = ((Math.atan2(-(sn.p[1] - from[1]), sn.p[0] - from[0]) * 180) / Math.PI + 360) % 360;
      s += `: ${fmtNum(L, ",", 2)} < ${fmtNum(ang, ",", 1)}°`;
    }
    return s;
  }

  /** Direction of the last segment drawn (degrees, counter-clockwise), for relative polar angles. */
  lastSegAngle() {
    let p = null;
    let q = null;
    if (this.clicks.length >= 2) [p, q] = this.clicks.slice(-2);
    else if (this.chain && this.chain.ids.length) {
      const a = this.annots.find((x) => x.id === this.chain.ids[this.chain.ids.length - 1]);
      if (a && a.pts && a.pts.length >= 2) [p, q] = a.pts.slice(-2);
    }
    if (!p || !q) return 0;
    return (Math.atan2(-(q[1] - p[1]), q[0] - p[0]) * 180) / Math.PI;
  }

  /** Tab: the next snap candidate under the cursor (Shift+Tab: the previous one). */
  cycleSnap(back = false) {
    const raw = this.lastPt;
    if (!raw || !this.cmdActive() || this.placing) return false;
    const cfg = this.snapCfg;
    const ov = this.snapOverride;
    if (!cfg.on && !ov) return false;
    const anchor = this.lastPoint();
    const sp = this.hidden.has("orig") ? this.noSnapper : this.snapper;
    const list = sp.candidates(raw, {
      tol: 10 / this.view.zoom,
      modes: ov ? overrideModes(ov) : new Set(cfg.modes),
      anchor: this.clicks.length || this.rectStart ? anchor : null,
      extra: this._extra || {},
      acq: this.acq,
      parDir: this.parDir,
      polarInc: 0,
      tracking: false,
    });
    if (list.length < 2) return false;
    const key = `${raw[0].toFixed(2)},${raw[1].toFixed(2)}`;
    if (!this.snapCyc || this.snapCyc.key !== key || this.snapCyc.n !== list.length) this.snapCyc = { key, i: 0, n: list.length };
    this.snapCyc.i = (this.snapCyc.i + (back ? list.length - 1 : 1)) % list.length;
    const c = { ...list[this.snapCyc.i] };
    c.label = `${this.snapLabel(c, anchor)} (${this.snapCyc.i + 1}/${list.length}, Tab)`;
    this.snapPick = { raw: [...raw], p: c.p, sn: c };
    this._dynPt = c.p;
    this._dynSn = c;
    this.updateOverlay(this.clicks.length ? this.dynPoint(c.p, anchor) : c.p, c);
    this.showCoords(c.p, this.clicks.length ? anchor : null);
    return true;
  }

  /**
   * Acquisition as in AutoCAD: resting the cursor ~½ s on a point marks it for tracking and
   * extension (resting again removes it); resting on a line during a command takes its direction
   * for parallel snap.
   */
  trackHover(sn, raw) {
    const cfg = this.snapCfg;
    if (!cfg.on) return;
    const pointKinds = new Set(["e", "m", "c", "x", "q", "ax", "a"]);
    let key = null;
    let act = null;
    if (sn && pointKinds.has(sn.kind) && (cfg.tracking || cfg.modes.includes("ext"))) {
      key = `p${sn.p[0].toFixed(2)},${sn.p[1].toFixed(2)}`;
      const p = [...sn.p];
      act = () => this.toggleAcq(p);
    } else if (this.clicks.length && cfg.modes.includes("par") && (!sn || sn.kind === "n" || sn.kind === "p")) {
      const u = (this.hidden.has("orig") ? this.noSnapper : this.snapper).dirUnder(raw[0], raw[1], 10 / this.view.zoom, this._extra || {});
      if (u) {
        key = `s${u.seg.slice(0, 4).join(",")}`;
        act = () => {
          this.parDir = u.dir;
          this.parSeg = u.seg.slice(0, 4);
        };
      }
    }
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    clearTimeout(this.hoverTimer);
    if (act) {
      this.hoverTimer = setTimeout(() => {
        if (this.hoverKey !== key) return;
        act();
        this.view.redraw();
      }, 450);
    }
  }

  toggleAcq(p) {
    const i = this.acq.findIndex((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < 0.01);
    if (i >= 0) this.acq.splice(i, 1);
    else {
      const sp = this.hidden.has("orig") ? this.noSnapper : this.snapper;
      this.acq.push({ p, dirs: sp.dirsAt(p, this._extra || {}) });
      if (this.acq.length > 7) this.acq.shift();
    }
  }

  clearAcq() {
    this.acq = [];
    this.parDir = null;
    this.parSeg = null;
    this.hoverKey = null;
    clearTimeout(this.hoverTimer);
  }

  saveSnapCfg() {
    try {
      localStorage.setItem("cotare.snap", JSON.stringify(this.snapCfg));
    } catch (_) { /* not remembered */ }
    this.syncSnapUi();
  }

  syncSnapUi() {
    const c = this.snapCfg;
    $("stSnap").checked = c.on;
    $("stOrtho").checked = c.ortho;
    $("stPolar").checked = c.polar;
    $("stTrack").checked = c.tracking;
    $("stPolarInc").value = String(c.polarInc);
    const m = $("snapMenu");
    if (m) m.querySelectorAll("[data-mode]").forEach((cb) => { cb.checked = c.modes.includes(cb.dataset.mode); });
  }

  bindSnapUi() {
    const c = this.snapCfg;
    $("snapMenu").innerHTML = `<div class="h">Moduri de snap</div>
      ${MODES.map((m) => `<label class="chk"><input type="checkbox" data-mode="${m.id}"> ${m.name}</label>`).join("")}
      <div class="row"><button class="ghost" data-all="1">Toate</button><button class="ghost" data-all="0">Niciunul</button></div>
      <label class="chk wide"><input type="checkbox" id="snScan" ${c.scan ? "checked" : ""}> Snap și pe scanări (pagina se vectorizează pe server; prima dată durează)</label>
      <div class="h">Polar</div>
      <label class="fld">Unghiuri suplimentare (°, despărțite prin ; ) <input type="text" id="snPolarExtra" class="mono" placeholder="ex.: 7; 22,5" value="${esc((c.polarExtra || []).join("; "))}"></label>
      <label class="chk wide"><input type="checkbox" id="snPolarRel" ${c.polarRel ? "checked" : ""}> Unghiuri față de ultimul segment</label>
      <label class="chk wide"><input type="checkbox" id="snTrackPolar" ${c.trackPolar ? "checked" : ""}> Urmărirea și pe unghiurile polare (nu doar orizontal / vertical)</label>
      <label class="fld">Pas pe direcția polară (mm reali, 0 = fără) <input type="text" id="snPolarStep" class="mono" value="${esc(String(c.polarStep || 0))}"></label>
      <div class="sub">Urmărire: oprește cursorul o clipă pe un punct (apare o cruciuliță verde), apoi mișcă-te pe orizontală, verticală sau în prelungirea liniei. Încă o oprire pe punct îl scoate.<br>Paralel: în timpul unei comenzi, oprește-te pe o linie, apoi mișcă-te aproape paralel cu ea.<br>F3 snap · F8 ortho · F10 polar · F11 urmărire · Alt = fără snap</div>`;
    $("snapMenu").querySelectorAll("[data-mode]").forEach((cb) => cb.addEventListener("change", () => {
      const set = new Set(c.modes);
      if (cb.checked) set.add(cb.dataset.mode);
      else set.delete(cb.dataset.mode);
      c.modes = MODES.map((m) => m.id).filter((id) => set.has(id));
      this.saveSnapCfg();
    }));
    $("snPolarExtra").addEventListener("change", (e) => {
      c.polarExtra = e.target.value.replace(/,\s+/g, ";").split(/[;\s]+/).map((x) => parseFloat(x.replace(",", "."))).filter((v) => Number.isFinite(v) && Math.abs(v) <= 360).slice(0, 12);
      e.target.value = c.polarExtra.join("; ");
      this.saveSnapCfg();
    });
    $("snPolarRel").addEventListener("change", (e) => { c.polarRel = e.target.checked; this.saveSnapCfg(); });
    $("snTrackPolar").addEventListener("change", (e) => { c.trackPolar = e.target.checked; this.saveSnapCfg(); });
    $("snScan").addEventListener("change", (e) => {
      c.scan = e.target.checked;
      this.saveSnapCfg();
      if (c.scan) this.loadScanSnap();
      else if (this.isScanPage()) this.snapper = new Snapper(); // back to the page's own (empty) geometry
    });
    $("snPolarStep").addEventListener("change", (e) => {
      const v = parseFloat(String(e.target.value).replace(",", "."));
      c.polarStep = Number.isFinite(v) && v > 0 ? v : 0;
      e.target.value = String(c.polarStep);
      this.saveSnapCfg();
    });
    $("snapMenu").querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => {
      c.modes = b.dataset.all === "1" ? MODES.map((m) => m.id) : [];
      this.saveSnapCfg();
    }));
    $("stSnapMenu").addEventListener("click", (e) => {
      e.stopPropagation();
      $("snapMenu").hidden = !$("snapMenu").hidden;
    });
    document.addEventListener("pointerdown", (e) => {
      if (!$("snapMenu").hidden && !e.target.closest(".snapctl")) $("snapMenu").hidden = true;
    });
    $("stSnap").addEventListener("change", () => { c.on = $("stSnap").checked; this.clearAcq(); this.saveSnapCfg(); });
    $("stTrack").addEventListener("change", () => { c.tracking = $("stTrack").checked; this.saveSnapCfg(); });
    // ortho and polar exclude each other, as in AutoCAD
    $("stOrtho").addEventListener("change", () => { c.ortho = $("stOrtho").checked; if (c.ortho) c.polar = false; this.saveSnapCfg(); });
    $("stPolar").addEventListener("change", () => { c.polar = $("stPolar").checked; if (c.polar) c.ortho = false; this.saveSnapCfg(); });
    $("stPolarInc").addEventListener("change", () => { c.polarInc = Number($("stPolarInc").value); c.polar = true; c.ortho = false; this.saveSnapCfg(); });
    this.syncSnapUi();
  }

  bindCanvas() {
    const cv = $("canvas");
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      if (e.ctrlKey || !e.shiftKey) this.view.zoomAt(Math.exp(-e.deltaY * 0.0015), sx, sy);
      else this.view.pan(-e.deltaY, 0);
    }, { passive: false });

    cv.addEventListener("pointerdown", (e) => {
      this.frame = (this.frame || 0) + 1;
      this.hideGripMenu();
      if (!this.doc) return;
      // tool keys must not end up in a panel field that is still focused
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      if (this.mmenu) {
        // radial menu open: a click outside closes it
        this.closeMarkingMenu();
        return;
      }
      // two fingers: pan + zoom; drop whatever the first finger started
      if (e.pointerType === "touch") {
        this.touches.set(e.pointerId, [sx, sy]);
        if (this.touches.size === 2) {
          clearTimeout(this.pressTimer);
          this.drag = { kind: "pinch", ...this.pinchState() };
          return;
        }
        if (this.touches.size > 2) return;
      }
      if (e.button === 2) {
        // right click: short = Esc / done, held = radial menu, dragged = pan the sheet
        this.drag = { kind: "rclick", sx, sy, x0: sx, y0: sy };
        clearTimeout(this.pressTimer);
        this.pressTimer = setTimeout(() => {
          if (this.drag && this.drag.kind === "rclick") {
            this.drag = { kind: "mmenu" };
            this.openMarkingMenu(sx, sy);
          }
        }, 350);
        e.preventDefault();
        return;
      }
      if (e.pointerType === "touch" && e.button === 0) {
        // long press with a finger: the radial menu
        clearTimeout(this.pressTimer);
        this.pressStart = [sx, sy];
        this.pressTimer = setTimeout(() => {
          if (this.touches.size !== 1 || !this.pressStart) return;
          this.drag = { kind: "mmenu", touch: true };
          this.view.overlay = null;
          this.openMarkingMenu(...this.pressStart);
        }, 550);
      }
      if (e.button === 1 || this.space || this.tool === "pan") {
        if (this.space) this.spaceDragged = true;
        this.drag = { kind: "pan", sx, sy };
        cv.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const t = TOOL_BY_ID[this.tool];
      if (this.hotGrip) {
        const base = this.hotGrip.base;
        const { pt } = this.snapPoint(raw, e, base);
        const p = this.dynTool() ? this.dynPoint(pt, base) : pt;
        if (this.dyn) this.dynReset();
        this.applyHotGrip(p);
        return;
      }
      if (t.kind === "select") {
        this.startSelectDrag(raw, sx, sy, e);
        return;
      }
      // inside a drawing or annotation tool the selection's handles are not active (as grips in a CAD
      // command): the next object often starts right where the last one ends, on its handles
      const anchor = this.pickAnchor();
      if (t.kind === "free") {
        // freehand (the highlighter): the points follow the cursor, without snap
        this.drag = { kind: "free", pts: [raw] };
        return;
      }
      if (t.kind === "rect") {
        if (t.id === "image" && !this.pendingImage) {
          this.startImageTool();
          return;
        }
        const { pt } = this.snapPoint(raw, e, anchor);
        this.drag = { kind: "rect", start: pt };
        return;
      }
      if (e.pointerType === "touch") {
        // on touch screens the point is placed when the finger lifts: you can adjust the position with snap,
        // and a long press opens the menu without leaving a point behind
        this.drag = { kind: "tap" };
        return;
      }
      this.toolClick(this.dynPoint(this.snapPoint(raw, e, anchor).pt, anchor));
    });

    cv.addEventListener("pointermove", (e) => {
      this.frame = (this.frame || 0) + 1;
      if (!this.doc) return;
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      this.lastPt = raw;
      const d = this.drag;
      if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, [sx, sy]);
        if (this.pressStart && Math.hypot(sx - this.pressStart[0], sy - this.pressStart[1]) > 8) {
          clearTimeout(this.pressTimer);
          this.pressStart = null;
        }
      }
      if (d && d.kind === "pinch") {
        if (this.touches.size < 2) return;
        const st = this.pinchState();
        if (st.d0 > 0 && d.d0 > 0) this.view.zoomAt(st.d0 / d.d0, st.cx, st.cy);
        this.view.pan(st.cx - d.cx, st.cy - d.cy);
        Object.assign(d, st);
        return;
      }
      if (d && d.kind === "rclick") {
        if (Math.hypot(sx - d.x0, sy - d.y0) > 5) {
          clearTimeout(this.pressTimer);
          this.drag = { kind: "pan", sx, sy };
          cv.style.cursor = "grabbing";
        }
        return;
      }
      if (d && d.kind === "mmenu") {
        this.hoverMarking(sx, sy);
        return;
      }
      if (d && d.kind === "pan") {
        this.view.pan(sx - d.sx, sy - d.sy);
        d.sx = sx;
        d.sy = sy;
        return;
      }
      if (d && d.kind === "edge") {
        const a = this.annots.find((x) => x.id === d.id);
        const { pt, sn } = this.snapPoint(raw, e, null);
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const b = this.boxOf(a);
        if (d.code.includes("w")) b[0] = pt[0];
        if (d.code.includes("e")) b[2] = pt[0];
        if (d.code.includes("n")) b[1] = pt[1];
        if (d.code.includes("s")) b[3] = pt[1];
        // edge dragged past the opposite one: the box flips, as in Windows
        if (b[0] > b[2]) {
          [b[0], b[2]] = [b[2], b[0]];
          d.code = d.code.replace(/[we]/, (c) => (c === "w" ? "e" : "w"));
        }
        if (b[1] > b[3]) {
          [b[1], b[3]] = [b[3], b[1]];
          d.code = d.code.replace(/[ns]/, (c) => (c === "n" ? "s" : "n"));
        }
        this.setBox(a, b);
        cv.style.cursor = this.edgeCursor(d.code);
        const ks = this.settings.scale || 1;
        this.dragTip = sn ? null : { p: pt, txt: `${fmtNum(((b[2] - b[0]) / K) * ks, ",", 1)} × ${fmtNum(((b[3] - b[1]) / K) * ks, ",", 1)} mm` };
        this.view.overlay = { snap: sn };
        this.view.redraw();
        this.showCoords(pt);
        return;
      }
      if (d && d.kind === "handle") {
        // a click without moving makes the grip hot (see pointerup); small jitter is not a drag
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
        d.moved = true;
        const { pt, sn } = this.snapPoint(raw, e, d.anchor);
        this.trackHover(sn, raw);
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const a = this.annots.find((x) => x.id === d.id);
        setHandle(a, d.k, d.k === "tx" ? raw : pt, this.builtOf(a));
        this.frame++;
        this.view.overlay = { snap: d.k === "tx" ? null : sn };
        cv.style.cursor = "grabbing";
        const bm = this.builtOf(a);
        const val = bm && bm.measured != null ? ` · ${fmtNum(bm.measured, ",", 2)}${bm.unit === "°" ? "°" : " mm"}` : "";
        this.dragTip = sn ? null : { p: pt, txt: `${d.label || "Modifică"}${val}` };
        this.view.redraw();
        this.showCoords(pt);
        return;
      }
      if (d && d.kind === "scale") {
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const a = this.annots.find((x) => x.id === d.id);
        const k = d.s0 * (Math.hypot(raw[0] - d.anchor[0], raw[1] - d.anchor[1]) / d.d0);
        a.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, k)) * 20) / 20;
        this.setHint(`Mărime ${Math.round(a.scale * 100)}% · eliberează pentru a fixa`);
        cv.style.cursor = d.cursor || "nwse-resize";
        this.dragTip = { p: raw, txt: `Mărime ${Math.round(a.scale * 100)}%` };
        this.view.redraw();
        return;
      }
      if (d && d.kind === "move") {
        const dx = raw[0] - d.last[0];
        const dy = raw[1] - d.last[1];
        if (!d.pushed) {
          if (Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
          this.pushHistory();
          d.pushed = true;
        }
        for (const a of this.annots) if (d.ids.includes(a.id)) moveAnnot(a, dx, dy);
        d.last = raw;
        cv.style.cursor = "grabbing";
        const k = this.settings.scale || 1;
        this.dragTip = { p: raw, txt: `Mută${d.ids.length > 1 ? ` ${d.ids.length} adnotări` : ""}: Δx ${fmtNum(((raw[0] - d.start[0]) / K) * k, ",", 2)} · Δy ${fmtNum(((d.start[1] - raw[1]) / K) * k, ",", 2)} mm` };
        this.view.redraw();
        return;
      }
      if (d && d.kind === "marquee") {
        const force = this.selPrompt && this.selPrompt.force;
        const crossing = force ? force === "c" : raw[0] < d.start[0];
        this.view.overlay = { rect: [d.start[0], d.start[1], raw[0], raw[1]], rectColor: crossing ? COLORS.selCrossing : COLORS.selWindow };
        this.view.redraw();
        return;
      }
      const t = TOOL_BY_ID[this.tool];
      if (this.selPrompt && this.selPrompt.fence && this.selPrompt.fence.length) {
        this.drawFence(raw);
        return;
      }
      if (this.hotGrip && !d) {
        const base = this.hotGrip.base;
        const { pt, sn } = this.snapPoint(raw, e, base);
        this.trackHover(sn, raw);
        this._dynPt = pt;
        this._dynSn = sn;
        // a length or angle typed at the cursor is locked: the preview follows it
        const dt = this.dynTool();
        const p2 = dt ? this.dynPoint(pt, base) : pt;
        this.previewHotGrip(p2, sn);
        this.showCoords(p2, base);
        this.renderDyn(p2, dt ? base : null);
        return;
      }
      if (t.kind === "select" || t.kind === "pan") {
        this.showCoords(raw);
        if (t.kind === "select" && !d) {
          // what a click would grab: handle, edge or annotation, with the matching cursor and label
          const hv = e.pointerType === "touch" ? null : this.hoverAt(sx, sy, raw, false);
          cv.style.cursor = hv ? hv.cursor : "default";
          this.setHover(hv, raw);
          this.gripMenuHover(hv, sx, sy);
        }
        return;
      }
      if (!d && !this.clicks.length) {
        // inside a tool the selection's handles are not grabbed (see pointerdown): the cursor says so
        if (this.hover) this.setHover(null, raw);
        cv.style.cursor = "crosshair";
      }
      if (d && d.kind === "free") {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(raw[0] - last[0], raw[1] - last[1]) * this.view.zoom >= 2) d.pts.push(raw);
        const pts = e.shiftKey ? [d.pts[0], raw] : d.pts;
        const pv = t.make(pts, this);
        this.view.overlay = { prims: build({ ...pv, id: "_pv" }, this.S(), this.measure).prims };
        this.view.redraw();
        return;
      }
      const anchor = d && d.kind === "rect" ? d.start : this.pickAnchor();
      const { pt: spt, sn } = this.snapPoint(raw, e, anchor);
      this.trackHover(sn, raw);
      this._dynPt = spt;
      this._dynSn = sn;
      // typed values (dynamic input) fix the point: the cursor only picks what you did not type
      const pt = d && d.kind === "rect" ? spt : this.dynPoint(spt, anchor);
      this.showCoords(pt, anchor);
      if (d && d.kind === "rect") {
        const im = t.id === "image" && this.pendingImage;
        const rr = im ? imageRect(d.start, pt, im.w, im.h, e.shiftKey) : [d.start[0], d.start[1], pt[0], pt[1]];
        this.view.overlay = { rect: rr, rectColor: t.id === "redact" ? COLORS.edred : COLORS.sel, snap: sn };
        this.view.redraw();
        return;
      }
      this.updateOverlay(pt, sn);
      this.renderDyn(pt, anchor);
    });

    const up = (e) => {
      this.dragTip = null;
      if (e.pointerType === "touch") {
        this.touches.delete(e.pointerId);
        clearTimeout(this.pressTimer);
        this.pressStart = null;
      }
      const d = this.drag;
      if (d && d.kind === "pinch") {
        // second finger lifted: the gesture ends, no click
        if (this.touches.size === 0) this.drag = null;
        return;
      }
      this.drag = null;
      if (!d) return;
      if (d.kind === "rclick") {
        clearTimeout(this.pressTimer);
        this.escape(true);
        return;
      }
      if (d.kind === "tap") {
        const [ux, uy] = pos(e);
        const raw = this.view.toPage(ux, uy);
        const an = this.pickAnchor();
        this.toolClick(this.dynPoint(this.snapPoint(raw, e, an).pt, an));
        return;
      }
      if (d.kind === "mmenu") {
        const m = this.mmenu;
        if (m && m.hi >= 0) this.runMarking(m.hi);
        return; // no direction: the menu stays open for a click
      }
      if (d.kind === "pan") {
        $("canvas").style.cursor = this.tool === "pan" ? "grab" : this.tool === "select" ? "default" : "crosshair";
        return;
      }
      if (d.kind === "edge") {
        this.view.overlay = null;
        if (d.pushed) {
          this.panel.render();
          this.changed();
        }
        return;
      }
      if (d.kind === "handle" && !d.moved && d.k !== "tx") {
        this.startHotGrip(d);
        return;
      }
      if (d.kind === "handle" || d.kind === "move" || d.kind === "scale") {
        if (d.kind === "scale") this.setHint(TOOL_BY_ID[this.tool].hint);
        this.view.overlay = null;
        if (d.pushed) {
          this.panel.render();
          this.changed();
        }
        return;
      }
      if (d.kind === "marquee") {
        const [sx2, sy2] = pos(e);
        const end = this.view.toPage(sx2, sy2);
        this.view.overlay = null;
        const x0 = Math.min(d.start[0], end[0]);
        const x1 = Math.max(d.start[0], end[0]);
        const y0 = Math.min(d.start[1], end[1]);
        const y1 = Math.max(d.start[1], end[1]);
        if ((x1 - x0) * this.view.zoom < 4 && (y1 - y0) * this.view.zoom < 4) {
          if (this.pickAdd()) this.view.redraw(); // a click on nothing keeps the selection
          else if (!d.add) this.select(null);
          else this.view.redraw();
          return;
        }
        // left→right: only what is fully inside the rectangle; right→left: everything it touches
        // (W / C at the Select objects prompt force one of them for the next rectangle)
        const force = this.selPrompt && this.selPrompt.force;
        const crossing = force ? force === "c" : end[0] < d.start[0];
        if (force) this.selPrompt.force = null;
        const ids = [];
        for (const { a, built } of this.visibleBuilt()) {
          const b = built.bbox;
          if (!b) continue;
          const inside = b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1;
          const touch = !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1);
          if (crossing ? touch : inside) ids.push(a.id);
        }
        if (this.pickAdd()) this.setSelection(windowSelection(this.sel, ids, { shift: d.add || !!(this.selPrompt && this.selPrompt.remove), pickadd: true }));
        else this.selectMany(ids, d.add);
        return;
      }
      if (d.kind === "rect") {
        const [sx, sy] = pos(e);
        const raw = this.view.toPage(sx, sy);
        const { pt } = this.snapPoint(raw, e, d.start);
        this.view.overlay = null;
        this.view.redraw();
        this.commitRect([d.start[0], d.start[1], pt[0], pt[1]], e);
      }
      if (d.kind === "free") {
        const [sx, sy] = pos(e);
        const end = this.view.toPage(sx, sy);
        this.view.overlay = null;
        let pts = e.shiftKey ? [d.pts[0], end] : [...d.pts, end];
        // a click without moving: a short stroke, so the mark is visible
        if (pts.length < 2 || Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1) pts = [pts[0], [pts[0][0] + 3 * K, pts[0][1]]];
        pts = simplifyPath(pts, 0.25 * K).map((q) => [round2(q[0]), round2(q[1])]);
        this.addAnnot(finalize(TOOL_BY_ID[this.tool].make(pts, this)));
      }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    // double click on an annotation: the cursor goes straight to the first editable field in the panel
    cv.addEventListener("dblclick", (e) => {
      if (this.tool !== "select") return;
      const [sx, sy] = pos(e);
      const a = this.annotAt(this.view.toPage(sx, sy));
      if (!a) return;
      this.select(a.id);
      if (this.compact()) this.setPanelOpen(true);
      const f = $("panel").querySelector("textarea, input[type=text]:not(#dScale)");
      if (f) {
        f.focus();
        if (f.select) f.select();
      }
    });
    // the browser context menu does not appear over the drawing; not even when the right click is
    // released over the radial menu (on Windows the event comes when the button is released)
    $("viewport").addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("contextmenu", (e) => {
      if (this.mmenu || this.mmenuClosedAt > performance.now() - 400) e.preventDefault();
    });
    cv.addEventListener("pointerleave", (e) => {
      // towards the grip menu: it stays; anywhere else it goes
      if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#gripMenu"))) this.hideGripMenu();
      if (this.hover) this.setHover(null, null);
      if (!this.drag && this.view.overlay && this.view.overlay.snap) {
        this.view.overlay.snap = null;
        this.view.redraw();
      }
    });
  }

  /** Editable rectangle of a box (cover, removal, blackening, struck dimension, drawn rectangle). */
  boxOf(a) {
    let r = null;
    if (a.r && ["white", "redact", "ink", "strike", "image", "cloud"].includes(a.type)) r = a.r;
    else if (a.type === "shape" && a.kind === "rect" && a.pts && a.pts.length >= 2) r = [...a.pts[0], ...a.pts[1]];
    if (!r) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }

  /** Box edge or corner under the cursor (like Windows windows). */
  edgeAt(sx, sy, touch) {
    const tol = touch ? 12 : 6;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) {
      const { a } = items[i];
      const b = this.boxOf(a);
      if (!b) continue;
      const [X0, Y0] = this.view.toScreen([b[0], b[1]]);
      const [X1, Y1] = this.view.toScreen([b[2], b[3]]);
      if (sx < X0 - tol || sx > X1 + tol || sy < Y0 - tol || sy > Y1 + tol) continue;
      let code = "";
      if (Math.abs(sy - Y0) <= tol) code += "n";
      else if (Math.abs(sy - Y1) <= tol) code += "s";
      if (Math.abs(sx - X0) <= tol) code += "w";
      else if (Math.abs(sx - X1) <= tol) code += "e";
      if (code) return { a, code };
    }
    return null;
  }

  edgeCursor(code) {
    return { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" }[code] || "default";
  }

  setBox(a, b) {
    if (a.type === "shape") a.pts = [[b[0], b[1]], [b[2], b[3]]];
    else a.r = b;
  }

  startSelectDrag(raw, sx, sy, e) {
    const v = this.view;
    const hv = this.hover;
    this.hover = null;
    this.hoverKey2 = "";
    const sp = this.selPrompt;
    if (sp && sp.fence) {
      // F (Fence): the clicks draw the line; Enter selects what it crosses
      sp.fence.push(raw);
      this.drawFence(raw);
      return;
    }
    if (!sp && e.shiftKey) {
      // as in AutoCAD: Shift+click on grips makes several hot; a click on one of them then stretches all
      const hg = this.handleAt(sx, sy, e.pointerType === "touch");
      if (hg && hg.h.k !== "sc" && hg.h.k !== "tx") {
        const key = gripKey(hg.a.id, hg.h.k);
        if (!this.hotSet) this.hotSet = new Map();
        if (this.hotSet.has(key)) this.hotSet.delete(key);
        else this.hotSet.set(key, { id: hg.a.id, k: hg.h.k, p: [...hg.h.p] });
        if (!this.hotSet.size) this.hotSet = null;
        this.view.redraw();
        return;
      }
    }
    if (!sp && !e.shiftKey && this.tryHandleDrag(sx, sy, false, e.pointerType === "touch")) return;
    if (this.hotSet) {
      // a click elsewhere drops the grips picked with Shift
      this.hotSet = null;
      this.view.redraw();
    }
    const edge = !sp && !e.shiftKey && this.edgeAt(sx, sy, e.pointerType === "touch");
    if (edge) {
      if (!this.sel.has(edge.a.id)) this.select(edge.a.id);
      this.drag = { kind: "edge", id: edge.a.id, code: edge.code };
      return;
    }
    const tol = 5 / v.zoom;
    const all = this.visibleBuilt();
    // Tab (selection cycling) chose an annotation under the cursor: the click takes that one
    const cycled = !sp && hv && hv.kind === "body" && this.hoverCycle && this.hoverCycle.i > 0 ? all.find((x) => x.a.id === hv.a.id) : null;
    const items = cycled ? [...all, cycled] : all;
    for (let i = items.length - 1; i >= 0; i--) {
      const { a, built } = items[i];
      if (hit(built, a, raw, tol)) {
        if (this.pickAdd()) {
          this.setSelection(clickSelection(this.sel, a.id, { shift: e.shiftKey || !!(this.selPrompt && this.selPrompt.remove), pickadd: true }));
          if (e.shiftKey || this.selPrompt) return;
          this.drag = { kind: "move", ids: [...this.sel], last: raw, start: raw, sx, sy };
          return;
        }
        if (e.shiftKey) {
          this.toggleSelect(a.id);
          return;
        }
        if (!this.sel.has(a.id)) this.select(a.id);
        this.drag = { kind: "move", ids: [...this.sel], last: raw, start: raw, sx, sy };
        return;
      }
    }
    // empty area: selection rectangle
    this.drag = { kind: "marquee", start: raw, add: e.shiftKey };
  }
}
