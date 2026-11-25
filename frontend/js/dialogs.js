// Dialogs: open, export, settings, removal from the original, calibration.
import * as api from "./api.js";
import { K, fmtNum, parseNum, DEFAULT_SETTINGS, derive, build, primsBBox } from "./annots.js";
import { MM_POSITIONS, MM_DEFAULT, MM_SPECIAL, markingConfig } from "./mmenu.js";
import { TOOLS, FAMILIES, TOOL_BY_ID } from "./tools.js";
import { EN } from "./i18n_en.js";
import { lang as uiLang, setLang, LANGS } from "./i18n.js";
import { SHEETS } from "./pages.js";
import { revName } from "./revision.js";
import { isoTemplate, cleanTemplate, templateFields } from "./tblock.js";
import { COLORS, drawPrims } from "./view.js";
import { searchCommands, commandList, conflicts, defaultKeyConfig, keyConfig, saveKeyConfig, labelOf, RESERVED_KEYS, DEFAULT_ALIASES, ACTIONS, parsePgp, importPgp } from "./commands.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const modal = () => document.getElementById("modal");
const dialog = () => document.getElementById("dialog");

export function showModal(html, onKey) {
  dialog().innerHTML = html;
  modal().hidden = false;
  const first = dialog().querySelector("input, select, button.primary");
  if (first) setTimeout(() => first.focus(), 0);
  modal().onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") closeModal();
    if (onKey) onKey(e);
  };
  modal().onclick = (e) => {
    if (e.target === modal()) closeModal();
  };
  dialog().querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  return dialog();
}

export function closeModal() {
  modal().hidden = true;
  dialog().innerHTML = "";
}

export function isModalOpen() {
  return !modal().hidden;
}

let toastTimer = null;
export function toast(msg, ms = 3200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}

function ago(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `azi, ${hm}`;
  return d.toLocaleDateString("ro-RO");
}

function daysLeft(expires) {
  if (!expires) return "";
  const d = Math.ceil((expires * 1000 - Date.now()) / 86400000);
  if (d <= 1) return " · se șterge mâine";
  return ` · se șterge în ${d} zile`;
}

const MODE_NOTE = {
  private: "Documentele tale sunt legate de acest browser: alți utilizatori ai serverului nu le văd. Ca să continui pe alt calculator, folosește codul din Setări.",
  session: "Documentele tale sunt legate de această sesiune a browserului: după închiderea lui nu le mai regăsești aici (exportă PDF-ul înainte). Alți utilizatori nu le văd.",
};

export function recentHtml(docs, retentionDays, mode = "personal") {
  const modeNote = MODE_NOTE[mode] ? `<div class="sub" style="margin:6px 4px">${MODE_NOTE[mode]}</div>` : "";
  if (!docs.length) return modeNote;
  const note = retentionDays > 0
    ? `<div class="sub" style="margin:6px 4px">Documentele stau pe server ${fmtNum(retentionDays, ",", 1)} zile de la ultima folosire, apoi se șterg automat. Ce ai exportat pe PC nu e afectat.</div>`
    : "";
  return `<div class="ttl">${mode === "personal" ? "Recente" : "Documentele tale"}</div>` + docs.slice(0, 12).map((d) => `
    <div class="item">
      <button class="open" data-doc="${d.id}">
        <span class="badge ${d.kind === "image" ? "img" : "pdf"}">${d.kind === "image" ? "IMG" : "PDF"}</span>
        <span style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0"><span translate="no" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span>
        <span class="muted" style="font-size:12px">${(d.pages || []).length} pagini · ${ago(d.updated)}${daysLeft(d.expires)}</span></span>
      </button>
      <button class="icon del" data-del="${d.id}" data-name="${esc(d.name)}" title="Șterge de pe server" aria-label="Șterge ${esc(d.name)} de pe server"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
    </div>`).join("") + note + modeNote;
}

/** Binds the buttons of the recent list: open and delete (with confirmation). */
export function bindRecent(container, app, onOpen) {
  container.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => {
    if (onOpen) onOpen();
    app.loadDoc(b.dataset.doc);
  }));
  container.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!window.confirm(`Ștergi „${b.dataset.name}” de pe server? Cotele nesalvate în PDF se pierd.`)) return;
    try {
      await api.deleteDoc(b.dataset.del);
      b.closest(".item").remove();
      toast("Document șters de pe server");
    } catch (e) {
      toast(e.message);
    }
  }));
}

// ------------------------------------------------------------------ closing a document
export function closeDialog(app) {
  const exp = app.doc && app.doc.expires ? new Date(app.doc.expires * 1000).toLocaleDateString("ro-RO") : null;
  const dlg = showModal(`
    <h2>Închizi documentul?</h2>
    <div class="note">Ai modificări care nu au fost exportate în PDF. Cotele sunt salvate automat pe server${exp ? ` și le regăsești la Recente până pe <b>${exp}</b>` : ""}, dar fișierul PDF pe calculator îl ai doar dacă exporți.</div>
    <div class="cards">
      <button class="card on" id="cExport"><b>Exportă PDF și închide</b><span>Salvezi PDF-ul pe calculator, apoi documentul se închide.</span></button>
      <button class="card" id="cClose"><b>Închide fără export</b><span>Lucrul rămâne pe server; îl redeschizi din Recente.</span></button>
      <button class="card" id="cDelete"><b>Închide și șterge de pe server</b><span style="color:var(--bad)">Cotele neexportate se pierd definitiv.</span></button>
    </div>
    <div class="foot"><button class="ghost" data-close>Anulează</button></div>`);
  dlg.querySelector("#cExport").addEventListener("click", () => {
    closeModal();
    exportDialog(app, { afterExport: () => app.doClose() });
  });
  dlg.querySelector("#cClose").addEventListener("click", () => {
    closeModal();
    app.doClose();
  });
  dlg.querySelector("#cDelete").addEventListener("click", async () => {
    try {
      await api.deleteDoc(app.doc.id);
    } catch (e) {
      toast(e.message);
      return;
    }
    closeModal();
    app.doClose();
    toast("Document închis și șters de pe server");
  });
}

// ------------------------------------------------------------------ open
export async function openDialog(app) {
  let docs = [];
  try {
    docs = await api.listDocs();
  } catch (_) { /* no list */ }
  const dlg = showModal(`
    <h2>Deschide desen</h2>
    <div class="cols">
      <div class="drop" id="dDrop" style="width:auto">
        <strong>Trage aici un PDF, un DXF sau o imagine</strong>
        <span class="muted">PDF · DXF · PNG · JPG · TIFF</span>
        <button class="ghost" id="dPick">Alege fișier</button>
        <div class="row" style="margin-top:8px"><label class="lbl" for="dDpi" style="white-space:nowrap">DPI imagine</label>
        <input type="text" id="dDpi" class="mono" placeholder="din fișier / 300" style="width:140px"></div>
        <span class="muted" style="font-size:12px">La scanuri, scara exactă se fixează apoi cu Calibrare (K).</span>
      </div>
      <div class="recent" style="width:auto">${recentHtml(docs, app.retentionDays, app.mode) || `<span class="muted">Niciun document deschis încă.</span>`}</div>
    </div>
    <div class="foot"><button class="ghost" data-close>Închide</button></div>`);
  dlg.querySelector("#dPick").addEventListener("click", () => {
    app.pendingDpi = parseNum(dlg.querySelector("#dDpi").value);
    document.getElementById("fileInput").click();
  });
  bindRecent(dlg, app, closeModal);
  const drop = dlg.querySelector("#dDrop");
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) {
      closeModal();
      app.openFile(f, parseNum(dlg.querySelector("#dDpi").value));
    }
  });
}

