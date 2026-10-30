// Ferestre de dialog: deschidere, export, setări, ștergere din original, calibrare.
import * as api from "./api.js";
import { K, fmtNum, parseNum, DEFAULT_SETTINGS } from "./annots.js";
import { MM_POSITIONS, MM_DEFAULT, MM_SPECIAL, markingConfig } from "./mmenu.js";
import { TOOLS } from "./tools.js";

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

export function recentHtml(docs, retentionDays) {
  if (!docs.length) return "";
  const note = retentionDays > 0
    ? `<div class="sub" style="margin:6px 4px">Documentele stau pe server ${fmtNum(retentionDays, ",", 1)} zile de la ultima folosire, apoi se șterg automat. Ce ai exportat pe PC nu e afectat.</div>`
    : "";
  return `<div class="ttl">Recente</div>` + docs.slice(0, 12).map((d) => `
    <div class="item">
      <button class="open" data-doc="${d.id}">
        <span class="badge ${d.kind === "image" ? "img" : "pdf"}">${d.kind === "image" ? "IMG" : "PDF"}</span>
        <span style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.name)}</span>
        <span class="muted" style="font-size:12px">${(d.pages || []).length} pagini · ${ago(d.updated)}${daysLeft(d.expires)}</span></span>
      </button>
      <button class="icon del" data-del="${d.id}" data-name="${esc(d.name)}" title="Șterge de pe server" aria-label="Șterge ${esc(d.name)} de pe server"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
    </div>`).join("") + note;
}

/** Leagă butoanele din lista de recente: deschidere și ștergere (cu confirmare). */
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

// ------------------------------------------------------------------ închidere document
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

