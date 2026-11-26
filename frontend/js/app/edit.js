// ERASE, MOVE / COPY with base point, and copy / paste.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { diaAllowed } from "../gdt.js";
import { build, hit, holeTable, moveAnnot, exportPrims, K, newId } from "../annots.js";
import { TOOL_BY_ID, finalize } from "../tools.js";
import { windowSelection, pointInPolygon, boxInPolygon } from "../selection.js";
import * as dlg from "../dialogs.js";
import { VIEW_LETTERS } from "../symbols.js";
import { today, $, DATUM_LETTERS } from "./util.js";

export class Editing {
  // ------------------------------------------------------------ ERASE (CMD-D12)
  /** E / ERASE: deletes the selection, or asks for objects first. */
  erase() {
    if (!this.doc) return;
    if (this.sel.size) {
      this.deleteSelected();
      return;
    }
    if (this.tool !== "select") this.setTool("select");
    this.selPrompt = { cmd: "erase" };
    this.updateCmdPrompt();
  }

  /** The fence being drawn, with the rubber segment to the cursor. */
  drawFence(cur) {
    const f = this.selPrompt.fence;
    const pts = cur ? [...f, cur] : f;
    const prims = [];
    for (let i = 0; i + 1 < pts.length; i++) prims.push({ t: "L", p: [...pts[i], ...pts[i + 1]], w: 0.8, c: "sel", dash: true });
    if (this.selPrompt.fenceMode !== "f" && pts.length >= 3) prims.push({ t: "L", p: [...pts[pts.length - 1], ...pts[0]], w: 0.8, c: "sel", dash: true });
    this.view.overlay = { prims };
    this.view.redraw();
  }

