// The application: state, tools, events, saving, export.
import * as api from "./api.js";
import { build, derive, hit, holeTable, setHandle, moveAnnot, annotSnapPoints, exportPrims, K, fmtNum, newId, scaleAnchor, typeName, SCALE_MIN, SCALE_MAX } from "./annots.js";
import { View, COLORS } from "./view.js";
import { Snapper, MODES, DEFAULT_MODES, parseOverride, overrideModes, LABELS } from "./osnap.js";
import { Panel } from "./panel.js";
import { TOOL_BY_ID, FAMILIES, FAMILY_OF, finalize, promptFor, resolveOption } from "./tools.js";
import { clickSelection, windowSelection, pointInPolygon, boxInPolygon } from "./selection.js";
import { parsePoint, parsePointMod, resolvePoint, toUser, defaultOrigin, orthoActive, routeKey } from "./pointin.js";
import * as dlg from "./dialogs.js";
import { VIEW_LETTERS } from "./symbols.js";
import { markingConfig, MM_ICONS } from "./mmenu.js";
import { keyConfig, directKeyMap, resolveCommand, suggest, commandList, labelOf, ACTIONS } from "./commands.js";
import { applyPageOp, rotateAbout, scaleAbout, mirrorAbout } from "./pages.js";
import { hasVertices, addVertex, removeVertex } from "./shapes.js";
import { startI18n, lang as uiLang, tr } from "./i18n.js";

const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const $ = (id) => document.getElementById(id);
/** Short hash (FNV-1a) for render keys. */
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const DATUM_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ"; // ISO 5459: no I, O, Q
// grips are shown on at most this many selected annotations (AutoCAD: GRIPOBJLIMIT, 100)
export const GRIP_LIMIT = 100;
const gripKey = (id, k) => `${id}:${k}`;

class App {
  constructor() {
    this.doc = null;
    this.page = 0;
    this.annots = [];
    this.settings = dlg.storedDefaults();
    this.selectedId = null;
    this.sel = new Set();
    this.tool = "select";
    this.clicks = [];
    this.undo = [];
    this.redo = [];
    this.cache = new Map();
    this.snapper = new Snapper();
    this.noSnapper = new Snapper();
    this.snapCfg = { modes: [...DEFAULT_MODES], polar: true, polarInc: 15, tracking: true, ortho: false, on: true };
    try {
      const saved = JSON.parse(localStorage.getItem("cotare.snap") || "{}");
      Object.assign(this.snapCfg, saved);
      // Node (annotation points) became a switchable mode in v1.1; they always snapped before
      if (Array.isArray(saved.modes) && !(saved.v >= 2) && !saved.modes.includes("node")) this.snapCfg.modes.push("node");
      this.snapCfg.v = 2;
    } catch (_) { /* default */ }
    this.acq = [];
    this.parDir = null;
    this.parSeg = null;
    this.touches = new Map();
    this.mmenu = null;
    this.measureCtx = document.createElement("canvas").getContext("2d");
    this.measureCtx.fontKerning = "none";
    this.mcache = new Map();
    this.measure = (txt, size) => {
      const key = `${size.toFixed(3)}|${txt}`;
      let w = this.mcache.get(key);
      if (w == null) {
        this.measureCtx.font = `${size}px osifont`;
        w = this.measureCtx.measureText(txt).width;
        if (this.mcache.size > 20000) this.mcache.clear(); // texts typed letter by letter pile up
        this.mcache.set(key, w);
      }
      return w;
    };
    this.view = new View($("canvas"), this);
    this.panel = new Panel($("panel"), this);
    this.cursor = null;
    this.drag = null;
    this.space = false;
    this.drawStyle = { ltype: "cont", w: 0.5, lscale: 1 };
    this.hidden = new Set();
    try {
      for (const k of JSON.parse(localStorage.getItem("cotare.hidden") || "[]")) this.hidden.add(k);
    } catch (_) { /* default */ }
    try {
      Object.assign(this.drawStyle, JSON.parse(localStorage.getItem("cotare.drawStyle") || "{}"));
    } catch (_) { /* default */ }
  }

  setDrawStyle(patch) {
    Object.assign(this.drawStyle, patch);
    try {
      localStorage.setItem("cotare.drawStyle", JSON.stringify(this.drawStyle));
    } catch (_) { /* not remembered */ }
  }

  /**
   * Esc, Enter with a command in progress or right click: finishes the polyline, stops the line chain,
   * drops the picked points; with no command in progress it deselects, then returns to Select.
   */
  escape(confirm = false) {
    const t = TOOL_BY_ID[this.tool];
    if (this.hideFlyout) this.hideFlyout();
    if (this.gripMenu && this.gripMenu.shown) {
      this.hideGripMenu();
      return;
    }
    if (this.hotGrip) {
      // Enter / right click goes to the next mode, as Space; Esc ends
      if (confirm) this.cycleHotGrip();
      else this.endHotGrip();
      return;
    }
    if (this.selPrompt) {
      if (this.selPrompt.fence && !confirm) {
        this.selPrompt.fence = null;
        this.view.overlay = null;
        this.view.redraw();
        this.updateCmdPrompt();
        return;
      }
      // right click / Enter runs the command on the selection, Esc drops it
      if (confirm) this.finishSelPrompt();
      else {
        this.selPrompt = null;
        this.select(null);
        this.updateCmdPrompt();
      }
      return;
    }
    if (confirm && this.pointMod && this.pointMod.kind === "tk" && this.pointMod.pts.length) {
      this.finishTracking();
      return;
    }
    if (this.snapOverride || this.pointMod) {
      this.snapOverride = null;
      this.pointMod = null;
      this.updateCmdPrompt();
      return;
    }
    if (this.cmdAsk) {
      // a value asked for by an option: dropped, the command goes on
      this.cmdAsk = null;
      this.updateCmdPrompt();
      return;
    }
    if (this.rectStart) {
      // a typed first corner of a drag tool: dropped
      this.rectStart = null;
      this.view.overlay = null;
      this.setHint(t.hint);
      this.view.redraw();
      return;
    }
    if (this.placing && confirm) {
      // Enter / Space / right click while placing the ordinate row: place it at the cursor
      const at = this._ordPt || this.clicks[this.clicks.length - 1];
      this.toolClick(at);
      return;
    }
    if (this.dyn) this.dynReset();
    const db = $("dynBox");
    if (db) db.hidden = true;
    if (this.placing) {
      // Esc while placing the ordinate row: drop the whole command
      this.placing = false;
      this.clicks = [];
      this.view.overlay = null;
      this.setHint(t.hint);
      this.clearAcq();
      this.view.redraw();
      return;
    }
    if (this.clicks.length && t.kind === "poly") {
      this.finishPoly(false);
      return;
    }
    if (this.acq.length || this.parDir) this.clearAcq();
    this.chain = null;
    if (this.tool === "measure") this.cmdState = {}; // DIST Multiple ends with the chain
    if (this.clicks.length) {
      this.clicks = [];
      this.view.overlay = null;
      this.setHint(t.hint);
      this.view.redraw();
    } else if (this.selectedId) this.select(null);
    else if (this.tool !== "select") this.setTool("select");
  }

  // ------------------------------------------------------------ radial menu (as in Inventor)
  /** Radial menu commands, in the order E, NE, N, NW, W, SW, S, SE (chosen in Settings). */
  markingItems() {
    return markingConfig().map((id) => this.markingAction(id)).map((it) => it || this.markingAction("dimLin"));
  }

