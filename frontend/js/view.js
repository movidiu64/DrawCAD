// Afișarea paginii și a adnotărilor pe <canvas>, cu zoom și deplasare.
import * as api from "./api.js";
import { tr } from "./i18n.js";

export const COLORS = {
  add: "#2f6fd6",
  rev: "#c62828",
  white: "#ffffff",
  edgray: "#8a929c",
  edred: "#d32f2f",
  edgreen: "#2e9d5b",
  sel: "#f2a93b",
  preview: "#2f6fd6",
};

const colorOf = (c) => COLORS[c] || (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#111");

const BASE_MAX_PX = 20e6; // pagina întreagă
const DETAIL_MAX_PX = 22e6; // zona de detaliu (serverul acceptă până la 24 MP)

export function drawPrims(ctx, prims, zoom, color = colorOf, minPx = 0.8, opts = {}) {
  for (const p of prims) {
    const col = color(p.c);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(p.w || 0.7, minPx / zoom);
    ctx.setLineDash(p.dp && !opts.noDash ? p.dp : p.dash ? [5 / zoom, 4 / zoom] : []);
    if (p.t === "L") {
      ctx.beginPath();
      ctx.moveTo(p.p[0], p.p[1]);
      ctx.lineTo(p.p[2], p.p[3]);
      ctx.stroke();
    } else if (p.t === "P") {
      ctx.beginPath();
      ctx.moveTo(p.p[0], p.p[1]);
      for (let i = 2; i < p.p.length; i += 2) ctx.lineTo(p.p[i], p.p[i + 1]);
      if (p.close) ctx.closePath();
      if (p.fill) ctx.fill();
      if (!p.nostroke) ctx.stroke();
    } else if (p.t === "R") {
      ctx.fillRect(p.p[0], p.p[1], p.p[2] - p.p[0], p.p[3] - p.p[1]);
    } else if (p.t === "C") {
      ctx.beginPath();
      ctx.arc(p.p[0], p.p[1], p.r, 0, Math.PI * 2);
      if (p.fill) ctx.fill();
      if (!p.nostroke) ctx.stroke();
    } else if (p.t === "T") {
      ctx.save();
      ctx.translate(p.p[0], p.p[1]);
      ctx.rotate((-(p.a || 0) * Math.PI) / 180);
      ctx.font = `${p.s}px osifont`;
      ctx.fillText(p.txt, 0, 0);
      ctx.restore();
    }
  }
  ctx.setLineDash([]);
}

// ------------------------------------------------------------------ vederea
export class View {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.app = app;
    this.zoom = 1;
    this.panX = 40;
    this.panY = 40;
    this.pageW = 0;
    this.pageH = 0;
    this.img = null;
    this.imgKey = null;
    this.imgScale = 0;
    this.overlay = null; // { prims, snap, rect }
    this.pending = false;
    this.reloadTimer = null;
    this.dpr = window.devicePixelRatio || 1;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.cw = r.width;
    this.ch = r.height;
    this.redraw();
  }

  setPage(docId, n, w, h, keepView = false) {
    this.docId = docId;
    this.pageN = n;
    this.pageW = w;
    this.pageH = h;
    this.img = null;
    this.imgScale = 0;
    this.detail = null;
    this.detailKey = null;
    if (!keepView) this.fit();
    this.loadImage(true);
  }

  clear() {
    this.docId = null;
    this.img = null;
    this.pageW = this.pageH = 0;
    this.redraw();
  }

  fit() {
    if (!this.pageW || !this.cw) return;
    const m = 24;
    this.zoom = Math.min((this.cw - 2 * m) / this.pageW, (this.ch - 2 * m) / this.pageH);
    this.panX = (this.cw - this.pageW * this.zoom) / 2;
    this.panY = (this.ch - this.pageH * this.zoom) / 2;
    this.afterZoom();
  }

  /** Zoom pe un dreptunghi din pagină (o adnotare sau o selecție), cu margine. */
  zoomToBox(b, margin = 60) {
    if (!b || !this.cw) return;
    const w = Math.max(b[2] - b[0], 20);
    const h = Math.max(b[3] - b[1], 20);
    this.zoom = Math.min(40, Math.max(0.05, Math.min((this.cw - 2 * margin) / w, (this.ch - 2 * margin) / h, 4)));
    this.panX = this.cw / 2 - ((b[0] + b[2]) / 2) * this.zoom;
    this.panY = this.ch / 2 - ((b[1] + b[3]) / 2) * this.zoom;
    this.afterZoom();
  }

  zoomAt(factor, sx, sy) {
    const nz = Math.min(40, Math.max(0.05, this.zoom * factor));
    const k = nz / this.zoom;
    this.panX = sx - (sx - this.panX) * k;
    this.panY = sy - (sy - this.panY) * k;
    this.zoom = nz;
    this.afterZoom();
  }

  setZoom(z) {
    this.zoomAt(z / this.zoom, this.cw / 2, this.ch / 2);
  }

  afterZoom() {
    this.app.onZoom(this.zoom);
    this.redraw();
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.loadImage(false), 220);
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.redraw();
    if (this.detailNeeded) this.scheduleDetail();
  }

  toPage(sx, sy) {
    return [(sx - this.panX) / this.zoom, (sy - this.panY) / this.zoom];
  }

  toScreen(p) {
    return [p[0] * this.zoom + this.panX, p[1] * this.zoom + this.panY];
  }

  loadImage(force) {
    if (!this.docId || !this.pageW) return;
    const want = this.zoom * this.dpr;
    const q = Math.pow(2, Math.ceil(Math.log2(want) * 2) / 2); // trepte de √2
    // pagina întreagă cel mult ~20 MP; peste, la zoom mare, se randează doar zona vizibilă
    const maxBase = Math.sqrt(BASE_MAX_PX / (this.pageW * this.pageH));
    const scale = Math.min(Math.max(q, 0.25), 16, Math.max(0.25, Math.pow(2, Math.floor(Math.log2(maxBase) * 2) / 2)));
    this.detailNeeded = want > scale * 1.05;
    if (this.detailNeeded) this.scheduleDetail();
    const q2 = this.app.renderQuery ? this.app.renderQuery(this.pageN) : "";
    if (!force && this.img && q2 === this.imgQuery && scale <= this.imgScale * 1.01 && scale >= this.imgScale / 2.9) return;
    const extra = this.app.renderQuery ? this.app.renderQuery(this.pageN) : "";
    const key = `${this.docId}/${this.pageN}/${scale}${extra}`;
    if (this.loadingKey === key) return;
    this.loadingKey = key;
    const im = new Image();
    let blobUrl = null;
    im.onload = () => {
      if (this.loadingKey !== key) return;
      if (this.imgBlob) URL.revokeObjectURL(this.imgBlob);
      this.imgBlob = blobUrl;
      this.img = im;
      this.imgScale = scale;
      this.imgQuery = extra;
      this.loadingKey = null;
      this.redraw();
    };
    im.onerror = () => {
      this.loadingKey = null;
    };
    const ops = this.app.removalOps ? this.app.removalOps(this.pageN) : [];
    if (ops.length) {
      // cu ștergeri: pagina se randează cu ele aplicate, ca în PDF-ul exportat
      const ink = this.app.settings.ink && this.app.settings.ink.all ? this.app.settings.ink : null;
      const bk = ink ? [] : this.app.annots.filter((a) => a.type === "ink" && a.page === this.pageN).flatMap((a) => a.ids || []);
      const all = bk.length ? [{ mode: "black", ids: bk }, ...ops] : ops;
      api.previewRemoval(this.docId, this.pageN, all, scale, ink).then((url) => {
        if (this.loadingKey !== key) {
          URL.revokeObjectURL(url);
          return;
        }
        blobUrl = url;
        im.src = url;
      }).catch(() => {
        this.loadingKey = null;
      });
      return;
    }
    im.src = api.renderUrl(this.docId, this.pageN, scale, extra);
  }

  /** Detaliul vizibil la zoom mare: doar zona de pe ecran (plus o margine), la rezoluția cerută. */
  scheduleDetail() {
    clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => this.loadDetail(), 140);
  }

  loadDetail() {
    if (!this.docId || !this.pageW || !this.detailNeeded) return;
    const want = this.zoom * this.dpr;
    const scale = Math.min(64, Math.pow(2, Math.ceil(Math.log2(want) * 2) / 2));
    const vx0 = -this.panX / this.zoom;
    const vy0 = -this.panY / this.zoom;
    const vx1 = (this.cw - this.panX) / this.zoom;
    const vy1 = (this.ch - this.panY) / this.zoom;
    let mx = (vx1 - vx0) * 0.25;
    let my = (vy1 - vy0) * 0.25;
    if ((vx1 - vx0 + 2 * mx) * (vy1 - vy0 + 2 * my) * scale * scale > DETAIL_MAX_PX) mx = my = 0;
    const g = 256 / scale; // grilă în puncte: zone refolosibile din cache la deplasări mici
    const x0 = Math.max(0, Math.floor((vx0 - mx) / g) * g);
    const y0 = Math.max(0, Math.floor((vy0 - my) / g) * g);
    const x1 = Math.min(this.pageW, Math.ceil((vx1 + mx) / g) * g);
    const y1 = Math.min(this.pageH, Math.ceil((vy1 + my) / g) * g);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const d = this.detail;
    const q2 = this.app.renderQuery ? this.app.renderQuery(this.pageN) : "";
    // detaliul de acum acoperă deja ecranul la rezoluția cerută
    if (d && d.page === this.pageN && d.doc === this.docId && d.query === q2 && d.scale >= scale / 1.01
      && d.rect[0] <= Math.max(0, vx0) && d.rect[1] <= Math.max(0, vy0) && d.rect[2] >= Math.min(this.pageW, vx1) && d.rect[3] >= Math.min(this.pageH, vy1)) return;
    const rect = [x0, y0, x1, y1].map((v) => Math.round(v * 100) / 100);
    const clip = rect.join(",");
    const key = `${this.docId}/${this.pageN}/${scale}/${clip}${q2}`;
    if (this.detailKey === key) return;
    this.detailKey = key;
    const im = new Image();
    let blobUrl = null;
    const page = this.pageN;
    const doc = this.docId;
    im.onload = () => {
      if (this.detailKey !== key) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      if (this.detail && this.detail.blob) URL.revokeObjectURL(this.detail.blob);
      this.detail = { img: im, rect, scale, page, doc, query: q2, blob: blobUrl };
      this.detailKey = null;
      this.redraw();
    };
    im.onerror = () => {
      if (this.detailKey === key) this.detailKey = null;
    };
    const ops = this.app.removalOps ? this.app.removalOps(this.pageN) : [];
    if (ops.length) {
      const ink = this.app.settings.ink && this.app.settings.ink.all ? this.app.settings.ink : null;
      const bk = ink ? [] : this.app.annots.filter((a) => a.type === "ink" && a.page === this.pageN).flatMap((a) => a.ids || []);
      const all = bk.length ? [{ mode: "black", ids: bk }, ...ops] : ops;
      api.previewRemoval(this.docId, this.pageN, all, scale, ink, clip).then((url) => {
        blobUrl = url;
        im.src = url;
      }).catch(() => {
        if (this.detailKey === key) this.detailKey = null;
      });
      return;
    }
    im.src = api.renderUrl(this.docId, this.pageN, scale, `${q2}&clip=${clip}`);
  }

  redraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  draw() {
    // cadru nou: modificările făcute între timp (tragere, panou) se văd la redesenare
    this.app.frame = (this.app.frame || 0) + 1;
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#2b3038";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.pageW) return;
    const z = this.zoom;
    ctx.setTransform(d * z, 0, 0, d * z, d * this.panX, d * this.panY);
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 24 * d;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, this.pageW, this.pageH);
    ctx.shadowBlur = 0;
    if (this.img && !this.app.hidden.has("orig")) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.img, 0, 0, this.pageW, this.pageH);
      const dt = this.detail;
      const q2 = this.app.renderQuery ? this.app.renderQuery(this.pageN) : "";
      if (this.detailNeeded && dt && dt.page === this.pageN && dt.doc === this.docId && dt.query === q2) {
        const [x0, y0, x1, y1] = dt.rect;
        ctx.drawImage(dt.img, x0, y0, x1 - x0, y1 - y0);
      }
    }
    const app = this.app;
    const single = app.sel.size === 1;
    const hv = app.hover;
    for (const { a, built } of app.visibleBuilt()) {
      const on = app.isSelected(a.id);
      if (hv && hv.a.id === a.id && hv.kind === "body" && !on) {
        // sub cursor: conturul se aprinde ușor, ca să se vadă ce se apucă
        ctx.globalAlpha = 0.22;
        drawPrims(ctx, built.prims.filter((p) => p.t !== "R"), z, () => COLORS.sel, 6, { noDash: true });
        ctx.globalAlpha = 1;
      }
      if (on) {
        // contur de selecție sub desen; textul primește o casetă
        ctx.globalAlpha = 0.35;
        drawPrims(ctx, built.prims.filter((p) => p.t !== "T" && p.t !== "R"), z, () => COLORS.sel, 5, { noDash: true });
        if (!single && built.bbox) {
          const [x0, y0, x1, y1] = built.bbox;
          ctx.fillStyle = COLORS.sel;
          ctx.globalAlpha = 0.12;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        ctx.globalAlpha = 1;
      }
      drawPrims(ctx, built.prims, z);
      if (on && single) {
        // caseta adnotării, ca să se vadă de unde se mărește
        if (built.bbox && (built.handles || []).some((h) => h.k === "sc")) {
          const [x0, y0, x1, y1] = built.bbox;
          ctx.setLineDash([4 / z, 3 / z]);
          ctx.strokeStyle = COLORS.sel;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1 / z;
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        this.drawHandles(built, hv && hv.kind === "handle" ? hv.h : null);
      }
    }
    if (app.showOcr && app.ocr) {
      const o = app.ocr.get(app.page);
      if (o && o.lines) this.drawOcr(o.lines);
    }
    if (app.hit && app.hit.page === app.page) {
      const [x0, y0, x1, y1] = app.hit.box;
      const m = 3 / z;
      ctx.strokeStyle = "#f08c00";
      ctx.lineWidth = 2.5 / z;
      ctx.strokeRect(x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m);
    }
    const ov = this.overlay;
    if (ov) {
      if (ov.prims) {
        ctx.globalAlpha = 0.9;
        drawPrims(ctx, ov.prims, z);
        ctx.globalAlpha = 1;
      }
      if (ov.rect) {
        const [x0, y0, x1, y1] = ov.rect;
        ctx.setLineDash([6 / z, 4 / z]);
        ctx.strokeStyle = ov.rectColor || COLORS.sel;
        ctx.lineWidth = 1.5 / z;
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        ctx.setLineDash([]);
      }
      if (ov.snap) this.drawSnap(ov.snap);
    }
    if ((app.acq && app.acq.length) || app.parSeg) this.drawAcquired(app.acq || [], app.parSeg);
    // eticheta de lângă cursor: ce face mânerul / caseta de sub cursor, sau valoarea în timpul tragerii
    if (app.dragTip) this.drawTip(app.dragTip.txt, app.dragTip.p[0], app.dragTip.p[1]);
    else if (hv && hv.label && app.hoverPt && !(ov && ov.snap)) this.drawTip(hv.label, app.hoverPt[0], app.hoverPt[1], true);
  }

  /** Textul recunoscut (OCR): casete verzi, cu textul citit deasupra când e destul de mare pe ecran. */
  drawOcr(lines) {
    const ctx = this.ctx;
    const z = this.zoom;
    ctx.save();
    ctx.lineWidth = 1 / z;
    for (const ln of lines) {
      const [x0, y0, x1, y1] = ln.box;
      const sure = ln.conf >= 75;
      ctx.strokeStyle = sure ? "rgba(23,140,80,0.85)" : "rgba(214,120,0,0.85)";
      ctx.fillStyle = sure ? "rgba(23,140,80,0.10)" : "rgba(214,120,0,0.10)";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      const fs = Math.max(ln.cap || 3, 3) * 1.1;
      if (fs * z >= 8) {
        ctx.font = `${fs}px osifont, sans-serif`;
        ctx.fillStyle = sure ? "rgba(23,120,70,0.95)" : "rgba(190,100,0,0.95)";
        if (ln.rot === 90) {
          ctx.save();
          ctx.translate(x0 - fs * 0.25, y1);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(ln.text, 0, 0);
          ctx.restore();
        } else ctx.fillText(ln.text, x0, y0 - fs * 0.25);
      }
    }
    ctx.restore();
  }

  drawHandles(built, hot) {
    const ctx = this.ctx;
    const s = 7 / this.zoom;
    if (hot && hot.p) {
      // mânerul de sub cursor: inel în jur
      ctx.beginPath();
      ctx.arc(hot.p[0], hot.p[1], 9 / this.zoom, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(242,169,59,0.25)";
      ctx.fill();
      ctx.strokeStyle = COLORS.sel;
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.stroke();
    }
    for (const h of built.handles || []) {
      if (!h.p) continue;
      ctx.fillStyle = h.k === "tx" ? "#ffffff" : COLORS.sel;
      ctx.strokeStyle = h.k === "tx" ? COLORS.sel : "#ffffff";
      ctx.lineWidth = 1.2 / this.zoom;
      if (h.k === "sc") {
        // pătrățelul de mărire: contur alb cu săgeată diagonală
        const q = s * 1.15;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = COLORS.sel;
        ctx.lineWidth = 1.6 / this.zoom;
        ctx.fillRect(h.p[0] - q / 2, h.p[1] - q / 2, q, q);
        ctx.strokeRect(h.p[0] - q / 2, h.p[1] - q / 2, q, q);
        ctx.beginPath();
        ctx.moveTo(h.p[0] - q * 0.3, h.p[1] - q * 0.3);
        ctx.lineTo(h.p[0] + q * 0.3, h.p[1] + q * 0.3);
        ctx.stroke();
        continue;
      }
      if (h.k === "tx") {
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], s * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(h.p[0] - s / 2, h.p[1] - s / 2, s, s);
        ctx.strokeRect(h.p[0] - s / 2, h.p[1] - s / 2, s, s);
      }
    }
  }

  drawSnap(sn) {
    const ctx = this.ctx;
    const z = this.zoom;
    const s = 9 / z;
    const [x, y] = sn.p;
    // linii de urmărire / extensie / polar: punctate, verzi, prelungite dincolo de punct
    if (sn.guides) {
      ctx.save();
      ctx.strokeStyle = "#3ccf8e";
      ctx.lineWidth = 1 / z;
      ctx.setLineDash([3 / z, 4 / z]);
      for (const g of sn.guides) {
        const dx = g.p[0] - g.o[0];
        const dy = g.p[1] - g.o[1];
        const L = Math.hypot(dx, dy) || 1;
        const k = 60 / z / L;
        ctx.beginPath();
        ctx.moveTo(g.o[0], g.o[1]);
        ctx.lineTo(g.p[0] + dx * k, g.p[1] + dy * k);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.strokeStyle = "#e07b00";
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    const X = (r) => {
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
    };
    switch (sn.kind) {
      case "m":
        ctx.moveTo(x, y - s * 0.7);
        ctx.lineTo(x + s * 0.65, y + s * 0.45);
        ctx.lineTo(x - s * 0.65, y + s * 0.45);
        ctx.closePath();
        break;
      case "c":
        ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
        break;
      case "x":
        X(s * 0.65);
        ctx.rect(x - s * 0.65, y - s * 0.65, s * 1.3, s * 1.3);
        break;
      case "ax":
        X(s * 0.65);
        ctx.rect(x - s * 0.65, y - s * 0.65, s * 1.3, s * 1.3);
        for (let i = 0; i < 3; i++) ctx.rect(x + s * (0.95 + i * 0.35), y + s * 0.55, 0.6 / z, 0.6 / z);
        break;
      case "n":
        // clepsidră, ca la AutoCAD
        ctx.moveTo(x - s / 2, y - s / 2);
        ctx.lineTo(x + s / 2, y - s / 2);
        ctx.lineTo(x - s / 2, y + s / 2);
        ctx.lineTo(x + s / 2, y + s / 2);
        ctx.closePath();
        break;
      case "q":
        ctx.moveTo(x, y - s * 0.6);
        ctx.lineTo(x + s * 0.6, y);
        ctx.lineTo(x, y + s * 0.6);
        ctx.lineTo(x - s * 0.6, y);
        ctx.closePath();
        break;
      case "p":
        ctx.moveTo(x - s * 0.6, y + s * 0.55);
        ctx.lineTo(x + s * 0.6, y + s * 0.55);
        ctx.moveTo(x, y + s * 0.55);
        ctx.lineTo(x, y - s * 0.65);
        ctx.moveTo(x - s * 0.6, y - s * 0.05);
        ctx.lineTo(x, y - s * 0.05);
        break;
      case "t":
        ctx.arc(x, y + s * 0.1, s * 0.5, 0, Math.PI * 2);
        ctx.moveTo(x - s * 0.7, y - s * 0.4);
        ctx.lineTo(x + s * 0.7, y - s * 0.4);
        break;
      case "par":
        ctx.moveTo(x - s * 0.55, y + s * 0.5);
        ctx.lineTo(x - s * 0.05, y - s * 0.5);
        ctx.moveTo(x + s * 0.05, y + s * 0.5);
        ctx.lineTo(x + s * 0.55, y - s * 0.5);
        break;
      case "ext":
      case "trk":
      case "pol":
        X(s * 0.4);
        break;
      default:
        ctx.rect(x - s / 2, y - s / 2, s, s);
    }
    ctx.stroke();
    if (sn.label) this.drawTip(sn.label, x, y);
  }

  /** Eticheta de lângă cursor, în pixeli de ecran (ca tooltip-ul de snap din AutoCAD). */
  drawTip(txt, x, y, subtle = false) {
    txt = tr(txt);
    const ctx = this.ctx;
    const d = this.dpr;
    const sx = Math.min(x * this.zoom + this.panX + 16, this.cw - 8 - txt.length * 6.5);
    const sy = Math.min(y * this.zoom + this.panY + 18, this.ch - 26);
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.font = "12px system-ui, sans-serif";
    const w = ctx.measureText(txt).width + 12;
    ctx.fillStyle = "rgba(21,24,28,0.92)";
    ctx.strokeStyle = subtle ? "#4a525d" : "#e07b00";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(sx, sy, w, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f1f3f5";
    ctx.fillText(txt, sx + 6, sy + 14);
    ctx.restore();
  }

  /** Punctele achiziționate pentru urmărire: cruciuliță portocalie mică; segmentul pentru paralel: „//”. */
  drawAcquired(acq, par) {
    const ctx = this.ctx;
    const z = this.zoom;
    const s = 4 / z;
    ctx.strokeStyle = "#3ccf8e";
    ctx.lineWidth = 1.6 / z;
    ctx.beginPath();
    for (const q of acq) {
      ctx.moveTo(q.p[0] - s, q.p[1]);
      ctx.lineTo(q.p[0] + s, q.p[1]);
      ctx.moveTo(q.p[0], q.p[1] - s);
      ctx.lineTo(q.p[0], q.p[1] + s);
    }
    if (par) {
      const m = [(par[0] + par[2]) / 2, (par[1] + par[3]) / 2];
      const k = 5 / z;
      ctx.moveTo(m[0] - k, m[1] + k);
      ctx.lineTo(m[0] - k * 0.2, m[1] - k);
      ctx.moveTo(m[0] + k * 0.2, m[1] + k);
      ctx.lineTo(m[0] + k, m[1] - k);
    }
    ctx.stroke();
  }

}
