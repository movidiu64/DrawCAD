// The properties panel on the right.
import { typeName, newId, fmtNum, parseNum, build, derive, K, SCALABLE, SCALE_MIN, SCALE_MAX } from "./annots.js";
import { LTYPES, LTYPE_BY_ID, WIDTHS, PRESETS, resizeShape } from "./shapes.js";
import { fmtDev } from "./iso286.js";
import { GDT_SYMBOLS, GDT_BY_ID, MODIFIERS, symbolPrims, diaAllowed } from "./gdt.js";
import { drawPrims, COLORS } from "./view.js";
import { TOOL_BY_ID, DRAW_TOOLS } from "./tools.js";
import { commandList, keyConfig } from "./commands.js";
import { tr } from "./i18n.js";
import { pagesDialog as dlgPages } from "./dialogs.js";

const ORIG_EDIT = new Set(["white", "redact", "ink"]); // changes to the original, no layer
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ISO_DISP = [
  ["code", "Doar simbol"],
  ["codeDev", "Simbol + (abateri)"],
  ["codeLim", "Simbol + (dimensiuni limită)"],
  ["dev", "Doar abateri"],
];

// panel sections that start collapsed (secondary; UI-D13): size and layer of the selection
const CLOSED_BY_DEFAULT = ["Mărime", "Strat"];

