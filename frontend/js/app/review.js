// Review tools: revision compare, stamps / QR / watermark, highlighter and comments.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { build, derive, K, fmtNum } from "../annots.js";
import { finalize, TOOL_BY_ID } from "../tools.js";
import * as dlg from "../dialogs.js";
import { tr } from "../i18n.js";
import { today, $ } from "./util.js";

export class Review {
  // ------------------------------------------------------------ revision compare (V12-6)
  /** Lays page otherPage of document other (the older revision) under the current page. */
  /** Two-point alignment (V13-7): two points on the open page, then the same two on the older revision,
   *  drawn half transparent over it; the older page is then moved, turned and scaled onto this one. */
  async startCompareAlign(other, otherPage, otherName, withAnnots, align) {
    if (this.compare) this.endCompare();
    if (this.tool !== "select") this.setTool("select");
    const om = await api.getDoc(other);
    const op = (om.pages || [])[otherPage];
    if (!op) return;
    const img = new Image();
    img.onload = () => this.view.redraw();
    img.src = api.renderUrl(other, otherPage, Math.min(3, 2400 / Math.max(op.w, op.h)));
    this.cmpPick = { other, otherPage, otherName, withAnnots, align, page: this.page, wo: op.w, ho: op.h, pts: [], img, snaps: [] };
    // the older page's corners and ends, where it is drawn over this one, to snap its two points
    const pg = this.doc.pages[this.page];
    api.snap(other, otherPage).then((g) => {
      if (this.cmpPick) this.cmpPick.snaps = (g.pts || []).map((q) => [(q[0] * pg.w) / op.w, (q[1] * pg.h) / op.h]);
    }).catch(() => {});
    this.comparePickHint();
  }

  comparePickHint() {
    const n = this.cmpPick ? this.cmpPick.pts.length : 0;
    const steps = [
      "Aliniere: click pe un punct de reper pe pagina deschisă (cu snap) · Esc renunță",
      "Aliniere: al doilea punct de reper, cât mai departe de primul",
      "Aliniere: același prim punct pe revizia veche (desenată cu roșu peste pagină; se prinde de colțuri și capete)",
      "Aliniere: același al doilea punct pe revizia veche",
    ];
    this.setHint(steps[n]);
    this.view.redraw();
  }

