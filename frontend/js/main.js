// Aplicația: stare, unelte, evenimente, salvare, export.
import * as api from "./api.js";
import { build, derive, hit, setHandle, moveAnnot, annotSnapPoints, exportPrims, K, fmtNum, newId, scaleAnchor, typeName, SCALE_MIN, SCALE_MAX } from "./annots.js";
import { View, COLORS } from "./view.js";
import { Snapper, MODES, DEFAULT_MODES, LABELS } from "./osnap.js";
import { Panel } from "./panel.js";
import { TOOLS, TOOL_BY_ID, finalize } from "./tools.js";
import * as dlg from "./dialogs.js";
import { VIEW_LETTERS } from "./symbols.js";
import { markingConfig, MM_ICONS } from "./mmenu.js";
import { keyConfig, directKeyMap, resolveCommand, suggest, commandList } from "./commands.js";
import { applyPageOp } from "./pages.js";
import { startI18n, lang as uiLang, tr } from "./i18n.js";

const $ = (id) => document.getElementById(id);
/** Hash scurt (FNV-1a) pentru cheile de randare. */
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const DATUM_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"; // ISO 5459: fără I, O, Q

class App {
  constructor() {
    this.doc = null;
    this.page = 0;
    this.annots = [];
    this.settings = dlg.storedDefaults();
    this.selectedId = null;
    this.sel = new Set();
    this.tool = "select";
    this.clicks = [];
    this.undo = [];
    this.redo = [];
    this.cache = new Map();
    this.snapper = new Snapper();
    this.noSnapper = new Snapper();
    this.snapCfg = { modes: [...DEFAULT_MODES], polar: true, polarInc: 15, tracking: true, ortho: false, on: true };
    try {
      Object.assign(this.snapCfg, JSON.parse(localStorage.getItem("cotare.snap") || "{}"));
    } catch (_) { /* implicit */ }
    this.acq = [];
    this.parDir = null;
    this.parSeg = null;
    this.touches = new Map();
    this.mmenu = null;
    this.measureCtx = document.createElement("canvas").getContext("2d");
    this.measureCtx.fontKerning = "none";
    this.mcache = new Map();
    this.measure = (txt, size) => {
      const key = `${size.toFixed(3)}|${txt}`;
      let w = this.mcache.get(key);
      if (w == null) {
        this.measureCtx.font = `${size}px osifont`;
        w = this.measureCtx.measureText(txt).width;
        this.mcache.set(key, w);
      }
      return w;
    };
    this.view = new View($("canvas"), this);
    this.panel = new Panel($("panel"), this);
    this.cursor = null;
    this.drag = null;
    this.space = false;
    this.drawStyle = { ltype: "cont", w: 0.5, lscale: 1 };
    this.hidden = new Set();
    try {
      for (const k of JSON.parse(localStorage.getItem("cotare.hidden") || "[]")) this.hidden.add(k);
    } catch (_) { /* implicit */ }
    try {
      Object.assign(this.drawStyle, JSON.parse(localStorage.getItem("cotare.drawStyle") || "{}"));
    } catch (_) { /* implicit */ }
  }

  setDrawStyle(patch) {
    Object.assign(this.drawStyle, patch);
    try {
      localStorage.setItem("cotare.drawStyle", JSON.stringify(this.drawStyle));
    } catch (_) { /* fără memorare */ }
  }

  /**
   * Esc, Enter cu o comandă în curs sau click dreapta: termină polilinia, oprește lanțul de linii,
   * renunță la punctele date; fără comandă în curs deselectează, apoi revine la Selecție.
   */
  escape() {
    const t = TOOL_BY_ID[this.tool];
    if (this.dyn) this.dynReset();
    const db = $("dynBox");
    if (db) db.hidden = true;
    if (this.clicks.length && t.kind === "poly") {
      this.finishPoly(false);
      return;
    }
    if (this.acq.length || this.parDir) this.clearAcq();
    if (this.clicks.length) {
      this.clicks = [];
      this.view.overlay = null;
      this.setHint(t.hint);
      this.view.redraw();
    } else if (this.selectedId) this.select(null);
    else if (this.tool !== "select") this.setTool("select");
  }

  // ------------------------------------------------------------ meniu radial (ca la Inventor)
  /** Comenzile din meniul radial, în ordinea E, NE, N, NV, V, SV, S, SE (alese din Setări). */
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
    // ține meniul în ecran
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

  /** Cu butonul încă apăsat, direcția față de centru alege comanda (marking menu). */
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

  /** Un click al uneltei active (puncte de cotă, vârfuri de polilinie…). */
  toolClick(pt) {
    const t = TOOL_BY_ID[this.tool];
    if (this.dyn) this.dynReset();
    if (t.kind === "poly") {
      const v = this.view;
      const near = (q) => {
        const [ax, ay] = v.toScreen(q);
        const [bx, by] = v.toScreen(pt);
        return Math.hypot(ax - bx, ay - by);
      };
      const n = this.clicks.length;
      // click pe primul punct: contur închis · al doilea click în același loc (dublu-click): gata
      if (n >= Math.max(3, t.min || 2) && near(this.clicks[0]) < 8) return this.finishPoly(true);
      if (n && near(this.clicks[n - 1]) < 3) return this.finishPoly(false);
      this.clicks.push(pt);
      this.updateOverlay(pt, null);
      return;
    }
    if (t.kind === "clicks") {
      this.clicks.push(pt);
      if (this.clicks.length >= t.n) {
        const pts = this.clicks;
        this.clicks = [];
        this.view.overlay = null;
        if (t.id === "measure") {
          this.showMeasure(pts[0], pts[1]);
          return;
        }
        if (t.id === "calib") {
          const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / K;
          if (d > 0.1) dlg.calibDialog(this, d);
          return;
        }
        this.addAnnot(finalize(t.make(pts, this)));
        if (!t.chain) this.clearAcq();
        if (t.chain) {
          // ca LINE din CAD: următorul segment pornește din capătul celui desenat
          this.clicks = [pts[pts.length - 1]];
          this.updateOverlay(pt, null);
        }
      } else {
        this.updateOverlay(pt, null);
      }
    }
  }

  /** Termină polilinia sau hașura în curs. */
  finishPoly(close) {
    const t = TOOL_BY_ID[this.tool];
    const pts = this.clicks;
    this.clicks = [];
    this.view.overlay = null;
    this.setHint(t.hint);
    this.clearAcq();
    if (pts.length >= (t.min || 2)) this.addAnnot(finalize(t.make(pts, this, close || t.closed)));
    else this.view.redraw();
  }

