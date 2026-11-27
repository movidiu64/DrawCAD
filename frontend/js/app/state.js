// Document state, undo / redo, autosave and adding annotations.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { nextRev } from "../revision.js";
import { build, derive, hit, fmtNum, onBoxEdge } from "../annots.js";
import * as dlg from "../dialogs.js";
import { today, $, hashStr } from "./util.js";

const UNSAVED_KEY = "drawcad.unsaved";

export class StateHistory {
  // ------------------------------------------------------------ state and history
  stateJson() {
    return { v: 1, settings: this.settings, annots: this.annots };
  }

  /**
   * Saves the open document now when it has a change the server has not confirmed: one waiting for
   * its timer, or one whose save failed. Before another document replaces it, so nothing is lost.
   */
  async flushSave() {
    if (!this.doc || !(this.saveTimer || (this.unsaved && this.unsaved.has(this.doc.id)))) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!(await this.saveNow(this.doc.id, this.stateJson()))) dlg.toast("Salvare eșuată: modificările se păstrează aici și se trimit din nou automat.", 6000);
  }

  /**
   * Sends one document's state; until the server confirms it, the state is kept here (`unsaved`) and
   * sent again every 5 s — also after switching to another document. Resolves to true when saved.
   */
  async saveNow(id, json) {
    this.unsaved = this.unsaved || new Map();
    this.unsaved.set(id, json);
    this.keepUnsaved();
    const cur = () => this.doc && this.doc.id === id;
    if (cur()) this.setSaveState("saving");
    try {
      await api.saveState(id, json);
      if (this.unsaved.get(id) === json) this.unsaved.delete(id);
      this.keepUnsaved();
      if (cur() && !this.saveTimer && !this.unsaved.has(id)) this.setSaveState("saved");
      return true;
    } catch (e) {
      if (e.status === 404) {
        // the document is gone (deleted, expired): there is nowhere to save it
        this.unsaved.delete(id);
        this.keepUnsaved();
        return false;
      }
      if (cur()) this.setSaveState("error", e.message);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.retrySaves(), 5000);
      return false;
    }
  }

  /** The states not confirmed yet, also in this browser's storage: a closed tab or a crash keeps them
   *  until the next start (restoreUnsaved). */
  keepUnsaved() {
    try {
      if (this.unsaved && this.unsaved.size) {
        const now = Date.now();
        const out = {};
        for (const [id, state] of this.unsaved) out[id] = { state, t: now };
        localStorage.setItem(UNSAVED_KEY, JSON.stringify(out));
      } else localStorage.removeItem(UNSAVED_KEY);
    } catch (_) { /* storage full or unavailable: kept in memory only */ }
  }

  /**
   * At start: states a previous session could not save are sent again (and shown with their document),
   * unless the server has a newer state of that document (saved since from another browser).
   */
  async restoreUnsaved() {
    this.unsaved = new Map();
    let v = {};
    try {
      v = JSON.parse(localStorage.getItem(UNSAVED_KEY) || "{}") || {};
    } catch (_) { /* nothing kept */ }
    for (const [id, e] of Object.entries(v)) {
      if (!/^[a-f0-9]{32}$/.test(id) || !e || !e.state || !Array.isArray(e.state.annots)) continue;
      try {
        const r = await fetch(`api/doc/${id}`);
        if (!r.ok) continue; // gone
        const meta = await r.json();
        if ((Number(meta.updated) || 0) * 1000 > (Number(e.t) || 0)) continue; // newer on the server
      } catch (_) { /* server unreachable: kept, sent when it answers */ }
      this.unsaved.set(id, e.state);
    }
    this.keepUnsaved();
    if (this.unsaved.size) setTimeout(() => this.retrySaves(), 1000);
  }

  /** Something the server has not confirmed (asked before the page closes). */
  hasUnsaved() {
    if (this.unsaved && this.unsaved.size) return true;
    // a waiting save too large for the page-close beacon (64 kB)
    return !!(this.saveTimer && this.doc && JSON.stringify(this.stateJson()).length > 60000);
  }

  /** Every state not yet confirmed, sent again (the open document's as it is now). */
  retrySaves() {
    for (const [id, json] of [...(this.unsaved || new Map())]) {
      if (this.doc && this.doc.id === id) {
        if (this.saveTimer) continue; // its own timer sends the newest state
        this.saveNow(id, this.stateJson());
      } else this.saveNow(id, json);
    }
  }

  /** The state of a document that the server has not confirmed yet (newer than the server's), or null. */
  unsavedState(id) {
    return (this.unsaved && this.unsaved.get(id)) || null;
  }

  flushSaveBeacon() {
    // the page is going away: every state not confirmed goes as a beacon, the open document's as it is now
    const out = new Map(this.unsaved || []);
    if (this.doc && (this.saveTimer || out.has(this.doc.id))) out.set(this.doc.id, this.stateJson());
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    for (const [id, json] of out) {
      const blob = new Blob([JSON.stringify(json)], { type: "application/json" });
      navigator.sendBeacon(`api/doc/${id}/state`, blob);
    }
  }

  markExported() {
    this.unexported = false;
    // this revision is out: the first change of a later session starts the next one
    this.settings = { ...this.settings, exportedRev: String(this.settings.revNo || "1") };
    this.revPending = false;
    this.scheduleSave();
  }

  async closeDoc() {
    if (!this.doc) return;
    await this.flushSave();
    if (this.unexported && this.annots.length) dlg.closeDialog(this);
    else this.doClose();
  }

  doClose() {
    const id = this.doc && this.doc.id;
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
    $("legend").hidden = true;
    this.renderCtx();
    $("docName").textContent = "Niciun document";
    $("docMeta").textContent = "";
    document.title = "DrawCAD — editor PDF pentru desene tehnice";
    try {
      localStorage.removeItem("cotare.lastDoc");
    } catch (_) { /* storage unavailable */ }
    this.setTool("select");
    this.panel.render();
    this.updateButtons();
    this.refreshRecent();
    // other documents open as tabs: the neighbouring one is shown
    if (id) this.afterClose(id);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    const id = this.doc && this.doc.id;
    if (!id) return;
    this.setSaveState("pending");
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // no network / server down: kept and sent again automatically, nothing is lost in the browser
      if (this.doc && this.doc.id === id) this.saveNow(id, this.stateJson());
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

  /** Short description for the annotation list. */
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
      case "ord":
        return `${a.axis === "y" ? "Y" : "X"}: ${((b && b.values) || []).map((v) => fmtNum(v, this.settings.sep || ",", 2)).join(" · ")}`.slice(0, 48);
      case "strike":
        return a.newText ? `→ ${a.newText}` : "tăiată";
      case "rough":
        return a.val || "";
      case "revtab":
      case "bom":
        return `${(a.rows || []).length} rânduri`;
      case "holes":
        return `${(a.rows || []).length} găuri`;
      default:
        return "";
    }
  }

  /** Every annotation under the point, the topmost first (for selection cycling). */
  annotsAt(raw) {
    const tol = 5 / this.view.zoom;
    const items = this.visibleBuilt();
    const out = [];
    for (let i = items.length - 1; i >= 0; i--) if (hit(items[i].built, items[i].a, raw, tol)) out.push(items[i].a);
    return out;
  }

  annotAt(raw) {
    const tol = 5 / this.view.zoom;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) if (hit(items[i].built, items[i].a, raw, tol)) return items[i].a;
    return null;
  }

  /** Selects the annotation and brings it to the center of the screen. */
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
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    const now = Date.now();
    if (key && this.lastHistKey === key && now - this.lastHistTime < 1500) {
      this.lastHistTime = now;
      return;
    }
    this.lastHistKey = key;
    this.lastHistTime = now;
    this.undo.push(JSON.stringify(this.annots));
    // at most 200 steps and ~20 million characters (with thousands of annotations every step is large)
    let chars = this.undo.reduce((n, st) => n + st.length, 0);
    while (this.undo.length > 1 && (this.undo.length > 200 || chars > 20e6)) chars -= this.undo.shift().length;
    this.redo = [];
    this.updateButtons();
  }

  changed() {
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    this.followFrames();
    this.bumpRevision();
    this.unexported = true;
    this.view.redraw();
    this.view.loadImage(false); // reload only if the original's blackening changed
    this.scheduleSave();
    this.updateButtons();
  }

  /** First change after opening a document whose revision was already exported (from the exported
   * PDF, or from Recent after an export): the revision goes up by one, once per session. Repeated
   * exports within a session keep their number. */
  bumpRevision() {
    if (!this.revPending || !this.doc) return;
    this.revPending = false;
    const S = this.settings;
    if (S.autoRev === false || S.exportedRev == null || String(S.exportedRev) !== String(S.revNo || "1")) return;
    const old = S.revNo || "1";
    this.settings = { ...S, revNo: nextRev(old), revDate: today() };
    this.cache.clear();
    this.panel.render();
    dlg.toast(`Revizie nouă: rev ${this.settings.revNo} (rev ${old} era deja exportată). O schimbi în Setări → Foaie și revizii.`, 6000);
  }

  /** Datum triangles placed on the border of a GD&T frame stay on it when the frame moves or grows;
   * one moved off the border lets go. */
  followFrames() {
    const datums = this.annots.filter((a) => a.type === "datum");
    if (!datums.length) return;
    const frames = new Map();
    for (const f of this.annots) {
      if (f.type !== "gdt") continue;
      const b = this.builtOf(f).frame;
      if (b) frames.set(f.id, { f, b });
    }
    let moved = false;
    for (const d of datums) {
      const fr = d.on && frames.get(d.on);
      if (fr && fr.f.page === d.page) {
        if (onBoxEdge(d.target, fr.b)) {
          d.onBox = [...fr.b];
          continue;
        }
        if (d.onBox && onBoxEdge(d.target, d.onBox)) {
          // the frame moved (or changed width): the datum keeps its place along the border
          const ox = d.target[0] - d.onBox[0];
          const oy = d.target[1] - d.onBox[1];
          const wOld = d.onBox[2] - d.onBox[0];
          const fx = wOld > 0 ? ox / wOld : 0;
          const nx = fr.b[0] + fx * (fr.b[2] - fr.b[0]);
          const ny = Math.abs(oy) < 0.7 ? fr.b[1] : Math.abs(d.target[1] - d.onBox[3]) < 0.7 ? fr.b[3] : fr.b[1] + oy;
          const dx = nx - d.target[0];
          const dy = ny - d.target[1];
          d.target = [nx, ny];
          d.pos = [d.pos[0] + dx, d.pos[1] + dy];
          d.onBox = [...fr.b];
          moved = true;
          continue;
        }
      }
      delete d.on;
      delete d.onBox;
      for (const { f, b } of frames.values()) {
        if (f.page === d.page && onBoxEdge(d.target, b)) {
          d.on = f.id;
          d.onBox = [...b];
          break;
        }
      }
    }
    if (moved) this.frame += 1;
  }

  doUndo() {
    if (!this.undo.length || this._pageBusy) return;
    // a page operation (rotate, delete, move, scale): its entry is an object, not a list of annotations
    if (this.undo[this.undo.length - 1][0] === "{") return this.pageHistory(this.undo.pop(), this.redo, this.undo);
    this.redo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.undo.pop());
    this.lastHistKey = null;
    this.sel = new Set([...this.sel].filter((id) => this.annots.some((a) => a.id === id)));
    if (!this.selected()) this.selectedId = this.sel.size ? [...this.sel][0] : null;
    this.panel.render();
    this.changed();
  }

  doRedo() {
    if (!this.redo.length || this._pageBusy) return;
    if (this.redo[this.redo.length - 1][0] === "{") return this.pageHistory(this.redo.pop(), this.undo, this.redo);
    this.undo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.redo.pop());
    this.lastHistKey = null;
    this.sel = new Set([...this.sel].filter((id) => this.annots.some((a) => a.id === id)));
    if (!this.selected()) this.selectedId = this.sel.size ? [...this.sel][0] : null;
    this.panel.render();
    this.changed();
  }

  setSettings(patch) {
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    if ("revNo" in patch && String(patch.revNo) !== String(this.settings.revNo || "1")) this.revPending = false;
    const inkBefore = JSON.stringify(this.settings.ink || null);
    // a drawing opened from DXF / DWG: a scale set by hand belongs to the current page's layout
    const p = this.doc && this.doc.dxf && this.doc.pages[this.page];
    if ("scale" in patch && p && p.src != null) patch = { ...patch, scaleBySrc: { ...(this.settings.scaleBySrc || {}), [p.src]: Number(patch.scale) || 1 } };
    this.settings = { ...this.settings, ...patch };
    this.cache.clear();
    this.panel.render();
    this.changed();
    if (JSON.stringify(this.settings.ink || null) !== inkBefore) this.view.loadImage(true);
  }

  /** Render parameters of the page: blackening of the original (whole drawing or chosen objects). */
  /** Real removals on page n, as render operations (the editor shows the export result). */
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
    // page version (rotation, order): old renders from the browser cache are no longer used
    let q = this.doc && this.doc.lv ? `&v=${this.doc.lv}` : "";
    if (ink && ink.all) q += `&ink=1&fills=${ink.fills || "black"}${ink.images ? "&img=1" : ""}`;
    else {
      const ids = this.annots.filter((a) => a.type === "ink" && a.page === n).flatMap((a) => a.ids || []);
      if (ids.length) q += `&bk=${encodeURIComponent([...new Set(ids)].join(","))}`;
    }
    return q;
  }

  // ------------------------------------------------------------ annotations
  /** Drawing scale of page i: a drawing opened from DXF / DWG keeps one per layout (a scale set by
   *  hand on a page stays with that page); any other document has one for all its pages. */
  pageScale(i = this.page) {
    const p = this.doc && this.doc.pages[i];
    const by = this.settings.scaleBySrc;
    if (p && p.src != null && by && by[p.src] != null) return Number(by[p.src]) || 1;
    if (p && p.dscale > 0) return p.dscale;
    return Number(this.settings.scale) || 1;
  }

  S(page = this.page) {
    // the page sizes too: a title block shows its sheet format and "sheet n / total"
    const pagesWH = this.doc ? this.doc.pages.map((p) => [p.w, p.h]) : [];
    const scale = this.pageScale(page);
    const key = JSON.stringify(this.settings) + JSON.stringify(pagesWH) + "|" + scale;
    this._Sm = this._Sm || new Map();
    let S = this._Sm.get(key);
    if (!S) {
      if (this._Sm.size > 32) this._Sm.clear();
      S = { ...derive({ ...this.settings, scale }), pagesWH, _key: key };
      this._Sm.set(key, S);
    }
    this._Skey = key;
    return S;
  }

  builtOf(a) {
    const S = this.S(a.page);
    const c = this.cache.get(a.id);
    // within the same event (one mouse move, one frame) geometry does not change: no JSON.stringify
    if (c && c.frame === this.frame && c.obj === a) return c.built;
    const stamp = JSON.stringify(a) + S._key;
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
    if (a.type === "comment") return "review";
    return a.layer === "rev" ? "rev" : "add";
  }

  /** Annotations of the current page, without layers hidden on screen. */
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
    } catch (_) { /* not remembered */ }
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

  /** Selected annotations (one or more), in document order. */
  selectedAll() {
    return this.annots.filter((a) => this.sel.has(a.id));
  }

  isSelected(id) {
    return this.sel.has(id);
  }

  select(id) {
    this.hotSet = null;
    this.selectedId = id;
    this.sel = new Set(id ? [id] : []);
    this.panel.render();
    this.view.redraw();
    if (this.compact()) {
      // on small screens the panel opens by itself only when there is something to type or an annotation is picked
      const a = id && this.annots.find((x) => x.id === id);
      const typing = a && ["text", "note", "lead", "strike", "revtab", "bom", "holes", "gdt", "rough", "balloon", "datum"].includes(a.type);
      if (!id) this.setPanelOpen(false);
      else if (this.tool === "select" || typing) this.setPanelOpen(true);
    }
  }

  selectMany(ids, add = false) {
    this.hotSet = null;
    const next = add ? new Set(this.sel) : new Set();
    for (const id of ids) next.add(id);
    this.sel = next;
    this.selectedId = next.size ? [...next][next.size - 1] : null;
    this.panel.render();
    this.view.redraw();
  }

  /** Replaces the selection by a set (from the selection rules). */
  setSelection(next) {
    this.sel = new Set(next);
    this.selectedId = this.sel.size ? [...this.sel][this.sel.size - 1] : null;
    this.panel.render();
    this.view.redraw();
    if (this.selPrompt) this.updateCmdPrompt();
  }

  /** AutoCAD selection (click adds, Shift removes): at a Select objects prompt, or chosen. */
  pickAdd() {
    return !!(this.selPrompt || (this.keyCfg && this.keyCfg.mode === "autocad" && this.keyCfg.pickadd));
  }
}
