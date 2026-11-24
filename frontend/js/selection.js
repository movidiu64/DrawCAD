// Selection rules (docs/design/commands-v2.md, CMD-D12).
//  - DrawCAD (default): a click replaces the selection, Shift+click adds or removes;
//    a window replaces it, Shift+window adds.
//  - AutoCAD (PICKADD = 2, an option in AutoCAD mode, and always at a "Select objects" prompt):
//    a click or a window adds, Shift+click or Shift+window removes; a click on nothing keeps it.

/** The selection after a click on an annotation. */
export function clickSelection(sel, id, { shift = false, pickadd = false } = {}) {
  const next = new Set(sel);
  if (pickadd) {
    if (shift) next.delete(id);
    else next.add(id);
    return next;
  }
  if (shift) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  // a click on what is already selected keeps the selection (to drag it all)
  return next.has(id) ? next : new Set([id]);
}

/** The selection after a window / crossing that caught `ids` (or a click on nothing: ids = []). */
export function windowSelection(sel, ids, { shift = false, pickadd = false, empty = false } = {}) {
  if (pickadd) {
    const next = new Set(sel);
    for (const id of ids) {
      if (shift) next.delete(id);
      else next.add(id);
    }
    return next;
  }
  if (empty) return shift ? new Set(sel) : new Set();
  const next = shift ? new Set(sel) : new Set();
  for (const id of ids) next.add(id);
  return next;
}

/** Is the point inside the polygon (even-odd rule)? */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** WP: is a box (x0, y0, x1, y1) completely inside the polygon (its corners, for a convex or a
 *  roughly convex outline)? */
export function boxInPolygon(b, poly) {
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].every((q) => pointInPolygon(q, poly));
}
