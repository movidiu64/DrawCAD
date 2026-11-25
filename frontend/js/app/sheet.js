// Title blocks (library, generator, from a selection) and images on the drawing.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { templateFromItems, templateFields } from "../tblock.js";
import { build, derive, K, CAP, scaledS, strikeLabelBox, annotSnapSegs, primsBBox, imageRect } from "../annots.js";
import { TOOL_BY_ID, finalize } from "../tools.js";
import * as dlg from "../dialogs.js";
import { round2, today, segHitsBox, $ } from "./util.js";

export class SheetItems {
  // ------------------------------------------------------------ title blocks (V12-3)
  /** The browser's title block library (localStorage). */
  tblockLib() {
    try {
      const v = JSON.parse(localStorage.getItem("cotare.tblocks") || "[]");
      return Array.isArray(v) ? v : [];
    } catch (_) {
      return [];
    }
  }

  saveTblockLib(list) {
    try {
      localStorage.setItem("cotare.tblocks", JSON.stringify(list));
      return true;
    } catch (_) {
      dlg.toast("Biblioteca de indicatoare nu a putut fi salvată: spațiul browserului e plin (logo prea mare?).", 7000);
      return false;
    }
  }

  openTblockLibrary(pick = false) {
    dlg.tblockDialog(this, { pick });
  }

  /** The title block chosen for the tool, placed with its bottom-right corner at pt. */
  tblockAt(pt, preview = false) {
    const tpl = this.tblockTpl;
    if (!tpl || !pt) return null;
    const copy = JSON.parse(JSON.stringify(tpl));
    delete copy.id;
    const vals = {};
    if (templateFields(copy).includes("autor") && this.settings.author) vals.autor = this.settings.author;
    if (!preview && !this.settings.revDate) this.settings = { ...this.settings, revDate: today() };
    return { type: "tblock", p: [...pt], tpl: copy, vals, page: this.page };
  }

  /** After placing: the logo goes to the server as an image of the document; back to Select. */
  async afterTblock(a) {
    setTimeout(() => {
      this.setTool("select");
      this.select(a.id);
    }, 0);
    const L = a.tpl && a.tpl.logo;
    if (!L || !L.data || L.img) return;
    try {
      const blob = await (await fetch(L.data)).blob();
      const res = await api.uploadImage(this.doc.id, blob);
      const cur = this.annots.find((x) => x.id === a.id);
      if (cur && cur.tpl && cur.tpl.logo) {
        cur.tpl.logo.img = res.img;
        delete cur.tpl.logo.data;
        this.cache.delete(cur.id);
        this.changed();
      }
    } catch (err) {
      dlg.toast(`Logo-ul nu a putut fi pus: ${err.message}`, 6000);
    }
  }

  /** A template from the selected lines, texts and image (the image becomes the logo). */
  async tblockFromSelection(name) {
    const sel = this.selectedAll().filter((a) => a.page === this.page);
    const S = this.S();
    const items = [];
    for (const a of sel) {
      const b = this.builtOf(a);
      if (a.type === "image") {
        try {
          const blob = await (await fetch(api.imageUrl(this.doc.id, a.img))).blob();
          if (blob.size > 300 * 1024) {
            dlg.toast("Imaginea e prea mare pentru bibliotecă (peste 300 kB): micșoreaz-o întâi.", 7000);
            continue;
          }
          const data = await new Promise((ok, bad) => {
            const fr = new FileReader();
            fr.onload = () => ok(fr.result);
            fr.onerror = bad;
            fr.readAsDataURL(blob);
          });
          items.push({ kind: "logo", r: a.r, data });
        } catch (_) { /* image unavailable */ }
        continue;
      }
      for (const p of b.prims) {
        if (p.ed) continue;
        if (p.t === "L") items.push({ kind: "line", p: p.p, heavy: (p.w || 0) >= 0.45 * K });
        else if (p.t === "P" && !p.fill) {
          const q = p.p;
          for (let i = 2; i < q.length; i += 2) items.push({ kind: "line", p: [q[i - 2], q[i - 1], q[i], q[i + 1]], heavy: (p.w || 0) >= 0.45 * K });
          if (p.close && q.length > 4) items.push({ kind: "line", p: [q[q.length - 2], q[q.length - 1], q[0], q[1]], heavy: (p.w || 0) >= 0.45 * K });
        } else if (p.t === "T" && !p.a) items.push({ kind: "text", p: p.p, txt: p.txt, h: p.s * CAP });
      }
    }
    void S;
    return templateFromItems(items, name);
  }