  markingAction(id) {
    const tool = (tid) => TOOL_BY_ID[tid] && { id: tid, label: TOOL_BY_ID[tid].label, icon: TOOL_BY_ID[tid].icon, run: () => this.setTool(tid) };
    const del = { id: "del", label: "Șterge selecția", icon: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13", run: () => this.deleteSelected() };
    switch (id) {
      case "last": {
        const last = this.lastTool && TOOL_BY_ID[this.lastTool];
        return last ? tool(last.id) : tool("dimLin");
      }
      case "undo":
        return { id, label: "Anulează acțiunea", icon: MM_ICONS.undo, run: () => this.doUndo() };
      case "redo":
        return { id, label: "Refă", icon: MM_ICONS.redo, run: () => this.doRedo() };
      case "del":
        return del;
      case "seldel":
        return this.sel.size ? del : tool("line");
      case "dup":
        return { id, label: "Duplică", icon: MM_ICONS.dup, run: () => this.copySelected(true) && this.paste(true) };
      case "fit":
        return { id, label: "Potrivește", icon: MM_ICONS.fit, run: () => this.view.fit() };
      case "export":
        return { id, label: "Exportă PDF", icon: MM_ICONS.export, run: () => this.doc && dlg.exportDialog(this) };
      default:
        return tool(id);
    }
  }

  openMarkingMenu(sx, sy) {
    this.closeMarkingMenu();
    const vp = $("viewport");
    const items = this.markingItems();
    const el = document.createElement("div");
    el.className = "mmenu";
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    const rx = 118;
    const ry = 78;
    el.innerHTML = `<div class="mm-center"></div>${items.map((it, i) => {
      const a = (i * Math.PI) / 4;
      const x = Math.cos(a) * rx;
      const y = -Math.sin(a) * ry;
      const side = Math.abs(Math.cos(a)) < 0.2 ? "c" : Math.cos(a) > 0 ? "r" : "l";
      return `<button class="mm-item mm-${side}" data-i="${i}" style="left:${x}px;top:${y}px" title="${it.label}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${it.icon}"/></svg><span>${it.label}</span></button>`;
    }).join("")}`;
    vp.appendChild(el);
    // keep the menu on screen
    const r = el.getBoundingClientRect();
    const vr = vp.getBoundingClientRect();
    const pad = 150;
    el.style.left = `${Math.min(Math.max(sx, pad), vr.width - pad)}px`;
    el.style.top = `${Math.min(Math.max(sy, 110), vr.height - 110)}px`;
    void r;
    el.querySelectorAll(".mm-item").forEach((b) => b.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      this.runMarking(Number(b.dataset.i));
    }));
    this.mmenu = { el, items, cx: parseFloat(el.style.left), cy: parseFloat(el.style.top), hi: -1 };
  }

  /** With the button still pressed, the direction from the center picks the command (marking menu). */
  hoverMarking(sx, sy) {
    const m = this.mmenu;
    if (!m) return;
    const dx = sx - m.cx;
    const dy = sy - m.cy;
    let hi = -1;
    if (Math.hypot(dx, dy) > 28) {
      const a = Math.atan2(-dy, dx);
      hi = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    }
    if (hi !== m.hi) {
      m.hi = hi;
      m.el.querySelectorAll(".mm-item").forEach((b) => b.classList.toggle("hi", Number(b.dataset.i) === hi));
    }
  }

  runMarking(i) {
    const m = this.mmenu;
    if (!m || !m.items[i]) return;
    const it = m.items[i];
    this.closeMarkingMenu();
    it.run();
  }

  closeMarkingMenu() {
    if (this.mmenu) {
      this.mmenu.el.remove();
      this.mmenuClosedAt = performance.now();
    }
    this.mmenu = null;
  }

  pinchState() {
    const [a, b] = [...this.touches.values()];
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, d0: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  }

  /** One click of the active tool (dimension points, polyline vertices…). */
  toolClick(pt) {
    const t = TOOL_BY_ID[this.tool];
    if (this.pointMod && this.consumePointMod(pt)) return;
    this.lastPick = pt; // AutoCAD's LASTPOINT: what @ refers to
    this.snapOverride = null; // a typed override (END, MID…) is for one pick
    this.snapPick = null;
    if (this.dyn) this.dynReset();
    if (t.kind === "poly" && this.placing) {
      // ordinates: the last click places the row (and decides the axis)
      const pts = this.clicks;
      this.placing = false;
      this.clicks = [];
      this.view.overlay = null;
      this.setHint(t.hint);
      this.clearAcq();
      this.addMade(t.make(pts, this, false, pt));
      return;
    }
    if (t.kind === "poly") {
      const v = this.view;
      const near = (q) => {
        const [ax, ay] = v.toScreen(q);
        const [bx, by] = v.toScreen(pt);
        return Math.hypot(ax - bx, ay - by);
      };
      const n = this.clicks.length;
      // click on the first point: closed outline · second click at the same spot (double click): done
      if (n >= Math.max(3, t.min || 2) && near(this.clicks[0]) < 8) return this.finishPoly(true);
      if (n && near(this.clicks[n - 1]) < 3) return this.finishPoly(false);
      this.clicks.push(pt);
      this.updateOverlay(pt, null);
      return;
    }
    if (t.kind === "clicks") {
      this.clicks.push(pt);
      if (this.clicks.length >= t.n) {
        const pts = this.clicks;
        this.clicks = [];
        this.view.overlay = null;
        if (t.id === "measure") {
          if (this.cmdState.multi) {
            this.measureChain(pts[0], pts[1]);
            return;
          }
          this.showMeasure(pts[0], pts[1]);
          return;
        }
        if (t.id === "calib") {
          const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / K;
          if (d > 0.1) dlg.calibDialog(this, d);
          return;
        }
        const made = t.make(pts, this);
        if (!made) return; // nothing to make (the tool says why)
        this.addMade(made);
        if (!t.chain) this.clearAcq();
        if (t.chain) {
          // like LINE in CAD: the next segment starts at the end of the one just drawn
          if (!this.chain) this.chain = { first: pts[0], ids: [] };
          this.chain.ids.push(this.annots[this.annots.length - 1].id);
          this.clicks = [pts[pts.length - 1]];
          this.updateOverlay(pt, null);
        }
      } else {
        this.updateOverlay(pt, null);
      }
    }
  }

  /** A rectangle of a drag tool (strike, cover, remove, blacken), dragged or typed. */
  commitRect(r) {
    this.snapOverride = null;
    if (Math.abs(r[2] - r[0]) < 2 || Math.abs(r[3] - r[1]) < 2) return;
    this.lastPick = [r[2], r[3]];
    const t = TOOL_BY_ID[this.tool];
    const a = t.make(r, this);
    if (a.type === "redact") {
      a.page = this.page;
      dlg.redactDialog(this, a, true);
    } else if (a.type === "ink") {
      a.page = this.page;
      dlg.inkDialog(this, a, true);
    } else this.addAnnot(finalize(a));
  }

  // ------------------------------------------------------------ typed points (CMD-D1…D4)
  /** A command that asks for points is running (any drawing or annotation tool). */
  cmdActive() {
    return !!(this.doc && (this.hotGrip || (this.tool !== "select" && this.tool !== "pan")));
  }

  /** Origin of typed coordinates on a page: its UCS annotation, or the bottom-left corner. */
  originOf(page = this.page) {
    const u = this.annots.find((a) => a.type === "ucs" && a.page === page && Array.isArray(a.p));
    if (u) return u.p;
    const pg = this.doc && this.doc.pages[page];
    return defaultOrigin(pg ? pg.h : 0);
  }

  /** Where the rubber band, polar and ortho start: the last tracking point during TK, else the last click. */
  pickAnchor() {
    if (this.hotGrip) return this.hotGrip.base;
    const m = this.pointMod;
    if (m && m.kind === "tk" && m.pts.length) return m.pts[m.pts.length - 1];
    return this.clicks[this.clicks.length - 1];
  }

  /** The point @ and a lone distance are measured from. */
  lastPoint() {
    if (this.hotGrip) return this.hotGrip.base;
    if (this.pointMod && this.pointMod.kind === "from" && this.pointMod.base) return this.pointMod.base;
    if (this.pointMod && this.pointMod.kind === "tk" && this.pointMod.pts.length) return this.pickAnchor();
    if (this.rectStart) return this.rectStart;
    if (this.clicks.length) return this.clicks[this.clicks.length - 1];
    return this.lastPick || null;
  }

  /**
   * FROM, M2P and option S of DCO / DBA take the next picks before the tool does.
   * Returns true when the pick was used here.
   */
  /** TK: the end of tracking (Enter); the last tracking point goes to the command. */
  finishTracking() {
    const m = this.pointMod;
    this.pointMod = null;
    this.updateCmdPrompt();
    if (m && m.pts.length) this.toolClick(m.pts[m.pts.length - 1]);
  }

  /** TK: the tracking path drawn so far stays on screen. */
  updateTkOverlay() {
    const m = this.pointMod;
    if (!m || m.kind !== "tk") return;
    this.view.redraw(); // view.js draws the path from pointMod.pts
  }

  consumePointMod(pt) {
    const m = this.pointMod;
    if (m.kind === "from") {
      if (!m.base) {
        m.base = pt;
        this.lastPick = pt;
        this.snapOverride = null;
        this.updateCmdPrompt();
        return true;
      }
      this.pointMod = null; // the offset point (typed @ from the base, or picked) goes to the tool
      return false;
    }
    if (m.kind === "tk") {
      // TK (tracking): each point is taken horizontally or vertically from the previous one;
      // Enter ends and the last one goes to the command
      if (m.pts.length) {
        const q = m.pts[m.pts.length - 1];
        pt = Math.abs(pt[0] - q[0]) >= Math.abs(pt[1] - q[1]) ? [pt[0], q[1]] : [q[0], pt[1]];
      }
      m.pts.push(pt);
      this.lastPick = pt;
      this.snapOverride = null;
      this.updateCmdPrompt();
      this.updateTkOverlay();
      return true;
    }
    if (m.kind === "m2p") {
      if (!m.a) {
        m.a = pt;
        this.snapOverride = null;
        this.updateCmdPrompt();
        return true;
      }
      this.pointMod = null;
      this.toolClick([(m.a[0] + pt[0]) / 2, (m.a[1] + pt[1]) / 2]);
      return true;
    }
    if (m.kind === "fx" || m.kind === "fy") {
      // .X / .Y: the first pick gives one coordinate, the next one the other
      if (!m.first) {
        m.first = pt;
        this.snapOverride = null;
        this.updateCmdPrompt();
        return true;
      }
      this.pointMod = null;
      this.toolClick(m.kind === "fx" ? [m.first[0], pt[1]] : [pt[0], m.first[1]]);
      return true;
    }
    if (m.kind === "pickDim") {
      this.pointMod = null;
      const tol = 6 / this.view.zoom;
      const hitDim = [...this.visibleBuilt()].reverse().find(({ a, built }) => a.type === "dim" && a.kind === "lin" && hit(built, a, pt, tol));
      if (!hitDim) {
        dlg.toast("Acolo nu e o cotă liniară");
        this.updateCmdPrompt();
        return true;
      }
      const d = hitDim.a;
      const orient = d.orient === "v" ? "v" : "h";
      this.cmdState.orient = orient;
      if (this.tool === "dimCont") {
        // as DIMCONTINUE: from the second extension line, on the same dimension line
        this.clicks = [[...d.p2]];
        this.cmdState.seriesAt = [...d.p3];
      } else {
        // as DIMBASELINE: from the first extension line, one step further out
        const S = this.S();
        const step = Math.max(7 * K, S.h * 2.4);
        const ax = orient === "h" ? 1 : 0;
        const dir = Math.sign(d.p3[ax] - (d.p1[ax] + d.p2[ax]) / 2) || 1;
        const at = [...d.p3];
        at[ax] += dir * step;
        this.clicks = [[...d.p1]];
        this.cmdState.seriesAt = at;
      }
      this.lastPick = this.clicks[0];
      this.updateCmdPrompt();
      if (this._dynPt) this.updateOverlay(this._dynPt, null);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ grip menu (CMD-D14)
  /** Resting on a grip for a moment opens its menu (AutoCAD's multifunctional grips). */
  gripMenuHover(hv, sx, sy) {
    const m = this.gripMenu;
    const on = hv && hv.kind === "handle" && hv.h.k !== "sc" && hv.h.k !== "tx" && !this.hotGrip && !this.drag;
    if (m && m.shown) {
      // it stays while the cursor is near its grip (on the way to the menu)
      if (Math.hypot(sx - m.sx, sy - m.sy) > 40) this.hideGripMenu();
      return;
    }
    const key = on ? `${hv.a.id}:${hv.h.k}` : "";
    if (m && m.key === key) return;
    this.hideGripMenu();
    if (!on) return;
    const [gx, gy] = this.view.toScreen(hv.h.p);
    const g = { key, id: hv.a.id, k: hv.h.k, p: [...hv.h.p], sx: gx, sy: gy, shown: false };
    g.timer = setTimeout(() => this.showGripMenu(g), 600);
    this.gripMenu = g;
  }

  hideGripMenu() {
    const m = this.gripMenu;
    if (!m) return;
    clearTimeout(m.timer);
    this.gripMenu = null;
    const el = $("gripMenu");
    if (el) el.hidden = true;
  }

  /** The items of a grip's menu: the hot-grip modes, and vertices for polylines and hatches. */
  gripMenuItems(a, k) {
    const items = [
      { id: "stretch", label: "Întindere" },
      { id: "move", label: "Mutare" },
      { id: "rotate", label: "Rotire" },
      { id: "scale", label: "Scalare" },
      { id: "mirror", label: "Oglindire" },
    ];
    if (hasVertices(a) && k.startsWith("pts.")) {
      items.push({ id: "addVertex", label: "Adaugă vârf", sep: true });
      const tmp = { ...a, pts: [...a.pts] };
      if (removeVertex(tmp, Number(k.slice(4)))) items.push({ id: "removeVertex", label: "Șterge vârful" });
    }
    return items;
  }

  showGripMenu(g) {
    const a = this.annots.find((x) => x.id === g.id);
    if (!a || this.gripMenu !== g) return;
    let el = $("gripMenu");
    if (!el) {
      el = document.createElement("div");
      el.id = "gripMenu";
      el.className = "gripmenu";
      el.setAttribute("translate", "no");
      $("viewport").appendChild(el);
      el.addEventListener("pointerleave", (e) => {
        if (!(e.relatedTarget && e.relatedTarget === this.view.canvas)) this.hideGripMenu();
      });
      el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-gm]");
        if (b) this.runGripMenu(b.dataset.gm);
      });
    }
    el.innerHTML = this.gripMenuItems(a, g.k).map((it) => `<button type="button" data-gm="${it.id}"${it.sep ? ' class="sep"' : ""}>${esc(tr(it.label))}</button>`).join("");
    const vp = $("viewport");
    el.hidden = false;
    const w = el.offsetWidth || 140;
    const h = el.offsetHeight || 160;
    el.style.left = `${Math.max(4, Math.min(g.sx + 12, vp.clientWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(g.sy + 12, vp.clientHeight - h - 4))}px`;
    g.shown = true;
    this.view.redraw(); // the hover label would sit under the menu
  }

  runGripMenu(id) {
    const g = this.gripMenu;
    this.hideGripMenu();
    if (!g) return;
    const a = this.annots.find((x) => x.id === g.id);
    if (!a) return;
    if (id === "addVertex" || id === "removeVertex") {
      const i = Number(g.k.slice(4));
      this.pushHistory();
      if (id === "removeVertex") {
        removeVertex(a, i);
        this.frame++;
        this.changed();
        return;
      }
      // as in AutoCAD: the new vertex follows the cursor until it is placed
      const j = addVertex(a, i);
      this.frame++;
      this.changed();
      if (j >= 0) this.startHotGrip({ id: a.id, k: `pts.${j}`, p: [...a.pts[j]] });
      return;
    }
    this.startHotGrip({ id: g.id, k: g.k, p: g.p });
    const hg = this.hotGrip;
    if (hg && id !== "stretch") {
      hg.mode = id;
      if (id === "scale") hg.ref = 10 * K;
      this.logCmd(`  ** ${this.hotGripName()} **`);
      this.updateCmdPrompt();
    }
  }

  // ------------------------------------------------------------ hot grips (CMD-D14)
  /** A click on a grip (without dragging): the grip becomes hot, as in AutoCAD. */
  startHotGrip(d) {
    const a = this.annots.find((x) => x.id === d.id);
    if (!a) return;
    // Shift+click made other grips hot first: Stretch moves all of them with the clicked one
    const picked = this.hotSet && this.hotSet.has(gripKey(d.id, d.k)) ? [...this.hotSet.values()] : [];
    const grips = [{ id: d.id, k: d.k, p: [...d.p] }, ...picked.filter((x) => !(x.id === d.id && x.k === d.k))].filter((x) => this.annots.some((b) => b.id === x.id));
    this.hotSet = null;
    this.hotGrip = { id: d.id, k: d.k, grips, base: [...d.p], ids: [...this.sel], mode: "stretch", copy: false, pickBase: false, ref: 10 * K };
    this.logCmd(grips.length > 1 ? `** GRIP ** (${grips.length})` : "** GRIP **");
    this.updateCmdPrompt();
    this.view.redraw();
  }

  endHotGrip() {
    this.hotGrip = null;
    this.hotSet = null;
    if (this.dyn) this.dynReset();
    this.view.overlay = null;
    this.dragTip = null;
    this.updateCmdPrompt();
    this.renderDyn(null, null);
    this.view.redraw();
  }

  /** Space / Enter: the next grip mode. */
  cycleHotGrip() {
    const g = this.hotGrip;
    const order = ["stretch", "move", "rotate", "scale", "mirror"];
    g.mode = order[(order.indexOf(g.mode) + 1) % order.length];
    if (this.dyn) this.dynReset();
    if (g.mode === "scale") {
      // the cursor's distance from the base when SCALE starts is factor 1
      const c = this.lastPt || g.base;
      g.ref = Math.max(10 * K, Math.hypot(c[0] - g.base[0], c[1] - g.base[1]));
    }
    this.logCmd(`  ** ${this.hotGripName()} **`);
    this.updateCmdPrompt();
    if (this._dynPt) this.previewHotGrip(this._dynPt, null);
  }

  hotGripName() {
    return { stretch: "ÎNTINDE", move: "MUTĂ", rotate: "ROTEȘTE", scale: "SCALEAZĂ", mirror: "OGLINDEȘTE" }[this.hotGrip.mode];
  }

  hotGripPrompt() {
    const g = this.hotGrip;
    const what = g.pickBase ? "punctul de bază" : { stretch: "punctul nou", move: "unde se mută", rotate: "unghiul (sfert de tură) sau scrie gradele", scale: "factorul (cursorul sau scrie-l)", mirror: "a doua axă a oglinzii (orizontală sau verticală)" }[g.mode];
    const opts = g.mode === "stretch" ? [] : [
      { key: "B", label: "Punct de bază", en: ["BASE"], run: (app) => { app.hotGrip.pickBase = true; } },
      { key: "C", label: g.copy ? "Copiere (pornită)" : "Copiere", en: ["COPY"], run: (app) => { app.hotGrip.copy = !app.hotGrip.copy; } },
    ];
    opts.push({ key: "X", label: "Ieși", en: ["EXIT"], run: (app) => app.endHotGrip() });
    return { text: `** ${this.hotGripName()} ** ${what} · Space = modul următor`, opts };
  }

  /** The annotations as the grip mode would leave them, for the point pt (or a typed value). */
  hotGripResult(pt, value = null) {
    const g = this.hotGrip;
    const ids = g.mode === "stretch" ? [...new Set(g.grips.map((x) => x.id))] : g.ids;
    const src = ids.map((id) => this.annots.find((a) => a.id === id)).filter(Boolean);
    const out = src.map((a) => JSON.parse(JSON.stringify(a)));
    const b = g.base;
    let info = "";
    if (g.mode === "stretch") {
      // every hot grip moves by the same displacement as the picked one
      const dx = pt[0] - b[0];
      const dy = pt[1] - b[1];
      const S = this.S();
      for (const x of g.grips) {
        const c = out[ids.indexOf(x.id)];
        if (c) setHandle(c, x.k, [x.p[0] + dx, x.p[1] + dy], build(c, S, this.measure));
      }
    } else if (g.mode === "move") {
      for (const c of out) moveAnnot(c, pt[0] - b[0], pt[1] - b[1]);
    } else if (g.mode === "rotate") {
      const ang = value != null ? value : (Math.atan2(-(pt[1] - b[1]), pt[0] - b[0]) * 180) / Math.PI;
      const q = ((Math.round(ang / 90) % 4) + 4) % 4; // quarter turns, counter-clockwise
      const cw = (360 - q * 90) % 360;
      for (const c of out) rotateAbout(c, cw, b, this.S(), this.measure);
      info = `${q * 90}°`;
    } else if (g.mode === "scale") {
      const k = value != null ? value : Math.hypot(pt[0] - b[0], pt[1] - b[1]) / g.ref;
      const kk = Math.max(0.05, Math.min(20, Math.round(k * 100) / 100));
      for (const c of out) scaleAbout(c, kk, b);
      info = `× ${fmtNum(kk, ",", 2)}`;
    } else if (g.mode === "mirror") {
      const axis = Math.abs(pt[0] - b[0]) >= Math.abs(pt[1] - b[1]) ? "h" : "v";
      for (const c of out) mirrorAbout(c, axis, b);
      info = axis === "h" ? "axă orizontală" : "axă verticală";
    }
    return { out, info };
  }

  previewHotGrip(pt, sn) {
    const g = this.hotGrip;
    if (g.pickBase) {
      this.view.overlay = { snap: sn };
      this.view.redraw();
      return;
    }
    const { out, info } = this.hotGripResult(pt);
    const S = this.S();
    const prims = out.flatMap((c) => build({ ...c, layer: "add" }, S, this.measure).prims);
    prims.push({ t: "L", p: [...g.base, ...pt], w: 0.6, c: "preview", dash: true });
    this.view.overlay = { prims, snap: sn };
    this.dragTip = sn ? null : { p: pt, txt: `${this.hotGripName()}${info ? ` · ${info}` : ""}${g.copy ? " · copie" : ""}` };
    this.view.redraw();
  }

  /** A click (or a typed point / value) with a hot grip. */
  applyHotGrip(pt, value = null) {
    const g = this.hotGrip;
    if (g.pickBase && pt) {
      g.base = pt;
      g.pickBase = false;
      this.updateCmdPrompt();
      return;
    }
    if (!pt && value == null) return;
    const { out } = this.hotGripResult(pt || g.base, value);
    if (!out.length) {
      this.endHotGrip();
      return;
    }
    this.pushHistory();
    if (g.copy && g.mode !== "stretch") {
      for (const c of out) c.id = newId();
      this.annots.push(...out);
    } else {
      const byId = new Map(out.map((c) => [c.id, c]));
      this.annots = this.annots.map((a) => byId.get(a.id) || a);
    }
    this.frame++;
    this.changed();
    // with Copy the grip stays hot for more copies; otherwise it is done
    if (!(g.copy && g.mode !== "stretch")) this.endHotGrip();
    else if (this._dynPt) this.previewHotGrip(this._dynPt, null);
  }

  /** DCO / DBA, option S: the next click picks the linear dimension to continue. */
  pickSeriesDim() {
    this.pointMod = { kind: "pickDim" };
  }

  /** A point typed in the command line: false if it is not a point (then it may be a command). */
  typedPoint(text) {
    const g = this.hotGrip;
    if (g && (g.mode === "rotate" || g.mode === "scale") && /^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(String(text).trim())) {
      // ROTATE: the angle (degrees, counter-clockwise); SCALE: the factor
      const v = parseFloat(String(text).trim().replace(",", "."));
      this.logCmd(`  ${String(text).trim()}`);
      if (g.mode === "rotate" && Math.abs(v / 90 - Math.round(v / 90)) > 1e-9) {
        // the annotations turn only in quarter turns (texts and symbols stay readable)
        this.logCmd("  Doar multipli de 90°");
        return true;
      }
      if (g.mode === "scale" && !(v > 0)) {
        this.logCmd("  Factorul trebuie să fie pozitiv");
        return true;
      }
      this.applyHotGrip(null, v);
      return true;
    }
    const q = parsePoint(text);
    if (!q) return false;
    const r = resolvePoint(q, { last: this.lastPoint(), cursor: this._dynPt || null, origin: this.originOf(), scale: this.settings.scale });
    this.logCmd(`  ${String(text).trim()}${r.error ? ` — ${r.error}` : ""}`);
    if (r.error) {
      dlg.toast(r.error);
      return true;
    }
    this.pointInput(r.p);
    return true;
  }

  /** A typed point, used as a click of the running tool. */
  pointInput(p) {
    if (this.hotGrip) {
      this.applyHotGrip(p);
      return;
    }
    const t = TOOL_BY_ID[this.tool];
    if (!t || !this.cmdActive()) return;
    if (this.dyn) this.dynReset();
    if (t.kind === "rect") {
      if (!this.rectStart) {
        this.rectStart = p;
        this.lastPick = p;
        this.snapOverride = null;
        this.view.overlay = { prims: [{ t: "C", p: [...p], r: 1.2, w: 0.6, c: "sel" }] };
        this.view.redraw();
        this.setHint(`${t.hint} · colțul opus: @lățime,înălțime sau click`);
        return;
      }
      const r = [...this.rectStart, ...p];
      this.rectStart = null;
      this.view.overlay = null;
      this.setHint(t.hint);
      this.commitRect(r);
      return;
    }
    this.toolClick(p);
    this.updateCmdPrompt();
  }

  /** The prompt of the running command, with its options as buttons (CMD-D5). */
  updateCmdPrompt() {
    const inp = $("cmdIn");
    const box = $("cmdPrompt");
    if (!inp || !this.keyCfg) return;
    if (this.cmdAsk) {
      inp.placeholder = "valoare, apoi Enter (Esc renunță)";
      if (box) {
        box.innerHTML = `<b>${esc(this.cmdAsk.text)}:</b>`;
        box.hidden = false;
      }
      return;
    }
    if (this.selPrompt) {
      inp.placeholder = "W · C · F · WP · CP · ALL · L · P · R · A";
      if (box) {
        const sp = this.selPrompt;
        const n = this.sel.size;
        const what = { erase: "Șterge adnotările", moveSel: "Mută obiectele", copySel: "Copiază obiectele" }[sp.cmd] || "";
        const then = sp.fence ? "Enter închide linia" : sp.cmd === "erase" ? "Enter șterge" : "Enter continuă";
        const state = sp.fence ? (sp.fenceMode === "f" ? "linie de selecție: click-uri" : "poligon: click-uri") : sp.force === "w" ? "fereastră" : sp.force === "c" ? "traversare" : sp.remove ? "scoate din selecție" : "";
        const opts = [["W", "Fereastră"], ["C", "Traversare"], ["F", "Linie"], ["WP", "Poligon"], ["CP", "Poligon traversare"], ["ALL", "Tot"], ["L", "Ultimul"], ["P", "Anterior"], sp.remove ? ["A", "Adaugă"] : ["R", "Scoate"]]
          .map(([k, l]) => `<button type="button" data-selopt="${k}" title="${esc(l)} (${k})">${esc(l)} <i>${k}</i></button>`).join("");
        box.innerHTML = `<b>${what} — selectează obiectele (${n} ${n === 1 ? "selectat" : "selectate"})${state ? ` · ${state}` : ""} · ${then}, Esc renunță</b> <span class="cmdopts">${opts}</span>`;
        box.hidden = false;
        box.querySelectorAll("[data-selopt]").forEach((b) => b.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.selPromptOption(b.dataset.selopt);
        }));
      }
      return;
    }
    if (!this.cmdActive()) {
      inp.placeholder = this.keyCfg.mode === "autocad" ? "Comandă (L, C, PL, DLI…)" : "Enter → comandă (L, C, DLI…)";
      if (box) box.hidden = true;
      return;
    }
    inp.placeholder = "x,y · @dx,dy · @d<unghi · opțiune";
    const pr = this.currentPrompt();
    if (!box) return;
    const opts = pr.opts.map((o) => `<button type="button" data-opt="${o.key}" title="${esc(o.label)} (${o.key})">${esc(o.label)} <i>${o.key}</i></button>`).join("");
    box.innerHTML = `<b>${esc(pr.text)}</b>${opts ? ` <span class="cmdopts">${opts}</span>` : ""}`;
    box.hidden = false;
    box.querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.runOption(b.dataset.opt);
    }));
  }

  /** Prompt text and options of the running command (command line and cursor). */
  currentPrompt() {
    if (this.hotGrip) return this.hotGripPrompt();
    const pr = promptFor(TOOL_BY_ID[this.tool], this);
    const pm = this.pointMod;
    if (pm && pm.kind === "from") pr.text = pm.base ? "FROM — deplasarea față de bază (@dx,dy sau @d<unghi)" : "FROM — punctul de bază";
    if (pm && pm.kind === "m2p") pr.text = pm.a ? "M2P — al doilea punct" : "M2P — primul punct";
    if (pm && pm.kind === "pickDim") pr.text = "Alege cota liniară de la care continui";
    if (pm && pm.kind === "fx") pr.text = pm.first ? ".X — punctul care dă Y" : ".X — punctul care dă X";
    if (pm && pm.kind === "fy") pr.text = pm.first ? ".Y — punctul care dă X" : ".Y — punctul care dă Y";
    if (pm && pm.kind === "tk") pr.text = pm.pts.length ? "TK — punctul următor (orizontal sau vertical; Enter încheie urmărirea)" : "TK — primul punct de urmărire";
    if (pm) pr.opts = [];
    if (this.snapOverride) pr.text += this.snapOverride === "none" ? " · fără snap" : ` · snap: ${LABELS[this.snapOverride === "node" ? "a" : this.snapOverride]}`;
    return pr;
  }

  /** The options of the running command, available now. */
  currentOptions() {
    return this.cmdActive() && !this.cmdAsk ? this.currentPrompt().opts : [];
  }

  /** Runs an option of the running command (typed or clicked). */
  runOption(keyOrText) {
    const o = resolveOption(this.currentOptions(), keyOrText);
    if (!o) return false;
    this.logCmd(`  [${o.key}] ${o.label}`);
    o.run(this);
    this.frame++;
    if (this._dynPt) this.updateOverlay(this._dynPt, null);
    this.updateCmdPrompt();
    this.renderDyn(this._dynPt, this.clicks[this.clicks.length - 1]);
    return true;
  }

  /** An option that needs a value: the next Enter in the command line answers it. */
  askValue(text, onValue) {
    this.cmdAsk = { text, onValue };
    this.updateCmdPrompt();
    this.focusCmdLine("");
    return true;
  }

  /** U while drawing: the last point (or the last segment of a line chain) goes away. */
  undoStep() {
    const t = TOOL_BY_ID[this.tool];
    if (t && t.chain && this.chain && this.chain.ids.length) {
      const id = this.chain.ids.pop();
      const a = this.annots.find((x) => x.id === id);
      this.pushHistory();
      this.annots = this.annots.filter((x) => x.id !== id);
      this.sel.delete(id);
      if (this.selectedId === id) this.selectedId = null;
      this.clicks = a && a.pts ? [a.pts[0]] : [];
      this.changed();
      if (!this.chain.ids.length && !this.clicks.length) this.chain = null;
    } else if (this.placing) {
      this.placing = false;
    } else if (this.clicks.length) {
      this.clicks.pop();
      if (t && t.chain && !this.clicks.length) this.chain = null;
    } else {
      dlg.toast("Nimic de anulat în comanda curentă");
    }
    if (this._dynPt && this.clicks.length) this.updateOverlay(this._dynPt, null);
    else {
      this.view.overlay = null;
      this.view.redraw();
    }
  }

  /** C: closes a line chain or a polyline. */
  closeStep() {
    const t = TOOL_BY_ID[this.tool];
    if (t && t.kind === "poly") {
      if (this.clicks.length >= 3) this.finishPoly(true);
      return;
    }
    if (t && t.chain && this.chain && this.clicks.length) {
      const first = this.chain.first;
      this.toolClick(first);
      this.chain = null;
      this.clicks = [];
      this.view.overlay = null;
      this.view.redraw();
    }
  }

  /** CIRCLE, option Diameter: a typed diameter in real mm. */
  circleByDiameter(d) {
    if (!(d > 0) || !this.clicks.length) return false;
    const c = this.clicks[0];
    const k = Number(this.settings.scale) || 1;
    this.toolClick([c[0] + (d / 2 / k) * K, c[1]]);
    return true;
  }

  /** RECTANG, option Dimensions: length and width in real mm, towards the cursor's quadrant. */
  rectBySize(w, h) {
    if (!(Math.abs(w) > 0) || !(Math.abs(h) > 0) || !this.clicks.length) return false;
    const c = this.clicks[0];
    const cur = this._dynPt || [c[0] + 1, c[1] - 1];
    const k = Number(this.settings.scale) || 1;
    const sx = cur[0] >= c[0] ? 1 : -1;
    const sy = cur[1] <= c[1] ? 1 : -1; // up on the sheet = Y up
    this.toolClick([c[0] + sx * (Math.abs(w) / k) * K, c[1] - sy * (Math.abs(h) / k) * K]);
    return true;
  }

  /** UCS, option World: the origin goes back to the bottom-left corner of the page. */
  ucsWorld() {
    const had = this.annots.some((a) => a.type === "ucs" && a.page === this.page);
    if (had) {
      this.pushHistory();
      this.annots = this.annots.filter((a) => !(a.type === "ucs" && a.page === this.page));
      this.changed();
    }
    dlg.toast("Originea coordonatelor: colțul stânga-jos al paginii");
    this.setTool("select");
  }

  /** Session log for the history window (F2). */
  logCmd(text) {
    if (!this.cmdLog) this.cmdLog = [];
    this.cmdLog.push({ t: new Date(), text });
    if (this.cmdLog.length > 500) this.cmdLog.shift();
  }

  /** Finishes the polyline or hatch in progress. */
  finishPoly(close) {
    const t = TOOL_BY_ID[this.tool];
    const at = this.cmdState && this.cmdState.seriesAt;
    if (t.place && !at && this.clicks.length >= (t.min || 2)) {
      // the points are picked: now the cursor places the row, the next click sets it
      this.placing = true;
      this.setHint(t.placeHint);
      this.updateOverlay(this._dynPt || this.lastPt || this.clicks[this.clicks.length - 1], null);
      return;
    }
    const pts = this.clicks;
    this.clicks = [];
    this.view.overlay = null;
    this.setHint(t.hint);
    this.clearAcq();
    if (pts.length >= (t.min || 2)) this.addMade(t.make(pts, this, close || t.closed, at || undefined));
    else this.view.redraw();
  }

  pollOcrLang(tries = 20) {
    setTimeout(async () => {
      try {
        const h = await (await fetch("api/health")).json();
        if (h.ocr) this.ocrLang = h.ocr;
        else if (h.ocrPending && tries > 1) this.pollOcrLang(tries - 1);
      } catch (_) {
        if (tries > 1) this.pollOcrLang(tries - 1);
      }
    }, 3000);
  }

  async init() {
    startI18n(); // in English, texts are translated as the interface is built
    await document.fonts.load("16px osifont").catch(() => {});
    try {
      const h = await (await fetch("api/health")).json();
      this.retentionDays = h.retentionDays;
      this.mode = h.mode || "personal";
      this.ocrLang = h.ocr || null;
      this.desktop = !!h.desktop;
      this.version = h.version || "";
      // on first start Tesseract may answer slowly: the interface starts anyway, OCR shows up later
      if (h.ocrPending) this.pollOcrLang();
    } catch (_) {
      this.retentionDays = 0;
    }
    this.buildToolbar();
    this.bindUi();
    this.bindSnapUi();
    this.bindCanvas();
    this.bindKeys();
    this.bindCmdLine();
    this.applyKeyCfg(keyConfig());
    let dynOn = true;
    try {
      dynOn = localStorage.getItem("drawcad.dyn") !== "0";
    } catch (_) { /* on by default */ }
    this.dyn = { on: dynOn, vals: {}, active: null, text: "" };
    this.panel.render();
    this.refreshRecent();
    this.setTool("select");
    // the desktop app opens a file passed from Explorer ("Open with DrawCAD") as #doc=<id>
    const m = /^#doc=([a-f0-9]{32})$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", location.pathname);
      this.loadDoc(m[1]);
      return;
    }
    const last = localStorage.getItem("cotare.lastDoc");
    if (last) this.loadDoc(last, true);
  }

  // ------------------------------------------------------------ interface
  /** The rail's own settings, for all documents: labels under the icons, families shown. */
  railCfg() {
    let c = {};
    try {
      c = JSON.parse(localStorage.getItem("cotare.rail") || "{}") || {};
    } catch (_) { /* default */ }
    return { labels: c.labels !== false, hidden: Array.isArray(c.hidden) ? c.hidden : [], last: c.last && typeof c.last === "object" ? c.last : {} };
  }

  saveRailCfg(c) {
    try {
      localStorage.setItem("cotare.rail", JSON.stringify(c));
    } catch (_) { /* not remembered */ }
  }

  /** The family a tool belongs to on the rail (e2e and the flyout). */
  familyOf(id) {
    return FAMILY_OF[id] || null;
  }

  /** The tool a family's slot shows: the member used last, or the first. */
  familyTool(f, cfg = this.railCfg()) {
    const id = cfg.last[f.id];
    return f.tools.includes(id) && TOOL_BY_ID[id] ? id : f.tools[0];
  }

  /**
   * The tool rail (UI-D1): one slot per family with an icon and a short label; a click runs the tool the
   * slot shows, a second click on the active slot, a right click or a long press opens the family's
   * flyout with every member. Every tool keeps a [data-tool] button (in the flyout).
   */
  buildToolbar() {
    const cfg = this.railCfg();
    const nav = $("tools");
    nav.classList.toggle("compact", !cfg.labels);
    const fams = FAMILIES.filter((f) => !cfg.hidden.includes(f.id));
    nav.innerHTML = fams.map((f, i) => {
      const t = TOOL_BY_ID[this.familyTool(f, cfg)];
      return `${f.sep && i ? '<div class="rsep" aria-hidden="true"></div>' : ""}<button class="slot${f.tools.length > 1 ? " fly" : ""}" data-fam="${f.id}" aria-label="${f.label}"${f.tools.length > 1 ? ' aria-haspopup="menu" aria-expanded="false"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span>${f.label}</span></button>`;
    }).join("");
    // the flyout sits next to the rail (in .body: the rail itself scrolls and would clip it)
    let fly = $("railFly");
    if (!fly) {
      fly = document.createElement("div");
      fly.id = "railFly";
      fly.className = "flyout";
      fly.setAttribute("role", "menu");
      nav.after(fly);
    }
    fly.hidden = true;
    fly.innerHTML = `${FAMILIES.map((f) => `<div class="fgrp" data-fly="${f.id}" hidden><div class="fh">${f.label}</div>${f.tools.map((id) => {
      const t = TOOL_BY_ID[id];
      return `<button class="frow" role="menuitem" data-tool="${id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span>${t.label}</span><i class="mono"></i><kbd class="mono"></kbd></button>`;
    }).join("")}</div>`).join("")}`;
    nav.querySelectorAll("[data-fam]").forEach((b) => {
      const f = FAMILIES.find((x) => x.id === b.dataset.fam);
      b.addEventListener("click", () => {
        const id = this.familyTool(f);
        if (f.tools.length > 1 && (this.tool === id || !$("railFly").hidden && this.flyFam === f.id)) this.toggleFlyout(f.id);
        else {
          this.hideFlyout();
          this.setTool(id);
        }
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (f.tools.length > 1) this.toggleFlyout(f.id, true);
      });
      // press and hold (touch): the flyout
      let timer = 0;
      b.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch" || f.tools.length < 2) return;
        timer = setTimeout(() => { timer = -1; this.toggleFlyout(f.id, true); }, 300);
      });
      b.addEventListener("pointerup", (e) => {
        if (timer > 0) clearTimeout(timer);
        if (timer === -1) e.preventDefault();
        timer = 0;
      });
    });
    fly.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => {
      this.hideFlyout();
      this.setTool(b.dataset.tool);
    }));
    if (this.railBound) {
      this.markRail();
      if (this.keyCfg) this.applyKeyCfg(this.keyCfg);
      return;
    }
    this.railBound = true;
    fly.addEventListener("keydown", (e) => {
      const rows = [...$("railFly").querySelectorAll(`[data-fly="${this.flyFam}"] .frow`)];
      const i = rows.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = rows.length;
        rows[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const slot = nav.querySelector(`[data-fam="${this.flyFam}"]`);
        this.hideFlyout();
        if (slot) slot.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!$("railFly").hidden && !e.target.closest("#railFly") && !e.target.closest("[data-fam]")) this.hideFlyout();
    });
    this.markRail();
    if (this.keyCfg) this.applyKeyCfg(this.keyCfg);
  }

  /** Opens (or closes) a family's flyout next to its slot. */
  toggleFlyout(fam, open) {
    const fly = $("railFly");
    const willOpen = open ?? (fly.hidden || this.flyFam !== fam);
    if (!willOpen) {
      this.hideFlyout();
      return;
    }
    const slot = $("tools").querySelector(`[data-fam="${fam}"]`);
    if (!slot) return;
    this.flyFam = fam;
    fly.querySelectorAll("[data-fly]").forEach((g) => { g.hidden = g.dataset.fly !== fam; });
    fly.hidden = false;
    $("tools").querySelectorAll("[data-fam]").forEach((b) => b.hasAttribute("aria-expanded") && b.setAttribute("aria-expanded", String(b === slot)));
    // next to the slot, inside the window
    const body = fly.parentElement.getBoundingClientRect();
    const r = slot.getBoundingClientRect();
    const h = fly.offsetHeight;
    fly.style.left = `${$("tools").offsetWidth + 4}px`;
    fly.style.top = `${Math.max(4, Math.min(r.top - body.top - 6, body.height - h - 4))}px`;
    const cur = fly.querySelector(`[data-fly="${fam}"] .frow.on`) || fly.querySelector(`[data-fly="${fam}"] .frow`);
    if (cur) cur.focus({ preventScroll: true });
  }

  hideFlyout() {
    const fly = $("railFly");
    if (!fly || fly.hidden) return;
    fly.hidden = true;
    $("tools").querySelectorAll("[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }

  /** Slot tooltips: family, the tool the slot runs, its key and alias. */
  slotTitles() {
    if (!this.keyCfg) return;
    const byId = Object.fromEntries(commandList(this.keyCfg).map((c) => [c.id, c]));
    const cfg = this.railCfg();
    $("tools").querySelectorAll("[data-fam]").forEach((b) => {
      const f = FAMILIES.find((x) => x.id === b.dataset.fam);
      const c = f && byId[this.familyTool(f, cfg)];
      if (!c) return;
      const bits = [c.key, c.aliases[0]].filter(Boolean);
      b.title = `${tr(f.label)} — ${tr(c.label)}${bits.length ? ` (${[...new Set(bits)].join(" · ")})` : ""}`;
    });
  }

  /** The active tool on the rail: its family's slot shows it and is marked; the row in the flyout too. */
  markRail() {
    const id = this.tool;
    const fam = FAMILY_OF[id];
    if (fam) {
      const cfg = this.railCfg();
      if (cfg.last[fam] !== id) {
        cfg.last[fam] = id;
        this.saveRailCfg(cfg);
      }
    }
    $("tools").querySelectorAll("[data-fam]").forEach((b) => {
      const on = b.dataset.fam === fam;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (on) {
        const p = b.querySelector("svg path");
        if (p) p.setAttribute("d", TOOL_BY_ID[id].icon);
      }
    });
    document.querySelectorAll("#railFly [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === id));
    this.slotTitles();
  }


  bindUi() {
    $("btnOpen").addEventListener("click", () => dlg.openDialog(this));
    $("btnOpen2").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => {
      // the file comes from the "Open drawing" dialog: close the dialog
      if (e.target.files[0] && dlg.isModalOpen()) dlg.closeModal();
      const f = e.target.files[0];
      e.target.value = "";
      if (f) this.openFile(f, this.pendingDpi);
      this.pendingDpi = null;
    });
    $("btnExport").addEventListener("click", () => this.doc && dlg.exportDialog(this));
    $("btnClose").addEventListener("click", () => this.closeDoc());
    $("btnPanel").addEventListener("click", () => this.setPanelOpen(!$("app").classList.contains("panel-open")));
    $("btnPanelClose").addEventListener("click", () => this.setPanelOpen(false));
    // a pending save is not lost when the tab closes
    window.addEventListener("pagehide", () => this.flushSaveBeacon());
    $("btnSettings").addEventListener("click", () => this.doc && dlg.settingsDialog(this));
    $("btnText").addEventListener("click", () => this.doc && dlg.textDialog(this));
    document.querySelectorAll(".langsw [data-uilang]").forEach((b) => {
      b.classList.toggle("on", b.dataset.uilang === uiLang());
      b.addEventListener("click", () => {
        if (b.dataset.uilang === uiLang()) return;
        try {
          localStorage.setItem("drawcad.lang", b.dataset.uilang);
        } catch (_) { /* storage unavailable */ }
        location.reload();
      });
    });
    $("btnUndo").addEventListener("click", () => this.doUndo());
    $("btnRedo").addEventListener("click", () => this.doRedo());
    $("btnZoomIn").addEventListener("click", () => this.view.zoomAt(1.25, this.view.cw / 2, this.view.ch / 2));
    $("btnZoomOut").addEventListener("click", () => this.view.zoomAt(0.8, this.view.cw / 2, this.view.ch / 2));
    $("btnFit").addEventListener("click", () => this.view.fit());
    const vp = $("viewport");
    vp.addEventListener("dragover", (e) => {
      e.preventDefault();
      vp.classList.add("drag");
    });
    vp.addEventListener("dragleave", () => vp.classList.remove("drag"));
    vp.addEventListener("drop", (e) => {
      e.preventDefault();
      vp.classList.remove("drag");
      const f = e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
    this.updateButtons();
  }

  async refreshRecent() {
    try {
      const docs = await api.listDocs();
      $("recentList").innerHTML = dlg.recentHtml(docs, this.retentionDays, this.mode);
      dlg.bindRecent($("recentList"), this);
    } catch (_) { /* no list */ }
  }

  updateButtons() {
    const has = !!this.doc;
    $("btnExport").disabled = !has;
    $("btnClose").hidden = !has;
    $("btnSettings").disabled = !has;
    $("btnText").disabled = !has;
    $("btnUndo").disabled = !this.undo.length;
    $("btnRedo").disabled = !this.redo.length;
    $("emptyState").hidden = has;
    $("stScale").textContent = has ? `Scară ${this.scaleLabel()}` : "";
  }

  scaleLabel() {
    const s = this.settings.scale || 1;
    if (Math.abs(s - 1) < 1e-6) return "1:1";
    return s > 1 ? `1:${fmtNum(s, ",", 3)}` : `${fmtNum(1 / s, ",", 3)}:1`;
  }

  onZoom(z) {
    $("zoomLbl").textContent = `${Math.round((z * 100) / (96 / 72))}%`;
  }

  setHint(txt) {
    $("stHint").textContent = txt || "";
    $("stHint").title = txt || ""; // the status bar never wraps: the whole hint is in the tooltip
    const vh = $("vpHint");
    if (vh) vh.textContent = this.doc && this.tool !== "select" && this.tool !== "pan" ? txt || "" : "";
  }

  compact() {
    return window.matchMedia("(max-width: 1100px)").matches;
  }

  setPanelOpen(open) {
    $("app").classList.toggle("panel-open", open);
    $("btnPanel").setAttribute("aria-expanded", String(open));
  }

  setTool(id) {
    if (!TOOL_BY_ID[id]) return;
    if (id !== "select" && id !== "pan") {
      this.lastTool = id;
      this.lastCmd = id; // Enter / Space (in AutoCAD mode) restarts it
      this.recordCmd(id, this._typedCmd);
      this._typedCmd = null;
    }
    this.tool = id;
    this.clicks = [];
    this.placing = false;
    this.rectStart = null;
    this.cmdState = {};
    this.cmdAsk = null;
    this.chain = null;
    this.selPrompt = null;
    this.pointMod = null;
    this.hotGrip = null;
    this.snapOverride = null;
    this.snapPick = null;
    if (this.dyn) this.dynReset();
    if ($("dynBox")) $("dynBox").hidden = true;
    this.lastMeasure = null;
    this.hover = null;
    this.hoverKey2 = "";
    this.clearAcq();
    this.view.overlay = null;
    this.markRail();
    this.setHint(TOOL_BY_ID[id].hint);
    this.updateCmdPrompt();
    $("canvas").style.cursor = id === "pan" ? "grab" : id === "select" ? "default" : "crosshair";
    if (!this.selectedId) this.panel.render();
    this.view.redraw();
  }

  // ------------------------------------------------------------ documents
  async openFile(file, dpi) {
    dlg.toast(`Se deschide ${file.name}…`, 15000);
    try {
      const meta = await api.openFile(file, dpi);
      this.setDoc(meta, meta.state);
      const rm = meta.removed || {};
      const names = { javascript: "JavaScript", actiuni: "acțiuni automate", atasamente: "fișiere atașate", adnotari: "adnotări multimedia", xfa: "formular XFA" };
      const rmTxt = Object.entries(rm).map(([k, n]) => `${names[k] || k} (${n})`).join(", ");
      if (rmTxt) dlg.toast(`Deschis: ${meta.name}. Am eliminat din PDF conținutul activ, inutil la un desen: ${rmTxt}.`, 9000);
      else dlg.toast(meta.fromExport ? "Export anterior: cotele au fost reîncărcate editabile." : `Deschis: ${meta.name}`);
    } catch (e) {
      dlg.toast(`Nu s-a putut deschide: ${e.message}`, 6000);
    }
  }

  async loadDoc(id, silent) {
    try {
      const meta = await api.getDoc(id);
      this.setDoc(meta, meta.state);
    } catch (e) {
      if (!silent) dlg.toast(`Documentul nu mai există: ${e.message}`);
      localStorage.removeItem("cotare.lastDoc");
    }
  }

  setDoc(meta, state) {
    this.doc = meta;
    localStorage.setItem("cotare.lastDoc", meta.id);
    this.annots = (state && state.annots) || [];
    this.settings = { ...dlg.storedDefaults(), ...((state && state.settings) || {}) };
    this.ocr = new Map(); // page → OCR result (null = not recognized yet)
    this.ocrPages = new Set(meta.ocrPages || []);
    this.hit = null;
    this.undo = [];
    this.redo = [];
    this.cache.clear();
    this.selectedId = null;
    this.sel = new Set();
    this.unexported = false;
    this.setSaveState(state ? "saved" : "");
    $("docName").textContent = meta.name;
    $("docMeta").textContent = `${meta.kind === "image" ? "imagine" : "PDF"} · ${meta.pages.length} ${meta.pages.length === 1 ? "pagină" : "pagini"}`;
    document.title = `${meta.name} — DrawCAD`;
    this.setPage(0);
    this.updateButtons();
  }

  setPage(n) {
    if (!this.doc) return;
    this.page = n;
    this.clicks = [];
    this.selectedId = null;
    this.sel = new Set();
    const p = this.doc.pages[n];
    this.view.setPage(this.doc.id, n, p.w, p.h);
    this.renderTabs();
    this.panel.render();
    this.snapper = new Snapper();
    this.clearAcq();
    api.snap(this.doc.id, n, this.doc.lv || 0).then((s) => {
      if (this.page === n) this.snapper = new Snapper(s);
      if (this.page === n && this.snapCfg.scan) this.loadScanSnap(n);
    }).catch(() => {});
    if (this.showOcr && this.ocrPages.has(n)) this.loadOcr(n).catch(() => {});
  }

  /** A scanned page (no vector lines in the PDF). */
  isScanPage(n = this.page) {
    const p = this.doc && this.doc.pages[n];
    return !!(p && p.paths === 0);
  }

  /** Snap on a scan (option): the page is vectorized on the server once, then cached. */
  loadScanSnap(n = this.page) {
    if (!this.doc || !this.isScanPage(n)) return;
    const key = `${this.doc.id}:${n}`;
    this.scanSnaps = this.scanSnaps || new Map();
    const have = this.scanSnaps.get(key);
    if (have) {
      if (have.data && this.page === n) this.snapper = new Snapper(have.data);
      return;
    }
    const entry = { data: null };
    this.scanSnaps.set(key, entry);
    dlg.toast("Snap pe scanare: pagina se vectorizează (o dată, poate dura un minut)…", 6000);
    api.snapScan(this.doc.id, n).then((data) => {
      entry.data = data;
      if (this.page === n && this.snapCfg.scan) this.snapper = new Snapper(data);
      dlg.toast(`Snap pe scanare: gata — ${data.segs.length} linii, ${data.arcs.length} arce și cercuri`);
    }).catch((e) => {
      this.scanSnaps.delete(key);
      dlg.toast(`Snap pe scanare: ${e.message}`);
    });
  }

  /** Drawn shapes are scaled about their first point (on calibration, "keep their real
   *  dimensions"); dimensions are left alone, they measure the drawing. */
  rescaleShapes(f) {
    if (!(f > 0) || Math.abs(f - 1) < 1e-9) return;
    this.pushHistory();
    for (const a of this.annots) {
      if (a.type !== "shape" || !Array.isArray(a.pts) || !a.pts.length) continue;
      const o = a.pts[0];
      a.pts = a.pts.map((p) => [o[0] + (p[0] - o[0]) * f, o[1] + (p[1] - o[1]) * f]);
    }
    this.changed();
  }

  // ------------------------------------------------------------ text and OCR
  /** Recognized text of page n (from cache, from the server, or — with run — recognized now). */
  async loadOcr(n, run = false, force = false) {
    if (!run && this.ocr.has(n)) return this.ocr.get(n);
    const r = run ? await api.runOcr(this.doc.id, n, force) : await api.getOcr(this.doc.id, n);
    const v = r.ocr || null;
    this.ocr.set(n, v);
    if (v) this.ocrPages.add(n);
    this.view.redraw();
    return v;
  }

  setShowOcr(on) {
    this.showOcr = !!on;
    if (on && this.ocrPages.has(this.page)) this.loadOcr(this.page).catch(() => {});
    this.view.redraw();
  }

  /** Shows a found text: its page, zoomed on it, with a frame that fades out. */
  gotoText(page, box) {
    if (page !== this.page) this.setPage(page);
    const pad = 30;
    this.view.zoomToBox([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], 40);
    this.hit = { page, box, t: Date.now() };
    this.view.redraw();
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      this.hit = null;
      this.view.redraw();
    }, 2600);
  }

  renderTabs() {
    const tabs = this.doc.pages.map((p, i) => `<button class="${i === this.page ? "on" : ""}" data-pg="${i}">Pagina ${i + 1}</button>`).join("");
    const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    const ops = `<span class="pgops">
      <button class="mini" data-pgop="rl" title="Rotește pagina la stânga (ROTL)" aria-label="Rotește pagina la stânga">${ico("M4 4v6h6M4.6 15a8 8 0 1 0 1.9-8.3L4 10")}</button>
      <button class="mini" data-pgop="rr" title="Rotește pagina la dreapta (ROTR)" aria-label="Rotește pagina la dreapta">${ico("M20 4v6h-6M19.4 15a8 8 0 1 1-1.9-8.3L20 10")}</button>
      <button class="mini" data-pgop="dlg" title="Pagini: rotire, ordine, ștergere (PAGES)" aria-label="Pagini">${ico("M5 3h9l5 5v13H5zM14 3v5h5")}</button></span>`;
    $("pageTabs").innerHTML = `${tabs}${ops}<span class="legend">Original: negru · Adăugat: albastru · Revizie: roșu</span>`;
    $("pageTabs").querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => this.setPage(Number(b.dataset.pg))));
    $("pageTabs").querySelectorAll("[data-pgop]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.pgop;
      if (k === "dlg") dlg.pagesDialog(this);
      else this.pageOp({ op: "rotate", pages: [this.page], delta: k === "rr" ? 90 : -90 }).catch((e) => dlg.toast(e.message));
    }));
  }

  /** Rotating / deleting / moving pages: annotations (and the undo history) are transformed along
   *  with the page, and the server receives the new state together with the operation. */
  async pageOp(op) {
    if (!this.doc || this._pageBusy) return;
    const n = this.doc.pages.length;
    const full = { ...op, count: n, sizes: this.doc.pages.map((p) => [p.w, p.h]) };
    const S = this.S();
    const tr = (list) => applyPageOp(list, full, S, this.measure);
    const annots = tr(this.annots);
    this._pageBusy = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      // sheet enlarged k times: the same real dimension means k times more paper mm
      let settings = this.settings;
      if (op.op === "scale" && (op.pages == null || n === 1)) settings = { ...settings, scale: (Number(settings.scale) || 1) / op.factor };
      const res = await api.pageOp(this.doc.id, { ...op, state: { ...this.stateJson(), settings, annots } });
      this.annots = annots;
      if (settings !== this.settings) {
        this.settings = settings;
        this._S = null;
      }
      this.undo = this.undo.map((st) => JSON.stringify(tr(JSON.parse(st))));
      this.redo = this.redo.map((st) => JSON.stringify(tr(JSON.parse(st))));
      this.cache.clear();
      this.doc.pages = res.pages;
      this.doc.lv = res.lv;
      this.ocrPages = new Set(res.ocrPages || []);
      this.ocr = new Map();
      let pg = this.page;
      if (op.op === "delete") pg = Math.min(pg - op.pages.filter((d) => d < pg).length, res.pages.length - 1);
      if (op.op === "move") {
        const order = [...Array(n).keys()];
        order.splice(op.to, 0, order.splice(op.page, 1)[0]);
        pg = order.indexOf(this.page);
      }
      this.selectedId = null;
      this.sel = new Set();
      this.unexported = true;
      this.setSaveState("saved");
      $("docMeta").textContent = `${this.doc.kind === "image" ? "imagine" : "PDF"} · ${res.pages.length} ${res.pages.length === 1 ? "pagină" : "pagini"}`;
      this.setPage(Math.max(0, pg));
      this.updateButtons();
    } finally {
      this._pageBusy = false;
    }
  }

  // ------------------------------------------------------------ state and history
  stateJson() {
    return { v: 1, settings: this.settings, annots: this.annots };
  }

  async flushSave() {
    if (!this.doc || !this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await api.saveState(this.doc.id, this.stateJson());
    } catch (e) {
      dlg.toast(`Salvare eșuată: ${e.message}`);
    }
  }

  flushSaveBeacon() {
    if (!this.doc || !this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const blob = new Blob([JSON.stringify(this.stateJson())], { type: "application/json" });
    navigator.sendBeacon(`api/doc/${this.doc.id}/state`, blob);
  }

  markExported() {
    this.unexported = false;
  }

  async closeDoc() {
    if (!this.doc) return;
    await this.flushSave();
    if (this.unexported && this.annots.length) dlg.closeDialog(this);
    else this.doClose();
  }

  doClose() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.doc = null;
    this.annots = [];
    this.selectedId = null;
    this.sel = new Set();
    this.clicks = [];
    this.undo = [];
    this.redo = [];
    this.cache.clear();
    this.unexported = false;
    this.view.overlay = null;
    this.view.clear();
    $("pageTabs").innerHTML = "";
    $("docName").textContent = "Niciun document";
    $("docMeta").textContent = "";
    document.title = "DrawCAD — editor PDF pentru desene tehnice";
    try {
      localStorage.removeItem("cotare.lastDoc");
    } catch (_) { /* storage unavailable */ }
    this.setTool("select");
    this.panel.render();
    this.updateButtons();
    this.refreshRecent();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    const id = this.doc && this.doc.id;
    if (!id) return;
    this.setSaveState("pending");
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.setSaveState("saving");
      api.saveState(id, this.stateJson()).then(() => {
        if (!this.saveTimer) this.setSaveState("saved");
      }).catch((e) => {
        // no network / server down: retried automatically, nothing is lost in the browser
        this.setSaveState("error", e.message);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.doc && this.doc.id === id && this.scheduleSave(), 5000);
      });
    }, 700);
  }

  setSaveState(st, msg) {
    const el = $("saveState");
    if (!el) return;
    const txt = { pending: "Modificat…", saving: "Se salvează…", saved: "Salvat pe server", error: "Nesalvat · reîncerc" }[st] || "";
    el.textContent = txt;
    el.className = `savestate ${st}`;
    el.title = st === "error" ? `Salvarea automată a eșuat (${msg || "eroare"}); se reîncearcă la 5 s.` : st === "saved" ? "Cotele sunt salvate pe server; le regăsești și după închiderea browserului." : "";
  }

  /** Short description for the annotation list. */
  annotLabel(a) {
    const b = this.builtOf(a);
    const first = (t) => String(t || "").split("\n")[0].slice(0, 40);
    switch (a.type) {
      case "dim":
      case "rad":
      case "ang": {
        const nom = a.nominal ?? (b && b.nominal);
        const v = nom != null ? fmtNum(nom, this.settings.sep || ",", 3) : "?";
        const tol = a.tol && a.tol.mode === "iso" ? ` ${a.tol.fit || ""}` : a.tol && a.tol.mode === "pm" ? " ±" : a.tol && a.tol.mode === "dev" ? " +/-" : "";
        return a.textOverride ? first(a.textOverride) : `${a.type === "rad" ? a.prefix ?? (a.dia ? "Ø" : "R") : a.prefix || ""}${v}${a.type === "ang" ? "°" : ""}${tol}`;
      }
      case "text":
      case "lead":
      case "note":
        return first(a.type === "note" ? a.title || a.text : a.text);
      case "gdt":
        return `${a.dia ? "Ø" : ""}${a.val || ""} ${(a.datums || []).filter(Boolean).join("|")}`.trim();
      case "datum":
      case "section":
      case "detail":
        return a.letter || "";
      case "balloon":
        return `poz. ${a.num}`;
      case "ord":
        return `${a.axis === "y" ? "Y" : "X"}: ${((b && b.values) || []).map((v) => fmtNum(v, this.settings.sep || ",", 2)).join(" · ")}`.slice(0, 48);
      case "strike":
        return a.newText ? `→ ${a.newText}` : "tăiată";
      case "rough":
        return a.val || "";
      case "revtab":
      case "bom":
        return `${(a.rows || []).length} rânduri`;
      case "holes":
        return `${(a.rows || []).length} găuri`;
      default:
        return "";
    }
  }

  /** Every annotation under the point, the topmost first (for selection cycling). */
  annotsAt(raw) {
    const tol = 5 / this.view.zoom;
    const items = this.visibleBuilt();
    const out = [];
    for (let i = items.length - 1; i >= 0; i--) if (hit(items[i].built, items[i].a, raw, tol)) out.push(items[i].a);
    return out;
  }

  annotAt(raw) {
    const tol = 5 / this.view.zoom;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) if (hit(items[i].built, items[i].a, raw, tol)) return items[i].a;
    return null;
  }

  /** Selects the annotation and brings it to the center of the screen. */
  focusAnnot(id) {
    const a = this.annots.find((x) => x.id === id);
    if (!a) return;
    if (a.page !== this.page) this.setPage(a.page);
    if (this.tool !== "select") this.setTool("select");
    this.select(id);
    const b = this.builtOf(a).bbox;
    if (b) this.view.zoomToBox(b);
  }

  pushHistory(key) {
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    const now = Date.now();
    if (key && this.lastHistKey === key && now - this.lastHistTime < 1500) {
      this.lastHistTime = now;
      return;
    }
    this.lastHistKey = key;
    this.lastHistTime = now;
    this.undo.push(JSON.stringify(this.annots));
    // at most 200 steps and ~20 million characters (with thousands of annotations every step is large)
    let chars = this.undo.reduce((n, st) => n + st.length, 0);
    while (this.undo.length > 1 && (this.undo.length > 200 || chars > 20e6)) chars -= this.undo.shift().length;
    this.redo = [];
    this.updateButtons();
  }

  changed() {
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    this.unexported = true;
    this.view.redraw();
    this.view.loadImage(false); // reload only if the original's blackening changed
    this.scheduleSave();
    this.updateButtons();
  }

  doUndo() {
    if (!this.undo.length) return;
    this.redo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.undo.pop());
    this.lastHistKey = null;
    this.sel = new Set([...this.sel].filter((id) => this.annots.some((a) => a.id === id)));
    if (!this.selected()) this.selectedId = this.sel.size ? [...this.sel][0] : null;
    this.panel.render();
    this.changed();
  }

  doRedo() {
    if (!this.redo.length) return;
    this.undo.push(JSON.stringify(this.annots));
    this.annots = JSON.parse(this.redo.pop());
    this.lastHistKey = null;
    this.sel = new Set([...this.sel].filter((id) => this.annots.some((a) => a.id === id)));
    if (!this.selected()) this.selectedId = this.sel.size ? [...this.sel][0] : null;
    this.panel.render();
    this.changed();
  }

  setSettings(patch) {
    this.frame = (this.frame || 0) + 1; // annotations may change: the per-frame cache is no longer valid
    const inkBefore = JSON.stringify(this.settings.ink || null);
    this.settings = { ...this.settings, ...patch };
    this.cache.clear();
    this.panel.render();
    this.changed();
    if (JSON.stringify(this.settings.ink || null) !== inkBefore) this.view.loadImage(true);
  }

  /** Render parameters of the page: blackening of the original (whole drawing or chosen objects). */
  /** Real removals on page n, as render operations (the editor shows the export result). */
  removalOps(n) {
    const ops = [];
    for (const a of this.annots) {
      if (a.page !== n || a.type !== "redact" || a.mode === "cover") continue;
      if (a.mode === "objects") {
        if ((a.ids || []).length) ops.push({ mode: "objects", ids: a.ids });
      } else ops.push({ mode: a.mode, rect: a.r });
    }
    return ops;
  }

  renderQuery(n) {
    const rem = this.removalOps(n);
    if (rem.length) return `#rm${JSON.stringify(rem).length}:${hashStr(JSON.stringify(rem))}${this.renderQueryBase(n)}`;
    return this.renderQueryBase(n);
  }

  renderQueryBase(n) {
    const ink = this.settings.ink;
    // page version (rotation, order): old renders from the browser cache are no longer used
    let q = this.doc && this.doc.lv ? `&v=${this.doc.lv}` : "";
    if (ink && ink.all) q += `&ink=1&fills=${ink.fills || "black"}${ink.images ? "&img=1" : ""}`;
    else {
      const ids = this.annots.filter((a) => a.type === "ink" && a.page === n).flatMap((a) => a.ids || []);
      if (ids.length) q += `&bk=${encodeURIComponent([...new Set(ids)].join(","))}`;
    }
    return q;
  }

  // ------------------------------------------------------------ annotations
  S() {
    if (!this._S || this._Skey !== JSON.stringify(this.settings)) {
      this._Skey = JSON.stringify(this.settings);
      this._S = derive(this.settings);
    }
    return this._S;
  }

  builtOf(a) {
    const S = this.S();
    const c = this.cache.get(a.id);
    // within the same event (one mouse move, one frame) geometry does not change: no JSON.stringify
    if (c && c.frame === this.frame && c.obj === a) return c.built;
    const stamp = JSON.stringify(a) + this._Skey;
    if (c && c.stamp === stamp) {
      c.frame = this.frame;
      c.obj = a;
      return c.built;
    }
    const built = build(a, S, this.measure);
    this.cache.set(a.id, { stamp, built, frame: this.frame, obj: a });
    return built;
  }

  layerOf(a) {
    if (a.type === "white" || a.type === "redact" || a.type === "ink") return "del";
    return a.layer === "rev" ? "rev" : "add";
  }

  /** Annotations of the current page, without layers hidden on screen. */
  visibleBuilt() {
    return this.annots
      .filter((a) => a.page === this.page && !this.hidden.has(this.layerOf(a)))
      .map((a) => ({ a, built: this.builtOf(a) }));
  }

  toggleLayer(k) {
    if (this.hidden.has(k)) this.hidden.delete(k);
    else this.hidden.add(k);
    try {
      localStorage.setItem("cotare.hidden", JSON.stringify([...this.hidden]));
    } catch (_) { /* not remembered */ }
    const keep = [...this.sel].filter((id) => {
      const a = this.annots.find((x) => x.id === id);
      return a && !this.hidden.has(this.layerOf(a));
    });
    if (keep.length !== this.sel.size) this.selectMany(keep);
    this.view.redraw();
  }

  selected() {
    return this.annots.find((a) => a.id === this.selectedId) || null;
  }

  /** Selected annotations (one or more), in document order. */
  selectedAll() {
    return this.annots.filter((a) => this.sel.has(a.id));
  }

  isSelected(id) {
    return this.sel.has(id);
  }

  select(id) {
    this.hotSet = null;
    this.selectedId = id;
    this.sel = new Set(id ? [id] : []);
    this.panel.render();
    this.view.redraw();
    if (this.compact()) {
      // on small screens the panel opens by itself only when there is something to type or an annotation is picked
      const a = id && this.annots.find((x) => x.id === id);
      const typing = a && ["text", "note", "lead", "strike", "revtab", "bom", "holes", "gdt", "rough", "balloon", "datum"].includes(a.type);
      if (!id) this.setPanelOpen(false);
      else if (this.tool === "select" || typing) this.setPanelOpen(true);
    }
  }

  selectMany(ids, add = false) {
    this.hotSet = null;
    const next = add ? new Set(this.sel) : new Set();
    for (const id of ids) next.add(id);
    this.sel = next;
    this.selectedId = next.size ? [...next][next.size - 1] : null;
    this.panel.render();
    this.view.redraw();
  }

  /** Replaces the selection by a set (from the selection rules). */
  setSelection(next) {
    this.sel = new Set(next);
    this.selectedId = this.sel.size ? [...this.sel][this.sel.size - 1] : null;
    this.panel.render();
    this.view.redraw();
    if (this.selPrompt) this.updateCmdPrompt();
  }

  /** AutoCAD selection (click adds, Shift removes): at a Select objects prompt, or chosen. */
  pickAdd() {
    return !!(this.selPrompt || (this.keyCfg && this.keyCfg.mode === "autocad" && this.keyCfg.pickadd));
  }

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
    if (p && (p.cmd === "moveSel" || p.cmd === "copySel") && this.sel.size) this.moveCmd(p.cmd);
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
    this.annots.push(...items);
    this.selectMany(items.map((a) => a.id));
    this.changed();
  }

  addAnnot(a) {
    this.pushHistory();
    a.page = this.page;
    // one origin per page: a new one replaces the old
    if (a.type === "ucs") this.annots = this.annots.filter((x) => !(x.type === "ucs" && x.page === this.page));
    if (this.hidden.has(this.layerOf(a))) {
      this.hidden.delete(this.layerOf(a));
      dlg.toast("Stratul era ascuns pe ecran; l-am reafișat ca să vezi ce ai adăugat.");
    }
    this.annots.push(a);
    this.select(a.id);
    this.changed();
    const focus = { text: "#tTxt", lead: "#lTxt", strike: "#sNew", note: "#nTxt" }[a.type];
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

  defaultTol() {
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
    return api.exportPdf(this.doc.id, { filename, colorMode, embed, pages, removals, ink, pageSel, split, state: this.stateJson(), ...extra });
  }

  // ------------------------------------------------------------ mouse
  snapPoint(raw, e, anchor) {
    const v = this.view;
    const cfg = this.snapCfg;
    // TK: every tracking point goes horizontally or vertically from the previous one
    const tk = this.pointMod && this.pointMod.kind === "tk" && this.pointMod.pts.length;
    const ortho = tk || orthoActive(cfg.ortho, e.shiftKey);
    // a candidate chosen with Tab stays while the cursor stays
    if (this.snapPick) {
      if (Math.hypot(raw[0] - this.snapPick.raw[0], raw[1] - this.snapPick.raw[1]) * v.zoom < 3) return { pt: this.snapPick.p, sn: this.snapPick.sn };
      this.snapPick = null;
    }
    let pt = raw;
    let sn = null;
    if (!e.altKey) {
      // a typed override (END, MID… NON) works for one pick, even with snap off
      const ov = this.snapOverride;
      const on = cfg.on || !!ov;
      const extra = { pts: [], segs: [], arcs: [] };
      if (on) {
        for (const { a, built } of this.visibleBuilt()) {
          if (this.drag && this.drag.id === a.id) continue;
          if (built.snap) {
            extra.pts.push(...built.snap.pts);
            extra.segs.push(...built.snap.segs);
            if (built.snap.arcs) extra.arcs.push(...built.snap.arcs);
          } else extra.pts.push(...annotSnapPoints(built));
        }
      }
      this._extra = extra;
      // an original hidden on screen no longer "catches" the cursor
      const sp = on && !this.hidden.has("orig") ? this.snapper : this.noSnapper;
      sn = sp.snap(raw, {
        tol: 10 / v.zoom,
        modes: ov ? overrideModes(ov) : on ? new Set(cfg.modes) : new Set(),
        anchor,
        extra,
        acq: on ? this.acq : [],
        parDir: this.parDir,
        polarInc: !ortho && cfg.polar ? cfg.polarInc : 0,
        polarExtra: !ortho && cfg.polar ? cfg.polarExtra || [] : [],
        polarBase: cfg.polarRel ? this.lastSegAngle() : 0,
        polarStep: cfg.polarStep > 0 ? (cfg.polarStep / (Number(this.settings.scale) || 1)) * K : 0,
        tracking: on && cfg.tracking,
        trackPolar: on && cfg.tracking && !!cfg.trackPolar,
      });
      if (sn) {
        pt = sn.p;
        sn.label = this.snapLabel(sn, anchor);
      }
    }
    if ((!sn || sn.kind === "n") && anchor && ortho) {
      const dx = Math.abs(raw[0] - anchor[0]);
      const dy = Math.abs(raw[1] - anchor[1]);
      pt = dx >= dy ? [raw[0], anchor[1]] : [anchor[0], raw[1]];
      sn = null;
    }
    return { pt, sn };
  }

  snapLabel(sn, anchor) {
    let s = LABELS[sn.kind] || "";
    if (sn.d2 && sn.d2 !== sn.kind) s += ` + ${LABELS[sn.d2].toLowerCase()}`;
    if (sn.onObj) s += " ∩ obiect";
    const from = sn.from || (sn.kind === "pol" || sn.kind === "par" ? anchor : null);
    if (from && (sn.kind === "pol" || sn.kind === "par" || sn.kind === "trk" || sn.kind === "ext")) {
      const L = (Math.hypot(sn.p[0] - from[0], sn.p[1] - from[1]) / K) * (this.settings.scale || 1);
      const ang = ((Math.atan2(-(sn.p[1] - from[1]), sn.p[0] - from[0]) * 180) / Math.PI + 360) % 360;
      s += `: ${fmtNum(L, ",", 2)} < ${fmtNum(ang, ",", 1)}°`;
    }
    return s;
  }

  /** Direction of the last segment drawn (degrees, counter-clockwise), for relative polar angles. */
  lastSegAngle() {
    let p = null;
    let q = null;
    if (this.clicks.length >= 2) [p, q] = this.clicks.slice(-2);
    else if (this.chain && this.chain.ids.length) {
      const a = this.annots.find((x) => x.id === this.chain.ids[this.chain.ids.length - 1]);
      if (a && a.pts && a.pts.length >= 2) [p, q] = a.pts.slice(-2);
    }
    if (!p || !q) return 0;
    return (Math.atan2(-(q[1] - p[1]), q[0] - p[0]) * 180) / Math.PI;
  }

  /** Tab: the next snap candidate under the cursor (Shift+Tab: the previous one). */
  cycleSnap(back = false) {
    const raw = this.lastPt;
    if (!raw || !this.cmdActive() || this.placing) return false;
    const cfg = this.snapCfg;
    const ov = this.snapOverride;
    if (!cfg.on && !ov) return false;
    const anchor = this.lastPoint();
    const sp = this.hidden.has("orig") ? this.noSnapper : this.snapper;
    const list = sp.candidates(raw, {
      tol: 10 / this.view.zoom,
      modes: ov ? overrideModes(ov) : new Set(cfg.modes),
      anchor: this.clicks.length || this.rectStart ? anchor : null,
      extra: this._extra || {},
      acq: this.acq,
      parDir: this.parDir,
      polarInc: 0,
      tracking: false,
    });
    if (list.length < 2) return false;
    const key = `${raw[0].toFixed(2)},${raw[1].toFixed(2)}`;
    if (!this.snapCyc || this.snapCyc.key !== key || this.snapCyc.n !== list.length) this.snapCyc = { key, i: 0, n: list.length };
    this.snapCyc.i = (this.snapCyc.i + (back ? list.length - 1 : 1)) % list.length;
    const c = { ...list[this.snapCyc.i] };
    c.label = `${this.snapLabel(c, anchor)} (${this.snapCyc.i + 1}/${list.length}, Tab)`;
    this.snapPick = { raw: [...raw], p: c.p, sn: c };
    this._dynPt = c.p;
    this._dynSn = c;
    this.updateOverlay(this.clicks.length ? this.dynPoint(c.p, anchor) : c.p, c);
    this.showCoords(c.p, this.clicks.length ? anchor : null);
    return true;
  }

  /**
   * Acquisition as in AutoCAD: resting the cursor ~½ s on a point marks it for tracking and
   * extension (resting again removes it); resting on a line during a command takes its direction
   * for parallel snap.
   */
  trackHover(sn, raw) {
    const cfg = this.snapCfg;
    if (!cfg.on) return;
    const pointKinds = new Set(["e", "m", "c", "x", "q", "ax", "a"]);
    let key = null;
    let act = null;
    if (sn && pointKinds.has(sn.kind) && (cfg.tracking || cfg.modes.includes("ext"))) {
      key = `p${sn.p[0].toFixed(2)},${sn.p[1].toFixed(2)}`;
      const p = [...sn.p];
      act = () => this.toggleAcq(p);
    } else if (this.clicks.length && cfg.modes.includes("par") && (!sn || sn.kind === "n" || sn.kind === "p")) {
      const u = (this.hidden.has("orig") ? this.noSnapper : this.snapper).dirUnder(raw[0], raw[1], 10 / this.view.zoom, this._extra || {});
      if (u) {
        key = `s${u.seg.slice(0, 4).join(",")}`;
        act = () => {
          this.parDir = u.dir;
          this.parSeg = u.seg.slice(0, 4);
        };
      }
    }
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    clearTimeout(this.hoverTimer);
    if (act) {
      this.hoverTimer = setTimeout(() => {
        if (this.hoverKey !== key) return;
        act();
        this.view.redraw();
      }, 450);
    }
  }

  toggleAcq(p) {
    const i = this.acq.findIndex((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < 0.01);
    if (i >= 0) this.acq.splice(i, 1);
    else {
      const sp = this.hidden.has("orig") ? this.noSnapper : this.snapper;
      this.acq.push({ p, dirs: sp.dirsAt(p, this._extra || {}) });
      if (this.acq.length > 7) this.acq.shift();
    }
  }

  clearAcq() {
    this.acq = [];
    this.parDir = null;
    this.parSeg = null;
    this.hoverKey = null;
    clearTimeout(this.hoverTimer);
  }

  saveSnapCfg() {
    try {
      localStorage.setItem("cotare.snap", JSON.stringify(this.snapCfg));
    } catch (_) { /* not remembered */ }
    this.syncSnapUi();
  }

  syncSnapUi() {
    const c = this.snapCfg;
    $("stSnap").checked = c.on;
    $("stOrtho").checked = c.ortho;
    $("stPolar").checked = c.polar;
    $("stTrack").checked = c.tracking;
    $("stPolarInc").value = String(c.polarInc);
    const m = $("snapMenu");
    if (m) m.querySelectorAll("[data-mode]").forEach((cb) => { cb.checked = c.modes.includes(cb.dataset.mode); });
  }

  bindSnapUi() {
    const c = this.snapCfg;
    $("snapMenu").innerHTML = `<div class="h">Moduri de snap</div>
      ${MODES.map((m) => `<label class="chk"><input type="checkbox" data-mode="${m.id}"> ${m.name}</label>`).join("")}
      <div class="row"><button class="ghost" data-all="1">Toate</button><button class="ghost" data-all="0">Niciunul</button></div>
      <label class="chk wide"><input type="checkbox" id="snScan" ${c.scan ? "checked" : ""}> Snap și pe scanări (pagina se vectorizează pe server; prima dată durează)</label>
      <div class="h">Polar</div>
      <label class="fld">Unghiuri suplimentare (°, despărțite prin ; ) <input type="text" id="snPolarExtra" class="mono" placeholder="ex.: 7; 22,5" value="${esc((c.polarExtra || []).join("; "))}"></label>
      <label class="chk wide"><input type="checkbox" id="snPolarRel" ${c.polarRel ? "checked" : ""}> Unghiuri față de ultimul segment</label>
      <label class="chk wide"><input type="checkbox" id="snTrackPolar" ${c.trackPolar ? "checked" : ""}> Urmărirea și pe unghiurile polare (nu doar orizontal / vertical)</label>
      <label class="fld">Pas pe direcția polară (mm reali, 0 = fără) <input type="text" id="snPolarStep" class="mono" value="${esc(String(c.polarStep || 0))}"></label>
      <div class="sub">Urmărire: oprește cursorul o clipă pe un punct (apare o cruciuliță verde), apoi mișcă-te pe orizontală, verticală sau în prelungirea liniei. Încă o oprire pe punct îl scoate.<br>Paralel: în timpul unei comenzi, oprește-te pe o linie, apoi mișcă-te aproape paralel cu ea.<br>F3 snap · F8 ortho · F10 polar · F11 urmărire · Alt = fără snap</div>`;
    $("snapMenu").querySelectorAll("[data-mode]").forEach((cb) => cb.addEventListener("change", () => {
      const set = new Set(c.modes);
      if (cb.checked) set.add(cb.dataset.mode);
      else set.delete(cb.dataset.mode);
      c.modes = MODES.map((m) => m.id).filter((id) => set.has(id));
      this.saveSnapCfg();
    }));
    $("snPolarExtra").addEventListener("change", (e) => {
      c.polarExtra = e.target.value.replace(/,\s+/g, ";").split(/[;\s]+/).map((x) => parseFloat(x.replace(",", "."))).filter((v) => Number.isFinite(v) && Math.abs(v) <= 360).slice(0, 12);
      e.target.value = c.polarExtra.join("; ");
      this.saveSnapCfg();
    });
    $("snPolarRel").addEventListener("change", (e) => { c.polarRel = e.target.checked; this.saveSnapCfg(); });
    $("snTrackPolar").addEventListener("change", (e) => { c.trackPolar = e.target.checked; this.saveSnapCfg(); });
    $("snScan").addEventListener("change", (e) => {
      c.scan = e.target.checked;
      this.saveSnapCfg();
      if (c.scan) this.loadScanSnap();
      else if (this.isScanPage()) this.snapper = new Snapper(); // back to the page's own (empty) geometry
    });
    $("snPolarStep").addEventListener("change", (e) => {
      const v = parseFloat(String(e.target.value).replace(",", "."));
      c.polarStep = Number.isFinite(v) && v > 0 ? v : 0;
      e.target.value = String(c.polarStep);
      this.saveSnapCfg();
    });
    $("snapMenu").querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => {
      c.modes = b.dataset.all === "1" ? MODES.map((m) => m.id) : [];
      this.saveSnapCfg();
    }));
    $("stSnapMenu").addEventListener("click", (e) => {
      e.stopPropagation();
      $("snapMenu").hidden = !$("snapMenu").hidden;
    });
    document.addEventListener("pointerdown", (e) => {
      if (!$("snapMenu").hidden && !e.target.closest(".snapctl")) $("snapMenu").hidden = true;
    });
    $("stSnap").addEventListener("change", () => { c.on = $("stSnap").checked; this.clearAcq(); this.saveSnapCfg(); });
    $("stTrack").addEventListener("change", () => { c.tracking = $("stTrack").checked; this.saveSnapCfg(); });
    // ortho and polar exclude each other, as in AutoCAD
    $("stOrtho").addEventListener("change", () => { c.ortho = $("stOrtho").checked; if (c.ortho) c.polar = false; this.saveSnapCfg(); });
    $("stPolar").addEventListener("change", () => { c.polar = $("stPolar").checked; if (c.polar) c.ortho = false; this.saveSnapCfg(); });
    $("stPolarInc").addEventListener("change", () => { c.polarInc = Number($("stPolarInc").value); c.polar = true; c.ortho = false; this.saveSnapCfg(); });
    this.syncSnapUi();
  }

  bindCanvas() {
    const cv = $("canvas");
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      if (e.ctrlKey || !e.shiftKey) this.view.zoomAt(Math.exp(-e.deltaY * 0.0015), sx, sy);
      else this.view.pan(-e.deltaY, 0);
    }, { passive: false });

    cv.addEventListener("pointerdown", (e) => {
      this.frame = (this.frame || 0) + 1;
      this.hideGripMenu();
      if (!this.doc) return;
      // tool keys must not end up in a panel field that is still focused
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      cv.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      if (this.mmenu) {
        // radial menu open: a click outside closes it
        this.closeMarkingMenu();
        return;
      }
      // two fingers: pan + zoom; drop whatever the first finger started
      if (e.pointerType === "touch") {
        this.touches.set(e.pointerId, [sx, sy]);
        if (this.touches.size === 2) {
          clearTimeout(this.pressTimer);
          this.drag = { kind: "pinch", ...this.pinchState() };
          return;
        }
        if (this.touches.size > 2) return;
      }
      if (e.button === 2) {
        // right click: short = Esc / done, held = radial menu, dragged = pan the sheet
        this.drag = { kind: "rclick", sx, sy, x0: sx, y0: sy };
        clearTimeout(this.pressTimer);
        this.pressTimer = setTimeout(() => {
          if (this.drag && this.drag.kind === "rclick") {
            this.drag = { kind: "mmenu" };
            this.openMarkingMenu(sx, sy);
          }
        }, 350);
        e.preventDefault();
        return;
      }
      if (e.pointerType === "touch" && e.button === 0) {
        // long press with a finger: the radial menu
        clearTimeout(this.pressTimer);
        this.pressStart = [sx, sy];
        this.pressTimer = setTimeout(() => {
          if (this.touches.size !== 1 || !this.pressStart) return;
          this.drag = { kind: "mmenu", touch: true };
          this.view.overlay = null;
          this.openMarkingMenu(...this.pressStart);
        }, 550);
      }
      if (e.button === 1 || this.space || this.tool === "pan") {
        if (this.space) this.spaceDragged = true;
        this.drag = { kind: "pan", sx, sy };
        cv.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const t = TOOL_BY_ID[this.tool];
      if (this.hotGrip) {
        const base = this.hotGrip.base;
        const { pt } = this.snapPoint(raw, e, base);
        const p = this.dynTool() ? this.dynPoint(pt, base) : pt;
        if (this.dyn) this.dynReset();
        this.applyHotGrip(p);
        return;
      }
      if (t.kind === "select") {
        this.startSelectDrag(raw, sx, sy, e);
        return;
      }
      // before the first click of a tool, the selection handles take priority
      if (!this.clicks.length && this.tryHandleDrag(sx, sy, true)) return;
      const anchor = this.pickAnchor();
      if (t.kind === "rect") {
        const { pt } = this.snapPoint(raw, e, anchor);
        this.drag = { kind: "rect", start: pt };
        return;
      }
      if (e.pointerType === "touch") {
        // on touch screens the point is placed when the finger lifts: you can adjust the position with snap,
        // and a long press opens the menu without leaving a point behind
        this.drag = { kind: "tap" };
        return;
      }
      this.toolClick(this.dynPoint(this.snapPoint(raw, e, anchor).pt, anchor));
    });

    cv.addEventListener("pointermove", (e) => {
      this.frame = (this.frame || 0) + 1;
      if (!this.doc) return;
      const [sx, sy] = pos(e);
      const raw = this.view.toPage(sx, sy);
      this.lastPt = raw;
      const d = this.drag;
      if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, [sx, sy]);
        if (this.pressStart && Math.hypot(sx - this.pressStart[0], sy - this.pressStart[1]) > 8) {
          clearTimeout(this.pressTimer);
          this.pressStart = null;
        }
      }
      if (d && d.kind === "pinch") {
        if (this.touches.size < 2) return;
        const st = this.pinchState();
        if (st.d0 > 0 && d.d0 > 0) this.view.zoomAt(st.d0 / d.d0, st.cx, st.cy);
        this.view.pan(st.cx - d.cx, st.cy - d.cy);
        Object.assign(d, st);
        return;
      }
      if (d && d.kind === "rclick") {
        if (Math.hypot(sx - d.x0, sy - d.y0) > 5) {
          clearTimeout(this.pressTimer);
          this.drag = { kind: "pan", sx, sy };
          cv.style.cursor = "grabbing";
        }
        return;
      }
      if (d && d.kind === "mmenu") {
        this.hoverMarking(sx, sy);
        return;
      }
      if (d && d.kind === "pan") {
        this.view.pan(sx - d.sx, sy - d.sy);
        d.sx = sx;
        d.sy = sy;
        return;
      }
      if (d && d.kind === "edge") {
        const a = this.annots.find((x) => x.id === d.id);
        const { pt, sn } = this.snapPoint(raw, e, null);
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const b = this.boxOf(a);
        if (d.code.includes("w")) b[0] = pt[0];
        if (d.code.includes("e")) b[2] = pt[0];
        if (d.code.includes("n")) b[1] = pt[1];
        if (d.code.includes("s")) b[3] = pt[1];
        // edge dragged past the opposite one: the box flips, as in Windows
        if (b[0] > b[2]) {
          [b[0], b[2]] = [b[2], b[0]];
          d.code = d.code.replace(/[we]/, (c) => (c === "w" ? "e" : "w"));
        }
        if (b[1] > b[3]) {
          [b[1], b[3]] = [b[3], b[1]];
          d.code = d.code.replace(/[ns]/, (c) => (c === "n" ? "s" : "n"));
        }
        this.setBox(a, b);
        cv.style.cursor = this.edgeCursor(d.code);
        const ks = this.settings.scale || 1;
        this.dragTip = sn ? null : { p: pt, txt: `${fmtNum(((b[2] - b[0]) / K) * ks, ",", 1)} × ${fmtNum(((b[3] - b[1]) / K) * ks, ",", 1)} mm` };
        this.view.overlay = { snap: sn };
        this.view.redraw();
        this.showCoords(pt);
        return;
      }
      if (d && d.kind === "handle") {
        // a click without moving makes the grip hot (see pointerup); small jitter is not a drag
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
        d.moved = true;
        const { pt, sn } = this.snapPoint(raw, e, d.anchor);
        this.trackHover(sn, raw);
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const a = this.annots.find((x) => x.id === d.id);
        setHandle(a, d.k, d.k === "tx" ? raw : pt, this.builtOf(a));
        this.frame++;
        this.view.overlay = { snap: d.k === "tx" ? null : sn };
        cv.style.cursor = "grabbing";
        const bm = this.builtOf(a);
        const val = bm && bm.measured != null ? ` · ${fmtNum(bm.measured, ",", 2)}${bm.unit === "°" ? "°" : " mm"}` : "";
        this.dragTip = sn ? null : { p: pt, txt: `${d.label || "Modifică"}${val}` };
        this.view.redraw();
        this.showCoords(pt);
        return;
      }
      if (d && d.kind === "scale") {
        if (!d.pushed) {
          this.pushHistory();
          d.pushed = true;
        }
        const a = this.annots.find((x) => x.id === d.id);
        const k = d.s0 * (Math.hypot(raw[0] - d.anchor[0], raw[1] - d.anchor[1]) / d.d0);
        a.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, k)) * 20) / 20;
        this.setHint(`Mărime ${Math.round(a.scale * 100)}% · eliberează pentru a fixa`);
        cv.style.cursor = d.cursor || "nwse-resize";
        this.dragTip = { p: raw, txt: `Mărime ${Math.round(a.scale * 100)}%` };
        this.view.redraw();
        return;
      }
      if (d && d.kind === "move") {
        const dx = raw[0] - d.last[0];
        const dy = raw[1] - d.last[1];
        if (!d.pushed) {
          if (Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
          this.pushHistory();
          d.pushed = true;
        }
        for (const a of this.annots) if (d.ids.includes(a.id)) moveAnnot(a, dx, dy);
        d.last = raw;
        cv.style.cursor = "grabbing";
        const k = this.settings.scale || 1;
        this.dragTip = { p: raw, txt: `Mută${d.ids.length > 1 ? ` ${d.ids.length} adnotări` : ""}: Δx ${fmtNum(((raw[0] - d.start[0]) / K) * k, ",", 2)} · Δy ${fmtNum(((d.start[1] - raw[1]) / K) * k, ",", 2)} mm` };
        this.view.redraw();
        return;
      }
      if (d && d.kind === "marquee") {
        const force = this.selPrompt && this.selPrompt.force;
        const crossing = force ? force === "c" : raw[0] < d.start[0];
        this.view.overlay = { rect: [d.start[0], d.start[1], raw[0], raw[1]], rectColor: crossing ? COLORS.selCrossing : COLORS.selWindow };
        this.view.redraw();
        return;
      }
      const t = TOOL_BY_ID[this.tool];
      if (this.selPrompt && this.selPrompt.fence && this.selPrompt.fence.length) {
        this.drawFence(raw);
        return;
      }
      if (this.hotGrip && !d) {
        const base = this.hotGrip.base;
        const { pt, sn } = this.snapPoint(raw, e, base);
        this.trackHover(sn, raw);
        this._dynPt = pt;
        this._dynSn = sn;
        // a length or angle typed at the cursor is locked: the preview follows it
        const dt = this.dynTool();
        const p2 = dt ? this.dynPoint(pt, base) : pt;
        this.previewHotGrip(p2, sn);
        this.showCoords(p2, base);
        this.renderDyn(p2, dt ? base : null);
        return;
      }
      if (t.kind === "select" || t.kind === "pan") {
        this.showCoords(raw);
        if (t.kind === "select" && !d) {
          // what a click would grab: handle, edge or annotation, with the matching cursor and label
          const hv = e.pointerType === "touch" ? null : this.hoverAt(sx, sy, raw, false);
          cv.style.cursor = hv ? hv.cursor : "default";
          this.setHover(hv, raw);
          this.gripMenuHover(hv, sx, sy);
        }
        return;
      }
      if (!d && !this.clicks.length) {
        // even with another tool, the resize corners of the selection stay grabbable
        const hs = this.handleAt(sx, sy);
        if (hs && hs.h.k === "sc") {
          cv.style.cursor = this.handleCursor(hs.a, hs.h);
          this.setHover({ kind: "handle", a: hs.a, h: hs.h, label: "Mărește / micșorează" }, raw);
          return;
        }
        if (this.hover) this.setHover(null, raw);
        cv.style.cursor = "crosshair";
      }
      const anchor = d && d.kind === "rect" ? d.start : this.pickAnchor();
      const { pt: spt, sn } = this.snapPoint(raw, e, anchor);
      this.trackHover(sn, raw);
      this._dynPt = spt;
      this._dynSn = sn;
      // typed values (dynamic input) fix the point: the cursor only picks what you did not type
      const pt = d && d.kind === "rect" ? spt : this.dynPoint(spt, anchor);
      this.showCoords(pt, anchor);
      if (d && d.kind === "rect") {
        this.view.overlay = { rect: [d.start[0], d.start[1], pt[0], pt[1]], rectColor: t.id === "redact" ? COLORS.edred : COLORS.sel, snap: sn };
        this.view.redraw();
        return;
      }
      this.updateOverlay(pt, sn);
      this.renderDyn(pt, anchor);
    });

    const up = (e) => {
      this.dragTip = null;
      if (e.pointerType === "touch") {
        this.touches.delete(e.pointerId);
        clearTimeout(this.pressTimer);
        this.pressStart = null;
      }
      const d = this.drag;
      if (d && d.kind === "pinch") {
        // second finger lifted: the gesture ends, no click
        if (this.touches.size === 0) this.drag = null;
        return;
      }
      this.drag = null;
      if (!d) return;
      if (d.kind === "rclick") {
        clearTimeout(this.pressTimer);
        this.escape(true);
        return;
      }
      if (d.kind === "tap") {
        const [ux, uy] = pos(e);
        const raw = this.view.toPage(ux, uy);
        const an = this.pickAnchor();
        this.toolClick(this.dynPoint(this.snapPoint(raw, e, an).pt, an));
        return;
      }
      if (d.kind === "mmenu") {
        const m = this.mmenu;
        if (m && m.hi >= 0) this.runMarking(m.hi);
        return; // no direction: the menu stays open for a click
      }
      if (d.kind === "pan") {
        $("canvas").style.cursor = this.tool === "pan" ? "grab" : this.tool === "select" ? "default" : "crosshair";
        return;
      }
      if (d.kind === "edge") {
        this.view.overlay = null;
        if (d.pushed) {
          this.panel.render();
          this.changed();
        }
        return;
      }
      if (d.kind === "handle" && !d.moved && d.k !== "tx") {
        this.startHotGrip(d);
        return;
      }
      if (d.kind === "handle" || d.kind === "move" || d.kind === "scale") {
        if (d.kind === "scale") this.setHint(TOOL_BY_ID[this.tool].hint);
        this.view.overlay = null;
        if (d.pushed) {
          this.panel.render();
          this.changed();
        }
        return;
      }
      if (d.kind === "marquee") {
        const [sx2, sy2] = pos(e);
        const end = this.view.toPage(sx2, sy2);
        this.view.overlay = null;
        const x0 = Math.min(d.start[0], end[0]);
        const x1 = Math.max(d.start[0], end[0]);
        const y0 = Math.min(d.start[1], end[1]);
        const y1 = Math.max(d.start[1], end[1]);
        if ((x1 - x0) * this.view.zoom < 4 && (y1 - y0) * this.view.zoom < 4) {
          if (this.pickAdd()) this.view.redraw(); // a click on nothing keeps the selection
          else if (!d.add) this.select(null);
          else this.view.redraw();
          return;
        }
        // left→right: only what is fully inside the rectangle; right→left: everything it touches
        // (W / C at the Select objects prompt force one of them for the next rectangle)
        const force = this.selPrompt && this.selPrompt.force;
        const crossing = force ? force === "c" : end[0] < d.start[0];
        if (force) this.selPrompt.force = null;
        const ids = [];
        for (const { a, built } of this.visibleBuilt()) {
          const b = built.bbox;
          if (!b) continue;
          const inside = b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1;
          const touch = !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1);
          if (crossing ? touch : inside) ids.push(a.id);
        }
        if (this.pickAdd()) this.setSelection(windowSelection(this.sel, ids, { shift: d.add || !!(this.selPrompt && this.selPrompt.remove), pickadd: true }));
        else this.selectMany(ids, d.add);
        return;
      }
      if (d.kind === "rect") {
        const [sx, sy] = pos(e);
        const raw = this.view.toPage(sx, sy);
        const { pt } = this.snapPoint(raw, e, d.start);
        this.view.overlay = null;
        this.view.redraw();
        this.commitRect([d.start[0], d.start[1], pt[0], pt[1]]);
      }
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    // double click on an annotation: the cursor goes straight to the first editable field in the panel
    cv.addEventListener("dblclick", (e) => {
      if (this.tool !== "select") return;
      const [sx, sy] = pos(e);
      const a = this.annotAt(this.view.toPage(sx, sy));
      if (!a) return;
      this.select(a.id);
      if (this.compact()) this.setPanelOpen(true);
      const f = $("panel").querySelector("textarea, input[type=text]:not(#dScale)");
      if (f) {
        f.focus();
        if (f.select) f.select();
      }
    });
    // the browser context menu does not appear over the drawing; not even when the right click is
    // released over the radial menu (on Windows the event comes when the button is released)
    $("viewport").addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("contextmenu", (e) => {
      if (this.mmenu || this.mmenuClosedAt > performance.now() - 400) e.preventDefault();
    });
    cv.addEventListener("pointerleave", (e) => {
      // towards the grip menu: it stays; anywhere else it goes
      if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#gripMenu"))) this.hideGripMenu();
      if (this.hover) this.setHover(null, null);
      if (!this.drag && this.view.overlay && this.view.overlay.snap) {
        this.view.overlay.snap = null;
        this.view.redraw();
      }
    });
  }

  /** Editable rectangle of a box (cover, removal, blackening, struck dimension, drawn rectangle). */
  boxOf(a) {
    let r = null;
    if (a.r && ["white", "redact", "ink", "strike"].includes(a.type)) r = a.r;
    else if (a.type === "shape" && a.kind === "rect" && a.pts && a.pts.length >= 2) r = [...a.pts[0], ...a.pts[1]];
    if (!r) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }

  /** Box edge or corner under the cursor (like Windows windows). */
  edgeAt(sx, sy, touch) {
    const tol = touch ? 12 : 6;
    const items = this.visibleBuilt();
    for (let i = items.length - 1; i >= 0; i--) {
      const { a } = items[i];
      const b = this.boxOf(a);
      if (!b) continue;
      const [X0, Y0] = this.view.toScreen([b[0], b[1]]);
      const [X1, Y1] = this.view.toScreen([b[2], b[3]]);
      if (sx < X0 - tol || sx > X1 + tol || sy < Y0 - tol || sy > Y1 + tol) continue;
      let code = "";
      if (Math.abs(sy - Y0) <= tol) code += "n";
      else if (Math.abs(sy - Y1) <= tol) code += "s";
      if (Math.abs(sx - X0) <= tol) code += "w";
      else if (Math.abs(sx - X1) <= tol) code += "e";
      if (code) return { a, code };
    }
    return null;
  }

  edgeCursor(code) {
    return { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" }[code] || "default";
  }

  setBox(a, b) {
    if (a.type === "shape") a.pts = [[b[0], b[1]], [b[2], b[3]]];
    else a.r = b;
  }

  startSelectDrag(raw, sx, sy, e) {
    const v = this.view;
    const hv = this.hover;
    this.hover = null;
    this.hoverKey2 = "";
    const sp = this.selPrompt;
    if (sp && sp.fence) {
      // F (Fence): the clicks draw the line; Enter selects what it crosses
      sp.fence.push(raw);
      this.drawFence(raw);
      return;
    }
    if (!sp && e.shiftKey) {
      // as in AutoCAD: Shift+click on grips makes several hot; a click on one of them then stretches all
      const hg = this.handleAt(sx, sy, e.pointerType === "touch");
      if (hg && hg.h.k !== "sc" && hg.h.k !== "tx") {
        const key = gripKey(hg.a.id, hg.h.k);
        if (!this.hotSet) this.hotSet = new Map();
        if (this.hotSet.has(key)) this.hotSet.delete(key);
        else this.hotSet.set(key, { id: hg.a.id, k: hg.h.k, p: [...hg.h.p] });
        if (!this.hotSet.size) this.hotSet = null;
        this.view.redraw();
        return;
      }
    }
    if (!sp && !e.shiftKey && this.tryHandleDrag(sx, sy, false, e.pointerType === "touch")) return;
    if (this.hotSet) {
      // a click elsewhere drops the grips picked with Shift
      this.hotSet = null;
      this.view.redraw();
    }
    const edge = !sp && !e.shiftKey && this.edgeAt(sx, sy, e.pointerType === "touch");
    if (edge) {
      if (!this.sel.has(edge.a.id)) this.select(edge.a.id);
      this.drag = { kind: "edge", id: edge.a.id, code: edge.code };
      return;
    }
    const tol = 5 / v.zoom;
    const all = this.visibleBuilt();
    // Tab (selection cycling) chose an annotation under the cursor: the click takes that one
    const cycled = !sp && hv && hv.kind === "body" && this.hoverCycle && this.hoverCycle.i > 0 ? all.find((x) => x.a.id === hv.a.id) : null;
    const items = cycled ? [...all, cycled] : all;
    for (let i = items.length - 1; i >= 0; i--) {
      const { a, built } = items[i];
      if (hit(built, a, raw, tol)) {
        if (this.pickAdd()) {
          this.setSelection(clickSelection(this.sel, a.id, { shift: e.shiftKey || !!(this.selPrompt && this.selPrompt.remove), pickadd: true }));
          if (e.shiftKey || this.selPrompt) return;
          this.drag = { kind: "move", ids: [...this.sel], last: raw, start: raw, sx, sy };
          return;
        }
        if (e.shiftKey) {
          this.toggleSelect(a.id);
          return;
        }
        if (!this.sel.has(a.id)) this.select(a.id);
        this.drag = { kind: "move", ids: [...this.sel], last: raw, start: raw, sx, sy };
        return;
      }
    }
    // empty area: selection rectangle
    this.drag = { kind: "marquee", start: raw, add: e.shiftKey };
  }

  /** At most this many selected annotations show grips. */
  get gripLimit() {
    return GRIP_LIMIT;
  }

  /** The selected annotations that show grips: all of them up to GRIP_LIMIT (none beyond, as in AutoCAD). */
  gripOwners() {
    if (!this.sel.size || this.sel.size > GRIP_LIMIT) return [];
    return this.selectedAll().filter((a) => a.page === this.page && !this.hidden.has(this.layerOf(a)));
  }

  /** A grip of annotation a; with several annotations selected the resize corners are left out. */
  gripsOf(a, multi = this.sel.size > 1) {
    const hs = this.builtOf(a).handles || [];
    return multi ? hs.filter((h) => h.k !== "sc") : hs;
  }

  /** The grip of the selected annotations closest to the cursor (screen pixels), or null. */
  handleAt(sx, sy, touch = false) {
    const r = touch ? 16 : 10;
    let best = null;
    let bd = r;
    for (const sel of this.gripOwners()) {
      for (const h of this.gripsOf(sel)) {
        if (!h.p) continue;
        const [hx, hy] = this.view.toScreen(h.p);
        // on a tie, the annotation's points win over the resize corners
        const d = Math.hypot(hx - sx, hy - sy) + (h.k === "sc" ? 1.5 : 0);
        if (d <= bd) {
          bd = d;
          best = { a: sel, h };
        }
      }
    }
    return best;
  }

  /** Is this grip hot (red): picked with Shift, or part of the hot grip in progress? */
  isHotGrip(id, k) {
    if (this.hotSet && this.hotSet.has(gripKey(id, k))) return true;
    return !!(this.hotGrip && this.hotGrip.grips.some((x) => x.id === id && x.k === k));
  }

  /** What a handle does, in words (hover tooltip). */
  handleLabel(a, k) {
    if (k === "sc") return "Mărește / micșorează";
    if (k === "tx") return "Mută textul cotei";
    if (k === "elbow") return "Cotul liniei — frânge linia";
    if (k === "target") return "Vârful pe piesă";
    if (k === "pos" || (k === "p" && ["text", "note", "revtab", "bom", "holes"].includes(a.type))) return "Mută";
    if (k === "vp") return "Partea spre care privești";
    if (k === "tp") return "Mută litera";
    if (k === "r0" || k === "r1") return "Colț — redimensionează";
    if (k === "p3") return a.type === "ang" ? "Poziția arcului (alege unghiul)" : "Poziția liniei de cotă";
    if (k === "c") return "Centrul";
    if (k === "v") return "Vârful unghiului";
    if (k === "p1" || k === "p2") return "Punct de cotă — trage pe alt punct";
    if (k === "p" && a.type === "rad") return "Punct pe arc";
    if (k.startsWith("pts.")) return a.type === "shape" && (a.kind === "circle" || a.kind === "cross") && k === "pts.0" ? "Centrul" : "Punct — trage (cu snap)";
    return "Trage pentru a modifica";
  }

  handleCursor(a, h) {
    if (h.k === "sc") {
      const an = scaleAnchor(a);
      return (h.p[0] - an[0]) * (h.p[1] - an[1]) >= 0 ? "nwse-resize" : "nesw-resize";
    }
    if (h.k === "pos" || h.k === "tp" || (h.k === "p" && ["text", "note", "revtab", "bom", "holes"].includes(a.type))) return "move";
    return "grab";
  }

  /**
   * A click on the handles of the selected annotation edits it. With another tool active only the
   * resize handles count: endpoints must stay free for chained dimensions from the same point.
   */
  /**
   * A click on a grip of a selected annotation edits it. With another tool active only the
   * resize handle counts: endpoints must stay free for chained dimensions from the same point.
   */
  tryHandleDrag(sx, sy, onlyScale = false, touch = false) {
    const hit0 = this.handleAt(sx, sy, touch);
    if (!hit0) return false;
    const { a: sel, h } = hit0;
    if (h.k === "sc") {
      const an = scaleAnchor(sel);
      this.drag = { kind: "scale", id: sel.id, anchor: an, d0: Math.max(1e-3, Math.hypot(h.p[0] - an[0], h.p[1] - an[1])), s0: sel.scale || 1, cursor: this.handleCursor(sel, h) };
      return true;
    }
    if (onlyScale) return false;
    this.drag = { kind: "handle", id: sel.id, k: h.k, p: h.p, sx, sy, label: this.handleLabel(sel, h.k), anchor: h.k === "p2" ? sel.p1 : h.k === "p1" ? sel.p2 : h.k === "elbow" ? sel.target : null };
    return true;
  }

  /** What is under the cursor in Select mode: handle, box edge or annotation. */
  hoverAt(sx, sy, raw, touch) {
    const h = this.handleAt(sx, sy, touch);
    if (h) return { kind: "handle", a: h.a, h: h.h, cursor: this.handleCursor(h.a, h.h), label: this.handleLabel(h.a, h.h.k) };
    const edge = this.edgeAt(sx, sy, touch);
    if (edge) return { kind: "edge", a: edge.a, cursor: this.edgeCursor(edge.code), label: edge.code.length === 2 ? "Colț — redimensionează" : "Margine — redimensionează" };
    const all = this.annotsAt(raw);
    if (!all.length) {
      this.hoverCycle = null;
      return null;
    }
    // selection cycling: with annotations on top of each other Tab picks which one a click takes
    const key = all.map((x) => x.id).join(",");
    if (!this.hoverCycle || this.hoverCycle.key !== key) this.hoverCycle = { key, i: 0, n: all.length };
    const a = all[this.hoverCycle.i % all.length];
    const cyc = all.length > 1 ? ` · ${this.hoverCycle.i + 1}/${all.length} — Tab: următorul` : "";
    return { kind: "body", a, cursor: "move", label: `${typeName(a)}${this.sel.has(a.id) ? " — trage pentru a muta" : " — click pentru a selecta, trage pentru a muta"}${cyc}` };
  }

  /** Tab over annotations on top of each other: the next one becomes the one a click takes. */
  cycleHover() {
    const hc = this.hoverCycle;
    const hv = this.hover;
    if (!hc || hc.n < 2 || !hv || hv.kind !== "body" || !this.hoverPt) return false;
    hc.i = (hc.i + 1) % hc.n;
    const [sx, sy] = this.view.toScreen(this.hoverPt);
    this.hoverKey2 = "";
    this.setHover(this.hoverAt(sx, sy, this.hoverPt, false), this.hoverPt);
    return true;
  }

  setHover(hv, raw) {
    const key = hv ? `${hv.kind}:${hv.a.id}:${hv.h ? hv.h.k + hv.h.p.join(",") : ""}` : "";
    this.hoverPt = raw;
    if (key === this.hoverKey2) {
      if (hv) this.view.redraw(); // the label follows the cursor
      return;
    }
    this.hoverKey2 = key;
    this.hover = hv;
    this.view.redraw();
  }

  updateOverlay(pt, sn) {
    const t = TOOL_BY_ID[this.tool];
    if (this.placing) this._ordPt = pt;
    let prims = null;
    if (this.clicks.length && t.preview) {
      const pv = t.preview(this.clicks, pt, this);
      if (pv && (pv.line || pv.lines)) {
        prims = (pv.lines || [pv.line]).map((l) => ({ t: "L", p: [...l[0], ...l[1]], w: 0.6, c: "preview", dash: true }));
      }
      else if (Array.isArray(pv)) prims = pv.flatMap((x) => build({ ...x, layer: "add" }, this.S(), this.measure).prims);
      else if (pv) prims = build({ ...pv, layer: "add" }, this.S(), this.measure).prims;
    }
    if (!prims && t.id === "measure" && this.lastMeasure) prims = this.lastMeasure;
    this.view.overlay = { prims, snap: sn };
    this.view.redraw();
    const t2 = TOOL_BY_ID[this.tool];
    if (this.clicks.length) {
      if (this.placing) this.setHint(t2.placeHint);
      else if (t2.kind === "poly") this.setHint(`${t2.hint} · ${this.clicks.length} puncte`);
      else if (t2.chain) this.setHint(t2.hint);
      else this.setHint(`${t2.hint} · pas ${this.clicks.length + 1}/${t2.n} · Esc renunță`);
    }
  }

  showMeasure(p, q) {
    const k = this.settings.scale || 1;
    const dx = ((q[0] - p[0]) / K) * k;
    const dy = ((q[1] - p[1]) / K) * k;
    const L = Math.hypot(dx, dy);
    const ang = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 180;
    const f = (v) => fmtNum(v, ",", 3);
    // the measured line stays visible until the next measurement
    this.lastMeasure = [{ t: "L", p: [...p, ...q], w: 0.6, c: "sel" }, { t: "C", p: [...p], r: 1.2, w: 0.6, c: "sel" }, { t: "C", p: [...q], r: 1.2, w: 0.6, c: "sel" }];
    this.view.overlay = { prims: this.lastMeasure };
    this.view.redraw();
    dlg.toast(`L = ${f(L)} mm · Δx ${f(Math.abs(dx))} · Δy ${f(Math.abs(dy))} · ${fmtNum(ang, ",", 2)}°${Math.abs(k - 1) > 1e-9 ? ` (scara ${this.scaleLabel()})` : ""}`, 8000);
  }

  /** DIST, option Multiple: a chain of distances and their total, until Enter / Esc. */
  measureChain(p, q) {
    const k = this.settings.scale || 1;
    const st = this.cmdState;
    st.total = (st.total || 0) + (Math.hypot(q[0] - p[0], q[1] - p[1]) / K) * k;
    st.n = (st.n || 0) + 1;
    st.prims = [...(st.prims || []), { t: "L", p: [...p, ...q], w: 0.6, c: "sel" }, { t: "C", p: [...q], r: 1.2, w: 0.6, c: "sel" }];
    this.lastMeasure = st.prims;
    this.clicks = [q];
    this.lastPick = q;
    this.view.overlay = { prims: st.prims };
    this.view.redraw();
    dlg.toast(`Total = ${fmtNum(st.total, ",", 3)} mm (${st.n} ${st.n === 1 ? "segment" : "segmente"})${Math.abs(k - 1) > 1e-9 ? ` · scara ${this.scaleLabel()}` : ""}`, 8000);
  }

  // ------------------------------------------------------------ dynamic input (DYN)
  /** The tool expects a point relative to the last click: values can be typed on the keyboard. */
  dynTool() {
    const t = TOOL_BY_ID[this.tool];
    // a hot grip in Stretch or Move: length and angle from the base point, as for the next point of a line
    const g = this.hotGrip;
    if (g) return !!(this.doc && this.dyn.on && !g.pickBase && (g.mode === "stretch" || g.mode === "move"));
    return !!(this.doc && this.dyn.on && this.clicks.length && !this.placing && t && (t.kind === "clicks" || t.kind === "poly"));
  }

  dynReset() {
    this.dyn.vals = {};
    this.dyn.active = null;
    this.dyn.text = "";
  }

  /** The cursor point, with the typed values applied (in real mm, Y up as in CAD). */
  dynPoint(pt, anchor) {
    const v = this.dyn.vals;
    if (!anchor || !Object.keys(v).length) return pt;
    const k = Number(this.settings.scale) || 1;
    const toPt = (mm) => (mm / k) * K;
    const lx = ((pt[0] - anchor[0]) / K) * k;
    const ly = (-(pt[1] - anchor[1]) / K) * k;
    if (v.len != null || v.ang != null) {
      const L = v.len ?? Math.hypot(lx, ly);
      const th = ((v.ang != null ? v.ang : (Math.atan2(ly, lx) * 180) / Math.PI) * Math.PI) / 180;
      return [anchor[0] + toPt(L * Math.cos(th)), anchor[1] - toPt(L * Math.sin(th))];
    }
    return [anchor[0] + toPt(v.dx ?? lx), anchor[1] - toPt(v.dy ?? ly)];
  }

  defaultDynField() {
    // length along the cursor direction first; Tab → angle
    return "len";
  }

  dynParse() {
    const d = this.dyn;
    if (!d.active) return;
    const group = d.active === "len" || d.active === "ang" ? ["dx", "dy"] : ["len", "ang"];
    const v = Number(d.text);
    if (d.text === "" || d.text === "-" || d.text === ".") delete d.vals[d.active];
    else if (Number.isFinite(v)) {
      d.vals[d.active] = v;
      for (const g of group) delete d.vals[g]; // cartesian or polar, not mixed
    }
  }

  /** Keys for dynamic input; returns true if the key was used here. */
  dynKey(e) {
    if (!this.dynTool()) return false;
    const d = this.dyn;
    // the comma (including the numeric keypad one) is the decimal separator: 12,5 = 12.5
    const k = e.code === "NumpadDecimal" || e.key === "," ? "." : e.key;
    const has = d.active || Object.keys(d.vals).length;
    if (/^[0-9.\-]$/.test(k)) {
      if (!d.active) {
        d.active = this.defaultDynField();
        d.text = "";
      }
      if (k === "-" && d.text) return true;
      if (k === "." && d.text.includes(".")) return true;
      d.text += k;
      this.dynParse();
      this.dynRefresh();
      return true;
    }
    if (k === "Tab" && !has && this.cycleSnap(e.shiftKey)) return true;
    if (k === "Tab") {
      // Tab switches between length and angle; the typed value stays locked
      d.active = (d.active || this.defaultDynField()) === "len" ? "ang" : "len";
      d.text = d.vals[d.active] != null ? String(d.vals[d.active]) : "";
      this.dynRefresh();
      return true;
    }
    if (k === "Backspace" && has) {
      if (d.text) d.text = d.text.slice(0, -1);
      else if (d.active) delete d.vals[d.active];
      this.dynParse();
      this.dynRefresh();
      return true;
    }
    if ((k === "Enter" || k === " ") && has) {
      const anchor = this.pickAnchor();
      const p = this.dynPoint(this._dynPt || this.lastPt || anchor, anchor);
      this.dynReset();
      if (this.hotGrip) this.applyHotGrip(p);
      else this.toolClick(p);
      this.dynRefresh();
      return true;
    }
    if (k === "Escape" && has) {
      this.dynReset();
      this.dynRefresh();
      return true;
    }
    return false;
  }

  dynRefresh() {
    const anchor = this.pickAnchor();
    if (!anchor || !this._dynPt) {
      this.renderDyn(null, null);
      return;
    }
    const p = this.dynPoint(this._dynPt, anchor);
    if (this.hotGrip) this.previewHotGrip(p, this._dynSn);
    else this.updateOverlay(p, this._dynSn);
    this.showCoords(p, anchor);
    this.renderDyn(p, anchor);
  }

  renderDyn(pt, anchor) {
    const box = $("dynBox");
    if (!box) return;
    // as AutoCAD's dynamic prompt: what the command asks, next to the cursor (F12 turns it off)
    const promptOn = !!(pt && this.dyn.on && this.cmdActive() && !this.cmdAsk);
    const fields = !!(pt && anchor && this.dynTool());
    if (!promptOn && !fields) {
      box.hidden = true;
      this.dynMenu = null;
      return;
    }
    let head = "";
    if (promptOn) {
      const pr = this.currentPrompt();
      if (this.dynMenu && pr.opts.length) {
        const i = Math.min(this.dynMenu.i, pr.opts.length - 1);
        head = `<div class="dmenu">${pr.opts.map((o, j) => `<div class="${j === i ? "on" : ""}">${esc(tr(o.label))} <i>${o.key}</i></div>`).join("")}</div>`;
      } else {
        head = `<div class="dp">${esc(tr(pr.text))}${pr.opts.length ? ` <i>↓ ${pr.opts.map((o) => o.key).join(" ")}</i>` : ""}</div>`;
      }
    }
    if (!fields) {
      box.innerHTML = head;
      this.placeDyn(box, pt);
      return;
    }
    const d = this.dyn;
    const k = Number(this.settings.scale) || 1;
    const sep = this.settings.sep || ",";
    const dx = ((pt[0] - anchor[0]) / K) * k;
    const dy = (-(pt[1] - anchor[1]) / K) * k;
    const live = { dx, dy, len: Math.hypot(dx, dy), ang: ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360 };
    const names = { dx: "X", dy: "Y", len: "L", ang: "∠" };
    const row = ["len", "ang"].map((f) => {
      const on = d.active === f;
      const lock = !on && d.vals[f] != null;
      const txt = on ? d.text.replace(".", sep) : fmtNum(lock ? d.vals[f] : live[f], sep, f === "ang" ? 1 : 2) + (f === "ang" ? "°" : "");
      return `<span class="df${on ? " on" : ""}${lock ? " lock" : ""}"><i>${names[f]}</i><b>${txt}</b></span>`;
    }).join("");
    box.innerHTML = `${head}<div class="drow">${row}</div>`;
    this.placeDyn(box, pt);
  }

  /** Next to the cursor, below the snap / polar label (that one is at +16, +18 and is 20 px tall). */
  placeDyn(box, pt) {
    const [sx, sy] = this.view.toScreen(this._dynPt || pt);
    const vp = $("viewport");
    box.hidden = false;
    const h = box.offsetHeight || 28;
    const w = box.offsetWidth || 190;
    box.style.left = `${Math.max(4, Math.min(sx + 16, vp.clientWidth - w - 4))}px`;
    box.style.top = `${Math.min(sy + 42, vp.clientHeight - h - 4)}px`;
  }

  showCoords(pt, anchor) {
    // from the origin of typed coordinates (UCS or the bottom-left corner), Y up, real mm
    const [ux, uy] = this.doc ? toUser(pt, this.originOf(), this.settings.scale) : [pt[0] / K, pt[1] / K];
    let s = `X ${fmtNum(ux, ",", 2)} · Y ${fmtNum(uy, ",", 2)} mm`;
    if (anchor) {
      const dx = ((pt[0] - anchor[0]) / K) * this.settings.scale;
      const dy = ((pt[1] - anchor[1]) / K) * this.settings.scale;
      s += ` · Δx ${fmtNum(Math.abs(dx), ",", 2)} · Δy ${fmtNum(Math.abs(dy), ",", 2)} · L ${fmtNum(Math.hypot(dx, dy), ",", 2)}`;
    }
    $("stCoords").textContent = s;
  }

  // ------------------------------------------------------------ keyboard
  // ------------------------------------------------------------ keys and the command line
  applyKeyCfg(cfg) {
    this.keyCfg = cfg;
    this.keyMap = directKeyMap(cfg);
    const byId = Object.fromEntries(commandList(cfg).map((c) => [c.id, c]));
    document.querySelectorAll("#railFly [data-tool]").forEach((b) => {
      const c = byId[b.dataset.tool];
      if (!c) return;
      const bits = [c.key, c.aliases[0]].filter(Boolean);
      b.title = `${tr(c.label)}${bits.length ? ` (${[...new Set(bits)].join(" · ")})` : ""}`;
      // flyout row: the alias and the direct key in their own columns
      const al = b.querySelector("i");
      const kb = b.querySelector("kbd");
      if (al) al.textContent = c.aliases[0] || "";
      if (kb) kb.textContent = c.key || "";
    });
    this.slotTitles();
    this.updateCmdPrompt();
    if (this.panel) this.panel.render();
  }

  bindCmdLine() {
    const inp = $("cmdIn");
    const box = $("cmdSug");
    if (!inp) return;
    let list = [];
    let pick = 0;
    let hIdx = -1; // position in the history (-1 = not browsing)
    const showHistory = () => {
      const hist = this.cmdHistory;
      const byId = Object.fromEntries(commandList(this.keyCfg).map((c) => [c.id, c]));
      // as in AutoCAD: most recent at the bottom, next to the command line
      const from = Math.max(0, hIdx - 7);
      const rows = hist.slice(from, from + 8).map((h, k) => ({ ...h, i: from + k })).reverse();
      box.innerHTML = rows.map((h) => {
        const c = byId[h.id];
        return `<div class="cs${h.i === hIdx ? " on" : ""}" data-h="${h.i}"><b class="mono">${h.text}</b><span>${c ? c.label : ""}</span></div>`;
      }).join("");
      box.hidden = !rows.length;
      box.querySelectorAll("[data-h]").forEach((el) => el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const h = hist[Number(el.dataset.h)];
        const c = h && resolveCommand(h.text, this.keyCfg);
        if (c) this.execCmdLine(c);
      }));
    };
    /** Arrow up / down: previously used commands, most recent first. */
    const browse = (dir) => {
      const hist = this.cmdHistory;
      if (!hist.length) return false;
      hIdx = Math.max(-1, Math.min(hist.length - 1, hIdx + dir));
      list = [];
      pick = 0;
      inp.value = hIdx >= 0 ? hist[hIdx].text : "";
      inp.setSelectionRange(inp.value.length, inp.value.length);
      if (hIdx >= 0) showHistory();
      else box.hidden = true;
      return true;
    };
    this._cmdBrowse = browse;
    const show = () => {
      hIdx = -1;
      // a point being typed: no command suggestions
      list = this.cmdAsk || this.selPrompt || (this.cmdActive() && (/^[\s@#<0-9.+\-]/.test(inp.value) || resolveOption(this.currentOptions(), inp.value) || parseOverride(inp.value) || parsePointMod(inp.value))) ? [] : suggest(inp.value, this.keyCfg);
      pick = 0;
      if (!list.length) {
        box.hidden = true;
        return;
      }
      box.innerHTML = list.map((c, i) => `<div class="cs${i === pick ? " on" : ""}" data-i="${i}"><b class="mono">${c.hit || ""}</b><span>${c.label}</span>${c.key ? `<i class="mono">${c.key}</i>` : ""}</div>`).join("");
      box.hidden = false;
      box.querySelectorAll("[data-i]").forEach((el) => el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.execCmdLine(list[Number(el.dataset.i)]);
      }));
    };
    const mark = () => box.querySelectorAll(".cs").forEach((el, i) => el.classList.toggle("on", i === pick));
    this._cmdShow = show;
    inp.addEventListener("input", show);
    inp.addEventListener("focus", () => { if (hIdx < 0) show(); });
    inp.addEventListener("blur", () => setTimeout(() => {
      box.hidden = true;
      hIdx = -1;
    }, 120));
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        inp.value = "";
        inp.blur();
        this.escape();
        return;
      }
      if (e.key === "ArrowDown" && !inp.value.trim() && hIdx < 0 && this.dyn.on && this.currentOptions().length) {
        // during a command with options, ↓ on the empty line opens them next to the cursor
        e.preventDefault();
        inp.blur();
        box.hidden = true;
        this.dynMenu = { i: 0 };
        this.renderDyn(this._dynPt, this.clicks[this.clicks.length - 1]);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // empty line (or already in history): the command history; otherwise, the suggestions
        if (!inp.value.trim() || hIdx >= 0) {
          browse(e.key === "ArrowUp" ? 1 : -1);
          return;
        }
        if (list.length) pick = (pick + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        mark();
        return;
      }
      if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
        e.preventDefault();
        const v = inp.value.trim();
        if (this.selPrompt && e.key !== "Tab") {
          inp.value = "";
          box.hidden = true;
          if (!v) {
            inp.blur();
            this.finishSelPrompt();
          } else if (!this.selPromptOption(v)) dlg.toast(`La „selectează obiectele”: click, fereastră, ALL sau L (nu ${v})`);
          return;
        }
        if (!v && this.cmdAsk && e.key !== "Tab") {
          // nothing typed: the question is dropped, the default stays
          this.cmdAsk = null;
          inp.blur();
          this.updateCmdPrompt();
          return;
        }
        if (!v) {
          inp.blur();
          if (e.key === "Tab") return;
          // during a command: finish it (polyline, series) or stop; otherwise repeat the last one
          if (this.hotGrip) this.cycleHotGrip();
          else if (this.pointMod && this.pointMod.kind === "tk") this.escape(true);
          else if (this.cmdActive() && (this.clicks.length || this.rectStart)) this.escape(true);
          else this.repeatCmd();
          return;
        }
        if (this.cmdAsk && e.key !== "Tab") {
          const ask = this.cmdAsk;
          this.cmdAsk = null;
          this.logCmd(`  ${ask.text}: ${v}`);
          if (ask.onValue(v) === false) dlg.toast(`Valoare nepotrivită: ${v}`);
          inp.value = "";
          box.hidden = true;
          this.updateCmdPrompt();
          if (this.cmdAsk) inp.focus();
          return;
        }
        if (this.cmdActive() && e.key !== "Tab" && this.runOption(v)) {
          inp.value = "";
          box.hidden = true;
          if (!this.cmdAsk) inp.blur();
          return;
        }
        const pmod = this.cmdActive() && e.key !== "Tab" && TOOL_BY_ID[this.tool].kind !== "rect" ? parsePointMod(v) : null;
        if (pmod) {
          this.pointMod = pmod === "tk" ? { kind: "tk", pts: [] } : { kind: pmod };
          this.logCmd(`  ${v.toUpperCase()}`);
          inp.value = "";
          box.hidden = true;
          inp.blur();
          this.updateCmdPrompt();
          return;
        }
        const ov = this.cmdActive() && e.key !== "Tab" ? parseOverride(v) : null;
        if (ov) {
          // END, MID, CEN… for the next pick only (NON: none)
          this.snapOverride = ov;
          this.logCmd(`  ${v.toUpperCase()}`);
          inp.value = "";
          box.hidden = true;
          inp.blur();
          this.updateCmdPrompt();
          return;
        }
        if (this.cmdActive() && e.key !== "Tab" && this.typedPoint(v)) {
          // the line stays open for the next point, as at AutoCAD's prompt
          inp.value = "";
          box.hidden = true;
          return;
        }
        // an exact match wins; otherwise the first suggestion (or the one picked with the arrows)
        const exact = resolveCommand(v, this.keyCfg);
        const chosen = hIdx >= 0 ? exact : pick > 0 && list[pick] ? list[pick] : exact || list[0];
        if (!chosen) {
          dlg.toast(`Comandă necunoscută: ${v.toUpperCase()}`);
          inp.select();
          return;
        }
        this.execCmdLine(chosen);
      }
    });
  }

  /** Starts typing a command (AutoCAD mode) or opens an empty command line. */
  focusCmdLine(ch = "") {
    const inp = $("cmdIn");
    if (!inp || inp.offsetParent === null) return false;
    inp.value = ch;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    if (this._cmdShow) this._cmdShow();
    return true;
  }

  execCmdLine(c) {
    const inp = $("cmdIn");
    // the history keeps what you typed (if it really is an alias of the command), otherwise its alias
    const typed = inp.value.trim().toUpperCase();
    this._typedCmd = c.aliases && c.aliases.includes(typed) ? typed : null;
    inp.value = "";
    inp.blur();
    $("cmdSug").hidden = true;
    this.runCommand(c.id);
  }

  repeatCmd() {
    if (this.lastCmd) this.runCommand(this.lastCmd);
  }

  /** Command history (most recent first), kept in the browser between sessions. */
  get cmdHistory() {
    if (!this._cmdHist) {
      try {
        const h = JSON.parse(localStorage.getItem("drawcad.cmdhist") || "[]");
        this._cmdHist = Array.isArray(h) ? h.filter((x) => x && typeof x.id === "string" && typeof x.text === "string") : [];
      } catch (_) {
        this._cmdHist = [];
      }
    }
    return this._cmdHist;
  }

  recordCmd(id, text) {
    if (!id || id === "select" || id === "pan") return;
    const c = commandList(this.keyCfg).find((x) => x.id === id);
    const t = String(text || (c && c.aliases[0]) || "").toUpperCase();
    this.logCmd(`${t || id} — ${tr(labelOf(id))}`);
    if (!t) return;
    const h = this.cmdHistory.filter((x) => x.text !== t);
    h.unshift({ id, text: t });
    this._cmdHist = h.slice(0, 50);
    try {
      localStorage.setItem("drawcad.cmdhist", JSON.stringify(this._cmdHist));
    } catch (_) { /* storage unavailable */ }
  }

  toggleSnapFlag(fk) {
    const c = this.snapCfg;
    c[fk] = !c[fk];
    if (fk === "ortho" && c.ortho) c.polar = false;
    if (fk === "polar" && c.polar) c.ortho = false;
    if (fk === "on") this.clearAcq();
    this.saveSnapCfg();
    const names = { on: "Snap", ortho: "Ortho", polar: `Polar ${c.polarInc}°`, tracking: "Urmărire" };
    dlg.toast(`${names[fk]}: ${c[fk] ? "pornit" : "oprit"}`, 1500);
  }

  zoomSelection() {
    const boxes = this.selectedAll().map((a) => this.builtOf(a).bbox).filter(Boolean);
    if (!boxes.length) return this.view.fit();
    this.view.zoomToBox([Math.min(...boxes.map((q) => q[0])), Math.min(...boxes.map((q) => q[1])), Math.max(...boxes.map((q) => q[2])), Math.max(...boxes.map((q) => q[3]))]);
  }

  /** A command by id: tool or action (from the command line, a key or a repeat). */
  runCommand(id) {
    const needDoc = () => {
      if (this.doc) return true;
      dlg.toast("Deschide întâi un desen");
      return false;
    };
    if (TOOL_BY_ID[id]) {
      if (!needDoc()) return;
      if (id === "moveSel" || id === "copySel") {
        this.moveCmd(id);
        return;
      }
      this.setTool(id);
      return;
    }
    // during a command only the transparent actions run (zoom, snap toggles), without ending it
    const action = ACTIONS.find((a) => a.id === id);
    const midCmd = this.cmdActive() && (this.clicks.length || this.rectStart || this.placing);
    if (midCmd && action && !action.transparent) {
      dlg.toast(`${tr(action.label)}: nu merge în timpul unei comenzi (Esc întâi)`);
      return;
    }
    const act = {
      erase: () => this.erase(),
      undo: () => this.doUndo(),
      redo: () => this.doRedo(),
      fit: () => this.view.fit(),
      zoomSel: () => this.zoomSelection(),
      find: () => needDoc() && dlg.textDialog(this),
      export: () => needDoc() && dlg.exportDialog(this),
      open: () => $("btnOpen").click(),
      close: () => this.doc && this.closeDoc(),
      settings: () => needDoc() && dlg.settingsDialog(this),
      keys: () => dlg.keysDialog(this),
      osnap: () => this.toggleSnapFlag("on"),
      ortho: () => this.toggleSnapFlag("ortho"),
      polar: () => this.toggleSnapFlag("polar"),
      selAll: () => this.doc && this.selectMany(this.visibleBuilt().map(({ a }) => a.id)),
      nextPage: () => this.doc && this.page < this.doc.pages.length - 1 && this.setPage(this.page + 1),
      prevPage: () => this.doc && this.page > 0 && this.setPage(this.page - 1),
      rotR: () => needDoc() && this.pageOp({ op: "rotate", pages: [this.page], delta: 90 }).catch((e) => dlg.toast(e.message)),
      rotL: () => needDoc() && this.pageOp({ op: "rotate", pages: [this.page], delta: -90 }).catch((e) => dlg.toast(e.message)),
      pages: () => needDoc() && dlg.pagesDialog(this),
    }[id];
    if (!act) return;
    act();
    // a transparent action keeps the command to repeat
    if (id !== "keys" && id !== "settings" && !midCmd) this.lastCmd = id;
    this.recordCmd(id, this._typedCmd);
    this._typedCmd = null;
  }

  bindKeys() {
    window.addEventListener("keydown", (e) => {
      this.frame = (this.frame || 0) + 1;
      if (dlg.isModalOpen()) return;
      // the rail's flyout handles its own keys (arrows, Enter on a row, Esc)
      if (e.target && e.target.closest && e.target.closest("#railFly")) return;
      if (e.key === "F12") {
        // as in AutoCAD: dynamic input on / off
        e.preventDefault();
        this.dyn.on = !this.dyn.on;
        try {
          localStorage.setItem("drawcad.dyn", this.dyn.on ? "1" : "0");
        } catch (_) { /* not remembered */ }
        if (!this.dyn.on) {
          this.dynReset();
          $("dynBox").hidden = true;
        }
        dlg.toast(`Intrare dinamică: ${this.dyn.on ? "pornită" : "oprită"}`, 1500);
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        dlg.historyDialog(this);
        return;
      }
      const fk = { F3: "on", F8: "ortho", F10: "polar", F11: "tracking" }[e.key];
      if (fk) {
        e.preventDefault();
        this.toggleSnapFlag(fk);
        return;
      }
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      // @ # < start a typed point in the command line (AltGr on some layouts sets Ctrl+Alt)
      if (this.cmdActive() && (e.key === "@" || e.key === "#" || e.key === "<") && !e.metaKey && !this.mmenu) {
        e.preventDefault();
        this.focusCmdLine(e.key);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.doRedo();
        else this.doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        this.doRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "s") {
        e.preventDefault();
        if (this.doc) dlg.exportDialog(this);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "f") {
        e.preventDefault();
        if (this.doc) dlg.textDialog(this);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "a") {
        e.preventDefault();
        if (this.doc) this.selectMany(this.visibleBuilt().map(({ a }) => a.id));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "c") {
        if (this.copySelected()) e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "v") {
        e.preventDefault();
        this.paste(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "d") {
        e.preventDefault();
        if (this.copySelected(true)) this.paste(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Tab" && !this.cmdActive() && this.tool === "select" && this.cycleHover()) {
        e.preventDefault();
        return;
      }
      const dynTyped = !!(this.dyn && (this.dyn.active || Object.keys(this.dyn.vals).length));
      if (this.hotGrip && (e.key === " " || e.key === "Enter") && !this.dynMenu && !dynTyped) {
        // as in AutoCAD: Space (or Enter) on a hot grip goes Stretch → Move → Rotate → Scale → Mirror
        e.preventDefault();
        this.cycleHotGrip();
        return;
      }
      // ↓ at the cursor: the options of the prompt (dynamic prompt), ↑ / ↓ move, Enter picks
      if (this.dynMenu && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        const opts = this.currentOptions();
        if (e.key === "Escape" || !opts.length) this.dynMenu = null;
        else if (e.key === "Enter") {
          const o = opts[Math.min(this.dynMenu.i, opts.length - 1)];
          this.dynMenu = null;
          this.runOption(o.key);
        } else this.dynMenu.i = (this.dynMenu.i + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
        this.renderDyn(this._dynPt, this.clicks[this.clicks.length - 1]);
        return;
      }
      if (e.key === "ArrowDown" && this.dyn.on && this.cmdActive() && !this.sel.size && this.currentOptions().length) {
        e.preventDefault();
        this.dynMenu = { i: 0 };
        this.renderDyn(this._dynPt, this.clicks[this.clicks.length - 1]);
        return;
      }
      // during a command, digits go to the length next to the cursor (dynamic input)
      if (this.dyn && this.dynKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Tab" && this.cycleSnap(e.shiftKey)) {
        e.preventDefault();
        return;
      }
      // a point typed without the box (first point, or F12 off): into the command line
      if (this.cmdActive() && !this.mmenu && routeKey({ dynUsable: !!(this.dyn && this.dyn.on && this.dynTool()) }, e.key) === "cmd") {
        e.preventDefault();
        this.focusCmdLine(e.key);
        return;
      }
      const autocad = this.keyCfg && this.keyCfg.mode === "autocad";
      // direct keys: during a command, an option letter of its prompt goes to the command line
      if (!autocad && e.key.length === 1 && /[a-z]/i.test(e.key) && !this.mmenu && (this.currentOptions().some((o) => o.key === e.key.toUpperCase()) || (this.selPrompt && "WCFLPRA".includes(e.key.toUpperCase())))) {
        e.preventDefault();
        this.focusCmdLine(e.key);
        return;
      }
      // AutoCAD mode: letters and digits type the command (Shift+F stays zoom to selection)
      if (autocad && e.key.length === 1 && /[a-z0-9]/i.test(e.key) && !(e.shiftKey && k === "f") && !this.mmenu) {
        e.preventDefault();
        this.focusCmdLine(e.key);
        return;
      }
      if (e.key === " ") {
        if (!this.space) {
          this.spaceAt = Date.now();
          this.spaceDragged = false;
        }
        this.space = true;
        $("canvas").style.cursor = "grab";
        e.preventDefault();
        return;
      }
      if ((e.key === "Enter" || (e.key === " " && autocad)) && this.selPrompt && !this.mmenu) {
        e.preventDefault();
        this.finishSelPrompt();
        return;
      }
      if (e.key === "Enter" && !this.clicks.length && !this.mmenu) {
        // nothing in progress: AutoCAD repeats the last command; in direct-keys mode,
        // Enter opens the command line
        e.preventDefault();
        if (autocad) this.repeatCmd();
        else this.focusCmdLine();
        return;
      }
      if (e.key === "Escape" && this.mmenu) {
        this.closeMarkingMenu();
        return;
      }
      if (e.key === "Escape" || (e.key === "Enter" && this.clicks.length)) {
        this.escape(e.key === "Enter");
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && autocad && !this.sel.size && !this.clicks.length) {
        // as in AutoCAD: arrow up brings the last commands into the command line
        e.preventDefault();
        if (this.focusCmdLine("") && this._cmdBrowse) this._cmdBrowse(e.key === "ArrowUp" ? 1 : -1);
        return;
      }
      if (e.key.startsWith("Arrow") && this.sel.size) {
        // fine nudge: 0.5 mm, with Shift 5 mm
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 0.5) * K;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        this.pushHistory("nudge");
        for (const a of this.selectedAll()) moveAnnot(a, dx, dy);
        this.changed();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        this.deleteSelected();
        e.preventDefault();
        return;
      }
      if (k === "f") {
        // Shift+F: zoom to selection; F: whole page
        if (e.shiftKey) this.zoomSelection();
        else this.view.fit();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        this.view.zoomAt(1.25, this.view.cw / 2, this.view.ch / 2);
        return;
      }
      if (e.key === "-") {
        this.view.zoomAt(0.8, this.view.cw / 2, this.view.ch / 2);
        return;
      }
      if (e.key === "PageDown" && this.doc && this.page < this.doc.pages.length - 1) this.setPage(this.page + 1);
      if (e.key === "PageUp" && this.doc && this.page > 0) this.setPage(this.page - 1);
      const id = !autocad && this.keyMap ? this.keyMap[k] : null;
      if (id && this.doc) this.setTool(id);
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === " ") {
        // AutoCAD mode: Space pressed briefly (no drag) = Enter: finishes or repeats the command
        const tap = this.space && !this.spaceDragged && Date.now() - (this.spaceAt || 0) < 300;
        if (tap && this.keyCfg && this.keyCfg.mode === "autocad" && !dlg.isModalOpen()) {
          const tag = document.activeElement && document.activeElement.tagName;
          if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
            if (this.clicks.length) this.escape(true);
            else this.repeatCmd();
          }
        }
        this.space = false;
        $("canvas").style.cursor = this.tool === "pan" ? "grab" : this.tool === "select" ? "default" : "crosshair";
      }
    });
  }
}

const app = new App();
window.drawcad = app; // for debugging from the console
window.cotare = app; // the old name, used by the e2e tests
app.init();
