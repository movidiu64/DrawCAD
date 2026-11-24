// ISO 1101 symbols, drawn as primitives in a unit square (y down).
// Each symbol: a list of { t: "L"|"P"|"C", ... } in 0…1 coordinates.

function arc(cx, cy, r, a0, a1, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(cx + r * Math.cos(a), cy - r * Math.sin(a));
  }
  return pts;
}

function head(x1, y1, x2, y2, len = 0.28, half = 0.11) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;
  const bx = x2 - ux * len;
  const by = y2 - uy * len;
  return { t: "P", p: [x2, y2, bx - uy * half, by + ux * half, bx + uy * half, by - ux * half], close: true, fill: true };
}

export const GDT_SYMBOLS = [
  { id: "str", dia: true, name: "Rectitudine", group: "Formă", datum: "none", draw: () => [{ t: "L", p: [0.05, 0.5, 0.95, 0.5] }] },
  { id: "flat", name: "Planitate", group: "Formă", datum: "none", draw: () => [{ t: "P", p: [0.3, 0.25, 0.97, 0.25, 0.7, 0.75, 0.03, 0.75], close: true }] },
  { id: "circ", name: "Circularitate", group: "Formă", datum: "none", draw: () => [{ t: "C", p: [0.5, 0.5], r: 0.42 }] },
  {
    id: "cyl", name: "Cilindricitate", group: "Formă", datum: "none",
    draw: () => [{ t: "C", p: [0.5, 0.5], r: 0.3 }, { t: "L", p: [0.05, 0.95, 0.42, 0.05] }, { t: "L", p: [0.58, 0.95, 0.95, 0.05] }],
  },
  { id: "profL", name: "Formă dată a unei linii", group: "Profil", datum: "opt", draw: () => [{ t: "P", p: arc(0.5, 0.75, 0.45, Math.PI, 0) }] },
  { id: "profS", name: "Formă dată a unei suprafețe", group: "Profil", datum: "opt", draw: () => [{ t: "P", p: arc(0.5, 0.75, 0.45, Math.PI, 0), close: true }] },
  { id: "par", dia: true, name: "Paralelism", group: "Orientare", datum: "req", draw: () => [{ t: "L", p: [0.12, 0.95, 0.52, 0.05] }, { t: "L", p: [0.48, 0.95, 0.88, 0.05] }] },
  { id: "perp", dia: true, name: "Perpendicularitate", group: "Orientare", datum: "req", draw: () => [{ t: "L", p: [0.5, 0.05, 0.5, 0.92] }, { t: "L", p: [0.05, 0.92, 0.95, 0.92] }] },
  { id: "ang", dia: true, name: "Înclinare", group: "Orientare", datum: "req", draw: () => [{ t: "L", p: [0.05, 0.92, 0.95, 0.92] }, { t: "L", p: [0.05, 0.92, 0.85, 0.3] }] },
  {
    id: "pos", dia: true, name: "Poziție", group: "Poziție", datum: "req",
    draw: () => [{ t: "C", p: [0.5, 0.5], r: 0.32 }, { t: "L", p: [0.5, 0.0, 0.5, 1.0] }, { t: "L", p: [0.0, 0.5, 1.0, 0.5] }],
  },
  { id: "coax", dia: true, name: "Coaxialitate / concentricitate", group: "Poziție", datum: "req", draw: () => [{ t: "C", p: [0.5, 0.5], r: 0.42 }, { t: "C", p: [0.5, 0.5], r: 0.2 }] },
  {
    id: "sym", name: "Simetrie", group: "Poziție", datum: "req",
    draw: () => [{ t: "L", p: [0.05, 0.5, 0.95, 0.5] }, { t: "L", p: [0.22, 0.24, 0.78, 0.24] }, { t: "L", p: [0.22, 0.76, 0.78, 0.76] }],
  },
  { id: "runC", name: "Bătaie circulară", group: "Bătaie", datum: "req", draw: () => [{ t: "L", p: [0.2, 0.92, 0.72, 0.18] }, head(0.2, 0.92, 0.8, 0.08)] },
  {
    id: "runT", name: "Bătaie totală", group: "Bătaie", datum: "req",
    draw: () => [
      { t: "L", p: [0.05, 0.92, 0.55, 0.92] },
      { t: "L", p: [0.08, 0.92, 0.42, 0.22] }, head(0.08, 0.92, 0.47, 0.12),
      { t: "L", p: [0.45, 0.92, 0.79, 0.22] }, head(0.45, 0.92, 0.84, 0.12),
    ],
  },
];

/** The tolerance zone can be cylindrical (Ø) only for these characteristics (an axis): straightness,
 * orientation, position and coaxiality; never for flatness, roundness, cylindricity, profile, symmetry
 * or run-out. */
export const diaAllowed = (id) => !!(GDT_SYMBOLS.find((s) => s.id === id) || {}).dia;

export const GDT_BY_ID = Object.fromEntries(GDT_SYMBOLS.map((s) => [s.id, s]));

export const MODIFIERS = [
  { id: "M", glyph: "Ⓜ", name: "Condiția de maxim de material" },
  { id: "L", glyph: "Ⓛ", name: "Condiția de minim de material" },
  { id: "P", glyph: "Ⓟ", name: "Zonă de toleranță proiectată" },
  { id: "F", glyph: "Ⓕ", name: "Stare liberă" },
  { id: "CZ", glyph: "CZ", name: "Zonă comună" },
];

/** Turns the symbol into primitives placed in the square (x, y, size). */
export function symbolPrims(id, x, y, size, w, layer) {
  const s = GDT_BY_ID[id];
  if (!s) return [];
  return s.draw().map((p) => {
    const q = { ...p, w, c: layer };
    if (p.t === "C") {
      q.p = [x + p.p[0] * size, y + p.p[1] * size];
      q.r = p.r * size;
    } else {
      q.p = p.p.map((v, i) => (i % 2 === 0 ? x + v * size : y + v * size));
    }
    return q;
  });
}
