// Definiția uneltelor: pictogramă, tastă, pași și ce adnotare produc.
import { newId, K } from "./annots.js";

function autoOrient(p1, p2, c) {
  const minx = Math.min(p1[0], p2[0]);
  const maxx = Math.max(p1[0], p2[0]);
  const miny = Math.min(p1[1], p2[1]);
  const maxy = Math.max(p1[1], p2[1]);
  const dxo = c[0] < minx ? minx - c[0] : c[0] > maxx ? c[0] - maxx : 0;
  const dyo = c[1] < miny ? miny - c[1] : c[1] > maxy ? c[1] - maxy : 0;
  if (dyo > dxo) return "h";
  if (dxo > dyo) return "v";
  return Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]) ? "h" : "v";
}

function dimTool(kind, prefix) {
  return {
    kind: "clicks",
    n: 3,
    make(pts, app) {
      const [p1, p2, p3] = pts;
      return {
        type: "dim",
        kind: kind === "ali" ? "ali" : "lin",
        orient: kind === "ali" ? undefined : autoOrient(p1, p2, p3),
        p1, p2, p3,
        prefix,
        nominal: null,
        tol: app.defaultTol(prefix),
      };
    },
    preview(pts, cur, app) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      return this.make([pts[0], pts[1], cur], app);
    },
  };
}

