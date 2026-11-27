// OFFSET, TRIM and EXTEND (CMD-D17): picking a drawn shape, the preview under the cursor and the change.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { K, fmtNum, newId } from "../annots.js";
import * as dlg from "../dialogs.js";
import { offsetShape, trimPrep, trimAt, extendShape, extendEnd, shapeCrossings, shapeGap, shapeDistance, toPath, elsPoints, OFFSET_KINDS, TRIM_KINDS, EXTEND_KINDS } from "../modify.js";

const KIND_HINT = {
  offset: "Alege o linie, polilinie, dreptunghi, cerc sau arc desenat",
  trim: "Alege o linie, polilinie, dreptunghi, cerc sau arc desenat",
  extend: "Alege o linie, o polilinie deschisă sau un arc desenat",
};

export class Modify {
  /** The drawn shape under the cursor that the command can change, or null. */
  modTarget(raw, kinds) {
    return this.annotsAt(raw).find((a) => a.type === "shape" && kinds.has(a.kind)) || null;
  }

  /**
   * Cutting / boundary edges: every other drawn shape on the page and the drawing's own geometry; with
   * a box, only those that reach into it (TRIM cuts lie on the shape, so its box is enough).
   */
  modEdges(exceptId, box = null) {
    const segs = [];
    const arcs = [];
    const over = (b) => !box || (b && b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]);
    for (const { a, built } of this.visibleBuilt()) {
      if (a.type !== "shape" || a.id === exceptId || !built.snap || !over(built.bbox)) continue;
      for (const g of built.snap.segs || []) segs.push(g);
      for (const g of built.snap.arcs || []) arcs.push(g);
    }
    const sn = this.snapper;
    if (!this.hidden.has("orig") && sn) {
      // copied one by one: a drawing has up to 60 000 of each, too many for push(...list)
      if (box && sn.sg) {
        for (const g of sn.sg.query(box[0], box[1], box[2], box[3], new Set())) segs.push(g);
        for (const g of sn.ag.query(box[0], box[1], box[2], box[3], new Set())) arcs.push(g);
      } else {
        for (const g of sn.segs || []) segs.push(g);
        for (const g of sn.arcs || []) arcs.push(g);
      }
    }
    return { segs, arcs };
  }

  /**
   * TRIM / EXTEND for this shape and pick, computed once per shape (and per end for EXTEND) while the
   * cursor stays on it; the cache goes with any change of the annotations or the drawing's geometry.
   */
  modResult(a, raw, ext, many = false) {
    const built = this.builtOf(a);
    const key = ext ? extendEnd(a, raw) : "trim";
    // one shape under the cursor, or several along a fence
    const c = this._modCache;
    const ok = c && c.annots === this.annots && c.n === this.annots.length && c.snapper === this.snapper && c.hidden === this.hidden.has("orig");
    if (!ok || (!many && c.map.size > 1)) {
      this._modCache = { annots: this.annots, n: this.annots.length, snapper: this.snapper, hidden: this.hidden.has("orig"), map: new Map() };
    }
    const map = this._modCache.map;
    let entry = map.get(a);
    if (!entry || entry.built !== built) map.set(a, (entry = { built, res: {} }));
    const memo = entry.res;
    if (ext) {
      if (!(key in memo)) memo[key] = extendShape(a, raw, this.modEdges(a.id));
      return memo[key];
    }
    if (!memo.prep) {
      const bb = built.bbox;
      memo.prep = trimPrep(a, this.modEdges(a.id, bb ? [bb[0] - 1, bb[1] - 1, bb[2] + 1, bb[3] + 1] : null));
    }
    return trimAt(memo.prep, a, raw);
  }

  /** The drawn shapes the fence from p to q crosses, with the crossing points. */
  fenceHits(p, q, kinds) {
    const seg = [p[0], p[1], q[0], q[1]];
    const box = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
    const out = [];
    for (const { a, built } of this.visibleBuilt()) {
      if (a.type !== "shape" || !kinds.has(a.kind)) continue;
      const bb = built.bbox;
      if (bb && (bb[0] > box[2] || bb[2] < box[0] || bb[1] > box[3] || bb[3] < box[1])) continue;
      const pts = shapeCrossings(a, seg);
      if (pts.length) out.push({ a, pts });
    }
    return out;
  }

  /**
   * TRIM or EXTEND along a fence: every shape it crosses, at each crossing (AutoCAD's drag across
   * objects), in one undo step. Returns how many shapes changed.
   */
  fenceApply(p, q, ext) {
    const hits = this.fenceHits(p, q, ext ? EXTEND_KINDS : TRIM_KINDS);
    let changed = 0;
    let first = true;
    for (const { a: a0, pts } of hits) {
      let ids = [a0.id];
      for (const pt of ext ? pts.slice(0, 1) : pts) {
        // the piece of the shape (it may already be cut) that lies at this crossing
        const a = this.annots.find((x) => ids.includes(x.id) && shapeGap(x, pt) < 0.5);
        if (!a) continue;
        const edges = this.modEdges(a.id);
        const r = ext ? extendShape(a, pt, edges) : trimAt(trimPrep(a, edges), a, pt);
        if (r.err) continue;
        const pieces = ext ? [{ ...a, ...r.shape }] : r.pieces.map((x) => ({ ...a, ...x }));
        const made = this.modApply(a, pieces, false, !first);
        first = false;
        ids = ids.filter((id) => id !== a.id).concat(made.map((x) => x.id));
        changed++;
      }
    }
    return changed;
  }

  /** The OFFSET distance in pt, or null for Through. */
  offsetPt() {
    const d = this.offsetDist;
    if (!(d > 0)) return null;
    return (d / (Number(this.settings.scale) || 1)) * K;
  }

  /** The distance asked when OFFSET starts, as AutoCAD: Enter keeps the last one. */
  askOffsetDist() {
    const cur = this.offsetDist > 0 ? `${fmtNum(this.offsetDist, ",", 3)} mm` : "prin punct";
    this.askValue(`Distanța de decalare în mm reali, sau T = prin punct (acum: ${cur})`, (v) => {
      const q = String(v).trim().toUpperCase();
      if (["T", "THROUGH", "PRIN", "PRINPUNCT"].includes(q.replace(/\s+/g, ""))) {
        this.offsetDist = null;
        return true;
      }
      const d = Number(q.replace(",", "."));
      if (!(d > 0)) return false;
      this.offsetDist = d;
      return true;
    });
  }

  /** A click of OFFSET, TRIM or EXTEND. raw: the cursor (objects are picked there), pt: the snapped point. */
  modifyClick(t, raw, pt, shift) {
    const st = this.cmdState;
    if (t.id === "offset") {
      if (!this.clicks.length) {
        const a = this.modTarget(raw, OFFSET_KINDS);
        if (!a) return dlg.toast(KIND_HINT.offset);
        st.obj = a.id;
        this.clicks = [pt];
      } else {
        const a = this.annots.find((x) => x.id === st.obj);
        this.clicks = [];
        st.obj = null;
        if (a) {
          const r = offsetShape(a, this.offsetPt(), pt);
          if (r.err) this.modError(r.err);
          else this.modApply(a, [{ ...a, ...r.shape }], true);
        }
      }
    } else {
      const ext = (t.id === "extend") !== !!shift; // Shift swaps TRIM and EXTEND, as in AutoCAD
      if (this.clicks.length) {
        // the end of a fence: everything it crosses
        const p = this.clicks[0];
        this.clicks = [];
        if (!this.fenceApply(p, raw, ext)) dlg.toast(ext ? "Linia nu trece peste nimic de prelungit" : "Linia nu trece peste nimic de tăiat");
      } else {
        const a = this.modTarget(raw, ext ? EXTEND_KINDS : TRIM_KINDS);
        if (!a) {
          // a click beside the objects starts a fence, as dragging across them in AutoCAD
          this.clicks = [raw];
        } else {
          const r = this.modResult(a, raw, ext);
          if (r.err) this.modError(r.err);
          else this.modApply(a, ext ? [{ ...a, ...r.shape }] : r.pieces.map((p) => ({ ...a, ...p })));
        }
      }
    }
    this.modPreview(t, raw, pt, shift);
    this.updateCmdPrompt();
  }

  modError(err) {
    dlg.toast({
      kind: "Comanda nu lucrează pe acest tip de obiect",
      one: "Un contur închis se taie între două intersecții: aici e doar una",
      none: "Nicio margine pe direcția capătului: nu are până unde să se prelungească",
      closed: "Un contur închis nu are capete de prelungit",
      big: "Distanța e prea mare pentru acest contur",
      side: "Punctul e chiar pe obiect: alege o parte",
    }[err] || err);
  }

  /** Replaces the shape with the pieces (none: deleted; copy: the pieces are added next to it), one undo step. */
  modApply(a, pieces, copy = false, sameStep = false) {
    this._modCache = null; // edges of the other shapes may change with this one
    if (!sameStep) this.pushHistory();
    const i = this.annots.indexOf(a);
    const items = pieces.map((p, k) => {
      const it = { ...p, id: copy || k ? newId() : a.id, page: a.page };
      for (const f of Object.keys(it)) if (it[f] === undefined) delete it[f];
      return it;
    });
    if (copy) this.annots.splice(i + 1, 0, ...items);
    else this.annots.splice(i, 1, ...items);
    if (!items.some((x) => x.id === a.id)) {
      this.sel.delete(a.id);
      if (this.selectedId === a.id) this.selectedId = null;
    }
    if (!sameStep) this.cmdState.done = (this.cmdState.done || 0) + 1;
    this.changed();
    return items;
  }

  /** U inside the command: the last change goes back. */
  modUndo() {
    if (!this.cmdState.done) return dlg.toast("Nimic de anulat în comanda curentă");
    this.cmdState.done -= 1;
    this.clicks = [];
    this.cmdState.obj = null;
    this.doUndo();
  }

  /** What a click would do, drawn under the cursor. */
  modPreview(t, raw, pt, shift, sn = null) {
    const prims = [];
    const outline = (a, c, w = 0.9, dash = false) => {
      const path = toPath(a);
      if (path) prims.push({ t: "P", p: elsPoints(path.els).flat(), close: path.closed && path.els[0].t === "L", w, c, dash });
    };
    if (t.id === "offset") {
      const a = this.clicks.length ? this.annots.find((x) => x.id === this.cmdState.obj) : this.modTarget(raw, OFFSET_KINDS);
      if (a) outline(a, "sel", 2.4);
      if (a && this.clicks.length) {
        const r = offsetShape(a, this.offsetPt(), pt);
        if (r.shape) outline({ ...a, ...r.shape }, "preview", 0.8, true);
        const d = r.shape && this.offsetPt() == null ? shapeDistance(a, pt) : null;
        if (d != null) this.setHint(`${t.hint} · prin punct: ${fmtNum((d / K) * (Number(this.settings.scale) || 1), ",", 3)} mm`);
      }
    } else {
      const ext = (t.id === "extend") !== !!shift;
      if (this.clicks.length) {
        // the fence and what it crosses
        const p = this.clicks[0];
        prims.push({ t: "P", p: [p[0], p[1], raw[0], raw[1]], close: false, w: 0.8, c: "preview", dash: true });
        for (const { a, pts } of this.fenceHits(p, raw, ext ? EXTEND_KINDS : TRIM_KINDS)) {
          // what each crossing would remove or add (the first crossing of each shape, as a hint)
          const r = this.modResult(a, pts[0], ext, true);
          if (r.err) outline(a, "edgray", 0.9, true);
          else if (ext) prims.push({ t: "P", p: r.added.flat(), close: false, w: 0.9, c: "preview", dash: true });
          else if (r.gone && r.gone.length > 1) prims.push({ t: "P", p: r.gone.flat(), close: false, w: 1.6, c: "edred", dash: true });
        }
      } else {
        const a = this.modTarget(raw, ext ? EXTEND_KINDS : TRIM_KINDS);
        if (a) {
          const r = this.modResult(a, raw, ext);
          if (r.err) outline(a, "edgray", 0.9, true);
          else if (ext) prims.push({ t: "P", p: r.added.flat(), close: false, w: 0.9, c: "preview", dash: true });
          else if (r.gone && r.gone.length > 1) prims.push({ t: "P", p: r.gone.flat(), close: false, w: 1.6, c: "edred", dash: true });
        }
      }
    }
    this.view.overlay = { prims: prims.length ? prims : null, snap: sn };
    this.view.redraw();
  }
}
