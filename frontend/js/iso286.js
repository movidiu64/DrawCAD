// ISO 286-1:2010 — limit deviations computed as the standard defines them: one limit is the
// fundamental deviation of the letter, the other is obtained by adding/subtracting the grade's IT (plus Δ for holes
// K…ZC in the fine grades). The logic is ported from TechTools (iso286_logic.dart) and the data comes from
// iso286_data.js; the check against all values printed in ISO 286-2 is described there.
// Letters: uppercase = hole ("H", "JS", "ZA"), lowercase = shaft ("g", "js", "za"). Values in µm, 0 < D ≤ 500 mm.
import { BRACKETS, IT, SHAFT_FD, K_EI, J_SHAFT_EI, J_HOLE_ES } from "./iso286_data.js";

/** Letters offered, in the order of the standard (t, v, y are not included, as in TechTools). */
export const LETTERS = ["a", "b", "c", "cd", "d", "e", "ef", "f", "fg", "g", "h", "js", "j", "k", "m", "n", "p", "r", "s", "u", "x", "z", "za", "zb", "zc"];
export const SUPPORTED_SHAFT = LETTERS;
export const SUPPORTED_HOLE = LETTERS.map((l) => l.toUpperCase());

// letters whose fundamental shaft deviation is the upper one (es); for holes it becomes EI = −es
const ES_LETTERS = new Set(["a", "b", "c", "cd", "d", "e", "ef", "f", "fg", "g"]);
// holes whose ES gets Δ in the fine grades; Δ is defined from IT3, so they start at grade 3
const DELTA_HOLE = new Set(["k", "m", "n", "p", "r", "s", "u", "x", "z", "za", "zb", "zc"]);

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Possible grades for a letter (j/J only a few; J9 and above are JS). */
export function gradesFor(letter) {
  const l = letter.toLowerCase();
  const hole = letter !== l;
  if (l === "j") return hole ? [6, 7, 8] : [5, 6, 7, 8];
  if (hole && DELTA_HOLE.has(l)) return range(3, 18);
  return range(1, 18);
}

function bracketIndex(D) {
  if (!(D > 0) || D > 500) return -1;
  for (let i = 0; i < BRACKETS.length; i++) if (D <= BRACKETS[i] + 1e-9) return i;
  return -1;
}

function rangeLabel(i) {
  return i === 0 ? `până la ${BRACKETS[0]}` : `${BRACKETS[i - 1]}–${BRACKETS[i]}`;
}

// Δ = IT(n) − IT(n−1), zero up to 3 mm
function delta(grade, i) {
  if (BRACKETS[i] <= 3) return 0;
  return IT[grade][i] - IT[grade - 1][i];
}

export function itValue(grade, D) {
  const i = bracketIndex(D);
  return i < 0 || !IT[grade] ? null : IT[grade][i];
}

