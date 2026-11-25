// Grips: the grip menu and hot grips (stretch, move, rotate, scale, mirror).
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { build, setHandle, moveAnnot, K, fmtNum, newId } from "../annots.js";
import { LABELS } from "../osnap.js";
import { TOOL_BY_ID, promptFor, resolveOption } from "../tools.js";
import { parsePoint, resolvePoint } from "../pointin.js";
import * as dlg from "../dialogs.js";
import { keyConfig } from "../commands.js";
import { rotateAbout, scaleAbout, mirrorAbout } from "../pages.js";
import { hasVertices, addVertex, removeVertex } from "../shapes.js";
import { startI18n, tr } from "../i18n.js";
import { esc, $, gripKey } from "./util.js";

export class Grips {
  // ------------------------------------------------------------ grip menu (CMD-D14)
  /** Resting on a grip for a moment opens its menu (AutoCAD's multifunctional grips). */
  gripMenuHover(hv, sx, sy) {
    const m = this.gripMenu;
    const on = hv && hv.kind === "handle" && hv.h.k !== "sc" && hv.h.k !== "tx" && !this.hotGrip && !this.drag;
    if (m && m.shown) {
      // it stays while the cursor is near its grip (on the way to the menu)
      if (Math.hypot(sx - m.sx, sy - m.sy) > 40) this.hideGripMenu();
      return;
    }
    const key = on ? `${hv.a.id}:${hv.h.k}` : "";
    if (m && m.key === key) return;
    this.hideGripMenu();
    if (!on) return;
    const [gx, gy] = this.view.toScreen(hv.h.p);
    const g = { key, id: hv.a.id, k: hv.h.k, p: [...hv.h.p], sx: gx, sy: gy, shown: false };
    g.timer = setTimeout(() => this.showGripMenu(g), 600);
    this.gripMenu = g;
  }

  hideGripMenu() {
    const m = this.gripMenu;
    if (!m) return;
    clearTimeout(m.timer);
    this.gripMenu = null;
    const el = $("gripMenu");
    if (el) el.hidden = true;
  }

  /** The items of a grip's menu: the hot-grip modes, and vertices for polylines and hatches. */
  gripMenuItems(a, k) {
    const items = [
      { id: "stretch", label: "Întindere" },
      { id: "move", label: "Mutare" },
      { id: "rotate", label: "Rotire" },
      { id: "scale", label: "Scalare" },
      { id: "mirror", label: "Oglindire" },
    ];
    if (hasVertices(a) && k.startsWith("pts.")) {
      items.push({ id: "addVertex", label: "Adaugă vârf", sep: true });
      const tmp = { ...a, pts: [...a.pts] };
      if (removeVertex(tmp, Number(k.slice(4)))) items.push({ id: "removeVertex", label: "Șterge vârful" });
    }
    return items;
  }

