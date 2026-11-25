// Rendering of the page and annotations on <canvas>, with zoom and pan.
import * as api from "./api.js";
import { tr } from "./i18n.js";

// The only place for colors in JS (canvas drawing cannot use CSS variables; the interface uses the
// :root tokens in app.css). tools/check_rules.py fails on a hex color anywhere else in the JS.
export const COLORS = {
  // primitive colors (annotation layers and editor-only marks)
  add: "#2f6fd6",
  rev: "#c62828",
  white: "#ffffff",
  edgray: "#8a929c",
  edred: "#d32f2f",
  edgreen: "#2e9d5b",
  sel: "#f2a93b",
  gripHot: "#e53935", // hot grips, red as in AutoCAD
  gripEdge: "#1a1a1a", // grip outline: amber alone is 2:1 on the white sheet
  preview: "#2f6fd6",
  // highlighter (multiply over the sheet) and review comments
  hlGreen: "#5fd35f",
  hlYellow: "#ffe14a",
  hlPink: "#ff7eb9",
  cmt: "#ffcf3f",
  cmtDone: "#c3c9d1",
  cmtInk: "#5c4400",
  // stamps keep their color in every export; the watermark is a faint gray
  stRed: "#c62828",
  stGreen: "#2e7d32",
  stBlue: "#1f4fbf",
  wm: "#7a7f87",
  // editor
  canvasBg: "#2b3038",
  inkDefault: "#111111",
  hitMark: "#f08c00",
  cmpGhost: "#d62828", // the older revision drawn over the page while picking alignment points
  snapMark: "#1f9d55", // tracking lines and acquired points: ≥ 3:1 on the white sheet and on the canvas
  acquired: "#d06f00", // the snap marker: ≥ 3:1 on the white sheet
  tipLine: "#4a525d",
  tipBg: "#f1f3f5",
  selWindow: "#4c9aff",
  selCrossing: "#3ccf8e",
  // swatches for symbol previews in the dark panel
  uiDark: "#15181c",
  uiLight: "#e8eaed",
  // cover colors offered in the panel / removal dialog (values stored in annotations)
  coverPaper: "#f4f1e8",
};

const colorOf = (c) => COLORS[c] || (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : COLORS.inkDefault);

// whole page: ~12 MP (≈ 48 MB decoded in the browser); beyond that, at high zoom, the detail area takes over
const BASE_MAX_PX = 12e6;

// page images are kept as ImageBitmap: when replaced they are released immediately (close), not when
// the garbage collector gets to them — zooming in and out would otherwise pile up hundreds of MB
const toBitmap = (im) => (typeof createImageBitmap === "function" ? createImageBitmap(im) : Promise.reject(new Error("no ImageBitmap"))).catch(() => im);
const release = (x) => {
  if (x && typeof x.close === "function") x.close();
};
const DETAIL_MAX_PX = 22e6; // detail area (the server accepts up to 24 MP)

// images of image annotations, loaded once (the id is the hash of the content)
const IMAGES = new Map();
let imgDoc = null;
let imgRedraw = null;