// ------------------------------------------------------------------ export
export function exportDialog(app, opts = {}) {
  const base = app.doc.name.replace(/\.[^.]+$/, "");
  const rev = app.settings.revNo || "1";
  const suggested = revName(base, rev);
  const nAnn = app.annots.length;
  const nDel = app.annots.filter((a) => a.type === "redact").length;
  const nPages = app.doc.pages.length;
  const nOcr = app.ocrPages ? app.ocrPages.size : 0;
  const realScale = Number(app.settings.scale) || 1;
  const dlg = showModal(`
    <h2>Exportă</h2>
    <div class="seg" id="eFmt" style="margin-bottom:12px">
      <button data-fmt="pdf" class="on">PDF</button>
      <button data-fmt="dxf">DXF (AutoCAD, Allplan…)</button></div>
    <div class="sub" id="eFmtNote" style="margin:-4px 0 12px">PDF vectorial, pentru tipărit, trimis și arhivat.</div>
    <div class="field"><label for="eName">Nume fișier</label><input type="text" class="mono" id="eName" value="${esc(suggested)}.pdf"></div>
    <div class="cols">
      <div class="cards">
        <div class="lbl">Culori</div>
        <button class="card on" data-col="black"><b>Toate negre</b><span>Cum se predă un desen: cotele noi arată ca restul.</span></button>
        <button class="card" data-col="layers"><b>Culorile straturilor</b><span>Adăugate albastru, revizii roșu — util pentru verificare.</span></button>
      </div>
      <div class="cards">
        <div class="lbl">Opțiuni</div>
        <div id="eDxfOpts" class="dxfopts" hidden>
          <div class="seg" id="eScale">
            <button data-sc="paper" class="${realScale === 1 ? "on" : ""}">Mărimea hârtiei (1:1)</button>
            <button data-sc="real" class="${realScale !== 1 ? "on" : ""}" ${realScale === 1 ? "disabled title=\"Calibrează întâi scara (K)\"" : ""}>Mărime reală${realScale !== 1 ? ` (×${fmtNum(realScale, ",", 4)})` : ""}</button></div>
          <label class="chk"><input type="checkbox" id="xGeom" checked> Liniile, arcele și cercurile din PDF</label>
          <label class="chk"><input type="checkbox" id="xText" checked> Textele din PDF</label>
          <label class="chk"><input type="checkbox" id="xAnn" checked> Cotele și adnotările DrawCAD</label>
          <label class="chk"><input type="checkbox" id="xOcr" checked> Textul recunoscut (OCR)${app.ocrLang ? "" : " — indisponibil pe server"}</label>
          <label class="chk"><input type="checkbox" id="xVec" checked> Scanuri: vectorizează imaginea <span class="muted">(experimental)</span></label>
          <label class="chk"><input type="checkbox" id="xImg"> Scanuri: imaginea ca fundal (arhivă ZIP cu DXF + PNG)</label>
          <div class="note">Straturi separate: PDF-GEOMETRIE, PDF-TEXT, SCAN-VECTORI, OCR-TEXT, DRAWCAD-COTE… Arcele rămân arce, cercurile cercuri. Imaginile puse în DrawCAD ies lângă DXF, în arhiva ZIP. Pe un scan, textul se recunoaște automat (OCR) dacă nu a fost deja; vectorizarea dă o bază de lucru, nu un desen curat — verifică cotele importante.</div>
        </div>
        <div id="ePdfOpts" class="dxfopts">
        <label class="chk" style="font-size:13px"><input type="checkbox" id="eEmbed" checked> Atașează stratul editabil (la redeschidere cotele rămân editabile)</label>
        ${app.annots.some((a) => a.type === "comment") ? `<label class="chk" style="font-size:13px"><input type="checkbox" id="eNotes" checked> Comentariile ca note PDF (vizibile în Acrobat; pe desen nu se tipăresc)</label>` : ""}
        <label class="chk" style="font-size:13px"><input type="checkbox" id="eInk" ${app.settings.ink && app.settings.ink.all ? "checked" : ""}> Liniile originale negre, pentru imprimantă (culorile deschise ies palid)</label>
        <label class="chk" style="font-size:13px"><input type="checkbox" id="eOcr" ${nOcr ? "checked" : "disabled"}> Text recunoscut (OCR) invizibil, ca PDF-ul să fie căutabil${nOcr ? ` (${nOcr} ${nOcr === 1 ? "pagină" : "pagini"})` : " — rulează întâi OCR din „Text”"}</label>
        </div>
        ${nPages > 1 ? `<div class="lbl">Pagini</div>
        <div class="seg" id="ePages">
          <button data-pg="all" class="on">Toate (${nPages})</button>
          <button data-pg="cur">Pagina ${app.page + 1}</button>
          <button data-pg="pick">Alege…</button></div>
        <div class="field" id="ePickRow" hidden><label for="ePick">Pagini (ex.: 1, 3-5)</label><input type="text" class="mono" id="ePick" value="${app.page + 1}"></div>
        <label class="chk" style="font-size:13px" id="eSplitRow"><input type="checkbox" id="eSplit"> Fiecare pagină într-un PDF separat (arhivă ZIP)</label>` : ""}
        <div class="note">${nAnn} adnotări · ${nDel} ștergeri din original. Cotele se scriu vectorial în pagină, cu fontul ISO 3098 încorporat. Originalul de pe server nu se modifică.</div>
      </div>
    </div>
    <div class="foot"><span class="muted" id="eMsg"></span><button class="ghost" data-close>Anulează</button><button class="primary" id="eGo">Exportă</button></div>`);
  let color = "black";
  let pgMode = "all";
  let fmt = "pdf";
  let scaleMode = realScale !== 1 ? "real" : "paper";
  dlg.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => {
    fmt = b.dataset.fmt;
    dlg.querySelectorAll("[data-fmt]").forEach((x) => x.classList.toggle("on", x === b));
    // what the chosen format is for (UI-D8)
    dlg.querySelector("#eFmtNote").textContent = fmt === "dxf" ? "Pentru AutoCAD, Allplan și alte programe CAD." : "PDF vectorial, pentru tipărit, trimis și arhivat.";
    dlg.querySelector("#eDxfOpts").hidden = fmt !== "dxf";
    dlg.querySelector("#ePdfOpts").hidden = fmt !== "pdf";
    const sr = dlg.querySelector("#eSplitRow");
    if (sr) sr.hidden = fmt !== "pdf";
    const nm = dlg.querySelector("#eName");
    nm.value = nm.value.replace(/\.(pdf|dxf|zip)$/i, "") + "." + fmt;
  }));
  dlg.querySelectorAll("[data-sc]").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return;
    scaleMode = b.dataset.sc;
    dlg.querySelectorAll("[data-sc]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  dlg.querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => {
    pgMode = b.dataset.pg;
    dlg.querySelectorAll("[data-pg]").forEach((x) => x.classList.toggle("on", x === b));
    dlg.querySelector("#ePickRow").hidden = pgMode !== "pick";
    if (pgMode === "pick") dlg.querySelector("#ePick").focus();
  }));
  // „1, 3-5” → [0, 2, 3, 4]
  const parsePages = (txt) => {
    const out = new Set();
    for (const part of String(txt).split(/[,; ]+/).filter(Boolean)) {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!m) throw new Error(`Pagină invalidă: „${part}”`);
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (i < 1 || i > nPages) throw new Error(`Documentul are ${nPages} pagini`);
        out.add(i - 1);
      }
    }
    if (!out.size) throw new Error("Alege cel puțin o pagină");
    return [...out].sort((x, y) => x - y);
  };
  dlg.querySelector("#eInk").addEventListener("change", (e) => {
    const cur = app.settings.ink || {};
    app.setSettings({ ink: { fills: "black", ...cur, all: e.target.checked, images: app.doc.kind === "image" ? true : !!cur.images } });
  });
  dlg.querySelectorAll("[data-col]").forEach((b) => b.addEventListener("click", () => {
    color = b.dataset.col;
    dlg.querySelectorAll("[data-col]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  dlg.querySelector("#eGo").addEventListener("click", async () => {
    const btn = dlg.querySelector("#eGo");
    btn.disabled = true;
    const chk = (id) => !!(dlg.querySelector(id) && dlg.querySelector(id).checked);
    dlg.querySelector("#eMsg").textContent = fmt === "dxf" && app.doc.kind === "image" ? "Se generează… (scan: OCR + vectorizare, poate dura un minut)" : "Se generează…";
    try {
      const name = dlg.querySelector("#eName").value.trim() || `export.${fmt}`;
      const sel = nPages > 1 ? (pgMode === "cur" ? [app.page] : pgMode === "pick" ? parsePages(dlg.querySelector("#ePick").value) : null) : null;
      const split = fmt === "pdf" && nPages > 1 && chk("#eSplit");
      const extra = fmt === "dxf"
        ? { format: "dxf", dxf: { scale: scaleMode === "real" ? realScale : 1, geom: chk("#xGeom"), text: chk("#xText"), annots: chk("#xAnn"), ocr: chk("#xOcr"), vectorize: chk("#xVec"), image: chk("#xImg") } }
        : { ocrLayer: chk("#eOcr"), notes: chk("#eNotes") };
      const { blob, report, kind, stats } = await app.exportPdf(name, color, chk("#eEmbed"), sel, split, extra);
      const stem = name.replace(/\.(pdf|dxf|zip)$/i, "");
      const fileName = `${stem}.${kind === "zip" ? "zip" : kind === "dxf" ? "dxf" : "pdf"}`;
      const saved = await saveBlob(blob, fileName);
      if (!saved) {
        dlg.querySelector("#eMsg").textContent = "Salvare anulată";
        btn.disabled = false;
        return;
      }
      const a = { download: saved };
      closeModal();
      const removed = Object.values(report).reduce((s, r) => s + (r.removed || 0), 0);
      const blackened = Object.values(report).reduce((s, r) => s + (r.black || 0), 0);
      const sum = (k) => Object.values(report).reduce((s, r) => s + (r[k] || 0), 0);
      const cut = sum("cut");
      const left = sum("partial") + sum("locked");
      app.markExported();
      let dx = "";
      if (stats) {
        const tot = (k) => Object.values(stats).reduce((acc, r) => acc + (r[k] || 0), 0);
        const ents = tot("linii") + tot("polilinii") + tot("arce") + tot("cercuri") + tot("curbe");
        const skew = Object.values(stats).map((r) => r.skew).find((v) => v);
        dx = ` · ${ents} entități, ${tot("texte")} texte${skew ? ` · scan îndreptat cu ${fmtNum(Math.abs(skew), ",", 2)}°` : ""}`;
        for (const n of Object.keys(stats)) if (stats[n].scan) app.ocrPages.add(Number(n));
      }
      const kb = blob.size / 1024;
      const size = kb >= 1024 ? `${fmtNum(kb / 1024, ",", 1)} MB` : `${Math.max(1, Math.round(kb))} kB`;
      toast(`Exportat ${a.download} (${size})${dx}${removed ? ` · ${removed} obiecte eliminate` : ""}${blackened ? ` · ${blackened} înnegrite` : ""}${cut ? ` · ${cut} linii tăiate la margine` : ""}${left ? ` · ${left} doar acoperite/rămase` : ""}`, dx ? 5000 : 3200);
      if (opts.afterExport) opts.afterExport();
    } catch (e) {
      dlg.querySelector("#eMsg").textContent = e.message;
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ pages
function sheetName(p) {
  const long = Math.max(p.w, p.h) / K;
  const hit = SHEETS.find(([, mm]) => Math.abs(long - mm) < 3);
  return hit ? hit[0] : `${Math.round(p.w / K)}×${Math.round(p.h / K)}`;
}

export function pagesDialog(app) {
  const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const RL = ico("M4 4v6h6M4.6 15a8 8 0 1 0 1.9-8.3L4 10");
  const RR = ico("M20 4v6h-6M19.4 15a8 8 0 1 1-1.9-8.3L20 10");
  const dlg = showModal(`
    <h2>Pagini</h2>
    <div class="row" style="margin-bottom:10px;align-items:center">
      <span class="muted" style="flex:1">Rotirea și ordinea rămân la export; fișierul încărcat nu se modifică. Cotele se rotesc odată cu pagina.</span>
      <button class="ghost" data-all="-90">${RL} Toate la stânga</button><button class="ghost" data-all="90">${RR} Toate la dreapta</button><button class="ghost" data-all="180">180°</button>
    </div>
    <div class="pggrid" id="pgGrid"></div>
    ${app.doc.pages.length > 1 ? '<label class="chk" style="font-size:13px;margin-top:8px"><input type="checkbox" id="pgSheetAll" checked> Mărimea foii se schimbă la toate paginile</label>' : ""}
    <div class="note" style="margin-top:8px">Mărimea foii contează la scanuri și poze: cotele și textele au mărimea lor în mm față de foaie. Dacă imaginea a venit cu DPI greșit (ex. 72), foaia iese uriașă și cotele par minuscule — alege formatul real (A3, A4…). Cotele existente rămân pe desen, iar scara calibrată se păstrează.</div>
    <div class="foot"><span class="muted" id="pgMsg" style="flex:1"></span><button class="primary" data-close>Gata</button></div>`);
  const grid = dlg.querySelector("#pgGrid");
  const msg = dlg.querySelector("#pgMsg");
  let armed = -1;
  const render = () => {
    const pages = app.doc.pages;
    const v = app.doc.lv || 0;
    grid.innerHTML = pages.map((p, i) => {
      const s = Math.min(160 / p.w, 160 / p.h);
      const nAnn = app.annots.filter((a) => (a.page || 0) === i).length;
      return `<div class="pgcard${i === app.page ? " on" : ""}" data-i="${i}">
        <button class="thumb" data-go="${i}" title="Deschide pagina ${i + 1}"><img alt="Pagina ${i + 1}" loading="lazy" src="${api.renderUrl(app.doc.id, i, Math.round(s * 1000) / 1000, `&v=${v}`)}"></button>
        <div class="pgl"><b>${i + 1}</b><span class="muted">${Math.round(p.w / K)}×${Math.round(p.h / K)} mm${nAnn ? ` · ${nAnn} adn.` : ""}</span></div>
        <select class="mini sheet" data-sheet="${i}" aria-label="Mărimea foii pentru pagina ${i + 1}" title="Mărimea foii: cotele și textele noi au mărimea lor în mm față de foaie">
          <option value="">Foaie: ${sheetName(p)}</option>
          ${SHEETS.map(([nm, mm]) => `<option value="${mm}">${nm} (${mm} mm)</option>`).join("")}
          <option value="x0.5">50%</option><option value="x2">200%</option></select>
        <div class="pgb">
          <button class="mini" data-op="rl" title="Rotește la stânga">${RL}</button>
          <button class="mini" data-op="rr" title="Rotește la dreapta">${RR}</button>
          <button class="mini" data-op="up" title="Mută înainte" ${i === 0 ? "disabled" : ""}>${ico("M15 6l-6 6 6 6")}</button>
          <button class="mini" data-op="dn" title="Mută după" ${i === pages.length - 1 ? "disabled" : ""}>${ico("M9 6l6 6-6 6")}</button>
          <button class="mini del${armed === i ? " armed" : ""}" data-op="del" title="${armed === i ? "Apasă încă o dată ca să ștergi" : "Șterge pagina"}" ${pages.length === 1 ? "disabled" : ""}>${armed === i ? "Sigur?" : ico("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13")}</button>
        </div></div>`;
    }).join("");
  };
  const run = async (op, text) => {
    msg.textContent = "…";
    grid.classList.add("busy");
    try {
      await app.pageOp(op);
      msg.textContent = text || "";
    } catch (e) {
      msg.textContent = e.message;
    }
    grid.classList.remove("busy");
    armed = -1;
    render();
    // the pressed button disappeared with the grid: focus stays in the dialog so Esc closes it
    dlg.querySelector(".foot .primary").focus();
  };
  grid.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-sheet]");
    if (!sel || !sel.value) return;
    const i = Number(sel.dataset.sheet);
    const p = app.doc.pages[i];
    const factor = sel.value.startsWith("x") ? Number(sel.value.slice(1)) : (Number(sel.value) * K) / Math.max(p.w, p.h);
    const all = app.doc.pages.length > 1 && dlg.querySelector("#pgSheetAll").checked;
    run({ op: "scale", pages: all ? null : [i], factor }, `Foaie nouă: ${Math.round((p.w * factor) / K)} × ${Math.round((p.h * factor) / K)} mm`);
  });
  grid.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) {
      app.setPage(Number(go.dataset.go));
      closeModal();
      return;
    }
    const b = e.target.closest("[data-op]");
    if (!b || b.disabled) return;
    const i = Number(b.closest("[data-i]").dataset.i);
    const op = b.dataset.op;
    if (op === "rl" || op === "rr") run({ op: "rotate", pages: [i], delta: op === "rr" ? 90 : -90 }, `Pagina ${i + 1} rotită`);
    else if (op === "up") run({ op: "move", page: i, to: i - 1 }, `Pagina ${i + 1} mutată înainte`);
    else if (op === "dn") run({ op: "move", page: i, to: i + 1 }, `Pagina ${i + 1} mutată după`);
    else if (op === "del") {
      const nAnn = app.annots.filter((a) => (a.page || 0) === i).length;
      if (armed !== i) {
        armed = i;
        msg.textContent = nAnn ? `Pagina ${i + 1} are ${nAnn} adnotări: se șterg și ele.` : "";
        render();
        return;
      }
      run({ op: "delete", pages: [i] }, `Pagina ${i + 1} ștearsă`);
    }
  });
  dlg.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => run({ op: "rotate", pages: null, delta: Number(b.dataset.all) }, "Toate paginile rotite")));
  render();
}

// ------------------------------------------------------------------ saving a file
/** Saves a generated file. In the desktop app it opens the system "Save as" dialog;
 *  in the browser it downloads it. Returns the saved name or null if the user cancelled. */
export async function saveBlob(blob, fileName) {
  const bridge = window.pywebview && window.pywebview.api;
  if (bridge && bridge.save_file) {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",", 2)[1] || "");
      r.onerror = () => reject(new Error("Fișierul nu a putut fi pregătit"));
      r.readAsDataURL(blob);
    });
    const res = await bridge.save_file(fileName, b64);
    if (!res || !res.ok) {
      if (res && res.error) throw new Error(res.error);
      return null;
    }
    return res.name || fileName;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return fileName;
}

// ------------------------------------------------------------------ text and OCR
const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[⌀ø]/g, "ø").replace(/\s+/g, "");

