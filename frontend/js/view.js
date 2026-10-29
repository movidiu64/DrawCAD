// Afișarea paginii și a adnotărilor pe <canvas>, cu zoom și deplasare.
import * as api from "./api.js";

export const COLORS = {
  add: "#2f6fd6",
  rev: "#c62828",
  white: "#ffffff",
  edgray: "#8a929c",
  edred: "#d32f2f",
  sel: "#f2a93b",
  preview: "#2f6fd6",
};

export function drawPrims(ctx, prims, zoom, color = (c) => COLORS[c] || "#111", minPx = 0.8) {
  for (const p of prims) {
    const col = color(p.c);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(p.w || 0.7, minPx / zoom);
    ctx.setLineDash(p.dash ? [5 / zoom, 4 / zoom] : []);
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

// ------------------------------------------------------------------ index de snap
export class SnapIndex {
  constructor(pts = [], segs = [], cell = 24) {
    this.cell = cell;
    this.grid = new Map();
    this.sgrid = new Map();
    for (const p of pts) this.add(p[0], p[1], p[2] || "e");
    for (const s of segs) this.addSeg(s);
  }

  key(i, j) {
    return i * 100003 + j;
  }

  add(x, y, kind) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push([x, y, kind]);
  }

  addSeg(s) {
    const i0 = Math.floor(Math.min(s[0], s[2]) / this.cell);
    const i1 = Math.floor(Math.max(s[0], s[2]) / this.cell);
    const j0 = Math.floor(Math.min(s[1], s[3]) / this.cell);
    const j1 = Math.floor(Math.max(s[1], s[3]) / this.cell);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) return; // segmente foarte lungi: doar capetele contează
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        let arr = this.sgrid.get(k);
        if (!arr) this.sgrid.set(k, (arr = []));
        arr.push(s);
      }
    }
  }

  nearest(x, y, tol, extra = []) {
    const PRIO = { c: 0, e: 1, a: 1, q: 2, m: 3 };
    let best = null;
    let bestScore = Infinity;
    const consider = (q) => {
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d > tol) return;
      const score = d + (PRIO[q[2]] ?? 2) * tol * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = { p: [q[0], q[1]], kind: q[2] };
      }
    };
    const r = Math.ceil(tol / this.cell);
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(y / this.cell);
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const arr = this.grid.get(this.key(i, j));
        if (arr) arr.forEach(consider);
      }
    }
    extra.forEach((q) => consider([q[0], q[1], "a"]));
    if (best) return best;
    // cel mai apropiat punct pe o linie
    let bd = tol;
    const seen = new Set();
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const arr = this.sgrid.get(this.key(i, j));
        if (!arr) continue;
        for (const s of arr) {
          if (seen.has(s)) continue;
          seen.add(s);
          const ax = s[0];
          const ay = s[1];
          const bx = s[2] - ax;
          const by = s[3] - ay;
          const L2 = bx * bx + by * by;
          let t = L2 ? ((x - ax) * bx + (y - ay) * by) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const px = ax + bx * t;
          const py = ay + by * t;
          const d = Math.hypot(px - x, py - y);
          if (d < bd) {
            bd = d;
            best = { p: [px, py], kind: "n" };
          }
        }
      }
    }
    return best;
  }
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
    const scale = Math.min(Math.max(q, 0.25), 16);
    if (!force && this.img && scale <= this.imgScale * 1.01 && scale >= this.imgScale / 2.9) return;
    const key = `${this.docId}/${this.pageN}/${scale}`;
    if (this.loadingKey === key) return;
    this.loadingKey = key;
    const im = new Image();
    im.onload = () => {
      if (this.loadingKey !== key) return;
      this.img = im;
      this.imgScale = scale;
      this.loadingKey = null;
      this.redraw();
    };
    im.onerror = () => {
      this.loadingKey = null;
    };
    im.src = api.renderUrl(this.docId, this.pageN, scale);
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
    if (this.img) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.img, 0, 0, this.pageW, this.pageH);
    }
    const app = this.app;
    const sel = app.selectedId;
    for (const { a, built } of app.visibleBuilt()) {
      if (a.id === sel) {
        // contur de selecție sub desen
        ctx.globalAlpha = 0.35;
        drawPrims(ctx, built.prims.filter((p) => p.t !== "T" && p.t !== "R"), z, () => COLORS.sel, 5);
        ctx.globalAlpha = 1;
      }
      drawPrims(ctx, built.prims, z);
      if (a.id === sel) this.drawHandles(built);
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
  }

  drawHandles(built) {
    const ctx = this.ctx;
    const s = 7 / this.zoom;
    for (const h of built.handles || []) {
      if (!h.p) continue;
      ctx.fillStyle = h.k === "tx" ? "#ffffff" : COLORS.sel;
      ctx.strokeStyle = h.k === "tx" ? COLORS.sel : "#ffffff";
      ctx.lineWidth = 1.2 / this.zoom;
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
    const s = 9 / this.zoom;
    const [x, y] = sn.p;
    ctx.strokeStyle = "#e07b00";
    ctx.lineWidth = 2 / this.zoom;
    ctx.beginPath();
    if (sn.kind === "m") {
      ctx.moveTo(x, y - s * 0.7);
      ctx.lineTo(x + s * 0.65, y + s * 0.45);
      ctx.lineTo(x - s * 0.65, y + s * 0.45);
      ctx.closePath();
    } else if (sn.kind === "c") {
      ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
    } else if (sn.kind === "n") {
      ctx.moveTo(x - s / 2, y - s / 2);
      ctx.lineTo(x + s / 2, y + s / 2);
      ctx.moveTo(x + s / 2, y - s / 2);
      ctx.lineTo(x - s / 2, y + s / 2);
    } else if (sn.kind === "q") {
      ctx.moveTo(x, y - s * 0.6);
      ctx.lineTo(x + s * 0.6, y);
      ctx.lineTo(x, y + s * 0.6);
      ctx.lineTo(x - s * 0.6, y);
      ctx.closePath();
    } else {
      ctx.rect(x - s / 2, y - s / 2, s, s);
    }
    ctx.stroke();
  }
}
