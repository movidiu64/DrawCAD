// ISO 286-1/-2: toleranțe fundamentale (IT) și abateri fundamentale.
// Valori în µm. Intervale „peste a până la b inclusiv”. Domeniu: 0 < D ≤ 500 mm.
// Litere acoperite: arbori d e f g h js k m n p r s; alezaje D E F G H JS K M N P R S.

const RANGES = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];

const IT = {
  1: [0.8, 1, 1, 1.2, 1.5, 1.5, 2, 2.5, 3.5, 4.5, 6, 7, 8],
  2: [1.2, 1.5, 1.5, 2, 2.5, 2.5, 3, 4, 5, 7, 8, 9, 10],
  3: [2, 2.5, 2.5, 3, 4, 4, 5, 6, 8, 10, 12, 13, 15],
  4: [3, 4, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20],
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
  12: [100, 120, 150, 180, 210, 250, 300, 350, 400, 460, 520, 570, 630],
  13: [140, 180, 220, 270, 330, 390, 460, 540, 630, 720, 810, 890, 970],
  14: [250, 300, 360, 430, 520, 620, 740, 870, 1000, 1150, 1300, 1400, 1550],
  15: [400, 480, 580, 700, 840, 1000, 1200, 1400, 1600, 1850, 2100, 2300, 2500],
  16: [600, 750, 900, 1100, 1300, 1600, 1900, 2200, 2500, 2900, 3200, 3600, 4000],
};

// Abateri fundamentale ale arborilor: es pentru d..g (negative), ei pentru k..p (pozitive)
const SHAFT_ES = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
const SHAFT_EI = {
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5], // pentru IT4…IT7; altfel 0
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};
// r și s au intervale subdivizate peste 50 mm: [limită superioară, ei]
const SHAFT_EI_FINE = {
  r: [[3, 10], [6, 15], [10, 19], [18, 23], [30, 28], [50, 34], [65, 41], [80, 43], [100, 51], [120, 54],
      [140, 63], [160, 65], [180, 68], [200, 77], [225, 80], [250, 84], [280, 94], [315, 98], [355, 108],
      [400, 114], [450, 126], [500, 132]],
  s: [[3, 14], [6, 19], [10, 23], [18, 28], [30, 35], [50, 43], [65, 53], [80, 59], [100, 71], [120, 79],
      [140, 92], [160, 100], [180, 108], [200, 122], [225, 130], [250, 140], [280, 158], [315, 170],
      [355, 190], [400, 208], [450, 232], [500, 252]],
};

export const SUPPORTED_SHAFT = ["d", "e", "f", "g", "h", "js", "k", "m", "n", "p", "r", "s"];
export const SUPPORTED_HOLE = SUPPORTED_SHAFT.map((l) => l.toUpperCase());

function rangeIndex(D) {
  for (let i = 0; i < RANGES.length; i++) if (D <= RANGES[i] + 1e-9) return i;
  return -1;
}

function rangeLabel(i) {
  const lo = i === 0 ? 0 : RANGES[i - 1];
  return i === 0 ? `până la ${RANGES[0]}` : `${lo}–${RANGES[i]}`;
}

function fineValue(table, D) {
  for (const [hi, v] of table) if (D <= hi + 1e-9) return v;
  return null;
}

export function itValue(grade, D) {
  const i = rangeIndex(D);
  if (i < 0 || !IT[grade]) return null;
  return IT[grade][i];
}

/** Abaterea inferioară ei a unui arbore k..s (fără js, h…). */
function shaftEi(letter, grade, D, i) {
  if (letter === "k") return grade >= 4 && grade <= 7 ? SHAFT_EI.k[i] : 0;
  if (SHAFT_EI[letter]) return SHAFT_EI[letter][i];
  if (SHAFT_EI_FINE[letter]) return fineValue(SHAFT_EI_FINE[letter], D);
  return null;
}

function jsHalf(it, grade) {
  // ISO 286: la js7…js11, o valoare IT impară se rotunjește la valoarea pară inferioară
  let v = it;
  if (grade >= 7 && grade <= 11 && Number.isInteger(v) && v % 2 === 1) v -= 1;
  return v / 2;
}

