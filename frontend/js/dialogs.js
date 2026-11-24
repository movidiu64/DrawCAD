// Dialogs: open, export, settings, removal from the original, calibration.
import * as api from "./api.js";
import { K, fmtNum, parseNum, DEFAULT_SETTINGS } from "./annots.js";
import { MM_POSITIONS, MM_DEFAULT, MM_SPECIAL, markingConfig } from "./mmenu.js";
import { TOOLS, FAMILIES } from "./tools.js";
import { lang as uiLang, setLang, LANGS } from "./i18n.js";
import { SHEETS } from "./pages.js";
import { COLORS } from "./view.js";
import { commandList, conflicts, defaultKeyConfig, keyConfig, saveKeyConfig, labelOf, RESERVED_KEYS, DEFAULT_ALIASES, ACTIONS, parsePgp, importPgp } from "./commands.js";

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
        <strong>Trage aici un PDF sau o imagine</strong>
        <span class="muted">PDF · PNG · JPG · TIFF</span>
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
  const suggested = /_rev\d+$/i.test(base) ? base.replace(/_rev\d+$/i, `_rev${rev}`) : `${base}_rev${rev}`;
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
          <div class="note">Straturi separate: PDF-GEOMETRIE, PDF-TEXT, SCAN-VECTORI, OCR-TEXT, DRAWCAD-COTE… Arcele rămân arce, cercurile cercuri. Pe un scan, textul se recunoaște automat (OCR) dacă nu a fost deja; vectorizarea dă o bază de lucru, nu un desen curat — verifică cotele importante.</div>
        </div>
        <div id="ePdfOpts" class="dxfopts">
        <label class="chk" style="font-size:13px"><input type="checkbox" id="eEmbed" checked> Atașează stratul editabil (la redeschidere cotele rămân editabile)</label>
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
        : { ocrLayer: chk("#eOcr") };
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
    html += `<label class="mmc" style="grid-column:${c + 1};grid-row:${r + 1}"><span class="sub">${MM_POSITIONS[i]}</span>
      <select data-i="${i}" aria-label="Comanda din poziția ${MM_POSITIONS[i]}">${options(cfg[i])}</select></label>`;
  }
  return html;
}