export async function textDialog(app) {
  const nPages = app.doc.pages.length;
  const many = nPages > 40;
  const dlg = showModal(`
    <h2>Text și OCR</h2>
    <div class="field"><label for="tQ">Caută în desen</label><input type="search" id="tQ" class="mono" placeholder="ex.: Ø25, H7, M8, 42CrMo4" autocomplete="off"></div>
    <div id="tList" class="annlist tlist"><div class="muted" style="padding:6px 8px">Se citesc textele…</div></div>
    <div class="ocrbar">
      <span id="tStat" class="muted"></span>
      <span style="flex:1"></span>
      <button class="ghost" id="tRun" ${app.ocrLang ? "" : "disabled"}>Recunoaște pagina ${app.page + 1}</button>
      ${nPages > 1 ? `<button class="ghost" id="tAll" ${app.ocrLang ? "" : "disabled"}>Toate paginile</button>` : ""}
    </div>
    <label class="chk" style="font-size:13px"><input type="checkbox" id="tShow" ${app.showOcr ? "checked" : ""}> Arată pe desen textul recunoscut (verde = sigur, portocaliu = de verificat)</label>
    <div class="note">${app.ocrLang
      ? `OCR (Tesseract, ${esc(app.ocrLang)}) citește textul din imagine: desene scanate sau texte desenate cu linii. Textul găsit se poate căuta, copia, pune invizibil în PDF (căutabil) și exporta ca text în DXF.`
      : "OCR indisponibil: pe server lipsește Tesseract. Căutarea funcționează doar pe textele reale din PDF."}</div>
    <div class="foot"><span class="muted" id="tMsg"></span><button class="ghost" id="tCopy">Copiază textul paginii</button><button class="primary" data-close>Închide</button></div>`);
  const $q = dlg.querySelector("#tQ");
  const $list = dlg.querySelector("#tList");
  const $stat = dlg.querySelector("#tStat");
  const $msg = dlg.querySelector("#tMsg");
  const native = new Map();
  const pagesToRead = many ? [app.page] : [...Array(nPages).keys()];
  const items = () => {
    const out = [];
    for (const n of pagesToRead) {
      for (const it of native.get(n) || []) out.push({ page: n, src: "PDF", text: it.text, box: it.box });
      const o = app.ocr.get(n);
      for (const ln of (o && o.lines) || []) out.push({ page: n, src: "OCR", text: ln.text, box: ln.box, conf: ln.conf });
    }
    return out;
  };
  const updStat = () => {
    const o = app.ocr.get(app.page);
    if (!app.ocrLang) $stat.textContent = "";
    else if (o) $stat.textContent = `Pagina ${app.page + 1}: ${o.lines.length} texte recunoscute${o.ms ? ` în ${fmtNum(o.ms / 1000, ",", 1)} s` : ""}${o.skew ? ` · scan înclinat ${fmtNum(o.skew, ",", 2)}°` : ""}`;
    else $stat.textContent = `Pagina ${app.page + 1}: OCR nerulat`;
    const run = dlg.querySelector("#tRun");
    if (run) run.textContent = o ? `Recunoaște din nou pagina ${app.page + 1}` : `Recunoaște pagina ${app.page + 1}`;
  };
  const render = () => {
    const q = norm($q.value);
    const all = items();
    const hits = q ? all.filter((it) => norm(it.text).includes(q)) : all;
    if (!all.length) {
      $list.innerHTML = `<div class="muted" style="padding:6px 8px">Niciun text în ${many ? "pagina curentă" : "document"}${app.ocrLang ? " — pentru desene scanate rulează OCR" : ""}.</div>`;
      return;
    }
    if (!hits.length) {
      $list.innerHTML = `<div class="muted" style="padding:6px 8px">Nimic găsit pentru „${esc($q.value)}”.</div>`;
      return;
    }
    const mark = (t) => {
      if (!q) return esc(t);
      // highlight the match, ignoring spaces and diacritics
      const chars = [...t];
      const nn = chars.map((c) => norm(c));
      const flat = nn.join("");
      const at = flat.indexOf(q);
      if (at < 0) return esc(t);
      let pos = 0;
      let html = "";
      for (let i = 0; i < chars.length; i++) {
        const inside = pos >= at && pos < at + q.length && nn[i];
        html += inside ? `<mark>${esc(chars[i])}</mark>` : esc(chars[i]);
        pos += nn[i].length;
      }
      return html.replace(/<\/mark><mark>/g, "");
    };
    $list.innerHTML = hits.slice(0, 300).map((it, i) => `<div class="it" data-i="${i}">
      <span class="src ${it.src === "OCR" ? (it.conf >= 75 ? "ok" : "low") : ""}">${it.src}</span>
      <span class="t" translate="no">${mark(it.text)}</span>${nPages > 1 ? `<span class="v">p. ${it.page + 1}</span>` : ""}</div>`).join("")
      + (hits.length > 300 ? `<div class="muted" style="padding:6px 8px">… încă ${hits.length - 300}</div>` : "");
    $list.querySelectorAll("[data-i]").forEach((el) => el.addEventListener("click", () => {
      const it = hits[Number(el.dataset.i)];
      $list.querySelectorAll(".it").forEach((x) => x.classList.toggle("on", x === el));
      app.gotoText(it.page, it.box);
    }));
  };
  $q.addEventListener("input", render);
  $q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $list.querySelector("[data-i]");
      if (first) first.click();
    }
  });
  dlg.querySelector("#tShow").addEventListener("change", (e) => app.setShowOcr(e.target.checked));
  const runPage = async (n, force) => {
    await app.loadOcr(n, true, force);
  };
  const busy = (on) => dlg.querySelectorAll("#tRun, #tAll").forEach((b) => { b.disabled = on || !app.ocrLang; });
  const runBtn = dlg.querySelector("#tRun");
  if (runBtn) runBtn.addEventListener("click", async () => {
    busy(true);
    $msg.textContent = "Se recunoaște textul… (10–60 s pe pagină)";
    try {
      await runPage(app.page, app.ocr.get(app.page) != null);
      $msg.textContent = "";
      if (!app.showOcr) {
        app.setShowOcr(true);
        dlg.querySelector("#tShow").checked = true;
      }
    } catch (e) {
      $msg.textContent = e.message;
    }
    busy(false);
    updStat();
    render();
  });
  const allBtn = dlg.querySelector("#tAll");
  if (allBtn) allBtn.addEventListener("click", async () => {
    busy(true);
    try {
      for (let n = 0; n < nPages; n++) {
        if (app.ocr.get(n)) continue;
        $msg.textContent = `Pagina ${n + 1} din ${nPages}…`;
        await runPage(n, false);
        if (!dlg.isConnected || modal().hidden) return;
        render();
      }
      $msg.textContent = "Gata";
    } catch (e) {
      $msg.textContent = e.message;
    }
    busy(false);
    updStat();
    render();
  });
  dlg.querySelector("#tCopy").addEventListener("click", async () => {
    const n = app.page;
    const lines = [...(native.get(n) || []).map((x) => x.text), ...(((app.ocr.get(n) || {}).lines) || []).map((x) => x.text)];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      $msg.textContent = `${lines.length} rânduri copiate`;
    } catch (_) {
      $msg.textContent = "Copierea nu e permisă de browser";
    }
  });
  updStat();
  // PDF texts and OCR already done, for the pages being searched
  await Promise.all(pagesToRead.map(async (n) => {
    try {
      native.set(n, (await api.pageText(app.doc.id, n, app.doc.lv || 0)).items);
    } catch (_) { native.set(n, []); }
    if (app.ocrPages.has(n) && !app.ocr.get(n)) {
      try { await app.loadOcr(n); } catch (_) { /* no OCR */ }
    }
  }));
  if (modal().hidden) return;
  updStat();
  render();
  $q.focus();
}

