// Context bar above the drawing: tool options and selection actions.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { build, K, fmtNum, scaleAnchor, typeName } from "../annots.js";
import { TOOL_BY_ID, DRAW_TOOLS, FAMILY_OF } from "../tools.js";
import * as dlg from "../dialogs.js";
import { PRESETS as LINE_PRESETS } from "../shapes.js";
import { tr } from "../i18n.js";
import { esc, $, GRIP_LIMIT, gripKey } from "./util.js";

// the tools whose new dimensions take the default tolerance, and the defaults offered
const TOL_DEF_TOOLS = new Set(["dimLin", "dimAli", "dimDia", "dimDiaC", "dimRad", "dimCont", "dimBase"]);
const TOL_PM = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
const TOL_FITS = ["H7", "H8", "H11", "h6", "h7", "h9", "g6", "k6", "p6"];

export class ContextBar {
  // ------------------------------------------------------------ context bar (UI-D2, UI-D10)
  /**
   * The strip above the drawing: the active tool with its hint and the options of its prompt, or, with a
   * selection, what is selected and the actions that fit it. Its place never changes, only its content.
   */
  renderCtx() {
    const box = $("ctxTool");
    if (!box) return;
    if (!this.doc) {
      box.innerHTML = "";
      return;
    }
    const ico = (d, cls = "ti") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    const sel = this.tool === "select" && !this.cmdActive() ? this.selectedAll().filter((a) => a.page === this.page) : [];
    let html;
    if (sel.length) {
      const one = sel.length === 1 ? sel[0] : null;
      const acts = [];
      if (one && one.type === "dim" && one.kind === "lin") acts.push(["dco", "Cote în lanț de aici", "DCO"], ["dba", "Față de bază de aici", "DBA"]);
      acts.push(["move", "Mută", "M"], ["copy", "Copiază", "CO"], ["zoom", "Zoom la selecție", ""], ["del", "Șterge", "E"]);
      html = `${ico(TOOL_BY_ID.select.icon)}<b>${one ? esc(tr(typeName(one))) : `${sel.length} adnotări selectate`}</b><span class="vs"></span>${acts.map(([k, l, al]) => `<button class="ca${k === "del" ? " dng" : ""}" data-ctx="${k}">${l}${al ? `<i>${al}</i>` : ""}</button>`).join("")}`;
    } else if (this.compare && this.compare.page === this.page && this.tool === "select" && !this.cmdActive()) {
      const c = this.compare;
      const n = c.regions.length;
      html = `${ico("M4 5h7v14H4zM13 5h7v14h-7z")}<b>Comparare</b><span class="cmpleg"><i class="old"></i>${esc(c.otherName)}<i class="new"></i>${esc(tr("revizia deschisă"))}</span><span class="vs"></span>
        ${c.oldImg ? `<span class="seg cmpmode">${[["overlay", "Suprapus"], ["side", "Alăturat"], ["swipe", "Cortină"]].map(([m, l]) => `<button data-cmpmode="${m}" class="${c.mode === m ? "on" : ""}" aria-pressed="${c.mode === m}">${esc(tr(l))}</button>`).join("")}</span><span class="vs"></span>` : ""}
        ${c.mode === "side" ? "" : c.mode === "swipe"
          ? `<label class="cdef" title="${esc(tr("Unde e linia: în stânga ei revizia veche, în dreapta cea deschisă; o poți trage și pe desen"))}">${esc(tr("Linie"))}<input type="range" id="cmpSplit" min="0" max="100" value="${Math.round(c.split * 100)}"></label>`
          : `<label class="cdef" title="Cât de tare se vede comparația peste pagină">${esc(tr("Suprapunere"))}<input type="range" id="cmpAlpha" min="0" max="100" value="${Math.round(c.alpha * 100)}"></label>`}
        <span class="vs"></span><button class="ca" data-cmp="prev" ${n ? "" : "disabled"} aria-label="${esc(tr("Zona anterioară"))}">◀</button><span class="mono cmpn">${n ? `${c.idx + 1 > 0 ? c.idx + 1 : "–"}/${n}` : "0"}</span><button class="ca" data-cmp="next" ${n ? "" : "disabled"} aria-label="${esc(tr("Zona următoare"))}">▶</button>
        <button class="ca" data-cmp="pdf">PDF</button><button class="ca" data-cmp="close" title="${esc(tr("Închide comparația"))}">${esc(tr("Închide"))}</button>`;
    } else {
      const t = TOOL_BY_ID[this.tool];
      if (!t) return;
      // the tool's defaults (UI-D2); the options of the current step stay in the command line
      let defs = "";
      if (DRAW_TOOLS.has(t.id) && t.id !== "cross" && t.id !== "hatch") {
        const ds = this.drawStyle;
        const cur = LINE_PRESETS.find((p) => p.ltype === ds.ltype && Math.abs(p.w - ds.w) < 1e-6);
        defs = `<label class="cdef">Linie<select id="ctxLine" title="Tipul și grosimea liniilor noi (ISO 128-24)">${cur ? "" : `<option selected>${esc(tr("Personalizată"))}</option>`}${LINE_PRESETS.map((p) => `<option value="${p.id}" ${cur && cur.id === p.id ? "selected" : ""}>${esc(tr(p.name))} · ${fmtNum(p.w, this.settings.sep || ",", 2)}</option>`).join("")}</select></label>`;
      } else if (FAMILY_OF[t.id] === "dims" || FAMILY_OF[t.id] === "tol" || FAMILY_OF[t.id] === "notes") {
        const h = this.settings.textH || 3.5;
        const hs = [2.5, 3.5, 5, 7];
        defs = `<label class="cdef">Text<select id="ctxTextH" class="num" title="Înălțimea textului pe desen, pentru tot documentul">${hs.includes(h) ? "" : `<option selected>${fmtNum(h, ",", 2)} mm</option>`}${hs.map((v) => `<option value="${v}" ${v === h ? "selected" : ""}>${fmtNum(v, ",", 1)} mm</option>`).join("")}</select></label>`;
        if (TOL_DEF_TOOLS.has(t.id)) defs += this.tolDefHtml();
      }
      html = `${ico(t.icon)}<b>${esc(tr(t.label))}</b><span class="ch" id="ctxHint" title="${esc(this.hintText || "")}">${esc(this.hintText || "")}</span>${defs ? `<span class="vs"></span>${defs}` : ""}`;
    }
    if (box._html === html) return;
    box._html = html;
    box.innerHTML = html;
    box.querySelectorAll("[data-ctx]").forEach((b) => b.addEventListener("click", () => this.ctxAction(b.dataset.ctx)));
    box.querySelectorAll("[data-cmp]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.cmp;
      if (k === "prev") this.stepCompare(-1);
      else if (k === "next") this.stepCompare(1);
      else if (k === "pdf") this.exportCompare();
      else this.endCompare();
    }));
    box.querySelectorAll("[data-cmpmode]").forEach((b) => b.addEventListener("click", () => this.setCompareMode(b.dataset.cmpmode)));
    const cs = box.querySelector("#cmpSplit");
    if (cs) cs.addEventListener("input", () => {
      this.compare.split = Number(cs.value) / 100;
      this.view.redraw();
    });
    const ca = box.querySelector("#cmpAlpha");
    if (ca) ca.addEventListener("input", () => {
      this.compare.alpha = Number(ca.value) / 100;
      this.view.redraw();
    });
    const ln = box.querySelector("#ctxLine");
    if (ln) ln.addEventListener("change", () => {
      const p = LINE_PRESETS.find((x) => x.id === ln.value);
      if (p) this.setDrawStyle({ ltype: p.ltype, w: p.w });
      this.panel.render();
    });
    const th = box.querySelector("#ctxTextH");
    if (th) th.addEventListener("change", () => this.setSettings({ textH: parseFloat(th.value) }));
    const td = box.querySelector("#ctxTol");
    if (td) td.addEventListener("change", () => {
      const [mode, v] = td.value.split(":");
      this.setSettings({ tolDef: mode === "pm" ? { mode, pm: parseFloat(v) } : mode === "iso" ? { mode, fit: v } : { mode: "none" } });
    });
  }

  /** The tolerance new dimensions get (UI-D2): none, ± a value or an ISO 286 fit, for the whole document. */
  tolDefHtml() {
    const sep = this.settings.sep || ",";
    const t = this.settings.tolDef || { mode: "none" };
    const cur = t.mode === "pm" ? `pm:${t.pm}` : t.mode === "iso" ? `iso:${t.fit}` : "none";
    const opts = [["none", tr("Fără")], ...TOL_PM.map((v) => [`pm:${v}`, `±${fmtNum(v, sep, 2)}`]), ...TOL_FITS.map((f) => [`iso:${f}`, f])];
    const known = opts.some(([v]) => v === cur);
    const extra = known ? "" : `<option value="${esc(cur)}" selected>${esc(t.mode === "pm" ? `±${fmtNum(t.pm, sep, 3)}` : t.fit || "")}</option>`;
    return `<label class="cdef">Toleranță<select id="ctxTol" class="num" title="Toleranța cotelor noi, pentru tot documentul (fără: se aplică toleranța generală)">${extra}${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  }

  ctxAction(k) {
    const one = this.selected();
    if (k === "move" || k === "copy") this.moveCmd(k === "move" ? "moveSel" : "copySel");
    else if (k === "zoom") this.zoomSelection();
    else if (k === "del") this.deleteSelected();
    else if ((k === "dco" || k === "dba") && one && one.type === "dim") {
      const d = one;
      this.setTool(k === "dco" ? "dimCont" : "dimBase");
      this.seriesFrom(d);
    }
  }

  /** At most this many selected annotations show grips. */
  get gripLimit() {
    return GRIP_LIMIT;
  }

  /** The selected annotations that show grips: all of them up to GRIP_LIMIT (none beyond, as in AutoCAD). */
  gripOwners() {
    if (!this.sel.size || this.sel.size > GRIP_LIMIT) return [];
    return this.selectedAll().filter((a) => a.page === this.page && !this.hidden.has(this.layerOf(a)));
  }

  /** A grip of annotation a; with several annotations selected the resize corners are left out. */
  gripsOf(a, multi = this.sel.size > 1) {
    const hs = this.builtOf(a).handles || [];
    return multi ? hs.filter((h) => h.k !== "sc") : hs;
  }

  /** The grip of the selected annotations closest to the cursor (screen pixels), or null. */
  handleAt(sx, sy, touch = false) {
    const r = touch ? 16 : 10;
    let best = null;
    let bd = r;
    for (const sel of this.gripOwners()) {
      for (const h of this.gripsOf(sel)) {
        if (!h.p) continue;
        const [hx, hy] = this.view.toScreen(h.p);
        // on a tie, the annotation's points win over the resize corners
        const d = Math.hypot(hx - sx, hy - sy) + (h.k === "sc" ? 1.5 : 0);
        if (d <= bd) {
          bd = d;
          best = { a: sel, h };
        }
      }
    }
    return best;
  }

  /** Is this grip hot (red): picked with Shift, or part of the hot grip in progress? */
  isHotGrip(id, k) {
    if (this.hotSet && this.hotSet.has(gripKey(id, k))) return true;
    return !!(this.hotGrip && this.hotGrip.grips.some((x) => x.id === id && x.k === k));
  }

  /** What a handle does, in words (hover tooltip). */
  handleLabel(a, k) {
    if (k === "sc") return "Mărește / micșorează";
    if (k === "tx") return "Mută textul cotei";
    if (k === "elbow") return "Cotul liniei — frânge linia";
    if (k === "target") return "Vârful pe piesă";
    if (k === "pos" || (k === "p" && ["text", "note", "revtab", "bom", "holes"].includes(a.type))) return "Mută";
    if (k === "vp") return "Partea spre care privești";
    if (k === "tp") return "Mută litera";
    if (k === "lp") return "Valoarea nouă — mut-o";
    if (k === "r0" || k === "r1") return "Colț — redimensionează";
    if (k === "p3") return a.type === "ang" ? "Poziția arcului (alege unghiul)" : "Poziția liniei de cotă";
    if (k === "c") return "Centrul";
    if (k === "v") return "Vârful unghiului";
    if (k === "p1" || k === "p2") return "Punct de cotă — trage pe alt punct";
    if (k === "p" && a.type === "rad") return "Punct pe arc";
    if (k.startsWith("pts.")) return a.type === "shape" && (a.kind === "circle" || a.kind === "cross") && k === "pts.0" ? "Centrul" : "Punct — trage (cu snap)";
    return "Trage pentru a modifica";
  }

  handleCursor(a, h) {
    if (h.k === "sc") {
      const an = scaleAnchor(a);
      return (h.p[0] - an[0]) * (h.p[1] - an[1]) >= 0 ? "nwse-resize" : "nesw-resize";
    }
    if (h.k === "pos" || h.k === "tp" || h.k === "lp" || (h.k === "p" && ["text", "note", "revtab", "bom", "holes"].includes(a.type))) return "move";
    return "grab";
  }

  /**
   * A click on the handles of the selected annotation edits it. With another tool active only the
   * resize handles count: endpoints must stay free for chained dimensions from the same point.
   */
  /**
   * A click on a grip of a selected annotation edits it. With another tool active only the
   * resize handle counts: endpoints must stay free for chained dimensions from the same point.
   */
  tryHandleDrag(sx, sy, onlyScale = false, touch = false) {
    const hit0 = this.handleAt(sx, sy, touch);
    if (!hit0) return false;
    const { a: sel, h } = hit0;
    if (h.k === "sc") {
      const an = scaleAnchor(sel);
      this.drag = { kind: "scale", id: sel.id, anchor: an, d0: Math.max(1e-3, Math.hypot(h.p[0] - an[0], h.p[1] - an[1])), s0: sel.scale || 1, cursor: this.handleCursor(sel, h) };
      return true;
    }
    if (onlyScale) return false;
    this.drag = { kind: "handle", id: sel.id, k: h.k, p: h.p, sx, sy, label: this.handleLabel(sel, h.k), anchor: h.k === "p2" ? sel.p1 : h.k === "p1" ? sel.p2 : h.k === "elbow" ? sel.target : null };
    return true;
  }

  /** What is under the cursor in Select mode: handle, box edge or annotation. */
  hoverAt(sx, sy, raw, touch) {
    const h = this.handleAt(sx, sy, touch);
    if (h) return { kind: "handle", a: h.a, h: h.h, cursor: this.handleCursor(h.a, h.h), label: this.handleLabel(h.a, h.h.k) };
    const edge = this.edgeAt(sx, sy, touch);
    if (edge) return { kind: "edge", a: edge.a, cursor: this.edgeCursor(edge.code), label: edge.code.length === 2 ? "Colț — redimensionează" : "Margine — redimensionează" };
    const all = this.annotsAt(raw);
    if (!all.length) {
      this.hoverCycle = null;
      return null;
    }
    // selection cycling: with annotations on top of each other Tab picks which one a click takes
    const key = all.map((x) => x.id).join(",");
    if (!this.hoverCycle || this.hoverCycle.key !== key) this.hoverCycle = { key, i: 0, n: all.length };
    const a = all[this.hoverCycle.i % all.length];
    const cyc = all.length > 1 ? ` · ${this.hoverCycle.i + 1}/${all.length} — Tab: următorul` : "";
    return { kind: "body", a, cursor: "move", label: `${typeName(a)}${this.sel.has(a.id) ? " — trage pentru a muta" : " — click pentru a selecta, trage pentru a muta"}${cyc}` };
  }

  /** Tab over annotations on top of each other: the next one becomes the one a click takes. */
  cycleHover() {
    const hc = this.hoverCycle;
    const hv = this.hover;
    if (!hc || hc.n < 2 || !hv || hv.kind !== "body" || !this.hoverPt) return false;
    hc.i = (hc.i + 1) % hc.n;
    const [sx, sy] = this.view.toScreen(this.hoverPt);
    this.hoverKey2 = "";
    this.setHover(this.hoverAt(sx, sy, this.hoverPt, false), this.hoverPt);
    return true;
  }

  setHover(hv, raw) {
    const key = hv ? `${hv.kind}:${hv.a.id}:${hv.h ? hv.h.k + hv.h.p.join(",") : ""}` : "";
    this.hoverPt = raw;
    if (key === this.hoverKey2) {
      if (hv) this.view.redraw(); // the label follows the cursor
      return;
    }
    this.hoverKey2 = key;
    this.hover = hv;
    this.view.redraw();
  }

  updateOverlay(pt, sn) {
    const t = TOOL_BY_ID[this.tool];
    if (this.placing) this._ordPt = pt;
    let prims = null;
    if (this.clicks.length && t.preview) {
      const pv = t.preview(this.clicks, pt, this);
      if (pv && (pv.line || pv.lines)) {
        prims = (pv.lines || [pv.line]).map((l) => ({ t: "L", p: [...l[0], ...l[1]], w: 0.6, c: "preview", dash: true }));
      }
      else if (Array.isArray(pv)) prims = pv.flatMap((x) => build({ ...x, layer: "add" }, this.S(), this.measure).prims);
      else if (pv) prims = build({ ...pv, layer: "add" }, this.S(), this.measure).prims;
    }
    if (!prims && t.id === "measure" && this.lastMeasure) prims = this.lastMeasure;
    this.view.overlay = { prims, snap: sn };
    this.view.redraw();
    const t2 = TOOL_BY_ID[this.tool];
    if (this.clicks.length) {
      if (this.placing) this.setHint(t2.placeHint);
      else if (t2.kind === "poly") this.setHint(`${t2.hint} · ${this.clicks.length} puncte`);
      else if (t2.id === "measure" && this.cmdState.area) this.setHint(`Arie: ${this.clicks.length} puncte · click pe primul punct, C sau Enter închide conturul · Esc renunță`);
      else if (t2.chain) this.setHint(t2.hint);
      else this.setHint(`${t2.hint} · pas ${this.clicks.length + 1}/${t2.n} · Esc renunță`);
    }
  }

  showMeasure(p, q) {
    const k = this.settings.scale || 1;
    const dx = ((q[0] - p[0]) / K) * k;
    const dy = ((q[1] - p[1]) / K) * k;
    const L = Math.hypot(dx, dy);
    const ang = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 180;
    const f = (v) => fmtNum(v, ",", 3);
    // the measured line stays visible until the next measurement
    this.lastMeasure = [{ t: "L", p: [...p, ...q], w: 0.6, c: "sel" }, { t: "C", p: [...p], r: 1.2, w: 0.6, c: "sel" }, { t: "C", p: [...q], r: 1.2, w: 0.6, c: "sel" }];
    this.view.overlay = { prims: this.lastMeasure };
    this.view.redraw();
    dlg.toast(`L = ${f(L)} mm · Δx ${f(Math.abs(dx))} · Δy ${f(Math.abs(dy))} · ${fmtNum(ang, ",", 2)}°${Math.abs(k - 1) > 1e-9 ? ` (scara ${this.scaleLabel()})` : ""}`, 8000);
  }

  /** DIST, option Multiple: a chain of distances and their total, until Enter / Esc. */
  measureChain(p, q) {
    const k = this.settings.scale || 1;
    const st = this.cmdState;
    st.total = (st.total || 0) + (Math.hypot(q[0] - p[0], q[1] - p[1]) / K) * k;
    st.n = (st.n || 0) + 1;
    st.prims = [...(st.prims || []), { t: "L", p: [...p, ...q], w: 0.6, c: "sel" }, { t: "C", p: [...q], r: 1.2, w: 0.6, c: "sel" }];
    this.lastMeasure = st.prims;
    this.clicks = [q];
    this.lastPick = q;
    this.view.overlay = { prims: st.prims };
    this.view.redraw();
    dlg.toast(`Total = ${fmtNum(st.total, ",", 3)} mm (${st.n} ${st.n === 1 ? "segment" : "segmente"})${Math.abs(k - 1) > 1e-9 ? ` · scara ${this.scaleLabel()}` : ""}`, 8000);
  }
}
