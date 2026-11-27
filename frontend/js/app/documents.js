// Documents (open, recent, close) and text search / OCR.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { Snapper } from "../osnap.js";
import * as dlg from "../dialogs.js";
import { applyPageOp } from "../pages.js";
import { tr } from "../i18n.js";
import { $, esc } from "./util.js";
import { scaleText } from "../tblock.js";
import { fmtNum } from "../annots.js";

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
      else if (meta.dxf) dlg.toast(this.dxfOpenedText(meta), 9000);
      else dlg.toast(meta.fromExport ? "Export anterior: cotele au fost reîncărcate editabile." : `Deschis: ${meta.name}`);
    } catch (e) {
      dlg.toast(`Nu s-a putut deschide: ${e.message}`, 6000);
    }
  }

  /** What came out of a DXF: the pages (layouts or model space on a sheet) and their scale. */
  dxfOpenedText(meta) {
    const pg = meta.dxf.pages || [];
    const k = pg[0].scale;
    const sc = k >= 1 ? `1:${fmtNum(k, ",", 3)}` : `${fmtNum(1 / k, ",", 3)}:1`;
    let what;
    if (pg.length === 1 && pg[0].space === "model" && pg[0].frame) what = `foaia din desen, ${pg[0].iso}, scara ${sc}`;
    else if (pg.length === 1 && pg[0].space === "model" && pg[0].iso) what = `spațiul model pe ${pg[0].iso}, scara ${sc}`;
    else if (pg.length === 1 && pg[0].space === "model") what = `pagina exportată din DrawCAD, scara ${sc}`;
    else if (pg.length === 1) what = `planșa ${pg[0].name}; scara ${sc}`;
    else what = `planșe: ${pg.map((p) => p.name).join(", ")}; scara ${sc}`;
    const n = (meta.dxf.fixes || 0) + (meta.dxf.errors || 0);
    const fonts = meta.dxf.fonts_missing || [];
    // each remark translated on its own: together they would not match one English entry
    const fix = [
      n ? `Fișierul avea ${n} erori, reparate la citire.` : "",
      meta.dxf.inventor ? "Desen salvat din Inventor: vederile, chenarul și indicatorul au fost așezate din nou din blocurile lui." : "",
      fonts.length ? `Fonturi înlocuite cu osifont: ${fonts.join(", ")}; le poți adăuga din Setări → Fonturi DXF / DWG.` : "",
      meta.dxf.gdt_symbols ? "Simbolurile GD&T (font AIGDT / GDT) au fost convertite." : "",
      meta.dxf.acis === 1 ? "Desenul are un solid 3D (ACIS), pe care DrawCAD nu îl poate desena: apare doar geometria 2D." : "",
      meta.dxf.acis > 1 ? `Desenul are ${meta.dxf.acis} solide 3D (ACIS), pe care DrawCAD nu le poate desena: apare doar geometria 2D.` : "",
      meta.dxf.views_3d === 1 ? "O vedere 3D dintr-o planșă rămâne goală: se desenează doar vederile de sus." : "",
      meta.dxf.views_3d > 1 ? `${meta.dxf.views_3d} vederi 3D din planșe rămân goale: se desenează doar vederile de sus.` : "",
      meta.dxf.insunits === 1 ? "Unitățile din fișier sunt inch; dacă desenul e în mm, alege mm în Straturi → Desen DXF / DWG." : "",
    ].filter(Boolean).map((t) => ` ${tr(t)}`).join("");
    return `Deschis: ${meta.name} — ${what}. Scara desenului e luată din fișier.${fix}`;
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
    // another document was open: it stays as a tab (UI-D4a), what lives only here is kept for it
    if (this.doc && this.doc.id !== meta.id) {
      this._tabFrom = this._tabFrom || this.doc.id;
      this.leaveDoc(meta.id);
      // a command in progress belongs to the document it started on (its U would undo the other one)
      if (this.tool !== "select") this.setTool("select");
    }
    // changes the server has not confirmed yet (a save failed) are newer than what it sent
    const mine = this.unsavedState(meta.id);
    if (mine) state = mine;
    this.compare = null;
    this.doc = meta;
    localStorage.setItem("cotare.lastDoc", meta.id);
    this.annots = (state && state.annots) || [];
    this.settings = { ...dlg.storedDefaults(), ...((state && state.settings) || {}) };
    // a DXF: the drawing scale comes from the file (the first page's layout or the fitted sheet)
    if (!(state && state.settings && state.settings.scale) && meta.dxf && meta.dxf.pages && meta.dxf.pages[0]) {
      this.settings.scale = meta.dxf.pages[0].scale;
    }
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
    this.setSaveState(mine ? "error" : state ? "saved" : "");
    $("docName").textContent = meta.name;
    $("docMeta").textContent = `${{ image: "imagine", dxf: "DXF", dwg: "DWG" }[meta.kind] || "PDF"} · ${meta.pages.length} ${meta.pages.length === 1 ? "pagină" : "pagini"}`;
    document.title = `${meta.name} — DrawCAD`;
    this.setPage(0);
    this.updateButtons();
    this.enterDoc(meta);
    // the first document ever opened here: three short tips (rail, command line, panel), once
    setTimeout(() => dlg.firstRunTips(), 600);
  }

  setPage(n) {
    if (!this.doc) return;
    if (this.compare && this.compare.page !== n) this.compare = null;
    if (this.cmpPick && this.cmpPick.page !== n) this.cmpPick = null;
    this.page = n;
    this.clicks = [];
    this.selectedId = null;
    this.sel = new Set();
    const p = this.doc.pages[n];
    // a drawing opened from DXF / DWG: each layout has its own scale, the tools follow the page shown
    if (this.doc.dxf) {
      const k = this.pageScale(n);
      if (k !== Number(this.settings.scale)) {
        this.settings = { ...this.settings, scale: k };
        this.cache.clear();
      }
    }
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

  /** Layers of a drawing opened from DXF / DWG, hidden or shown again: the server leaves them out of
   *  the page, snap, search and export, so the page is loaded again. */
  async setDxfHidden(hidden, colors = !!(this.doc && this.doc.dxf && this.doc.dxf.colors)) {
    if (!this.doc || !this.doc.dxf) return;
    if (colors && !this.doc.dxf.colors) dlg.toast("Desenul se reface color…", 4000);
    const res = await api.dxfLayers(this.doc.id, hidden, colors);
    this.doc.dxf.hidden = res.hidden;
    this.doc.dxf.colors = res.colors;
    this.doc.lv = res.lv;
    this.unexported = true;
    this.setPage(this.page);
  }

  /** The drawing read again in other units (an inch template drawn in mm, or the reverse): a new document;
   *  the old one is removed when it has no annotations, otherwise it stays in the list. */
  async setDxfUnits(units) {
    if (!this.doc || !this.doc.dxf) return;
    const old = this.doc;
    const keep = this.annots.length > 0;
    await this.flushSave();
    dlg.toast(units === "mm" ? "Desenul se citește din nou în mm…" : "Desenul se citește din nou în inch…", 15000);
    const meta = await api.dxfUnits(old.id, units);
    this.setDoc(meta, meta.state);
    if (!keep) {
      api.deleteDoc(old.id).catch(() => {});
      if (this._sessions) this._sessions.delete(old.id);
      this.forgetTab(old.id);
    }
    dlg.toast(`${this.dxfOpenedText(meta)}${keep ? ` ${tr("Documentul de dinainte, cu adnotările lui, rămâne în lista de documente.")}` : ""}`, 9000);
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
    // a drawing opened from DXF / DWG: the layout names (Model, Sheet, Plansa 1…)
    const label = (p, i) => (p.name ? `<span translate="no">${esc(p.name.length > 24 ? `${p.name.slice(0, 23)}…` : p.name)}</span>` : `Pagina ${i + 1}`);
    const tabs = this.doc.pages.map((p, i) => `<button class="${i === this.page ? "on" : ""}" data-pg="${i}"${p.name ? ` title="${esc(p.name)} · ${esc(scaleText(this.pageScale(i)))}"` : ""}>${label(p, i)}</button>`).join("");
    const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    const ops = `<span class="pgops">
      <button class="mini" data-pgop="rl" title="Rotește pagina la stânga (ROTL)" aria-label="Rotește pagina la stânga">${ico("M4 4v6h6M4.6 15a8 8 0 1 0 1.9-8.3L4 10")}</button>
      <button class="mini" data-pgop="rr" title="Rotește pagina la dreapta (ROTR)" aria-label="Rotește pagina la dreapta">${ico("M20 4v6h-6M19.4 15a8 8 0 1 1-1.9-8.3L20 10")}</button>
      <button class="mini" data-pgop="dlg" title="Pagini: rotire, ordine, ștergere (PAGES)" aria-label="Pagini">${ico("M5 3h9l5 5v13H5zM14 3v5h5")}</button></span>`;
    // many pages (a DWG with 20 layouts): the tabs scroll sideways (wheel, arrows) without a scrollbar
    // over them; the page buttons stay in place
    const box = $("pageTabs");
    const left = box.querySelector(".pgscroll")?.scrollLeft || 0;
    const arr = (d, t) => `<button class="pgarr" data-pgstep="${d}" title="${t}" aria-label="${t}">${ico(d < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7")}</button>`;
    box.innerHTML = `${arr(-1, "Filele din stânga")}<div class="pgscroll">${tabs}</div>${arr(1, "Filele din dreapta")}${ops}`;
    $("legend").hidden = false;
    const sc = box.querySelector(".pgscroll");
    sc.scrollLeft = left;
    const on = sc.querySelector("button.on");
    if (on && (on.offsetLeft < sc.scrollLeft || on.offsetLeft + on.offsetWidth > sc.scrollLeft + sc.clientWidth)) {
      sc.scrollLeft = on.offsetLeft - (sc.clientWidth - on.offsetWidth) / 2;
    }
    const ends = () => box.querySelectorAll("[data-pgstep]").forEach((b) => {
      b.disabled = b.dataset.pgstep < 0 ? sc.scrollLeft <= 0 : sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 1;
    });
    const fit = () => {
      box.classList.toggle("ovf", sc.scrollWidth > sc.clientWidth + 1);
      ends();
    };
    fit();
    this._tabsFit = fit;
    sc.addEventListener("scroll", ends, { passive: true });
    if (!this._tabsRO && window.ResizeObserver) {
      // the bar may still be hidden at the first render (no width yet), or the window resized
      this._tabsRO = new ResizeObserver(() => this._tabsFit?.());
      this._tabsRO.observe(box);
    }
    sc.addEventListener("wheel", (e) => {
      if (sc.scrollWidth <= sc.clientWidth) return;
      e.preventDefault();
      sc.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    }, { passive: false });
    box.querySelectorAll("[data-pgstep]").forEach((b) => b.addEventListener("click", () => {
      sc.scrollBy({ left: Number(b.dataset.pgstep) * sc.clientWidth * 0.8, behavior: "smooth" });
    }));
    box.querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => this.setPage(Number(b.dataset.pg))));
    box.querySelectorAll("[data-pgop]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.pgop;
      if (k === "dlg") dlg.pagesDialog(this);
      else this.pageOp({ op: "rotate", pages: [this.page], delta: k === "rr" ? 90 : -90 }).catch((e) => dlg.toast(e.message));
    }));
  }

  /** Rotating / deleting / moving / scaling pages: annotations are transformed along with the page,
   *  and the server receives the new state together with the operation. The operation is a history step:
   *  the entry holds the page layout, annotations and settings from before it, so Ctrl+Z brings the
   *  pages back (a deleted page too: the uploaded file never changes).
   *  `hist` = an entry from the history being undone / redone: { pages, annots, settings, page, stack }. */
  async pageOp(op, hist = null) {
    if (!this.doc || this._pageBusy) return;
    const n = this.doc.pages.length;
    const full = { ...op, count: n, sizes: this.doc.pages.map((p) => [p.w, p.h]) };
    const S = this.S();
    const annots = hist ? hist.annots : applyPageOp(this.annots, full, S, this.measure);
    const before = { annots: this.annots, settings: this.settings, page: this.page };
    this._pageBusy = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      // sheet enlarged k times: the same real dimension means k times more paper mm
      let settings = hist ? hist.settings : this.settings;
      if (!hist && op.op === "scale" && (op.pages == null || n === 1)) settings = { ...settings, scale: (Number(settings.scale) || 1) / op.factor };
      const res = await api.pageOp(this.doc.id, { ...op, state: { ...this.stateJson(), settings, annots } });
      this.annots = annots;
      // a comparison drawn for the page before the change would no longer line up
      if (this.compare) this.endCompare();
      if (settings !== this.settings) {
        this.settings = settings;
        this._S = null;
      }
      // the step for the other direction: the layout the server had before, with what we had
      const entry = JSON.stringify({ pages: res.prev, annots: before.annots, settings: before.settings, page: before.page });
      if (hist) hist.stack.push(entry);
      else {
        this.undo.push(entry);
        this.redo = [];
      }
      this.lastHistKey = null;
      this.cache.clear();
      this.doc.pages = res.pages;
      this.doc.lv = res.lv;
      this.ocrPages = new Set(res.ocrPages || []);
      this.ocr = new Map();
      let pg = this.page;
      if (hist) pg = hist.page;
      else if (op.op === "delete") pg = Math.min(pg - op.pages.filter((d) => d < pg).length, res.pages.length - 1);
      else if (op.op === "move") {
        const order = [...Array(n).keys()];
        order.splice(op.to, 0, order.splice(op.page, 1)[0]);
        pg = order.indexOf(this.page);
      }
      this.selectedId = null;
      this.sel = new Set();
      this.unexported = true;
      this.setSaveState("saved");
      $("docMeta").textContent = `${{ image: "imagine", dxf: "DXF", dwg: "DWG" }[this.doc.kind] || "PDF"} · ${res.pages.length} ${res.pages.length === 1 ? "pagină" : "pagini"}`;
      this.setPage(Math.min(Math.max(0, pg), res.pages.length - 1));
      this.panel.render();
      this.updateButtons();
    } finally {
      this._pageBusy = false;
    }
  }

  /** Undo / redo of a page operation: puts back the layout of a history entry (see pageOp). */
  pageHistory(entry, stack, back) {
    const st = JSON.parse(entry);
    this.pageOp({ op: "layout", layout: st.pages }, { annots: st.annots, settings: st.settings, page: st.page, stack }).catch((e) => {
      back.push(entry);
      this.updateButtons();
      dlg.toast(e.message);
    });
  }
}
