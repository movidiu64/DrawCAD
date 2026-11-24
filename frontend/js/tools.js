// Tool definitions: icon, key, steps and the annotation they produce.
import { newId, K, dimSeries, parseNum, gdtAnchor } from "./annots.js";
import { trackSweep } from "./shapes.js";

const shape = (app, kind, pts, extra = {}) => ({ type: "shape", kind, pts, ...app.drawStyle, ...extra });
const arcState = { key: null };

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

/** Tool for a series of linear dimensions (chain or from a common base). */
function dimSeriesTool(mode) {
  const across = "sub sau deasupra punctelor = cote orizontale, la stânga sau la dreapta = verticale";
  return {
    kind: "poly",
    min: 2,
    place: true,
    placeHint: mode === "base"
      ? `Click pentru prima linie de cotă (cea mai scurtă cotă), ${across}; următoarele se etajează spre exterior · Esc renunță`
      : `Click pentru linia de cotă: ${across} · Esc renunță`,
    make(pts, app, _closed, cur) {
      const S = app.S();
      const step = Math.max(7 * K, S.h * 2.4); // distance between baseline dimensions (paper)
      const st = app.cmdState || {};
      return dimSeries(pts, st.seriesAt || cur || pts[pts.length - 1], mode, step, st.orient).map((g) => ({
        type: "dim", kind: "lin", ...g, prefix: "", nominal: null, tol: app.defaultTol(""),
      }));
    },
    preview(pts, cur, app) {
      if (app.placing) return this.make(pts, app, false, cur);
      // continuing an existing dimension (option S): the row is known, show the dimensions
      if (app.cmdState && app.cmdState.seriesAt) return this.make([...pts, cur], app, false, null);
      const r = 1.6 * K;
      const lines = [];
      pts.forEach((q, i) => {
        const m = i === 0 && mode === "base" ? r * 1.6 : r;
        lines.push([[q[0] - m, q[1]], [q[0] + m, q[1]]], [[q[0], q[1] - m], [q[0], q[1] + m]]);
      });
      lines.push([pts[pts.length - 1], cur]);
      return { lines };
    },
  };
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

  { id: "measure", label: "Măsoară", key: "M", group: "Navigare", icon: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2", kind: "clicks", n: 2,
    hint: "Două puncte (cu snap) → distanța, Δx, Δy și unghiul, la scara desenului; nu se adaugă nimic pe desen",
    preview(pts, cur) { return { line: [pts[0], cur] }; } },

  // MOVE / COPY on the selection (commands only, not on the toolbar): base point, second point
  { id: "moveSel", label: "Mută obiectele", key: "", group: "Navigare", hidden: true, icon: "M12 3v18M3 12h18",
    kind: "clicks", n: 2, hint: "Punctul de bază, apoi al doilea punct (sau @dx,dy) · Esc renunță",
    make: (pts, app) => app.moveSelection(pts, false),
    preview: (pts, cur, app) => app.movePreview(pts[0], cur) },
  { id: "copySel", label: "Copiază obiectele", key: "", group: "Navigare", hidden: true, icon: "M8 8h12v12H8zM4 4h12v12",
    kind: "clicks", n: 2, hint: "Punctul de bază, apoi unde pui copia (sau @dx,dy); copiile continuă până la Enter / Esc",
    make: (pts, app) => app.moveSelection(pts, true),
    preview: (pts, cur, app) => app.movePreview(pts[0], cur) },
  { id: "ucs", label: "Origine", key: "", group: "Navigare", icon: "M5 19V5M5 19h14M5 5l-2 3M5 5l2 3M19 19l-3-2M19 19l-3 2M3.5 17.5h3v3h-3z",
    kind: "clicks", n: 1,
    hint: "Click pe punctul care devine 0,0 pentru coordonatele scrise (de ex. colțul piesei) · X spre dreapta, Y în sus, în mm reali",
    make: (pts) => ({ type: "ucs", p: pts[0] }) },

  { id: "dimLin", label: "Liniară", key: "D", group: "Cote", icon: "M4 6v12M20 6v12M4 12h16M4 12l3-2M4 12l3 2M20 12l-3-2M20 12l-3 2",
    hint: "Punct 1 → punct 2 → poziția liniei de cotă (orizontală sau verticală după unde muți)", ...dimTool("lin", "") },
  { id: "dimAli", label: "Aliniată", key: "A", group: "Cote", icon: "M5 15L15 5M5 15l1-3.5M5 15l3.5-1M15 5l-3.5 1M15 5l-1 3.5M3 13l4 4M13 3l4 4",
    hint: "Punct 1 → punct 2 → poziția liniei, paralelă cu segmentul", ...dimTool("ali", "") },
  { id: "dimDia", label: "Diametru", key: "O", group: "Cote", icon: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M5 19L19 5",
    hint: "Generatoarea de sus → cea de jos → poziția liniei (prefix Ø)", ...dimTool("lin", "Ø") },
  { id: "dimDiaC", label: "Diametru cerc", group: "Cote", icon: "M3 14a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0M14.1 9.4L19 4.5h3.5M14.1 9.4l0.5-3M14.1 9.4l3-0.5",
    kind: "clicks", n: 3, hint: "Centrul (snap ○) → un punct pe cerc → poziția textului: săgeata pe contur, linia spre centru, textul pe umăr",
    make: (pts, app) => ({ type: "rad", dia: true, style: "shoulder", c: pts[0], p: pts[1], p3: pts[2], prefix: "Ø", nominal: null, tol: app.defaultTol("Ø") }),
    preview(pts, cur, app) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      return this.make([pts[0], pts[1], cur], app);
    } },
  { id: "dimRad", label: "Rază", key: "R", group: "Cote", icon: "M4 20a16 16 0 0 1 16-16M4 20l11-11M15 9l-3.5 0.6M15 9l-0.6 3.5",
    kind: "clicks", n: 3, hint: "Centrul (snap ○) → un punct pe arc → capătul liniei de cotă",
    make: (pts, app) => ({ type: "rad", c: pts[0], p: pts[1], p3: pts[2], prefix: "R", nominal: null, tol: app.defaultTol("R") }),
    preview(pts, cur, app) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      return this.make([pts[0], pts[1], cur], app);
    } },
  { id: "dimOrd", label: "Ordonate", key: "", group: "Cote", icon: "M5 4v16h15M5 20l-2-2M9 20V8M14 20V11M19 20V6M5 15h4M5 10h9",
    kind: "poly", min: 2, place: true,
    hint: "Baza (cota 0) → punctele de cotat · Enter sau click dreapta → poziția rândului: sub / deasupra = cote pe X, stânga / dreapta = pe Y",
    placeHint: "Click pentru rândul de cote: sub sau deasupra punctelor = cote pe X, la stânga sau la dreapta = pe Y · Esc renunță",
    make(pts, app, _closed, cur) {
      const [base, ...rest] = pts;
      const at = cur || pts[pts.length - 1];
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      const dx = at[0] < Math.min(...xs) ? Math.min(...xs) - at[0] : at[0] > Math.max(...xs) ? at[0] - Math.max(...xs) : 0;
      const dy = at[1] < Math.min(...ys) ? Math.min(...ys) - at[1] : at[1] > Math.max(...ys) ? at[1] - Math.max(...ys) : 0;
      const axis = dx > dy ? "y" : "x";
      return { type: "ord", axis, base, pts: rest, row: axis === "x" ? at[1] : at[0] };
    },
    preview(pts, cur, app) {
      if (app.placing) return this.make(pts, app, false, cur);
      // while picking: a small cross on each point, the base with a circle-like square
      const r = 1.6 * K;
      const lines = [];
      pts.forEach((q, i) => {
        const m = i === 0 ? r * 1.6 : r;
        lines.push([[q[0] - m, q[1]], [q[0] + m, q[1]]], [[q[0], q[1] - m], [q[0], q[1] + m]]);
      });
      lines.push([pts[pts.length - 1], cur]);
      return { lines };
    } },
  { id: "dimCont", label: "În lanț", key: "", group: "Cote", icon: "M3 6v12M10 6v12M21 6v12M3 12h18M3 12l2.5-1.5M3 12l2.5 1.5M10 12l-2.5-1.5M10 12l-2.5 1.5M10 12l2.5-1.5M10 12l2.5 1.5M21 12l-2.5-1.5M21 12l-2.5 1.5",
    hint: "Punctele de cotat, unul după altul (cu snap) · Enter sau click dreapta → poziția liniei de cotă; cotele se așază cap la cap", ...dimSeriesTool("chain") },
  { id: "dimBase", label: "Față de bază", key: "", group: "Cote", icon: "M3 4v16M11 10v10M20 4v16M3 8h17M3 15h8M3 8l2.5-1.5M3 8l2.5 1.5M20 8l-2.5-1.5M20 8l-2.5 1.5M3 15l2.5-1.5M3 15l2.5 1.5M11 15l-2.5-1.5M11 15l-2.5 1.5",
    hint: "Baza (de unde pleacă toate cotele) → punctele de cotat · Enter sau click dreapta → poziția primei linii de cotă", ...dimSeriesTool("base") },
  { id: "holes", label: "Tabel găuri", key: "", group: "Cote", icon: "M3 4h11v9H3zM3 7h11M7 4v9M10 4v9M18 15.5a2.5 2.5 0 1 0 0.01 0M18 15.5h0",
    kind: "clicks", n: 1,
    hint: "Click pentru colțul dreapta-jos al tabelului · X, Y și Ø se iau din cotele ordonate ale paginii (DOR) și din cercurile găurilor",
    make: (pts, app) => app.holeTableAt(pts[0]) },
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
    make: (pts, app) => {
      const st = (app && app.cmdState) || {};
      const S = app && app.S ? app.S() : null;
      // option H: height in paper mm → the size factor of the standard text height
      const size = st.textH && S && S.h ? Math.min(5, Math.max(0.3, Math.round(((st.textH * K) / S.h) * 100) / 100)) : 1;
      return { type: "text", p: pts[0], text: "Text", angle: Number.isFinite(st.textA) ? st.textA : 0, size };
    } },

  { id: "rough", label: "Rugozitate", key: "Q", group: "Toleranțe", icon: "M3 13l3 5 8-14h7M6.5 13h5", kind: "clicks", n: 2,
    hint: "Punct pe suprafață → al doilea click în același loc = simbol direct, în altă parte = cu linie de indicație",
    make(pts) {
      const near = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 3 * K;
      return { type: "rough", target: pts[0], pos: near ? null : pts[1], kind: "remove", val: "Ra 3,2", method: "", rot: 0 };
    },
    preview(pts, cur) { return this.make([pts[0], cur]); } },
  { id: "gdt", label: "Cadru GD&T", key: "G", group: "Toleranțe", icon: "M2 8h20v8H2zM9 8v8M16 8v8M3.5 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", kind: "clicks", n: 2,
    hint: "Vârful săgeții (pe linia de cotă = axă, pe contur = suprafață) → poziția cadrului",
    make: (pts, app) => ({ type: "gdt", target: pts[0], pos: pts[1], anchor: gdtAnchor(pts[0], pts[1]), ...app.gdtDefaults() }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },
  { id: "datum", label: "Bază", key: "B", group: "Toleranțe", icon: "M8 4h8v8H8zM12 12v4M8.5 20h7L12 16z", kind: "clicks", n: 2,
    hint: "Punct pe element, pe linia de cotă sau pe marginea unui cadru GD&T → poziția casetei",
    make: (pts, app) => ({ type: "datum", target: pts[0], pos: pts[1], letter: app.nextDatumLetter() }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },

  { id: "note", label: "Note", key: "N", group: "Documentare", icon: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5", kind: "clicks", n: 1,
    hint: "Click pe colțul stânga-sus al blocului de note · textul (pe mai multe rânduri) se scrie în panou",
    make: (pts, app) => (app && app.settings && app.settings.dlang === "en"
      ? { type: "note", p: pts[0], title: "NOTES", text: "Break all sharp edges 0.5×45°\nGeneral tolerances ISO 2768-mK", numbered: true, frame: false, size: 1 }
      : { type: "note", p: pts[0], title: "NOTE", text: "Muchiile nespecificate se teșesc 0,5×45°\nToleranțe generale ISO 2768-mK", numbered: true, frame: false, size: 1 }),
  },
  { id: "revtab", label: "Tabel rev.", key: "E", group: "Documentare", icon: "M3 6h18v12H3zM3 10h18M3 14h18M8 6v12M17 6v12", kind: "clicks", n: 1,
    hint: "Click pe colțul dreapta-sus al cartușului: tabelul se așază deasupra, aliniat la dreapta",
    make: (pts, app) => ({ type: "revtab", p: pts[0], rows: app.revRowsFromStrikes(true), headerBottom: true }) },
  { id: "bom", label: "Componente", key: "", group: "Documentare", icon: "M3 5h18v14H3zM3 9h18M3 13h18M7 5v14M15 5v14", kind: "clicks", n: 1,
    hint: "Click pe colțul dreapta-sus al cartușului: lista se așază deasupra, cu câte un rând pentru fiecare reper",
    make: (pts, app) => ({ type: "bom", p: pts[0], rows: app.bomRowsFromBalloons([], true), headerBottom: true }) },
  { id: "line", label: "Linie", key: "I", group: "Desen", icon: "M4 19L20 5M4 19h0M20 5h0", kind: "clicks", n: 2, chain: true,
    hint: "Punct de start → capăt, sau scrie lungimea (Tab → unghiul) și Enter · linia următoare pornește din capăt · Shift ortho · Esc termină",
    make: (pts, app) => shape(app, "line", [pts[0], pts[1]]),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },
  { id: "poly", label: "Polilinie", key: "P", group: "Desen", icon: "M3 18l5-9 6 5 7-10", kind: "poly", min: 2,
    hint: "Click pe fiecare vârf · Enter, dublu-click sau Esc termină · click pe primul punct închide conturul",
    make: (pts, app, closed) => shape(app, "poly", pts, { closed: !!closed }),
    preview(pts, cur, app) { return this.make([...pts, cur], app); } },
  { id: "rect", label: "Dreptunghi", key: "J", group: "Desen", icon: "M4 6h16v12H4z", kind: "clicks", n: 2,
    hint: "Un colț → colțul opus (dimensiunile exacte se pot scrie apoi în panou)",
    make: (pts, app) => shape(app, "rect", [pts[0], pts[1]]),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },
  { id: "circle", label: "Cerc", key: "Y", group: "Desen", icon: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 12h8", kind: "clicks", n: 2,
    hint: "Centrul → un punct pe cerc (diametrul exact se poate scrie apoi în panou)",
    make: (pts, app) => shape(app, "circle", [pts[0], pts[1]]),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },
  { id: "arc", label: "Arc", key: "Z", group: "Desen", icon: "M4 18a10 10 0 0 1 16-8M12 18h0", kind: "clicks", n: 3,
    hint: "Centrul → începutul arcului → sfârșitul; sensul e cel în care miști cursorul",
    make(pts, app) {
      const ccw = arcState.key === pts[1] ? arcState.ccw : true;
      return shape(app, "arc", [pts[0], pts[1], pts[2]], { ccw });
    },
    preview(pts, cur, app) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      if (arcState.key !== pts[1]) {
        arcState.key = pts[1];
        arcState.last = null;
      }
      arcState.ccw = trackSweep(arcState, pts[0], pts[1], cur);
      return shape(app, "arc", [pts[0], pts[1], cur], { ccw: arcState.ccw });
    } },
  { id: "cross", label: "Axe cerc", key: "", group: "Desen", icon: "M12 2v20M2 12h20M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0", kind: "clicks", n: 2,
    hint: "Centrul cercului (snap ○) → un punct pe cerc: axele depășesc conturul cu 3 mm",
    make: (pts, app) => ({ type: "shape", kind: "cross", pts: [pts[0], pts[1]], ltype: "chain", w: 0.25, lscale: app.drawStyle.lscale || 1, ext: 3 }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },
  { id: "hatch", label: "Hașură", key: "", group: "Desen", icon: "M4 4h16v16H4zM4 12l8-8M4 20L20 4M12 20l8-8", kind: "poly", min: 3, closed: true,
    hint: "Click pe vârfurile zonei secționate (cu snap pe contur) · Enter sau click pe primul punct termină",
    make: (pts) => ({ type: "shape", kind: "hatch", pts, ltype: "cont", w: 0.18, angle: 45, sp: 2, cross: false, outline: false }),
    preview(pts, cur, app) {
      const all = [...pts, cur];
      return all.length >= 3 ? this.make(all, app) : { type: "shape", kind: "poly", pts: all, ltype: "cont", w: 0.18 };
    } },

  { id: "break", label: "Ruptură", key: "", group: "Desen", icon: "M2 12h7l2-5 2 10 2-5h7", kind: "clicks", n: 2,
    hint: "Capetele liniei de ruptură; zigzagul se pune la mijloc (sau ondulată, din panou)",
    make: (pts) => ({ type: "shape", kind: "break", pts: [pts[0], pts[1]], ltype: "cont", w: 0.25, style: "zigzag" }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },

  { id: "section", label: "Secțiune", key: "", group: "Vederi", icon: "M4 4v16M20 4v16M4 8h-0M4 12l4 0M20 12l-4 0M6 10l2 2-2 2M18 10l-2 2 2 2", kind: "clicks", n: 3,
    hint: "Capetele planului de secționare → partea spre care privești (acolo arată săgețile)",
    make: (pts, app) => ({ type: "section", pts: [pts[0], pts[1]], vp: pts[2], letter: app.nextViewLetter() }),
    preview(pts, cur, app) {
      if (pts.length === 1) return { line: [pts[0], cur] };
      return this.make([pts[0], pts[1], cur], app);
    } },
  { id: "detail", label: "Detaliu", key: "", group: "Vederi", icon: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M17 7l3-3", kind: "clicks", n: 2,
    hint: "Centrul zonei → raza cercului de detaliu; litera se poate muta din pătrățelul ei",
    make: (pts, app) => ({ type: "detail", pts: [pts[0], pts[1]], letter: app.nextViewLetter() }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },
  { id: "viewlabel", label: "Etichetă", key: "", group: "Vederi", icon: "M4 18L8 6l4 12M5.5 14h5M14 12h6", kind: "clicks", n: 1,
    hint: "Click deasupra vederii: se propune „A–A” pentru secțiuni sau „B (2:1)” pentru detalii încă neetichetate",
    make: (pts, app) => ({ type: "text", p: pts[0], text: app.nextViewLabel(), angle: 0, scale: 1.4 }) },
  { id: "tblock", label: "Indicator", key: "", group: "Documentare", icon: "M2 13h20v7H2zM2 16.5h20M9 13v7M16 13v7", kind: "clicks", n: 1,
    hint: "Click pe colțul dreapta-jos al chenarului (se prinde cu snap) · câmpurile se completează în panou",
    make: (pts, app) => app.tblockAt(pts[0]),
    preview(pts, cur, app) { return app.tblockAt(cur, true); } },
  { id: "stamp", label: "Ștampilă", key: "", group: "Documentare", icon: "M4 6h16v9H4zM6.5 8.5h11v4h-11zM8 18h8", kind: "clicks", n: 1,
    hint: "Click unde pui ștampila · textul, culoarea, data și numele din panou",
    make: (pts, app) => app.stampAt(pts[0]),
    preview(pts, cur, app) { return app.stampAt(cur); } },
  { id: "qr", label: "Cod QR", key: "", group: "Documentare", icon: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z", kind: "clicks", n: 1,
    hint: "Click pe colțul stânga-sus al codului · conținutul (nr. desen, revizie, dată, link) din panou",
    make: (pts, app) => app.qrAt(pts[0]),
    preview(pts, cur, app) { return app.qrAt(cur, true); } },
  { id: "image", label: "Imagine", key: "", group: "Documentare", icon: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9a1.5 1.5 0 1 0 0.01 0", kind: "rect",
    hint: "Trage dreptunghiul imaginii (proporțiile se păstrează; Shift = liber) · click = 50 mm lățime · Ctrl+V lipește o imagine copiată",
    make: (r, app) => ({ type: "image", r, img: app.pendingImage.img, iw: app.pendingImage.w, ih: app.pendingImage.h, rot: 0, op: 1 }) },
  { id: "balloon", label: "Reper", key: "", group: "Vederi", icon: "M14 9a5 5 0 1 0 0.01 0M10.5 12.5L4 19M4 19h0", kind: "clicks", n: 2,
    hint: "Punct pe piesă → poziția cercului; numărul crește automat",
    make: (pts, app) => ({ type: "balloon", target: pts[0], pos: pts[1], num: app.nextBalloon(), shape: "circle", end: "dot" }),
    preview(pts, cur, app) { return this.make([pts[0], cur], app); } },

  { id: "cloud", label: "Nor de revizie", key: "", group: "Revizie", icon: "M6 8a2 2 0 0 1 4-1a2 2 0 0 1 4 0a2 2 0 0 1 4 1a2 2 0 0 1 0 4a2 2 0 0 1 0 4a2 2 0 0 1-4 1a2 2 0 0 1-4 0a2 2 0 0 1-4-1a2 2 0 0 1 0-4a2 2 0 0 1 0-4z", kind: "rect",
    hint: "Trage un dreptunghi în jurul zonei modificate · triunghiul de revizie și mărimea arcelor din panou",
    make: (r, app) => ({ type: "cloud", r, arc: app.cloudArc || 6, tri: true, rev: app.settings.revNo || "1", layer: "rev" }) },
  { id: "mark", label: "Marker", key: "", group: "Revizie", icon: "M4 20h7M14.5 4.5l5 5L10 19l-5 1 1-5z", kind: "free",
    hint: "Trage peste ce vrei să evidențiezi (Shift = linie dreaptă) · culoarea și grosimea din panou",
    make: (pts, app) => ({ type: "mark", pts, color: (app.markStyle || {}).color || "hlGreen", w: (app.markStyle || {}).w || 6 }) },
  { id: "comment", label: "Comentariu", key: "", group: "Revizie", icon: "M4 5h16v11H9l-5 4z", kind: "clicks", n: 1,
    hint: "Click unde vrei comentariul · textul se scrie în panou · nu se tipărește; la export devine notă PDF",
    make: (pts, app) => ({ type: "comment", p: pts[0], text: "", author: app.settings.author || "", date: new Date().toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" }), done: false }) },
  { id: "strike", label: "Taie cota", key: "S", group: "Revizie", icon: "M5 7h6M8 7v10M14 7h5M16.5 7v10M3 12h18", kind: "rect",
    hint: "Trage un dreptunghi peste valoarea veche → scrie valoarea nouă în panou",
    make: (r, app) => ({ type: "strike", r, newText: "", rev: app.settings.revNo, layer: "rev" }) },
  { id: "white", label: "Acoperă", key: "W", group: "Revizie", icon: "M3 6h18v12H3zM7 10h10M7 14h6", kind: "rect",
    hint: "Trage un dreptunghi alb peste zonă (conținutul rămâne în fișier)",
    make: (r) => ({ type: "white", r }) },
  { id: "ink", label: "Înnegrește", key: "", group: "Revizie", icon: "M4 20h16M7 16l7.5-12 3 2L10 18H7zM12.5 7.5l3 2", kind: "rect",
    hint: "Trage un dreptunghi peste liniile originale care ies slab la tipărire → devin negre (doar ele)",
    make: (r) => ({ type: "ink", r, ids: [], objs: [] }) },
  { id: "redact", label: "Șterge", key: "X", group: "Revizie", icon: "M7 20h12M5 15.5l9-9 5 5-6.5 6.5H9z", kind: "rect",
    hint: "Trage un dreptunghi → alegi ce obiecte din original se elimină",
    make: (r) => ({ type: "redact", r, ids: [], objs: [] }) },
  { id: "calib", label: "Calibrare", key: "K", group: "Revizie", icon: "M3 17h18M5 17v-4M9 17v-2M13 17v-4M17 17v-2M21 17v-4M3 7h18M3 7l3-2M3 7l3 2M21 7l-3-2M21 7l-3 2", kind: "clicks", n: 2,
    hint: "Click pe capetele unei cote cunoscute → introduci valoarea reală",
    preview(pts, cur) { return { line: [pts[0], cur] }; } },
];

// ------------------------------------------------------------------ prompts and options (CMD-D5)
// Each tool step has a prompt; options are chosen in the command line by AutoCAD's English keyword
// letter (or the whole word, in English or Romanian) or by a click. `run(app)` acts on the app.

const DIM_PROMPTS = ["Originea primei linii ajutătoare", "Originea celei de-a doua linii ajutătoare", "Poziția liniei de cotă"];
const PROMPTS = {
  ucs: ["Originea (0,0)"],
  text: ["Locul textului"],
  moveSel: ["Punctul de bază", "Al doilea punct (sau @dx,dy)"],
  copySel: ["Punctul de bază", "Unde pui copia (sau @dx,dy; Enter = gata)"],
  measure: ["Primul punct", "Al doilea punct"],
  dimLin: DIM_PROMPTS,
  dimAli: DIM_PROMPTS,
  dimDia: DIM_PROMPTS,
  dimDiaC: ["Centrul", "Un punct pe cerc", "Poziția textului"],
  dimRad: ["Centrul", "Un punct pe arc", "Capătul liniei de cotă"],
  dimAng: ["Vârful unghiului", "Un punct pe prima latură", "Un punct pe a doua latură", "Poziția arcului"],
  dimOrd: ["Baza (cota 0)", "Punctul de cotat (Enter = gata)"],
  dimCont: ["Primul punct", "Punctul următor (Enter = gata)"],
  dimBase: ["Baza", "Punctul de cotat (Enter = gata)"],
  line: ["Primul punct", "Punctul următor"],
  poly: ["Primul vârf", "Vârful următor (Enter = gata)"],
  rect: ["Primul colț", "Colțul opus"],
  circle: ["Centrul", "Raza sau un punct pe cerc"],
};
const PLACE_PROMPTS = {
  dimOrd: "Poziția rândului de cote",
  dimCont: "Poziția liniei de cotă",
  dimBase: "Poziția primei linii de cotă",
};

const optText = {
  key: "T", label: "Text", en: ["TEXT"],
  run: (app) => app.askValue("Textul cotei (un număr = valoarea nominală; gol = valoarea măsurată)", (v) => {
    app.cmdState.text = v;
    return true;
  }),
};
const optUndo = { key: "U", label: "Anulează pasul", en: ["UNDO", "ANULEAZA"], when: (app) => app.clicks.length > 0 || !!(app.chain && app.chain.ids.length), run: (app) => app.undoStep() };
const optClose = { key: "C", label: "Închide", en: ["CLOSE"], run: (app) => app.closeStep() };

const OPTIONS = {
  dimLin: [
    optText,
    { key: "H", label: "Orizontal", en: ["HORIZONTAL"], run: (app) => { app.cmdState.orient = "h"; } },
    { key: "V", label: "Vertical", en: ["VERTICAL"], run: (app) => { app.cmdState.orient = "v"; } },
  ],
  dimAli: [optText],
  dimDia: [optText],
  dimDiaC: [optText],
  dimRad: [optText],
  dimAng: [optText],
  dimOrd: [
    { key: "X", label: "Pe X", en: ["XDATUM"], run: (app) => { app.cmdState.axis = "x"; } },
    { key: "Y", label: "Pe Y", en: ["YDATUM"], run: (app) => { app.cmdState.axis = "y"; } },
    optUndo,
  ],
  dimCont: [optUndo, { key: "S", label: "Din cota existentă", en: ["SELECT"], when: (app) => !app.clicks.length && !app.placing, run: (app) => app.pickSeriesDim() }],
  dimBase: [optUndo, { key: "S", label: "Din cota existentă", en: ["SELECT"], when: (app) => !app.clicks.length && !app.placing, run: (app) => app.pickSeriesDim() }],
  line: [optUndo, { ...optClose, when: (app) => !!(app.chain && app.chain.ids.length >= 2) }],
  poly: [optUndo, { ...optClose, when: (app) => app.clicks.length >= 3 }],
  circle: [{
    key: "D", label: "Diametru", en: ["DIAMETER"], when: (app) => app.clicks.length === 1,
    run: (app) => app.askValue("Diametrul (mm reali)", (v) => app.circleByDiameter(parseNum(v))),
  }],
  rect: [{
    key: "D", label: "Dimensiuni", en: ["DIMENSIONS"], when: (app) => app.clicks.length === 1,
    run: (app) => app.askValue("Lungimea pe X (mm reali)", (v) => {
      const w = parseNum(v);
      if (!(Math.abs(w) > 0)) return false;
      app.askValue("Lățimea pe Y (mm reali)", (v2) => app.rectBySize(w, parseNum(v2)));
      return true;
    }),
  }],
  ucs: [{ key: "W", label: "Colțul paginii", en: ["WORLD"], run: (app) => app.ucsWorld() }],
  text: [
    { key: "H", label: "Înălțime", en: ["HEIGHT"], run: (app) => app.askValue("Înălțimea textului (mm pe hârtie)", (v) => {
      const h = parseNum(v);
      if (!(h > 0)) return false;
      app.cmdState.textH = h;
      return true;
    }) },
    { key: "R", label: "Rotire", en: ["ROTATION", "ROTATE"], run: (app) => app.askValue("Unghiul textului (grade, în sens trigonometric)", (v) => {
      const a = parseNum(v);
      if (a == null) return false;
      app.cmdState.textA = ((a % 360) + 360) % 360;
      return true;
    }) },
  ],
  measure: [{ key: "M", label: "Mai multe puncte", en: ["MULTIPLE"], when: (app) => !app.cmdState || !app.cmdState.multi, run: (app) => { app.cmdState.multi = true; } }],
};

/** The prompt of a tool in the current state: { text, opts } (opts only those available now). */
export function promptFor(t, app) {
  if (!t) return { text: "", opts: [] };
  const list = PROMPTS[t.id];
  const n = (app.clicks || []).length;
  let text = app.placing && PLACE_PROMPTS[t.id] ? PLACE_PROMPTS[t.id] : list ? list[Math.min(n, list.length - 1)] : `Punctul ${n + 1}`;
  if (app.cmdState && app.cmdState.orient) text += app.cmdState.orient === "h" ? " (orizontal)" : " (vertical)";
  if (app.cmdState && app.cmdState.axis) text += ` (pe ${app.cmdState.axis.toUpperCase()})`;
  const opts = (OPTIONS[t.id] || []).filter((o) => !o.when || o.when(app));
  return { text, opts };
}

const fold = (s) => String(s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "");

/** The option a typed text means: the key letter, the English keyword or the Romanian label. */
export function resolveOption(opts, text) {
  const q = fold(text);
  if (!q) return null;
  return (opts || []).find((o) => o.key === q || (o.en || []).includes(q) || fold(o.label) === q) || null;
}

/** Options and typed text applied to what a dimension tool makes (also to its preview). */
function applyDimState(a, st, cur) {
  if (!a || Array.isArray(a) || !st) return a;
  if (st.orient && a.type === "dim" && a.kind === "lin") a.orient = st.orient;
  if (st.axis && a.type === "ord") {
    a.axis = st.axis;
    const at = cur || a.pts[a.pts.length - 1] || a.base;
    a.row = st.axis === "x" ? at[1] : at[0];
  }
  if (st.text != null && String(st.text).trim() !== "" && ["dim", "rad", "ang"].includes(a.type)) {
    const v = parseNum(st.text);
    if (v != null) a.nominal = v;
    else a.textOverride = String(st.text).trim();
  }
  return a;
}

for (const t of TOOLS) {
  if (!OPTIONS[t.id] || !t.make || !["dimLin", "dimAli", "dimDia", "dimDiaC", "dimRad", "dimAng", "dimOrd"].includes(t.id)) continue;
  const make = t.make;
  t.make = function (pts, app, closed, cur) {
    return applyDimState(make.call(this, pts, app, closed, cur), app && app.cmdState, cur);
  };
}

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

/**
 * The tool rail (UI v2, UI-D1 as revised in docs/design/ui-v2/research.md): one slot per family, with an
 * icon and a short label; the other members are in a flyout. `sep` starts a new group on the rail.
 * Every visible tool is in exactly one family, except `calib` (key K, CALIB, Straturi tab).
 */
export const FAMILIES = [
  { id: "select", label: "Selecție", tools: ["select"] },
  { id: "pan", label: "Pan", tools: ["pan"] },
  { id: "measure", label: "Măsoară", tools: ["measure", "ucs"] },
  { id: "dims", label: "Cote", sep: true, tools: ["dimLin", "dimAli", "dimDia", "dimDiaC", "dimRad", "dimAng", "chamfer", "dimOrd", "dimCont", "dimBase", "holes"] },
  { id: "tol", label: "Toleranțe", tools: ["rough", "gdt", "datum"] },
  { id: "notes", label: "Adnotări", tools: ["text", "lead", "note", "revtab", "bom", "balloon", "tblock", "stamp", "qr", "image"] },
  { id: "draw", label: "Desen", sep: true, tools: ["line", "poly", "rect", "circle", "arc", "cross", "hatch", "break"] },
  { id: "views", label: "Vederi", tools: ["section", "detail", "viewlabel"] },
  { id: "rev", label: "Revizie", sep: true, tools: ["strike", "cloud", "mark", "comment", "white", "ink", "redact"] },
];
export const FAMILY_OF = Object.fromEntries(FAMILIES.flatMap((f) => f.tools.map((t) => [t, f.id])));
/** Tools reached only by key, command or another button, not from the rail. */
export const OFF_RAIL = ["calib"];
export const TOOL_BY_KEY = Object.fromEntries(TOOLS.filter((t) => t.key).map((t) => [t.key.toLowerCase(), t]));
export const DRAW_TOOLS = new Set(TOOLS.filter((t) => t.group === "Desen").map((t) => t.id));

export function finalize(a) {
  return { id: newId(), layer: a.layer || "add", ...a };
}
