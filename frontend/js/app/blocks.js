// Own symbol library (BLOCK / INSERT): save the selection as a symbol, place a symbol with a click.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { build, newId } from "../annots.js";
import * as api from "../api.js";
import * as dlg from "../dialogs.js";
import { drawPrims } from "../view.js";
import { finalize } from "../tools.js";
import { rotateFree, rotateAbout, scaleAbout, freeRotatable } from "../pages.js";
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

  /**
   * The symbol's items with the base point at pt, turned by symRot (degrees counter-clockwise; by
   * quarter turns when an item cannot turn freely, as grips do) and scaled by symScale.
   */
  symbolAt(sym, pt) {
    const items = placeItems(sym.items, pt);
    const k = this.symScale > 0 ? this.symScale : 1;
    const deg = Number(this.symRot) || 0;
    if (k !== 1) for (const it of items) scaleAbout(it, k, pt);
    if (deg) {
      if (items.every(freeRotatable)) for (const it of items) rotateFree(it, deg, pt);
      else {
        const q = ((Math.round(deg / 90) % 4) + 4) % 4;
        const cw = (360 - q * 90) % 360;
        for (const it of items) rotateAbout(it, cw, pt, this.S(), this.measure);
      }
    }
    return items;
  }

  /** INSERT's R and S options: the angle (degrees, counter-clockwise) and the scale of the next symbols. */
  askSymbolRot() {
    this.askValue(`Rotația simbolului în grade, în sens trigonometric (acum: ${String(Number(this.symRot) || 0).replace(".", ",")}°)`, (v) => {
      const d = Number(String(v).replace(",", "."));
      if (!Number.isFinite(d) || Math.abs(d) > 3600) return false;
      this.symRot = Math.round((((d % 360) + 360) % 360) * 10) / 10;
      const sym = this.currentSymbol();
      if (sym && this.symRot % 90 && !sym.items.every((it) => freeRotatable(it)))
        dlg.toast("Simbolul are elemente care se rotesc doar cu sferturi de tură (simboluri, tabele, chenare): se pune la cel mai apropiat multiplu de 90°", 6000);
      return true;
    });
  }

  askSymbolScale() {
    this.askValue(`Scara simbolului (acum: ${String(this.symScale > 0 ? this.symScale : 1).replace(".", ",")})`, (v) => {
      const k = Number(String(v).replace(",", "."));
      if (!(k >= 0.05 && k <= 20)) return false;
      this.symScale = Math.round(k * 1000) / 1000;
      return true;
    });
  }

  /** The symbol's items at pt, for the preview (images as their outline). */
  symbolPreview(pt) {
    const sym = this.currentSymbol();
    if (!sym) return null;
    const S = this.S();
    const prims = [];
    this.symbolAt(sym, pt).forEach((it, i) => {
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
    const items = this.symbolAt(sym, pt);
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

  /** The library picture with the symbol's images drawn in (they decode asynchronously). */
  async symbolThumbFull(sym) {
    const imgs = new Map();
    for (const it of sym.items) {
      const data = it.type === "image" ? it.data : it.type === "tblock" && it.tpl && it.tpl.logo ? it.tpl.logo.data : null;
      if (!data || imgs.has(data)) continue;
      const im = new Image();
      im.src = data;
      try {
        await im.decode();
        imgs.set(data, im);
      } catch (_) { /* not drawn */ }
    }
    return this.symbolThumb(sym, 132, 84, imgs);
  }

  /** A small picture of the symbol for the library (PNG data URL); images from `imgs` (data → image). */
  symbolThumb(sym, w = 132, h = 84, imgs = null) {
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
    if (imgs) {
      for (const it of sym.items) {
        const im = it.type === "image" && imgs.get(it.data);
        if (im && Array.isArray(it.r)) ctx.drawImage(im, it.r[0], it.r[1], it.r[2] - it.r[0], it.r[3] - it.r[1]);
      }
    }
    return cv.toDataURL("image/png");
  }
}