// ------------------------------------------------------------------ deschidere
export async function openDialog(app) {
  let docs = [];
  try {
    docs = await api.listDocs();
  } catch (_) { /* fără listă */ }
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
      <div class="recent" style="width:auto">${recentHtml(docs, app.retentionDays) || `<span class="muted">Niciun document deschis încă.</span>`}</div>
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
  const dlg = showModal(`
    <h2>Exportă PDF</h2>
    <div class="field"><label for="eName">Nume fișier</label><input type="text" class="mono" id="eName" value="${esc(suggested)}.pdf"></div>
    <div class="cols">
      <div class="cards">
        <div class="lbl">Culori</div>
        <button class="card on" data-col="black"><b>Toate negre</b><span>Cum se predă un desen: cotele noi arată ca restul.</span></button>
        <button class="card" data-col="layers"><b>Culorile straturilor</b><span>Adăugate albastru, revizii roșu — util pentru verificare.</span></button>
      </div>
      <div class="cards">
        <div class="lbl">Opțiuni</div>
        <label class="chk" style="font-size:13px"><input type="checkbox" id="eEmbed" checked> Atașează stratul editabil (la redeschidere cotele rămân editabile)</label>
        <label class="chk" style="font-size:13px"><input type="checkbox" id="eInk" ${app.settings.ink && app.settings.ink.all ? "checked" : ""}> Liniile originale negre, pentru imprimantă (culorile deschise ies palid)</label>
        <div class="note">${nAnn} adnotări · ${nDel} ștergeri din original. Cotele se scriu vectorial în pagină, cu fontul ISO 3098 încorporat. Originalul de pe server nu se modifică.</div>
      </div>
    </div>
    <div class="foot"><span class="muted" id="eMsg"></span><button class="ghost" data-close>Anulează</button><button class="primary" id="eGo">Exportă</button></div>`);
  let color = "black";
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
    dlg.querySelector("#eMsg").textContent = "Se generează…";
    try {
      const name = dlg.querySelector("#eName").value.trim() || "export.pdf";
      const { blob, report } = await app.exportPdf(name, color, dlg.querySelector("#eEmbed").checked);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      closeModal();
      const removed = Object.values(report).reduce((s, r) => s + (r.removed || 0), 0);
      const blackened = Object.values(report).reduce((s, r) => s + (r.black || 0), 0);
      const sum = (k) => Object.values(report).reduce((s, r) => s + (r[k] || 0), 0);
      const cut = sum("cut");
      const left = sum("partial") + sum("locked");
      app.markExported();
      toast(`Exportat ${a.download}${removed ? ` · ${removed} obiecte eliminate` : ""}${blackened ? ` · ${blackened} înnegrite` : ""}${cut ? ` · ${cut} linii tăiate la margine` : ""}${left ? ` · ${left} doar acoperite/rămase` : ""}`);
      if (opts.afterExport) opts.afterExport();
    } catch (e) {
      dlg.querySelector("#eMsg").textContent = e.message;
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ setări
/** Cele 8 poziții ale meniului radial, ca o busolă în jurul cursorului. */
function mmGridHtml(cfg) {
  const groups = [];
  for (const t of TOOLS) {
    if (t.id === "select" || t.id === "pan" || t.id === "calib") continue;
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push((g = { name: t.group, tools: [] }));
    g.tools.push(t);
  }
  const options = (cur) => `<optgroup label="Acțiuni">${MM_SPECIAL.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>
    ${groups.map((g) => `<optgroup label="${esc(g.name)}">${g.tools.map((t) => `<option value="${t.id}" ${t.id === cur ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</optgroup>`).join("")}`;
  // poziția în grilă 3×3 pentru indicii E, NE, N, NV, V, SV, S, SE
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
    <h2>Stil cote · documentul curent</h2>
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
    <div class="sec">
      <div class="lbl">Meniul de la click dreapta ținut · comenzile tale favorite (pentru toate documentele)</div>
      <div class="mmgrid" id="sMm">${mmGridHtml(markingConfig())}</div>
      <div class="row"><button class="ghost" id="sMmReset">Revino la implicit</button><span class="sub">Alegi trăgând spre comandă și eliberând butonul; pe ecran tactil, apăsare lungă.</span></div>
    </div>
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
  dlg.querySelector("#sMmReset").addEventListener("click", () => {
    dlg.querySelector("#sMm").innerHTML = mmGridHtml(MM_DEFAULT);
  });
  dlg.querySelector("#sSave").addEventListener("click", () => {
    const mm = [...dlg.querySelectorAll("#sMm select")].sort((p, q) => p.dataset.i - q.dataset.i).map((x) => x.value);
    try {
      if (mm.length === 8) localStorage.setItem("cotare.mmenu", JSON.stringify(mm));
    } catch (_) { /* stocare indisponibilă */ }
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
      } catch (_) { /* stocare indisponibilă */ }
    }
    closeModal();
  });
}

export function storedDefaults() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("cotare.defaults") || "{}") };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

// ------------------------------------------------------------------ calibrare
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
  dlg.querySelector("#cOk").addEventListener("click", () => {
    const v = parseNum(dlg.querySelector("#cReal").value);
    if (!v || v <= 0) return;
    app.setSettings({ scale: v / paperMm });
    closeModal();
    toast(`Scară fixată: ${fmtNum(v / paperMm, ",", 4)} mm reali / mm hârtie`);
  });
}

// ------------------------------------------------------------------ ștergere din original
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
  // implicit: obiectele aflate cel puțin 90% în zonă (lungimea liniei sau aria textului)
  const FRAC = 0.9;
  // literele mici (texte AutoCAD exportate ca linii) cu centrul în zonă se iau întregi,
  // chiar dacă o codiță iese din casetă (g, p, y…)
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
  let color = annot.color || "#ffffff";
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
  // în modul zonă, ce nu se poate tăia (blocuri, umpleri, imagini) se poate acoperi cu alb
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
            <button class="ghost sw" data-sw="#ffffff" title="Alb" aria-label="Alb"><i style="background:#fff"></i></button>
            <button class="ghost sw" data-sw="#f4f1e8" title="Hârtie" aria-label="Hârtie"><i style="background:#f4f1e8"></i></button>
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
  // ---- acoperire: culoare, mostre, pipetă
  const colorInp = dlg.querySelector("#rColor");
  const setColor = (c) => {
    color = c.toLowerCase();
    colorInp.value = color;
    dlg.querySelector("#rColorTxt").textContent = color === "#ffffff" ? "#ffffff · alb" : color;
    dlg.querySelectorAll("[data-sw]").forEach((b) => b.classList.toggle("on", b.dataset.sw === color));
    schedulePreview();
  };
  colorInp.addEventListener("input", () => setColor(colorInp.value));
  dlg.querySelectorAll("[data-sw]").forEach((b) => b.addEventListener("click", () => setColor(b.dataset.sw)));
  // pipeta: un click pe imaginea „Înainte” ia culoarea punctului; în Chrome/Edge se poate lua
  // și de oriunde de pe ecran (EyeDropper)
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
        // anulat cu Esc: rămâne varianta cu click pe previzualizare
      }
    }
  });
  before.addEventListener("click", (e) => {
    if (!picking) return;
    const cv = e.currentTarget;
    const r = cv.getBoundingClientRect();
    const x = Math.min(cv.width - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * cv.width)));
    const y = Math.min(cv.height - 1, Math.max(0, Math.round(((e.clientY - r.top) / r.height) * cv.height)));
    // fără conturul roșu al zonei: culoarea se citește din imaginea curată
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

  // previzualizări decupate în jurul zonei
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
    ctx.fillStyle = "#fff";
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
      ctx.strokeStyle = "#c62828";
      ctx.lineWidth = 1.2 / k;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      const o = objs.find((q) => q.id === hoverId);
      if (o) {
        ctx.strokeStyle = "#f2a93b";
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
      // acoperirea nu schimbă fișierul: „după” = „înainte” cu dreptunghiul colorat
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
          ctx.fillStyle = "#fff";
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        } : null);
        URL.revokeObjectURL(url);
      } catch (_) { /* previzualizare indisponibilă */ }
    }, 150);
  };
  try {
    beforeImg = await loadImg(api.renderUrl(app.doc.id, annot.page, imgScale));
  } catch (_) { /* fără imagine */ }
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

// ------------------------------------------------------------------ înnegrire linii originale
export async function inkDialog(app, annot, isNew) {
  const rect = annot.r;
  let objs = [];
  try {
    objs = (await api.objectsInRect(app.doc.id, annot.page, rect)).objects;
  } catch (e) {
    toast(e.message);
    return;
  }
  // implicit: tot ce atinge zona, mai puțin ce e în blocuri (acelea doar cu înnegrirea întregului desen)
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
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    const k = 2 * pvScale;
    ctx.setTransform(k, 0, 0, k, -crop[0] * k, -crop[1] * k);
    if (im) ctx.drawImage(im, 0, 0, im.width / imgScale, im.height / imgScale);
    ctx.setLineDash([4 / k, 3 / k]);
    ctx.strokeStyle = "#2e9d5b";
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
      } catch (_) { /* fără previzualizare */ }
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
  } catch (_) { /* fără imagine */ }
  render();
  preview();
  dlg.querySelector("#kOk").addEventListener("click", () => {
    const keep = objs.filter((o) => ids.has(o.id)).map((o) => ({ id: o.id, type: o.type, poly: o.poly, bbox: o.bbox }));
    app.commitRedaction(annot, { ids: [...ids], objs: keep }, isNew);
    closeModal();
  });
}