export function settingsDialog(app) {
  const S = app.settings;
  const opt = (name, cur, list) => list.map(([v, l]) => `<button class="${String(cur) === String(v) ? "on" : ""}" data-set="${name}" data-v="${v}">${l}</button>`).join("");
  const dlg = showModal(`
    <h2>Setări</h2>
    <div class="lbl" style="margin-bottom:-6px">Stil cote · documentul curent</div>
    <div class="cols">
      <div class="sec">
        <div class="lbl">Înălțime text (ISO 3098)</div><div class="seg">${opt("textH", S.textH, [[2.5, "2,5 mm"], [3.5, "3,5 mm"], [5, "5 mm"], [7, "7 mm"]])}</div>
        <div class="lbl">Capete linie de cotă</div><div class="seg">${opt("arrow", S.arrow, [["closed", "Închise"], ["open", "Deschise"], ["tick", "Oblic"], ["dot", "Punct"]])}</div>
        <div class="lbl">Lungime săgeată</div><div class="seg">${opt("arrowLen", S.arrowLen, [[2.5, "2,5"], [3, "3"], [3.5, "3,5"], [4, "4"]])}</div>
        <div class="lbl">Grosime linii</div><div class="seg">${opt("lineW", S.lineW, [[0.18, "0,18"], [0.25, "0,25"], [0.35, "0,35"]])}</div>
      </div>
      <div class="sec">
        <div class="lbl">Separator zecimal</div><div class="seg">${opt("sep", S.sep, [[",", "Virgulă 0,015"], [".", "Punct 0.015"]])}</div>
        <div class="lbl">Câmp ISO 286 — afișare implicită</div><div class="seg" style="flex-wrap:wrap">${opt("isoDisplay", S.isoDisplay, [["code", "Simbol"], ["codeDev", "+ (abateri)"], ["codeLim", "+ (limite)"], ["dev", "Abateri"]])}</div>
        <div class="lbl">Scriere câmp</div><div class="seg">${opt("codeSpace", S.codeSpace, [[false, "Ø25k6 (ISO)"], [true, "Ø25 k6"]])}</div>
        <div class="row"><div class="field"><label for="sRev">Nr. revizie curent</label><input type="text" id="sRev" class="mono" value="${esc(S.revNo)}"></div>
        <div class="field"><label for="sAuth">Nume / inițiale (tabel revizii)</label><input type="text" id="sAuth" value="${esc(S.author || "")}"></div></div>
        <div class="row">
        <div class="field"><label for="sScale">Scară (mm reali / mm hârtie)</label><input type="text" id="sScale" class="mono" value="${fmtNum(S.scale, ",", 4)}"></div></div>
      </div>
    </div>
    ${app.mode && app.mode !== "personal" ? `<div class="sec">
      <div class="lbl">Spațiul tău de lucru · ${app.mode === "session" ? "până la închiderea browserului" : "legat de acest browser"}</div>
      <div class="row"><input type="text" class="mono" id="wsCode" readonly value="…" aria-label="Codul spațiului de lucru"><button class="ghost" id="wsCopy">Copiază</button></div>
      <div class="row"><input type="text" class="mono" id="wsNew" placeholder="Lipește codul din alt browser" aria-label="Cod din alt browser"><button class="ghost" id="wsUse">Folosește</button></div>
      <div class="sub">Codul e ca o cheie: cine îl are vede documentele tale. Îl folosești ca să continui pe alt calculator sau browser; documentele deschise cu codul vechi rămân la codul vechi.</div>
    </div>` : ""}
    <div class="sec">
      <div class="lbl">Meniul de la click dreapta ținut · comenzile tale favorite (pentru toate documentele)</div>
      <div class="mmgrid" id="sMm">${mmGridHtml(markingConfig())}</div>
      <div class="row"><button class="ghost" id="sMmReset">Revino la implicit</button><span class="sub">Alegi trăgând spre comandă și eliberând butonul; pe ecran tactil, apăsare lungă.</span></div>
    </div>
    <div class="sec">
      <div class="lbl">Bara de unelte · pentru toate documentele</div>
      <label class="chk"><input type="checkbox" id="sRailLbl" ${app.railCfg().labels ? "checked" : ""}> Etichete sub iconițe</label>
      <label class="chk"><input type="checkbox" id="sRailHover" ${app.railCfg().hover ? "checked" : ""}> Lista familiei se deschide când ții mouse-ul pe buton</label>
      <div class="railfams" id="sRailFams">${FAMILIES.map((f) => `<label class="chk"><input type="checkbox" data-fam="${f.id}" ${app.railCfg().hidden.includes(f.id) ? "" : "checked"}> ${f.label}</label>`).join("")}</div>
      <div class="sub">O familie ascunsă rămâne la îndemână din linia de comandă și cu tastele ei.</div>
    </div>
    <div class="cols">
      <div class="sec">
        <div class="lbl">Limba interfeței · Language</div>
        <div class="seg">${LANGS.map(([v, l]) => `<button data-uilang="${v}" class="${uiLang() === v ? "on" : ""}" translate="no">${l}</button>`).join("")}</div>
      </div>
      <div class="sec">
        <div class="lbl">Limba textelor din desen (antete de tabel, note) · documentul curent</div>
        <div class="seg">${opt("dlang", S.dlang || "ro", [["ro", "Română"], ["en", "English"]])}</div>
      </div>
    </div>
    <div class="sec">
      <div class="lbl">Taste și comenzi · pentru toate documentele</div>
      <div class="row"><button class="ghost" id="sKeys">Taste și comenzi…</button><span class="sub">Acum: ${keyConfig().mode === "autocad" ? "comenzi AutoCAD (L, C, DLI… + Spațiu)" : "taste directe (o tastă = o unealtă); Enter deschide linia de comandă"}.</span></div>
    </div>
    <div class="sub" translate="no" style="text-align:right;margin-top:-4px">DrawCAD ${esc(app.version || "dev")}</div>
    <div class="foot"><label class="chk" style="flex:1"><input type="checkbox" id="sDef"> Folosește ca implicit pentru documente noi</label>
      <button class="ghost" data-close>Închide</button><button class="primary" id="sSave">Aplică</button></div>`);
  const pending = {};
  dlg.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.set;
    let v = b.dataset.v;
    if (["textH", "arrowLen", "lineW"].includes(k)) v = Number(v);
    if (k === "codeSpace") v = v === "true";
    pending[k] = v;
    dlg.querySelectorAll(`[data-set="${k}"]`).forEach((x) => x.classList.toggle("on", x === b));
  }));
  if (dlg.querySelector("#wsCode")) {
    api.workspace().then((w) => { dlg.querySelector("#wsCode").value = w.code || ""; }).catch(() => {});
    dlg.querySelector("#wsCopy").addEventListener("click", async () => {
      const inp = dlg.querySelector("#wsCode");
      try {
        await navigator.clipboard.writeText(inp.value);
        toast("Cod copiat");
      } catch (_) {
        inp.select();
        toast("Selectat: apasă Ctrl+C");
      }
    });
    dlg.querySelector("#wsUse").addEventListener("click", async () => {
      const code = dlg.querySelector("#wsNew").value.trim();
      try {
        await api.useWorkspace(code);
        localStorage.removeItem("cotare.lastDoc");
        location.reload();
      } catch (e) {
        toast(e.message);
      }
    });
  }
  dlg.querySelector("#sKeys").addEventListener("click", () => keysDialog(app));
  dlg.querySelectorAll("[data-uilang]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.uilang === uiLang()) return;
    setLang(b.dataset.uilang);
    location.reload();
  }));
  // the rail: applied at once, for all documents
  const railSave = () => {
    const c = app.railCfg();
    c.labels = dlg.querySelector("#sRailLbl").checked;
    c.hover = dlg.querySelector("#sRailHover").checked;
    c.hidden = [...dlg.querySelectorAll("#sRailFams [data-fam]")].filter((x) => !x.checked).map((x) => x.dataset.fam);
    app.saveRailCfg(c);
    app.buildToolbar();
  };
  dlg.querySelector("#sRailLbl").addEventListener("change", railSave);
  dlg.querySelector("#sRailHover").addEventListener("change", railSave);
  dlg.querySelectorAll("#sRailFams [data-fam]").forEach((x) => x.addEventListener("change", railSave));
  dlg.querySelector("#sMmReset").addEventListener("click", () => {
    dlg.querySelector("#sMm").innerHTML = mmGridHtml(MM_DEFAULT);
  });
  dlg.querySelector("#sSave").addEventListener("click", () => {
    const mm = [...dlg.querySelectorAll("#sMm select")].sort((p, q) => p.dataset.i - q.dataset.i).map((x) => x.value);
    try {
      if (mm.length === 8) localStorage.setItem("cotare.mmenu", JSON.stringify(mm));
    } catch (_) { /* storage unavailable */ }
    pending.revNo = dlg.querySelector("#sRev").value.trim() || "1";
    pending.author = dlg.querySelector("#sAuth").value.trim();
    const sc = parseNum(dlg.querySelector("#sScale").value);
    if (sc && sc > 0) pending.scale = sc;
    app.setSettings(pending);
    if (dlg.querySelector("#sDef").checked) {
      const { scale, revNo, ...style } = { ...app.settings };
      void scale;
      void revNo;
      try {
        localStorage.setItem("cotare.defaults", JSON.stringify(style));
      } catch (_) { /* storage unavailable */ }
    }
    closeModal();
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
