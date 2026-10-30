// Panoul de proprietăți din dreapta.
import { typeName, newId, fmtNum, parseNum, build, derive, K, SCALABLE, SCALE_MIN, SCALE_MAX } from "./annots.js";
import { LTYPES, LTYPE_BY_ID, WIDTHS, PRESETS, resizeShape } from "./shapes.js";
import { fmtDev } from "./iso286.js";
import { GDT_SYMBOLS, GDT_BY_ID, MODIFIERS, symbolPrims } from "./gdt.js";
import { drawPrims } from "./view.js";
import { TOOL_BY_ID, DRAW_TOOLS } from "./tools.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ISO_DISP = [
  ["code", "Doar simbol"],
  ["codeDev", "Simbol + (abateri)"],
  ["codeLim", "Simbol + (dimensiuni limită)"],
  ["dev", "Doar abateri"],
];

export class Panel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
  }

  render() {
    const a = this.app.selected();
    if (!this.app.doc) {
      this.el.innerHTML = this.introHtml();
      return;
    }
    if (!a) {
      this.el.innerHTML = this.docHtml();
      this.bind();
      return;
    }
    if (this.app.sel.size > 1) {
      this.el.innerHTML = this.groupHtml();
      this.bindGroup();
      return;
    }
    const fn = this[`html_${a.type}`];
    this.el.innerHTML = this.headHtml(a) + (fn ? fn.call(this, a) : "") + this.footHtml(a);
    this.bind();
    this.drawPreview(a);
  }

  // -------------------------------------------------------------- selecție multiplă
  groupHtml() {
    const list = this.app.selectedAll();
    const counts = {};
    for (const a of list) counts[typeName(a)] = (counts[typeName(a)] || 0) + 1;
    const summary = Object.entries(counts).map(([t, n]) => `${esc(t)}: ${n}`).join(" · ");
    const scalable = list.filter((a) => SCALABLE.has(a.type));
    const layered = list.filter((a) => a.type !== "white" && a.type !== "redact");
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
            if (a.type !== "white" && a.type !== "redact") a.layer = v;
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

  // -------------------------------------------------------------- fără selecție
  introHtml() {
    return `<div class="sec"><div class="title">Bine ai venit</div>
      <div class="note">Deschide un PDF exportat din CAD sau o imagine scanată. Originalul nu se modifică: cotele, toleranțele și ștergerile se păstrează separat și se aplică la export.</div></div>
      ${this.keysHtml()}`;
  }

  keysHtml() {
    return `<div class="sec"><div class="h">Taste</div><div class="keys">
      <b>V</b> selecție · <b>H</b> mută · <b>D</b> liniară · <b>A</b> aliniată · <b>O</b> diametru · <b>R</b> rază · <b>U</b> unghi · <b>C</b> teșitură · <b>L</b> indicație · <b>T</b> text<br>
      <b>G</b> GD&amp;T · <b>B</b> bază · <b>Q</b> rugozitate · <b>S</b> taie cota · <b>W</b> acoperă · <b>X</b> șterge · <b>K</b> calibrare<br>
      <b>I</b> linie · <b>P</b> polilinie · <b>J</b> dreptunghi · <b>Y</b> cerc · <b>Z</b> arc · <b>M</b> măsoară · <b>Enter</b> termină polilinia<br>
      <b>Shift</b> ortho · <b>Alt</b> fără snap · <b>Esc</b> renunță · <b>Del</b> șterge selecția<br>
      <b>Ctrl+C / Ctrl+V</b> copiază / lipește la cursor · <b>Ctrl+D</b> duplică · <b>Ctrl+A</b> selectează tot<br>
      <b>Shift+click</b> sau dreptunghi pe zonă goală = selecție multiplă · <b>săgeți</b> mută 0,5 mm<br>
      <b>Ctrl+Z / Ctrl+Y</b> anulează / refă · <b>F</b> potrivește · rotița = zoom · Space+tragere = mută</div></div>`;
  }

  docHtml() {
    const app = this.app;
    const d = app.doc;
    const S = app.settings;
    const counts = { add: 0, rev: 0, del: 0 };
    for (const a of app.annots) {
      if (a.type === "redact" || a.type === "white") counts.del++;
      else if (a.layer === "rev") counts.rev++;
      else counts.add++;
    }
    const tool = TOOL_BY_ID[app.tool];
    const pg = d.pages[app.page];
    return `<div class="sec"><div class="h">Document</div>
        <div class="title" style="word-break:break-all">${esc(d.name)}</div>
        <div class="sub">${d.kind === "image" ? `imagine · ${Math.round(d.dpi || 0)} DPI` : "PDF"} · ${d.pages.length} pagini · pagina ${app.page + 1}: ${fmtNum(pg.w / K, ",", 1)} × ${fmtNum(pg.h / K, ",", 1)} mm${pg.rot ? ` · rotită ${pg.rot}°` : ""}</div>
        ${d.kind === "pdf" && pg.paths === 0 ? `<div class="note warn">Pagina nu are geometrie vectorială (probabil scan). Snap-ul pe desen nu e disponibil; ștergerea se face doar prin acoperire.</div>` : ""}
        ${d.fromExport ? `<div class="note">Deschis dintr-un export anterior: cotele sunt editabile, originalul a fost recuperat din fișier.</div>` : ""}
      </div>
      <div class="sec"><div class="h">Unealta activă</div><div class="title" style="font-size:14px">${esc(tool ? tool.label : "")}</div><div class="note">${esc(tool ? tool.hint : "")}</div></div>
      ${tool && DRAW_TOOLS.has(tool.id) && tool.id !== "cross" && tool.id !== "hatch" ? this.styleHtml(app.drawStyle, "tool") : ""}
      <div class="sec"><div class="h">Scara desenului</div>
        <div class="row"><div class="field"><label for="dScale">mm reali / mm hârtie</label><input type="text" class="mono" id="dScale" value="${fmtNum(S.scale, ",", 4)}"></div>
        <button class="ghost" data-act="calib" style="align-self:flex-end">Calibrează</button></div>
        <div class="sub">1 = scara 1:1 · 2 = scara 1:2 · 0,5 = scara 2:1</div>
      </div>
      <div class="sec"><div class="h">Straturi</div>
        <div class="layer"><i style="background:#e8eaed"></i><span style="flex:1">Original PDF</span><span class="sub">neatins</span></div>
        <div class="layer"><i style="background:#4c8dff"></i><span style="flex:1">Adăugate</span><span class="mono sub">${counts.add}</span></div>
        <div class="layer"><i style="background:#ff6b6b"></i><span style="flex:1">Revizii</span><span class="mono sub">${counts.rev}</span></div>
        <div class="layer"><i style="border:1px dashed #a3acb7"></i><span style="flex:1">Ștergeri / acoperiri</span><span class="mono sub">${counts.del}</span></div>
      </div>
      ${this.keysHtml()}`;
  }

  // -------------------------------------------------------------- comun
  headHtml(a) {
    const b = this.app.builtOf(a);
    let sub = a.layer === "rev" ? "strat Revizii" : a.type === "white" || a.type === "redact" ? "aplicat la export" : "strat Adăugate";
    if (b && b.measured != null) sub += ` · măsurat ${fmtNum(b.measured, ",", 2)}${b.unit === "°" ? "°" : " mm"}`;
    return `<div class="sec"><div class="h">Selecție</div><div class="title">${esc(typeName(a))}</div><div class="sub">${esc(sub)}</div></div>`;
  }

  footHtml(a) {
    const layer = a.type === "white" || a.type === "redact" ? "" : `<div class="sec"><div class="h">Strat</div><div class="seg">
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
    return `<div class="sec"><div class="h">Mărime</div>
      <div class="row"><button class="ghost" data-act="scalestep" data-v="-0.1" aria-label="Micșorează" style="width:40px;padding:0">−</button>
        <span class="mono" style="min-width:60px;text-align:center;font-size:15px">${Math.round(k * 100)}%</span>
        <button class="ghost" data-act="scalestep" data-v="0.1" aria-label="Mărește" style="width:40px;padding:0">+</button></div>
      <div class="pills">${opts.map((v) => `<button data-act="scale" data-v="${v}" class="${Math.abs(k - v) < 0.001 ? "on" : ""}">${Math.round(v * 100)}%</button>`).join("")}</div>
      <div class="sub">Sau trage de pătrățelul alb din colțul adnotării selectate.</div></div>`;
  }

  previewBox() {
    return `<div class="preview"><canvas id="pv" width="560" height="120" style="width:280px;height:60px"></canvas></div>`;
  }

  // -------------------------------------------------------------- cote
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
    return `<div class="sec"><div class="h">Toleranță</div><div class="seg">${seg}</div>${body}${this.previewBox()}</div>`;
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
    return `<div class="sec"><div class="h">Valoare</div>
      <div class="row"><div class="field" style="flex:0 0 76px"><label for="dPre">Prefix</label><select id="dPre" data-f="prefix">
        ${["R", "SR", "Ø", ""].map((p) => `<option value="${p}" ${p === (a.prefix ?? "R") ? "selected" : ""}>${p || "—"}</option>`).join("")}</select></div>
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
      <div class="sub"><b style="color:#e8eaed">${esc(sym.name)}</b> · ${esc(note)}</div></div>
      <div class="sec"><div class="h">Zonă de toleranță</div>
        <div class="row"><div class="pills"><button data-act="dia" class="${a.dia ? "on" : ""}" title="Zonă cilindrică">Ø</button></div>
        <div class="field"><input type="text" class="mono" id="gVal" data-f="val" value="${esc(a.val)}" aria-label="Valoare toleranță"></div></div>
        <div class="lbl">Modificatori</div><div class="pills">${mods}</div></div>
      <div class="sec"><div class="h">Baze de referință</div>${datums || `<div class="sub">—</div>`}</div>
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

  // -------------------------------------------------------------- desen
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
    const num = (id, f, label, v, dec = 2) => `<div class="field"><label for="${id}">${label}</label><input type="text" class="mono" id="${id}" data-shf="${f}" value="${v != null ? fmtNum(v, ",", dec) : ""}"></div>`;
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
      geo = `<div class="sub">${inf.n} vârfuri · lungime ${fmtNum(inf.len, ",", 2)} mm</div>
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

  html_white(a) {
    return `<div class="sec"><div class="note">Dreptunghi alb desenat peste original la export. Conținutul de dedesubt rămâne în fișier și poate fi copiat. Pentru eliminare reală folosește unealta <b>Șterge</b>.</div></div>`;
  }

  html_redact(a) {
    const n = a.mode === "objects" ? (a.ids || []).length : null;
    const label = { objects: `Obiecte selectate: ${n}`, text: "Doar textul din zonă", zone: a.cover === false ? "Tot din zonă · liniile tăiate la margine" : "Tot din zonă · tăiere + acoperire albă" }[a.mode];
    return `<div class="sec"><div class="h">Ștergere din original</div><div class="note">${esc(label)}</div>
      <div class="btns"><button class="ghost" data-act="redit">Editează selecția</button></div></div>`;
  }

  // -------------------------------------------------------------- evenimente
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
    el.querySelectorAll("[data-st]").forEach((btn) => btn.addEventListener("click", () => this.onStyle(btn.dataset.st, btn.dataset.v, btn.dataset.scope)));
    el.querySelectorAll("[data-shf]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const v = parseNum(inp.value);
        if (v == null) return;
        const f = inp.dataset.shf;
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
      drawPrims(ctx, symbolPrims(cv.dataset.sym, 6, 6, 32, 2.6, "x"), 1, () => (on ? "#15181c" : "#e8eaed"));
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
    // câmpurile care schimbă informațiile calculate re-randează doar zona de toleranță
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
      // ultima alegere devine implicită pentru formele următoare (nu pentru axe și hașuri)
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
        upd((a) => { a.sym = v; });
        break;
      case "dia":
        upd((a) => { a.dia = !a.dia; });
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
        // aceleași capete, celălalt sens: arcul complementar
        upd((a) => { a.ccw = a.ccw === false; });
        break;
      case "bshape":
        upd((a) => { a.shape = v; });
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
      // doar textul cotei, orizontal, cu nominalul efectiv (introdus sau măsurat)
      const own = this.app.builtOf(a);
      const tmp = {
        ...a, type: "dim", kind: "lin", orient: "h", p1: [0, 0], p2: [100, 0], p3: [0, -10], textShift: 0,
        nominal: a.nominal ?? (own ? own.nominal : null),
      };
      if (a.type === "rad") tmp.prefix = a.prefix ?? "R";
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
    drawPrims(ctx, prims, z, () => "#2f6fd6", 1);
  }
}
