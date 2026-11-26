// Own symbol library (BLOCK / INSERT): save the selection as a symbol, place a symbol with a click.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { build, newId } from "../annots.js";
import * as api from "../api.js";
import * as dlg from "../dialogs.js";
import { drawPrims } from "../view.js";
import { finalize } from "../tools.js";
import { SYMBOL_STORE, SYMBOL_TYPES, symbolItems, placeItems, cleanSymbol, addSymbol, symbolId } from "../blocks.js";

const IMG_MAX = 300 * 1024;

export class Blocks {
  symbolLib() {
    try {
      const v = JSON.parse(localStorage.getItem(SYMBOL_STORE) || "[]");
      return Array.isArray(v) ? v.map(cleanSymbol).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  saveSymbolLib(list) {
    try {
      localStorage.setItem(SYMBOL_STORE, JSON.stringify(list));
      return true;
    } catch (_) {
      dlg.toast("Biblioteca de simboluri nu a putut fi salvată: spațiul browserului e plin (imagini prea mari?).", 7000);
      return false;
    }
  }

  /** The symbol the INSERT tool places, or null. */
  currentSymbol() {
    return this.symbolLib().find((s) => s.id === this.symCur) || null;
  }

  openSymbolLibrary() {
    dlg.symbolDialog(this);
  }

  /** BLOCK: the selection (moveIds) becomes a symbol with this base point; the name is asked next. */
  symbolFromSel(base) {
    const src = (this.moveIds || []).map((id) => this.annots.find((a) => a.id === id)).filter(Boolean);
    const keep = src.filter((a) => SYMBOL_TYPES.has(a.type));
    if (!keep.length) {
      dlg.toast("Nimic din selecție nu poate intra într-un simbol (ștergerile, acoperirile, comentariile și tabelul de găuri țin de desenul lor)", 6000);
      this.setTool("select");
      return;
    }
    if (keep.length < src.length) dlg.toast(`${src.length - keep.length} din selecție nu intră în simbol (ștergeri, acoperiri, comentarii, tabelul de găuri)`, 5000);
    // after the click's own focus change, so the name goes to the command line
    setTimeout(() => this.askValue("Numele simbolului", (v) => {
      const name = String(v || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name) return false;
      this.saveSymbol(keep, base, name);
      return true;
    }, true), 0);
  }

  /** The image of this document as a data URL (null if too large or unavailable). */
  async imageData(img) {
    try {
      const blob = await (await fetch(api.imageUrl(this.doc.id, img))).blob();
      if (blob.size > IMG_MAX) return null;
      return await new Promise((ok, bad) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.onerror = bad;
        fr.readAsDataURL(blob);
      });
    } catch (_) {
      return null;
    }
  }

  async saveSymbol(annots, base, name) {
    let items = symbolItems(annots, base);
    let dropped = 0;
    // images belong to a document on the server: the symbol keeps their content
    for (const it of items) {
      if (it.type === "image") {
        it.data = await this.imageData(it.img);
        delete it.img;
        if (!it.data) dropped++;
      } else if (it.type === "tblock" && it.tpl && it.tpl.logo && it.tpl.logo.img) {
        const data = await this.imageData(it.tpl.logo.img);
        delete it.tpl.logo.img;
        if (data) it.tpl.logo.data = data;
        else delete it.tpl.logo;
      }
    }
    items = items.filter((it) => it.type !== "image" || it.data);
    if (dropped) dlg.toast(`${dropped === 1 ? "O imagine" : `${dropped} imagini`} peste 300 kB nu intră în simbol: micșoreaz-o întâi.`, 7000);
    const sym = cleanSymbol({ v: 1, id: symbolId(), name, items });
    this.setTool("select");
    if (!sym) return;
    const { list, replaced } = addSymbol(this.symbolLib(), sym);
    if (!this.saveSymbolLib(list)) return;
    this.symCur = list.find((s) => s.name === sym.name).id;
    dlg.toast(replaced ? `Simbolul „${sym.name}” a fost înlocuit (${sym.items.length} obiecte)` : `Simbol salvat: ${sym.name} (${sym.items.length} obiecte) · I sau INSERT îl pune pe desen`, 5000);
  }

  /** The symbol's items at pt, for the preview (images as their outline). */
  symbolPreview(pt) {
    const sym = this.currentSymbol();
    if (!sym) return null;
    const S = this.S();
    const prims = [];
    placeItems(sym.items, pt).forEach((it, i) => {
      try {
        prims.push(...build({ ...it, id: `_sym${i}`, layer: "add" }, S, this.measure).prims);
      } catch (_) { /* an item that cannot be drawn */ }
    });
    return prims;
  }

  /** INSERT: the symbol placed with its base point at pt; the tool stays for the next one. */
  async placeSymbol(pt) {
    const sym = this.currentSymbol();
    if (!sym) {
      this.openSymbolLibrary();
      return;
    }
    const docId = this.doc.id;
    const items = placeItems(sym.items, pt);
    if (!this.symImg || this.symImg.doc !== docId) this.symImg = { doc: docId, map: new Map() };
    const upload = async (data) => {
      const m = this.symImg.map;
      if (!m.has(data)) {
        const blob = await (await fetch(data)).blob();
        m.set(data, await api.uploadImage(docId, blob));
      }
      return m.get(data);
    };
    try {
      for (const it of items) {
        if (it.type === "image" && it.data) {
          const res = await upload(it.data);
          it.img = res.img;
          it.iw = res.w;
          it.ih = res.h;
          delete it.data;
        } else if (it.type === "tblock" && it.tpl && it.tpl.logo && it.tpl.logo.data) {
          it.tpl.logo.img = (await upload(it.tpl.logo.data)).img;
          delete it.tpl.logo.data;
        }
      }
    } catch (err) {
      dlg.toast(`Imaginea simbolului nu a putut fi pusă: ${err.message}`, 6000);
      return;
    }
    if (!this.doc || this.doc.id !== docId) return;
    const S = this.S();
    const placed = items.map((it) => ({ ...finalize(it), id: newId(), page: this.page })).filter((a) => {
      try {
        return !!build(a, S, this.measure).bbox;
      } catch (_) {
        return false;
      }
    });
    if (!placed.length) return;
    this.pushHistory();
    if (this.hidden.has("add")) this.hidden.delete("add");
    this.annots.push(...placed);
    this.selectMany(placed.map((a) => a.id));
    this.changed();
  }

  /** A small picture of the symbol for the library (PNG data URL). */
  symbolThumb(sym, w = 132, h = 84) {
    const S = this.S();
    const prims = [];
    let box = null;
    sym.items.forEach((it, i) => {
      try {
        const b = build({ ...it, id: `_th${i}`, layer: "add" }, S, this.measure);
        prims.push(...b.prims.filter((p) => !p.ed));
        if (b.bbox) box = box ? [Math.min(box[0], b.bbox[0]), Math.min(box[1], b.bbox[1]), Math.max(box[2], b.bbox[2]), Math.max(box[3], b.bbox[3])] : [...b.bbox];
      } catch (_) { /* an item that cannot be drawn */ }
    });
    const cv = document.createElement("canvas");
    const dpr = 2;
    cv.width = w * dpr;
    cv.height = h * dpr;
    if (!box) return cv.toDataURL("image/png");
    const pad = 6;
    const bw = Math.max(box[2] - box[0], 1);
    const bh = Math.max(box[3] - box[1], 1);
    const k = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh, 3);
    const ctx = cv.getContext("2d");
    ctx.setTransform(k * dpr, 0, 0, k * dpr, (w / 2 - ((box[0] + box[2]) / 2) * k) * dpr, (h / 2 - ((box[1] + box[3]) / 2) * k) * dpr);
    drawPrims(ctx, prims, k, undefined, 0.8);
    return cv.toDataURL("image/png");
  }
}