// ------------------------------------------------------------------ settings
/** The 8 positions of the radial menu, like a compass around the cursor. */
function mmGridHtml(cfg) {
  const groups = [];
  for (const t of TOOLS) {
    if (t.id === "select" || t.id === "pan" || t.id === "calib" || t.hidden) continue;
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push((g = { name: t.group, tools: [] }));
    g.tools.push(t);
  }
  const options = (cur) => `<optgroup label="Acțiuni">${MM_SPECIAL.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>
    ${groups.map((g) => `<optgroup label="${esc(g.name)}">${g.tools.map((t) => `<option value="${t.id}" ${t.id === cur ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</optgroup>`).join("")}`;
  // position in a 3×3 grid for the indices E, NE, N, NW, W, SW, S, SE
  const cell = { 0: [2, 1], 1: [2, 0], 2: [1, 0], 3: [0, 0], 4: [0, 1], 5: [0, 2], 6: [1, 2], 7: [2, 2] };
  let html = `<div class="mmc" style="grid-column:2;grid-row:2"><span>●</span><span class="sub">cursor</span></div>`;
  for (let i = 0; i < 8; i++) {
    const [c, r] = cell[i];
    html += `<label class="mmc" style="grid-column:${c + 1};grid-row:${r + 1};order:${r * 3 + c}"><span class="sub">${MM_POSITIONS[i]}</span>
      <select data-i="${i}" aria-label="Comanda din poziția ${MM_POSITIONS[i]}">${options(cfg[i])}</select></label>`;
  }
  return html;
}

/** Settings preview: a Ø25k6 shaft dimension drawn with the chosen style, on white paper, at a fixed
 * zoom so that text height, arrows and line width can be compared between choices. */
function drawStylePreview(cv, settings, measure) {
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth || 360;
  const ch = cv.clientHeight || 150;
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const S = derive(settings);
  const d = 25 * K; // shaft Ø25, standing, cut 9 mm below the dimension
  const dim = {
    type: "dim", kind: "lin", orient: "h", p1: [0, 0], p2: [d, 0], p3: [0, -9 * K], textShift: 0,
    prefix: "Ø", nominal: null, tol: { mode: "iso", fit: "k6" },
  };
  const prims = [...build(dim, S, measure).prims];
  const thick = 0.5 * K;
  const deep = 9 * K;
  prims.push({ t: "L", p: [0, 0, 0, deep], w: thick }, { t: "L", p: [d, 0, d, deep], w: thick }, { t: "L", p: [0, 0, d, 0], w: thick });
  prims.push({ t: "L", p: [d / 2, -3 * K, d / 2, deep + 2 * K], w: S.lw, dp: [8 * K, 1.5 * K, 1 * K, 1.5 * K] });
  const bb = primsBBox(prims);
  if (!bb) return;
  const [x0, y0, x1, y1] = bb;
  const pad = 12 * dpr;
  const z = Math.min(2.4 * dpr, (cv.width - 2 * pad) / (x1 - x0 || 1), (cv.height - 2 * pad) / (y1 - y0 || 1));
  ctx.setTransform(z, 0, 0, z, (cv.width - (x1 - x0) * z) / 2 - x0 * z, (cv.height - (y1 - y0) * z) / 2 - y0 * z);
  drawPrims(ctx, prims, z, () => COLORS.inkDefault, 0.6 * dpr);
}

export function settingsDialog(app, startPane = null) {
  const S = app.settings;
  const rail = app.railCfg();
  const ws = app.mode && app.mode !== "personal";
  const opt = (name, cur, list) => list.map(([v, l]) => `<button class="${String(cur) === String(v) ? "on" : ""}" data-set="${name}" data-v="${v}">${l}</button>`).join("");
  // the panes: two scopes, said once in the navigation and once at the top of each pane
  const PANES = [
    { id: "style", doc: true, label: "Stil cote" },
    { id: "sheet", doc: true, label: "Foaie și revizii" },
    { id: "ui", doc: false, label: "Interfață" },
    { id: "cmds", doc: false, label: "Comenzi și meniu" },
    ...(ws ? [{ id: "ws", doc: false, label: "Spațiu de lucru" }] : []),
  ];
  let cur = "style";
  try {
    const last = startPane || localStorage.getItem("cotare.stab");
    if (PANES.some((p) => p.id === last)) cur = last;
  } catch (_) { /* storage unavailable */ }
  const navItem = (p) => `<button role="tab" id="stab-${p.id}" data-stab="${p.id}" aria-controls="spane-${p.id}">${p.label}</button>`;
  const pane = (id, body) => {
    const p = PANES.find((x) => x.id === id);
    const scope = p.doc ? "Documentul curent · se aplică la „Aplică”" : "Toate documentele · se salvează imediat, în acest browser";
    return `<section class="spane" role="tabpanel" id="spane-${id}" aria-labelledby="stab-${id}" hidden>
      <div class="scope"><h3>${p.label}</h3><span class="${p.doc ? "doc" : ""}">${scope}</span></div>${body}</section>`;
  };
  const dlg = showModal(`
    <h2>Setări</h2>
    <div class="setlay">
      <nav class="snav" role="tablist" aria-orientation="vertical" aria-label="Secțiuni setări">
        <div class="sgrp">Documentul curent</div>
        ${PANES.filter((p) => p.doc).map(navItem).join("")}
        <div class="sgrp">Toate documentele</div>
        ${PANES.filter((p) => !p.doc).map(navItem).join("")}
        <div class="sver" translate="no">DrawCAD ${esc(app.version || "dev")}</div>
      </nav>
      <div class="spanes">
        ${pane("style", `
          <div class="prevbox stylepv"><canvas id="sPrev" aria-label="Previzualizare stil cote"></canvas></div>
          <div class="cols">
            <div class="sec">
              <div class="lbl">Înălțime text (ISO 3098)</div><div class="seg">${opt("textH", S.textH, [[2.5, "2,5 mm"], [3.5, "3,5 mm"], [5, "5 mm"], [7, "7 mm"]])}</div>
              <div class="lbl">Capete linie de cotă</div><div class="seg">${opt("arrow", S.arrow, [["closed", "Închise"], ["open", "Deschise"], ["tick", "Oblic"], ["dot", "Punct"]])}</div>
              <div class="lbl">Lungime săgeată (mm)</div><div class="seg">${opt("arrowLen", S.arrowLen, [[2.5, "2,5"], [3, "3"], [3.5, "3,5"], [4, "4"]])}</div>
              <div class="lbl">Grosime linii subțiri (mm)</div><div class="seg">${opt("lineW", S.lineW, [[0.18, "0,18"], [0.25, "0,25"], [0.35, "0,35"]])}</div>
            </div>
            <div class="sec">
              <div class="lbl">Separator zecimal</div><div class="seg">${opt("sep", S.sep, [[",", "Virgulă 0,015"], [".", "Punct 0.015"]])}</div>
              <div class="lbl">Câmp ISO 286 — afișare implicită</div><div class="seg">${opt("isoDisplay", S.isoDisplay, [["code", "Simbol"], ["codeDev", "+ abateri"], ["codeLim", "+ limite"], ["dev", "Abateri"]])}</div>
              <div class="lbl">Scriere câmp</div><div class="seg">${opt("codeSpace", S.codeSpace, [[false, "Ø25k6 (ISO)"], [true, "Ø25 k6"]])}</div>
            </div>
          </div>`)}
        ${pane("sheet", `
          <div class="sec">
            <div class="h">Scară</div>
            <div class="row"><div class="field"><label for="sScale">mm reali / mm hârtie</label><input type="text" id="sScale" class="mono" value="${fmtNum(S.scale, ",", 4)}"></div></div>
            <div class="sub">Cotele măsurate pe desen se înmulțesc cu scara. Pentru o scară citită de pe o cotă existentă folosește Calibrare.</div>
          </div>
          <div class="sec">
            <div class="h">Revizii</div>
            <div class="row"><div class="field"><label for="sRev">Nr. revizie curent</label><input type="text" id="sRev" class="mono" value="${esc(S.revNo)}"></div>
            <div class="field"><label for="sAuth">Nume / inițiale (tabel revizii)</label><input type="text" id="sAuth" value="${esc(S.author || "")}"></div></div>
            <label class="chk"><input type="checkbox" id="sAutoRev" ${S.autoRev === false ? "" : "checked"}> Revizie nouă automat la prima modificare după un export</label>
            <div class="sub"><span>${S.exportedRev ? `Ultimul export: rev ${esc(S.exportedRev)}.` : "Documentul nu a fost încă exportat."}</span> <span>Numărul intră în numele fișierului (_rev${esc(S.revNo || "1")}), în metadatele PDF, la cotele tăiate și în tabelul de revizii.</span></div>
          </div>
          <div class="sec">
            <div class="h">Toleranțe generale (ISO 2768)</div>
            <div class="lbl">ISO 2768-1 — cote liniare și unghiulare</div><div class="seg">${opt("gtol", S.gtol || "", [["", "Fără"], ["f", "f · fin"], ["m", "m · mediu"], ["c", "c · grosier"], ["v", "v · foarte grosier"]])}</div>
            <div class="lbl">ISO 2768-2 — forme și poziții (doar în text)</div><div class="seg">${opt("gtol2", S.gtol2 || "", [["", "—"], ["H", "H"], ["K", "K"], ["L", "L"]])}</div>
            <div class="sub">O cotă fără toleranță proprie arată în panou abaterea care i se aplică, cu un buton care o scrie pe cotă. Câmpul din indicator și nota implicită preiau clasa (ex.: ISO 2768-mK).</div>
          </div>
          <div class="sec">
            <div class="h">Limba textelor din desen</div>
            <div class="seg">${opt("dlang", S.dlang || "ro", [["ro", "Română"], ["en", "English"]])}</div>
            <div class="sub">Antete de tabel, note implicite, tabelul de revizii. Nu schimbă limba interfeței.</div>
          </div>`)}
        ${pane("ui", `
          <div class="sec">
            <div class="h">Limba interfeței · Language</div>
            <div class="seg">${LANGS.map(([v, l]) => `<button data-uilang="${v}" class="${uiLang() === v ? "on" : ""}" translate="no">${l}</button>`).join("")}</div>
            <div class="sub">Pagina se reîncarcă; lucrul rămâne salvat.</div>
          </div>
          <div class="sec">
            <div class="h">Temă</div>
            <div class="seg">${[["dark", "Întunecată"], ["light", "Luminoasă"], ["system", "Ca sistemul"]].map(([v, l]) => `<button data-theme-set="${v}" class="${app.themePref() === v ? "on" : ""}">${l}</button>`).join("")}</div>
            <div class="sub">Foaia rămâne albă în ambele teme. Se salvează în acest browser.</div>
          </div>
          <div class="sec">
            <div class="h">Bara de unelte</div>
            <label class="chk"><input type="checkbox" id="sRailLbl" ${rail.labels ? "checked" : ""}> Etichete sub iconițe</label>
            <label class="chk"><input type="checkbox" id="sRailHover" ${rail.hover ? "checked" : ""}> Lista familiei se deschide când ții mouse-ul pe buton</label>
          </div>
          <div class="sec">
            <div class="h">Familii afișate în bară</div>
            <div class="railfams" id="sRailFams">${FAMILIES.map((f) => `<label class="chk"><input type="checkbox" data-fam="${f.id}" ${rail.hidden.includes(f.id) ? "" : "checked"}> ${f.label}</label>`).join("")}</div>
            <div class="sub">O familie ascunsă rămâne la îndemână din linia de comandă și cu tastele ei.</div>
          </div>`)}
        ${pane("cmds", `
          <div class="sec">
            <div class="h">Taste și linia de comandă</div>
            <div class="row"><button class="ghost" id="sKeys">Taste și comenzi…</button><span class="sub">Acum: ${keyConfig().mode === "autocad" ? "comenzi AutoCAD (L, C, DLI… + Spațiu)" : "taste directe (o tastă = o unealtă); Enter deschide linia de comandă"}.</span></div>
          </div>
          <div class="sec">
            <div class="h">Meniul radial · click dreapta ținut</div>
            <div class="sub">Alegi trăgând spre comandă și eliberând butonul; pe ecran tactil, apăsare lungă.</div>
            <div class="mmgrid" id="sMm">${mmGridHtml(markingConfig())}</div>
            <div class="row"><button class="ghost" id="sMmReset">Revino la implicit</button></div>
          </div>`)}
        ${ws ? pane("ws", `
          <div class="sec">
            <div class="h">Codul spațiului tău de lucru · ${app.mode === "session" ? "până la închiderea browserului" : "legat de acest browser"}</div>
            <div class="row"><input type="text" class="mono" id="wsCode" readonly value="…" aria-label="Codul spațiului de lucru"><button class="ghost" id="wsCopy">Copiază</button></div>
            <div class="sub">Codul e ca o cheie: cine îl are vede documentele tale.</div>
          </div>
          <div class="sec">
            <div class="h">Continuă dintr-un alt browser</div>
            <div class="row"><input type="text" class="mono" id="wsNew" placeholder="Lipește codul din alt browser" aria-label="Cod din alt browser"><button class="ghost" id="wsUse">Folosește</button></div>
            <div class="sub">Documentele deschise cu codul vechi rămân la codul vechi.</div>
          </div>`) : ""}
      </div>
    </div>
    <div class="foot">
      <label class="chk sdef" style="flex:1"><input type="checkbox" id="sDef"> Folosește stilul ca implicit pentru documente noi</label>
      <span class="sub snote" style="flex:1" hidden>Modificările din această secțiune sunt deja salvate.</span>
      <button class="ghost" data-close>Închide</button><button class="primary" id="sSave" disabled>Aplică</button></div>`);
  const pending = {};
  const $d = (sel) => dlg.querySelector(sel);
  const textsChanged = () => $d("#sRev").value.trim() !== String(S.revNo) || $d("#sAuth").value.trim() !== (S.author || "") || $d("#sScale").value.trim() !== fmtNum(S.scale, ",", 4);
  const dirty = () => Object.keys(pending).some((k) => String(pending[k]) !== String(S[k] ?? ({ dlang: "ro", autoRev: true }[k] ?? ""))) || textsChanged();
  const updFoot = () => {
    const doc = PANES.find((p) => p.id === cur).doc;
    $d(".sdef").hidden = !doc;
    $d(".snote").hidden = doc;
    $d("#sSave").disabled = !(dirty() || $d("#sDef").checked);
    $d("#sSave").textContent = dirty() ? "Aplică modificările" : "Aplică";
  };
  const preview = () => drawStylePreview($d("#sPrev"), { ...S, ...pending }, app.measure);
  const show = (id, focus = false) => {
    cur = id;
    try {
      localStorage.setItem("cotare.stab", id);
    } catch (_) { /* storage unavailable */ }
    dlg.querySelectorAll("[data-stab]").forEach((t) => {
      const on = t.dataset.stab === id;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
      if (on) t.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    dlg.querySelectorAll(".spane").forEach((p) => { p.hidden = p.id !== `spane-${id}`; });
    if (id === "style") preview();
    updFoot();
  };
  dlg.querySelectorAll("[data-stab]").forEach((t) => {
    t.addEventListener("click", () => show(t.dataset.stab));
    t.addEventListener("keydown", (e) => {
      const ids = PANES.map((p) => p.id);
      const i = ids.indexOf(cur);
      let j = -1;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % ids.length;
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + ids.length) % ids.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = ids.length - 1;
      if (j < 0) return;
      e.preventDefault();
      show(ids[j], true);
    });
  });
  dlg.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.set;
    let v = b.dataset.v;
    if (["textH", "arrowLen", "lineW"].includes(k)) v = Number(v);
    if (k === "codeSpace") v = v === "true";
    pending[k] = v;
    dlg.querySelectorAll(`[data-set="${k}"]`).forEach((x) => x.classList.toggle("on", x === b));
    if (cur === "style") preview();
    updFoot();
  }));
  for (const id of ["#sRev", "#sAuth", "#sScale"]) $d(id).addEventListener("input", updFoot);
  $d("#sAutoRev").addEventListener("change", () => {
    pending.autoRev = $d("#sAutoRev").checked;
    updFoot();
  });
  $d("#sDef").addEventListener("change", updFoot);
  if ($d("#wsCode")) {
    api.workspace().then((w) => { $d("#wsCode").value = w.code || ""; }).catch(() => {});
    $d("#wsCopy").addEventListener("click", async () => {
      const inp = $d("#wsCode");
      try {
        await navigator.clipboard.writeText(inp.value);
        toast("Cod copiat");
      } catch (_) {
        inp.select();
        toast("Selectat: apasă Ctrl+C");
      }
    });
    $d("#wsUse").addEventListener("click", async () => {
      const code = $d("#wsNew").value.trim();
      try {
        await api.useWorkspace(code);
        localStorage.removeItem("cotare.lastDoc");
        location.reload();
      } catch (e) {
        toast(e.message);
      }
    });
  }
  $d("#sKeys").addEventListener("click", () => keysDialog(app));
  dlg.querySelectorAll("[data-theme-set]").forEach((b) => b.addEventListener("click", () => {
    app.applyTheme(b.dataset.themeSet);
    dlg.querySelectorAll("[data-theme-set]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  dlg.querySelectorAll("[data-uilang]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.uilang === uiLang()) return;
    setLang(b.dataset.uilang);
    location.reload();
  }));
  // the rail and the radial menu: saved at once, for all documents
  const railSave = () => {
    const c = app.railCfg();
    c.labels = $d("#sRailLbl").checked;
    c.hover = $d("#sRailHover").checked;
    c.hidden = [...dlg.querySelectorAll("#sRailFams [data-fam]")].filter((x) => !x.checked).map((x) => x.dataset.fam);
    app.saveRailCfg(c);
    app.buildToolbar();
  };
  $d("#sRailLbl").addEventListener("change", railSave);
  $d("#sRailHover").addEventListener("change", railSave);
  dlg.querySelectorAll("#sRailFams [data-fam]").forEach((x) => x.addEventListener("change", railSave));
  const mmSave = () => {
    const mm = [...dlg.querySelectorAll("#sMm select")].sort((p, q) => p.dataset.i - q.dataset.i).map((x) => x.value);
    try {
      if (mm.length === 8) localStorage.setItem("cotare.mmenu", JSON.stringify(mm));
    } catch (_) { /* storage unavailable */ }
  };
  $d("#sMm").addEventListener("change", mmSave);
  $d("#sMmReset").addEventListener("click", () => {
    $d("#sMm").innerHTML = mmGridHtml(MM_DEFAULT);
    mmSave();
    toast("Meniul radial a revenit la implicit");
  });
  $d("#sSave").addEventListener("click", () => {
    pending.revNo = $d("#sRev").value.trim() || "1";
    pending.author = $d("#sAuth").value.trim();
    const sc = parseNum($d("#sScale").value);
    if (sc && sc > 0) pending.scale = sc;
    app.setSettings(pending);
    if ($d("#sDef").checked) {
      // the style only: not this document's scale or revision
      const { scale, revNo, exportedRev, ...style } = { ...app.settings };
      void scale;
      void revNo;
      void exportedRev;
      try {
        localStorage.setItem("cotare.defaults", JSON.stringify(style));
      } catch (_) { /* storage unavailable */ }
    }
    closeModal();
  });
  show(cur);
  setTimeout(() => $d(`[data-stab="${cur}"]`).focus(), 0);
}

// ------------------------------------------------------------------ revision compare (V12-6)
/** Which older revision to lay under the current page: a document from the list, or a PDF uploaded now. */
export async function compareDialog(app) {
  let docs = [];
  try {
    docs = (await api.listDocs()).filter((d) => d.id !== app.doc.id);
  } catch (_) { /* no list */ }
  let chosen = docs[0] ? docs[0].id : null;
  const dlg = showModal(`
    <h2>Compară cu altă revizie</h2>
    <div class="sub">Pagina ${app.page + 1} din ${esc(app.doc.name)} (revizia nouă) peste o pagină dintr-un desen mai vechi.</div>
    <div class="lbl">Revizia veche</div>
    <div class="cmplist" id="cmpList">${docs.slice(0, 30).map((d) => `<label class="cmpitem"><input type="radio" name="cmpDoc" value="${d.id}" ${d.id === chosen ? "checked" : ""}>
      <span translate="no">${esc(d.name)}</span><span class="sub">${(d.pages || []).length} pag. · ${ago(d.updated)}</span></label>`).join("") || `<div class="note">Niciun alt document pe server. Încarcă revizia veche (PDF sau scan).</div>`}</div>
    <div class="row"><button class="ghost" id="cmpUp">Încarcă revizia veche…</button><input type="file" id="cmpFile" accept=".pdf,application/pdf,image/*" hidden>
      <div class="field" style="max-width:120px"><label for="cmpPage">Pagina din cea veche</label><input type="text" class="mono" id="cmpPage" value="${app.page + 1}"></div></div>
    <label class="chk"><input type="checkbox" id="cmpAnn" checked> Cu adnotările DrawCAD (cote, revizii, indicator…), ca în export</label>
    <label class="chk"><input type="checkbox" id="cmpAlign" checked> Aliniază automat (un export decalat cu câțiva milimetri nu apare ca modificare)</label>
    <label class="chk"><input type="checkbox" id="cmpTwo"> Aliniază cu două puncte (revizia veche e la altă scară sau rotită): alegi două puncte pe pagina deschisă, apoi aceleași două pe cea veche</label>
    <div class="foot"><span class="muted" id="cmpMsg"></span><button class="ghost" data-close>Anulează</button><button class="primary" id="cmpGo" ${chosen ? "" : "disabled"}>Compară</button></div>`);
  const pick = () => {
    const r = dlg.querySelector("[name=cmpDoc]:checked");
    chosen = r ? r.value : chosen;
    dlg.querySelector("#cmpGo").disabled = !chosen;
  };
  dlg.querySelectorAll("[name=cmpDoc]").forEach((r) => r.addEventListener("change", pick));
  dlg.querySelector("#cmpUp").addEventListener("click", () => dlg.querySelector("#cmpFile").click());
  dlg.querySelector("#cmpFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    dlg.querySelector("#cmpMsg").textContent = "Se încarcă…";
    try {
      const meta = await api.openFile(f);
      docs = [meta, ...docs];
      chosen = meta.id;
      dlg.querySelector("#cmpList").insertAdjacentHTML("afterbegin", `<label class="cmpitem"><input type="radio" name="cmpDoc" value="${meta.id}" checked><span translate="no">${esc(meta.name)}</span><span class="sub">${meta.pages.length} pag.</span></label>`);
      dlg.querySelectorAll("[name=cmpDoc]").forEach((r) => r.addEventListener("change", pick));
      dlg.querySelector("#cmpMsg").textContent = "";
      pick();
    } catch (err) {
      dlg.querySelector("#cmpMsg").textContent = err.message;
    }
  });
  dlg.querySelector("#cmpGo").addEventListener("click", () => {
    const d = docs.find((x) => x.id === chosen);
    if (!d) return;
    const n = Math.max(1, Math.min((d.pages || []).length || 1, parseInt(dlg.querySelector("#cmpPage").value, 10) || 1));
    const align = dlg.querySelector("#cmpAlign").checked;
    const withAnn = dlg.querySelector("#cmpAnn").checked;
    const two = dlg.querySelector("#cmpTwo").checked;
    closeModal();
    if (two) app.startCompareAlign(d.id, n - 1, d.name, withAnn, align);
    else app.runCompare(d.id, n - 1, align, d.name, withAnn);
  });
}

// ------------------------------------------------------------------ stamps (V12-5)
// the words are drawing text: they follow the document's drawing language (settings.dlang)
export const STAMP_PRESETS = {
  ro: [["APROBAT", "stGreen"], ["VERIFICAT", "stBlue"], ["PENTRU EXECUȚIE", "stGreen"], ["PRELIMINAR", "stBlue"], ["ANULAT", "stRed"], ["COPIE NECONTROLATĂ", "stRed"]],
  en: [["APPROVED", "stGreen"], ["CHECKED", "stBlue"], ["FOR PRODUCTION", "stGreen"], ["PRELIMINARY", "stBlue"], ["VOID", "stRed"], ["UNCONTROLLED COPY", "stRed"]],
};
const STAMP_SW = { stRed: "var(--stamp-red)", stGreen: "var(--stamp-green)", stBlue: "var(--stamp-blue)" };

/** Which stamp the tool places: the usual ones, plus the user's own (kept in the browser). */
export function stampDialog(app) {
  let chosen = false;
  const render = () => {
    const mine = app.stampLib();
    const btn = (t, c, i = null) => `<span class="stampopt"><button class="ghost stampbtn" data-st="${esc(t)}" data-sc="${c}" style="color:${STAMP_SW[c]};border-color:${STAMP_SW[c]}">${esc(t)}</button>${i != null ? `<button class="icon" data-stdel="${i}" aria-label="Șterge ${esc(t)}" title="Șterge">×</button>` : ""}</span>`;
    const dlg = showModal(`
      <h2>Ștampilă</h2>
      <div class="lbl">Uzuale</div>
      <div class="stamps" translate="no">${STAMP_PRESETS[app.settings.dlang === "en" ? "en" : "ro"].map(([t, c]) => btn(t, c)).join("")}</div>
      <div class="lbl">Ale tale</div>
      <div class="stamps">${mine.map((x, i) => btn(x.text, x.color, i)).join("") || `<span class="sub">Nicio ștampilă proprie încă.</span>`}</div>
      <div class="row"><div class="field"><label for="stNew">Ștampilă nouă</label><input type="text" id="stNew" maxlength="40" placeholder="ex.: CONFORM CU ORIGINALUL"></div>
        <div class="seg" id="stCol">${["stRed", "stGreen", "stBlue"].map((c, i) => `<button data-c="${c}" class="${i === 0 ? "on" : ""}" aria-label="${["Roșu", "Verde", "Albastru"][i]}"><span class="swatch" style="background:${STAMP_SW[c]}"></span></button>`).join("")}</div>
        <button class="ghost" id="stAdd" style="align-self:flex-end">Adaugă</button></div>
      <div class="sub">Data și numele tău (Setări → Foaie și revizii) apar sub text; le schimbi din panou după ce ai pus-o.</div>
      <div class="foot"><button class="ghost" data-close>Închide</button></div>`);
    let col = "stRed";
    dlg.querySelectorAll("#stCol [data-c]").forEach((b) => b.addEventListener("click", () => {
      col = b.dataset.c;
      dlg.querySelectorAll("#stCol [data-c]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    dlg.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => {
      app.stampChoice = { text: b.dataset.st, color: b.dataset.sc };
      chosen = true;
      closeModal();
      app.setHint(TOOLS.find((t) => t.id === "stamp").hint);
    }));
    dlg.querySelectorAll("[data-stdel]").forEach((b) => b.addEventListener("click", () => {
      const list = app.stampLib();
      list.splice(Number(b.dataset.stdel), 1);
      app.saveStampLib(list);
      render();
    }));
    dlg.querySelector("#stAdd").addEventListener("click", () => {
      const t = dlg.querySelector("#stNew").value.trim().toUpperCase();
      if (!t) return;
      app.saveStampLib([...app.stampLib(), { text: t.slice(0, 40), color: col }]);
      render();
    });
  };
  render();
  const obs = new MutationObserver(() => {
    if (modal().hidden) {
      obs.disconnect();
      if (!chosen && app.tool === "stamp") app.setTool("select");
    }
  });
  obs.observe(modal(), { attributes: true, attributeFilter: ["hidden"] });
}

// ------------------------------------------------------------------ title blocks (V12-3)
const readDataUrl = (file) => new Promise((ok, bad) => {
  const fr = new FileReader();
  fr.onload = () => ok(fr.result);
  fr.onerror = bad;
  fr.readAsDataURL(file);
});
const imageSize = (url) => new Promise((ok) => {
  const im = new Image();
  im.onload = () => ok([im.naturalWidth, im.naturalHeight]);
  im.onerror = () => ok([0, 0]);
  im.src = url;
});
const tbId = () => `tb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The browser's title block library: place, generate (ISO 7200), make from the selection, rename,
 * duplicate, export / import as .drawcad-tb.json, delete. pick: opened by the tool, to choose one. */
export function tblockDialog(app, opts = {}) {
  const lib = () => app.tblockLib();
  const nSel = app.selectedAll().filter((a) => a.page === app.page && ["shape", "text", "image"].includes(a.type)).length;
  const render = () => {
    const list = lib();
    const rows = list.map((t, i) => `<div class="tbrow">
        <div class="tbname"><b>${esc(t.name)}</b><span class="sub">${fmtNum(t.w, ",", 1)} × ${fmtNum(t.h, ",", 1)} mm${t.logo ? " · logo" : ""} · ${templateFields(t).length} câmpuri</span></div>
        <button class="primary" data-tbput="${i}">Pune pe desen</button>
        <button class="ghost" data-tbren="${i}">Redenumește</button>
        <button class="ghost" data-tbdup="${i}">Duplică</button>
        <button class="ghost" data-tbexp="${i}">Exportă</button>
        <button class="ghost danger" data-tbdel="${i}" aria-label="Șterge ${esc(t.name)}">Șterge</button></div>`).join("");
    const dlg = showModal(`
      <h2>Indicatoare</h2>
      <div class="sub">Șabloanele stau în acest browser. Le muți pe alt calculator cu Exportă / Importă.</div>
      <div class="tblist">${rows || `<div class="note">Niciun indicator încă. Începe cu unul după ISO 7200 sau desenează-l cu linii și texte, selectează-l și alege „Din selecție”.</div>`}</div>
      <div class="row"><button class="ghost" id="tbNew">Nou după ISO 7200…</button>
        <button class="ghost" id="tbSel" ${nSel ? "" : `disabled title="Selectează întâi liniile, textele și imaginea indicatorului"`}>Din selecție (${nSel})</button>
        <button class="ghost" id="tbImp">Importă…</button>
        <input type="file" id="tbFile" accept=".json,application/json" hidden></div>
      <div class="sub">În texte, câmpurile se scriu între acolade: {titlu}, {nr_desen}, {material}, {masa}, {tol}, {autor}, {verificat}, {aprobat}, {firma}; {rev}, {data}, {scara}, {format} și {foaia} se completează singure.</div>
      <div class="foot"><button class="ghost" data-close>Închide</button></div>`);
    const save = (list2) => {
      app.saveTblockLib(list2);
      render();
    };
    dlg.querySelectorAll("[data-tbput]").forEach((b) => b.addEventListener("click", () => {
      app.tblockTpl = lib()[Number(b.dataset.tbput)];
      closeModal();
      if (app.tool === "tblock") app.setHint(TOOLS.find((t) => t.id === "tblock").hint);
      else app.setTool("tblock");
    }));
    dlg.querySelectorAll("[data-tbren]").forEach((b) => b.addEventListener("click", () => {
      const list2 = lib();
      const t = list2[Number(b.dataset.tbren)];
      const name = window.prompt("Numele indicatorului", t.name);
      if (name && name.trim()) {
        t.name = name.trim().slice(0, 80);
        save(list2);
      }
    }));
    dlg.querySelectorAll("[data-tbdup]").forEach((b) => b.addEventListener("click", () => {
      const list2 = lib();
      const t = JSON.parse(JSON.stringify(list2[Number(b.dataset.tbdup)]));
      t.id = tbId();
      t.name = `${t.name} (copie)`;
      list2.push(t);
      save(list2);
    }));
    dlg.querySelectorAll("[data-tbexp]").forEach((b) => b.addEventListener("click", async () => {
      const t = { ...lib()[Number(b.dataset.tbexp)] };
      delete t.id;
      const blob = new Blob([JSON.stringify(t, null, 1)], { type: "application/json" });
      const safe = t.name.replace(/[\\/:*?<>|\u0022]+/g, "_");
      await saveBlob(blob, `${safe}.drawcad-tb.json`);
    }));
    dlg.querySelectorAll("[data-tbdel]").forEach((b) => b.addEventListener("click", () => {
      const list2 = lib();
      const t = list2[Number(b.dataset.tbdel)];
      if (!window.confirm(`Ștergi indicatorul „${t.name}” din bibliotecă? Desenele pe care e pus nu se schimbă.`)) return;
      list2.splice(Number(b.dataset.tbdel), 1);
      save(list2);
    }));
    dlg.querySelector("#tbNew").addEventListener("click", () => tblockGenerator(app, () => tblockDialog(app, opts)));
    dlg.querySelector("#tbSel").addEventListener("click", async () => {
      const name = window.prompt("Numele indicatorului", "Indicatorul meu");
      if (!name) return;
      const t = await app.tblockFromSelection(name.trim().slice(0, 80));
      if (!t) {
        toast("În selecție nu sunt linii sau texte.");
        return;
      }
      t.id = tbId();
      save([...lib(), t]);
      toast(`Indicator salvat: ${t.name} (${templateFields(t).length} câmpuri)`);
    });
    dlg.querySelector("#tbImp").addEventListener("click", () => dlg.querySelector("#tbFile").click());
    dlg.querySelector("#tbFile").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        if (f.size > 600 * 1024) throw new Error("fișier prea mare");
        const t = cleanTemplate(JSON.parse(await f.text()));
        if (!t || !(t.lines.length || t.texts.length)) throw new Error("nu e un indicator DrawCAD");
        t.id = tbId();
        save([...lib(), t]);
        toast(`Importat: ${t.name}`);
      } catch (err) {
        toast(`Nu s-a putut importa: ${err.message}`, 6000);
      }
    });
  };
  render();
  // opened by the tool and closed without choosing: back to Select
  if (opts.pick) {
    const obs = new MutationObserver(() => {
      if (modal().hidden) {
        obs.disconnect();
        if (app.tool === "tblock" && !app.tblockTpl) app.setTool("select");
      }
    });
    obs.observe(modal(), { attributes: true, attributeFilter: ["hidden"] });
  }
}