  /** A point of the two-point alignment: the first two on this page, the next two on the older one. */
  comparePick(p) {
    const c = this.cmpPick;
    if (c.pts.length >= 2 && c.snaps.length) {
      // on the older page: the nearest of its corners and ends, within 10 screen pixels
      const tol = 10 / this.view.zoom;
      let best = null;
      for (const q of c.snaps) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d <= tol && (!best || d < best[0])) best = [d, q];
      }
      if (best) p = [...best[1]];
    }
    c.pts.push(p);
    if (c.pts.length < 4) return this.comparePickHint();
    this.cmpPick = null;
    const pg = this.doc.pages[c.page];
    // the older page is drawn stretched over this one: back to its own points
    const old = (q) => [(q[0] * c.wo) / pg.w, (q[1] * c.ho) / pg.h];
    const pairs = [[c.pts[0], old(c.pts[2])], [c.pts[1], old(c.pts[3])]];
    this.setHint(TOOL_BY_ID[this.tool].hint);
    this.runCompare(c.other, c.otherPage, c.align, c.otherName, c.withAnnots, pairs);
  }

  cancelComparePick() {
    this.cmpPick = null;
    this.setHint(TOOL_BY_ID[this.tool].hint);
    this.view.redraw();
    dlg.toast("Alinierea în două puncte a fost anulată");
  }

  async runCompare(other, otherPage, align, otherName, withAnnots = true, pairs = null) {
    dlg.toast("Se compară…", 30000);
    try {
      const body = { other, page: this.page, otherPage, align };
      if (pairs) body.pairs = pairs;
      if (withAnnots) {
        // both pages as their exports look: this one from the editor, the other from its saved state
        const mine = this.pageLayer(this.annots, this.page, (a) => this.builtOf(a));
        body.prims = mine.prims;
        body.removals = mine.removals;
        const om = await api.getDoc(other);
        const st = om.state || {};
        const oS = { ...derive({ ...dlg.storedDefaults(), ...(st.settings || {}) }), pagesWH: (om.pages || []).map((p) => [p.w, p.h]) };
        const theirs = this.pageLayer(st.annots || [], otherPage, (a) => build(a, oS, this.measure));
        body.otherPrims = theirs.prims;
        body.otherRemovals = theirs.removals;
      }
      const res = await api.compare(this.doc.id, body);
      const img = new Image();
      await new Promise((ok, bad) => {
        img.onload = ok;
        img.onerror = bad;
        img.src = res.image;
      });
      this.compare = { other, otherPage, otherName, align, withAnnots, body, page: this.page, regions: res.regions, idx: -1, alpha: 1, img };
      this.view.redraw();
      this.renderCtx();
      const n = res.regions.length;
      const sh = res.shiftMm || [0, 0];
      const fit = res.fit ? ` · revizia veche × ${fmtNum(res.fit.scale, ",", 3)}, rotită ${fmtNum(res.fit.angle, ",", 1)}°` : "";
      dlg.toast(n ? `${n} ${n === 1 ? "zonă modificată" : "zone modificate"}: roșu = doar în ${otherName}, verde = doar în revizia deschisă${sh[0] || sh[1] ? ` · aliniat cu ${fmtNum(sh[0], ",", 2)} / ${fmtNum(sh[1], ",", 2)} mm` : ""}${fit}` : `Nicio diferență de desen între cele două pagini.${fit}`, 6000);
    } catch (err) {
      dlg.toast(`Compararea nu a reușit: ${err.message}`, 6000);
    }
  }

  endCompare() {
    this.compare = null;
    this.view.cmpBox = null;
    this.view.redraw();
    this.renderCtx();
  }

  /** The next / previous changed area: zoom on it and outline it. */
  stepCompare(d) {
    const c = this.compare;
    if (!c || !c.regions.length) return;
    c.idx = (c.idx + d + c.regions.length) % c.regions.length;
    const b = c.regions[c.idx];
    const m = 12 * K;
    this.view.zoomToBox([b[0] - m, b[1] - m, b[2] + m, b[3] + m]);
    this.view.cmpBox = b;
    this.view.redraw();
    this.renderCtx();
  }

  async exportCompare() {
    const c = this.compare;
    if (!c) return;
    try {
      const blob = await api.compare(this.doc.id, { ...c.body, format: "pdf",
        legend: `${tr("doar în")} ${c.otherName}|${tr("doar în")} ${this.doc.name}|${tr("în ambele")}` });
      const base = this.doc.name.replace(/\.[^.]+$/, "");
      await dlg.saveBlob(blob, `${base}_comparare.pdf`);
    } catch (err) {
      dlg.toast(err.message, 6000);
    }
  }

  // ------------------------------------------------------------ stamps, QR, watermark (V12-5)
  /** The stamp chosen for the tool, at pt (centre): today's date and the user's name under the word. */
  stampAt(pt) {
    const c = this.stampChoice;
    if (!c || !pt) return null;
    return { type: "stamp", p: [...pt], text: c.text, color: c.color, sub: true, date: today(), name: this.settings.author || "", angle: 0 };
  }

  /** A QR code at pt (top-left): drawing number taken from a title block of the document, if any. */
  qrAt(pt, preview = false) {
    if (!pt) return null;
    // the code holds the date of the current revision: today, if the document has none yet
    if (!preview && !this.settings.revDate) this.settings = { ...this.settings, revDate: today() };
    const tb = this.annots.find((x) => x.type === "tblock" && x.vals && x.vals.nr_desen);
    return { type: "qr", p: [...pt], size: 20, vals: { nr_desen: tb ? tb.vals.nr_desen : "", extra: "" } };
  }

  /** The custom stamps kept in the browser. */
  stampLib() {
    try {
      const v = JSON.parse(localStorage.getItem("cotare.stamps") || "[]");
      return Array.isArray(v) ? v.filter((x) => x && typeof x.text === "string").slice(0, 50) : [];
    } catch (_) {
      return [];
    }
  }

  saveStampLib(list) {
    try {
      localStorage.setItem("cotare.stamps", JSON.stringify(list.slice(0, 50)));
    } catch (_) { /* storage unavailable */ }
  }

  /** A faint diagonal text on every page (one watermark annotation per page, replacing older ones). */
  addWatermark(text) {
    this.pushHistory();
    this.annots = this.annots.filter((a) => a.type !== "watermark");
    if (text) for (let i = 0; i < this.doc.pages.length; i++) this.annots.push(finalize({ type: "watermark", text, page: i, op: 0.14 }));
    this.changed();
    this.panel.render();
  }

  // ------------------------------------------------------------ markup (V12-4)
  /** Color and width of the next highlighter strokes (remembered in the browser). */
  setMarkStyle(patch) {
    this.markStyle = { ...(this.markStyle || {}), ...patch };
    try {
      localStorage.setItem("cotare.mark", JSON.stringify(this.markStyle));
    } catch (_) { /* storage unavailable */ }
  }

  /** Review comments of the export, as PDF notes: page → [{ p, text, author, date, done }]. */
  commentNotes(pages) {
    const out = {};
    for (const a of this.annots) {
      if (a.type !== "comment" || !String(a.text || "").trim()) continue;
      if (pages && !pages.includes(a.page)) continue;
      (out[a.page] = out[a.page] || []).push({ p: a.p, text: String(a.text).slice(0, 4000), author: a.author || "", date: a.date || "", done: !!a.done });
    }
    return out;
  }
}