  async init() {
    startI18n(); // în engleză, textele apar traduse pe măsură ce se construiește interfața
    await document.fonts.load("16px osifont").catch(() => {});
    try {
      const h = await (await fetch("api/health")).json();
      this.retentionDays = h.retentionDays;
      this.mode = h.mode || "personal";
      this.ocrLang = h.ocr || null;
      this.desktop = !!h.desktop;
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
    } catch (_) { /* implicit pornit */ }
    this.dyn = { on: dynOn, vals: {}, active: null, text: "" };
    this.panel.render();
    this.refreshRecent();
    this.setTool("select");
    // aplicația desktop deschide un fișier dat din Explorer („Deschide cu DrawCAD”) ca #doc=<id>
    const m = /^#doc=([a-f0-9]{32})$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", location.pathname);
      this.loadDoc(m[1]);
      return;
    }
    const last = localStorage.getItem("cotare.lastDoc");
    if (last) this.loadDoc(last, true);
  }

  // ------------------------------------------------------------ interfață
  buildToolbar() {
    const groups = [];
    for (const t of TOOLS) {
      let g = groups.find((x) => x.name === t.group);
      if (!g) groups.push((g = { name: t.group, tools: [] }));
      g.tools.push(t);
    }
    let collapsed = new Set();
    try {
      collapsed = new Set(JSON.parse(localStorage.getItem("cotare.toolGroups") || "[]"));
    } catch (_) { /* implicit */ }
    this.collapsedGroups = collapsed;
    $("tools").innerHTML = groups.map((g) => `<button class="grp" data-grp="${g.name}" aria-expanded="${!collapsed.has(g.name)}">
        <span>${g.name}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
      <div class="grid" data-grid="${g.name}" ${collapsed.has(g.name) ? "hidden" : ""}>${g.tools.map((t) => `
      <button class="tool" data-tool="${t.id}" title="${t.label}${t.key ? ` (${t.key})` : ""}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span>${t.label}</span></button>`).join("")}</div>`).join("");
    $("tools").querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => this.setTool(b.dataset.tool)));
    $("tools").querySelectorAll("[data-grp]").forEach((b) => b.addEventListener("click", () => this.toggleGroup(b.dataset.grp)));
  }

  /** Grupurile din bara de unelte se pliază; starea se ține minte în browser. */
  toggleGroup(name, open) {
    const c = this.collapsedGroups;
    const willOpen = open ?? c.has(name);
    if (willOpen) c.delete(name);
    else c.add(name);
    const grid = $("tools").querySelector(`[data-grid="${name}"]`);
    const btn = $("tools").querySelector(`[data-grp="${name}"]`);
    if (grid) grid.hidden = !willOpen;
    if (btn) btn.setAttribute("aria-expanded", String(willOpen));
    try {
      localStorage.setItem("cotare.toolGroups", JSON.stringify([...c]));
    } catch (_) { /* fără memorare */ }
  }

  bindUi() {
    $("btnOpen").addEventListener("click", () => dlg.openDialog(this));
    $("btnOpen2").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => {
      // fișierul vine din dialogul „Deschide desen”: dialogul se închide
      if (e.target.files[0] && dlg.isModalOpen()) dlg.closeModal();
      const f = e.target.files[0];
      e.target.value = "";
      if (f) this.openFile(f, this.pendingDpi);
      this.pendingDpi = null;
    });
    $("btnExport").addEventListener("click", () => this.doc && dlg.exportDialog(this));
    $("btnClose").addEventListener("click", () => this.closeDoc());
    $("btnPanel").addEventListener("click", () => this.setPanelOpen(!$("app").classList.contains("panel-open")));
    $("btnPanelClose").addEventListener("click", () => this.setPanelOpen(false));
    // salvarea în așteptare nu se pierde la închiderea tab-ului
    window.addEventListener("pagehide", () => this.flushSaveBeacon());
    $("btnSettings").addEventListener("click", () => this.doc && dlg.settingsDialog(this));
    $("btnText").addEventListener("click", () => this.doc && dlg.textDialog(this));
    document.querySelectorAll(".langsw [data-uilang]").forEach((b) => {
      b.classList.toggle("on", b.dataset.uilang === uiLang());
      b.addEventListener("click", () => {
        if (b.dataset.uilang === uiLang()) return;
        try {
          localStorage.setItem("drawcad.lang", b.dataset.uilang);
        } catch (_) { /* stocare indisponibilă */ }
        location.reload();
      });
    });
    $("btnUndo").addEventListener("click", () => this.doUndo());
    $("btnRedo").addEventListener("click", () => this.doRedo());
    $("btnZoomIn").addEventListener("click", () => this.view.zoomAt(1.25, this.view.cw / 2, this.view.ch / 2));
    $("btnZoomOut").addEventListener("click", () => this.view.zoomAt(0.8, this.view.cw / 2, this.view.ch / 2));
    $("btnFit").addEventListener("click", () => this.view.fit());
    const vp = $("viewport");
    vp.addEventListener("dragover", (e) => {
      e.preventDefault();
      vp.classList.add("drag");
    });
    vp.addEventListener("dragleave", () => vp.classList.remove("drag"));
    vp.addEventListener("drop", (e) => {
      e.preventDefault();
      vp.classList.remove("drag");
      const f = e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
    this.updateButtons();
  }

  async refreshRecent() {
    try {
      const docs = await api.listDocs();
      $("recentList").innerHTML = dlg.recentHtml(docs, this.retentionDays, this.mode);
      dlg.bindRecent($("recentList"), this);
    } catch (_) { /* fără listă */ }
  }

  updateButtons() {
    const has = !!this.doc;
    $("btnExport").disabled = !has;
    $("btnClose").hidden = !has;
    $("btnSettings").disabled = !has;
    $("btnText").disabled = !has;
    $("btnUndo").disabled = !this.undo.length;
    $("btnRedo").disabled = !this.redo.length;
    $("emptyState").hidden = has;
    $("stScale").textContent = has ? `Scară ${this.scaleLabel()}` : "";
  }

  scaleLabel() {
    const s = this.settings.scale || 1;
    if (Math.abs(s - 1) < 1e-6) return "1:1";
    return s > 1 ? `1:${fmtNum(s, ",", 3)}` : `${fmtNum(1 / s, ",", 3)}:1`;
  }

  onZoom(z) {
    $("zoomLbl").textContent = `${Math.round((z * 100) / (96 / 72))}%`;
  }

  setHint(txt) {
    $("stHint").textContent = txt || "";
    const vh = $("vpHint");
    if (vh) vh.textContent = this.doc && this.tool !== "select" && this.tool !== "pan" ? txt || "" : "";
  }

  compact() {
    return window.matchMedia("(max-width: 1100px)").matches;
  }

  setPanelOpen(open) {
    $("app").classList.toggle("panel-open", open);
    $("btnPanel").setAttribute("aria-expanded", String(open));
  }

  setTool(id) {
    if (!TOOL_BY_ID[id]) return;
    if (id !== "select" && id !== "pan") {
      this.lastTool = id;
      this.lastCmd = id; // Enter / Spațiu (în modul AutoCAD) o repornește
      this.recordCmd(id, this._typedCmd);
      this._typedCmd = null;
    }
    this.tool = id;
    this.clicks = [];
    if (this.dyn) this.dynReset();
    if ($("dynBox")) $("dynBox").hidden = true;
    this.lastMeasure = null;
    this.hover = null;
    this.hoverKey2 = "";
    this.clearAcq();
    const grp = TOOL_BY_ID[id].group;
    if (this.collapsedGroups && this.collapsedGroups.has(grp)) this.toggleGroup(grp, true);
    this.view.overlay = null;
    $("tools").querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === id));
    this.setHint(TOOL_BY_ID[id].hint);
    $("canvas").style.cursor = id === "pan" ? "grab" : id === "select" ? "default" : "crosshair";
    if (!this.selectedId) this.panel.render();
    this.view.redraw();
  }

  // ------------------------------------------------------------ documente
  async openFile(file, dpi) {
    dlg.toast(`Se deschide ${file.name}…`, 15000);
    try {
      const meta = await api.openFile(file, dpi);
      this.setDoc(meta, meta.state);
      const rm = meta.removed || {};
      const names = { javascript: "JavaScript", actiuni: "acțiuni automate", atasamente: "fișiere atașate", adnotari: "adnotări multimedia", xfa: "formular XFA" };
      const rmTxt = Object.entries(rm).map(([k, n]) => `${names[k] || k} (${n})`).join(", ");
      if (rmTxt) dlg.toast(`Deschis: ${meta.name}. Am eliminat din PDF conținutul activ, inutil la un desen: ${rmTxt}.`, 9000);
      else dlg.toast(meta.fromExport ? "Export anterior: cotele au fost reîncărcate editabile." : `Deschis: ${meta.name}`);
    } catch (e) {
      dlg.toast(`Nu s-a putut deschide: ${e.message}`, 6000);
    }
  }

  async loadDoc(id, silent) {
    try {
      const meta = await api.getDoc(id);
      this.setDoc(meta, meta.state);
    } catch (e) {
      if (!silent) dlg.toast(`Documentul nu mai există: ${e.message}`);
      localStorage.removeItem("cotare.lastDoc");
    }
  }

  setDoc(meta, state) {
    this.doc = meta;
    localStorage.setItem("cotare.lastDoc", meta.id);
    this.annots = (state && state.annots) || [];
    this.settings = { ...dlg.storedDefaults(), ...((state && state.settings) || {}) };
    this.ocr = new Map(); // pagină → rezultat OCR (null = nerecunoscută încă)
    this.ocrPages = new Set(meta.ocrPages || []);
    this.hit = null;
    this.undo = [];
    this.redo = [];
    this.cache.clear();
    this.selectedId = null;
    this.sel = new Set();
    this.unexported = false;
    this.setSaveState(state ? "saved" : "");
    $("docName").textContent = meta.name;
    $("docMeta").textContent = `${meta.kind === "image" ? "imagine" : "PDF"} · ${meta.pages.length} ${meta.pages.length === 1 ? "pagină" : "pagini"}`;
    document.title = `${meta.name} — DrawCAD`;
    this.setPage(0);
    this.updateButtons();
  }

  setPage(n) {
    if (!this.doc) return;
    this.page = n;
    this.clicks = [];
    this.selectedId = null;
    this.sel = new Set();
    const p = this.doc.pages[n];
    this.view.setPage(this.doc.id, n, p.w, p.h);
    this.renderTabs();
    this.panel.render();
    this.snapper = new Snapper();
    this.clearAcq();
    api.snap(this.doc.id, n, this.doc.lv || 0).then((s) => {
      if (this.page === n) this.snapper = new Snapper(s);
    }).catch(() => {});
    if (this.showOcr && this.ocrPages.has(n)) this.loadOcr(n).catch(() => {});
  }

  /** Formele desenate se scalează față de primul lor punct (la calibrare, „își păstrează
   *  dimensiunile reale”); cotele nu se ating, ele măsoară desenul. */
  rescaleShapes(f) {
    if (!(f > 0) || Math.abs(f - 1) < 1e-9) return;
    this.pushHistory();
    for (const a of this.annots) {
      if (a.type !== "shape" || !Array.isArray(a.pts) || !a.pts.length) continue;
      const o = a.pts[0];
      a.pts = a.pts.map((p) => [o[0] + (p[0] - o[0]) * f, o[1] + (p[1] - o[1]) * f]);
    }
    this.changed();
  }

  // ------------------------------------------------------------ text și OCR
  /** Textul recunoscut al paginii n (din cache, de pe server, sau — cu run — recunoscut acum). */
  async loadOcr(n, run = false, force = false) {
    if (!run && this.ocr.has(n)) return this.ocr.get(n);
    const r = run ? await api.runOcr(this.doc.id, n, force) : await api.getOcr(this.doc.id, n);
    const v = r.ocr || null;
    this.ocr.set(n, v);
    if (v) this.ocrPages.add(n);
    this.view.redraw();
    return v;
  }

  setShowOcr(on) {
    this.showOcr = !!on;
    if (on && this.ocrPages.has(this.page)) this.loadOcr(this.page).catch(() => {});
    this.view.redraw();
  }

  /** Arată un text găsit: pagina lui, mărit pe el, cu un chenar care se stinge. */
  gotoText(page, box) {
    if (page !== this.page) this.setPage(page);
    const pad = 30;
    this.view.zoomToBox([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], 40);
    this.hit = { page, box, t: Date.now() };
    this.view.redraw();
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      this.hit = null;
      this.view.redraw();
    }, 2600);
  }

  renderTabs() {
    const tabs = this.doc.pages.map((p, i) => `<button class="${i === this.page ? "on" : ""}" data-pg="${i}">Pagina ${i + 1}</button>`).join("");
    const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    const ops = `<span class="pgops">
      <button class="mini" data-pgop="rl" title="Rotește pagina la stânga (ROTL)" aria-label="Rotește pagina la stânga">${ico("M4 4v6h6M4.6 15a8 8 0 1 0 1.9-8.3L4 10")}</button>
      <button class="mini" data-pgop="rr" title="Rotește pagina la dreapta (ROTR)" aria-label="Rotește pagina la dreapta">${ico("M20 4v6h-6M19.4 15a8 8 0 1 1-1.9-8.3L20 10")}</button>
      <button class="mini" data-pgop="dlg" title="Pagini: rotire, ordine, ștergere (PAGES)" aria-label="Pagini">${ico("M5 3h9l5 5v13H5zM14 3v5h5")}</button></span>`;
    $("pageTabs").innerHTML = `${tabs}${ops}<span class="legend">Original: negru · Adăugat: albastru · Revizie: roșu</span>`;
    $("pageTabs").querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => this.setPage(Number(b.dataset.pg))));
    $("pageTabs").querySelectorAll("[data-pgop]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.pgop;
      if (k === "dlg") dlg.pagesDialog(this);
      else this.pageOp({ op: "rotate", pages: [this.page], delta: k === "rr" ? 90 : -90 }).catch((e) => dlg.toast(e.message));
    }));
  }

  /** Rotire / ștergere / mutare de pagini: adnotările (și istoricul de anulare) se transformă odată
   *  cu pagina, iar serverul primește starea nouă împreună cu operația. */
  async pageOp(op) {
    if (!this.doc || this._pageBusy) return;
    const n = this.doc.pages.length;
    const full = { ...op, count: n, sizes: this.doc.pages.map((p) => [p.w, p.h]) };
    const S = this.S();
    const tr = (list) => applyPageOp(list, full, S, this.measure);
    const annots = tr(this.annots);
    this._pageBusy = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      // foaia mărită de k ori: aceeași cotă reală înseamnă de k ori mai mulți mm de hârtie
      let settings = this.settings;
      if (op.op === "scale" && (op.pages == null || n === 1)) settings = { ...settings, scale: (Number(settings.scale) || 1) / op.factor };
      const res = await api.pageOp(this.doc.id, { ...op, state: { ...this.stateJson(), settings, annots } });
      this.annots = annots;
      if (settings !== this.settings) {
        this.settings = settings;
        this._S = null;
      }
      this.undo = this.undo.map((st) => JSON.stringify(tr(JSON.parse(st))));
      this.redo = this.redo.map((st) => JSON.stringify(tr(JSON.parse(st))));
      this.cache.clear();
      this.doc.pages = res.pages;
      this.doc.lv = res.lv;
      this.ocrPages = new Set(res.ocrPages || []);
      this.ocr = new Map();
      let pg = this.page;
      if (op.op === "delete") pg = Math.min(pg - op.pages.filter((d) => d < pg).length, res.pages.length - 1);
      if (op.op === "move") {
        const order = [...Array(n).keys()];
        order.splice(op.to, 0, order.splice(op.page, 1)[0]);
        pg = order.indexOf(this.page);
      }
      this.selectedId = null;
      this.sel = new Set();
      this.unexported = true;
      this.setSaveState("saved");
      $("docMeta").textContent = `${this.doc.kind === "image" ? "imagine" : "PDF"} · ${res.pages.length} ${res.pages.length === 1 ? "pagină" : "pagini"}`;
      this.setPage(Math.max(0, pg));
      this.updateButtons();
    } finally {
      this._pageBusy = false;
    }
  }

  // ------------------------------------------------------------ stare și istoric
  stateJson() {
    return { v: 1, settings: this.settings, annots: this.annots };
  }

  async flushSave() {
    if (!this.doc || !this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await api.saveState(this.doc.id, this.stateJson());
    } catch (e) {
      dlg.toast(`Salvare eșuată: ${e.message}`);
    }
  }

  flushSaveBeacon() {
    if (!this.doc || !this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const blob = new Blob([JSON.stringify(this.stateJson())], { type: "application/json" });
    navigator.sendBeacon(`api/doc/${this.doc.id}/state`, blob);
  }

  markExported() {
    this.unexported = false;
  }

  async closeDoc() {
    if (!this.doc) return;
    await this.flushSave();
    if (this.unexported && this.annots.length) dlg.closeDialog(this);
    else this.doClose();
  }

  doClose() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.doc = null;
    this.annots = [];
    this.selectedId = null;
    this.sel = new Set();
    this.clicks = [];
    this.undo = [];
    this.redo = [];
    this.cache.clear();
    this.unexported = false;
    this.view.overlay = null;
    this.view.clear();
    $("pageTabs").innerHTML = "";
    $("docName").textContent = "Niciun document";
    $("docMeta").textContent = "";
    document.title = "DrawCAD — editor PDF pentru desene tehnice";
    try {
      localStorage.removeItem("cotare.lastDoc");
    } catch (_) { /* stocare indisponibilă */ }
    this.setTool("select");
    this.panel.render();
    this.updateButtons();
    this.refreshRecent();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    const id = this.doc && this.doc.id;
    if (!id) return;
    this.setSaveState("pending");
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.setSaveState("saving");
      api.saveState(id, this.stateJson()).then(() => {
        if (!this.saveTimer) this.setSaveState("saved");
      }).catch((e) => {
        // fără rețea / server oprit: se reîncearcă singur, fără să se piardă nimic din browser
        this.setSaveState("error", e.message);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.doc && this.doc.id === id && this.scheduleSave(), 5000);
      });
    }, 700);
  }

  setSaveState(st, msg) {
    const el = $("saveState");
    if (!el) return;
    const txt = { pending: "Modificat…", saving: "Se salvează…", saved: "Salvat pe server", error: "Nesalvat · reîncerc" }[st] || "";
    el.textContent = txt;
    el.className = `savestate ${st}`;
    el.title = st === "error" ? `Salvarea automată a eșuat (${msg || "eroare"}); se reîncearcă la 5 s.` : st === "saved" ? "Cotele sunt salvate pe server; le regăsești și după închiderea browserului." : "";
  }

  /** Descriere scurtă pentru lista de adnotări. */
  annotLabel(a) {
    const b = this.builtOf(a);
    const first = (t) => String(t || "").split("\n")[0].slice(0, 40);
    switch (a.type) {
      case "dim":
      case "rad":
      case "ang": {
        const nom = a.nominal ?? (b && b.nominal);
        const v = nom != null ? fmtNum(nom, this.settings.sep || ",", 3) : "?";
        const tol = a.tol && a.tol.mode === "iso" ? ` ${a.tol.fit || ""}` : a.tol && a.tol.mode === "pm" ? " ±" : a.tol && a.tol.mode === "dev" ? " +/-" : "";
        return a.textOverride ? first(a.textOverride) : `${a.type === "rad" ? a.prefix ?? (a.dia ? "Ø" : "R") : a.prefix || ""}${v}${a.type === "ang" ? "°" : ""}${tol}`;
      }
      case "text":
      case "lead":
      case "note":
        return first(a.type === "note" ? a.title || a.text : a.text);
      case "gdt":
        return `${a.dia ? "Ø" : ""}${a.val || ""} ${(a.datums || []).filter(Boolean).join("|")}`.trim();
      case "datum":
      case "section":
      case "detail":
        return a.letter || "";
      case "balloon":
        return `poz. ${a.num}`;
      case "strike":
        return a.newText ? `→ ${a.newText}` : "tăiată";
      case "rough":
        return a.val || "";
      case "revtab":
      case "bom":
        return `${(a.rows || []).length} rânduri`;
      default:
        return "";
    }
  }

  annotAt(raw) {
    const tol = 5 / this.view.zoom;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) if (hit(items[i].built, items[i].a, raw, tol)) return items[i].a;
    return null;
  }

  /** Selectează adnotarea și o aduce în centrul ecranului. */
  focusAnnot(id) {
    const a = this.annots.find((x) => x.id === id);
    if (!a) return;
    if (a.page !== this.page) this.setPage(a.page);
    if (this.tool !== "select") this.setTool("select");
    this.select(id);
    const b = this.builtOf(a).bbox;
    if (b) this.view.zoomToBox(b);
  }

  pushHistory(key) {
    this.frame = (this.frame || 0) + 1; // adnotările se pot schimba: cache-ul de cadru nu mai e valabil
    const now = Date.now();
    if (key && this.lastHistKey === key && now - this.lastHistTime < 1500) {
      this.lastHistTime = now;
      return;
    }
    this.lastHistKey = key;
    this.lastHistTime = now;
    this.undo.push(JSON.stringify(this.annots));
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
    this.updateButtons();
  }

  changed() {
    this.frame = (this.frame || 0) + 1; // adnotările se pot schimba: cache-ul de cadru nu mai e valabil
    this.unexported = true;
    this.view.redraw();
    this.view.loadImage(false); // se reîncarcă doar dacă s-a schimbat înnegrirea originalului
    this.scheduleSave();
    this.updateButtons();
  }

  doUndo() {
    if (!this.undo.length) return;
    this.redo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.undo.pop());
    this.lastHistKey = null;
    this.sel = new Set([...this.sel].filter((id) => this.annots.some((a) => a.id === id)));
    if (!this.selected()) this.selectedId = this.sel.size ? [...this.sel][0] : null;
    this.panel.render();
    this.changed();
  }

  doRedo() {
    if (!this.redo.length) return;
    this.undo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.redo.pop());
    this.lastHistKey = null;
    this.sel = new Set([...this.sel].filter((id) => this.annots.some((a) => a.id === id)));
    if (!this.selected()) this.selectedId = this.sel.size ? [...this.sel][0] : null;
    this.panel.render();
    this.changed();
  }

  setSettings(patch) {
    this.frame = (this.frame || 0) + 1; // adnotările se pot schimba: cache-ul de cadru nu mai e valabil
    const inkBefore = JSON.stringify(this.settings.ink || null);
    this.settings = { ...this.settings, ...patch };
    this.cache.clear();
    this.panel.render();
    this.changed();
    if (JSON.stringify(this.settings.ink || null) !== inkBefore) this.view.loadImage(true);
  }

  /** Parametrii de randare ai paginii: înnegrirea originalului (tot desenul sau obiecte alese). */
  /** Ștergerile reale de pe pagina n, ca operații pentru randare (editorul arată rezultatul exportului). */
  removalOps(n) {
    const ops = [];
    for (const a of this.annots) {
      if (a.page !== n || a.type !== "redact" || a.mode === "cover") continue;
      if (a.mode === "objects") {
        if ((a.ids || []).length) ops.push({ mode: "objects", ids: a.ids });
      } else ops.push({ mode: a.mode, rect: a.r });
    }
    return ops;
  }

  renderQuery(n) {
    const rem = this.removalOps(n);
    if (rem.length) return `#rm${JSON.stringify(rem).length}:${hashStr(JSON.stringify(rem))}${this.renderQueryBase(n)}`;
    return this.renderQueryBase(n);
  }

  renderQueryBase(n) {
    const ink = this.settings.ink;
    // versiunea paginilor (rotire, ordine): randările vechi din cache-ul browserului nu se mai folosesc
    let q = this.doc && this.doc.lv ? `&v=${this.doc.lv}` : "";
    if (ink && ink.all) q += `&ink=1&fills=${ink.fills || "black"}${ink.images ? "&img=1" : ""}`;
    else {
      const ids = this.annots.filter((a) => a.type === "ink" && a.page === n).flatMap((a) => a.ids || []);
      if (ids.length) q += `&bk=${encodeURIComponent([...new Set(ids)].join(","))}`;
    }
    return q;
  }

  // ------------------------------------------------------------ adnotări
  S() {
    if (!this._S || this._Skey !== JSON.stringify(this.settings)) {
      this._Skey = JSON.stringify(this.settings);
      this._S = derive(this.settings);
    }
    return this._S;
  }

  builtOf(a) {
    const S = this.S();
    const c = this.cache.get(a.id);
    // în același eveniment (o mișcare de mouse, un cadru) geometria nu se schimbă: fără JSON.stringify
    if (c && c.frame === this.frame && c.obj === a) return c.built;
    const stamp = JSON.stringify(a) + this._Skey;
    if (c && c.stamp === stamp) {
      c.frame = this.frame;
      c.obj = a;
      return c.built;
    }
    const built = build(a, S, this.measure);
    this.cache.set(a.id, { stamp, built, frame: this.frame, obj: a });
    return built;
  }

  layerOf(a) {
    if (a.type === "white" || a.type === "redact" || a.type === "ink") return "del";
    return a.layer === "rev" ? "rev" : "add";
  }

  /** Adnotările paginii curente, fără straturile ascunse pe ecran. */
  visibleBuilt() {
    return this.annots
      .filter((a) => a.page === this.page && !this.hidden.has(this.layerOf(a)))
      .map((a) => ({ a, built: this.builtOf(a) }));
  }

  toggleLayer(k) {
    if (this.hidden.has(k)) this.hidden.delete(k);
    else this.hidden.add(k);
    try {
      localStorage.setItem("cotare.hidden", JSON.stringify([...this.hidden]));
    } catch (_) { /* fără memorare */ }
    const keep = [...this.sel].filter((id) => {
      const a = this.annots.find((x) => x.id === id);
      return a && !this.hidden.has(this.layerOf(a));
    });
    if (keep.length !== this.sel.size) this.selectMany(keep);
    this.view.redraw();
  }

  selected() {
    return this.annots.find((a) => a.id === this.selectedId) || null;
  }

  /** Adnotările selectate (una sau mai multe), în ordinea din document. */
  selectedAll() {
    return this.annots.filter((a) => this.sel.has(a.id));
  }

  isSelected(id) {
    return this.sel.has(id);
  }

  select(id) {
    this.selectedId = id;
    this.sel = new Set(id ? [id] : []);
    this.panel.render();
    this.view.redraw();
    if (this.compact()) {
      // pe ecran mic panoul se deschide singur doar când e de scris ceva sau ai ales o adnotare
      const a = id && this.annots.find((x) => x.id === id);
      const typing = a && ["text", "note", "lead", "strike", "revtab", "bom", "gdt", "rough", "balloon", "datum"].includes(a.type);
      if (!id) this.setPanelOpen(false);
      else if (this.tool === "select" || typing) this.setPanelOpen(true);
    }
  }

  selectMany(ids, add = false) {
    const next = add ? new Set(this.sel) : new Set();
    for (const id of ids) next.add(id);
    this.sel = next;
    this.selectedId = next.size ? [...next][next.size - 1] : null;
    this.panel.render();
    this.view.redraw();
  }

  toggleSelect(id) {
    const next = new Set(this.sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.sel = next;
    this.selectedId = next.has(id) ? id : next.size ? [...next][next.size - 1] : null;
    this.panel.render();
    this.view.redraw();
  }

  updateSel(fn, key) {
    this.frame = (this.frame || 0) + 1; // adnotările se pot schimba: cache-ul de cadru nu mai e valabil
    const a = this.selected();
    if (!a) return;
    this.pushHistory(key ? `${a.id}:${key}` : null);
    fn(a);
    this.changed();
  }

  /** Aceeași modificare pe toate adnotările selectate (un singur pas de anulare). */
  updateMany(fn) {
    this.frame = (this.frame || 0) + 1; // adnotările se pot schimba: cache-ul de cadru nu mai e valabil
    const list = this.selectedAll();
    if (!list.length) return;
    this.pushHistory();
    list.forEach(fn);
    this.changed();
  }

  addAnnot(a) {
    this.pushHistory();
    a.page = this.page;
    if (this.hidden.has(this.layerOf(a))) {
      this.hidden.delete(this.layerOf(a));
      dlg.toast("Stratul era ascuns pe ecran; l-am reafișat ca să vezi ce ai adăugat.");
    }
    this.annots.push(a);
    this.select(a.id);
    this.changed();
    const focus = { text: "#tTxt", lead: "#lTxt", strike: "#sNew", note: "#nTxt" }[a.type];
    if (focus) {
      const el = $("panel").querySelector(focus);
      if (el) {
        el.focus();
        el.select();
      }
    }
  }

  deleteSelected() {
    const ids = new Set(this.sel);
    if (!ids.size) return;
    this.pushHistory();
    this.annots = this.annots.filter((x) => !ids.has(x.id));
    ids.forEach((id) => this.cache.delete(id));
    this.select(null);
    this.changed();
  }

  // ------------------------------------------------------------ copiere / lipire
  copySelected(silent) {
    const list = this.selectedAll();
    if (!list.length) return false;
    const keep = list.filter((a) => a.type !== "redact");
    if (keep.length < list.length) dlg.toast("Ștergerile din original țin de obiectele de sub ele și nu se copiază.");
    if (!keep.length) return false;
    this.clip = JSON.stringify(keep);
    try {
      localStorage.setItem("cotare.clip", this.clip);
    } catch (_) { /* stocare indisponibilă */ }
    if (!silent) dlg.toast(`${keep.length === 1 ? "Copiat" : `Copiate ${keep.length} adnotări`} · Ctrl+V lipește la cursor`);
    return true;
  }

  paste(duplicate) {
    if (!this.doc) return;
    let raw = this.clip;
    if (!raw) {
      try {
        raw = localStorage.getItem("cotare.clip");
      } catch (_) { /* stocare indisponibilă */ }
    }
    if (!raw) return;
    let src = JSON.parse(raw);
    if (!Array.isArray(src)) src = [src];
    const items = src.map((x) => {
      const c = { ...x };
      delete c.id;
      const a = finalize(c);
      a.id = newId();
      a.page = this.page;
      return a;
    });
    // grupul se mută ca întreg: ancora primei adnotări ajunge la cursor
    const anchor = (build(items[0], this.S(), this.measure).handles || []).find((h) => h.p);
    let dx = 5 * K;
    let dy = 5 * K;
    const p = this.lastPt;
    const pg = this.doc.pages[this.page];
    if (!duplicate && anchor && p && p[0] >= 0 && p[1] >= 0 && p[0] <= pg.w && p[1] <= pg.h) {
      dx = p[0] - anchor.p[0];
      dy = p[1] - anchor.p[1];
    }
    if (items.length === 1) {
      moveAnnot(items[0], dx, dy);
      this.addAnnot(items[0]);
      return;
    }
    this.pushHistory();
    for (const a of items) {
      moveAnnot(a, dx, dy);
      this.annots.push(a);
    }
    this.selectMany(items.map((a) => a.id));
    this.changed();
  }

  revRowsFromStrikes(ensureOne, existing = []) {
    const today = new Date().toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" });
    const by = new Map();
    for (const a of this.annots) {
      if (a.type !== "strike") continue;
      const r = String(a.rev || "").trim() || this.settings.revNo || "1";
      if (!by.has(r)) by.set(r, []);
      if (a.newText && a.newText.trim()) by.get(r).push(a.newText.trim());
    }
    const have = new Set(existing.map((r) => String(r.rev)));
    const rows = [];
    const keys = [...by.keys()].sort((x, y) => (parseFloat(x) || 0) - (parseFloat(y) || 0) || x.localeCompare(y));
    for (const rev of keys) {
      if (have.has(rev)) continue;
      const vals = by.get(rev);
      const word = this.settings.dlang === "en" ? "Modified dimensions" : "Cote modificate";
      rows.push({ rev, desc: vals.length ? `${word}: ${vals.join(", ")}` : word, date: today, name: this.settings.author || "" });
    }
    if (ensureOne && !rows.length && !existing.length) {
      rows.push({ rev: this.settings.revNo || "1", desc: "", date: today, name: this.settings.author || "" });
    }
    return rows;
  }

  /** Rânduri noi pentru lista de componente: câte unul pentru fiecare număr de reper absent. */
  bomRowsFromBalloons(existing = [], ensureOne = false) {
    const have = new Set(existing.map((r) => String(r.poz).trim()));
    const nums = [...new Set(this.annots.filter((a) => a.type === "balloon").map((a) => String(a.num ?? "").trim()).filter(Boolean))];
    nums.sort((x, y) => (parseFloat(x) || 0) - (parseFloat(y) || 0) || x.localeCompare(y));
    const rows = nums.filter((n) => !have.has(n)).map((poz) => ({ poz, name: "", qty: "1", mat: "", obs: "" }));
    if (ensureOne && !rows.length && !existing.length) rows.push({ poz: "1", name: "", qty: "1", mat: "", obs: "" });
    return rows;
  }

  defaultTol() {
    return { mode: "none" };
  }

  nextViewLetter() {
    const used = new Set(this.annots.filter((a) => a.type === "section" || a.type === "detail").map((a) => a.letter));
    for (const ch of VIEW_LETTERS) if (!used.has(ch)) return ch;
    return "A";
  }

  /** Eticheta propusă pentru vederea următoare: prima secțiune sau primul detaliu fără etichetă. */
  nextViewLabel() {
    const texts = this.annots.filter((a) => a.type === "text").map((a) => String(a.text || "").replace(/\s+/g, ""));
    const has = (l) => texts.some((t) => t.startsWith(`${l}–`) || t.startsWith(`${l}-`) || t.startsWith(`${l}(`) || t === l);
    for (const a of this.annots) {
      if ((a.type === "section" || a.type === "detail") && !has(a.letter)) return a.type === "section" ? `${a.letter}–${a.letter}` : `${a.letter} (2:1)`;
    }
    return "A–A";
  }

  nextBalloon() {
    const nums = this.annots.filter((a) => a.type === "balloon").map((a) => parseInt(a.num, 10)).filter(Number.isFinite);
    return String(nums.length ? Math.max(...nums) + 1 : 1);
  }

  nextDatumLetter() {
    const used = new Set(this.annots.filter((a) => a.type === "datum").map((a) => a.letter));
    for (const ch of DATUM_LETTERS) if (!used.has(ch)) return ch;
    return "A";
  }

  editInk(a) {
    dlg.inkDialog(this, a, false);
  }

  editRedaction(a) {
    dlg.redactDialog(this, a, false);
  }

  commitRedaction(a, patch, isNew) {
    this.pushHistory();
    if (isNew) {
      const na = finalize({ ...a, ...patch });
      na.page = this.page;
      this.annots.push(na);
      this.selectedId = na.id;
      this.sel = new Set([na.id]);
    } else {
      const cur = this.annots.find((x) => x.id === a.id);
      if (cur) Object.assign(cur, patch);
    }
    this.panel.render();
    this.changed();
  }

  async exportPdf(filename, colorMode, embed, pageSel = null, split = false, extra = {}) {
    const pages = {};
    const removals = {};
    for (const a of this.annots) {
      const prims = exportPrims(this.builtOf(a).prims);
      if (prims.length) (pages[a.page] = pages[a.page] || []).push(...prims);
      if (a.type === "redact" && a.mode !== "cover") {
        const op = a.mode === "objects" ? { mode: "objects", ids: a.ids || [] } : { mode: a.mode, rect: a.r };
        if (a.mode !== "objects" || op.ids.length) (removals[a.page] = removals[a.page] || []).push(op);
      }
      if (a.type === "ink" && (a.ids || []).length && !(this.settings.ink && this.settings.ink.all)) {
        (removals[a.page] = removals[a.page] || []).push({ mode: "black", ids: a.ids });
      }
    }
    const ink = this.settings.ink && this.settings.ink.all ? this.settings.ink : null;
    return api.exportPdf(this.doc.id, { filename, colorMode, embed, pages, removals, ink, pageSel, split, state: this.stateJson(), ...extra });
  }

  // ------------------------------------------------------------ mouse
  snapPoint(raw, e, anchor) {
    const v = this.view;
    const cfg = this.snapCfg;
    const ortho = e.shiftKey || cfg.ortho;
    let pt = raw;
    let sn = null;
    if (!e.altKey) {
      const on = cfg.on;
      const extra = { pts: [], segs: [], arcs: [] };
      if (on) {
        for (const { a, built } of this.visibleBuilt()) {
          if (this.drag && this.drag.id === a.id) continue;
          if (built.snap) {
            extra.pts.push(...built.snap.pts);
            extra.segs.push(...built.snap.segs);
            if (built.snap.arcs) extra.arcs.push(...built.snap.arcs);
          } else extra.pts.push(...annotSnapPoints(built));
        }
      }
      this._extra = extra;
      // originalul ascuns pe ecran nu mai „prinde” cursorul
      const sp = on && !this.hidden.has("orig") ? this.snapper : this.noSnapper;
      sn = sp.snap(raw, {
        tol: 10 / v.zoom,
        modes: on ? new Set(cfg.modes) : new Set(),
        anchor,
        extra,
        acq: on ? this.acq : [],
        parDir: this.parDir,
        polarInc: !ortho && cfg.polar ? cfg.polarInc : 0,
        tracking: on && cfg.tracking,
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

  /**
   * Achiziție ca în AutoCAD: cursorul oprit ~½ s pe un punct îl marchează pentru urmărire și
   * extensie (încă o oprire îl scoate); oprit pe o linie, în timpul unei comenzi, îi ia direcția
   * pentru snap paralel.
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
    } catch (_) { /* fără memorare */ }
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
      <div class="sub">Urmărire: oprește cursorul o clipă pe un punct (apare o cruciuliță verde), apoi mișcă-te pe orizontală, verticală sau în prelungirea liniei. Încă o oprire pe punct îl scoate.<br>Paralel: în timpul unei comenzi, oprește-te pe o linie, apoi mișcă-te aproape paralel cu ea.<br>F3 snap · F8 ortho · F10 polar · F11 urmărire · Alt = fără snap</div>`;
    $("snapMenu").querySelectorAll("[data-mode]").forEach((cb) => cb.addEventListener("change", () => {
      const set = new Set(c.modes);
      if (cb.checked) set.add(cb.dataset.mode);
      else set.delete(cb.dataset.mode);
      c.modes = MODES.map((m) => m.id).filter((id) => set.has(id));
      this.saveSnapCfg();
    }));
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
    // ortho și polar se exclud, ca în AutoCAD
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
      if (!this.doc) return;
      // tastele de unelte nu trebuie să ajungă într-un câmp din panou rămas activ
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      if (this.mmenu) {
        // meniul radial deschis: un click în afara lui îl închide
        this.closeMarkingMenu();
        return;
      }
      // două degete: pan + zoom; renunță la ce începuse primul deget
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
        // click dreapta: scurt = Esc / gata, ținut = meniu radial, tras = mută foaia
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
        // apăsare lungă cu degetul: meniul radial
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
      if (t.kind === "select") {
        this.startSelectDrag(raw, sx, sy, e);
        return;
      }
      // înainte de primul click al unei unelte, pătrățelele selecției au prioritate
      if (!this.clicks.length && this.tryHandleDrag(sx, sy, true)) return;
      const anchor = this.clicks[this.clicks.length - 1];
      if (t.kind === "rect") {
        const { pt } = this.snapPoint(raw, e, anchor);
        this.drag = { kind: "rect", start: pt };
        return;
      }
      if (e.pointerType === "touch") {
        // pe ecran tactil punctul se pune la ridicarea degetului: poți ajusta poziția cu snap,
        // iar apăsarea lungă deschide meniul fără să lase un punct în urmă
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
        // marginea trecută peste cea opusă: caseta se întoarce, ca în Windows
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
        const crossing = raw[0] < d.start[0];
        this.view.overlay = { rect: [d.start[0], d.start[1], raw[0], raw[1]], rectColor: crossing ? "#3ccf8e" : "#4c9aff" };
        this.view.redraw();
        return;
      }
      const t = TOOL_BY_ID[this.tool];
      if (t.kind === "select" || t.kind === "pan") {
        this.showCoords(raw);
        if (t.kind === "select" && !d) {
          // ce s-ar apuca la click: mâner, margine sau adnotare, cu cursorul și eticheta potrivite
          const hv = e.pointerType === "touch" ? null : this.hoverAt(sx, sy, raw, false);
          cv.style.cursor = hv ? hv.cursor : "default";
          this.setHover(hv, raw);
        }
        return;
      }
      if (!d && !this.clicks.length) {
        // și cu altă unealtă, colțurile de mărire ale selecției rămân apucabile
        const hs = this.handleAt(sx, sy);
        if (hs && hs.h.k === "sc") {
          cv.style.cursor = this.handleCursor(hs.a, hs.h);
          this.setHover({ kind: "handle", a: hs.a, h: hs.h, label: "Mărește / micșorează" }, raw);
          return;
        }
        if (this.hover) this.setHover(null, raw);
        cv.style.cursor = "crosshair";
      }
      const anchor = d && d.kind === "rect" ? d.start : this.clicks[this.clicks.length - 1];
      const { pt: spt, sn } = this.snapPoint(raw, e, anchor);
      this.trackHover(sn, raw);
      this._dynPt = spt;
      this._dynSn = sn;
      // valorile scrise (intrarea dinamică) fixează punctul: cursorul alege doar ce n-ai scris
      const pt = d && d.kind === "rect" ? spt : this.dynPoint(spt, anchor);
      this.showCoords(pt, anchor);
      if (d && d.kind === "rect") {
        this.view.overlay = { rect: [d.start[0], d.start[1], pt[0], pt[1]], rectColor: t.id === "redact" ? COLORS.edred : COLORS.sel, snap: sn };
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
        // al doilea deget ridicat: gestul se termină, fără click
        if (this.touches.size === 0) this.drag = null;
        return;
      }
      this.drag = null;
      if (!d) return;
      if (d.kind === "rclick") {
        clearTimeout(this.pressTimer);
        this.escape();
        return;
      }
      if (d.kind === "tap") {
        const [ux, uy] = pos(e);
        const raw = this.view.toPage(ux, uy);
        const an = this.clicks[this.clicks.length - 1];
        this.toolClick(this.dynPoint(this.snapPoint(raw, e, an).pt, an));
        return;
      }
      if (d.kind === "mmenu") {
        const m = this.mmenu;
        if (m && m.hi >= 0) this.runMarking(m.hi);
        return; // fără direcție: meniul rămâne deschis pentru click
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
          if (!d.add) this.select(null);
          else this.view.redraw();
          return;
        }
        // stânga→dreapta: doar ce e complet în dreptunghi; dreapta→stânga: tot ce atinge
        const crossing = end[0] < d.start[0];
        const ids = [];
        for (const { a, built } of this.visibleBuilt()) {
          const b = built.bbox;
          if (!b) continue;
          const inside = b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1;
          const touch = !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1);
          if (crossing ? touch : inside) ids.push(a.id);
        }
        this.selectMany(ids, d.add);
        return;
      }
      if (d.kind === "rect") {
        const [sx, sy] = pos(e);
        const raw = this.view.toPage(sx, sy);
        const { pt } = this.snapPoint(raw, e, d.start);
        this.view.overlay = null;
        this.view.redraw();
        const r = [d.start[0], d.start[1], pt[0], pt[1]];
        if (Math.abs(r[2] - r[0]) < 2 || Math.abs(r[3] - r[1]) < 2) return;
        const t = TOOL_BY_ID[this.tool];
        const a = t.make(r, this);
        if (a.type === "redact") {
          a.page = this.page;
          dlg.redactDialog(this, a, true);
        } else if (a.type === "ink") {
          a.page = this.page;
          dlg.inkDialog(this, a, true);
        } else this.addAnnot(finalize(a));
      }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    // dublu-click pe o adnotare: cursorul ajunge direct în primul câmp de editat din panou
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
    // meniul contextual al browserului nu apare peste desen; nici când click-ul dreapta se
    // eliberează pe meniul radial (pe Windows evenimentul vine la ridicarea butonului)
    $("viewport").addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("contextmenu", (e) => {
      if (this.mmenu || this.mmenuClosedAt > performance.now() - 400) e.preventDefault();
    });
    cv.addEventListener("pointerleave", () => {
      if (this.hover) this.setHover(null, null);
      if (!this.drag && this.view.overlay && this.view.overlay.snap) {
        this.view.overlay.snap = null;
        this.view.redraw();
      }
    });
  }

  /** Dreptunghiul editabil al unei casete (acoperire, ștergere, înnegrire, cotă tăiată, dreptunghi desenat). */
  boxOf(a) {
    let r = null;
    if (a.r && ["white", "redact", "ink", "strike"].includes(a.type)) r = a.r;
    else if (a.type === "shape" && a.kind === "rect" && a.pts && a.pts.length >= 2) r = [...a.pts[0], ...a.pts[1]];
    if (!r) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }

  /** Marginea sau colțul de casetă de sub cursor (ca la ferestrele din Windows). */
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
    this.hover = null;
    this.hoverKey2 = "";
    if (!e.shiftKey && this.sel.size <= 1 && this.tryHandleDrag(sx, sy, false, e.pointerType === "touch")) return;
    const edge = !e.shiftKey && this.edgeAt(sx, sy, e.pointerType === "touch");
    if (edge) {
      if (!this.sel.has(edge.a.id)) this.select(edge.a.id);
      this.drag = { kind: "edge", id: edge.a.id, code: edge.code };
      return;
    }
    const tol = 5 / v.zoom;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) {
      const { a, built } = items[i];
      if (hit(built, a, raw, tol)) {
        if (e.shiftKey) {
          this.toggleSelect(a.id);
          return;
        }
        if (!this.sel.has(a.id)) this.select(a.id);
        this.drag = { kind: "move", ids: [...this.sel], last: raw, start: raw, sx, sy };
        return;
      }
    }
    // zonă goală: dreptunghi de selecție
    this.drag = { kind: "marquee", start: raw, add: e.shiftKey };
  }

  /**
   * Un click pe pătrățelele adnotării selectate o editează. Cu altă unealtă activă contează doar
   * pătrățelul de mărire: capetele trebuie să rămână libere pentru cote înlănțuite din același punct.
   */
  /** Mânerul adnotării selectate cel mai apropiat de cursor (pixeli de ecran), sau null. */
  handleAt(sx, sy, touch = false) {
    const sel = this.selected();
    if (!sel || sel.page !== this.page || this.sel.size > 1 || this.hidden.has(this.layerOf(sel))) return null;
    const r = touch ? 16 : 10;
    let best = null;
    let bd = r;
    for (const h of this.builtOf(sel).handles || []) {
      if (!h.p) continue;
      const [hx, hy] = this.view.toScreen(h.p);
      // la egalitate, punctele adnotării au prioritate față de colțurile de mărire
      const d = Math.hypot(hx - sx, hy - sy) + (h.k === "sc" ? 1.5 : 0);
      if (d <= bd) {
        bd = d;
        best = { a: sel, h };
      }
    }
    return best;
  }

  /** Ce face un mâner, în cuvinte (tooltip la hover). */
  handleLabel(a, k) {
    if (k === "sc") return "Mărește / micșorează";
    if (k === "tx") return "Mută textul cotei";
    if (k === "elbow") return "Cotul liniei — frânge linia";
    if (k === "target") return "Vârful pe piesă";
    if (k === "pos" || (k === "p" && ["text", "note", "revtab", "bom"].includes(a.type))) return "Mută";
    if (k === "vp") return "Partea spre care privești";
    if (k === "tp") return "Mută litera";
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
    if (h.k === "pos" || h.k === "tp" || (h.k === "p" && ["text", "note", "revtab", "bom"].includes(a.type))) return "move";
    return "grab";
  }

  /**
   * Un click pe mânerele adnotării selectate o editează. Cu altă unealtă activă contează doar
   * pătrățelele de mărire: capetele trebuie să rămână libere pentru cote înlănțuite din același punct.
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
    this.drag = { kind: "handle", id: sel.id, k: h.k, label: this.handleLabel(sel, h.k), anchor: h.k === "p2" ? sel.p1 : h.k === "p1" ? sel.p2 : h.k === "elbow" ? sel.target : null };
    return true;
  }

  /** Ce e sub cursor în modul Selecție: mâner, margine de casetă sau adnotare. */
  hoverAt(sx, sy, raw, touch) {
    const h = this.handleAt(sx, sy, touch);
    if (h) return { kind: "handle", a: h.a, h: h.h, cursor: this.handleCursor(h.a, h.h), label: this.handleLabel(h.a, h.h.k) };
    const edge = this.edgeAt(sx, sy, touch);
    if (edge) return { kind: "edge", a: edge.a, cursor: this.edgeCursor(edge.code), label: edge.code.length === 2 ? "Colț — redimensionează" : "Margine — redimensionează" };
    const a = this.annotAt(raw);
    if (a) return { kind: "body", a, cursor: "move", label: `${typeName(a)}${this.sel.has(a.id) ? " — trage pentru a muta" : " — click pentru a selecta, trage pentru a muta"}` };
    return null;
  }

  setHover(hv, raw) {
    const key = hv ? `${hv.kind}:${hv.a.id}:${hv.h ? hv.h.k + hv.h.p.join(",") : ""}` : "";
    this.hoverPt = raw;
    if (key === this.hoverKey2) {
      if (hv) this.view.redraw(); // eticheta urmează cursorul
      return;
    }
    this.hoverKey2 = key;
    this.hover = hv;
    this.view.redraw();
  }

  updateOverlay(pt, sn) {
    const t = TOOL_BY_ID[this.tool];
    let prims = null;
    if (this.clicks.length && t.preview) {
      const pv = t.preview(this.clicks, pt, this);
      if (pv && (pv.line || pv.lines)) {
        prims = (pv.lines || [pv.line]).map((l) => ({ t: "L", p: [...l[0], ...l[1]], w: 0.6, c: "preview", dash: true }));
      }
      else if (pv) prims = build({ ...pv, layer: "add" }, this.S(), this.measure).prims;
    }
    if (!prims && t.id === "measure" && this.lastMeasure) prims = this.lastMeasure;
    this.view.overlay = { prims, snap: sn };
    this.view.redraw();
    const t2 = TOOL_BY_ID[this.tool];
    if (this.clicks.length) {
      if (t2.kind === "poly") this.setHint(`${t2.hint} · ${this.clicks.length} puncte`);
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
    // linia măsurată rămâne vizibilă până la măsurătoarea următoare
    this.lastMeasure = [{ t: "L", p: [...p, ...q], w: 0.6, c: "sel" }, { t: "C", p: [...p], r: 1.2, w: 0.6, c: "sel" }, { t: "C", p: [...q], r: 1.2, w: 0.6, c: "sel" }];
    this.view.overlay = { prims: this.lastMeasure };
    this.view.redraw();
    dlg.toast(`L = ${f(L)} mm · Δx ${f(Math.abs(dx))} · Δy ${f(Math.abs(dy))} · ${fmtNum(ang, ",", 2)}°${Math.abs(k - 1) > 1e-9 ? ` (scara ${this.scaleLabel()})` : ""}`, 8000);
  }

  // ------------------------------------------------------------ intrare dinamică (DYN)
  /** Unealta așteaptă un punct relativ la ultimul click: valorile se pot scrie de la tastatură. */
  dynTool() {
    const t = TOOL_BY_ID[this.tool];
    return !!(this.doc && this.dyn.on && this.clicks.length && t && (t.kind === "clicks" || t.kind === "poly"));
  }

  dynReset() {
    this.dyn.vals = {};
    this.dyn.active = null;
    this.dyn.text = "";
  }

  /** Punctul cursorului, cu valorile scrise (în mm reali, Y în sus ca în CAD) aplicate. */
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
    // un singur câmp: lungimea pe direcția cursorului (direcția o dau ortho / polar / snap)
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
      for (const g of group) delete d.vals[g]; // carteziene sau polare, nu amestecate
    }
  }

  /** Taste pentru intrarea dinamică; întoarce true dacă tasta a fost folosită aici. */
  dynKey(e) {
    if (!this.dynTool()) return false;
    const d = this.dyn;
    // virgula (și cea de pe tastatura numerică) e separator zecimal: 12,5 = 12.5
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
    if (k === "Tab") return true; // un singur câmp; Tab nu mută focusul din desen
    if (k === "Backspace" && has) {
      if (d.text) d.text = d.text.slice(0, -1);
      else if (d.active) delete d.vals[d.active];
      this.dynParse();
      this.dynRefresh();
      return true;
    }
    if ((k === "Enter" || k === " ") && has) {
      const anchor = this.clicks[this.clicks.length - 1];
      const p = this.dynPoint(this._dynPt || this.lastPt || anchor, anchor);
      this.dynReset();
      this.toolClick(p);
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
    const anchor = this.clicks[this.clicks.length - 1];
    if (!anchor || !this._dynPt) {
      this.renderDyn(null, null);
      return;
    }
    const p = this.dynPoint(this._dynPt, anchor);
    this.updateOverlay(p, this._dynSn);
    this.showCoords(p, anchor);
    this.renderDyn(p, anchor);
  }

  renderDyn(pt, anchor) {
    const box = $("dynBox");
    if (!box) return;
    if (!pt || !anchor || !this.dynTool()) {
      box.hidden = true;
      return;
    }
    const d = this.dyn;
    const k = Number(this.settings.scale) || 1;
    const sep = this.settings.sep || ",";
    const dx = ((pt[0] - anchor[0]) / K) * k;
    const dy = (-(pt[1] - anchor[1]) / K) * k;
    const live = { dx, dy, len: Math.hypot(dx, dy), ang: ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360 };
    const names = { dx: "X", dy: "Y", len: "L", ang: "∠" };
    box.innerHTML = ["len"].map((f) => {
      const on = d.active === f;
      const lock = !on && d.vals[f] != null;
      const txt = on ? d.text.replace(".", sep) : fmtNum(lock ? d.vals[f] : live[f], sep, f === "ang" ? 1 : 2) + (f === "ang" ? "°" : "");
      return `<span class="df${on ? " on" : ""}${lock ? " lock" : ""}"><i>${names[f]}</i><b>${txt}</b></span>`;
    }).join("");
    // lângă cursor, sub eticheta de snap / polar (aceea e la +16, +18 și are 20 px)
    const [sx, sy] = this.view.toScreen(this._dynPt || pt);
    const vp = $("viewport");
    box.style.left = `${Math.max(4, Math.min(sx + 16, vp.clientWidth - 110))}px`;
    box.style.top = `${Math.min(sy + 42, vp.clientHeight - 28)}px`;
    box.hidden = false;
  }

  showCoords(pt, anchor) {
    let s = `X ${fmtNum(pt[0] / K, ",", 2)} · Y ${fmtNum(pt[1] / K, ",", 2)} mm`;
    if (anchor) {
      const dx = ((pt[0] - anchor[0]) / K) * this.settings.scale;
      const dy = ((pt[1] - anchor[1]) / K) * this.settings.scale;
      s += ` · Δx ${fmtNum(Math.abs(dx), ",", 2)} · Δy ${fmtNum(Math.abs(dy), ",", 2)} · L ${fmtNum(Math.hypot(dx, dy), ",", 2)}`;
    }
    $("stCoords").textContent = s;
  }

  // ------------------------------------------------------------ tastatură
  // ------------------------------------------------------------ taste și linia de comandă
  applyKeyCfg(cfg) {
    this.keyCfg = cfg;
    this.keyMap = directKeyMap(cfg);
    const byId = Object.fromEntries(commandList(cfg).map((c) => [c.id, c]));
    $("tools").querySelectorAll("[data-tool]").forEach((b) => {
      const c = byId[b.dataset.tool];
      if (!c) return;
      const bits = [c.key, c.aliases[0]].filter(Boolean);
      b.title = `${tr(c.label)}${bits.length ? ` (${[...new Set(bits)].join(" · ")})` : ""}`;
    });
    const inp = $("cmdIn");
    if (inp) inp.placeholder = cfg.mode === "autocad" ? "Comandă (L, C, PL, DLI…)" : "Enter → comandă (L, C, DLI…)";
    if (this.panel) this.panel.render();
  }

  bindCmdLine() {
    const inp = $("cmdIn");
    const box = $("cmdSug");
    if (!inp) return;
    let list = [];
    let pick = 0;
    let hIdx = -1; // poziția în istoric (-1 = nu se răsfoiește)
    const showHistory = () => {
      const hist = this.cmdHistory;
      const byId = Object.fromEntries(commandList(this.keyCfg).map((c) => [c.id, c]));
      // ca în AutoCAD: cele mai recente jos, lângă linia de comandă
      const from = Math.max(0, hIdx - 7);
      const rows = hist.slice(from, from + 8).map((h, k) => ({ ...h, i: from + k })).reverse();
      box.innerHTML = rows.map((h) => {
        const c = byId[h.id];
        return `<div class="cs${h.i === hIdx ? " on" : ""}" data-h="${h.i}"><b class="mono">${h.text}</b><span>${c ? c.label : ""}</span></div>`;
      }).join("");
      box.hidden = !rows.length;
      box.querySelectorAll("[data-h]").forEach((el) => el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const h = hist[Number(el.dataset.h)];
        const c = h && resolveCommand(h.text, this.keyCfg);
        if (c) this.execCmdLine(c);
      }));
    };
    /** Săgeată sus / jos: comenzile folosite înainte, de la cea mai recentă. */
    const browse = (dir) => {
      const hist = this.cmdHistory;
      if (!hist.length) return false;
      hIdx = Math.max(-1, Math.min(hist.length - 1, hIdx + dir));
      list = [];
      pick = 0;
      inp.value = hIdx >= 0 ? hist[hIdx].text : "";
      inp.setSelectionRange(inp.value.length, inp.value.length);
      if (hIdx >= 0) showHistory();
      else box.hidden = true;
      return true;
    };
    this._cmdBrowse = browse;
    const show = () => {
      hIdx = -1;
      list = suggest(inp.value, this.keyCfg);
      pick = 0;
      if (!list.length) {
        box.hidden = true;
        return;
      }
      box.innerHTML = list.map((c, i) => `<div class="cs${i === pick ? " on" : ""}" data-i="${i}"><b class="mono">${c.hit || ""}</b><span>${c.label}</span>${c.key ? `<i class="mono">${c.key}</i>` : ""}</div>`).join("");
      box.hidden = false;
      box.querySelectorAll("[data-i]").forEach((el) => el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.execCmdLine(list[Number(el.dataset.i)]);
      }));
    };
    const mark = () => box.querySelectorAll(".cs").forEach((el, i) => el.classList.toggle("on", i === pick));
    this._cmdShow = show;
    inp.addEventListener("input", show);
    inp.addEventListener("focus", () => { if (hIdx < 0) show(); });
    inp.addEventListener("blur", () => setTimeout(() => {
      box.hidden = true;
      hIdx = -1;
    }, 120));
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        inp.value = "";
        inp.blur();
        this.escape();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // linia goală (sau deja în istoric): istoricul comenzilor; altfel, sugestiile
        if (!inp.value.trim() || hIdx >= 0) {
          browse(e.key === "ArrowUp" ? 1 : -1);
          return;
        }
        if (list.length) pick = (pick + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        mark();
        return;
      }
      if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
        e.preventDefault();
        const v = inp.value.trim();
        if (!v) {
          inp.blur();
          if (e.key !== "Tab") this.repeatCmd();
          return;
        }
        // potrivirea exactă are întâietate; altfel prima sugestie (sau cea aleasă cu săgețile)
        const exact = resolveCommand(v, this.keyCfg);
        const chosen = hIdx >= 0 ? exact : pick > 0 && list[pick] ? list[pick] : exact || list[0];
        if (!chosen) {
          dlg.toast(`Comandă necunoscută: ${v.toUpperCase()}`);
          inp.select();
          return;
        }
        this.execCmdLine(chosen);
      }
    });
  }

  /** Începe scrierea unei comenzi (modul AutoCAD) sau deschide linia de comandă goală. */
  focusCmdLine(ch = "") {
    const inp = $("cmdIn");
    if (!inp || inp.offsetParent === null) return false;
    inp.value = ch;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    if (this._cmdShow) this._cmdShow();
    return true;
  }

  execCmdLine(c) {
    const inp = $("cmdIn");
    // în istoric rămâne ce ai scris (dacă e chiar o prescurtare a comenzii), altfel prescurtarea ei
    const typed = inp.value.trim().toUpperCase();
    this._typedCmd = c.aliases && c.aliases.includes(typed) ? typed : null;
    inp.value = "";
    inp.blur();
    $("cmdSug").hidden = true;
    this.runCommand(c.id);
  }

  repeatCmd() {
    if (this.lastCmd) this.runCommand(this.lastCmd);
  }

  /** Istoricul comenzilor (cea mai recentă prima), păstrat în browser între sesiuni. */
  get cmdHistory() {
    if (!this._cmdHist) {
      try {
        const h = JSON.parse(localStorage.getItem("drawcad.cmdhist") || "[]");
        this._cmdHist = Array.isArray(h) ? h.filter((x) => x && typeof x.id === "string" && typeof x.text === "string") : [];
      } catch (_) {
        this._cmdHist = [];
      }
    }
    return this._cmdHist;
  }

  recordCmd(id, text) {
    if (!id || id === "select" || id === "pan") return;
    const c = commandList(this.keyCfg).find((x) => x.id === id);
    const t = String(text || (c && c.aliases[0]) || "").toUpperCase();
    if (!t) return;
    const h = this.cmdHistory.filter((x) => x.text !== t);
    h.unshift({ id, text: t });
    this._cmdHist = h.slice(0, 50);
    try {
      localStorage.setItem("drawcad.cmdhist", JSON.stringify(this._cmdHist));
    } catch (_) { /* stocare indisponibilă */ }
  }

  toggleSnapFlag(fk) {
    const c = this.snapCfg;
    c[fk] = !c[fk];
    if (fk === "ortho" && c.ortho) c.polar = false;
    if (fk === "polar" && c.polar) c.ortho = false;
    if (fk === "on") this.clearAcq();
    this.saveSnapCfg();
    const names = { on: "Snap", ortho: "Ortho", polar: `Polar ${c.polarInc}°`, tracking: "Urmărire" };
    dlg.toast(`${names[fk]}: ${c[fk] ? "pornit" : "oprit"}`, 1500);
  }

  zoomSelection() {
    const boxes = this.selectedAll().map((a) => this.builtOf(a).bbox).filter(Boolean);
    if (!boxes.length) return this.view.fit();
    this.view.zoomToBox([Math.min(...boxes.map((q) => q[0])), Math.min(...boxes.map((q) => q[1])), Math.max(...boxes.map((q) => q[2])), Math.max(...boxes.map((q) => q[3]))]);
  }

  /** O comandă după id: unealtă sau acțiune (din linia de comandă, tastă sau repetare). */
  runCommand(id) {
    const needDoc = () => {
      if (this.doc) return true;
      dlg.toast("Deschide întâi un desen");
      return false;
    };
    if (TOOL_BY_ID[id]) {
      if (!needDoc()) return;
      // E (ERASE) cu ceva selectat șterge selecția, ca în AutoCAD; altfel pornește ștergerea din original
      if (id === "redact" && this.sel.size) {
        this.deleteSelected();
        this.lastCmd = id;
        this.recordCmd(id, this._typedCmd);
        this._typedCmd = null;
        return;
      }
      this.setTool(id);
      return;
    }
    const act = {
      undo: () => this.doUndo(),
      redo: () => this.doRedo(),
      fit: () => this.view.fit(),
      zoomSel: () => this.zoomSelection(),
      find: () => needDoc() && dlg.textDialog(this),
      export: () => needDoc() && dlg.exportDialog(this),
      open: () => $("btnOpen").click(),
      close: () => this.doc && this.closeDoc(),
      settings: () => needDoc() && dlg.settingsDialog(this),
      keys: () => dlg.keysDialog(this),
      osnap: () => this.toggleSnapFlag("on"),
      ortho: () => this.toggleSnapFlag("ortho"),
      polar: () => this.toggleSnapFlag("polar"),
      selAll: () => this.doc && this.selectMany(this.visibleBuilt().map(({ a }) => a.id)),
      nextPage: () => this.doc && this.page < this.doc.pages.length - 1 && this.setPage(this.page + 1),
      prevPage: () => this.doc && this.page > 0 && this.setPage(this.page - 1),
      rotR: () => needDoc() && this.pageOp({ op: "rotate", pages: [this.page], delta: 90 }).catch((e) => dlg.toast(e.message)),
      rotL: () => needDoc() && this.pageOp({ op: "rotate", pages: [this.page], delta: -90 }).catch((e) => dlg.toast(e.message)),
      pages: () => needDoc() && dlg.pagesDialog(this),
    }[id];
    if (!act) return;
    act();
    if (id !== "keys" && id !== "settings") this.lastCmd = id;
    this.recordCmd(id, this._typedCmd);
    this._typedCmd = null;
  }

  bindKeys() {
    window.addEventListener("keydown", (e) => {
      this.frame = (this.frame || 0) + 1;
      if (dlg.isModalOpen()) return;
      if (e.key === "F12") {
        // ca în AutoCAD: intrarea dinamică pornită / oprită
        e.preventDefault();
        this.dyn.on = !this.dyn.on;
        try {
          localStorage.setItem("drawcad.dyn", this.dyn.on ? "1" : "0");
        } catch (_) { /* fără memorare */ }
        if (!this.dyn.on) {
          this.dynReset();
          $("dynBox").hidden = true;
        }
        dlg.toast(`Intrare dinamică: ${this.dyn.on ? "pornită" : "oprită"}`, 1500);
        return;
      }
      const fk = { F3: "on", F8: "ortho", F10: "polar", F11: "tracking" }[e.key];
      if (fk) {
        e.preventDefault();
        this.toggleSnapFlag(fk);
        return;
      }
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.doRedo();
        else this.doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        this.doRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "s") {
        e.preventDefault();
        if (this.doc) dlg.exportDialog(this);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "f") {
        e.preventDefault();
        if (this.doc) dlg.textDialog(this);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "a") {
        e.preventDefault();
        if (this.doc) this.selectMany(this.visibleBuilt().map(({ a }) => a.id));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "c") {
        if (this.copySelected()) e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "v") {
        e.preventDefault();
        this.paste(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "d") {
        e.preventDefault();
        if (this.copySelected(true)) this.paste(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // în timpul unei comenzi, cifrele merg în lungimea de lângă cursor (intrarea dinamică)
      if (this.dyn && this.dynKey(e)) {
        e.preventDefault();
        return;
      }
      const autocad = this.keyCfg && this.keyCfg.mode === "autocad";
      // modul AutoCAD: literele și cifrele scriu comanda (Shift+F rămâne zoom pe selecție)
      if (autocad && e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !(e.shiftKey && k === "f") && !this.mmenu) {
        e.preventDefault();
        this.focusCmdLine(e.key);
        return;
      }
      if (e.key === " ") {
        if (!this.space) {
          this.spaceAt = Date.now();
          this.spaceDragged = false;
        }
        this.space = true;
        $("canvas").style.cursor = "grab";
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !this.clicks.length && !this.mmenu) {
        // fără nimic în lucru: AutoCAD repetă ultima comandă; în modul cu taste directe,
        // Enter deschide linia de comandă
        e.preventDefault();
        if (autocad) this.repeatCmd();
        else this.focusCmdLine();
        return;
      }
      if (e.key === "Escape" && this.mmenu) {
        this.closeMarkingMenu();
        return;
      }
      if (e.key === "Escape" || (e.key === "Enter" && this.clicks.length)) {
        this.escape();
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && autocad && !this.sel.size && !this.clicks.length) {
        // ca în AutoCAD: săgeata sus aduce ultimele comenzi în linia de comandă
        e.preventDefault();
        if (this.focusCmdLine("") && this._cmdBrowse) this._cmdBrowse(e.key === "ArrowUp" ? 1 : -1);
        return;
      }
      if (e.key.startsWith("Arrow") && this.sel.size) {
        // deplasare fină: 0,5 mm, cu Shift 5 mm
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 0.5) * K;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        this.pushHistory("nudge");
        for (const a of this.selectedAll()) moveAnnot(a, dx, dy);
        this.changed();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        this.deleteSelected();
        e.preventDefault();
        return;
      }
      if (k === "f") {
        // Shift+F: zoom pe selecție; F: toată pagina
        if (e.shiftKey) this.zoomSelection();
        else this.view.fit();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        this.view.zoomAt(1.25, this.view.cw / 2, this.view.ch / 2);
        return;
      }
      if (e.key === "-") {
        this.view.zoomAt(0.8, this.view.cw / 2, this.view.ch / 2);
        return;
      }
      if (e.key === "PageDown" && this.doc && this.page < this.doc.pages.length - 1) this.setPage(this.page + 1);
      if (e.key === "PageUp" && this.doc && this.page > 0) this.setPage(this.page - 1);
      const id = !autocad && this.keyMap ? this.keyMap[k] : null;
      if (id && this.doc) this.setTool(id);
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === " ") {
        // modul AutoCAD: Spațiu apăsat scurt (fără tragere) = Enter: termină sau repetă comanda
        const tap = this.space && !this.spaceDragged && Date.now() - (this.spaceAt || 0) < 300;
        if (tap && this.keyCfg && this.keyCfg.mode === "autocad" && !dlg.isModalOpen()) {
          const tag = document.activeElement && document.activeElement.tagName;
          if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
            if (this.clicks.length) this.escape();
            else this.repeatCmd();
          }
        }
        this.space = false;
        $("canvas").style.cursor = this.tool === "pan" ? "grab" : this.tool === "select" ? "default" : "crosshair";
      }
    });
  }
}

const app = new App();
window.drawcad = app; // pentru depanare din consolă
window.cotare = app; // numele vechi, folosit de testele e2e
app.init();
