// Several documents open as tabs in the header (UI-D4a).
// Methods of the editor (App in main.js), mixed into App.prototype.
//
// The editor still holds one document at a time: a tab is a document kept open beside it. Switching
// saves the current one (its state is on the server anyway), keeps what only lives in the browser
// (undo / redo, page, zoom, unexported changes) and loads the other one. The list of tabs is kept in
// the browser, so it survives a reload.

import * as dlg from "../dialogs.js";
import { esc, $ } from "./util.js";

const KEY = "drawcad.tabs";
export const MAX_TABS = 8;

/** The tab list after opening `doc` from `cur`: added right after the current tab, at most MAX_TABS
 *  (the oldest tabs other than these two go first). Pure, for the tests. */
export function withTab(tabs, doc, cur) {
  const it = { id: doc.id, name: doc.name, kind: doc.kind };
  const i = tabs.findIndex((t) => t.id === doc.id);
  if (i >= 0) return tabs.map((t, k) => (k === i ? it : t));
  const at = tabs.findIndex((t) => t.id === cur);
  const out = [...tabs];
  out.splice(at >= 0 ? at + 1 : out.length, 0, it);
  while (out.length > MAX_TABS) {
    const drop = out.findIndex((t) => t.id !== doc.id && t.id !== cur);
    out.splice(drop, 1);
  }
  return out;
}

/** The tab to show after closing `id`: the one to its right, else to its left, else none. */
export function nextAfterClose(tabs, id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return null;
  return (tabs[i + 1] || tabs[i - 1] || null)?.id || null;
}

export class DocTabs {
  get tabs() {
    if (!this._tabs) {
      try {
        const v = JSON.parse(localStorage.getItem(KEY) || "[]");
        this._tabs = Array.isArray(v) ? v.filter((t) => t && /^[a-f0-9]{32}$/.test(t.id)).slice(0, MAX_TABS) : [];
      } catch (_) {
        this._tabs = [];
      }
    }
    return this._tabs;
  }

  set tabs(v) {
    this._tabs = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch (_) { /* storage unavailable */ }
  }

  /** Called by setDoc before it replaces the open document: what lives only in the browser is kept
   *  for when its tab is shown again, and its state is saved now. */
  leaveDoc(nextId) {
    if (!this.doc || this.doc.id === nextId) return;
    this._sessions = this._sessions || new Map();
    const v = this.view;
    this._sessions.set(this.doc.id, {
      undo: this.undo, redo: this.redo, page: this.page, unexported: this.unexported, revPending: this.revPending,
      view: { zoom: v.zoom, panX: v.panX, panY: v.panY },
    });
    this.flushSave(); // the state is read now, before the next document replaces it
  }

  /** Called by setDoc once the document is shown: its tab, and what was kept from the last visit. */
  enterDoc(meta) {
    this.tabs = withTab(this.tabs, meta, this._tabFrom || null);
    this._tabFrom = null;
    const s = this._sessions && this._sessions.get(meta.id);
    if (s) {
      this._sessions.delete(meta.id);
      this.undo = s.undo;
      this.redo = s.redo;
      this.unexported = s.unexported;
      this.revPending = s.revPending;
      if (s.page && s.page < meta.pages.length) this.setPage(s.page);
      Object.assign(this.view, s.view);
      if (this.view.afterZoom) this.view.afterZoom();
      this.updateButtons();
    }
    this.renderDocTabs();
  }

  /** Shows the document of another tab. */
  async switchDoc(id) {
    if (!id || (this.doc && this.doc.id === id)) return;
    this._tabFrom = this.doc && this.doc.id;
    await this.loadDoc(id);
    // a document that no longer exists (deleted, expired): its tab goes
    if (!this.doc || this.doc.id !== id) {
      this.tabs = this.tabs.filter((t) => t.id !== id);
      this.renderDocTabs();
    }
  }