/** Deviations [upper, lower] in µm, or null where the standard does not define the class. */
function limitDeviations(letter, grade, D) {
  const i = bracketIndex(D);
  if (i < 0 || !gradesFor(letter).includes(grade)) return null;
  const it = IT[grade] && IT[grade][i];
  if (it == null) return null;
  // the "≤ 1 mm" notes from ISO 286-2 Tables 1, 2, 6, 9, 17
  const upTo1 = D <= 1;
  if (grade >= 14 && upTo1) return null;
  const l = letter.toLowerCase();
  const hole = letter !== l;
  const top = BRACKETS[i];

  if (l === "h") return hole ? [it, 0] : [0, -it];
  if (l === "js") return [it / 2, -it / 2];
  if ((l === "a" || l === "b") && upTo1) return null;

  if (!hole) {
    if (l === "j") {
      const ei = J_SHAFT_EI[grade] && J_SHAFT_EI[grade][i];
      return ei == null ? null : [ei + it, ei];
    }
    if (l === "k") {
      const ei = grade >= 4 && grade <= 7 ? K_EI[i] : 0;
      return [ei + it, ei];
    }
    const fd = SHAFT_FD[l] && SHAFT_FD[l][i];
    if (fd == null) return null;
    return ES_LETTERS.has(l) ? [fd, fd - it] : [fd + it, fd];
  }

  // holes
  if (l === "j") {
    const es = J_HOLE_ES[grade] && J_HOLE_ES[grade][i];
    return es == null ? null : [es, es - it];
  }
  if (ES_LETTERS.has(l)) {
    const fd = SHAFT_FD[l] && SHAFT_FD[l][i];
    if (fd == null) return null;
    const ei = -fd; // mirror of the shaft letter
    return [ei + it, ei];
  }
  let es;
  if (l === "k") {
    if (grade <= 8) es = -K_EI[i] + delta(grade, i);
    else if (top <= 3) es = 0;
    else return null; // K above IT8 is not defined above 3 mm
    return [es, es - it];
  }
  const fd = SHAFT_FD[l] && SHAFT_FD[l][i];
  if (fd == null) return null;
  if (l === "m") {
    es = grade <= 8 ? -fd + delta(grade, i) : -fd;
    if (grade === 6 && top > 250 && top <= 315) es = -9; // special case of ISO 286-1
  } else if (l === "n") {
    if (grade <= 8) es = -fd + delta(grade, i);
    else {
      if (upTo1) return null; // N9…N11 not for ≤ 1 mm
      es = top <= 3 ? -fd : 0;
    }
  } else {
    es = grade <= 7 ? -fd + delta(grade, i) : -fd; // P…ZC
  }
  return [es, es - it];
}

/** Parses a tolerance class: "k6", "H7", "js6", "ZA8". */
export function parseFit(str) {
  const m = /^\s*([A-Za-z]{1,2})\s*(\d{1,2})\s*$/.exec(str || "");
  if (!m) return null;
  const letters = m[1];
  const grade = parseInt(m[2], 10);
  const lower = letters.toLowerCase();
  const isHole = letters === letters.toUpperCase();
  if (!isHole && letters !== lower) return null; // "Js" or "jS"
  if (!LETTERS.includes(lower)) return null;
  return { letter: lower, grade, isHole, code: letters + grade };
}

/**
 * Computes the deviations for a nominal size and a class.
 * Returns { ok, upper, lower, it, isHole, grade, code, range } in µm or { ok:false, error }.
 */
export function deviations(nominal, fitStr) {
  const D = Number(nominal);
  if (!(D > 0) || D > 500) return { ok: false, error: "Nominal în afara domeniului 0–500 mm" };
  const f = parseFit(fitStr);
  if (!f) {
    if (/^\s*[tTvVyY]\d/.test(fitStr || "")) return { ok: false, error: "t, v, y nu sunt incluse; folosește abateri introduse manual" };
    return { ok: false, error: "Câmp necunoscut (ex.: H7, k6, js6, u6)" };
  }
  const letterAsWritten = f.isHole ? f.letter.toUpperCase() : f.letter;
  if (!gradesFor(letterAsWritten).includes(f.grade)) {
    return { ok: false, error: `${letterAsWritten} există doar în treptele ${gradesFor(letterAsWritten).join(", ")}` };
  }
  const r = limitDeviations(letterAsWritten, f.grade, D);
  if (!r) return { ok: false, error: `${f.code} nu e definit de ISO 286 la Ø${String(D).replace(".", ",")}` };
  const i = bracketIndex(D);
  const clean = (v) => (Object.is(v, -0) ? 0 : v);
  return { ok: true, upper: clean(r[0]), lower: clean(r[1]), it: IT[f.grade][i], isHole: f.isHole, grade: f.grade, code: f.code, range: rangeLabel(i) };
}

/** Formats a deviation from µm to mm, signed: +0,015 / -0,002 / 0 / +0,0065 */
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