  /** Enter after F: what the fence line crosses is added (or removed in R mode). */
  finishFence() {
    const sp = this.selPrompt;
    const f = sp.fence;
    sp.fence = null;
    this.view.overlay = null;
    const ids = [];
    const mode = sp.fenceMode || "f";
    const poly = mode !== "f";
    const edges = poly && f.length >= 3 ? [...f, f[0]] : f;
    if (poly && f.length >= 3) {
      // WP: completely inside the polygon; CP: inside or crossing its edges
      for (const { a, built } of this.visibleBuilt()) {
        const b = built.bbox;
        if (!b) continue;
        if (boxInPolygon(b, f)) ids.push(a.id);
        else if (mode === "cp" && [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].some((q) => pointInPolygon(q, f))) ids.push(a.id);
      }
    }
    if ((mode === "f" && f.length >= 2) || (mode === "cp" && f.length >= 3)) {
      const tol = 4 / this.view.zoom;
      for (const { a, built } of this.visibleBuilt()) {
        if (ids.includes(a.id)) continue;
        let crossed = false;
        for (let i = 0; i + 1 < edges.length && !crossed; i++) {
          const [p, q] = [edges[i], edges[i + 1]];
          const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / tol));
          for (let k = 0; k <= n && !crossed; k++) crossed = hit(built, a, [p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n], tol);
        }
        if (crossed) ids.push(a.id);
      }
    }
    this.setSelection(windowSelection(this.sel, ids, { shift: !!sp.remove, pickadd: true }));
  }

  /** Enter at the Select objects prompt: the command runs on the selection. */
  finishSelPrompt() {
    const p = this.selPrompt;
    if (p && p.fence) {
      this.finishFence();
      return;
    }
    if (this.sel.size) this.prevSel = [...this.sel];
    this.selPrompt = null;
    if (p && p.cmd === "erase" && this.sel.size) this.deleteSelected();
    if (p && (p.cmd === "moveSel" || p.cmd === "copySel" || p.cmd === "symSave") && this.sel.size) this.moveCmd(p.cmd);
    this.updateCmdPrompt();
  }

  // ------------------------------------------------------------ MOVE / COPY (CMD-D13)
  /** M / CO: on the selection, or after a Select objects prompt. */
  moveCmd(id) {
    if (this.sel.size) this.prevSel = [...this.sel];
    if (!this.sel.size) {
      if (this.tool !== "select") this.setTool("select");
      this.selPrompt = { cmd: id };
      this.updateCmdPrompt();
      return;
    }
    this.moveIds = [...this.sel];
    this.setTool(id);
  }

  /** The selected annotations moved by the cursor (preview of MOVE / COPY). */
  movePreview(base, cur) {
    const dx = cur[0] - base[0];
    const dy = cur[1] - base[1];
    return (this.moveIds || []).map((id) => this.annots.find((a) => a.id === id)).filter(Boolean).map((a) => {
      const c = JSON.parse(JSON.stringify(a));
      moveAnnot(c, dx, dy);
      return c;
    });
  }

  /** MOVE / COPY with a base point and a second point (typed or picked). */
  moveSelection(pts, copy) {
    const [b, q] = pts;
    const dx = q[0] - b[0];
    const dy = q[1] - b[1];
    const src = (this.moveIds || []).map((id) => this.annots.find((a) => a.id === id)).filter(Boolean);
    if (!src.length) return null;
    this.pushHistory();
    if (copy) {
      const items = src.map((a) => {
        const c = JSON.parse(JSON.stringify(a));
        c.id = newId();
        moveAnnot(c, dx, dy);
        return c;
      });
      this.annots.push(...items);
      this.changed();
      // as in AutoCAD: more copies from the same base point until Enter / Esc
      this.clicks = [b];
      return null;
    }
    for (const a of src) moveAnnot(a, dx, dy);
    this.changed();
    this.setTool("select");
    this.selectMany(src.map((a) => a.id));
    return null;
  }

  /** Options typed at the Select objects prompt: ALL, L (last), P (previous), W, C, F, R, A. */
  selPromptOption(text) {
    const q = String(text || "").trim().toUpperCase();
    const sp = this.selPrompt;
    const onPage = this.visibleBuilt().map(({ a }) => a.id);
    const done = () => {
      this.updateCmdPrompt();
      return true;
    };
    if (q === "W" || q === "WINDOW") {
      sp.force = "w";
      return done();
    }
    if (q === "C" || q === "CROSSING") {
      sp.force = "c";
      return done();
    }
    if (q === "F" || q === "FENCE") {
      sp.fence = [];
      sp.fenceMode = "f";
      return done();
    }
    if (q === "WP" || q === "WPOLYGON" || q === "CP" || q === "CPOLYGON") {
      sp.fence = [];
      sp.fenceMode = q[0] === "W" ? "wp" : "cp";
      return done();
    }
    if (q === "R" || q === "REMOVE") {
      sp.remove = true;
      return done();
    }
    if (q === "A" || q === "ADD") {
      sp.remove = false;
      return done();
    }
    if (q === "P" || q === "PREVIOUS") {
      const prev = (this.prevSel || []).filter((id) => onPage.includes(id));
      this.setSelection(windowSelection(this.sel, prev, { shift: !!sp.remove, pickadd: true }));
      return done();
    }
    if (q === "ALL" || q === "TOT") {
      this.setSelection(windowSelection(this.sel, onPage, { shift: !!sp.remove, pickadd: true }));
      return done();
    }
    if (q === "L" || q === "LAST" || q === "ULTIMUL") {
      const last = [...this.annots].reverse().find((a) => onPage.includes(a.id));
      if (last) this.setSelection(windowSelection(this.sel, [last.id], { shift: !!sp.remove, pickadd: true }));
      return done();
    }
    return false;
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
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    const a = this.selected();
    if (!a) return;
    this.pushHistory(key ? `${a.id}:${key}` : null);
    fn(a);
    this.changed();
  }

  /** The same change on all selected annotations (a single undo step). */
  updateMany(fn) {
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    const list = this.selectedAll();
    if (!list.length) return;
    this.pushHistory();
    list.forEach(fn);
    this.changed();
  }

  /** Adds what a tool made: one annotation, or several at once (a series of dimensions),
   *  as one undo step. */
  addMade(made) {
    const t = TOOL_BY_ID[this.tool];
    if (!(t && t.chain)) this.cmdState = {};
    if (!Array.isArray(made)) {
      if (made) this.addAnnot(finalize(made));
      return;
    }
    if (!made.length) {
      dlg.toast("Nu e nimic de cotat: punctele sunt pe aceeași linie de măsurare.");
      this.view.redraw();
      return;
    }
    if (made.length === 1) {
      this.addAnnot(finalize(made[0]));
      return;
    }
    this.pushHistory();
    const items = made.map((x) => ({ ...finalize(x), page: this.page }));
    if (this.hidden.has("add")) this.hidden.delete("add");
    // the values that fit between their lines first; then, one by one, those that do not look for room
    // next to everything already placed
    const S = this.S();
    const outside = (it) => {
      const b = build(it, S, this.measure);
      return !!(b.meta && b.meta.out);
    };
    const later = [];
    for (const it of items) {
      if (outside(it)) later.push(it);
      else this.annots.push(it);
    }
    for (const it of later) {
      this.autoPlace(it);
      this.annots.push(it);
    }
    this.selectMany(items.map((a) => a.id));
    this.changed();
  }

  addAnnot(a) {
    this.pushHistory();
    a.page = this.page;
    this.autoPlace(a);
    // one origin per page: a new one replaces the old
    if (a.type === "ucs") this.annots = this.annots.filter((x) => !(x.type === "ucs" && x.page === this.page));
    if (this.hidden.has(this.layerOf(a))) {
      this.hidden.delete(this.layerOf(a));
      dlg.toast("Stratul era ascuns pe ecran; l-am reafișat ca să vezi ce ai adăugat.");
    }
    this.annots.push(a);
    this.select(a.id);
    this.changed();
    if (a.type === "tblock") this.afterTblock(a);
    if (a.type === "stamp" || a.type === "qr") {
      // one at a time: back to Select, with the new one in the panel
      setTimeout(() => {
        this.setTool("select");
        this.select(a.id);
      }, 0);
    }
    const focus = { text: "#tTxt", lead: "#lTxt", strike: "#sNew", note: "#nTxt", comment: "#cTxt" }[a.type];
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

  // ------------------------------------------------------------ copy / paste
  copySelected(silent) {
    const list = this.selectedAll();
    if (!list.length) return false;
    const keep = list.filter((a) => a.type !== "redact");
    if (keep.length < list.length) dlg.toast("Ștergerile din original țin de obiectele de sub ele și nu se copiază.");
    if (!keep.length) return false;
    this.clip = JSON.stringify(keep);
    try {
      localStorage.setItem("cotare.clip", this.clip);
    } catch (_) { /* storage unavailable */ }
    if (!silent) dlg.toast(`${keep.length === 1 ? "Copiat" : `Copiate ${keep.length} adnotări`} · Ctrl+V lipește la cursor`);
    return true;
  }

  paste(duplicate) {
    if (!this.doc) return;
    let raw = this.clip;
    if (!raw) {
      try {
        raw = localStorage.getItem("cotare.clip");
      } catch (_) { /* storage unavailable */ }
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
    // the group moves as a whole: the anchor of the first annotation goes to the cursor
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

  /** New rows for the parts list: one for each missing item number. */
  bomRowsFromBalloons(existing = [], ensureOne = false) {
    const have = new Set(existing.map((r) => String(r.poz).trim()));
    const nums = [...new Set(this.annots.filter((a) => a.type === "balloon").map((a) => String(a.num ?? "").trim()).filter(Boolean))];
    nums.sort((x, y) => (parseFloat(x) || 0) - (parseFloat(y) || 0) || x.localeCompare(y));
    const rows = nums.filter((n) => !have.has(n)).map((poz) => ({ poz, name: "", qty: "1", mat: "", obs: "" }));
    if (ensureOne && !rows.length && !existing.length) rows.push({ poz: "1", name: "", qty: "1", mat: "", obs: "" });
    return rows;
  }

  /**
   * The tolerance of a new dimension: the document's default (context bar, UI-D2), or none (the general
   * tolerance then applies). A fit (H7, h6…) is not given to radii.
   */
  defaultTol(prefix = "") {
    const t = this.settings.tolDef;
    if (t && t.mode === "pm" && t.pm > 0) return { mode: "pm", pm: t.pm };
    if (t && t.mode === "iso" && t.fit && prefix !== "R") return { mode: "iso", fit: t.fit };
    return { mode: "none" };
  }

  /** Circles of the page: the original drawing and the shapes drawn on it. */
  pageArcs() {
    const arcs = [...(this.hidden.has("orig") ? [] : this.snapper.arcs || [])];
    for (const { built } of this.visibleBuilt()) if (built.snap && built.snap.arcs) arcs.push(...built.snap.arcs);
    return arcs;
  }

  /** The ordinate dimensions a hole table is made from: those sharing the base of the selected
   *  set, or else of the set with the most points. */
  holeOrds(base = null) {
    const ords = this.annots.filter((a) => a.page === this.page && a.type === "ord" && Array.isArray(a.base));
    if (!ords.length) return [];
    const same = (u, w) => Math.hypot(u[0] - w[0], u[1] - w[1]) <= 0.75;
    const sel = this.selectedAll().find((a) => a.type === "ord" && a.page === this.page);
    let b = base || (sel && sel.base);
    if (!b || !ords.some((o) => same(o.base, b))) b = [...ords].sort((u, w) => (w.pts || []).length - (u.pts || []).length)[0].base;
    return ords.filter((o) => same(o.base, b));
  }

  holeTableAt(p) {
    const t = holeTable(this.holeOrds(), this.pageArcs(), this.S());
    if (!t) {
      dlg.toast("Tabelul de găuri se face din cotele ordonate ale paginii: cotează întâi găurile cu DOR, pe X și pe Y, din aceeași bază.");
      return null;
    }
    return { type: "holes", p, pts: t.pts, rows: t.rows, headerBottom: false };
  }

  /** Recomputes a hole table from the ordinates (diameters typed by hand are kept). */
  holeTableSync(a) {
    const near = (a.pts || []).find(Array.isArray);
    let base = null;
    if (near) {
      // the base of the ordinate set that measures these holes
      const o = this.annots.find((x) => x.page === a.page && x.type === "ord" && [x.base, ...(x.pts || [])].some((q) => Array.isArray(q) && Math.hypot(q[0] - near[0], q[1] - near[1]) <= 0.75));
      if (o) base = o.base;
    }
    const t = holeTable(this.holeOrds(base), this.pageArcs(), this.S(), a);
    if (!t) {
      dlg.toast("Nu mai există cote ordonate pe pagină: tabelul a rămas cum era.");
      return false;
    }
    a.pts = t.pts;
    a.rows = t.rows;
    return true;
  }

  nextViewLetter() {
    const used = new Set(this.annots.filter((a) => a.type === "section" || a.type === "detail").map((a) => a.letter));
    for (const ch of VIEW_LETTERS) if (!used.has(ch)) return ch;
    return "A";
  }

  /** Proposed label for the next view: the first section or detail without a label. */
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

  /** A new GD&T frame starts like the last one in the document (characteristic, value, modifiers,
   * datums); the first one is a flatness frame. Ø only where the characteristic allows it. */
  gdtDefaults() {
    const last = [...this.annots].reverse().find((a) => a.type === "gdt");
    if (!last) return { sym: "flat", dia: false, val: "0,05", mods: [], datums: ["A", "", ""] };
    return {
      sym: last.sym, dia: !!last.dia && diaAllowed(last.sym), val: last.val || "", mods: [...(last.mods || [])],
      datums: [...(last.datums || ["", "", ""])], ...(last.scale && last.scale !== 1 ? { scale: last.scale } : {}),
    };
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

  /** What the export draws on page n of a document: primitives and removals from the original. */
  pageLayer(annots, n, builtOf, inkAll = false) {
    const prims = [];
    const removals = [];
    for (const a of annots) {
      if (a.page !== n) continue;
      prims.push(...exportPrims(builtOf(a).prims));
      if (a.type === "redact" && a.mode !== "cover") {
        const op = a.mode === "objects" ? { mode: "objects", ids: a.ids || [] } : { mode: a.mode, rect: a.r };
        if (a.mode !== "objects" || op.ids.length) removals.push(op);
      }
      if (a.type === "ink" && (a.ids || []).length && !inkAll) removals.push({ mode: "black", ids: a.ids });
    }
    return { prims, removals };
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
    const rev = String(this.settings.revNo || "1");
    const state = { ...this.stateJson(), settings: { ...this.settings, exportedRev: rev } };
    if (extra.notes === true) extra = { ...extra, notes: this.commentNotes(pageSel) };
    else if (extra.notes === false) extra = { ...extra, notes: null };
    return api.exportPdf(this.doc.id, { filename, colorMode, embed, pages, removals, ink, pageSel, split, rev, state, ...extra });
  }
}