  /** Closes a tab that is not the current one: its work stays on the server (Recent). */
  closeTab(id) {
    if (this.doc && this.doc.id === id) return this.closeDoc();
    const s = this._sessions && this._sessions.get(id);
    if (s && s.unexported) dlg.toast("Lucrul rămâne pe server; îl redeschizi din Recente.");
    if (this._sessions) this._sessions.delete(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.renderDocTabs();
  }

  /** After the current document closed: the neighbouring tab, if any. → true when one is shown. */
  afterClose(id) {
    const next = nextAfterClose(this.tabs, id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this._sessions) this._sessions.delete(id);
    this.renderDocTabs();
    if (!next) return false;
    this.switchDoc(next);
    return true;
  }

  /** A document deleted from the server (Recent): its tab goes too. */
  forgetTab(id) {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.renderDocTabs();
  }

  /** The other open documents as tabs on both sides of the current one's chip, and "+". */
  renderDocTabs() {
    const box = $("docTabs");
    if (!box) return;
    const chip = box.querySelector(".docchip");
    box.querySelectorAll(".doctab, .tabadd, .tabmorew").forEach((e) => e.remove());
    const cur = this.doc && this.doc.id;
    const ico = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>`;
    const tab = (t) => `<div class="doctab"><button class="tb" data-tab="${t.id}" title="${esc(t.name)}">${ico}<span translate="no">${esc(t.name)}</span></button><button class="icon tx" data-tabclose="${t.id}" title="Închide fila" aria-label="Închide ${esc(t.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
    const i = this.tabs.findIndex((t) => t.id === cur);
    const before = i >= 0 ? this.tabs.slice(0, i) : [];
    const after = i >= 0 ? this.tabs.slice(i + 1) : this.tabs;
    // little room (narrow window, many tabs): the other documents behind one button, in a menu
    const more = after.length + before.length ? `<div class="split tabmorew"><button class="tabmore" aria-haspopup="menu" aria-expanded="false" title="Celelalte documente deschise">${ico}<span class="mono">${before.length + after.length}</span><svg class="dd" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="xmenu tabmenu" role="menu" hidden>${[...before, ...after].map((t) => `<div class="tmrow"><button role="menuitem" data-tab="${t.id}"><b translate="no">${esc(t.name)}</b><span>${esc({ image: "imagine", dxf: "DXF", dwg: "DWG" }[t.kind] || "PDF")}</span></button><button class="icon tx" data-tabclose="${t.id}" title="Închide fila" aria-label="Închide ${esc(t.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")}</div></div>` : "";
    const add = cur ? `<button class="icon tabadd" title="Deschide alt document într-o filă nouă" aria-label="Deschide alt document"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>` : "";
    chip.insertAdjacentHTML("beforebegin", before.map(tab).join(""));
    chip.insertAdjacentHTML("afterend", after.map(tab).join("") + more + add);
    const plus = box.querySelector(".tabadd");
    if (plus) plus.addEventListener("click", () => dlg.openDialog(this));
    box.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => this.switchDoc(b.dataset.tab)));
    box.querySelectorAll("[data-tabclose]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(b.dataset.tabclose);
    }));
    box.classList.toggle("multi", this.tabs.length > 1);
    const menu = box.querySelector(".tabmenu");
    const mbtn = box.querySelector(".tabmore");
    if (menu) {
      const open = (v) => {
        menu.hidden = !v;
        mbtn.setAttribute("aria-expanded", String(v));
        if (v) menu.querySelector("[data-tab]").focus();
      };
      mbtn.addEventListener("click", () => open(menu.hidden));
      menu.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          open(false);
          mbtn.focus();
        }
      });
      if (!this._tabMenuOff) {
        this._tabMenuOff = true;
        document.addEventListener("pointerdown", (e) => {
          const m = document.querySelector("#docTabs .tabmenu");
          if (m && !m.hidden && !e.target.closest(".tabmorew")) {
            m.hidden = true;
            document.querySelector("#docTabs .tabmore").setAttribute("aria-expanded", "false");
          }
        });
      }
    }
    this.fitDocTabs();
    if (!this._tabsHdrRO && window.ResizeObserver) {
      this._tabsHdrRO = new ResizeObserver(() => this.fitDocTabs());
      this._tabsHdrRO.observe(box.parentElement);
    }
  }

  /** The other tabs inline while each keeps a readable name, otherwise behind the "N ▾" button. */
  fitDocTabs() {
    const box = $("docTabs");
    if (!box) return;
    box.classList.remove("crowd");
    const names = [...box.querySelectorAll(".doctab .tb span")];
    const cramped = names.some((n) => n.scrollWidth > n.clientWidth && n.clientWidth < 72);
    const cut = box.scrollWidth > box.clientWidth + 1;
    box.classList.toggle("crowd", cramped || cut);
  }
}
