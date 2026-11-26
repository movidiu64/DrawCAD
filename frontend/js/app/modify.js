// OFFSET, TRIM and EXTEND (CMD-D17): picking a drawn shape, the preview under the cursor and the change.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { K, fmtNum, newId } from "../annots.js";
import * as dlg from "../dialogs.js";
import { offsetShape, trimShape, extendShape, shapeDistance, toPath, elsPoints, OFFSET_KINDS, TRIM_KINDS, EXTEND_KINDS } from "../modify.js";

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

  /** Cutting / boundary edges: every other drawn shape on the page and the drawing's own geometry. */
  modEdges(exceptId) {
    const segs = [];
    const arcs = [];
    for (const { a, built } of this.visibleBuilt()) {
      if (a.type !== "shape" || a.id === exceptId || !built.snap) continue;
      segs.push(...built.snap.segs);
      if (built.snap.arcs) arcs.push(...built.snap.arcs);
    }
    if (!this.hidden.has("orig") && this.snapper) {
      segs.push(...(this.snapper.segs || []));
      arcs.push(...(this.snapper.arcs || []));
    }
    return { segs, arcs };
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
      const a = this.modTarget(raw, ext ? EXTEND_KINDS : TRIM_KINDS);
      if (!a) return dlg.toast(KIND_HINT[ext ? "extend" : "trim"]);
      const edges = this.modEdges(a.id);
      if (ext) {
        const r = extendShape(a, raw, edges);
        if (r.err) this.modError(r.err);
        else this.modApply(a, [{ ...a, ...r.shape }]);
      } else {
        const r = trimShape(a, raw, edges);
        if (r.err) this.modError(r.err);
        else this.modApply(a, r.pieces.map((p) => ({ ...a, ...p })));
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
  modApply(a, pieces, copy = false) {
    this.pushHistory();
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
    this.cmdState.done = (this.cmdState.done || 0) + 1;
    this.changed();
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
      const a = this.modTarget(raw, ext ? EXTEND_KINDS : TRIM_KINDS);
      if (a) {
        const edges = this.modEdges(a.id);
        const r = ext ? extendShape(a, raw, edges) : trimShape(a, raw, edges);
        if (r.err) outline(a, "edgray", 0.9, true);
        else if (ext) prims.push({ t: "P", p: r.added.flat(), close: false, w: 0.9, c: "preview", dash: true });
        else if (r.gone && r.gone.length > 1) prims.push({ t: "P", p: r.gone.flat(), close: false, w: 1.6, c: "edred", dash: true });
      }
    }
    this.view.overlay = { prims: prims.length ? prims : null, snap: sn };
    this.view.redraw();
  }
}
