"""Extrage textele de interfață din frontend (literali JS și HTML), pentru dicționarul de traduceri.

Rulare: python tools/i18n_extract.py > /tmp/strings.json
Fiecare intrare: textul exact al unui nod de text (sau al unui atribut title/placeholder/aria-label),
cu `{}` în locul expresiilor ${…} din șabloane.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "frontend"
SKIP_FILES = {"iso286_data.js", "i18n.js", "i18n_en.js"}


def literals(src):
    """Literalii de text din JS: "…", '…' și `…` (cu ${…} înlocuite de \\x00, șabloanele imbricate separat)."""
    out = []
    i, n = 0, len(src)

    def read_template(i):
        # i: după backtick; întoarce (text_cu_marcaje, poziție_după_backtick)
        buf = []
        while i < n:
            c = src[i]
            if c == "\\":
                buf.append(src[i:i + 2])
                i += 2
                continue
            if c == "`":
                return "".join(buf), i + 1
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                j = i + 2
                depth = 1
                while j < n and depth:
                    ch = src[j]
                    if ch == "`":
                        inner, j = read_template(j + 1)
                        out.append(("t", inner))
                        continue
                    if ch in "\"'":
                        k = j + 1
                        while k < n and src[k] != ch:
                            k += 2 if src[k] == "\\" else 1
                        out.append(("s", src[j + 1:k]))
                        j = k + 1
                        continue
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                    j += 1
                buf.append("\x00")
                i = j
                continue
            buf.append(c)
            i += 1
        return "".join(buf), i

    while i < n:
        c = src[i]
        if src.startswith("//", i):
            i = src.find("\n", i)
            if i < 0:
                break
            continue
        if src.startswith("/*", i):
            i = src.find("*/", i) + 2
            continue
        if c == "`":
            t, i = read_template(i + 1)
            out.append(("t", t))
            continue
        if c in "\"'":
            k = i + 1
            while k < n and src[k] != c and src[k] != "\n":
                k += 2 if src[k] == "\\" else 1
            out.append(("s", src[i + 1:k]))
            i = k + 1
            continue
        if c == "/" and re.match(r"[=(,:!&|?{};\[]\s*$", src[max(0, i - 3):i].rstrip()[-1:] or "("):
            # literal regex: îl sărim
            k = i + 1
            while k < n and src[k] not in "/\n":
                k += 2 if src[k] == "\\" else 1
            i = k + 1
            continue
        i += 1
    return out


WORD = re.compile(r"[A-Za-zĂÂÎȘȚăâîșț]{2,}")
CODEY = re.compile(r"^[\w.#:\-/\[\]=*>+~^$|()'\" ,%]*$")


def segments(text):
    """Textele vizibile dintr-un literal: părțile dintre etichetele HTML + atributele de interfață."""
    segs = []
    for m in re.finditer(r'(?:title|placeholder|aria-label|alt)="([^"]*)"', text):
        segs.append(m.group(1))
    plain = re.sub(r"<[^>]*>", "\x01", text)
    for part in plain.split("\x01"):
        segs.append(part)
    return segs


def is_ui(s):
    t = s.replace("\x00", "").strip()
    if not WORD.search(t):
        return False
    if re.search(r"[ăâîșțĂÂÎȘȚ]", t):
        return True
    if " " in t.strip() and not re.match(r"^[a-z\-]+( [a-z\-]+)*$", t):  # clase CSS: „mini on”
        return True
    if re.match(r"^[A-ZĂÂÎȘȚ][a-zăâîșț]+[.:…]?$", t):  # un cuvânt cu majusculă: „Gata”, „Setări”
        return True
    return False


def main():
    found = {}
    for f in sorted(ROOT.glob("js/*.js")):
        if f.name in SKIP_FILES:
            continue
        for kind, lit in literals(f.read_text("utf-8")):
            for seg in segments(lit):
                if is_ui(seg):
                    key = re.sub(r"\s+", " ", seg.replace("\x00", "{}")).strip()
                    found.setdefault(key, set()).add(f.name)
    html = (ROOT / "index.html").read_text("utf-8")
    for seg in segments(html):
        if is_ui(seg):
            key = re.sub(r"\s+", " ", seg).strip()
            found.setdefault(key, set()).add("index.html")
    json.dump({k: sorted(v) for k, v in sorted(found.items())}, sys.stdout, ensure_ascii=False, indent=0)


if __name__ == "__main__":
    main()
