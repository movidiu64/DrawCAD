// Calls to the backend.

async function jsonOrThrow(r) {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if (j.error) msg = j.error;
    } catch (_) { /* no JSON body */ }
    throw new Error(msg);
  }
  return r.json();
}

export async function openFile(file, dpi) {
  const headers = { "X-Filename": unescape(encodeURIComponent(file.name)) };
  if (dpi) headers["X-Dpi"] = String(dpi);
  const r = await fetch("api/open", { method: "POST", body: file, headers });
  return jsonOrThrow(r);
}

export const listDocs = () => fetch("api/docs").then(jsonOrThrow);
export const getDoc = (id) => fetch(`api/doc/${id}`).then(jsonOrThrow);
export const deleteDoc = (id) => fetch(`api/doc/${id}`, { method: "DELETE" }).then(jsonOrThrow);

export async function saveState(id, state) {
  const r = await fetch(`api/doc/${id}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  return jsonOrThrow(r);
}

export const snap = (id, n, v = 0) => fetch(`api/doc/${id}/page/${n}/snap?v=${v}`).then(jsonOrThrow);
/** Snap geometry of a scanned page, from its vectorization (slow the first time). */
export const snapScan = (id, n) => fetch(`api/doc/${id}/page/${n}/snapscan`).then(jsonOrThrow);

export function renderUrl(id, n, scale, extra = "") {
  return `api/doc/${id}/page/${n}/render?scale=${scale}${extra}`;
}

export async function objectsInRect(id, n, rect) {
  const r = await fetch(`api/doc/${id}/page/${n}/objects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rect }),
  });
  return jsonOrThrow(r);
}

export async function previewRemoval(id, n, ops, scale, ink = null, clip = null) {
  const r = await fetch(`api/doc/${id}/page/${n}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops, scale, ink, clip }),
  });
  if (!r.ok) throw new Error("Previzualizare eșuată");
  return URL.createObjectURL(await r.blob());
}

export async function exportPdf(id, payload) {
  const r = await fetch(`api/doc/${id}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let msg = "Export eșuat";
    try {
      msg = (await r.json()).error || msg;
    } catch (_) { /* ignored */ }
    throw new Error(msg);
  }
  const report = JSON.parse(r.headers.get("X-Removal-Report") || "{}");
  let stats = null;
  try {
    stats = JSON.parse(r.headers.get("X-Dxf-Stats") || "null");
  } catch (_) { /* no statistics */ }
  return { blob: await r.blob(), report, kind: r.headers.get("X-Export-Kind") || "pdf", stats };
}

export const getOcr = (id, n) => fetch(`api/doc/${id}/page/${n}/ocr`).then(jsonOrThrow);

export async function runOcr(id, n, force = false) {
  const r = await fetch(`api/doc/${id}/page/${n}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  return jsonOrThrow(r);
}

export const pageText = (id, n, v = 0) => fetch(`api/doc/${id}/page/${n}/text?v=${v}`).then(jsonOrThrow);

export async function pageOp(id, body) {
  const r = await fetch(`api/doc/${id}/pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOrThrow(r);
}

export const workspace = () => fetch("api/workspace").then(jsonOrThrow);

export async function useWorkspace(code) {
  const r = await fetch("api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  return jsonOrThrow(r);
}
