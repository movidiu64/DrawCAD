// Interface: tool rail, panels, status bar, snap menu and the other controls around the canvas.
// Methods of the editor (App in main.js), mixed into App.prototype.

import * as api from "../api.js";
import { fmtNum } from "../annots.js";
import { TOOL_BY_ID, FAMILIES, FAMILY_OF } from "../tools.js";
import * as dlg from "../dialogs.js";
import { commandList } from "../commands.js";
import { lang as uiLang, tr } from "../i18n.js";
import { useThemeColors } from "../view.js";
import { $ } from "./util.js";

export class Interface {
  // ------------------------------------------------------------ interface
  /** The rail's own settings, for all documents: labels under the icons, families shown. */
  railCfg() {
    let c = {};
    try {
      c = JSON.parse(localStorage.getItem("cotare.rail") || "{}") || {};
    } catch (_) { /* default */ }
    return { labels: c.labels !== false, hover: c.hover !== false, hidden: Array.isArray(c.hidden) ? c.hidden : [], last: c.last && typeof c.last === "object" ? c.last : {} };
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
  /** Theme (V13-8): "dark" (default), "light" or "system" (follows the operating system), kept in
   *  this browser. The CSS tokens switch with data-theme on <html>, the canvas colors with them. */
  themePref() {
    try {
      const v = localStorage.getItem("drawcad.theme");
      return v === "light" || v === "system" ? v : "dark";
    } catch (_) {
      return "dark";
    }
  }

  applyTheme(pref = null) {
    if (pref) {
      try {
        localStorage.setItem("drawcad.theme", pref);
      } catch (_) { /* storage unavailable */ }
    }
    const p = pref || this.themePref();
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
    const light = p === "light" || (p === "system" && !!(mq && mq.matches));
    document.documentElement.dataset.theme = light ? "light" : "dark";
    useThemeColors(light);
    if (mq && !this._themeWatch) {
      this._themeWatch = true;
      mq.addEventListener("change", () => {
        if (this.themePref() === "system") this.applyTheme();
      });
    }
    if (this.view) this.view.redraw();
    if (this.panel && this.doc) this.panel.render();
  }

  buildToolbar() {
    const cfg = this.railCfg();
    const nav = $("tools");
    nav.classList.toggle("compact", !cfg.labels);
    const fams = FAMILIES.filter((f) => !cfg.hidden.includes(f.id));
    nav.innerHTML = fams.map((f, i) => {
      const t = TOOL_BY_ID[this.familyTool(f, cfg)];
      return `${f.sep && i ? '<div class="rsep" aria-hidden="true"></div>' : ""}<button class="slot${f.tools.length > 1 ? " fly" : ""}" data-fam="${f.id}" aria-label="${f.label}"${f.tools.length > 1 ? ' aria-haspopup="menu" aria-expanded="false"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.icon}"/></svg><span>${f.label}</span></button>`;
    }).join("") + `<div class="rsep" aria-hidden="true"></div><button class="slot" id="railSearch" aria-label="Caută o comandă (Ctrl+K)" title="Caută o comandă (Ctrl+K)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M15.2 15.2L20 20"/></svg><span>Caută</span></button>`;
    nav.querySelector("#railSearch").addEventListener("click", (e) => {
      if (e.detail > 0) e.currentTarget.blur();
      dlg.commandSearch(this);
    });
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
      b.addEventListener("click", (e) => {
        // one click: the family's tool runs AND its list opens next to the slot; moving on to the
        // drawing closes the list, so the tool is ready for the first point (a second click closes it)
        const open = !$("railFly").hidden && this.flyFam === f.id;
        const id = this.familyTool(f);
        if (this.tool !== id) this.setTool(id);
        if (f.tools.length < 2 || open) this.hideFlyout();
        else this.toggleFlyout(f.id, true, e.detail === 0);
        // a mouse click leaves no focus on the slot: Space and Enter belong to the command line
        if (e.detail > 0) b.blur();
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (f.tools.length > 1) this.toggleFlyout(f.id, true);
      });
      // hover with intent (UI-D1c): resting on a slot opens its list without changing the tool; with a
      // list already open, moving along the rail switches it at once, as a menu bar does
      b.addEventListener("pointerenter", (e) => {
        if (e.pointerType !== "mouse" || !this.railCfg().hover) return;
        clearTimeout(this.flyTimer);
        if (f.tools.length < 2) {
          if (!$("railFly").hidden) this.flyTimer = setTimeout(() => this.hideFlyout(), 300);
          return;
        }
        if (!$("railFly").hidden) {
          if (this.flyFam !== f.id) this.toggleFlyout(f.id, true, false);
          return;
        }
        this.flyTimer = setTimeout(() => this.toggleFlyout(f.id, true, false), 400);
      });
      b.addEventListener("pointerleave", () => {
        if ($("railFly").hidden) clearTimeout(this.flyTimer);
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
    // on the drawing the list closes, after a short grace in case the pointer only slipped out
    $("viewport").addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse" || $("railFly").hidden) return;
      clearTimeout(this.flyTimer);
      this.flyTimer = setTimeout(() => this.hideFlyout(), 250);
    });
    fly.addEventListener("pointerenter", () => clearTimeout(this.flyTimer));
    this.markRail();
    if (this.keyCfg) this.applyKeyCfg(this.keyCfg);
  }

  /** Opens (or closes) a family's flyout next to its slot. */
  toggleFlyout(fam, open, focus = true) {
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
    fly.style.left = `${$("tools").offsetWidth}px`; // touching the rail: the pointer goes from slot to list without crossing the drawing
    fly.style.top = `${Math.max(4, Math.min(r.top - body.top - 6, body.height - h - 4))}px`;
    // the keyboard goes into the list only when it was opened from the keyboard or by a right click:
    // after a mouse click, typed commands keep going to the command line
    const cur = fly.querySelector(`[data-fly="${fam}"] .frow.on`) || fly.querySelector(`[data-fly="${fam}"] .frow`);
    if (cur && focus) cur.focus({ preventScroll: true });
  }

  hideFlyout() {
    clearTimeout(this.flyTimer);
    const fly = $("railFly");
    if (!fly || fly.hidden) return;
    // keys go back to the drawing (a focused row would keep them)
    if (fly.contains(document.activeElement)) document.activeElement.blur();
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
      const t = `${tr(f.label)} — ${tr(c.label)}${bits.length ? ` (${[...new Set(bits)].join(" · ")})` : ""}`;
      // with lists on hover, the browser's tooltip would land on the list: the list shows the same
      if (cfg.hover && f.tools.length > 1) {
        b.removeAttribute("title");
        b.setAttribute("aria-description", t);
      } else b.title = t;
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
    // Export ▾: PDF or DXF chosen before the dialog opens (UI-D4)
    const xmenu = $("exportMenu");
    const xopen = (open) => {
      xmenu.hidden = !open;
      $("btnExportMenu").setAttribute("aria-expanded", String(open));
      if (open) xmenu.querySelector("button").focus();
    };
    $("btnExportMenu").addEventListener("click", () => this.doc && xopen(xmenu.hidden));
    xmenu.querySelectorAll("[data-xfmt]").forEach((b) => b.addEventListener("click", () => {
      xopen(false);
      if (!this.doc) return;
      dlg.exportDialog(this);
      const f = document.querySelector(`#dialog [data-fmt="${b.dataset.xfmt}"]`);
      if (f && !f.classList.contains("on")) f.click();
    }));
    xmenu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        xopen(false);
        $("btnExportMenu").focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!xmenu.hidden && !e.target.closest(".split")) xopen(false);
    });
    $("btnMin").addEventListener("click", () => this.toggleMinUI());
    // phone: Redo, Open, Settings and Keys behind "⋯" (UI-D16)
    const more = $("moreMenu");
    const mopen = (open) => {
      more.hidden = !open;
      $("btnMore").setAttribute("aria-expanded", String(open));
      if (open) more.querySelector("button").focus();
    };
    $("btnMore").addEventListener("click", () => mopen(more.hidden));
    more.querySelectorAll("[data-more]").forEach((b) => b.addEventListener("click", () => {
      mopen(false);
      const k = b.dataset.more;
      if (k === "redo") this.doRedo();
      else if (k === "open") $("btnOpen").click();
      else if (k === "settings") $("btnSettings").click();
      else if (k === "keys") dlg.keysDialog(this);
    }));
    more.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        mopen(false);
        $("btnMore").focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!more.hidden && !e.target.closest(".more")) mopen(false);
    });
    $("btnKeys2").addEventListener("click", () => dlg.keysDialog(this));
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
    // Ctrl+V with an image copied (screenshot, logo): it goes on the drawing at the cursor
    document.addEventListener("paste", (e) => {
      if (!this.doc || dlg.isModalOpen()) return;
      const el = e.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((it) => it.kind === "file" && /^image\/(png|jpeg|webp)$/.test(it.type));
      if (!item) return;
      e.preventDefault();
      this.pasteImage(item.getAsFile());
    });
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

  /** Minimize UI (UI-D17): the rail, the context bar and the panel go; the command line and status stay. */
  toggleMinUI(on) {
    const app = $("app");
    const v = on ?? !app.classList.contains("minui");
    app.classList.toggle("minui", v);
    $("btnMin").setAttribute("aria-pressed", String(v));
    this.hideFlyout();
    requestAnimationFrame(() => this.view.resize && this.view.resize());
  }

  updateButtons() {
    const has = !!this.doc;
    $("app").classList.toggle("nodoc", !has);
    $("btnExportMenu").disabled = !has;
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
    this.hintText = txt || "";
    const ch = $("ctxHint");
    if (ch) {
      ch.textContent = txt || "";
      ch.title = txt || "";
    }
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
    // an action in a family's list (Compare revisions): it opens its window, the active tool stays
    if (TOOL_BY_ID[id].kind === "action") {
      if (id === "compare" && this.doc) dlg.compareDialog(this);
      return;
    }
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
    if (id === "image" && this.doc) this.startImageTool();
    else if (id !== "image") this.pendingImage = null;
    if (id === "tblock" && this.doc && !this.tblockTpl) this.openTblockLibrary(true);
    if (id === "stamp" && this.doc) dlg.stampDialog(this);
    if (id === "offset" && this.doc) this.askOffsetDist();
  }
}
