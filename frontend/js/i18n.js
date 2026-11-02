// Limba interfeței (română / engleză). Interfața e scrisă în română; în engleză textele vizibile se
// traduc din dicționar (i18n_en.js), pe măsură ce apar în pagină: noduri de text și atributele
// title / placeholder / aria-label / alt. Ce nu are traducere rămâne în română.
import { EN } from "./i18n_en.js";

const STORE = "drawcad.lang";
export const LANGS = [["ro", "Română"], ["en", "English"]];

export function getLang() {
  try {
    const v = localStorage.getItem(STORE);
    if (v === "ro" || v === "en") return v;
  } catch (_) { /* stocare indisponibilă */ }
  const nav = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
  return [...nav].some((l) => String(l || "").toLowerCase().startsWith("ro")) || !nav.length ? "ro" : "en";
}

export function setLang(l) {
  try {
    localStorage.setItem(STORE, l);
  } catch (_) { /* stocare indisponibilă */ }
}

let LANG = null;
export const lang = () => (LANG || (LANG = getLang()));

let exact = null;
let patterns = null;

function prepare() {
  exact = new Map();
  patterns = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [ro, en] of Object.entries(EN)) {
    const k = ro.replace(/\s+/g, " ").trim();
    if (!k.includes("{}")) {
      exact.set(k, en);
      continue;
    }
    const parts = k.split("{}");
    const re = new RegExp(`^${parts.map(esc).join("(.*?)")}$`, "s");
    patterns.push({ re, en, weight: parts.join("").length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
}

function lookup(text, depth = 0) {
  const k = text.replace(/\s+/g, " ").trim();
  if (!k) return null;
  if (exact.has(k)) return exact.get(k);
  if (!/[A-Za-zĂÂÎȘȚăâîșț]/.test(k)) return null;
  const whole = lookupPattern(k, depth);
  if (whole != null) return whole;
  // „· text” la începutul unui fragment
  const lead = /^([·•—–]\s+)(.+)$/.exec(k);
  if (lead && depth < 3) {
    const t = lookup(lead[2], depth + 1);
    if (t != null) return lead[1] + t;
  }
  // texte compuse din bucăți despărțite prin „ · ”: fiecare bucată separat
  if (depth < 3 && k.includes(" · ")) {
    const parts = k.split(" · ");
    let any = false;
    const out = parts.map((part) => {
      const t = part ? lookup(part, depth + 1) : null;
      if (t != null) any = true;
      return t ?? part;
    });
    if (any) return out.join(" · ");
  }
  return null;
}

function lookupPattern(k, depth) {
  for (const p of patterns) {
    const m = p.re.exec(k);
    if (!m) continue;
    let i = 1;
    return p.en.replace(/\{\}/g, () => {
      const g = m[i++] ?? "";
      // valorile pot fi și ele texte de tradus („în 4 s”, „· scan înclinat 0,6°”)
      if (depth < 2 && /[a-zăâîșț]{2}/i.test(g)) {
        const t = lookup(g, depth + 1);
        if (t != null) return g.match(/^\s*/)[0] + t + g.match(/\s*$/)[0];
      }
      return g;
    });
  }
  return null;
}

/** Traducerea unui text (în română: textul neschimbat). */
export function tr(text) {
  if (lang() === "ro" || text == null) return text;
  if (!exact) prepare();
  const s = String(text);
  const t = lookup(s);
  if (t == null) return s;
  return s.match(/^\s*/)[0] + t + s.match(/\s*$/)[0];
}

const ATTRS = ["title", "placeholder", "aria-label", "alt"];
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);

function skipEl(el) {
  return !el || SKIP.has(el.tagName) || (el.closest && el.closest('[translate="no"]'));
}

function translateText(node) {
  const p = node.parentElement;
  if (skipEl(p)) return;
  const v = node.nodeValue;
  const t = tr(v);
  if (t !== v) node.nodeValue = t;
}

function translateAttrs(el) {
  if (skipEl(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v) {
      const t = tr(v);
      if (t !== v) el.setAttribute(a, t);
    }
  }
}

function walk(root) {
  if (root.nodeType === 3) return translateText(root);
  if (root.nodeType !== 1 || skipEl(root)) return;
  translateAttrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n = it.nextNode();
  while (n) {
    if (n.nodeType === 3) translateText(n);
    else translateAttrs(n);
    n = it.nextNode();
  }
}

/** Pornește traducerea automată a paginii (doar în engleză). */
export function startI18n() {
  document.documentElement.lang = lang();
  if (lang() === "ro") return;
  if (!exact) prepare();
  document.title = tr(document.title);
  walk(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach((n) => walk(n));
      else if (m.type === "characterData") translateText(m.target);
      else if (m.type === "attributes") translateAttrs(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // titlul ferestrei se schimbă din cod (numele documentului)
  const t = document.querySelector("title");
  if (t) new MutationObserver(() => {
    const v = tr(document.title);
    if (v !== document.title) document.title = v;
  }).observe(t, { childList: true, characterData: true, subtree: true });
}
