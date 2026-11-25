// DrawCAD editor: the App object. Its methods are grouped by area in js/app/*.js and mixed in below.
import { View } from "./view.js";
import { Snapper, DEFAULT_MODES } from "./osnap.js";
import { Panel } from "./panel.js";
import { TOOL_BY_ID } from "./tools.js";
import * as dlg from "./dialogs.js";
import { $ } from "./app/util.js";
import { RadialMenu } from "./app/radial.js";
import { Review } from "./app/review.js";
import { SheetItems } from "./app/sheet.js";
import { PointInput } from "./app/input.js";
import { Grips } from "./app/grips.js";
import { Interface } from "./app/ui.js";
import { Documents } from "./app/documents.js";
import { StateHistory } from "./app/state.js";
import { Editing } from "./app/edit.js";
import { Mouse } from "./app/mouse.js";
import { ContextBar } from "./app/contextbar.js";
import { Keyboard } from "./app/keys.js";

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
      this.markStyle = JSON.parse(localStorage.getItem("cotare.mark") || "null") || { color: "hlGreen", w: 6 };
    } catch (_) {
      this.markStyle = { color: "hlGreen", w: 6 };
    }
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
    {
      // every change of selection re-renders the panel: the context bar follows it (UI-D2, UI-D10)
      const render = this.panel.render.bind(this.panel);
      this.panel.render = (...args) => {
        const r = render(...args);
        this.renderCtx();
        return r;
      };
    }
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
}

// the methods of each area, in the order they used to stand in the class
for (const part of [RadialMenu, Review, SheetItems, PointInput, Grips, Interface, Documents, StateHistory, Editing, Mouse, ContextBar, Keyboard]) {
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(part.prototype))) {
    if (name !== "constructor") Object.defineProperty(App.prototype, name, d);
  }
}

const app = new App();
window.drawcad = app; // for debugging from the console
window.cotare = app; // the old name, used by the e2e tests
app.init();