/** A new title block after ISO 7200: name, language of the labels, the owner (company) or a logo. */
function tblockGenerator(app, back) {
  let logo = null;
  const dlg = showModal(`
    <h2>Indicator nou după ISO 7200</h2>
    <div class="sub">180 mm lățime, 40 mm înălțime: Desenat / Verificat / Aprobat și proprietarul, denumirea, materialul, masa, toleranțele generale, nr. desen, revizia, foaia, scara, formatul și data.</div>
    <div class="row"><div class="field"><label for="tgName">Nume</label><input type="text" id="tgName" value="ISO 7200"></div>
      <div class="field"><span class="lbl">Limba etichetelor</span><div class="seg" id="tgLang">
        <button data-l="ro" class="${(app.settings.dlang || "ro") === "ro" ? "on" : ""}" translate="no">Română</button><button data-l="en" class="${app.settings.dlang === "en" ? "on" : ""}" translate="no">English</button></div></div></div>
    <div class="field"><label for="tgComp">Firmă (în locul logo-ului; gol = câmpul {firma})</label><input type="text" id="tgComp" value=""></div>
    <div class="row"><button class="ghost" id="tgLogoBtn">Logo (PNG / JPG, max. 300 kB)…</button><span class="sub" id="tgLogoInfo">fără logo</span>
      <input type="file" id="tgLogo" accept="image/png,image/jpeg,image/webp" hidden></div>
    <div class="foot"><button class="ghost" id="tgBack">Înapoi</button><button class="primary" id="tgMake">Creează</button></div>`);
  let lang = app.settings.dlang === "en" ? "en" : "ro";
  dlg.querySelectorAll("#tgLang [data-l]").forEach((b) => b.addEventListener("click", () => {
    lang = b.dataset.l;
    dlg.querySelectorAll("#tgLang [data-l]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  dlg.querySelector("#tgLogoBtn").addEventListener("click", () => dlg.querySelector("#tgLogo").click());
  dlg.querySelector("#tgLogo").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 300 * 1024) {
      dlg.querySelector("#tgLogoInfo").textContent = "Prea mare: peste 300 kB";
      return;
    }
    const data = await readDataUrl(f);
    const [w, h] = await imageSize(data);
    if (!w) {
      dlg.querySelector("#tgLogoInfo").textContent = "Imagine necitibilă";
      return;
    }
    logo = { data, w, h };
    dlg.querySelector("#tgLogoInfo").textContent = `${f.name} · ${w} × ${h} px`;
  });
  dlg.querySelector("#tgBack").addEventListener("click", back);
  dlg.querySelector("#tgMake").addEventListener("click", () => {
    const t = isoTemplate({ name: dlg.querySelector("#tgName").value.trim() || "ISO 7200", lang, company: dlg.querySelector("#tgComp").value.trim(), logo });
    t.id = tbId();
    if (app.saveTblockLib([...app.tblockLib(), t])) toast(`Indicator creat: ${t.name}`);
    back();
  });
}

// ------------------------------------------------------------------ keys and commands
/** F2: the session's commands, typed points, options and answers, newest at the bottom. */
export function historyDialog(app) {
  const log = app.cmdLog || [];
  const pad = (n) => String(n).padStart(2, "0");
  const rows = log.map((r) => `<div><span class="tm">${pad(r.t.getHours())}:${pad(r.t.getMinutes())}:${pad(r.t.getSeconds())}</span> ${esc(r.text)}</div>`).join("");
  const dlg = showModal(`
    <h2>Istoricul comenzilor</h2>
    <div class="histlog" id="hLog">${rows || `<span class="muted">Nicio comandă în această sesiune.</span>`}</div>
    <div class="foot"><span class="muted" style="flex:1">F2 închide · ↑ / ↓ în linia de comandă reiau comenzile</span><button class="primary" data-close>Închide</button></div>`);
  const box = dlg.querySelector("#hLog");
  box.scrollTop = box.scrollHeight;
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "F2") {
      e.preventDefault();
      closeModal();
    }
  });
}