export class Panel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.tabs = document.getElementById("ptabs");
    try {
      this.tab = localStorage.getItem("cotare.ptab") || "props";
    } catch (_) {
      this.tab = "props";
    }
    try {
      const v = JSON.parse(localStorage.getItem("cotare.secs") || "null");
      this.secs = v && typeof v === "object" ? v : {};
    } catch (_) {
      this.secs = {};
    }
    this.filter = { q: "", kind: "all" };
    if (this.tabs) {
      this.tabs.querySelectorAll("[data-ptab]").forEach((b) => b.addEventListener("click", () => this.setTab(b.dataset.ptab)));
    }
  }

  /** The panel's tabs (UI-D3): Properties, Layers, Annotations; the choice is remembered. */
  setTab(tab) {
    this.tab = tab;
    try {
      localStorage.setItem("cotare.ptab", tab);
    } catch (_) { /* not remembered */ }
    this.render();
  }

  render() {
    const a = this.app.selected();
    if (this.tabs) this.tabs.hidden = !this.app.doc;
    if (!this.app.doc) {
      this.el.innerHTML = this.introHtml();
      return;
    }
    // a new selection shows its properties
    const selKey = [...this.app.sel].join(",");
    if (selKey && selKey !== this._selKey) this.tab = "props";
    this._selKey = selKey;
    this.markTabs();
    if (this.tab === "layers") {
      this.el.innerHTML = this.layersHtml();
      this.bind();
    } else if (this.tab === "list") {
      this.el.innerHTML = this.listTabHtml();
      this.bind();
      this.bindList();
    } else if (!a) {
      this.el.innerHTML = this.noSelHtml();
      this.bind();
    } else if (this.app.sel.size > 1) {
      this.el.innerHTML = this.groupHtml();
      this.bindGroup();
    } else {
      const fn = this[`html_${a.type}`];
      this.el.innerHTML = this.headHtml(a) + (fn ? fn.call(this, a) : "") + this.footHtml(a);
      this.bind();
      this.drawPreview(a);
    }
    this.collapsible();
  }

  markTabs() {
    if (!this.tabs) return;
    const n = this.app.annots.filter((x) => x.page === this.app.page).length;
    this.tabs.querySelectorAll("[data-ptab]").forEach((b) => {
      const on = b.dataset.ptab === this.tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    const c = this.tabs.querySelector("#ptabN");
    if (c) c.textContent = String(n);
  }

  /** Section headings open and close their section; the state is remembered per heading (UI-D13). */
  collapsible() {
    const secs = [...this.el.children].filter((c) => c.classList.contains("sec"));
    secs.forEach((sec, i) => {
      const h = [...sec.children].find((c) => c.classList.contains("h"));
      if (!h || i === 0 || sec.children.length < 2) return;
      const key = h.textContent.replace(/[\d·()]+/g, " ").replace(/\s+/g, " ").trim();
      const closed = this.secs[key] ?? CLOSED_BY_DEFAULT.includes(key);
      sec.classList.add("col");
      sec.classList.toggle("closed", closed);
      h.setAttribute("role", "button");
      h.setAttribute("tabindex", "0");
      h.setAttribute("aria-expanded", String(!closed));
      const toggle = () => {
        const now = !sec.classList.contains("closed");
        sec.classList.toggle("closed", now);
        h.setAttribute("aria-expanded", String(!now));
        this.secs[key] = now;
        try {
          localStorage.setItem("cotare.secs", JSON.stringify(this.secs));
        } catch (_) { /* not remembered */ }
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation(); // not a command repeat
          toggle();
        }
      });
    });
  }

  /** Properties with nothing selected: what to do, and the drawing style of a drawing tool. */
  noSelHtml() {
    const app = this.app;
    const tool = TOOL_BY_ID[app.tool];
    return `<div class="sec"><div class="h">Nicio selecție</div>
        <div class="sub">Click pe o adnotare din desen (sau din tab-ul Adnotări) ca să-i vezi proprietățile. Un dreptunghi pe zonă goală selectează mai multe.</div></div>
      ${tool && DRAW_TOOLS.has(tool.id) && tool.id !== "cross" && tool.id !== "hatch" ? this.styleHtml(app.drawStyle, "tool") : ""}`;
  }

  /** The Annotations tab: a filter, chips by kind and the whole list. */
  listTabHtml() {
    const app = this.app;
    const all = app.annots.filter((a) => a.page === app.page);
    const kinds = [["all", "Toate", () => true], ["dims", "Cote", (a) => ["dim", "rad", "ang", "ord", "chamfer"].includes(a.type)], ["tol", "Toleranțe", (a) => ["gdt", "rough", "datum"].includes(a.type)], ["rev", "Revizii", (a) => a.layer === "rev" || ["strike", "revtab"].includes(a.type)], ["text", "Text", (a) => ["text", "note", "lead", "balloon"].includes(a.type)]];
    const f = this.filter;
    const kind = kinds.find((k) => k[0] === f.kind) || kinds[0];
    const q = f.q.trim().toLowerCase();
    const list = all.filter((a) => kind[2](a) && (!q || `${tr(typeName(a))} ${app.annotLabel(a)}`.toLowerCase().includes(q)));
    return `<div class="sec">
        <input type="search" id="annQ" placeholder="Filtrează: tip sau valoare" aria-label="Filtrează adnotările" value="${esc(f.q)}">
        <div class="chips">${kinds.map(([k, l, fn]) => `<button data-kind="${k}" class="${f.kind === k ? "on" : ""}" aria-pressed="${f.kind === k}">${l} <span class="num">${all.filter(fn).length}</span></button>`).join("")}</div>
      </div>
      ${this.annListHtml(list)}`;
  }

  bindList() {
    const q = this.el.querySelector("#annQ");
    if (q) {
      q.addEventListener("input", () => {
        this.filter.q = q.value;
        const pos = q.selectionStart;
        this.render();
        const q2 = this.el.querySelector("#annQ");
        if (q2) {
          q2.focus();
          q2.setSelectionRange(pos, pos);
        }
      });
    }
    this.el.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
      this.filter.kind = b.dataset.kind;
      this.render();
    }));
  }

  // -------------------------------------------------------------- multiple selection
  groupHtml() {
    const list = this.app.selectedAll();
    const counts = {};
    for (const a of list) counts[typeName(a)] = (counts[typeName(a)] || 0) + 1;
    const summary = Object.entries(counts).map(([t, n]) => `${esc(t)}: ${n}`).join(" · ");
    const scalable = list.filter((a) => SCALABLE.has(a.type));
    const layered = list.filter((a) => !ORIG_EDIT.has(a.type));
    const allRev = layered.length && layered.every((a) => a.layer === "rev");
    const allAdd = layered.length && layered.every((a) => a.layer !== "rev");
    return `<div class="sec"><div class="h">Selecție multiplă</div><div class="title">${list.length} adnotări</div><div class="sub">${summary}</div></div>
      ${scalable.length ? `<div class="sec"><div class="h">Mărime (${scalable.length} adnotări)</div>
        <div class="row"><button class="ghost" data-g="step" data-v="-0.1" style="width:40px;padding:0" aria-label="Micșorează toate">−</button>
        <button class="ghost" data-g="step" data-v="0.1" style="width:40px;padding:0" aria-label="Mărește toate">+</button></div>
        <div class="pills">${[0.5, 0.7, 0.85, 1, 1.2, 1.5, 2].map((v) => `<button data-g="scale" data-v="${v}">${Math.round(v * 100)}%</button>`).join("")}</div></div>` : ""}
      ${layered.length ? `<div class="sec"><div class="h">Strat</div><div class="seg">
        <button data-g="layer" data-v="add" class="${allAdd ? "on" : ""}">Adăugat</button>
        <button data-g="layer" data-v="rev" class="${allRev ? "on" : ""}">Revizie</button></div></div>` : ""}
      <div class="sec"><div class="btns">
        <button class="ghost" data-g="copy">Copiază</button><button class="ghost" data-g="dup">Duplică</button>
        <button class="danger" data-g="del">Șterge ${list.length}</button></div>
      <div class="note">Trage de oricare dintre ele pentru a muta grupul · săgețile mută cu 0,5 mm (Shift: 5 mm) · Shift+click adaugă sau scoate din selecție · Esc renunță.</div></div>`;
  }

  bindGroup() {
    const app = this.app;
    this.el.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.v;
      switch (b.dataset.g) {
        case "step":
          app.updateMany((a) => {
            if (SCALABLE.has(a.type)) a.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(((a.scale || 1) + Number(v)) * 100) / 100));
          });
          break;
        case "scale":
          app.updateMany((a) => {
            if (SCALABLE.has(a.type)) a.scale = Number(v);
          });
          break;
        case "layer":
          app.updateMany((a) => {
            if (!ORIG_EDIT.has(a.type)) a.layer = v;
          });
          break;
        case "copy":
          app.copySelected();
          break;
        case "dup":
          if (app.copySelected(true)) app.paste(true);
          return;
        case "del":
          app.deleteSelected();
          return;
        default:
          break;
      }
      this.render();
    }));
  }

  // -------------------------------------------------------------- no selection
  introHtml() {
    return `<div class="sec"><div class="title">Bine ai venit</div>
      <div class="note">Deschide un PDF exportat din CAD sau o imagine scanată. Originalul nu se modifică: cotele, toleranțele și ștergerile se păstrează separat și se aplică la export.</div></div>
      ${this.keysHtml()}`;
  }

  keysHtml() {
    const cfg = (this.app && this.app.keyCfg) || keyConfig();
    const ac = cfg.mode === "autocad";
    const items = commandList(cfg).filter((c) => c.kind === "tool" && (ac ? c.aliases.length : c.key));
    const list = items.map((c) => `<b>${ac ? c.aliases[0] : c.key}</b> ${tr(c.label).toLowerCase()}`).join(" · ");
    return `<div class="sec"><div class="h">Taste${ac ? " · comenzi AutoCAD" : ""}</div><div class="keys">
      ${list}<br>
      ${ac ? "comanda + <b>Spațiu</b> / <b>Enter</b> · Spațiu sau Enter singur <b>repetă</b> · <b>U</b> anulează · <b>Z</b> potrivește · <b>E</b> cu selecție șterge" : "<b>Enter</b> linie de comandă (L, C, DLI…) · <b>Enter</b> termină polilinia"} · <b>ALIASEDIT</b> sau Setări → Taste și comenzi<br>
      <b>Shift</b> ortho · <b>Alt</b> fără snap · <b>Esc</b> renunță · <b>Del</b> șterge selecția<br>
      <b>Ctrl+C / Ctrl+V</b> copiază / lipește la cursor · <b>Ctrl+D</b> duplică · <b>Ctrl+A</b> selectează tot · <b>Ctrl+F</b> caută text / OCR<br>
      <b>Shift+click</b> sau dreptunghi pe zonă goală = selecție multiplă · <b>săgeți</b> mută 0,5 mm<br>
      <b>Ctrl+Z / Ctrl+Y</b> anulează / refă · <b>F</b> potrivește · <b>Shift+F</b> zoom pe selecție · <b>dublu-click</b> editează · rotița = zoom · Space+tragere = mută</div></div>`;
  }

  layersHtml() {
    const app = this.app;
    const d = app.doc;
    const S = app.settings;
    const counts = { add: 0, rev: 0, del: 0 };
    for (const a of app.annots) {
      if (ORIG_EDIT.has(a.type)) counts.del++;
      else if (a.layer === "rev") counts.rev++;
      else counts.add++;
    }
    const pg = d.pages[app.page];
    return `<div class="sec"><div class="h">Document</div>
        <div class="title" style="word-break:break-all">${esc(d.name)}</div>
        <div class="sub">${d.kind === "image" ? `imagine · ${Math.round(d.dpi || 0)} DPI` : "PDF"} · ${d.pages.length} pagini · pagina ${app.page + 1}: ${fmtNum(pg.w / K, ",", 1)} × ${fmtNum(pg.h / K, ",", 1)} mm${pg.rot ? ` · rotită ${pg.rot}°` : ""}</div>
        ${d.kind === "pdf" && pg.paths === 0 ? `<div class="note warn">Pagina nu are geometrie vectorială (probabil scan). Snap-ul pe desen nu e disponibil; ștergerea se face doar prin acoperire.</div>` : ""}
        ${Math.max(pg.w, pg.h) / K > 900 && (d.kind === "image" || pg.paths === 0) ? `<div class="note warn">Foaia are ${fmtNum(pg.w / K, ",", 0)} × ${fmtNum(pg.h / K, ",", 0)} mm (imaginea are probabil DPI greșit), așa că cotele și textele par mici. Alege mărimea reală a foii (A3, A4…).
          <div style="margin-top:6px"><button class="ghost" data-act="pages">Mărimea foii…</button></div></div>` : ""}
        ${d.fromExport ? `<div class="note">Deschis dintr-un export anterior: cotele sunt editabile, originalul a fost recuperat din fișier.</div>` : ""}
      </div>
      <div class="sec"><div class="h">Scara desenului</div>
        <div class="row"><div class="field"><label for="dScale">mm reali / mm hârtie</label><input type="text" class="mono" id="dScale" value="${fmtNum(S.scale, ",", 4)}"></div>
        <button class="ghost" data-act="calib" style="align-self:flex-end">Calibrează</button></div>
        <div class="sub">1 = scara 1:1 · 2 = scara 1:2 · 0,5 = scara 2:1</div>
      </div>
      <div class="sec"><div class="h">Straturi</div>
        ${[["orig", "background:var(--layer-orig)", "Original PDF", "neatins"], ["add", "background:var(--layer-add)", "Adăugate", counts.add], ["rev", "background:var(--layer-rev)", "Revizii", counts.rev], ["del", "border:1px dashed var(--layer-del)", "Ștergeri / acoperiri", counts.del]]
          .map(([k, st, name, n]) => {
            const off = app.hidden.has(k);
            return `<div class="layer ${off ? "off" : ""}"><i style="${st}"></i><span style="flex:1">${name}</span><span class="${k === "orig" ? "sub" : "mono sub"}">${n}</span>
              <button class="icon eye" data-act="layervis" data-v="${k}" aria-pressed="${!off}" aria-label="${off ? "Arată" : "Ascunde"} ${name}" title="${off ? "Arată" : "Ascunde"} pe ecran">
              <svg viewBox="0 0 24 24">${off ? '<path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.6 3.2M6.6 6.6C4.3 8.1 3 12 3 12s4 6 9 6a8.8 8.8 0 0 0 4.4-1.2"/>' : '<path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/>'}</svg></button></div>`;
          }).join("")}
        ${app.hidden.size ? `<div class="sub">Ascunderea e doar pe ecran: exportul conține toate straturile.</div>` : ""}
      </div>
      ${this.inkHtml()}`;
  }

  /** List of annotations on the page: click = select and center, bin = delete. */
  annListHtml(list) {
    const app = this.app;
    if (!list.length) return `<div class="sub">Nicio adnotare${this.filter.q || this.filter.kind !== "all" ? " care să se potrivească" : " pe această pagină"}.</div>`;
    const col = (a) => (["white", "redact", "ink"].includes(a.type) ? "var(--layer-del)" : a.layer === "rev" ? "var(--layer-rev)" : "var(--layer-add)");
    return `<div class="sec">
      <div class="annlist full">${list.map((a) => `<div class="it ${app.sel.has(a.id) ? "on" : ""}" data-ann="${esc(a.id)}" title="Click: selectează și centrează">
        <i style="background:${col(a)}"></i><span class="t">${esc(typeName(a))}</span><span class="v" translate="no">${esc(app.annotLabel(a))}</span>
        <button class="icon" data-anndel="${esc(a.id)}" aria-label="Șterge ${esc(typeName(a))}" title="Șterge"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button></div>`).join("")}</div>
      <div class="sub">Shift+F face zoom pe selecție, F revine la toată pagina.</div></div>`;
  }

  /** Blackening the original for printing (colored drawings that print pale). */
  inkHtml() {
    const ink = this.app.settings.ink || {};
    const img = this.app.doc && this.app.doc.kind === "image";
    const fills = [["black", "Negre"], ["gray", "Gri"], ["keep", "Neschimbate"]];
    return `<div class="sec"><div class="h">Original la tipărire</div>
      <label class="chk"><input type="checkbox" id="inkAll" ${ink.all ? "checked" : ""}> Linii și text negre, pe tot desenul</label>
      ${ink.all ? `<div class="field"><span class="lbl">Suprafețe pline colorate</span><div class="seg">${fills.map(([k, l]) => `<button data-act="inkfills" data-v="${k}" class="${(ink.fills || "black") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <label class="chk"><input type="checkbox" id="inkImg" ${ink.images || img ? "checked" : ""} ${img ? "disabled" : ""}> Imagini alb-negru${img ? " (scanul e o imagine)" : ""}</label>` : ""}
      <div class="sub">${ink.all ? "Albul rămâne alb; cotele adăugate de tine nu se schimbă. Se vede pe ecran și se aplică la export." : "Pentru doar câteva linii folosește unealta <b>Înnegrește</b> din grupul Revizie."}</div></div>`;
  }

  // -------------------------------------------------------------- common
  headHtml(a) {
    const b = this.app.builtOf(a);
    let sub = a.layer === "rev" ? "strat Revizii" : ORIG_EDIT.has(a.type) ? "aplicat la export" : "strat Adăugate";
    if (b && b.measured != null) sub += ` · măsurat ${fmtNum(b.measured, ",", 2)}${b.unit === "°" ? "°" : " mm"}`;
    return `<div class="sec"><div class="h">Selecție</div><div class="title">${esc(typeName(a))}</div><div class="sub">${esc(sub)}</div></div>`;
  }

  footHtml(a) {
    const layer = ORIG_EDIT.has(a.type) ? "" : `<div class="sec"><div class="h">Strat</div><div class="seg">
        <button data-act="layer" data-v="add" class="${a.layer !== "rev" ? "on" : ""}">Adăugat</button>
        <button data-act="layer" data-v="rev" class="${a.layer === "rev" ? "on" : ""}">Revizie</button></div></div>`;
    return `${this.scaleHtml(a)}${layer}<div class="btns"><button class="danger" data-act="delete">Șterge adnotarea</button></div>`;
  }

  symRow(target) {
    const syms = [["⌀", "Diametru"], ["⌴", "Lamaj"], ["⌵", "Teșire / con"], ["↧", "Adâncime"], ["±", "Plus-minus"], ["°", "Grad"], ["×", "Ori / pe"], ["√", "Rădăcină"]];
    return `<div class="pills sym">${syms.map(([ch, t]) => `<button data-ins="${ch}" data-target="${target}" title="${t}" aria-label="Inserează ${t}">${ch}</button>`).join("")}</div>`;
  }

  textHeights(a) {
    const base = this.app.settings.textH || 3.5;
    const cur = base * (a.scale || 1) * (a.size || 1);
    return [2.5, 3.5, 5, 7, 10].map((mm) => `<button data-act="theight" data-v="${mm}" class="${Math.abs(cur - mm) < 0.02 ? "on" : ""}">${fmtNum(mm, ",", 1)}</button>`).join("");
  }

  scaleHtml(a) {
    if (!SCALABLE.has(a.type) || a.type === "text" || a.type === "note") return "";
    const k = a.scale || 1;
    const opts = [0.5, 0.7, 0.85, 1, 1.2, 1.5, 2];
    const known = opts.some((v) => Math.abs(k - v) < 0.001);
    return `<div class="sec"><div class="h">Mărime</div>
      <div class="row"><button class="ghost" data-act="scalestep" data-v="-0.1" aria-label="Micșorează" style="width:34px;height:34px;padding:0">−</button>
        <select id="scaleSel" aria-label="Mărime" class="num" style="flex:1">${known ? "" : `<option selected>${Math.round(k * 100)} %</option>`}${opts.map((v) => `<option value="${v}" ${Math.abs(k - v) < 0.001 ? "selected" : ""}>${Math.round(v * 100)} %</option>`).join("")}</select>
        <button class="ghost" data-act="scalestep" data-v="0.1" aria-label="Mărește" style="width:34px;height:34px;padding:0">+</button></div>
      <div class="sub">Sau trage de oricare colț alb al casetei punctate din jurul adnotării.</div></div>`;
  }

  previewBox() {
    return `<div class="preview"><canvas id="pv" width="560" height="120" style="width:280px;height:60px"></canvas></div>`;
  }

  // -------------------------------------------------------------- dimensions
  tolHtml(a, b) {
    const t = a.tol || { mode: "none" };
    const S = this.app.settings;
    const deg = a.type === "ang";
    const u = deg ? "°" : "mm";
    const modes = [["none", "Fără"], ["pm", "±"], ["dev", "Abateri"]];
    if (!deg) modes.push(["iso", "ISO 286"]);
    const seg = modes
      .map(([k, l]) => `<button data-act="tolmode" data-v="${k}" class="${t.mode === k ? "on" : ""}">${l}</button>`)
      .join("");
    let body = "";
    if (t.mode === "none") body = `<div class="sub">Se aplică toleranța generală din cartuș.</div>`;
    if (t.mode === "pm") {
      body = `<div class="field"><label for="tPm">Toleranță simetrică ± (${u})</label><input type="text" class="mono" id="tPm" data-f="pm" value="${t.pm != null ? fmtNum(t.pm, ",", 4) : ""}" placeholder="${deg ? "0,5" : "0,1"}"></div>`;
    }
    if (t.mode === "dev") {
      body = `<div class="row"><div class="field"><label for="tUp">Abatere superioară</label><input type="text" class="mono" id="tUp" data-f="up" value="${t.up != null ? fmtNum(t.up, ",", 4) : ""}" placeholder="+0,015"></div>
        <div class="field"><label for="tLo">Abatere inferioară</label><input type="text" class="mono" id="tLo" data-f="lo" value="${t.lo != null ? fmtNum(t.lo, ",", 4) : ""}" placeholder="-0,010"></div></div>`;
    }
    if (t.mode === "iso") {
      const r = b && b.iso;
      let info = "";
      if (r && r.ok) {
        const H = r.isHole;
        const nom = b.nominal;
        info = `<div class="kv">
          <span>Abatere superioară ${H ? "ES" : "es"}</span><span>${fmtDev(r.upper)}</span>
          <span>Abatere inferioară ${H ? "EI" : "ei"}</span><span>${fmtDev(r.lower)}</span>
          <span>IT${r.grade} (${r.range} mm)</span><span>${fmtNum(r.it, ",", 1)} µm</span>
          <span>Limite</span><span>${fmtNum(nom + r.upper / 1000, ",", 4)} / ${fmtNum(nom + r.lower / 1000, ",", 4)}</span></div>`;
      } else if (r && !r.ok) info = `<div class="note warn">${esc(r.error)}</div>`;
      const disp = t.disp || null;
      const opts = ISO_DISP.map(([k, l]) => {
        const on = (disp || S.isoDisplay) === k;
        return `<button data-act="isodisp" data-v="${k}" class="${on ? "on" : ""}">${l}${!disp && k === S.isoDisplay ? " · implicit document" : ""}</button>`;
      }).join("");
      body = `<div class="row"><div class="field" style="flex:0 0 92px"><label for="tFit">Câmp</label><input type="text" class="mono ${r && !r.ok ? "bad" : ""}" id="tFit" data-f="fit" value="${esc(t.fit || "")}" placeholder="H7"></div>
        <div class="sub" style="align-self:flex-end;padding-bottom:9px">literă mică = arbore, mare = alezaj</div></div>
        ${info}<div class="lbl">Afișare pe desen</div><div class="opts">${opts}</div>`;
    }
    return `<div class="sec"><div class="h">Toleranță</div><div class="seg">${seg}</div>${body}${t.mode !== "none" ? this.previewBox() : ""}</div>`;
  }

  html_dim(a) {
    const b = this.app.builtOf(a);
    const prefixes = ["", "Ø", "R", "SØ", "SR", "M", "□"];
    const popts = prefixes.map((p) => `<option value="${p}" ${p === (a.prefix || "") ? "selected" : ""}>${p || "—"}</option>`).join("");
    const orient = a.kind === "ali" ? "" : `<div class="field" style="flex:0 0 auto"><span class="lbl">Direcție</span><div class="seg">
        <button data-act="orient" data-v="h" class="${a.orient === "h" ? "on" : ""}">Orizontal</button>
        <button data-act="orient" data-v="v" class="${a.orient === "v" ? "on" : ""}">Vertical</button></div></div>`;
    return `<div class="sec"><div class="h">Valoare</div>
      <div class="row"><div class="field" style="flex:0 0 76px"><label for="dPre">Prefix</label><select id="dPre" data-f="prefix">${popts}</select></div>
      <div class="field"><label for="dNom">Nominal (mm)</label><input type="text" class="mono" id="dNom" data-f="nominal" value="${a.nominal != null ? fmtNum(a.nominal, ",", 4) : ""}" placeholder="${b ? fmtNum(b.nominal, ",", 2) : ""}"></div></div>
      <div class="field"><label for="dOver">Text înlocuitor (opțional)</label><input type="text" id="dOver" data-f="textOverride" value="${esc(a.textOverride || "")}" placeholder="ex.: 4× M8, 2 găuri Ø6"></div>
      ${this.symRow("#dOver")}
      <div class="row">${orient}${a.textShift != null ? `<button class="ghost" data-act="autotext" style="align-self:flex-end;height:34px">Text automat</button>` : ""}</div></div>
      ${this.tolHtml(a, b)}`;
  }

  html_ord(a) {
    const b = this.app.builtOf(a);
    const items = (b && b.items) || [];
    const step = Number(a.round) || 0;
    // the field holds the value as drawn: edit only what is wrong (e.g. the decimals)
    const fields = items.map((it) => `<input type="text" class="mono ordv${it.ov != null ? " ov" : ""}" data-ord="${it.idx}" data-auto="${it.auto}"
        value="${fmtNum(it.v, ",", 3)}" placeholder="${fmtNum(it.auto, ",", 2)}" title="Măsurat: ${fmtNum(it.auto, ",", 2)}" aria-label="Valoare ${fmtNum(it.auto, ",", 2)}">`).join("");
    const nOv = items.filter((it) => it.ov != null).length;
    return `<div class="sec"><div class="h">Cote ordonate</div>
      <div class="field"><span class="lbl">Axa</span><div class="seg">
        <button data-act="ordaxis" data-v="x" class="${a.axis !== "y" ? "on" : ""}">Pe X (linii verticale)</button>
        <button data-act="ordaxis" data-v="y" class="${a.axis === "y" ? "on" : ""}">Pe Y (linii orizontale)</button></div></div>
      <div class="field"><span class="lbl">Rotunjire valori măsurate</span><div class="seg">
        ${[[0, "Exact"], [0.1, "0,1"], [0.5, "0,5"], [1, "1"]].map(([v, l]) => `<button data-act="ordround" data-v="${v}" class="${step === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="field"><span class="lbl">Valori (mm reali), în ordinea de pe desen</span>
        <div class="ordvals">${fields}</div></div>
      <div class="sub">Corectează direct valoarea din câmp (de ex. doar zecimalele); câmpurile modificate au chenar portocaliu, iar un câmp golit revine la valoarea măsurată. Tab trece la următoarea și o selectează.</div>
      ${nOv ? `<div class="btns"><button class="ghost" data-act="ordreset">Revino la valorile măsurate (${nOv})</button></div>` : ""}
      <div class="sub">Trage de pătrățelul de la capătul liniilor ca să muți rândul de cote; de punctele de pe piesă ca să le muți. Valorile apropiate se depărtează singure, cu linia frântă.</div></div>`;
  }

  html_ang(a) {
    const b = this.app.builtOf(a);
    return `<div class="sec"><div class="h">Valoare</div>
      <div class="field"><label for="dNom">Nominal (°)</label><input type="text" class="mono" id="dNom" data-f="nominal" value="${a.nominal != null ? fmtNum(a.nominal, ",", 4) : ""}" placeholder="${b ? fmtNum(b.nominal, ",", 2) : ""}"></div>
      <div class="field"><label for="dOver">Text înlocuitor (opțional)</label><input type="text" id="dOver" data-f="textOverride" value="${esc(a.textOverride || "")}" placeholder="ex.: 30°15'"></div>
      <div class="sub">Sectorul se alege din poziția arcului: trage de pătrățelul de pe arc în celălalt unghi (suplementar sau opus).</div></div>
      ${this.tolHtml(a, b)}`;
  }

  html_rad(a) {
    const b = this.app.builtOf(a);
    const style = a.style || (a.dia ? "shoulder" : "aligned");
    return `<div class="sec"><div class="h">Valoare</div>
      <div class="row"><div class="seg" style="flex:1">
        <button data-act="radkind" data-v="r" class="${a.dia ? "" : "on"}">Rază</button>
        <button data-act="radkind" data-v="d" class="${a.dia ? "on" : ""}">Diametru</button></div>
      <div class="seg" style="flex:1.4">
        <button data-act="radstyle" data-v="shoulder" class="${style === "shoulder" ? "on" : ""}" title="Textul orizontal, pe o linie scurtă la capătul liniei de indicație">Text pe umăr</button>
        <button data-act="radstyle" data-v="aligned" class="${style === "aligned" ? "on" : ""}" title="Textul de-a lungul liniei">Aliniat cu linia</button></div></div>
      <div class="row"><div class="field" style="flex:0 0 76px"><label for="dPre">Prefix</label><select id="dPre" data-f="prefix">
        ${["R", "SR", "Ø", "SØ", ""].map((p) => `<option value="${p}" ${p === (a.prefix ?? (a.dia ? "Ø" : "R")) ? "selected" : ""}>${p || "—"}</option>`).join("")}</select></div>
      <div class="field"><label for="dNom">Nominal (mm)</label><input type="text" class="mono" id="dNom" data-f="nominal" value="${a.nominal != null ? fmtNum(a.nominal, ",", 4) : ""}" placeholder="${b ? fmtNum(b.nominal, ",", 2) : ""}"></div></div>
      <div class="field"><label for="dOver">Text înlocuitor (opțional)</label><input type="text" id="dOver" data-f="textOverride" value="${esc(a.textOverride || "")}"></div></div>
      ${this.tolHtml(a, b)}`;
  }

  html_rough(a) {
    const lead = !!a.pos;
    const kinds = [["any", "Oricare"], ["remove", "Cu așchiere"], ["noremove", "Fără așchiere"]];
    const vals = ["Ra 0,4", "Ra 0,8", "Ra 1,6", "Ra 3,2", "Ra 6,3", "Ra 12,5", "Rz 25"];
    return `<div class="sec"><div class="h">Prelucrare</div><div class="seg">
        ${kinds.map(([k, l]) => `<button data-act="rkind" data-v="${k}" class="${(a.kind || "any") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="sec"><div class="h">Cerință</div>
        <div class="field"><label for="rVal">Parametru și valoare</label><input type="text" class="mono" id="rVal" data-f="val" value="${esc(a.val)}" placeholder="Ra 3,2"></div>
        <div class="pills">${vals.map((v) => `<button data-act="rval" data-v="${esc(v)}" class="${a.val === v ? "on" : ""}">${esc(v)}</button>`).join("")}</div>
        <div class="field"><label for="rMet">Procedeu (opțional, deasupra liniei)</label><input type="text" id="rMet" data-f="method" value="${esc(a.method || "")}" placeholder="ex.: rectificat"></div></div>
      <div class="sec"><div class="h">Așezare</div>
        ${lead ? "" : `<div class="seg"><button data-act="rrot" data-v="0" class="${!a.rot ? "on" : ""}">Deasupra suprafeței</button><button data-act="rrot" data-v="90" class="${a.rot === 90 ? "on" : ""}">La stânga</button></div>`}
        <div class="btns"><button class="ghost" data-act="rlead">${lead ? "Fără linie de indicație" : "Cu linie de indicație"}</button></div>
        <div class="sub">Pentru suprafețe văzute de jos sau din dreapta, ISO 1302 cere linie de indicație.</div></div>`;
  }

  html_note(a) {
    const tpl = [
      "Muchiile nespecificate se teșesc 0,5×45°",
      "Razele nespecificate R0,5",
      "Toleranțe generale ISO 2768-mK",
      "Toate dimensiunile în mm",
      "Călire + revenire 48–52 HRC",
      "Fără bavuri și muchii tăietoare",
    ];
    return `<div class="sec"><div class="h">Conținut</div>
      <div class="field"><label for="nTit">Titlu (opțional)</label><input type="text" id="nTit" data-f="title" value="${esc(a.title || "")}" placeholder="NOTE"></div>
      <div class="field"><label for="nTxt">Note — un rând pe linie</label><textarea id="nTxt" data-f="text" rows="7" spellcheck="false">${esc(a.text || "")}</textarea></div>
      ${this.symRow("#nTxt")}
      <div class="lbl">Adaugă rapid</div>
      <div class="opts">${tpl.map((t) => `<button data-act="ntpl" data-v="${esc(t)}">${esc(t)}</button>`).join("")}</div></div>
      <div class="sec"><div class="h">Aspect</div>
      <div class="seg"><button data-act="nnum" class="${a.numbered ? "on" : ""}">Numerotate</button><button data-act="nframe" class="${a.frame ? "on" : ""}">Cu chenar</button></div>
      <div class="field"><span class="lbl">Înălțime text (mm)</span><div class="seg">
        ${this.textHeights(a)}</div></div></div>`;
  }

  html_revtab(a) {
    const rows = a.rows || [];
    const cells = rows.map((r, i) => `<div class="rtrow">
        <input type="text" class="mono" data-row="${i}" data-col="rev" value="${esc(r.rev)}" aria-label="Revizie" style="width:44px;text-align:center">
        <input type="text" data-row="${i}" data-col="desc" value="${esc(r.desc)}" aria-label="Descriere" placeholder="Descrierea modificării" style="grid-column: span 2">
        <button class="icon" data-act="rtdel" data-v="${i}" aria-label="Șterge rândul" title="Șterge rândul"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <span></span>
        <input type="text" class="mono" data-row="${i}" data-col="date" value="${esc(r.date)}" aria-label="Data" placeholder="zz.ll.aaaa">
        <input type="text" data-row="${i}" data-col="name" value="${esc(r.name)}" aria-label="Nume" placeholder="Nume">
        <span></span>
      </div>`).join("");
    return `<div class="sec"><div class="h">Rânduri</div>
      <div class="rtlist">${cells || `<span class="sub">Niciun rând.</span>`}</div>
      <div class="btns"><button class="ghost" data-act="rtadd">+ Rând nou</button><button class="ghost" data-act="rtsync">Din cotele tăiate</button></div>
      <div class="sub">„Din cotele tăiate” adaugă câte un rând pentru fiecare număr de revizie folosit la unealta Taie cota și încă absent din tabel.</div></div>
      <div class="sec"><div class="h">Așezare</div><div class="seg">
        <button data-act="rthead" data-v="bottom" class="${a.headerBottom !== false ? "on" : ""}">Antet jos (peste cartuș)</button>
        <button data-act="rthead" data-v="top" class="${a.headerBottom === false ? "on" : ""}">Antet sus</button></div>
      <div class="sub">Pătrățelul e colțul dreapta-jos: trage-l pe colțul cartușului, se prinde cu snap.</div></div>`;
  }

  html_bom(a) {
    const rows = a.rows || [];
    const inp = (i, col, v, extra = "") => `<input type="text" data-row="${i}" data-col="${col}" value="${esc(v)}" ${extra}>`;
    const cells = rows.map((r, i) => `<div class="rtrow">
        ${inp(i, "poz", r.poz, 'class="mono" aria-label="Poziție" style="text-align:center"')}
        ${inp(i, "name", r.name, 'aria-label="Denumire" placeholder="Denumire" style="grid-column: span 2"')}
        <button class="icon" data-act="rtdel" data-v="${i}" aria-label="Șterge rândul" title="Șterge rândul"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        ${inp(i, "qty", r.qty, 'class="mono" aria-label="Bucăți" placeholder="buc." style="text-align:center"')}
        ${inp(i, "mat", r.mat, 'aria-label="Material" placeholder="Material"')}
        ${inp(i, "obs", r.obs, 'aria-label="Observații" placeholder="Observații / standard"')}
        <span></span>
      </div>`).join("");
    return `<div class="sec"><div class="h">Componente</div>
      <div class="rtlist">${cells || `<span class="sub">Niciun rând.</span>`}</div>
      <div class="btns"><button class="ghost" data-act="bmadd">+ Rând nou</button><button class="ghost" data-act="bmsync">Din repere</button></div>
      <div class="sub">„Din repere” adaugă câte un rând pentru fiecare număr de reper de pe desen încă absent din listă.</div></div>
      <div class="sec"><div class="h">Așezare</div><div class="seg">
        <button data-act="rthead" data-v="bottom" class="${a.headerBottom !== false ? "on" : ""}">Antet jos (peste cartuș)</button>
        <button data-act="rthead" data-v="top" class="${a.headerBottom === false ? "on" : ""}">Antet sus</button></div>
      <div class="sub">Cu antetul jos, poziția 1 stă lângă antet și numerele cresc în sus (ISO 7573). Pătrățelul e colțul dreapta-jos.</div></div>`;
  }

  html_ucs(a) {
    const k = this.app.settings.scale || 1;
    const pg = this.app.doc && this.app.doc.pages[a.page];
    const fromCorner = pg ? `${fmtNum((a.p[0] / K) * k, ",", 2)} · ${fmtNum(((pg.h - a.p[1]) / K) * k, ",", 2)}` : "";
    return `<div class="sec"><div class="h">Originea coordonatelor</div>
      <div class="sub">Punctul 0,0 al coordonatelor scrise în linia de comandă (x,y sau polar) și al coordonatelor din bara de jos, pe această pagină. X spre dreapta, Y în sus, în mm reali (la scara desenului). Simbolul apare doar pe ecran, nu și la export.</div>
      <div class="sub">Față de colțul stânga-jos al paginii: <b class="mono">${fromCorner}</b> mm.</div>
      <div class="sub">Trage de pătrățel ca s-o muți. Ștearsă, originea revine în colțul stânga-jos al paginii.</div></div>`;
  }

  html_holes(a) {
    const rows = a.rows || [];
    const inp = (i, col, v, extra = "") => `<input type="text" class="mono" data-row="${i}" data-col="${col}" value="${esc(v)}" ${extra}>`;
    const cells = rows.map((r, i) => `<div class="rtrow hlrow">
        ${inp(i, "tag", r.tag, 'aria-label="Gaură" style="text-align:center"')}
        ${inp(i, "x", r.x, 'aria-label="X" placeholder="X"')}
        ${inp(i, "y", r.y, 'aria-label="Y" placeholder="Y"')}
        ${inp(i, "d", r.d, 'aria-label="Diametru" placeholder="Ø"')}
        <button class="icon" data-act="hldel" data-v="${i}" aria-label="Șterge rândul" title="Șterge rândul"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join("");
    return `<div class="sec"><div class="h">Găuri</div>
      <div class="rtlist">${cells || `<span class="sub">Niciun rând.</span>`}</div>
      <div class="btns"><button class="ghost" data-act="hlsync">Actualizează din cote</button></div>
      <div class="sub">X și Y vin din cotele ordonate (DOR) cu aceeași bază, cu valorile corectate acolo; Ø din cel mai mic cerc al găurii. Găurile cu același diametru primesc aceeași literă. „Actualizează din cote” refă tabelul după ce ai schimbat cotele; diametrele scrise de mână rămân.</div></div>
      <div class="sec"><div class="h">Așezare</div>
      <div class="field"><span class="lbl">Etichete la găuri</span><div class="seg">
        <button data-act="hltags" data-v="1" class="${a.tags !== false ? "on" : ""}">Afișate</button>
        <button data-act="hltags" data-v="0" class="${a.tags === false ? "on" : ""}">Ascunse</button></div></div>
      <div class="seg">
        <button data-act="rthead" data-v="top" class="${a.headerBottom === false ? "on" : ""}">Antet sus</button>
        <button data-act="rthead" data-v="bottom" class="${a.headerBottom !== false ? "on" : ""}">Antet jos</button></div>
      <div class="sub">Pătrățelul e colțul dreapta-jos al tabelului. Mutat, tabelul își lasă etichetele pe găuri.</div></div>`;
  }

  html_lead(a) {
    return `<div class="sec"><div class="h">Text</div>
      <div class="field"><label for="lTxt">Conținut (Enter = rând nou)</label><textarea id="lTxt" data-f="text" rows="3" spellcheck="false">${esc(a.text)}</textarea></div>
      ${this.symRow("#lTxt")}
      <div class="pills">${["1×45°", "0,5×45°", "2×45°", "Ra 1,6", "Ra 0,8", "M8", "Ra 3,2"].map((t) => `<button data-act="settext" data-v="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <div class="field"><span class="lbl">Capăt</span><div class="seg">
        <button data-act="arrowk" data-v="arrow" class="${a.arrow !== "dot" && a.arrow !== "none" ? "on" : ""}">Săgeată</button>
        <button data-act="arrowk" data-v="dot" class="${a.arrow === "dot" ? "on" : ""}">Punct</button>
        <button data-act="arrowk" data-v="none" class="${a.arrow === "none" ? "on" : ""}">Fără</button></div></div></div>`;
  }

  html_text(a) {
    return `<div class="sec"><div class="h">Text</div>
      <div class="field"><label for="tTxt">Conținut (Enter = rând nou)</label><textarea id="tTxt" data-f="text" rows="3" spellcheck="false">${esc(a.text)}</textarea></div>
      ${this.symRow("#tTxt")}
      <div class="row"><div class="field"><span class="lbl">Înălțime text (mm)</span><div class="seg">
        ${this.textHeights(a)}</div></div></div>
      <div class="field"><span class="lbl">Orientare</span><div class="seg">
        <button data-act="tangle" data-v="0" class="${!a.angle ? "on" : ""}">Orizontal</button>
        <button data-act="tangle" data-v="90" class="${a.angle === 90 ? "on" : ""}">Vertical</button></div></div></div>`;
  }

  html_gdt(a) {
    const sym = GDT_BY_ID[a.sym] || GDT_BY_ID.pos;
    const grid = GDT_SYMBOLS.map((s) => `<button data-act="sym" data-v="${s.id}" class="${s.id === sym.id ? "on" : ""}" title="${esc(s.name)}" aria-label="${esc(s.name)}"><canvas data-sym="${s.id}" width="44" height="44"></canvas></button>`).join("");
    const mods = MODIFIERS.map((m) => `<button data-act="mod" data-v="${m.id}" class="${(a.mods || []).includes(m.id) ? "on" : ""}" title="${esc(m.name)}">${m.glyph}</button>`).join("");
    const note = { none: "Toleranță de formă: fără bază de referință.", opt: "Bază opțională: fără bază controlează forma, cu bază și poziția.", req: "Necesită cel puțin o bază de referință." }[sym.datum];
    const ds = a.datums || ["", "", ""];
    const datums = sym.datum === "none" ? "" : `<div class="row">${["Primară", "Secundară", "Terțiară"].map((l, i) => `<div class="field"><label for="gd${i}">${l}</label><input type="text" class="mono" id="gd${i}" data-datum="${i}" value="${esc(ds[i] || "")}" placeholder="—" style="text-align:center"></div>`).join("")}</div>`;
    return `<div class="sec"><div class="h">Caracteristică</div><div class="symgrid">${grid}</div>
      <div class="sub"><b style="color:var(--text)">${esc(sym.name)}</b> · ${esc(note)}</div></div>
      <div class="sec"><div class="h">Zonă de toleranță</div>
        <div class="row"><div class="pills"><button data-act="dia" class="${a.dia ? "on" : ""}" ${diaAllowed(sym.id) ? "" : "disabled"} title="${diaAllowed(sym.id) ? "Zonă cilindrică (axă)" : "Fără Ø pentru această caracteristică"}">Ø</button></div>
        <div class="field"><input type="text" class="mono" id="gVal" data-f="val" value="${esc(a.val)}" aria-label="Valoare toleranță"></div></div>
        <div class="lbl">Modificatori</div><div class="pills">${mods}</div></div>
      <div class="sec"><div class="h">Baze de referință</div>${datums || `<div class="sub">—</div>`}</div>
      <div class="sec"><div class="h">Linia de indicație</div>
        <div class="sub">Trage de pătrățelul din cotul liniei ca s-o frângi în orice unghi.</div>
        ${a.elbow ? `<div class="btns"><button class="ghost" data-act="gelbow">Cot automat (90°)</button></div>` : ""}</div>
      <div class="sec"><div class="h">Previzualizare</div>${this.previewBox()}</div>`;
  }

  html_datum(a) {
    return `<div class="sec"><div class="h">Literă</div>
      <div class="field"><input type="text" class="mono" id="dLet" data-f="letter" value="${esc(a.letter)}" maxlength="3" aria-label="Litera bazei" style="width:80px;text-align:center"></div>
      <div class="sub">Triunghiul pe linia de cotă = axa; pe contur, decalat = suprafața.</div></div>`;
  }

  html_strike(a) {
    return `<div class="sec"><div class="h">Revizie</div>
      <div class="field"><label for="sNew">Valoare nouă (gol = doar tăiere)</label><input type="text" class="mono" id="sNew" data-f="newText" value="${esc(a.newText)}" placeholder="120"></div>
      ${this.symRow("#sNew")}
      <div class="field" style="max-width:100px"><label for="sRev">Nr. revizie</label><input type="text" class="mono" id="sRev" data-f="rev" value="${esc(a.rev)}"></div>
      <div class="note">Valoarea veche rămâne lizibilă, tăiată cu o linie, iar cea nouă se scrie alături cu triunghiul de revizie.</div></div>`;
  }

  // -------------------------------------------------------------- drawing
  styleHtml(st, scope) {
    const lt = st.ltype || "cont";
    const sample = (t) => {
      const d = t.pat ? t.pat.map((v) => Math.max(v * 0.9, 1.4)).join(" ") : "";
      return `<svg viewBox="0 0 64 8" aria-hidden="true"><line x1="2" y1="4" x2="62" y2="4" stroke="currentColor" stroke-width="1.6" ${d ? `stroke-dasharray="${d}"` : ""}/></svg>`;
    };
    const preset = PRESETS.find((p) => p.ltype === lt && Math.abs(p.w - (st.w ?? 0.25)) < 1e-6);
    return `<div class="sec"><div class="h">Tip de linie${scope === "tool" ? " pentru desen" : ""}</div>
      <div class="ltypes">${LTYPES.map((t) => `<button data-st="ltype" data-scope="${scope}" data-v="${t.id}" class="${lt === t.id ? "on" : ""}" title="ISO 128-20 tip ${t.code}">${sample(t)}<span>${esc(t.name)}</span></button>`).join("")}</div>
      <div class="field"><span class="lbl">Grosime (mm)</span><div class="pills">${WIDTHS.map((w) => `<button data-st="w" data-scope="${scope}" data-v="${w}" class="${Math.abs((st.w ?? 0.25) - w) < 1e-6 ? "on" : ""}">${fmtNum(w, ",", 2)}</button>`).join("")}</div></div>
      ${lt !== "cont" ? `<div class="field"><span class="lbl">Scara modelului</span><div class="pills">${[0.5, 1, 2, 3, 4].map((v) => `<button data-st="lscale" data-scope="${scope}" data-v="${v}" class="${Math.abs((st.lscale || 1) - v) < 1e-6 ? "on" : ""}">${fmtNum(v, ",", 1)}×</button>`).join("")}</div>
        <div class="sub">1× = lungimile din ISO 128-20 (liniuță 12d, linie lungă 24d, gol 3d); se ajustează ca linia să înceapă și să se termine cu liniuță.</div></div>` : ""}
      <div class="lbl">Utilizări (ISO 128-24)</div>
      <div class="opts">${PRESETS.map((p) => `<button data-st="preset" data-scope="${scope}" data-v="${p.id}" class="${preset && preset.id === p.id ? "on" : ""}">${esc(p.name)} <span class="muted">· ${p.code} · ${fmtNum(p.w, ",", 2)}</span></button>`).join("")}</div></div>`;
  }

  html_shape(a) {
    const b = this.app.builtOf(a);
    const inf = (b && b.info) || {};
    // shape dimensions are real, at drawing scale (like dimension values)
    const k = Number(this.app.settings.scale) || 1;
    const real = new Set(["len", "w", "h", "d", "r"]);
    const num = (id, f, label, v, dec = 2) => `<div class="field"><label for="${id}">${label}${k !== 1 && real.has(f) ? ` <span class="muted">· scara ${fmtNum(k, ",", 4)}</span>` : ""}</label><input type="text" class="mono" id="${id}" data-shf="${f}" value="${v != null ? fmtNum(real.has(f) ? v * k : v, ",", dec) : ""}"></div>`;
    let geo = "";
    if (a.kind === "line") geo = `<div class="row">${num("shLen", "len", "Lungime (mm)", inf.len)}${num("shAng", "ang", "Unghi (°)", inf.ang, 2)}</div>`;
    if (a.kind === "rect") geo = `<div class="row">${num("shW", "w", "Lățime (mm)", inf.w)}${num("shH", "h", "Înălțime (mm)", inf.h)}</div>`;
    if (a.kind === "circle" || a.kind === "cross") geo = `<div class="row">${num("shD", "d", "Diametru (mm)", inf.r * 2)}</div>`;
    if (a.kind === "cross") {
      geo += `<div class="field"><span class="lbl">Depășire contur (mm)</span><div class="pills">${[2, 3, 5].map((v) => `<button data-act="shset" data-k="ext" data-v="${v}" class="${(a.ext ?? 3) === v ? "on" : ""}">${v}</button>`).join("")}</div></div>
        <div class="field"><span class="lbl">Orientare</span><div class="seg"><button data-act="shset" data-k="rot" data-v="0" class="${!a.rot ? "on" : ""}">+</button><button data-act="shset" data-k="rot" data-v="45" class="${a.rot === 45 ? "on" : ""}">×</button></div></div>`;
    }
    if (a.kind === "arc") {
      geo = `<div class="row">${num("shR", "r", "Rază (mm)", inf.r)}<div class="field"><span class="lbl">Deschidere</span><div class="mono" style="padding:8px 0">${fmtNum(inf.sweep, ",", 2)}°</div></div></div>
        <div class="btns"><button class="ghost" data-act="shflip">Arcul complementar</button></div>`;
    }
    if (a.kind === "poly") {
      geo = `<div class="sub">${inf.n} vârfuri · lungime ${fmtNum(inf.len * k, ",", 2)} mm</div>
        <div class="seg"><button data-act="shset" data-k="closed" data-v="0" class="${!a.closed ? "on" : ""}">Deschisă</button><button data-act="shset" data-k="closed" data-v="1" class="${a.closed ? "on" : ""}">Închisă</button></div>`;
    }
    if (a.kind === "break") {
      geo = `<div class="seg"><button data-act="shset" data-k="style" data-v="zigzag" class="${a.style !== "wave" ? "on" : ""}">Cu zigzag</button><button data-act="shset" data-k="style" data-v="wave" class="${a.style === "wave" ? "on" : ""}">Ondulată</button></div>
        <div class="sub">Linie subțire continuă (ISO 128-20 tip 01.1); zigzagul e varianta pentru desenul pe calculator.</div>`;
    }
    if (a.kind === "hatch") {
      const ang = a.angle ?? 45;
      const sp = a.sp ?? 2;
      geo = `<div class="field"><span class="lbl">Unghi</span><div class="pills">${[45, 135, 30, 60, 0, 90].map((v) => `<button data-act="shset" data-k="angle" data-v="${v}" class="${ang === v ? "on" : ""}">${v}°</button>`).join("")}</div></div>
        <div class="field"><span class="lbl">Pas (mm)</span><div class="pills">${[1, 1.5, 2, 3, 4, 5].map((v) => `<button data-act="shset" data-k="sp" data-v="${v}" class="${sp === v ? "on" : ""}">${fmtNum(v, ",", 1)}</button>`).join("")}</div></div>
        <div class="row">${num("shAngle", "angle", "Unghi exact (°)", ang, 1)}${num("shSp", "sp", "Pas exact (mm)", sp, 2)}</div>
        <div class="seg"><button data-act="shtog" data-k="cross" class="${a.cross ? "on" : ""}">Încrucișată</button><button data-act="shtog" data-k="outline" class="${a.outline ? "on" : ""}">Cu contur</button></div>
        <div class="sub">Piesele alăturate dintr-un ansamblu se hașurează cu unghi sau pas diferit (ISO 128-50). Poți trage de vârfuri ca să ajustezi zona.</div>`;
    }
    return `${geo ? `<div class="sec"><div class="h">Geometrie</div>${geo}</div>` : ""}${this.styleHtml(a, "sel")}`;
  }

  html_section(a) {
    return `<div class="sec"><div class="h">Identificare</div>
      <div class="field" style="max-width:100px"><label for="vLet">Literă</label><input type="text" class="mono" id="vLet" data-f="letter" value="${esc(a.letter)}" maxlength="2" style="text-align:center"></div>
      <div class="sub">Linie-punct subțire, groasă la capete; săgețile arată direcția de privire (ISO 128-44). Trage de pătrățelul din mijloc pe cealaltă parte ca să le întorci.</div>
      <div class="btns"><button class="ghost" data-act="vlabel">Adaugă eticheta „${esc(a.letter)}–${esc(a.letter)}”</button></div></div>`;
  }

  html_detail(a) {
    return `<div class="sec"><div class="h">Identificare</div>
      <div class="field" style="max-width:100px"><label for="vLet">Literă</label><input type="text" class="mono" id="vLet" data-f="letter" value="${esc(a.letter)}" maxlength="2" style="text-align:center"></div>
      <div class="sub">Cerc subțire continuu în jurul zonei mărite. Vederea de detaliu se notează „${esc(a.letter)} (2:1)”, cu scara ei.</div>
      <div class="btns"><button class="ghost" data-act="vlabel">Adaugă eticheta „${esc(a.letter)} (2:1)”</button></div></div>`;
  }

  html_balloon(a) {
    return `<div class="sec"><div class="h">Reper</div>
      <div class="field" style="max-width:120px"><label for="bNum">Număr de poziție</label><input type="text" class="mono" id="bNum" data-f="num" value="${esc(a.num)}" style="text-align:center"></div>
      <div class="field"><span class="lbl">Formă</span><div class="seg">
        <button data-act="bshape" data-v="circle" class="${a.shape !== "plain" ? "on" : ""}">Încercuit</button>
        <button data-act="bshape" data-v="plain" class="${a.shape === "plain" ? "on" : ""}">Pe linie</button></div></div>
      <div class="field"><span class="lbl">Capăt pe piesă</span><div class="seg">
        <button data-act="bend" data-v="dot" class="${!a.end || a.end === "dot" ? "on" : ""}">Punct (în interior)</button>
        <button data-act="bend" data-v="arrow" class="${a.end === "arrow" ? "on" : ""}">Săgeată (pe contur)</button>
        <button data-act="bend" data-v="none" class="${a.end === "none" ? "on" : ""}">Fără</button></div></div>
      <div class="sub">ISO 6433: punct când linia se termină în interiorul piesei, săgeată când atinge conturul.</div></div>`;
  }

  html_ink(a) {
    const n = (a.ids || []).length;
    return `<div class="sec"><div class="h">Înnegrire</div><div class="note">${n} ${n === 1 ? "obiect devine negru" : "obiecte devin negre"} la export (și pe ecran).${this.app.settings.ink && this.app.settings.ink.all ? " Acum e activă înnegrirea pe tot desenul, care o include." : ""}</div>
      <div class="btns"><button class="ghost" data-act="inkedit">Editează selecția</button></div></div>`;
  }

  coverColorHtml(a) {
    const c = (a.color || COLORS.white).toLowerCase();
    return `<div class="field"><span class="lbl">Culoare</span><div class="row">
      <input type="color" id="cvColor" value="${esc(c)}" aria-label="Culoarea acoperirii">
      <button class="ghost sw ${c === COLORS.white ? "on" : ""}" data-act="cvcolor" data-v="${COLORS.white}" title="Alb" aria-label="Alb"><i style="background:${COLORS.white}"></i></button>
      <button class="ghost sw ${c === COLORS.coverPaper ? "on" : ""}" data-act="cvcolor" data-v="${COLORS.coverPaper}" title="Hârtie" aria-label="Hârtie"><i style="background:${COLORS.coverPaper}"></i></button>
      ${window.EyeDropper ? `<button class="ghost" data-act="cvpick" title="Ia culoarea de pe ecran">Pipetă</button>` : ""}
      <span class="mono sub">${esc(c)}</span></div></div>`;
  }

  html_white(a) {
    return `<div class="sec">${this.coverColorHtml(a)}<div class="note">Dreptunghi plin desenat peste original la export. Conținutul de dedesubt rămâne în fișier și poate fi copiat. Pentru eliminare reală folosește unealta <b>Șterge</b>.</div></div>`;
  }

  html_redact(a) {
    const n = a.mode === "objects" ? (a.ids || []).length : null;
    const label = { cover: "Acoperire a zonei (nimic nu se elimină din fișier)", objects: `Obiecte selectate: ${n}`, text: "Doar textul din zonă", zone: a.cover === false ? "Tot din zonă · liniile tăiate la margine" : "Tot din zonă · tăiere + acoperire albă" }[a.mode];
    return `<div class="sec"><div class="h">Ștergere din original</div><div class="note">${esc(label)}</div>${a.mode === "cover" ? this.coverColorHtml(a) : ""}
      <div class="btns"><button class="ghost" data-act="redit">Editează selecția</button></div></div>`;
  }

  // -------------------------------------------------------------- events
  bind() {
    const app = this.app;
    const el = this.el;
    el.querySelectorAll("[data-f]").forEach((inp) => {
      const ev = inp.tagName === "SELECT" ? "change" : "input";
      inp.addEventListener(ev, () => this.onField(inp));
      inp.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" && inp.tagName !== "TEXTAREA") || e.key === "Escape") inp.blur();
        e.stopPropagation();
      });
    });
    el.querySelectorAll("[data-row]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = Number(inp.dataset.row);
        const col = inp.dataset.col;
        app.updateSel((a) => {
          a.rows = a.rows.map((r, j) => (j === i ? { ...r, [col]: inp.value } : r));
        }, `row${i}.${col}`);
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") inp.blur();
        e.stopPropagation();
      });
    });
    el.querySelectorAll("[data-ord]").forEach((inp) => {
      // ordinate values: typed over the measured ones (empty = measured again)
      inp.addEventListener("input", () => {
        const idx = Number(inp.dataset.ord);
        const auto = Number(inp.dataset.auto);
        let v = parseNum(inp.value);
        if (inp.value.trim() !== "" && v == null) return;
        // the measured value typed back (or an empty field) = no override
        if (v != null && Math.abs(Math.abs(v) - auto) < 1e-9) v = null;
        app.updateSel((a) => {
          const ov = Array.from({ length: (a.pts || []).length + 1 }, (_, i) => (a.ov && a.ov[i] != null ? a.ov[i] : null));
          ov[idx] = v == null ? null : Math.abs(v);
          a.ov = ov.some((x) => x != null) ? ov : undefined;
        }, `ord${idx}`);
        inp.classList.toggle("ov", v != null);
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") inp.blur();
        e.stopPropagation();
      });
      inp.addEventListener("blur", () => {
        // after leaving the field the list is redrawn in drawing order (a value may have moved)
        setTimeout(() => {
          if (!el.contains(document.activeElement) || !document.activeElement.dataset.ord) this.render();
        }, 0);
      });
    });
    el.querySelectorAll("[data-datum]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = Number(inp.dataset.datum);
        app.updateSel((a) => {
          const d = [...(a.datums || ["", "", ""])];
          d[i] = inp.value.toUpperCase();
          a.datums = d;
        }, `datum${i}`);
        this.drawPreview(app.selected());
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") inp.blur();
        e.stopPropagation();
      });
    });
    el.querySelectorAll("[data-ins]").forEach((btn) => btn.addEventListener("click", () => {
      const inp = el.querySelector(btn.dataset.target);
      if (!inp) return;
      const ch = btn.dataset.ins;
      const p0 = inp.selectionStart ?? inp.value.length;
      const p1 = inp.selectionEnd ?? p0;
      inp.value = inp.value.slice(0, p0) + ch + inp.value.slice(p1);
      inp.dispatchEvent(new Event("input"));
      inp.focus();
      inp.setSelectionRange(p0 + ch.length, p0 + ch.length);
    }));
    el.querySelectorAll("[data-act]").forEach((btn) => btn.addEventListener("click", () => this.onAct(btn.dataset.act, btn.dataset.v, btn.dataset.k)));
    const ss = el.querySelector("#scaleSel");
    if (ss) ss.addEventListener("change", () => this.onAct("scale", ss.value));
    el.querySelectorAll("[data-st]").forEach((btn) => btn.addEventListener("click", () => this.onStyle(btn.dataset.st, btn.dataset.v, btn.dataset.scope)));
    el.querySelectorAll("[data-shf]").forEach((inp) => {
      inp.addEventListener("change", () => {
        let v = parseNum(inp.value);
        if (v == null) return;
        const f = inp.dataset.shf;
        // the typed value is real: on paper it is drawn divided by the scale
        if (["len", "w", "h", "d", "r"].includes(f)) v /= Number(app.settings.scale) || 1;
        app.updateSel((a) => {
          if (f === "d") resizeShape(a, "r", v / 2);
          else if (f === "angle" || f === "sp") {
            if (f === "sp" && !(v > 0.2)) return;
            a[f] = v;
          } else resizeShape(a, f, v);
        });
        this.render();
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") inp.blur();
        e.stopPropagation();
      });
    });
    const cv = el.querySelector("#cvColor");
    if (cv) cv.addEventListener("change", () => {
      app.updateSel((a) => { a.color = cv.value.toLowerCase(); });
      this.render();
    });
    el.querySelectorAll("[data-ann]").forEach((it) => it.addEventListener("click", (e) => {
      if (e.target.closest("[data-anndel]")) return;
      app.focusAnnot(it.dataset.ann);
    }));
    el.querySelectorAll("[data-anndel]").forEach((b) => b.addEventListener("click", () => {
      app.selectMany([b.dataset.anndel]);
      app.deleteSelected();
    }));
    const inkAll = el.querySelector("#inkAll");
    if (inkAll) {
      inkAll.addEventListener("change", () => {
        const cur = app.settings.ink || {};
        const img = app.doc && app.doc.kind === "image";
        app.setSettings({ ink: { fills: "black", ...cur, all: inkAll.checked, images: img ? true : !!cur.images } });
      });
    }
    const inkImg = el.querySelector("#inkImg");
    if (inkImg) inkImg.addEventListener("change", () => app.setSettings({ ink: { ...(app.settings.ink || {}), images: inkImg.checked } }));
    const sc = el.querySelector("#dScale");
    if (sc) {
      sc.addEventListener("change", () => {
        const v = parseNum(sc.value);
        if (v && v > 0) app.setSettings({ scale: v });
      });
      sc.addEventListener("keydown", (e) => e.stopPropagation());
    }
    el.querySelectorAll("canvas[data-sym]").forEach((cv) => {
      const ctx = cv.getContext("2d");
      const on = cv.parentElement.classList.contains("on");
      ctx.lineCap = "round";
      drawPrims(ctx, symbolPrims(cv.dataset.sym, 6, 6, 32, 2.6, "x"), 1, () => (on ? COLORS.uiDark : COLORS.uiLight));
    });
  }

  onField(inp) {
    const app = this.app;
    const f = inp.dataset.f;
    const raw = inp.value;
    app.updateSel((a) => {
      if (["nominal", "pm", "up", "lo"].includes(f)) {
        const v = parseNum(raw);
        if (f === "nominal") a.nominal = v;
        else a.tol = { ...(a.tol || {}), [f]: v };
      } else if (f === "fit") {
        a.tol = { ...(a.tol || {}), fit: raw.trim() };
      } else {
        a[f] = raw;
      }
    }, f);
    // fields that change the computed information re-render only the tolerance area
    if (f === "fit" || f === "nominal" || f === "prefix") this.refreshTol();
    this.drawPreview(app.selected());
  }

  refreshTol() {
    const a = this.app.selected();
    if (!a || !["dim", "rad", "ang"].includes(a.type)) return;
    const active = document.activeElement && document.activeElement.id;
    const pos = document.activeElement && document.activeElement.selectionStart;
    this.render();
    if (active) {
      const el = this.el.querySelector(`#${active}`);
      if (el) {
        el.focus();
        if (pos != null && el.setSelectionRange) el.setSelectionRange(pos, pos);
      }
    }
  }

  onStyle(key, v, scope) {
    const app = this.app;
    let patch;
    if (key === "preset") {
      const p = PRESETS.find((x) => x.id === v);
      patch = { ltype: p.ltype, w: p.w };
    } else patch = { [key]: key === "ltype" ? v : Number(v) };
    if (scope === "tool") app.setDrawStyle(patch);
    else {
      app.updateSel((a) => Object.assign(a, patch));
      // the last choice becomes the default for the next shapes (not for center marks and hatches)
      const a = app.selected();
      if (a && !["cross", "hatch"].includes(a.kind)) app.setDrawStyle(patch);
    }
    this.render();
  }

  onAct(act, v, k) {
    const app = this.app;
    const upd = (fn) => {
      app.updateSel(fn);
      this.render();
    };
    switch (act) {
      case "delete":
        app.deleteSelected();
        break;
      case "layer":
        upd((a) => { a.layer = v; });
        break;
      case "tolmode":
        upd((a) => { a.tol = { ...(a.tol || {}), mode: v }; });
        break;
      case "isodisp":
        upd((a) => { a.tol = { ...(a.tol || {}), disp: v }; });
        break;
      case "autotext":
        upd((x) => { x.textShift = null; });
        break;
      case "ntpl":
        upd((x) => {
          const t = String(x.text || "").replace(/\s+$/, "");
          x.text = t ? `${t}\n${v}` : v;
        });
        break;
      case "nnum":
        upd((x) => { x.numbered = !x.numbered; });
        break;
      case "nframe":
        upd((x) => { x.frame = !x.frame; });
        break;
      case "rtadd":
        upd((x) => {
          const rows = x.rows || [];
          const last = rows.length ? parseInt(rows[rows.length - 1].rev, 10) : 0;
          const today = new Date().toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" });
          x.rows = [...rows, { rev: String(Number.isFinite(last) ? last + 1 : rows.length + 1), desc: "", date: today, name: app.settings.author || "" }];
        });
        break;
      case "rtdel":
        upd((x) => { x.rows = (x.rows || []).filter((_r, j) => j !== Number(v)); });
        break;
      case "hldel":
        upd((x) => {
          x.rows = (x.rows || []).filter((_r, j) => j !== Number(v));
          x.pts = (x.pts || []).filter((_q, j) => j !== Number(v));
        });
        break;
      case "hlsync":
        upd((x) => { app.holeTableSync(x); });
        break;
      case "hltags":
        upd((x) => { x.tags = v === "1"; });
        break;
      case "gelbow":
        upd((a) => { delete a.elbow; });
        break;
      case "cvcolor":
        upd((a) => { a.color = v; });
        break;
      case "cvpick":
        (async () => {
          try {
            const res = await new window.EyeDropper().open();
            app.updateSel((a) => { a.color = res.sRGBHex.toLowerCase(); });
            this.render();
          } catch (_) { /* cancelled */ }
        })();
        break;
      case "inkfills":
        app.setSettings({ ink: { ...(app.settings.ink || {}), fills: v } });
        break;
      case "inkedit":
        app.editInk(app.selected());
        break;
      case "layervis":
        app.toggleLayer(v);
        this.render();
        break;
      case "bmadd":
        upd((x) => {
          const rows = x.rows || [];
          const last = Math.max(0, ...rows.map((r) => parseInt(r.poz, 10)).filter(Number.isFinite));
          x.rows = [...rows, { poz: String(last + 1), name: "", qty: "1", mat: "", obs: "" }];
        });
        break;
      case "bmsync":
        upd((x) => {
          const rows = [...(x.rows || []), ...app.bomRowsFromBalloons(x.rows || [])];
          rows.sort((p, q) => (parseFloat(p.poz) || 0) - (parseFloat(q.poz) || 0));
          x.rows = rows;
        });
        break;
      case "rtsync":
        upd((x) => { x.rows = [...(x.rows || []), ...app.revRowsFromStrikes(false, x.rows || [])]; });
        break;
      case "rthead":
        upd((x) => { x.headerBottom = v === "bottom"; });
        break;
      case "rkind":
        upd((x) => { x.kind = v; });
        break;
      case "rval":
        upd((x) => { x.val = v; });
        break;
      case "rrot":
        upd((x) => { x.rot = Number(v); });
        break;
      case "rlead":
        upd((x) => {
          x.pos = x.pos ? null : [x.target[0] + 8 * K, x.target[1] - 8 * K];
        });
        break;
      case "orient":
        upd((a) => { a.orient = v; });
        break;
      case "pages":
        dlgPages(this.app);
        break;
      case "radkind":
        upd((a) => {
          a.dia = v === "d";
          if (a.dia && (a.prefix ?? "R") === "R") a.prefix = "Ø";
          if (!a.dia && a.prefix === "Ø") a.prefix = "R";
        });
        break;
      case "radstyle":
        upd((a) => { a.style = v; });
        break;
      case "settext":
        upd((a) => { a.text = v; });
        break;
      case "arrowk":
        upd((a) => { a.arrow = v; });
        break;
      case "theight":
        upd((x) => {
          x.scale = Math.round((Number(v) / (app.settings.textH || 3.5)) * 1000) / 1000;
          delete x.size;
        });
        break;
      case "scale":
        upd((x) => { x.scale = Number(v); });
        break;
      case "scalestep":
        upd((x) => {
          const k = Math.round(((x.scale || 1) + Number(v)) * 100) / 100;
          x.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, k));
        });
        break;
      case "tsize":
        upd((a) => { a.size = Number(v); });
        break;
      case "tangle":
        upd((a) => { a.angle = Number(v); });
        break;
      case "sym":
        upd((a) => {
          a.sym = v;
          if (!diaAllowed(v)) a.dia = false;
        });
        break;
      case "dia":
        upd((a) => { a.dia = diaAllowed(a.sym) && !a.dia; });
        break;
      case "mod":
        upd((a) => {
          const m = new Set(a.mods || []);
          if (m.has(v)) m.delete(v);
          else {
            m.add(v);
            if (v === "M") m.delete("L");
            if (v === "L") m.delete("M");
          }
          a.mods = MODIFIERS.map((x) => x.id).filter((id) => m.has(id));
        });
        break;
      case "shset":
        upd((a) => { a[k] = k === "closed" ? v === "1" : k === "style" ? v : Number(v); });
        break;
      case "shtog":
        upd((a) => { a[k] = !a[k]; });
        break;
      case "shflip":
        // same endpoints, other direction: the complementary arc
        upd((a) => { a.ccw = a.ccw === false; });
        break;
      case "bshape":
        upd((a) => { a.shape = v; });
        break;
      case "ordround":
        upd((a) => { a.round = Number(v) || undefined; });
        break;
      case "ordreset":
        upd((a) => { delete a.ov; });
        break;
      case "ordaxis":
        upd((a) => {
          if ((a.axis || "x") === v) return;
          // the row moves to the matching side: 10 mm past the points
          const all = [a.base, ...a.pts];
          a.axis = v;
          a.row = v === "x" ? Math.max(...all.map((q) => q[1])) + 10 * K : Math.min(...all.map((q) => q[0])) - 10 * K;
        });
        break;
      case "bend":
        upd((a) => { a.end = v; });
        break;
      case "vlabel": {
        const a = app.selected();
        const r = 30 * K;
        const p = a.type === "section" ? [Math.min(a.pts[0][0], a.pts[1][0]), Math.min(a.pts[0][1], a.pts[1][1]) - 12 * K] : [a.pts[0][0] + r, a.pts[0][1] - r];
        app.addAnnot({ id: newId(), layer: a.layer || "add", type: "text", p, angle: 0, scale: 1.4, text: a.type === "section" ? `${a.letter}–${a.letter}` : `${a.letter} (2:1)` });
        app.setHint("Eticheta e selectată: trage-o deasupra vederii respective");
        break;
      }
      case "redit":
        app.editRedaction(app.selected());
        break;
      case "calib":
        app.setTool("calib");
        break;
      default:
        break;
    }
  }

  drawPreview(a) {
    const cv = this.el.querySelector("#pv");
    if (!cv || !a) return;
    const ctx = cv.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const S = derive(this.app.settings);
    let prims;
    if (a.type === "gdt") {
      prims = build({ ...a, target: null, pos: [0, 0] }, S, this.app.measure).prims;
    } else {
      // only the dimension text, horizontal, with the effective nominal (typed or measured)
      const own = this.app.builtOf(a);
      const tmp = {
        ...a, type: "dim", kind: "lin", orient: "h", p1: [0, 0], p2: [100, 0], p3: [0, -10], textShift: 0,
        nominal: a.nominal ?? (own ? own.nominal : null),
      };
      if (a.type === "rad") tmp.prefix = a.prefix ?? (a.dia ? "Ø" : "R");
      if (a.type === "ang") {
        tmp.deg = true;
        tmp.prefix = "";
      }
      prims = build(tmp, S, this.app.measure).prims.filter((p) => p.t === "T");
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of prims) {
      const pts = p.t === "T" ? [p.p[0], p.p[1] - p.s * 0.85, p.p[0] + (p.tw || 0), p.p[1] + p.s * 0.25] : p.p;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]);
        y0 = Math.min(y0, pts[i + 1]);
        x1 = Math.max(x1, pts[i]);
        y1 = Math.max(y1, pts[i + 1]);
      }
    }
    if (x0 === Infinity) return;
    const pad = 8;
    const z = Math.min((cv.width - 2 * pad) / (x1 - x0 || 1), (cv.height - 2 * pad) / (y1 - y0 || 1), 6);
    const ox = (cv.width - (x1 - x0) * z) / 2 - x0 * z;
    const oy = (cv.height - (y1 - y0) * z) / 2 - y0 * z;
    ctx.setTransform(z, 0, 0, z, ox, oy);
    drawPrims(ctx, prims, z, () => COLORS.preview, 1);
  }
}
