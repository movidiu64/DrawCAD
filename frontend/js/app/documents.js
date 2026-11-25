// Documents (open, recent, close) and text search / OCR.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { Snapper } from "../osnap.js";
import * as dlg from "../dialogs.js";
import { applyPageOp } from "../pages.js";
import { tr } from "../i18n.js";
import { $ } from "./util.js";

export class Documents {
  // ------------------------------------------------------------ documents
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
    this.compare = null;
    this.doc = meta;
    localStorage.setItem("cotare.lastDoc", meta.id);
    this.annots = (state && state.annots) || [];
    this.settings = { ...dlg.storedDefaults(), ...((state && state.settings) || {}) };
    this.ocr = new Map(); // page → OCR result (null = not recognized yet)
    this.ocrPages = new Set(meta.ocrPages || []);
    this.hit = null;
    this.undo = [];
    this.redo = [];
    this.cache.clear();
    this.selectedId = null;
    this.sel = new Set();
    this.unexported = false;
    // the first real change of this session starts a new revision if the current one was exported
    this.revPending = true;
    this.setSaveState(state ? "saved" : "");
    $("docName").textContent = meta.name;
    $("docMeta").textContent = `${meta.kind === "image" ? "imagine" : "PDF"} · ${meta.pages.length} ${meta.pages.length === 1 ? "pagină" : "pagini"}`;
    document.title = `${meta.name} — DrawCAD`;
    this.setPage(0);
    this.updateButtons();
  }

  setPage(n) {
    if (!this.doc) return;
    if (this.compare && this.compare.page !== n) this.compare = null;
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
    this.pageTextBoxes(n);
    api.snap(this.doc.id, n, this.doc.lv || 0).then((s) => {
      if (this.page === n) this.snapper = new Snapper(s);
      if (this.page === n && this.snapCfg.scan) this.loadScanSnap(n);
    }).catch(() => {});
    if (this.showOcr && this.ocrPages.has(n)) this.loadOcr(n).catch(() => {});
  }

  /** A scanned page (no vector lines in the PDF). */
  isScanPage(n = this.page) {
    const p = this.doc && this.doc.pages[n];
    return !!(p && p.paths === 0);
  }

  /** Snap on a scan (option): the page is vectorized on the server once, then cached. */
  loadScanSnap(n = this.page) {
    if (!this.doc || !this.isScanPage(n)) return;
    const key = `${this.doc.id}:${n}`;
    this.scanSnaps = this.scanSnaps || new Map();
    const have = this.scanSnaps.get(key);
    if (have) {
      if (have.data && this.page === n) this.snapper = new Snapper(have.data);
      return;
    }
    const entry = { data: null };
    this.scanSnaps.set(key, entry);
    dlg.toast("Snap pe scanare: pagina se vectorizează (o dată, poate dura un minut)…", 6000);
    api.snapScan(this.doc.id, n).then((data) => {
      entry.data = data;
      if (this.page === n && this.snapCfg.scan) this.snapper = new Snapper(data);
      dlg.toast(`Snap pe scanare: gata — ${data.segs.length} linii, ${data.arcs.length} arce și cercuri`);
    }).catch((e) => {
      this.scanSnaps.delete(key);
      dlg.toast(`Snap pe scanare: ${e.message}`);
    });
  }

  /** Drawn shapes are scaled about their first point (on calibration, "keep their real
   *  dimensions"); dimensions are left alone, they measure the drawing. */
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

  // ------------------------------------------------------------ text and OCR
  /** Recognized text of page n (from cache, from the server, or — with run — recognized now). */
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

  /** Shows a found text: its page, zoomed on it, with a frame that fades out. */
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
    $("pageTabs").innerHTML = `${tabs}${ops}`;
    $("legend").hidden = false;
    $("pageTabs").querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => this.setPage(Number(b.dataset.pg))));
    $("pageTabs").querySelectorAll("[data-pgop]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.pgop;
      if (k === "dlg") dlg.pagesDialog(this);
      else this.pageOp({ op: "rotate", pages: [this.page], delta: k === "rr" ? 90 : -90 }).catch((e) => dlg.toast(e.message));
    }));
  }

  /** Rotating / deleting / moving pages: annotations (and the undo history) are transformed along
   *  with the page, and the server receives the new state together with the operation. */
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
      // sheet enlarged k times: the same real dimension means k times more paper mm
      let settings = this.settings;
      if (op.op === "scale" && (op.pages == null || n === 1)) settings = { ...settings, scale: (Number(settings.scale) || 1) / op.factor };
      const res = await api.pageOp(this.doc.id, { ...op, state: { ...this.stateJson(), settings, annots } });
      this.annots = annots;
      // a comparison drawn for the page before the change would no longer line up
      if (this.compare) this.endCompare();
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
}