// ------------------------------------------------------------------ command search, shortcut sheet, tips (UI-D9, UI-D14)
const SETTINGS_PAGES = [
  ["style", "Stil cote", "înălțime text săgeți separator zecimal afișare ISO 286"],
  ["sheet", "Foaie și revizii", "scară revizie nume toleranțe generale ISO 2768 limba desenului"],
  ["ui", "Interfață", "limbă bara de unelte etichete temă"],
  ["cmds", "Comenzi și meniu", "taste directe comenzi AutoCAD meniu radial"],
];

/** Ctrl+K: finds a tool, an action or a settings page by name (Romanian or English), alias or what it
 *  does; ↑ ↓ Enter runs it, Esc closes. */
export function commandSearch(app) {
  const cfg = keyConfig();
  const extra = SETTINGS_PAGES.map(([id, label, desc]) => ({ id: `settings:${id}`, kind: "settings", label: `Setări → ${label}`, group: "Setări", key: "", aliases: [], desc }));
  const dlg = showModal(`
    <div class="palette">
      <input type="search" id="pkQ" class="pk" placeholder="Caută o comandă: cotă, rază, DLI, export, scară…" autocomplete="off" spellcheck="false" aria-label="Caută o comandă">
      <div class="pklist" id="pkList" role="listbox"></div>
      <div class="pkfoot muted">↑ ↓ alege · Enter pornește · Esc închide · <button class="link" id="pkSheet">Toate tastele (?)</button></div>
    </div>`);
  const q = dlg.querySelector("#pkQ");
  const list = dlg.querySelector("#pkList");
  let items = [];
  let sel = 0;
  const run = (c) => {
    closeModal();
    if (c.kind === "settings") settingsDialog(app, c.id.slice(9));
    else app.runCommand(c.id);
  };
  const draw = () => {
    const t = q.value.trim();
    items = t ? searchCommands(t, cfg, { extra, en: EN, max: 10 }) : [];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((c, i) => {
      const tool = TOOL_BY_ID[c.id];
      const icon = tool ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${tool.icon}"/></svg>` : `<span class="pkdot" aria-hidden="true"></span>`;
      return `<button class="pkrow${i === sel ? " on" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}">${icon}<span class="pkl">${esc(c.label)}</span><span class="pkg">${esc(c.group || "")}</span>${c.aliases[0] ? `<i class="mono">${esc(c.aliases[0])}</i>` : ""}${c.key ? `<kbd class="mono">${esc(c.key)}</kbd>` : ""}</button>`;
    }).join("") || (t ? `<div class="pkempty muted">Nicio comandă pentru „${esc(t)}”.</div>` : `<div class="pkempty muted">Scrie numele uneltei (în română sau engleză), prescurtarea AutoCAD sau ce vrei să faci.</div>`);
    list.querySelectorAll(".pkrow").forEach((b) => b.addEventListener("click", () => run(items[Number(b.dataset.i)])));
  };
  q.addEventListener("input", () => {
    sel = 0;
    draw();
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === "Enter" && items[sel]) {
      e.preventDefault();
      run(items[sel]);
    }
  });
  dlg.querySelector("#pkSheet").addEventListener("click", () => shortcutSheet(app));
  draw();
}

/** The keys that are not a tool's (shared by the start screen and the shortcut sheet). */
export function generalKeysHtml(ac) {
  return `${ac ? "comanda + <b>Spațiu</b> / <b>Enter</b> · Spațiu sau Enter singur <b>repetă</b> · <b>U</b> anulează · <b>Z</b> potrivește · <b>E</b> cu selecție șterge" : "<b>Enter</b> linie de comandă (L, C, DLI…) · <b>Enter</b> termină polilinia"} · <b>ALIASEDIT</b> sau Setări → Taste și comenzi<br>
      <b>Ctrl+K</b> caută o comandă · <b>?</b> sau <b>F1</b> toate tastele · <b>F2</b> istoricul comenzilor<br>
      <b>Shift</b> ortho · <b>Alt</b> fără snap · <b>Esc</b> renunță · <b>Del</b> șterge selecția<br>
      <b>Ctrl+C / Ctrl+V</b> copiază / lipește la cursor · <b>Ctrl+D</b> duplică · <b>Ctrl+A</b> selectează tot · <b>Ctrl+F</b> caută text / OCR<br>
      <b>Shift+click</b> sau dreptunghi pe zonă goală = selecție multiplă · <b>săgeți</b> mută 0,5 mm<br>
      <b>Ctrl+Z / Ctrl+Y</b> anulează / refă · <b>F</b> potrivește · <b>Shift+F</b> zoom pe selecție · <b>dublu-click</b> editează · rotița = zoom · Space+tragere = mută`;
}

/** ? / F1: every tool by family with its key and commands, the general keys, a filter. */
export function shortcutSheet(app) {
  const cfg = keyConfig();
  const ac = cfg.mode === "autocad";
  const cl = Object.fromEntries(commandList(cfg).map((c) => [c.id, c]));
  const row = (c) => `<div class="ssrow" data-q="${esc(`${c.label} ${EN[c.label] || ""} ${c.aliases.join(" ")}`.toLowerCase())}"><span>${esc(c.label)}</span><i class="mono">${esc(c.aliases.slice(0, 2).join(" · "))}</i>${!ac && c.key ? `<kbd class="mono">${esc(c.key)}</kbd>` : "<kbd></kbd>"}</div>`;
  const fams = FAMILIES.map((f) => `<div class="ssfam"><div class="ssh">${esc(f.label)}</div>${f.tools.map((id) => cl[id] && row(cl[id])).filter(Boolean).join("")}</div>`).join("");
  const acts = commandList(cfg).filter((c) => c.kind === "action");
  const dlg = showModal(`
    <h2>Taste și comenzi${ac ? " · comenzi AutoCAD" : ""}</h2>
    <div class="field"><label for="ssQ">Filtrează</label><input type="search" id="ssQ" placeholder="ex.: cerc, DLI, rază" autocomplete="off"></div>
    <div class="sheetgrid" id="ssGrid">${fams}<div class="ssfam"><div class="ssh">Comenzi</div>${acts.map(row).join("")}</div></div>
    <div class="keys">${generalKeysHtml(ac)}</div>
    <div class="foot"><button class="ghost" id="ssTips">Arată din nou sfaturile</button><button class="ghost" id="ssKeys">Schimbă tastele…</button><span class="muted" style="flex:1"></span><button class="primary" data-close>Închide</button></div>`, (e) => {
    if (e.key === "F1") {
      e.preventDefault();
      closeModal();
    }
  });
  dlg.querySelector("#ssQ").addEventListener("input", (e) => {
    const v = e.target.value.trim().toLowerCase();
    dlg.querySelectorAll(".ssrow").forEach((r) => { r.hidden = !!v && !r.dataset.q.includes(v); });
    dlg.querySelectorAll(".ssfam").forEach((f) => { f.hidden = !f.querySelector(".ssrow:not([hidden])"); });
  });
  dlg.querySelector("#ssKeys").addEventListener("click", () => keysDialog(app));
  dlg.querySelector("#ssTips").addEventListener("click", () => {
    closeModal();
    firstRunTips(true);
  });
}

const TIPS_KEY = "drawcad.tips";
const TIPS = [
  ["tools", "right", "Uneltele sunt grupate pe familii. Un click pornește unealta afișată și deschide lista familiei; ultima folosită rămâne pe buton."],
  ["cmdIn", "top", "Linia de comandă: scrii comenzi ca în AutoCAD (DLI, L, C…), puncte (10,20 sau @30<45) și opțiuni. Ctrl+K caută orice comandă după nume."],
  ["panelWrap", "left", "Proprietățile selecției: valoarea, toleranța, mărimea. Straturile și lista adnotărilor sunt în tab-urile de sus. ? arată toate tastele."],
];

/** First document opened: three tips (rail, command line, panel), one after the other, shown once.
 *  `again` shows them even if they were seen. Bubbles next to their target, not modal. */
export function firstRunTips(again = false) {
  // on a phone the rail is a bar at the bottom and the panel a drawer: the tips would point at nothing
  if (!again && window.innerWidth < 700) return;
  try {
    if (!again && localStorage.getItem(TIPS_KEY)) return;
    localStorage.setItem(TIPS_KEY, "1");
  } catch (_) {
    if (!again) return;
  }
  let i = 0;
  let bub = null;
  const close = () => {
    if (bub) bub.remove();
    bub = null;
    window.removeEventListener("resize", place);
  };
  function place() {
    if (!bub) return;
    const [id, side] = TIPS[i];
    const t = document.getElementById(id);
    const r = t ? t.getBoundingClientRect() : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2, width: 0, height: 0 };
    const b = bub.getBoundingClientRect();
    let x;
    let y;
    if (side === "right") [x, y] = [r.right + 12, r.top + Math.min(r.height / 3, 160)];
    else if (side === "left") [x, y] = [r.left - b.width - 12, r.top + 80];
    else [x, y] = [r.left + 24, r.top - b.height - 12];
    bub.style.left = `${Math.max(8, Math.min(innerWidth - b.width - 8, x)) + scrollX}px`;
    bub.style.top = `${Math.max(8, Math.min(innerHeight - b.height - 8, y)) + scrollY}px`;
    bub.dataset.side = side;
  }
  const show = () => {
    close();
    if (i >= TIPS.length) return;
    bub = document.createElement("div");
    bub.className = "tipbub";
    bub.setAttribute("role", "dialog");
    bub.setAttribute("aria-label", "Sfat");
    bub.innerHTML = `<div class="tipn mono">${i + 1} / ${TIPS.length}</div><p>${esc(TIPS[i][2])}</p>
      <div class="btns"><button class="ghost" data-tip="skip">${i + 1 < TIPS.length ? "Sari peste" : ""}</button><button class="primary" data-tip="ok">Am înțeles</button></div>`;
    if (i + 1 >= TIPS.length) bub.querySelector('[data-tip="skip"]').remove();
    document.body.append(bub);
    place();
    window.addEventListener("resize", place);
    bub.querySelector('[data-tip="ok"]').addEventListener("click", () => {
      i += 1;
      show();
    });
    const sk = bub.querySelector('[data-tip="skip"]');
    if (sk) sk.addEventListener("click", close);
    bub.querySelector('[data-tip="ok"]').focus();
    bub.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      e.stopPropagation();
    });
  };
  show();
}