  // ------------------------------------------------------------ images (V12-2)
  /** Asks for an image file, sends it to the server (which keeps a clean copy) and gives back
   * { img, w, h }; onCancel when the file dialog is closed without a file. */
  pickImage(onDone, onCancel = null) {
    const inp = $("imgInput");
    inp.value = "";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        onDone(await this.uploadImage(f));
      } catch (err) {
        dlg.toast(`Imaginea nu a putut fi adăugată: ${err.message}`, 6000);
        if (onCancel) onCancel();
      }
    };
    inp.oncancel = () => onCancel && onCancel();
    inp.click();
  }

  async uploadImage(blob) {
    dlg.toast("Se încarcă imaginea…", 15000);
    const res = await api.uploadImage(this.doc.id, blob);
    dlg.toast(`Imagine ${res.w} × ${res.h} px`, 1500);
    return res;
  }

  /** The Image tool: first the file, then the rectangle. */
  startImageTool() {
    this.pendingImage = null;
    this.pickImage((res) => {
      if (this.tool !== "image") return;
      this.pendingImage = res;
      this.setHint(TOOL_BY_ID.image.hint);
    }, () => {
      if (this.tool === "image" && !this.pendingImage) this.setTool("select");
    });
  }

  /** Default size of an image without a dragged rectangle: 50 mm wide (or high, if it is tall). */
  imageDefaultRect(at, iw, ih, side = 50 * K) {
    const k = side / Math.max(iw, ih);
    return [at[0], at[1], at[0] + iw * k, at[1] + ih * k];
  }

  commitImage(r, free) {
    const im = this.pendingImage;
    if (!im) return;
    const tiny = Math.abs(r[2] - r[0]) < 2 && Math.abs(r[3] - r[1]) < 2;
    const rr = tiny ? this.imageDefaultRect([r[0], r[1]], im.w, im.h) : imageRect([r[0], r[1]], [r[2], r[3]], im.w, im.h, free);
    const box = [Math.min(rr[0], rr[2]), Math.min(rr[1], rr[3]), Math.max(rr[0], rr[2]), Math.max(rr[1], rr[3])];
    this.addAnnot(finalize(TOOL_BY_ID.image.make(box, this)));
    this.pendingImage = null;
    const id = this.selectedId;
    this.setTool("select");
    if (id) this.select(id);
  }

  /** Ctrl+V with an image in the clipboard: placed at the cursor, at 150 dpi (at most 120 mm wide). */
  async pasteImage(file) {
    try {
      const res = await this.uploadImage(file);
      const wmm = Math.min(120, (res.w / 150) * 25.4);
      const w = wmm * K;
      const h = (w * res.h) / res.w;
      const p = this.lastPt || this.view.toPage(this.view.cw / 2, this.view.ch / 2);
      const r = [p[0] - w / 2, p[1] - h / 2, p[0] + w / 2, p[1] + h / 2];
      this.addAnnot(finalize({ type: "image", r, img: res.img, iw: res.w, ih: res.h, rot: 0, op: 1 }));
    } catch (err) {
      dlg.toast(`Imaginea nu a putut fi lipită: ${err.message}`, 6000);
    }
  }

  /** What a new label must not cover: texts and closed shapes of the other annotations and the
   * page's texts (boxes), lines of the annotations and of the drawing (segments, counted less). */
  placeObstacles(exceptId) {
    const boxes = [];
    const segs = [];
    for (const { a, built } of this.visibleBuilt()) {
      if (a.id === exceptId) continue;
      for (const q of built.prims || []) {
        if (q.ed) continue;
        if (q.t === "T" || (q.t === "P" && q.close) || q.t === "C" || q.t === "R") {
          const b = primsBBox([q]);
          if (b) boxes.push(b);
        }
      }
      segs.push(...annotSnapSegs(built));
    }
    boxes.push(...this.pageTextBoxes());
    return { boxes, segs };
  }

  /** Cost of putting a label in box b: area covered, plus a share for every line crossing it. */
  placeCost(b0, obs, margin = 2) {
    if (!b0) return 0;
    // a little air around the label: two values must not touch
    const b = [b0[0] - margin, b0[1] - margin, b0[2] + margin, b0[3] + margin];
    const area = (q) => Math.max(0, Math.min(b[2], q[2]) - Math.max(b[0], q[0])) * Math.max(0, Math.min(b[3], q[3]) - Math.max(b[1], q[1]));
    // covering text is much worse than crossing a line
    let c = 4 * obs.boxes.reduce((sum, q) => sum + area(q), 0);
    const own = (b[2] - b[0]) * (b[3] - b[1]);
    // lines: only those through the label itself (a dimension line just under a value is normal)
    const t = [b0[0] + 0.5, b0[1] + 0.5, b0[2] - 0.5, b0[3] - 0.5];
    let n = obs.segs.filter((q) => segHitsBox(q, t)).length;
    if (this.snapper && this.snapper.sg) n += [...this.snapper.sg.query(t[0], t[1], t[2], t[3], new Set())].filter((q) => segHitsBox(q, t)).length;
    c += n * 0.2 * own;
    const p = this.doc.pages[this.page];
    if (b0[0] < 0 || b0[1] < 0 || b0[2] > p.w || b0[3] > p.h) c += 1e9;
    return c;
  }

  /** A new linear dimension whose value does not fit between its extension lines: the value goes after
   * or before the arrows, sliding further out if needed, where it covers no other text or line. */
  autoPlace(a) {
    if (a.type !== "dim" || a.textShift != null) return;
    const S = this.S();
    const first = build({ ...a, textOut: "r" }, S, this.measure);
    if (!first.meta || !first.meta.out) return;
    const textBox = (b) => primsBBox(b.prims.filter((q) => q.t === "T"));
    const obs = this.placeObstacles(a.id);
    const tb = textBox(first);
    const base = first.meta.mid0 && tb ? Math.abs((tb[0] + tb[2]) / 2 - first.meta.mid0[0]) + Math.abs((tb[1] + tb[3]) / 2 - first.meta.mid0[1]) : 0;
    const w = tb ? Math.max(tb[2] - tb[0], tb[3] - tb[1]) : 10;
    let best = null;
    // at most two steps further out: a value far from its dimension would be read as another one's
    for (let k = 0; k < 3; k++) {
      for (const sgn of [1, -1]) {
        const shift = sgn * (base + k * w * 0.6);
        const b = textBox(build({ ...a, textShift: shift }, S, this.measure));
        const cost = this.placeCost(b, obs) + k * 1e-3;
        if (!best || cost < best.cost) best = { shift, cost, k, sgn };
      }
      if (best && best.cost < 1) break;
    }
    if (!best || (best.k === 0 && best.sgn === 1)) return; // the usual place is fine
    if (best.k === 0) a.textOut = "l";
    else a.textShift = round2(best.shift);
  }

  /** Side of a struck value where its new value and triangle overlap nothing: after it, above, before,
   * below (in that order); the new value is not typed yet, so it is assumed as long as the old one. */
  freeStrikeSide(a) {
    const S = scaledS(derive(this.settings), a.scale || 1);
    const r = [Math.min(a.r[0], a.r[2]), Math.min(a.r[1], a.r[3]), Math.max(a.r[0], a.r[2]), Math.max(a.r[1], a.r[3])];
    const vertical = r[3] - r[1] > (r[2] - r[0]) * 1.3;
    const tw = Math.max(vertical ? r[3] - r[1] : r[2] - r[0], S.h);
    const obs = this.placeObstacles(a.id);
    // the struck value itself is not an obstacle
    const touches = (b) => !(b[2] <= r[0] || b[0] >= r[2] || b[3] <= r[1] || b[1] >= r[3]);
    obs.boxes = obs.boxes.filter((b) => !touches(b));
    let best = "r";
    let bestCost = Infinity;
    for (const side of ["r", "t", "l", "b"]) {
      const cost = this.placeCost(strikeLabelBox(a, S, tw, side), obs);
      if (cost < bestCost - 1e-6) {
        best = side;
        bestCost = cost;
      }
      if (cost === 0) break;
    }
    return best;
  }

  /** Text boxes of the current page: PDF text and OCR lines (loaded once per page, in the background). */
  pageTextBoxes(n = this.page) {
    const boxes = [];
    const key = `${this.doc.id}:${n}:${this.doc.lv || 0}`;
    this.textBoxCache = this.textBoxCache || new Map();
    const have = this.textBoxCache.get(key);
    if (have === undefined) {
      this.textBoxCache.set(key, null);
      api.pageText(this.doc.id, n, this.doc.lv || 0).then((t) => {
        this.textBoxCache.set(key, (t.items || []).map((it) => it.box).filter(Boolean));
      }).catch(() => this.textBoxCache.set(key, []));
    } else if (have) boxes.push(...have);
    const o = this.ocr && this.ocr.get(n);
    if (o && o.lines) for (const ln of o.lines) if (ln.box) boxes.push(ln.box);
    return boxes;
  }
}
