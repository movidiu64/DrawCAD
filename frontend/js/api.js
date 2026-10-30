// Apeluri către backend.

async function jsonOrThrow(r) {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      if (j.error) msg = j.error;
    } catch (_) { /* fără corp JSON */ }
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

export const snap = (id, n) => fetch(`api/doc/${id}/page/${n}/snap`).then(jsonOrThrow);

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

export async function previewRemoval(id, n, ops, scale, ink = null) {
  const r = await fetch(`api/doc/${id}/page/${n}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops, scale, ink }),
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
    } catch (_) { /* ignorat */ }
    throw new Error(msg);
  }
  const report = JSON.parse(r.headers.get("X-Removal-Report") || "{}");
  return { blob: await r.blob(), report };
}