export function keysDialog(app) {
  let cfg = JSON.parse(JSON.stringify(keyConfig()));
  const rowsHtml = () => {
    let html = "";
    let group = "";
    for (const c of commandList(cfg)) {
      if (c.group !== group) {
        group = c.group;
        html += `<tr><td class="g" colspan="3">${esc(group)}</td></tr>`;
      }
      html += `<tr data-id="${c.id}" data-q="${esc(`${c.label} ${c.aliases.join(" ")} ${c.key}`.toLowerCase())}">
        <td>${esc(c.label)}</td>
        <td>${c.kind === "tool" ? `<input type="text" class="mono k" maxlength="1" value="${esc(c.key)}" aria-label="Tasta pentru ${esc(c.label)}">` : `<span class="muted">—</span>`}</td>
        <td><input type="text" class="mono al" value="${esc(c.aliases.join(", "))}" aria-label="Comenzile pentru ${esc(c.label)}"></td></tr>`;
    }
    return html;
  };
  const dlg = showModal(`
    <h2>Taste și comenzi</h2>
    <div class="seg" id="kMode" style="margin-bottom:8px">
      <button data-mode="direct" class="${cfg.mode === "direct" ? "on" : ""}">Taste directe</button>
      <button data-mode="autocad" class="${cfg.mode === "autocad" ? "on" : ""}">Comenzi AutoCAD</button></div>
    <div class="note" id="kHelp"></div>
    <label class="chk" id="kPickRow" style="margin-top:8px"><input type="checkbox" id="kPick" ${cfg.pickadd ? "checked" : ""}> Selecție ca în AutoCAD: click adaugă la selecție, Shift+click scoate</label>
    <div class="field" style="margin-top:8px"><label for="kQ">Caută</label><input type="search" id="kQ" placeholder="ex.: cerc, DLI, rază"></div>
    <div class="keytab"><table><thead><tr><th>Comandă</th><th>Tastă</th><th>Prescurtări (despărțite prin virgulă)</th></tr></thead><tbody id="kRows">${rowsHtml()}</tbody></table></div>
    <div class="note" id="kImp" hidden></div>
    <div class="foot"><span class="muted" id="kMsg" style="flex:1"></span><input type="file" id="kPgp" accept=".pgp,.txt,text/plain" hidden><button class="ghost" id="kImport" title="Prescurtările din AutoCAD (fișierul acad.pgp din folderul Support)">Importă acad.pgp…</button><button class="ghost" id="kReset">Revino la implicit</button><button class="ghost" data-close>Anulează</button><button class="primary" id="kSave">Aplică</button></div>`);
  const help = () => {
    dlg.querySelector("#kPickRow").hidden = cfg.mode !== "autocad";
    dlg.querySelector("#kHelp").innerHTML = cfg.mode === "autocad"
      ? "<b>Comenzi AutoCAD:</b> scrii comanda oriunde pe desen (apare jos, în linia de comandă, cu sugestii) și o pornești cu <b>Spațiu</b> sau <b>Enter</b>. Spațiu sau Enter fără nimic scris <b>repetă ultima comandă</b>; la polilinie o termină. Spațiu ținut + tragere mută desenul, Esc renunță. Tastele directe nu se folosesc în acest mod."
      : "<b>Taste directe:</b> o tastă pornește unealta (coloana Tastă). Comenzile din coloana a treia merg și aici: <b>Enter</b> deschide linia de comandă de jos, scrii de exemplu <b class=\"mono\">DLI</b> și dai Spațiu sau Enter.";
  };
  help();
  const read = () => {
    const keys = {};
    const aliases = {};
    dlg.querySelectorAll("#kRows tr[data-id]").forEach((tr) => {
      const id = tr.dataset.id;
      const k = tr.querySelector("input.k");
      const al = tr.querySelector("input.al");
      if (k) {
        const tool = TOOLS.find((t) => t.id === id);
        const v = k.value.trim().toUpperCase();
        if (v !== String((tool && tool.key) || "").toUpperCase()) keys[id] = v;
      }
      const list = [...new Set(al.value.split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9]{1,16}$/.test(x)))];
      const def = (DEFAULT_ALIASES[id] || (ACTIONS.find((a) => a.id === id) || {}).aliases || []).map((x) => x.toUpperCase());
      if (list.join(",") !== def.join(",")) aliases[id] = list;
    });
    return { mode: cfg.mode, keys, aliases, pickadd: dlg.querySelector("#kPick").checked };
  };
  const check = () => {
    cfg = read();
    const bad = conflicts(cfg);
    const msgs = [];
    dlg.querySelectorAll("#kRows input").forEach((x) => x.classList.remove("bad"));
    const mark = (id, sel) => {
      const el = dlg.querySelector(`#kRows tr[data-id="${id}"] ${sel}`);
      if (el) el.classList.add("bad");
    };
    for (const [k, ids] of Object.entries(bad.keys)) {
      ids.forEach((id) => mark(id, "input.k"));
      msgs.push(`tasta ${k}: ${ids.map(labelOf).join(" și ")}`);
    }
    for (const k of bad.reserved) {
      commandList(cfg).filter((c) => c.key === k).forEach((c) => mark(c.id, "input.k"));
      msgs.push(`tasta ${k} e rezervată (F = potrivește, +/− = zoom)`);
    }
    for (const [a, ids] of Object.entries(bad.aliases)) {
      ids.forEach((id) => mark(id, "input.al"));
      msgs.push(`${a}: ${ids.map(labelOf).join(" și ")}`);
    }
    dlg.querySelector("#kMsg").textContent = msgs.length ? `Dubluri — ${msgs.slice(0, 3).join(" · ")}${msgs.length > 3 ? " …" : ""}` : "";
    dlg.querySelector("#kSave").disabled = msgs.length > 0;
  };
  dlg.querySelector("#kRows").addEventListener("input", check);
  dlg.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    cfg.mode = b.dataset.mode;
    dlg.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    help();
  }));
  dlg.querySelector("#kQ").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    dlg.querySelectorAll("#kRows tr").forEach((tr) => {
      tr.hidden = !!q && (!tr.dataset.q || !tr.dataset.q.includes(q));
    });
  });
  dlg.querySelector("#kImport").addEventListener("click", () => dlg.querySelector("#kPgp").click());
  dlg.querySelector("#kPgp").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      toast("Fișierul e prea mare pentru un acad.pgp");
      return;
    }
    // read here, in the browser: nothing is uploaded
    const entries = parsePgp(await f.text());
    const res = importPgp(read(), entries);
    cfg = res.cfg;
    dlg.querySelector("#kRows").innerHTML = rowsHtml();
    check();
    const box = dlg.querySelector("#kImp");
    const moved = res.moved.map((m) => `${m.alias}: ${labelOf(m.from)} → ${labelOf(m.to)}`);
    box.innerHTML = `<b>${esc(f.name)}:</b> <span>${entries.length} prescurtări citite · ${res.added.length} adăugate · ${res.moved.length} mutate de la alte comenzi · ${res.unknown.length} comenzi fără echivalent în DrawCAD${res.invalid.length ? ` · ${res.invalid.length} nume nevalide` : ""}.</span> <span>Nimic nu se salvează până la Aplică.</span>
      ${moved.length ? `<details><summary>Mutate</summary><div class="mono">${esc(moved.join(" · "))}</div></details>` : ""}
      ${res.unknown.length ? `<details><summary>Fără echivalent</summary><div class="mono">${esc(res.unknown.join(", "))}</div></details>` : ""}`;
    box.hidden = false;
  });
  dlg.querySelector("#kReset").addEventListener("click", () => {
    cfg = { ...defaultKeyConfig(), mode: cfg.mode };
    dlg.querySelector("#kPick").checked = false;
    dlg.querySelector("#kRows").innerHTML = rowsHtml();
    check();
  });
  dlg.querySelector("#kSave").addEventListener("click", () => {
    check();
    if (dlg.querySelector("#kSave").disabled) return;
    saveKeyConfig(cfg);
    app.applyKeyCfg(cfg);
    closeModal();
    toast(cfg.mode === "autocad" ? "Comenzi AutoCAD: scrie comanda + Spațiu" : "Taste directe; Enter deschide linia de comandă");
  });
  check();
}

export function storedDefaults() {
  // new documents: drawing texts and the decimal separator follow the UI language
  const byLang = uiLang() === "en" ? { dlang: "en", sep: "." } : { dlang: "ro" };
  try {
    return { ...DEFAULT_SETTINGS, ...byLang, ...JSON.parse(localStorage.getItem("cotare.defaults") || "{}") };
  } catch (_) {
    return { ...DEFAULT_SETTINGS, ...byLang };
  }
}

// ------------------------------------------------------------------ calibration
export function calibDialog(app, paperMm) {
  const dlg = showModal(`
    <h2>Calibrare scară</h2>
    <div class="note">Distanța aleasă măsoară <b class="mono">${fmtNum(paperMm, ",", 3)} mm</b> pe hârtie.</div>
    <div class="field"><label for="cReal">Valoarea reală a cotei (mm)</label><input type="text" id="cReal" class="mono" placeholder="ex.: 50"></div>
    <div class="foot"><span class="muted" id="cOut"></span><button class="ghost" data-close>Anulează</button><button class="primary" id="cOk">Aplică</button></div>`,
  (e) => {
    if (e.key === "Enter") dlg.querySelector("#cOk").click();
  });
  const out = dlg.querySelector("#cOut");
  dlg.querySelector("#cReal").addEventListener("input", (e) => {
    const v = parseNum(e.target.value);
    out.textContent = v ? `scară ${fmtNum(v / paperMm, ",", 4)} (1:${fmtNum(v / paperMm, ",", 2)})` : "";
  });
  const nShapes = app.annots.filter((a) => a.type === "shape").length;
  if (nShapes) {
    dlg.querySelector(".foot").insertAdjacentHTML("beforebegin", `<div class="sec">
      <div class="lbl">Ai ${nShapes} ${nShapes === 1 ? "formă desenată" : "forme desenate"} (linii, cercuri…)</div>
      <div class="cards">
        <button class="card on" data-keep="paper"><b>Rămân pe desen</b><span>Desenate cu snap pe contur: stau pe aceleași linii, dimensiunea lor reală se recalculează.</span></button>
        <button class="card" data-keep="real"><b>Își păstrează dimensiunile reale</b><span>Desenate cu valori scrise (ex. linie de 10): se scalează față de punctul lor de start și rămân 10.</span></button>
      </div></div>`);
  }
  let keep = "paper";
  dlg.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", () => {
    keep = b.dataset.keep;
    dlg.querySelectorAll("[data-keep]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  dlg.querySelector("#cOk").addEventListener("click", () => {
    const v = parseNum(dlg.querySelector("#cReal").value);
    if (!v || v <= 0) return;
    const old = Number(app.settings.scale) || 1;
    const scale = v / paperMm;
    if (keep === "real" && nShapes) app.rescaleShapes(old / scale);
    app.setSettings({ scale });
    closeModal();
    toast(`Scară fixată: ${fmtNum(v / paperMm, ",", 4)} mm reali / mm hârtie`);
  });
}

