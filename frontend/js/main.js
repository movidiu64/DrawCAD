// Aplicația: stare, unelte, evenimente, salvare, export.
import * as api from "./api.js";
import { build, derive, hit, setHandle, moveAnnot, annotSnapPoints, exportPrims, K, fmtNum, newId } from "./annots.js";
import { View, SnapIndex, COLORS } from "./view.js";
import { Panel } from "./panel.js";
import { TOOLS, TOOL_BY_ID, TOOL_BY_KEY, finalize } from "./tools.js";
import * as dlg from "./dialogs.js";

const $ = (id) => document.getElementById(id);
const DATUM_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"; // ISO 5459: fără I, O, Q

class App {
  constructor() {
    this.doc = null;
    this.page = 0;
    this.annots = [];
    this.settings = dlg.storedDefaults();
    this.selectedId = null;
    this.tool = "select";
    this.clicks = [];
    this.undo = [];
    this.redo = [];
    this.cache = new Map();
    this.snapIdx = new SnapIndex();
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
  }

  async init() {
    await document.fonts.load("16px osifont").catch(() => {});
    this.buildToolbar();
    this.bindUi();
    this.bindCanvas();
    this.bindKeys();
    this.panel.render();
    this.refreshRecent();
    this.setTool("select");
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
    $("tools").innerHTML = groups.map((g) => `<div class="grp">${g.name}</div><div class="grid">${g.tools.map((t) => `
      <button class="tool" data-tool="${t.id}" title="${t.label} (${t.key})"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span>${t.label}</span></button>`).join("")}</div>`).join("");
    $("tools").querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => this.setTool(b.dataset.tool)));
  }

  bindUi() {
    $("btnOpen").addEventListener("click", () => dlg.openDialog(this));
    $("btnOpen2").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) this.openFile(f, this.pendingDpi);
      this.pendingDpi = null;
    });
    $("btnExport").addEventListener("click", () => this.doc && dlg.exportDialog(this));
    $("btnSettings").addEventListener("click", () => this.doc && dlg.settingsDialog(this));
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
      $("recentList").innerHTML = dlg.recentHtml(docs);
      $("recentList").querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => this.loadDoc(b.dataset.doc)));
    } catch (_) { /* fără listă */ }
  }

  updateButtons() {
    const has = !!this.doc;
    $("btnExport").disabled = !has;
    $("btnSettings").disabled = !has;
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
  }

  setTool(id) {
    if (!TOOL_BY_ID[id]) return;
    this.tool = id;
    this.clicks = [];
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
      dlg.toast(meta.fromExport ? "Export anterior: cotele au fost reîncărcate editabile." : `Deschis: ${meta.name}`);
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
    this.undo = [];
    this.redo = [];
    this.cache.clear();
    this.selectedId = null;
    $("docName").textContent = meta.name;
    $("docMeta").textContent = `${meta.kind === "image" ? "imagine" : "PDF"} · ${meta.pages.length} ${meta.pages.length === 1 ? "pagină" : "pagini"}`;
    document.title = `${meta.name} — Cotare`;
    this.setPage(0);
    this.updateButtons();
  }

  setPage(n) {
    if (!this.doc) return;
    this.page = n;
    this.clicks = [];
    this.selectedId = null;
    const p = this.doc.pages[n];
    this.view.setPage(this.doc.id, n, p.w, p.h);
    this.renderTabs();
    this.panel.render();
    this.snapIdx = new SnapIndex();
    api.snap(this.doc.id, n).then((s) => {
      if (this.page === n) this.snapIdx = new SnapIndex(s.pts, s.segs);
    }).catch(() => {});
  }

  renderTabs() {
    const tabs = this.doc.pages.map((p, i) => `<button class="${i === this.page ? "on" : ""}" data-pg="${i}">Pagina ${i + 1}</button>`).join("");
    $("pageTabs").innerHTML = `${tabs}<span class="legend">Original: negru · Adăugat: albastru · Revizie: roșu</span>`;
    $("pageTabs").querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => this.setPage(Number(b.dataset.pg))));
  }

  // ------------------------------------------------------------ stare și istoric
  stateJson() {
    return { v: 1, settings: this.settings, annots: this.annots };
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    const id = this.doc && this.doc.id;
    if (!id) return;
    this.saveTimer = setTimeout(() => {
      api.saveState(id, this.stateJson()).catch((e) => dlg.toast(`Salvare automată eșuată: ${e.message}`));
    }, 700);
  }

  pushHistory(key) {
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
    this.view.redraw();
    this.scheduleSave();
    this.updateButtons();
  }

  doUndo() {
    if (!this.undo.length) return;
    this.redo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.undo.pop());
    this.lastHistKey = null;
    if (!this.selected()) this.selectedId = null;
    this.panel.render();
    this.changed();
  }

  doRedo() {
    if (!this.redo.length) return;
    this.undo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.redo.pop());
    this.lastHistKey = null;
    if (!this.selected()) this.selectedId = null;
    this.panel.render();
    this.changed();
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.cache.clear();
    this.panel.render();
    this.changed();
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
    const stamp = JSON.stringify(a) + this._Skey;
    const c = this.cache.get(a.id);
    if (c && c.stamp === stamp) return c.built;
    const built = build(a, S, this.measure);
    this.cache.set(a.id, { stamp, built });
    return built;
  }

  visibleBuilt() {
    return this.annots.filter((a) => a.page === this.page).map((a) => ({ a, built: this.builtOf(a) }));
  }

  selected() {
    return this.annots.find((a) => a.id === this.selectedId) || null;
  }

  select(id) {
    this.selectedId = id;
    this.panel.render();
    this.view.redraw();
  }

  updateSel(fn, key) {
    const a = this.selected();
    if (!a) return;
    this.pushHistory(key ? `${a.id}:${key}` : null);
    fn(a);
    this.changed();
  }

  addAnnot(a) {
    this.pushHistory();
    a.page = this.page;
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
    const a = this.selected();
    if (!a) return;
    this.pushHistory();
    this.annots = this.annots.filter((x) => x.id !== a.id);
    this.cache.delete(a.id);
    this.selectedId = null;
    this.panel.render();
    this.changed();
  }

  // ------------------------------------------------------------ copiere / lipire
  copySelected(silent) {
    const a = this.selected();
    if (!a) return false;
    if (a.type === "redact") {
      dlg.toast("Ștergerile din original țin de obiectele de sub ele și nu se copiază.");
      return false;
    }
    this.clip = JSON.stringify(a);
    try {
      localStorage.setItem("cotare.clip", this.clip);
    } catch (_) { /* stocare indisponibilă */ }
    if (!silent) dlg.toast("Copiat · Ctrl+V lipește la cursor");
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
    const src = JSON.parse(raw);
    delete src.id;
    const a = finalize(src);
    a.id = newId();
    a.page = this.page;
    const anchor = (build(a, this.S(), this.measure).handles || []).find((h) => h.p);
    let dx = 5 * K;
    let dy = 5 * K;
    const p = this.lastPt;
    const pg = this.doc.pages[this.page];
    if (!duplicate && anchor && p && p[0] >= 0 && p[1] >= 0 && p[0] <= pg.w && p[1] <= pg.h) {
      dx = p[0] - anchor.p[0];
      dy = p[1] - anchor.p[1];
    }
    moveAnnot(a, dx, dy);
    this.addAnnot(a);
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
      rows.push({ rev, desc: vals.length ? `Cote modificate: ${vals.join(", ")}` : "Cote modificate", date: today, name: this.settings.author || "" });
    }
    if (ensureOne && !rows.length && !existing.length) {
      rows.push({ rev: this.settings.revNo || "1", desc: "", date: today, name: this.settings.author || "" });
    }
    return rows;
  }

  defaultTol() {
    return { mode: "none" };
  }

  nextDatumLetter() {
    const used = new Set(this.annots.filter((a) => a.type === "datum").map((a) => a.letter));
    for (const ch of DATUM_LETTERS) if (!used.has(ch)) return ch;
    return "A";
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
    } else {
      const cur = this.annots.find((x) => x.id === a.id);
      if (cur) Object.assign(cur, patch);
    }
    this.panel.render();
    this.changed();
  }

  async exportPdf(filename, colorMode, embed) {
    const pages = {};
    const removals = {};
    for (const a of this.annots) {
      const prims = exportPrims(this.builtOf(a).prims);
      if (prims.length) (pages[a.page] = pages[a.page] || []).push(...prims);
      if (a.type === "redact") {
        const op = a.mode === "objects" ? { mode: "objects", ids: a.ids || [] } : { mode: a.mode, rect: a.r };
        if (a.mode !== "objects" || op.ids.length) (removals[a.page] = removals[a.page] || []).push(op);
      }
    }
    return api.exportPdf(this.doc.id, { filename, colorMode, embed, pages, removals, state: this.stateJson() });
  }

  // ------------------------------------------------------------ mouse
  snapPoint(raw, e, anchor) {
    const v = this.view;
    let pt = raw;
    let sn = null;
    if ($("stSnap").checked && !e.altKey) {
      const extra = [];
      for (const { a, built } of this.visibleBuilt()) {
        if (this.drag && this.drag.id === a.id) continue;
        extra.push(...annotSnapPoints(built));
      }
      sn = this.snapIdx.nearest(raw[0], raw[1], 10 / v.zoom, extra);
      if (sn) pt = sn.p;
    }
    if (!sn && anchor && (e.shiftKey || $("stOrtho").checked)) {
      const dx = Math.abs(raw[0] - anchor[0]);
      const dy = Math.abs(raw[1] - anchor[1]);
      pt = dx >= dy ? [raw[0], anchor[1]] : [anchor[0], raw[1]];
    }
    return { pt, sn };
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
      if (!this.doc) return;
      // tastele de unelte nu trebuie să ajungă într-un câmp din panou rămas activ
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      if (e.button === 1 || e.button === 2 || this.space || this.tool === "pan") {
        this.drag = { kind: "pan", sx, sy };
        cv.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const t = TOOL_BY_ID[this.tool];
      if (t.kind === "select") {
        this.startSelectDrag(raw, sx, sy);
        return;
      }
      const anchor = this.clicks[this.clicks.length - 1];
      const { pt } = this.snapPoint(raw, e, anchor);
      if (t.kind === "rect") {
        this.drag = { kind: "rect", start: pt };
        return;
      }
      if (t.kind === "clicks") {
        this.clicks.push(pt);
        if (this.clicks.length >= t.n) {
          const pts = this.clicks;
          this.clicks = [];
          this.view.overlay = null;
          if (t.id === "calib") {
            const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / K;
            if (d > 0.1) dlg.calibDialog(this, d);
            return;
          }
          this.addAnnot(finalize(t.make(pts, this)));
        } else {
          this.updateOverlay(pt, null);
        }
      }
    });

    cv.addEventListener("pointermove", (e) => {
      if (!this.doc) return;
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      this.lastPt = raw;
      const d = this.drag;
      if (d && d.kind === "pan") {
        this.view.pan(sx - d.sx, sy - d.sy);
        d.sx = sx;
        d.sy = sy;
        return;
      }
      if (d && d.kind === "handle") {
        const { pt, sn } = this.snapPoint(raw, e, d.anchor);
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const a = this.annots.find((x) => x.id === d.id);
        setHandle(a, d.k, d.k === "tx" ? raw : pt, this.builtOf(a));
        this.view.overlay = { snap: d.k === "tx" ? null : sn };
        this.view.redraw();
        this.showCoords(pt);
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
        const a = this.annots.find((x) => x.id === d.id);
        moveAnnot(a, dx, dy);
        d.last = raw;
        this.view.redraw();
        return;
      }
      const t = TOOL_BY_ID[this.tool];
      if (t.kind === "select" || t.kind === "pan") {
        this.showCoords(raw);
        return;
      }
      const anchor = d && d.kind === "rect" ? d.start : this.clicks[this.clicks.length - 1];
      const { pt, sn } = this.snapPoint(raw, e, anchor);
      this.showCoords(pt, anchor);
      if (d && d.kind === "rect") {
        this.view.overlay = { rect: [d.start[0], d.start[1], pt[0], pt[1]], rectColor: t.id === "redact" ? COLORS.edred : COLORS.sel, snap: sn };
        this.view.redraw();
        return;
      }
      this.updateOverlay(pt, sn);
    });

    const up = (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.kind === "pan") {
        $("canvas").style.cursor = this.tool === "pan" ? "grab" : this.tool === "select" ? "default" : "crosshair";
        return;
      }
      if (d.kind === "handle" || d.kind === "move") {
        this.view.overlay = null;
        if (d.pushed) {
          this.panel.render();
          this.changed();
        }
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
        } else this.addAnnot(finalize(a));
      }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("pointerleave", () => {
      if (!this.drag && this.view.overlay && this.view.overlay.snap) {
        this.view.overlay.snap = null;
        this.view.redraw();
      }
    });
  }

  startSelectDrag(raw, sx, sy) {
    const v = this.view;
    const sel = this.selected();
    if (sel && sel.page === this.page) {
      const built = this.builtOf(sel);
      for (const h of built.handles || []) {
        if (!h.p) continue;
        const [hx, hy] = v.toScreen(h.p);
        if (Math.hypot(hx - sx, hy - sy) <= 9) {
          this.drag = { kind: "handle", id: sel.id, k: h.k, anchor: h.k === "p2" ? sel.p1 : h.k === "p1" ? sel.p2 : null };
          return;
        }
      }
    }
    const tol = 5 / v.zoom;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) {
      const { a, built } = items[i];
      if (hit(built, a, raw, tol)) {
        if (this.selectedId !== a.id) this.select(a.id);
        this.drag = { kind: "move", id: a.id, last: raw, sx, sy };
        return;
      }
    }
    if (this.selectedId) this.select(null);
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
    this.view.overlay = { prims, snap: sn };
    this.view.redraw();
    const t2 = TOOL_BY_ID[this.tool];
    if (this.clicks.length) this.setHint(`${t2.hint} · pas ${this.clicks.length + 1}/${t2.n} · Esc renunță`);
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
  bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (dlg.isModalOpen()) return;
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
      if (e.key === " ") {
        this.space = true;
        $("canvas").style.cursor = "grab";
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (this.clicks.length) {
          this.clicks = [];
          this.view.overlay = null;
          this.setHint(TOOL_BY_ID[this.tool].hint);
          this.view.redraw();
        } else if (this.selectedId) this.select(null);
        else this.setTool("select");
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        this.deleteSelected();
        e.preventDefault();
        return;
      }
      if (k === "f") {
        this.view.fit();
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
      const t = TOOL_BY_KEY[k];
      if (t && this.doc) this.setTool(t.id);
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === " ") {
        this.space = false;
        $("canvas").style.cursor = this.tool === "pan" ? "grab" : this.tool === "select" ? "default" : "crosshair";
      }
    });
  }
}

const app = new App();
window.cotare = app; // pentru depanare din consolă
app.init();