function imageOf(img) {
  if (!imgDoc || !img) return null;
  const key = `${imgDoc}/${img}`;
  let im = IMAGES.get(key);
  if (!im) {
    im = new Image();
    im.onload = () => imgRedraw && imgRedraw();
    im.src = api.imageUrl(imgDoc, img);
    IMAGES.set(key, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

function drawImagePrim(ctx, p, outline) {
  const [x0, y0, x1, y1] = p.p;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  const im = outline ? null : imageOf(p.img);
  if (!im) {
    // selection outline, or the image still loading
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), w, h);
    return;
  }
  const rot = (p.rot || 0) % 360;
  const [iw, ih] = rot === 90 || rot === 270 ? [h, w] : [w, h];
  ctx.save();
  ctx.translate((x0 + x1) / 2, (y0 + y1) / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.globalAlpha *= p.op ?? 1;
  ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
  ctx.restore();
}

export function drawPrims(ctx, prims, zoom, color = colorOf, minPx = 0.8, opts = {}) {
  let font = null; // setting ctx.font is slow: only when the size changes
  for (const p of prims) {
    if (p.op != null || p.blend || p.cap) {
      // highlighter: transparent, multiplied over the drawing, round ends (only in the normal pass)
      ctx.save();
      if (color === colorOf) {
        ctx.globalAlpha *= p.op ?? 1;
        if (p.blend === "multiply") ctx.globalCompositeOperation = "multiply";
      }
      if (p.cap === "round") {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      }
      drawPrims(ctx, [{ ...p, op: undefined, blend: undefined, cap: undefined, w: color === colorOf ? p.w : 0 }], zoom, color, minPx, opts);
      ctx.restore();
      continue;
    }
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
    } else if (p.t === "I") {
      drawImagePrim(ctx, p, color !== colorOf);
    } else if (p.t === "C") {
      ctx.beginPath();
      ctx.arc(p.p[0], p.p[1], p.r, 0, Math.PI * 2);
      if (p.fill) ctx.fill();
      if (!p.nostroke) ctx.stroke();
    } else if (p.t === "T") {
      const f = `${p.s}px osifont`;
      if (f !== font) {
        ctx.font = f;
        font = f;
      }
      if (!p.a) {
        ctx.fillText(p.txt, p.p[0], p.p[1]);
      } else {
        ctx.save();
        ctx.translate(p.p[0], p.p[1]);
        ctx.rotate((-p.a * Math.PI) / 180);
        ctx.fillText(p.txt, 0, 0);
        ctx.restore();
      }
    }
  }
  ctx.setLineDash([]);
}

// ------------------------------------------------------------------ the view
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

  dropDetail() {
    if (!this.detail) return;
    if (this.detail.blob) URL.revokeObjectURL(this.detail.blob);
    release(this.detail.img);
    this.detail = null;
  }

  dropImage() {
    release(this.img);
    this.img = null;
    if (this.imgBlob) URL.revokeObjectURL(this.imgBlob);
    this.imgBlob = null;
    this.dropDetail();
  }

  setPage(docId, n, w, h, keepView = false) {
    this.docId = docId;
    imgDoc = docId;
    imgRedraw = () => this.redraw();
    this.pageN = n;
    this.pageW = w;
    this.pageH = h;
    this.dropImage();
    this.imgScale = 0;
    this.detailKey = null;
    if (!keepView) this.fit();
    this.loadImage(true);
  }

  clear() {
    this.docId = null;
    this.dropImage();
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

  /** Zoom to a rectangle of the page (an annotation or a selection), with a margin. */
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
    const q = Math.pow(2, Math.ceil(Math.log2(want) * 2) / 2); // steps of √2
    // whole page at most ~12 MP; beyond that, at high zoom, only the visible area is rendered
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
      toBitmap(im).then((bmp) => {
        if (this.loadingKey !== key) {
          if (bmp !== im) release(bmp);
          return;
        }
        if (this.imgBlob) URL.revokeObjectURL(this.imgBlob);
        this.imgBlob = null;
        if (bmp !== im && blobUrl) URL.revokeObjectURL(blobUrl);
        else this.imgBlob = blobUrl;
        release(this.img);
        this.img = bmp;
        this.imgScale = scale;
        this.imgQuery = extra;
        this.loadingKey = null;
        this.redraw();
      });
    };
    im.onerror = () => {
      this.loadingKey = null;
    };
    const ops = this.app.removalOps ? this.app.removalOps(this.pageN) : [];
    if (ops.length) {
      // with removals: the page is rendered with them applied, as in the exported PDF
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

  /** The visible detail at high zoom: only the on-screen area (plus a margin), at the required resolution. */
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
    const g = 256 / scale; // grid in points: areas reusable from the cache on small pans
    const x0 = Math.max(0, Math.floor((vx0 - mx) / g) * g);
    const y0 = Math.max(0, Math.floor((vy0 - my) / g) * g);
    const x1 = Math.min(this.pageW, Math.ceil((vx1 + mx) / g) * g);
    const y1 = Math.min(this.pageH, Math.ceil((vy1 + my) / g) * g);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const d = this.detail;
    const q2 = this.app.renderQuery ? this.app.renderQuery(this.pageN) : "";
    // the current detail already covers the screen at the required resolution
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
      toBitmap(im).then((bmp) => {
        if (this.detailKey !== key) {
          if (bmp !== im) release(bmp);
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          return;
        }
        let blob = blobUrl;
        if (bmp !== im && blobUrl) {
          URL.revokeObjectURL(blobUrl);
          blob = null;
        }
        this.dropDetail();
        this.detail = { img: bmp, rect, scale, page, doc, query: q2, blob };
        this.detailKey = null;
        this.redraw();
      });
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
    // new frame: changes made in the meantime (dragging, panel) show on redraw
    this.app.frame = (this.app.frame || 0) + 1;
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.canvasBg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.pageW) return;
    const z = this.zoom;
    ctx.setTransform(d * z, 0, 0, d * z, d * this.panX, d * this.panY);
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 24 * d;
    ctx.fillStyle = COLORS.white;
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
    // revision compare: the overlay (red / green / gray) over the page, as strong as the slider says
    const cmp = this.app.compare;
    if (cmp && cmp.page === this.pageN && cmp.img && cmp.alpha > 0) {
      ctx.save();
      ctx.globalAlpha = cmp.alpha;
      ctx.drawImage(cmp.img, 0, 0, this.pageW, this.pageH);
      ctx.restore();
      if (this.cmpBox) {
        const [x0, y0, x1, y1] = this.cmpBox;
        ctx.save();
        ctx.strokeStyle = COLORS.hitMark;
        ctx.lineWidth = 2 / z;
        ctx.setLineDash([6 / z, 4 / z]);
        ctx.strokeRect(x0 - 4 / z, y0 - 4 / z, x1 - x0 + 8 / z, y1 - y0 + 8 / z);
        ctx.restore();
      }
    }
    // two-point alignment: after the two points on this page, the older page half transparent over it
    const pick = this.app.cmpPick;
    if (pick && pick.page === this.pageN) {
      if (pick.pts.length >= 2 && pick.img && pick.img.complete && pick.img.naturalWidth) {
        // in red, multiplied over the page: its white disappears, its lines stand apart from this page's
        if (!pick.tint) {
          const t = document.createElement("canvas");
          t.width = pick.img.naturalWidth;
          t.height = pick.img.naturalHeight;
          const c2 = t.getContext("2d");
          c2.drawImage(pick.img, 0, 0);
          c2.globalCompositeOperation = "screen";
          c2.fillStyle = COLORS.cmpGhost;
          c2.fillRect(0, 0, t.width, t.height);
          pick.tint = t;
        }
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = 0.85;
        ctx.drawImage(pick.tint, 0, 0, this.pageW, this.pageH);
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = COLORS.hitMark;
      ctx.fillStyle = COLORS.hitMark;
      ctx.lineWidth = 2 / z;
      ctx.font = `${12 / z}px sans-serif`;
      pick.pts.forEach((q, i) => {
        ctx.beginPath();
        ctx.arc(q[0], q[1], 6 / z, 0, Math.PI * 2);
        ctx.moveTo(q[0] - 10 / z, q[1]);
        ctx.lineTo(q[0] + 10 / z, q[1]);
        ctx.moveTo(q[0], q[1] - 10 / z);
        ctx.lineTo(q[0], q[1] + 10 / z);
        ctx.stroke();
        ctx.fillText(i < 2 ? `${i + 1}` : `${i - 1}′`, q[0] + 8 / z, q[1] - 8 / z);
      });
      ctx.restore();
    }
    const app = this.app;
    const single = app.sel.size === 1;
    const grips = app.sel.size > 0 && app.sel.size <= (app.gripLimit || 100);
    const hv = app.hover;
    // only what is on screen is drawn: zoomed in on a large drawing, most annotations are skipped
    const m = 4 / z;
    const vx0 = -this.panX / z - m;
    const vy0 = -this.panY / z - m;
    const vx1 = (this.canvas.width / d - this.panX) / z + m;
    const vy1 = (this.canvas.height / d - this.panY) / z + m;
    for (const { a, built } of app.visibleBuilt()) {
      const on = app.isSelected(a.id);
      const bb = built.bbox;
      if (!on && bb && (bb[2] < vx0 || bb[0] > vx1 || bb[3] < vy0 || bb[1] > vy1)) continue;
      if (hv && hv.a.id === a.id && hv.kind === "body" && !on) {
        // under the cursor: the outline lights up slightly, to show what would be grabbed
        ctx.globalAlpha = 0.22;
        drawPrims(ctx, built.prims.filter((p) => p.t !== "R"), z, () => COLORS.sel, 6, { noDash: true });
        ctx.globalAlpha = 1;
      }
      if (on) {
        // selection outline beneath the drawing; text gets a box
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
      if (on && grips && !single) {
        // several selected: the grips of each one (no resize corners)
        this.drawHandles(app.gripsOf(a, true), hv && hv.kind === "handle" && hv.a.id === a.id ? hv.h : null, (k) => app.isHotGrip(a.id, k));
      }
      if (on && single) {
        // annotation box, to show where it is resized from
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
        this.drawHandles(built.handles || [], hv && hv.kind === "handle" ? hv.h : null, (k) => app.isHotGrip(a.id, k));
      }
    }
    if (app.showOcr && app.ocr) {
      const o = app.ocr.get(app.page);
      if (o && o.lines) this.drawOcr(o.lines);
    }
    if (app.hit && app.hit.page === app.page) {
      const [x0, y0, x1, y1] = app.hit.box;
      const m = 3 / z;
      ctx.strokeStyle = COLORS.hitMark;
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
    const tk = app.pointMod && app.pointMod.kind === "tk" ? app.pointMod.pts : null;
    if (tk && tk.length) {
      // TK: the tracking path so far, with its points
      const prims = tk.slice(1).map((p, i) => ({ t: "L", p: [...tk[i], ...p], w: 0.6, c: "preview", dash: true }));
      for (const p of tk) prims.push({ t: "C", p: [...p], r: 4 / z, w: 0.6, c: "preview" });
      drawPrims(ctx, prims, z);
    }
    if ((app.acq && app.acq.length) || app.parSeg) this.drawAcquired(app.acq || [], app.parSeg);
    // label next to the cursor: what the handle / box under the cursor does, or the value while dragging
    if (app.dragTip) this.drawTip(app.dragTip.txt, app.dragTip.p[0], app.dragTip.p[1]);
    else if (hv && hv.label && app.hoverPt && !(ov && ov.snap) && !(app.gripMenu && app.gripMenu.shown)) this.drawTip(hv.label, app.hoverPt[0], app.hoverPt[1], true);
  }

  /** Recognized text (OCR): green boxes, with the read text above when it is large enough on screen. */
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

  drawHandles(handles, hot, isHot = () => false) {
    const ctx = this.ctx;
    const s = 7 / this.zoom;
    if (hot && hot.p) {
      // handle under the cursor: a ring around it
      ctx.beginPath();
      ctx.arc(hot.p[0], hot.p[1], 9 / this.zoom, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(242,169,59,0.25)";
      ctx.fill();
      ctx.strokeStyle = COLORS.sel;
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.stroke();
    }
    for (const h of handles) {
      if (!h.p) continue;
      ctx.fillStyle = h.k === "tx" ? COLORS.white : isHot(h.k) ? COLORS.gripHot : COLORS.sel;
      ctx.strokeStyle = h.k === "tx" ? COLORS.sel : COLORS.gripEdge;
      ctx.lineWidth = 1.2 / this.zoom;
      if (h.k === "sc") {
        // resize handle: white outline with a diagonal arrow
        const q = s * 1.15;
        ctx.fillStyle = COLORS.white;
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
    // tracking / extension / polar lines: dotted, green, extended past the point
    if (sn.guides) {
      ctx.save();
      ctx.strokeStyle = COLORS.snapMark;
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
    ctx.strokeStyle = COLORS.acquired;
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
        // hourglass, as in AutoCAD
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
      case "g":
        // geometric center: a polygon with a dot, as in AutoCAD
        for (let i = 0; i <= 5; i++) {
          const th = (i * Math.PI) / 2.5 - Math.PI / 2;
          const px = x + s * 0.6 * Math.cos(th);
          const py = y + s * 0.6 * Math.sin(th);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.moveTo(x + s * 0.12, y);
        ctx.arc(x, y, s * 0.12, 0, Math.PI * 2);
        break;
      case "i":
        // insertion: two stacked squares
        ctx.rect(x - s * 0.55, y - s * 0.55, s * 0.6, s * 0.6);
        ctx.rect(x - s * 0.05, y - s * 0.05, s * 0.6, s * 0.6);
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

  /** Label next to the cursor, in screen pixels (like AutoCAD's snap tooltip). */
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
    ctx.strokeStyle = subtle ? COLORS.tipLine : COLORS.acquired;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(sx, sy, w, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.tipBg;
    ctx.fillText(txt, sx + 6, sy + 14);
    ctx.restore();
  }

  /** Points acquired for tracking: small orange cross; the segment for parallel: "//". */
  drawAcquired(acq, par) {
    const ctx = this.ctx;
    const z = this.zoom;
    const s = 4 / z;
    ctx.strokeStyle = COLORS.snapMark;
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