export const TOOLS = [
  { id: "select", label: "Selecție", key: "V", group: "Navigare", icon: "M5 3l13 8-6 1.5L9 19z", kind: "select",
    hint: "Click pe o adnotare pentru a o edita · trage de pătrățele · Delete șterge · Esc deselectează" },
  { id: "pan", label: "Mută", key: "H", group: "Navigare", icon: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3", kind: "pan",
    hint: "Trage pentru a muta foaia · rotița = zoom · oricând: butonul din mijloc sau Space + tragere" },

  { id: "dimLin", label: "Liniară", key: "D", group: "Cote", icon: "M4 6v12M20 6v12M4 12h16M4 12l3-2M4 12l3 2M20 12l-3-2M20 12l-3 2",
    hint: "Punct 1 → punct 2 → poziția liniei de cotă (orizontală sau verticală după unde muți)", ...dimTool("lin", "") },
  { id: "dimAli", label: "Aliniată", key: "A", group: "Cote", icon: "M5 15L15 5M5 15l1-3.5M5 15l3.5-1M15 5l-3.5 1M15 5l-1 3.5M3 13l4 4M13 3l4 4",
    hint: "Punct 1 → punct 2 → poziția liniei, paralelă cu segmentul", ...dimTool("ali", "") },
  { id: "dimDia", label: "Diametru", key: "O", group: "Cote", icon: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M5 19L19 5",
    hint: "Generatoarea de sus → cea de jos → poziția liniei (prefix Ø)", ...dimTool("lin", "Ø") },
  { id: "dimRad", label: "Rază", key: "R", group: "Cote", icon: "M4 20a16 16 0 0 1 16-16M4 20l11-11M15 9l-3.5 0.6M15 9l-0.6 3.5",
    kind: "clicks", n: 3, hint: "Centrul (snap ○) → un punct pe arc → capătul liniei de cotă",
    make: (pts, app) => ({ type: "rad", c: pts[0], p: pts[1], p3: pts[2], prefix: "R", nominal: null, tol: app.defaultTol("R") }),
    preview(pts, cur, app) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      return this.make([pts[0], pts[1], cur], app);
    } },
  { id: "dimAng", label: "Unghi", key: "U", group: "Cote", icon: "M4 20h16M4 20L17 6M12 20a8 8 0 0 0-2.6-5.9",
    kind: "clicks", n: 4, hint: "Vârful → un punct pe prima latură → un punct pe a doua → poziția arcului (alege sectorul)",
    make: (pts) => ({ type: "ang", v: pts[0], p1: pts[1], p2: pts[2], p3: pts[3], nominal: null, tol: { mode: "none" } }),
    preview(pts, cur) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      if (pts.length === 2) return { lines: [[pts[0], pts[1]], [pts[0], cur]] };
      return this.make([pts[0], pts[1], pts[2], cur]);
    } },
  { id: "chamfer", label: "Teșitură", key: "C", group: "Cote", icon: "M4 20V10l6-6h10M13 13l-5-5", kind: "clicks", n: 2,
    hint: "Click pe muchia teșită → poziția textului",
    make: (pts) => ({ type: "lead", pts: [pts[0], pts[1]], text: "1×45°", arrow: "arrow" }),
    preview(pts, cur) { return this.make([pts[0], cur]); } },
  { id: "lead", label: "Indicație", key: "L", group: "Cote", icon: "M4 20l8-8h8M4 20l1-4M4 20l4-1", kind: "clicks", n: 2,
    hint: "Vârful săgeții → cotul liniei · textul se scrie în panou",
    make: (pts) => ({ type: "lead", pts: [pts[0], pts[1]], text: "Text", arrow: "arrow" }),
    preview(pts, cur) { return this.make([pts[0], cur]); } },
  { id: "text", label: "Text", key: "T", group: "Cote", icon: "M5 6h14M12 6v13M9 19h6", kind: "clicks", n: 1,
    hint: "Click → text liber (se editează în panou)",
    make: (pts) => ({ type: "text", p: pts[0], text: "Text", angle: 0, size: 1 }) },

  { id: "rough", label: "Rugozitate", key: "Q", group: "Toleranțe", icon: "M3 13l3 5 8-14h7M6.5 13h5", kind: "clicks", n: 2,
    hint: "Punct pe suprafață → al doilea click în același loc = simbol direct, în altă parte = cu linie de indicație",
    make(pts) {
      const near = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 3 * K;
      return { type: "rough", target: pts[0], pos: near ? null : pts[1], kind: "remove", val: "Ra 3,2", method: "", rot: 0 };
    },
    preview(pts, cur) { return this.make([pts[0], cur]); } },
  { id: "gdt", label: "Cadru GD&T", key: "G", group: "Toleranțe", icon: "M2 8h20v8H2zM9 8v8M16 8v8M3.5 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", kind: "clicks", n: 2,
    hint: "Vârful săgeții (pe linia de cotă = axă, pe contur = suprafață) → poziția cadrului",
    make: (pts) => ({ type: "gdt", target: pts[0], pos: pts[1], sym: "coax", dia: true, val: "0,02", mods: [], datums: ["A", "", ""] }),
    preview(pts, cur) { return this.make([pts[0], cur]); } },
  { id: "datum", label: "Bază", key: "B", group: "Toleranțe", icon: "M8 4h8v8H8zM12 12v4M8.5 20h7L12 16z", kind: "clicks", n: 2,
    hint: "Punct pe element (sau pe linia de cotă) → poziția casetei",
    make: (pts, app) => ({ type: "datum", target: pts[0], pos: pts[1], letter: app.nextDatumLetter() }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },

  { id: "note", label: "Note", key: "N", group: "Documentare", icon: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5", kind: "clicks", n: 1,
    hint: "Click pe colțul stânga-sus al blocului de note · textul (pe mai multe rânduri) se scrie în panou",
    make: (pts) => ({ type: "note", p: pts[0], title: "NOTE", text: "Muchiile nespecificate se teșesc 0,5×45°\nToleranțe generale ISO 2768-mK", numbered: true, frame: false, size: 1 }),
  },
  { id: "revtab", label: "Tabel rev.", key: "E", group: "Documentare", icon: "M3 6h18v12H3zM3 10h18M3 14h18M8 6v12M17 6v12", kind: "clicks", n: 1,
    hint: "Click pe colțul dreapta-sus al cartușului: tabelul se așază deasupra, aliniat la dreapta",
    make: (pts, app) => ({ type: "revtab", p: pts[0], rows: app.revRowsFromStrikes(true), headerBottom: true }) },
  { id: "strike", label: "Taie cota", key: "S", group: "Revizie", icon: "M5 7h6M8 7v10M14 7h5M16.5 7v10M3 12h18", kind: "rect",
    hint: "Trage un dreptunghi peste valoarea veche → scrie valoarea nouă în panou",
    make: (r, app) => ({ type: "strike", r, newText: "", rev: app.settings.revNo, layer: "rev" }) },
  { id: "white", label: "Acoperă", key: "W", group: "Revizie", icon: "M3 6h18v12H3zM7 10h10M7 14h6", kind: "rect",
    hint: "Trage un dreptunghi alb peste zonă (conținutul rămâne în fișier)",
    make: (r) => ({ type: "white", r }) },
  { id: "redact", label: "Șterge", key: "X", group: "Revizie", icon: "M7 20h12M5 15.5l9-9 5 5-6.5 6.5H9z", kind: "rect",
    hint: "Trage un dreptunghi → alegi ce obiecte din original se elimină",
    make: (r) => ({ type: "redact", r, mode: "objects", ids: [], objs: [] }) },
  { id: "calib", label: "Calibrare", key: "K", group: "Revizie", icon: "M3 17h18M5 17v-4M9 17v-2M13 17v-4M17 17v-2M21 17v-4M3 7h18M3 7l3-2M3 7l3 2M21 7l-3-2M21 7l-3 2", kind: "clicks", n: 2,
    hint: "Click pe capetele unei cote cunoscute → introduci valoarea reală",
    preview(pts, cur) { return { line: [pts[0], cur] }; } },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
export const TOOL_BY_KEY = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t]));

export function finalize(a) {
  return { id: newId(), layer: a.layer || "add", ...a };
}
