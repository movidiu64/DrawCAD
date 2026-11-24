// Revision number of a document: the next one, and the revision suffix of a file name.
// Pure functions (tested in Node).

// a revision suffix at the end of a name: "_rev1", "_rev.1", "-rev1", " rev 1", "_Rev_2", "-REV3"…
const SUFFIX = /(^|[ _.-]+)(rev[ _.]*)([0-9]+|[a-z]{1,2})$/i;

/** The revision after `rev`: 1 → 2, 9 → 10, A → B, Z → AA, "2a" → "2b"; empty → "1". */
export function nextRev(rev) {
  const s = String(rev ?? "").trim();
  if (!s) return "1";
  const num = s.match(/^(.*?)(\d+)$/);
  if (num) return num[1] + String(Number(num[2]) + 1);
  const let_ = s.match(/^(.*?)([a-z]+)$/i);
  if (let_) {
    const up = let_[2] === let_[2].toUpperCase();
    const chars = let_[2].toLowerCase().split("");
    let i = chars.length - 1;
    while (i >= 0) {
      if (chars[i] !== "z") {
        chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
        break;
      }
      chars[i] = "a";
      i--;
    }
    if (i < 0) chars.unshift("a");
    const out = chars.join("");
    return let_[1] + (up ? out.toUpperCase() : out);
  }
  return `${s}1`;
}

/** The revision written in a file name (without extension), or null. */
export function revOfName(base) {
  const m = String(base || "").match(SUFFIX);
  return m ? m[3] : null;
}

/** File name (without extension) for revision `rev`: an existing suffix keeps its style and gets the
 * new number ("piesa-Rev 3" → "piesa-Rev 4"); a name without one gets "_rev{rev}". */
export function revName(base, rev) {
  const b = String(base || "").trim() || "export";
  const r = String(rev ?? "").trim() || "1";
  if (SUFFIX.test(b)) return b.replace(SUFFIX, (_m, sep, pre) => `${sep}${pre}${r}`);
  return `${b}_rev${r}`;
}