  showGripMenu(g) {
    const a = this.annots.find((x) => x.id === g.id);
    if (!a || this.gripMenu !== g) return;
    let el = $("gripMenu");
    if (!el) {
      el = document.createElement("div");
      el.id = "gripMenu";
      el.className = "gripmenu";
      el.setAttribute("translate", "no");
      $("viewport").appendChild(el);
      el.addEventListener("pointerleave", (e) => {
        if (!(e.relatedTarget && e.relatedTarget === this.view.canvas)) this.hideGripMenu();
      });
      el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-gm]");
        if (b) this.runGripMenu(b.dataset.gm);
      });
    }
    el.innerHTML = this.gripMenuItems(a, g.k).map((it) => `<button type="button" data-gm="${it.id}"${it.sep ? ' class="sep"' : ""}>${esc(tr(it.label))}</button>`).join("");
    const vp = $("viewport");
    el.hidden = false;
    const w = el.offsetWidth || 140;
    const h = el.offsetHeight || 160;
    el.style.left = `${Math.max(4, Math.min(g.sx + 12, vp.clientWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(g.sy + 12, vp.clientHeight - h - 4))}px`;
    g.shown = true;
    this.view.redraw(); // the hover label would sit under the menu
  }

  runGripMenu(id) {
    const g = this.gripMenu;
    this.hideGripMenu();
    if (!g) return;
    const a = this.annots.find((x) => x.id === g.id);
    if (!a) return;
    if (id === "addVertex" || id === "removeVertex") {
      const i = Number(g.k.slice(4));
      this.pushHistory();
      if (id === "removeVertex") {
        removeVertex(a, i);
        this.frame++;
        this.changed();
        return;
      }
      // as in AutoCAD: the new vertex follows the cursor until it is placed
      const j = addVertex(a, i);
      this.frame++;
      this.changed();
      if (j >= 0) this.startHotGrip({ id: a.id, k: `pts.${j}`, p: [...a.pts[j]] });
      return;
    }
    this.startHotGrip({ id: g.id, k: g.k, p: g.p });
    const hg = this.hotGrip;
    if (hg && id !== "stretch") {
      hg.mode = id;
      if (id === "scale") hg.ref = 10 * K;
      this.logCmd(`  ** ${this.hotGripName()} **`);
      this.updateCmdPrompt();
    }
  }

  // ------------------------------------------------------------ hot grips (CMD-D14)
  /** A click on a grip (without dragging): the grip becomes hot, as in AutoCAD. */
  startHotGrip(d) {
    const a = this.annots.find((x) => x.id === d.id);
    if (!a) return;
    // Shift+click made other grips hot first: Stretch moves all of them with the clicked one
    const picked = this.hotSet && this.hotSet.has(gripKey(d.id, d.k)) ? [...this.hotSet.values()] : [];
    const grips = [{ id: d.id, k: d.k, p: [...d.p] }, ...picked.filter((x) => !(x.id === d.id && x.k === d.k))].filter((x) => this.annots.some((b) => b.id === x.id));
    this.hotSet = null;
    this.hotGrip = { id: d.id, k: d.k, grips, base: [...d.p], ids: [...this.sel], mode: "stretch", copy: false, pickBase: false, ref: 10 * K };
    this.logCmd(grips.length > 1 ? `** GRIP ** (${grips.length})` : "** GRIP **");
    this.updateCmdPrompt();
    this.view.redraw();
  }

  endHotGrip() {
    this.hotGrip = null;
    this.hotSet = null;
    if (this.dyn) this.dynReset();
    this.view.overlay = null;
    this.dragTip = null;
    this.updateCmdPrompt();
    this.renderDyn(null, null);
    this.view.redraw();
  }

  /** Space / Enter: the next grip mode. */
  cycleHotGrip() {
    const g = this.hotGrip;
    const order = ["stretch", "move", "rotate", "scale", "mirror"];
    g.mode = order[(order.indexOf(g.mode) + 1) % order.length];
    if (this.dyn) this.dynReset();
    if (g.mode === "scale") {
      // the cursor's distance from the base when SCALE starts is factor 1
      const c = this.lastPt || g.base;
      g.ref = Math.max(10 * K, Math.hypot(c[0] - g.base[0], c[1] - g.base[1]));
    }
    this.logCmd(`  ** ${this.hotGripName()} **`);
    this.updateCmdPrompt();
    if (this._dynPt) this.previewHotGrip(this._dynPt, null);
  }

  hotGripName() {
    return { stretch: "ÎNTINDE", move: "MUTĂ", rotate: "ROTEȘTE", scale: "SCALEAZĂ", mirror: "OGLINDEȘTE" }[this.hotGrip.mode];
  }

  hotGripPrompt() {
    const g = this.hotGrip;
    const what = g.pickBase ? "punctul de bază" : { stretch: "punctul nou", move: "unde se mută", rotate: "unghiul (sfert de tură) sau scrie gradele", scale: "factorul (cursorul sau scrie-l)", mirror: "a doua axă a oglinzii (orizontală sau verticală)" }[g.mode];
    const opts = g.mode === "stretch" ? [] : [
      { key: "B", label: "Punct de bază", en: ["BASE"], run: (app) => { app.hotGrip.pickBase = true; } },
      { key: "C", label: g.copy ? "Copiere (pornită)" : "Copiere", en: ["COPY"], run: (app) => { app.hotGrip.copy = !app.hotGrip.copy; } },
    ];
    opts.push({ key: "X", label: "Ieși", en: ["EXIT"], run: (app) => app.endHotGrip() });
    return { text: `** ${this.hotGripName()} ** ${what} · Space = modul următor`, opts };
  }

  /** The annotations as the grip mode would leave them, for the point pt (or a typed value). */
  hotGripResult(pt, value = null) {
    const g = this.hotGrip;
    const ids = g.mode === "stretch" ? [...new Set(g.grips.map((x) => x.id))] : g.ids;
    const src = ids.map((id) => this.annots.find((a) => a.id === id)).filter(Boolean);
    const out = src.map((a) => JSON.parse(JSON.stringify(a)));
    const b = g.base;
    let info = "";
    if (g.mode === "stretch") {
      // every hot grip moves by the same displacement as the picked one
      const dx = pt[0] - b[0];
      const dy = pt[1] - b[1];
      const S = this.S();
      for (const x of g.grips) {
        const c = out[ids.indexOf(x.id)];
        if (c) setHandle(c, x.k, [x.p[0] + dx, x.p[1] + dy], build(c, S, this.measure));
      }
    } else if (g.mode === "move") {
      for (const c of out) moveAnnot(c, pt[0] - b[0], pt[1] - b[1]);
    } else if (g.mode === "rotate") {
      const ang = value != null ? value : (Math.atan2(-(pt[1] - b[1]), pt[0] - b[0]) * 180) / Math.PI;
      const q = ((Math.round(ang / 90) % 4) + 4) % 4; // quarter turns, counter-clockwise
      const cw = (360 - q * 90) % 360;
      for (const c of out) rotateAbout(c, cw, b, this.S(), this.measure);
      info = `${q * 90}°`;
    } else if (g.mode === "scale") {
      const k = value != null ? value : Math.hypot(pt[0] - b[0], pt[1] - b[1]) / g.ref;
      const kk = Math.max(0.05, Math.min(20, Math.round(k * 100) / 100));
      for (const c of out) scaleAbout(c, kk, b);
      info = `× ${fmtNum(kk, ",", 2)}`;
    } else if (g.mode === "mirror") {
      const axis = Math.abs(pt[0] - b[0]) >= Math.abs(pt[1] - b[1]) ? "h" : "v";
      for (const c of out) mirrorAbout(c, axis, b, this.S(), this.measure);
      info = axis === "h" ? "axă orizontală" : "axă verticală";
    }
    return { out, info };
  }

  previewHotGrip(pt, sn) {
    const g = this.hotGrip;
    if (g.pickBase) {
      this.view.overlay = { snap: sn };
      this.view.redraw();
      return;
    }
    const { out, info } = this.hotGripResult(pt);
    const S = this.S();
    const prims = out.flatMap((c) => build({ ...c, layer: "add" }, S, this.measure).prims);
    prims.push({ t: "L", p: [...g.base, ...pt], w: 0.6, c: "preview", dash: true });
    this.view.overlay = { prims, snap: sn };
    this.dragTip = sn ? null : { p: pt, txt: `${this.hotGripName()}${info ? ` · ${info}` : ""}${g.copy ? " · copie" : ""}` };
    this.view.redraw();
  }

  /** A click (or a typed point / value) with a hot grip. */
  applyHotGrip(pt, value = null) {
    const g = this.hotGrip;
    if (g.pickBase && pt) {
      g.base = pt;
      g.pickBase = false;
      this.updateCmdPrompt();
      return;
    }
    if (!pt && value == null) return;
    const { out } = this.hotGripResult(pt || g.base, value);
    if (!out.length) {
      this.endHotGrip();
      return;
    }
    this.pushHistory();
    if (g.copy && g.mode !== "stretch") {
      for (const c of out) c.id = newId();
      this.annots.push(...out);
    } else {
      const byId = new Map(out.map((c) => [c.id, c]));
      this.annots = this.annots.map((a) => byId.get(a.id) || a);
    }
    this.frame++;
    this.changed();
    // with Copy the grip stays hot for more copies; otherwise it is done
    if (!(g.copy && g.mode !== "stretch")) this.endHotGrip();
    else if (this._dynPt) this.previewHotGrip(this._dynPt, null);
  }

  /** DCO / DBA, option S: the next click picks the linear dimension to continue. */
  pickSeriesDim() {
    this.pointMod = { kind: "pickDim" };
  }

  /** A point typed in the command line: false if it is not a point (then it may be a command). */
  typedPoint(text) {
    const g = this.hotGrip;
    if (g && (g.mode === "rotate" || g.mode === "scale") && /^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(String(text).trim())) {
      // ROTATE: the angle (degrees, counter-clockwise); SCALE: the factor
      const v = parseFloat(String(text).trim().replace(",", "."));
      this.logCmd(`  ${String(text).trim()}`);
      if (g.mode === "rotate" && Math.abs(v / 90 - Math.round(v / 90)) > 1e-9) {
        // the annotations turn only in quarter turns (texts and symbols stay readable)
        this.logCmd("  Doar multipli de 90°");
        return true;
      }
      if (g.mode === "scale" && !(v > 0)) {
        this.logCmd("  Factorul trebuie să fie pozitiv");
        return true;
      }
      this.applyHotGrip(null, v);
      return true;
    }
    const q = parsePoint(text);
    if (!q) return false;
    const r = resolvePoint(q, { last: this.lastPoint(), cursor: this._dynPt || null, origin: this.originOf(), scale: this.settings.scale });
    this.logCmd(`  ${String(text).trim()}${r.error ? ` — ${r.error}` : ""}`);
    if (r.error) {
      dlg.toast(r.error);
      return true;
    }
    this.pointInput(r.p);
    return true;
  }

  /** A typed point, used as a click of the running tool. */
  pointInput(p) {
    if (this.hotGrip) {
      this.applyHotGrip(p);
      return;
    }
    const t = TOOL_BY_ID[this.tool];
    if (!t || !this.cmdActive()) return;
    if (this.dyn) this.dynReset();
    if (t.kind === "rect") {
      if (!this.rectStart) {
        this.rectStart = p;
        this.lastPick = p;
        this.snapOverride = null;
        this.view.overlay = { prims: [{ t: "C", p: [...p], r: 1.2, w: 0.6, c: "sel" }] };
        this.view.redraw();
        this.setHint(`${t.hint} · colțul opus: @lățime,înălțime sau click`);
        return;
      }
      const r = [...this.rectStart, ...p];
      this.rectStart = null;
      this.view.overlay = null;
      this.setHint(t.hint);
      this.commitRect(r);
      return;
    }
    this.toolClick(p);
    this.updateCmdPrompt();
  }

  /** The prompt of the running command, with its options as buttons (CMD-D5). */
  updateCmdPrompt() {
    this.renderCtx();
    const inp = $("cmdIn");
    const box = $("cmdPrompt");
    if (!inp || !this.keyCfg) return;
    if (this.cmdAsk) {
      inp.placeholder = "valoare, apoi Enter (Esc renunță)";
      if (box) {
        box.innerHTML = `<b>${esc(this.cmdAsk.text)}:</b>`;
        box.hidden = false;
      }
      return;
    }
    if (this.selPrompt) {
      inp.placeholder = "W · C · F · WP · CP · ALL · L · P · R · A";
      if (box) {
        const sp = this.selPrompt;
        const n = this.sel.size;
        const what = { erase: "Șterge adnotările", moveSel: "Mută obiectele", copySel: "Copiază obiectele" }[sp.cmd] || "";
        const then = sp.fence ? "Enter închide linia" : sp.cmd === "erase" ? "Enter șterge" : "Enter continuă";
        const state = sp.fence ? (sp.fenceMode === "f" ? "linie de selecție: click-uri" : "poligon: click-uri") : sp.force === "w" ? "fereastră" : sp.force === "c" ? "traversare" : sp.remove ? "scoate din selecție" : "";
        const opts = [["W", "Fereastră"], ["C", "Traversare"], ["F", "Linie"], ["WP", "Poligon"], ["CP", "Poligon traversare"], ["ALL", "Tot"], ["L", "Ultimul"], ["P", "Anterior"], sp.remove ? ["A", "Adaugă"] : ["R", "Scoate"]]
          .map(([k, l]) => `<button type="button" data-selopt="${k}" title="${esc(l)} (${k})">${esc(l)} <i>${k}</i></button>`).join("");
        box.innerHTML = `<b>${what} — selectează obiectele (${n} ${n === 1 ? "selectat" : "selectate"})${state ? ` · ${state}` : ""} · ${then}, Esc renunță</b> <span class="cmdopts">${opts}</span>`;
        box.hidden = false;
        box.querySelectorAll("[data-selopt]").forEach((b) => b.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.selPromptOption(b.dataset.selopt);
        }));
      }
      return;
    }
    if (!this.cmdActive()) {
      inp.placeholder = this.keyCfg.mode === "autocad" ? "Comandă (L, C, PL, DLI…)" : "Enter → comandă (L, C, DLI…)";
      if (box) box.hidden = true;
      return;
    }
    inp.placeholder = "x,y · @dx,dy · @d<unghi · opțiune";
    const pr = this.currentPrompt();
    if (!box) return;
    const opts = pr.opts.map((o) => `<button type="button" data-opt="${o.key}" title="${esc(o.label)} (${o.key})">${esc(o.label)} <i>${o.key}</i></button>`).join("");
    box.innerHTML = `<b>${esc(pr.text)}</b>${opts ? ` <span class="cmdopts">${opts}</span>` : ""}`;
    box.hidden = false;
    box.querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.runOption(b.dataset.opt);
    }));
  }

  /** Prompt text and options of the running command (command line and cursor). */
  currentPrompt() {
    if (this.hotGrip) return this.hotGripPrompt();
    const pr = promptFor(TOOL_BY_ID[this.tool], this);
    const pm = this.pointMod;
    if (pm && pm.kind === "from") pr.text = pm.base ? "FROM — deplasarea față de bază (@dx,dy sau @d<unghi)" : "FROM — punctul de bază";
    if (pm && pm.kind === "m2p") pr.text = pm.a ? "M2P — al doilea punct" : "M2P — primul punct";
    if (pm && pm.kind === "pickDim") pr.text = "Alege cota liniară de la care continui";
    if (pm && pm.kind === "fx") pr.text = pm.first ? ".X — punctul care dă Y" : ".X — punctul care dă X";
    if (pm && pm.kind === "fy") pr.text = pm.first ? ".Y — punctul care dă X" : ".Y — punctul care dă Y";
    if (pm && pm.kind === "tk") pr.text = pm.pts.length ? "TK — punctul următor (orizontal sau vertical; Enter încheie urmărirea)" : "TK — primul punct de urmărire";
    if (pm) pr.opts = [];
    if (this.snapOverride) pr.text += this.snapOverride === "none" ? " · fără snap" : ` · snap: ${LABELS[this.snapOverride === "node" ? "a" : this.snapOverride]}`;
    return pr;
  }

  /** The options of the running command, available now. */
  currentOptions() {
    return this.cmdActive() && !this.cmdAsk ? this.currentPrompt().opts : [];
  }

  /** Runs an option of the running command (typed or clicked). */
  runOption(keyOrText) {
    const o = resolveOption(this.currentOptions(), keyOrText);
    if (!o) return false;
    this.logCmd(`  [${o.key}] ${o.label}`);
    o.run(this);
    this.frame++;
    if (this._dynPt) this.updateOverlay(this._dynPt, null);
    this.updateCmdPrompt();
    this.renderDyn(this._dynPt, this.clicks[this.clicks.length - 1]);
    return true;
  }

  /** An option that needs a value: the next Enter in the command line answers it. */
  askValue(text, onValue) {
    this.cmdAsk = { text, onValue };
    this.updateCmdPrompt();
    this.focusCmdLine("");
    return true;
  }

  /** U while drawing: the last point (or the last segment of a line chain) goes away. */
  undoStep() {
    const t = TOOL_BY_ID[this.tool];
    if (t && t.chain && this.chain && this.chain.ids.length) {
      const id = this.chain.ids.pop();
      const a = this.annots.find((x) => x.id === id);
      this.pushHistory();
      this.annots = this.annots.filter((x) => x.id !== id);
      this.sel.delete(id);
      if (this.selectedId === id) this.selectedId = null;
      this.clicks = a && a.pts ? [a.pts[0]] : [];
      this.changed();
      if (!this.chain.ids.length && !this.clicks.length) this.chain = null;
    } else if (this.placing) {
      this.placing = false;
    } else if (this.clicks.length) {
      this.clicks.pop();
      if (t && t.chain && !this.clicks.length) this.chain = null;
    } else {
      dlg.toast("Nimic de anulat în comanda curentă");
    }
    if (this._dynPt && this.clicks.length) this.updateOverlay(this._dynPt, null);
    else {
      this.view.overlay = null;
      this.view.redraw();
    }
  }

  /** C: closes a line chain or a polyline. */
  closeStep() {
    const t = TOOL_BY_ID[this.tool];
    if (t && t.kind === "poly") {
      if (this.clicks.length >= 3) this.finishPoly(true);
      return;
    }
    if (t && t.chain && this.chain && this.clicks.length) {
      const first = this.chain.first;
      this.toolClick(first);
      this.chain = null;
      this.clicks = [];
      this.view.overlay = null;
      this.view.redraw();
    }
  }

  /** CIRCLE, option Diameter: a typed diameter in real mm. */
  circleByDiameter(d) {
    if (!(d > 0) || !this.clicks.length) return false;
    const c = this.clicks[0];
    const k = Number(this.settings.scale) || 1;
    this.toolClick([c[0] + (d / 2 / k) * K, c[1]]);
    return true;
  }

  /** RECTANG, option Dimensions: length and width in real mm, towards the cursor's quadrant. */
  rectBySize(w, h) {
    if (!(Math.abs(w) > 0) || !(Math.abs(h) > 0) || !this.clicks.length) return false;
    const c = this.clicks[0];
    const cur = this._dynPt || [c[0] + 1, c[1] - 1];
    const k = Number(this.settings.scale) || 1;
    const sx = cur[0] >= c[0] ? 1 : -1;
    const sy = cur[1] <= c[1] ? 1 : -1; // up on the sheet = Y up
    this.toolClick([c[0] + sx * (Math.abs(w) / k) * K, c[1] - sy * (Math.abs(h) / k) * K]);
    return true;
  }

  /** UCS, option World: the origin goes back to the bottom-left corner of the page. */
  ucsWorld() {
    const had = this.annots.some((a) => a.type === "ucs" && a.page === this.page);
    if (had) {
      this.pushHistory();
      this.annots = this.annots.filter((a) => !(a.type === "ucs" && a.page === this.page));
      this.changed();
    }
    dlg.toast("Originea coordonatelor: colțul stânga-jos al paginii");
    this.setTool("select");
  }

  /** Session log for the history window (F2). */
  logCmd(text) {
    if (!this.cmdLog) this.cmdLog = [];
    this.cmdLog.push({ t: new Date(), text });
    if (this.cmdLog.length > 500) this.cmdLog.shift();
  }

  /** Finishes the polyline or hatch in progress. */
  finishPoly(close) {
    const t = TOOL_BY_ID[this.tool];
    const at = this.cmdState && this.cmdState.seriesAt;
    if (t.place && !at && this.clicks.length >= (t.min || 2)) {
      // the points are picked: now the cursor places the row, the next click sets it
      this.placing = true;
      this.setHint(t.placeHint);
      this.updateOverlay(this._dynPt || this.lastPt || this.clicks[this.clicks.length - 1], null);
      return;
    }
    const pts = this.clicks;
    this.clicks = [];
    this.view.overlay = null;
    this.setHint(t.hint);
    this.clearAcq();
    if (pts.length >= (t.min || 2)) this.addMade(t.make(pts, this, close || t.closed, at || undefined));
    else this.view.redraw();
  }

  pollOcrLang(tries = 20) {
    setTimeout(async () => {
      try {
        const h = await (await fetch("api/health")).json();
        if (h.ocr) this.ocrLang = h.ocr;
        else if (h.ocrPending && tries > 1) this.pollOcrLang(tries - 1);
      } catch (_) {
        if (tries > 1) this.pollOcrLang(tries - 1);
      }
    }, 3000);
  }

  async init() {
    startI18n(); // in English, texts are translated as the interface is built
    await document.fonts.load("16px osifont").catch(() => {});
    try {
      const h = await (await fetch("api/health")).json();
      this.retentionDays = h.retentionDays;
      this.mode = h.mode || "personal";
      this.ocrLang = h.ocr || null;
      this.desktop = !!h.desktop;
      this.version = h.version || "";
      // on first start Tesseract may answer slowly: the interface starts anyway, OCR shows up later
      if (h.ocrPending) this.pollOcrLang();
    } catch (_) {
      this.retentionDays = 0;
    }
    this.buildToolbar();
    this.bindUi();
    this.bindSnapUi();
    this.bindCanvas();
    this.bindKeys();
    this.bindCmdLine();
    this.applyKeyCfg(keyConfig());
    let dynOn = true;
    try {
      dynOn = localStorage.getItem("drawcad.dyn") !== "0";
    } catch (_) { /* on by default */ }
    this.dyn = { on: dynOn, vals: {}, active: null, text: "" };
    this.panel.render();
    this.refreshRecent();
    this.setTool("select");
    // the desktop app opens a file passed from Explorer ("Open with DrawCAD") as #doc=<id>
    const m = /^#doc=([a-f0-9]{32})$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", location.pathname);
      this.loadDoc(m[1]);
      return;
    }
    const last = localStorage.getItem("cotare.lastDoc");
    if (last) this.loadDoc(last, true);
  }
}
