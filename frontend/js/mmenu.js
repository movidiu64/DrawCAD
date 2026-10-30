// Meniul radial (click dreapta ținut): comenzile din cele 8 poziții, alese de utilizator în Setări.
// ------------------------------------------------------------------ meniul radial: configurare
export const MM_POSITIONS = ["Dreapta", "Dreapta-sus", "Sus", "Stânga-sus", "Stânga", "Stânga-jos", "Jos", "Dreapta-jos"];
export const MM_DEFAULT = ["dimRad", "dimDia", "last", "measure", "undo", "lead", "seldel", "text"];
export const MM_SPECIAL = [
  ["last", "Ultima comandă folosită"],
  ["undo", "Anulează"],
  ["redo", "Refă"],
  ["seldel", "Linie, sau Șterge selecția când ai ceva selectat"],
  ["del", "Șterge selecția"],
  ["dup", "Duplică selecția"],
  ["fit", "Potrivește pagina"],
  ["export", "Exportă PDF"],
];
export const MM_ICONS = {
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  dup: "M8 8h12v12H8zM4 16V4h12",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  export: "M12 4v11M7 10l5 5 5-5M5 20h14",
};

export function markingConfig() {
  try {
    const v = JSON.parse(localStorage.getItem("cotare.mmenu") || "null");
    if (Array.isArray(v) && v.length === 8) return v;
  } catch (_) { /* implicit */ }
  return [...MM_DEFAULT];
}

