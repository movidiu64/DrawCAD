// Keyboard, direct keys and the command line.
// Methods of the editor (App in main.js), mixed into App.prototype.

import { moveAnnot, K } from "../annots.js";
import { parseOverride } from "../osnap.js";
import { TOOL_BY_ID, resolveOption } from "../tools.js";
import { parsePointMod, routeKey } from "../pointin.js";
import * as dlg from "../dialogs.js";
import { directKeyMap, resolveCommand, suggest, commandList, labelOf, ACTIONS } from "../commands.js";
import { tr } from "../i18n.js";
import { $ } from "./util.js";

export class Keyboard {
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
      const ctl = (e.ctrlKey || e.metaKey) && !e.altKey;
      // from the command line too: Ctrl+K searches commands; Ctrl+Z / Ctrl+Y with nothing typed are the
      // drawing's undo / redo, as in AutoCAD (with text typed they stay the field's own)
      if (ctl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        dlg.commandSearch(this);
        return;
      }
      // ? on an empty command line: the shortcut sheet (a command never starts with ?)
      if (e.key === "?" && !inp.value && !ctl) {
        e.preventDefault();
        dlg.shortcutSheet(this);
        return;
      }
      if (ctl && !inp.value && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        if (e.key.toLowerCase() === "z" && !e.shiftKey) this.doUndo();
        else this.doRedo();
        return;
      }
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
      // Ctrl+K: command search (UI-D9), also from the command line; F1: the shortcut sheet (UI-D14)
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        dlg.commandSearch(this);
        return;
      }
      if (e.key === "F1") {
        e.preventDefault();
        dlg.shortcutSheet(this);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        // as AutoCAD's Clean Screen: hide the rail, the context bar and the panel
        e.preventDefault();
        this.toggleMinUI();
        return;
      }
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
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !this.mmenu) {
        e.preventDefault();
        dlg.shortcutSheet(this);
        return;
      }
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