/** Parsează un câmp de toleranță: „k6”, „H7”, „js6”, „JS7”. */
export function parseFit(str) {
  const m = /^\s*([A-Za-z]{1,2})\s*(\d{1,2})\s*$/.exec(str || "");
  if (!m) return null;
  const letters = m[1];
  const grade = parseInt(m[2], 10);
  const isHole = letters[0] === letters[0].toUpperCase();
  const norm = letters.toLowerCase();
  if (!SUPPORTED_SHAFT.includes(norm)) return null;
  if (isHole && letters !== letters.toUpperCase()) return null; // „Js” nu e valid
  if (!isHole && letters !== letters.toLowerCase()) return null;
  return { letter: norm, grade, isHole, code: letters + grade };
}

/**
 * Calculează abaterile pentru un nominal și un câmp.
 * Întoarce { ok, upper, lower, it, isHole, range, code } în µm sau { ok:false, error }.
 */
export function deviations(nominal, fitStr) {
  const D = Number(nominal);
  if (!(D > 0) || D > 500) return { ok: false, error: "Nominal în afara domeniului 0–500 mm" };
  const f = parseFit(fitStr);
  if (!f) return { ok: false, error: "Câmp necunoscut (ex.: H7, k6, js6)" };
  const i = rangeIndex(D);
  const it = IT[f.grade] ? IT[f.grade][i] : null;
  if (it == null) return { ok: false, error: "Treaptă IT neacoperită (1–16)" };
  const L = f.letter;
  let upper;
  let lower;

  if (!f.isHole) {
    if (L === "js") {
      const h = jsHalf(it, f.grade);
      upper = h;
      lower = -h;
    } else if (SHAFT_ES[L]) {
      upper = SHAFT_ES[L][i];
      lower = upper - it;
    } else {
      const ei = shaftEi(L, f.grade, D, i);
      if (ei == null) return { ok: false, error: "Abatere necunoscută" };
      lower = ei;
      upper = ei + it;
    }
  } else {
    if (L === "js") {
      const h = jsHalf(it, f.grade);
      upper = h;
      lower = -h;
    } else if (SHAFT_ES[L]) {
      // D, E, F, G, H: EI = −es
      lower = -SHAFT_ES[L][i];
      upper = lower + it;
    } else {
      // K, M, N (≤ IT8) și P, R, S (≤ IT7): ES = −ei + Δ, Δ = IT(n) − IT(n−1)
      const useDelta = (["k", "m", "n"].includes(L) && f.grade <= 8) || (["p", "r", "s"].includes(L) && f.grade <= 7);
      const ei = L === "k" ? SHAFT_EI.k[i] : shaftEi(L, f.grade, D, i);
      let ES;
      if (L === "k" && f.grade > 8) ES = 0;
      else if (L === "n" && f.grade > 8) ES = 0;
      else if (useDelta && f.grade >= 3 && i > 0) ES = -ei + (IT[f.grade][i] - IT[f.grade - 1][i]);
      else ES = -ei;
      upper = ES;
      lower = ES - it;
    }
  }
  const clean = (v) => (Object.is(v, -0) ? 0 : v);
  return {
    ok: true,
    upper: clean(upper),
    lower: clean(lower),
    it,
    isHole: f.isHole,
    grade: f.grade,
    code: f.code,
    range: rangeLabel(i),
  };
}

/** Formatează o abatere din µm în mm, cu semn: +0,015 / −0,002 / 0 / ±0,0065 */
export function fmtDev(um, sep = ",", sign = true) {
  if (Math.abs(um) < 1e-9) return "0";
  let s = (Math.abs(um) / 1000).toFixed(4);
  s = s.replace(/0+$/, "");
  const dec = s.split(".")[1] || "";
  if (dec.length < 3) s = (Math.abs(um) / 1000).toFixed(3);
  s = s.replace(".", sep);
  if (!sign) return s;
  return (um > 0 ? "+" : "-") + s;
}