// ------------------------------------------------------------------ removal from the original
export async function redactDialog(app, annot, isNew) {
  const rect = annot.r;
  let objs = [];
  try {
    objs = (await api.objectsInRect(app.doc.id, annot.page, rect)).objects;
  } catch (e) {
    toast(e.message);
    return;
  }
  let mode = annot.mode || (isNew ? "cover" : "objects");
  // default: objects at least 90% inside the zone (line length or text area)
  const FRAC = 0.9;
  // small letters (AutoCAD texts exported as lines) with their center in the zone are taken whole,
  // even if a tail sticks out of the box (g, p, y…)
  const zx0 = Math.min(rect[0], rect[2]);
  const zx1 = Math.max(rect[0], rect[2]);
  const zy0 = Math.min(rect[1], rect[3]);
  const zy1 = Math.max(rect[1], rect[3]);
  const glyphIn = (o) => {
    const [bx0, by0, bx1, by1] = o.bbox;
    const cx = (bx0 + bx1) / 2;
    const cy = (by0 + by1) / 2;
    return Math.max(bx1 - bx0, by1 - by0) <= 12 * K && Math.min(bx1 - bx0, by1 - by0) >= 0.8 * K && cx >= zx0 && cx <= zx1 && cy >= zy0 && cy <= zy1 && (o.frac ?? 0) >= 0.5;
  };
  const auto = () => objs.filter((o) => !o.locked && (o.inside || (o.frac ?? 0) >= FRAC || glyphIn(o))).map((o) => o.id);
  const ids = new Set(isNew || !annot.ids ? auto() : annot.ids);
  let color = annot.color || COLORS.white;
  let picking = false;
  const label = (o) => {
    if (o.type === "text") return `Text „${esc(o.text || "?")}”`;
    if (o.type === "path") return `Linie / contur · ${o.segments} puncte`;
    if (o.type === "image") return "Imagine";
    return o.type;
  };
  const LOCKED = ["în bloc — doar acoperire", "var(--warn)"];
  const statusOf = (o) => {
    if (mode === "cover") return ["acoperit", "var(--muted)"];
    if (mode === "objects") return o.locked ? LOCKED : ids.has(o.id) ? ["se elimină", "var(--bad)"] : ["rămâne", "var(--ok)"];
    if (mode === "text") return o.type !== "text" ? ["rămâne", "var(--ok)"] : o.locked ? LOCKED : ["se elimină", "var(--bad)"];
    if (o.locked) return LOCKED;
    if (o.type === "text" || o.inside || glyphIn(o)) return ["se elimină", "var(--bad)"];
    if (o.cuttable) return ["tăiat la margine", "var(--accent)"];
    return ["parțial — doar acoperire", "var(--warn)"];
  };
  // in zone mode, what cannot be cut (blocks, fills, images) can be covered with white
  const needsCover = () => objs.some((o) => o.locked || (!o.inside && o.type !== "text" && !o.cuttable));
  let cover = annot.mode === "zone" && annot.cover !== undefined ? annot.cover : needsCover();
  const dlg = showModal(`
    <h2>Șterge din PDF-ul original</h2>
    <div class="sub">Pagina ${annot.page + 1} · zonă ${fmtNum(Math.abs(rect[2] - rect[0]) / K, ",", 1)} × ${fmtNum(Math.abs(rect[3] - rect[1]) / K, ",", 1)} mm · ${objs.length} obiecte găsite</div>
    <div class="cols">
      <div class="sec">
        <div class="row"><div class="field"><span class="lbl">Înainte</span><div class="prevbox"><canvas id="rBefore"></canvas></div></div>
        <div class="field"><span class="lbl">După</span><div class="prevbox"><canvas id="rAfter"></canvas></div></div></div>
        <div class="lbl">Obiecte în zonă (bifează ce se elimină)</div>
        <div class="objlist" id="rList"></div>
      </div>
      <div class="cards">
        <button class="card" data-mode="cover"><b>Acoperă zona</b><span>Un dreptunghi plin peste zonă, alb sau în culoarea fundalului. Nu elimină nimic din fișier.</span></button>
        <div class="coverctl" id="rCoverCtl">
          <span class="lbl">Culoare</span>
          <div class="row"><input type="color" id="rColor" aria-label="Culoarea acoperirii">
            <button class="ghost sw" data-sw="${COLORS.white}" title="Alb" aria-label="Alb"><i style="background:${COLORS.white}"></i></button>
            <button class="ghost sw" data-sw="${COLORS.coverPaper}" title="Hârtie" aria-label="Hârtie"><i style="background:${COLORS.coverPaper}"></i></button>
            <button class="ghost" id="rPick" title="Ia culoarea dintr-un punct al desenului"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5l5 5M17 2l5 5-3 3-5-5zM14 7l-9 9-1 4 4-1 9-9"/></svg> Pipetă</button></div>
          <span class="sub mono" id="rColorTxt"></span>
        </div>
        <button class="card" data-mode="objects"><b>Selecție pe obiecte</b><span>Elimini exact ce bifezi. Implicit sunt bifate obiectele aflate cel puțin 90% în zonă și literele cu centrul în zonă.</span></button>
        <label class="chk" id="rAllRow"><input type="checkbox" id="rAll"> Bifează tot ce atinge zona</label>
        <button class="card" data-mode="text"><b>Doar textul</b><span>Elimină valoarea; liniile de cotă rămân și poți scrie valoarea nouă pe ele.</span></button>
        <button class="card" data-mode="zone"><b>Tot din zonă</b><span>Elimină ce e în zonă și taie liniile care trec prin ea exact la margine (ex. conturul rămâne, cu o întrerupere).</span></button>
        <label class="chk" id="rCoverRow"><input type="checkbox" id="rCover"> Acoperă zona cu alb (pentru ce nu se poate tăia)</label>
        <div class="note">AutoCAD exportă uneori textul ca linii (fonturi SHX): atunci apare ca „Linie / contur”, nu ca text.</div>
        <div class="note" id="rLockNote" hidden>Unele obiecte sunt într-un bloc (Form XObject, ex. indicatorul): nu se pot modifica fără să strice fonturile blocului, deci se pot doar acoperi cu alb.</div>
      </div>
    </div>
    <div class="foot"><span class="muted">Se aplică la export; originalul de pe server rămâne neatins.</span><button class="ghost" data-close>Anulează</button><button class="primary" id="rOk">Aplică</button></div>`);

  const list = dlg.querySelector("#rList");
  const renderList = () => {
    list.innerHTML = objs.length ? objs.map((o) => {
      const [st, col] = statusOf(o);
      return `<label data-oid="${o.id}"><input type="checkbox" ${ids.has(o.id) && !o.locked && mode !== "cover" ? "checked" : ""} ${mode !== "objects" || o.locked ? "disabled" : ""}>
        <span>${label(o)}${o.inside ? "" : ` <span class="muted">(parțial · ${Math.round((o.frac ?? 0) * 100)}% în zonă)</span>`}</span><span class="st" style="color:${col}">${st}</span></label>`;
    }).join("") : `<span class="muted">Niciun obiect vectorial în zonă (pagină scanată?). Folosește Acoperă.</span>`;
    list.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
      const id = cb.closest("label").dataset.oid;
      if (cb.checked) ids.add(id);
      else ids.delete(id);
      renderList();
      schedulePreview();
    }));
    list.querySelectorAll("label").forEach((lb) => {
      lb.addEventListener("mouseenter", () => drawBefore(lb.dataset.oid));
      lb.addEventListener("mouseleave", () => drawBefore(null));
    });
  };
  const coverCb = dlg.querySelector("#rCover");
  coverCb.checked = cover;
  coverCb.addEventListener("change", () => {
    cover = coverCb.checked;
    schedulePreview();
  });
  dlg.querySelector("#rLockNote").hidden = !objs.some((o) => o.locked);
  // ---- cover: color, swatches, eyedropper
  const colorInp = dlg.querySelector("#rColor");
  const setColor = (c) => {
    color = c.toLowerCase();
    colorInp.value = color;
    dlg.querySelector("#rColorTxt").textContent = color === COLORS.white ? `${COLORS.white} · alb` : color;
    dlg.querySelectorAll("[data-sw]").forEach((b) => b.classList.toggle("on", b.dataset.sw === color));
    schedulePreview();
  };
  colorInp.addEventListener("input", () => setColor(colorInp.value));
  dlg.querySelectorAll("[data-sw]").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.sw)));
  // eyedropper: a click on the "Before" image takes the color of that point; in Chrome/Edge it can be taken
  // from anywhere on screen as well (EyeDropper)
  const pickBtn = dlg.querySelector("#rPick");
  const before = dlg.querySelector("#rBefore");
  const setPicking = (on) => {
    picking = on;
    pickBtn.classList.toggle("on", on);
    before.style.cursor = on ? "crosshair" : "";
    before.closest(".prevbox").classList.toggle("picking", on);
    dlg.querySelector("#rColorTxt").textContent = on ? "Click pe imaginea „Înainte” în punctul cu culoarea dorită" : color;
  };
  pickBtn.addEventListener("click", async () => {
    if (picking) {
      setPicking(false);
      return;
    }
    setPicking(true);
    if (window.EyeDropper) {
      try {
        const res = await new window.EyeDropper().open();
        setPicking(false);
        setColor(res.sRGBHex);
      } catch (_) {
        // cancelled with Esc: the click-on-preview option remains
      }
    }
  });
  before.addEventListener("click", (e) => {
    if (!picking) return;
    const cv = e.currentTarget;
    const r = cv.getBoundingClientRect();
    const x = Math.min(cv.width - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * cv.width)));
    const y = Math.min(cv.height - 1, Math.max(0, Math.round(((e.clientY - r.top) / r.height) * cv.height)));
    // without the red zone outline: the color is read from the clean image
    paint(cv, beforeImg, null);
    const d = cv.getContext("2d").getImageData(x, y, 1, 1).data;
    drawBefore(null);
    setPicking(false);
    setColor(`#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  });
  const allCb = dlg.querySelector("#rAll");
  allCb.addEventListener("change", () => {
    ids.clear();
    for (const id of allCb.checked ? objs.filter((o) => !o.locked).map((o) => o.id) : auto()) ids.add(id);
    renderList();
    schedulePreview();
  });
  const setMode = (m) => {
    mode = m;
    dlg.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
    dlg.querySelector("#rCoverRow").hidden = m !== "zone";
    dlg.querySelector("#rCoverCtl").hidden = m !== "cover";
    dlg.querySelector("#rAllRow").hidden = m !== "objects";
    renderList();
    schedulePreview();
  };
  dlg.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // previews cropped around the zone
  const x0 = Math.min(rect[0], rect[2]);
  const x1 = Math.max(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]);
  const y1 = Math.max(rect[1], rect[3]);
  const m = Math.max(12 * K, (x1 - x0) * 0.4, (y1 - y0) * 0.4);
  const crop = [x0 - m, y0 - m, x1 + m, y1 + m];
  const pvScale = Math.min(8, 380 / (crop[2] - crop[0]), 300 / (crop[3] - crop[1]));
  const imgScale = Math.min(6, pvScale * 1.5);
  const loadImg = (src) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
  const paint = (cv, im, overlay) => {
    const w = (crop[2] - crop[0]) * pvScale;
    const h = (crop[3] - crop[1]) * pvScale;
    cv.width = Math.round(w * 2);
    cv.height = Math.round(h * 2);
    cv.style.width = `${Math.round(w)}px`;
    cv.style.height = `${Math.round(h)}px`;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = COLORS.white;
    ctx.fillRect(0, 0, cv.width, cv.height);
    const k = 2 * pvScale;
    ctx.setTransform(k, 0, 0, k, -crop[0] * k, -crop[1] * k);
    if (im) ctx.drawImage(im, 0, 0, im.width / imgScale, im.height / imgScale);
    if (overlay) overlay(ctx, k);
  };
  let beforeImg = null;
  const drawBefore = (hoverId) => {
    paint(dlg.querySelector("#rBefore"), beforeImg, (ctx, k) => {
      ctx.setLineDash([4 / k, 3 / k]);
      ctx.strokeStyle = COLORS.rev;
      ctx.lineWidth = 1.2 / k;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      const o = objs.find((q) => q.id === hoverId);
      if (o) {
        ctx.strokeStyle = COLORS.sel;
        ctx.lineWidth = 3 / k;
        if (o.poly) {
          for (const poly of o.poly) {
            ctx.beginPath();
            poly.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.stroke();
          }
        } else {
          ctx.strokeRect(o.bbox[0], o.bbox[1], o.bbox[2] - o.bbox[0], o.bbox[3] - o.bbox[1]);
        }
      }
    });
  };
  const ops = () => (mode === "objects" ? [{ mode, ids: [...ids] }] : [{ mode, rect }]);
  let pvTimer = null;
  const schedulePreview = () => {
    clearTimeout(pvTimer);
    if (mode === "cover") {
      // a cover does not change the file: "after" = "before" with the colored rectangle
      paint(dlg.querySelector("#rAfter"), beforeImg, (ctx) => {
        ctx.fillStyle = color;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      });
      return;
    }
    pvTimer = setTimeout(async () => {
      try {
        const url = await api.previewRemoval(app.doc.id, annot.page, ops(), imgScale);
        const im = await loadImg(url);
        paint(dlg.querySelector("#rAfter"), im, mode === "zone" && cover ? (ctx) => {
          ctx.fillStyle = COLORS.white;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        } : null);
        URL.revokeObjectURL(url);
      } catch (_) { /* preview unavailable */ }
    }, 150);
  };
  try {
    beforeImg = await loadImg(api.renderUrl(app.doc.id, annot.page, imgScale));
  } catch (_) { /* no image */ }
  drawBefore(null);
  setColor(color);
  setMode(mode);

  dlg.querySelector("#rOk").addEventListener("click", () => {
    const keep = objs
      .filter((o) => !o.locked)
      .filter((o) => (mode === "objects" ? ids.has(o.id) : mode === "text" ? o.type === "text" : o.type === "text" || o.inside))
      .map((o) => ({ id: o.id, type: o.type, poly: o.poly, bbox: o.bbox }));
    const keepIds = [...ids].filter((id) => !objs.some((o) => o.id === id && o.locked));
    if (mode === "cover") {
      app.commitRedaction(annot, { mode, ids: [], objs: [], color, cover: undefined }, isNew);
      closeModal();
      return;
    }
    app.commitRedaction(annot, { mode, ids: keepIds, objs: keep, cover: mode === "zone" ? cover : undefined, color: undefined }, isNew);
    closeModal();
  });
}

// ------------------------------------------------------------------ blackening original lines
export async function inkDialog(app, annot, isNew) {
  const rect = annot.r;
  let objs = [];
  try {
    objs = (await api.objectsInRect(app.doc.id, annot.page, rect)).objects;
  } catch (e) {
    toast(e.message);
    return;
  }
  // default: everything touching the zone, except what is inside blocks (those only via blackening the whole drawing)
  const ids = new Set(isNew ? objs.filter((o) => !o.locked && o.type !== "image").map((o) => o.id) : annot.ids || []);
  const label = (o) => (o.type === "text" ? `Text „${esc(o.text || "?")}”` : o.type === "path" ? `Linie / contur · ${o.segments} puncte` : o.type === "image" ? "Imagine" : o.type);
  const dlg = showModal(`
    <h2>Înnegrește linii din original</h2>
    <div class="sub">Pagina ${annot.page + 1} · ${objs.length} obiecte în zonă. Culoarea devine neagră; forma, grosimea și tipul liniei rămân.</div>
    <div class="cols">
      <div class="sec">
        <div class="row"><div class="field"><span class="lbl">Înainte</span><div class="prevbox"><canvas id="kBefore"></canvas></div></div>
        <div class="field"><span class="lbl">După</span><div class="prevbox"><canvas id="kAfter"></canvas></div></div></div>
      </div>
      <div class="sec">
        <div class="lbl">Obiecte (bifează ce devine negru)</div>
        <div class="objlist" id="kList"></div>
        <div class="row"><button class="ghost" id="kAll">Toate</button><button class="ghost" id="kNone">Niciunul</button></div>
        <div class="note">Pentru tot desenul (inclusiv blocuri și imagini) folosește „Linii și text negre, pe tot desenul” din panoul documentului sau din export.</div>
      </div>
    </div>
    <div class="foot"><span class="muted">Se aplică la export; originalul de pe server rămâne neatins.</span><button class="ghost" data-close>Anulează</button><button class="primary" id="kOk">Aplică</button></div>`);
  const list = dlg.querySelector("#kList");
  const x0 = Math.min(rect[0], rect[2]);
  const x1 = Math.max(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]);
  const y1 = Math.max(rect[1], rect[3]);
  const m = Math.max(10 * K, (x1 - x0) * 0.3, (y1 - y0) * 0.3);
  const crop = [x0 - m, y0 - m, x1 + m, y1 + m];
  const pvScale = Math.min(8, 300 / (crop[2] - crop[0]), 240 / (crop[3] - crop[1]));
  const imgScale = Math.min(6, pvScale * 1.5);
  const paint = (cv, im) => {
    const w = (crop[2] - crop[0]) * pvScale;
    const h = (crop[3] - crop[1]) * pvScale;
    cv.width = Math.round(w * 2);
    cv.height = Math.round(h * 2);
    cv.style.width = `${Math.round(w)}px`;
    cv.style.height = `${Math.round(h)}px`;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = COLORS.white;
    ctx.fillRect(0, 0, cv.width, cv.height);
    const k = 2 * pvScale;
    ctx.setTransform(k, 0, 0, k, -crop[0] * k, -crop[1] * k);
    if (im) ctx.drawImage(im, 0, 0, im.width / imgScale, im.height / imgScale);
    ctx.setLineDash([4 / k, 3 / k]);
    ctx.strokeStyle = COLORS.edgreen;
    ctx.lineWidth = 1.2 / k;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  };
  const loadImg = (src) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
  let timer = null;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const url = await api.previewRemoval(app.doc.id, annot.page, [{ mode: "black", ids: [...ids] }], imgScale);
        paint(dlg.querySelector("#kAfter"), await loadImg(url));
        URL.revokeObjectURL(url);
      } catch (_) { /* no preview */ }
    }, 150);
  };
  const render = () => {
    list.innerHTML = objs.length ? objs.map((o) => `<label data-oid="${o.id}"><input type="checkbox" ${ids.has(o.id) ? "checked" : ""} ${o.locked || o.type === "image" ? "disabled" : ""}>
        <span>${label(o)}</span><span class="st" style="color:${o.locked || o.type === "image" ? "var(--warn)" : ids.has(o.id) ? "var(--ok)" : "var(--muted)"}">${o.locked ? "în bloc — doar tot desenul" : o.type === "image" ? "imagine — doar tot desenul" : ids.has(o.id) ? "devine negru" : "rămâne"}</span></label>`).join("")
      : `<span class="muted">Niciun obiect vectorial în zonă. La un scan folosește înnegrirea pe tot desenul.</span>`;
    list.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
      const id = cb.closest("label").dataset.oid;
      if (cb.checked) ids.add(id);
      else ids.delete(id);
      render();
      preview();
    }));
  };
  dlg.querySelector("#kAll").addEventListener("click", () => {
    for (const o of objs) if (!o.locked && o.type !== "image") ids.add(o.id);
    render();
    preview();
  });
  dlg.querySelector("#kNone").addEventListener("click", () => {
    ids.clear();
    render();
    preview();
  });
  try {
    paint(dlg.querySelector("#kBefore"), await loadImg(api.renderUrl(app.doc.id, annot.page, imgScale)));
  } catch (_) { /* no image */ }
  render();
  preview();
  dlg.querySelector("#kOk").addEventListener("click", () => {
    const keep = objs.filter((o) => ids.has(o.id)).map((o) => ({ id: o.id, type: o.type, poly: o.poly, bbox: o.bbox }));
    app.commitRedaction(annot, { ids: [...ids], objs: keep }, isNew);
    closeModal();
  });
}
