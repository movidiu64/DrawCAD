// Simboluri de desen: plan de secționare, detaliu, reper de poziție.
// Coordonate în puncte PDF vizuale (y în jos). S = setările derivate (S.h = înălțimea majusculelor).
import { fitDash, K } from "./shapes.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : null;
};

/** Litere de identificare (ISO 128-44 folosește majuscule; I, O, Q se evită ca la baze). */
export const VIEW_LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";

function arrow(tip, d, S, c, k = 1) {
  const aw = S.aw * k;
  const back = sub(tip, mul(d, aw));
  const n = [-d[1], d[0]];
  const b1 = add(back, mul(n, aw * 0.17));
  const b2 = add(back, mul(n, -aw * 0.17));
  return { t: "P", p: [...tip, ...b1, ...b2], close: true, fill: true, w: S.lw * 0.5, c };
}

function centeredText(txt, center, s, measure, c) {
  const tw = measure(txt, s);
  // linia de bază: centrul casetei majusculelor (CAP ≈ 0,74 em)
  return { t: "T", p: [center[0] - tw / 2, center[1] + s * 0.37], s, a: 0, txt, tw, c };
}

/**
 * Plan de secționare (ISO 128-44): linie-punct subțire, îngroșată la capete, săgeți în direcția
 * de privire, cu vârful pe linie, și litera lângă coada săgeții.
 */
export function buildSection(a, S, measure) {
  const c = a.layer || "add";
  const [P0, P1] = a.pts;
  const u = norm(sub(P1, P0)) || [1, 0];
  let n = [-u[1], u[0]];
  const mid = mul(add(P0, P1), 0.5);
  if (a.vp && dot(sub(a.vp, mid), n) < 0) n = mul(n, -1); // n = direcția de privire
  const L = len(sub(P1, P0));
  const thin = 0.25;
  const thick = 0.5;
  const tl = Math.min(5 * K, L / 3); // lungimea porțiunii groase
  const prims = [];
  if (L > 2 * tl) {
    const A = add(P0, mul(u, tl));
    const B = sub(P1, mul(u, tl));
    prims.push({ t: "L", p: [...A, ...B], w: thin * K, c, dp: fitDash("chain", thin, 1, L - 2 * tl, false, false) });
  }
  prims.push({ t: "L", p: [...P0, ...add(P0, mul(u, tl))], w: thick * K, c });
  prims.push({ t: "L", p: [...sub(P1, mul(u, tl)), ...P1], w: thick * K, c });
  const al = 7 * K * (a.scale || 1); // lungimea săgeții, cu tot cu vârf
  const h = S.h * 1.4;
  const F = S.F * 1.4;
  const letter = a.letter || "A";
  for (const [P, out] of [[P0, mul(u, -1)], [P1, u]]) {
    const tip = add(P, mul(out, -Math.min(tl * 0.4, 1.5 * K)));
    const tail = sub(tip, mul(n, al));
    prims.push({ t: "L", p: [...tail, ...tip], w: S.lw, c });
    prims.push(arrow(tip, n, S, c, 1.15));
    // litera: lângă coadă, spre exterior
    const tc = add(add(tail, mul(n, al * 0.25)), mul(out, h * 1.1));
    prims.push(centeredText(letter, tc, F, measure, c));
  }
  return {
    prims,
    handles: [{ k: "pts.0", p: P0 }, { k: "pts.1", p: P1 }, { k: "vp", p: add(mid, mul(n, 6 * K)) }],
  };
}

/** Detaliu (ISO 128-44): cerc subțire continuu în jurul zonei și litera lângă el. */
export function buildDetail(a, S, measure) {
  const c = a.layer || "add";
  const [C, R] = a.pts;
  const r = len(sub(R, C));
  const F = S.F * 1.4;
  const tp = a.tp || add(C, mul([Math.SQRT1_2, -Math.SQRT1_2], r + 1.4 * S.h));
  const prims = [{ t: "C", p: [...C], r, w: 0.25 * K, c }];
  prims.push(centeredText(a.letter || "B", tp, F, measure, c));
  return { prims, handles: [{ k: "pts.0", p: C }, { k: "pts.1", p: R }, { k: "tp", p: tp }] };
}

/**
 * Reper de poziție (ISO 6433): linie de indicație terminată cu punct pe piesă (sau săgeată pe
 * contur) și numărul, încercuit sau nu. Numărul e mai mare decât cotele.
 */
export function buildBalloon(a, S, measure) {
  const c = a.layer || "add";
  const F = S.F * 1.4;
  const h = S.h * 1.4;
  const txt = String(a.num ?? "1");
  const tw = measure(txt, F);
  const R = Math.max(h * 0.95, tw / 2 + h * 0.45);
  const { target: T, pos: Pc } = a;
  const prims = [];
  const d = norm(sub(T, Pc)) || [1, 0];
  const circled = a.shape !== "plain";
  const start = circled ? add(Pc, mul(d, R)) : Pc;
  prims.push({ t: "L", p: [...start, ...T], w: S.lw, c });
  if (a.end === "arrow") prims.push(arrow(T, d, S, c));
  else if (a.end !== "none") prims.push({ t: "C", p: [...T], r: S.aw * 0.2, fill: true, nostroke: true, w: S.lw, c });
  if (circled) prims.push({ t: "C", p: [...Pc], r: R, w: S.lw, c });
  else {
    // fără cerc: numărul stă deasupra unui scurt umăr orizontal
    const side = T[0] >= Pc[0] ? -1 : 1;
    const end = [Pc[0] + side * (tw + h * 0.6), Pc[1]];
    prims.push({ t: "L", p: [...Pc, ...end], w: S.lw, c });
    const cx = (Pc[0] + end[0]) / 2;
    prims.push({ t: "T", p: [cx - tw / 2, Pc[1] - h * 0.35], s: F, a: 0, txt, tw, c });
    return { prims, handles: [{ k: "target", p: T }, { k: "pos", p: Pc }] };
  }
  prims.push(centeredText(txt, Pc, F, measure, c));
  return { prims, handles: [{ k: "target", p: T }, { k: "pos", p: Pc }] };
}
