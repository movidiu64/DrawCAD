"""Project rules checked in CI (the `test` job). Fails with a list of violations.

1. Colors: a hex color in app.css only inside `:root` (the tokens); in the JS only inside the
   `COLORS` object of view.js.
2. i18n: every interface text that tools/i18n_extract.py finds has a key in i18n_en.js
   (exact, or a `{}` pattern, or composed of translated pieces, as i18n.js looks it up).
   Duplicate keys in i18n_en.js are errors too.
3. Overlays: modals, dialogs, toasts and other overlays are created only in dialogs.js
   (showModal / closeModal / toast). In app.css only `.modal` and `.toast` are position: fixed.
4. Agent skills: every .claude/skills/<name>/SKILL.md has front matter with `name: <name>` and a
   description that says "Use when…"; CLAUDE.md lists every skill.
5. Deploy: unraid/drawcad.xml and compose.yaml only set variables the backend reads; the Unraid
   template maps port 8080 and /data.

Anything that must break a rule goes in EXCEPTIONS below, with the reason on the same line.

Run: python tools/check_rules.py   (from the repo root; exit code 1 on violations)
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONT = ROOT / "frontend"
sys.path.insert(0, str(ROOT / "tools"))
import i18n_extract  # noqa: E402

HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")

# (rule, file, text that the violation contains) → allowed, with the reason
EXCEPTIONS = [
    # colors
    ("color", "js/annots.js", '"#ffffff"', "default cover color stored in annotations; annots.js stays free of view.js (pure, tested in Node)"),
    # i18n: drawing content, not interface (follows the document's drawing language, Settings → dlang)
    ("i18n", "js/annots.js", "Date", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/annots.js", "Description", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/annots.js", "Item", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/annots.js", "Name", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/annots.js", "Qty", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/annots.js", "Remarks", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/annots.js", "Hole", "English table header for drawings in English (dlang = en)"),
    ("i18n", "js/main.js", "Modified dimensions", "revision table text for drawings in English (dlang = en)"),
    ("i18n", "js/tools.js", "Break all sharp edges", "default note for drawings in English (dlang = en)"),
    ("i18n", "js/tools.js", "Muchiile nespecificate se teșesc", "default note for drawings in Romanian (dlang = ro): drawing text, not interface"),
    # i18n: shown in both languages on purpose (translate="no")
    ("i18n", "index.html", "Limba / Language", "language switcher label, bilingual on purpose"),
    ("i18n", "*", "English", "language name, shown as itself (translate=\"no\")"),
    ("i18n", "*", "Română", "language name, shown as itself (translate=\"no\")"),
    ("i18n", "js/dialogs.js", "DrawCAD {}", "product name + version (translate=\"no\")"),
    # i18n: not interface text
    ("i18n", "*", "Escape", "KeyboardEvent.key value"),
    ("i18n", "js/main.js", "Arrow", "KeyboardEvent.key prefix (ArrowUp…)"),
    ("i18n", "js/main.js", "Backspace", "KeyboardEvent.key value"),
    ("i18n", "js/main.js", "Delete", "KeyboardEvent.key value"),
    ("i18n", "js/main.js", "Tab", "KeyboardEvent.key value"),
    ("i18n", "js/view.js", "no ImageBitmap", "internal error message, caught right away, never shown"),
    # overlays
    ("overlay", "js/main.js", 'createElement("div")', "radial marking menu: absolute inside the viewport, follows the cursor, closes on release; not a modal"),
    ("overlay", "css/app.css", ".snapmenu", "snap-mode popover pinned above the status bar on phones; not a modal"),
]


USED = set()


def excepted(rule, file, text):
    for i, (r, f, needle, _why) in enumerate(EXCEPTIONS):
        if r == rule and (f == "*" or f == file) and needle in text:
            USED.add(i)
            return True
    return False


def line_of(src, pos):
    return src.count("\n", 0, pos) + 1


# ---------------------------------------------------------------- 1. colors
def check_colors():
    out = []
    css_path = "css/app.css"
    css = (FRONT / css_path).read_text("utf-8")
    m = re.search(r":root\s*\{[^}]*\}", css)
    root = (m.start(), m.end()) if m else (0, 0)
    for h in HEX.finditer(css):
        if root[0] <= h.start() < root[1]:
            continue
        ln = line_of(css, h.start())
        text = css.splitlines()[ln - 1].strip()
        if not excepted("color", css_path, text):
            out.append(f"{css_path}:{ln}: color {h.group(0)} outside :root — add a token in :root and use var(--…): {text[:100]}")
    for f in sorted((FRONT / "js").glob("*.js")):
        rel = f"js/{f.name}"
        if f.name in ("i18n_en.js", "iso286_data.js"):
            continue
        src = f.read_text("utf-8")
        allowed = (0, 0)
        if f.name == "view.js":
            m = re.search(r"export const COLORS = \{[^}]*\};", src)
            allowed = (m.start(), m.end()) if m else (0, 0)
        for h in HEX.finditer(src):
            if allowed[0] <= h.start() < allowed[1]:
                continue
            # inside a regex literal / character class: not a color ("/^#[0-9a-f]{6}$/")
            before = src[max(0, h.start() - 2):h.start()]
            if "^" in before or "[" in before:
                continue
            ln = line_of(src, h.start())
            text = src.splitlines()[ln - 1].strip()
            if not excepted("color", rel, text):
                out.append(f"{rel}:{ln}: color {h.group(0)} outside view.js COLORS — add it to COLORS (canvas) or use a CSS token: {text[:100]}")
    return out


# ---------------------------------------------------------------- 2. i18n
def en_keys():
    src = (FRONT / "js/i18n_en.js").read_text("utf-8")
    keys = [json.loads(f'"{k}"') for k in re.findall(r'^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"', src, re.M)]
    return keys


def make_lookup(keys):
    norm = lambda s: re.sub(r"\s+", " ", s).strip()  # noqa: E731
    exact, pats = set(), []
    for k in keys:
        k = norm(k)
        if "{}" in k:
            pats.append(re.compile("^" + "(.*?)".join(map(re.escape, k.split("{}"))) + "$", re.S))
        else:
            exact.add(k)

    def look(t, depth=0):
        # the same order as lookup() in i18n.js
        t = norm(t)
        if not t or t in exact or not re.search(r"[A-Za-zĂÂÎȘȚăâîșț]", t):
            return True
        if any(p.match(t) for p in pats):
            return True
        m = re.match(r"^([·•—–]\s+)(.+)$", t)
        if m and depth < 3 and look(m.group(2), depth + 1):
            return True
        if depth < 3 and " · " in t:
            parts = t.split(" · ")
            if all(not re.search(r"[A-Za-zăâîșț]{2}", p) or look(p, depth + 1) for p in parts):
                return True
        return False

    return look


def check_i18n():
    out = []
    keys = en_keys()
    for k, n in Counter(keys).items():
        if n > 1:
            out.append(f"js/i18n_en.js: duplicate key {k!r} ({n}×)")
    look = make_lookup(keys)
    found = {}
    for f in sorted((FRONT / "js").glob("*.js")):
        if f.name in i18n_extract.SKIP_FILES:
            continue
        for _kind, lit in i18n_extract.literals(f.read_text("utf-8")):
            for seg in i18n_extract.segments(lit):
                if i18n_extract.is_ui(seg):
                    key = re.sub(r"\s+", " ", seg.replace("\x00", "{}")).strip()
                    found.setdefault(key, set()).add(f"js/{f.name}")
    for seg in i18n_extract.segments((FRONT / "index.html").read_text("utf-8")):
        if i18n_extract.is_ui(seg):
            found.setdefault(re.sub(r"\s+", " ", seg).strip(), set()).add("index.html")
    for text, files in sorted(found.items()):
        if look(text):
            continue
        files = [f for f in sorted(files) if not excepted("i18n", f, text)]
        if files:
            out.append(f"{', '.join(files)}: no English key in i18n_en.js for {text[:120]!r}")
    return out


# ---------------------------------------------------------------- 3. overlays
OVERLAY_JS = re.compile(
    r'createElement\("(?:div|dialog|section|aside)"\)'
    r'|getElementById\("(?:modal|dialog|toast)"\)|\$\("(?:modal|dialog|toast)"\)'
    r'|class(?:Name)?\s*=\s*\\?"(?:modal|dialog|toast|overlay|backdrop)\b'
    r'|classList\.add\("(?:modal|overlay|backdrop)"'
    r'|\.showModal\(|<dialog\b|position:\s*fixed'
)


def check_overlays():
    out = []
    for f in sorted((FRONT / "js").glob("*.js")):
        if f.name == "dialogs.js":
            continue
        rel = f"js/{f.name}"
        src = f.read_text("utf-8")
        for m in OVERLAY_JS.finditer(src):
            ln = line_of(src, m.start())
            text = src.splitlines()[ln - 1].strip()
            if not excepted("overlay", rel, text):
                out.append(f"{rel}:{ln}: overlay/modal outside dialogs.js — use showModal / closeModal / toast: {text[:100]}")
    css = (FRONT / "css/app.css").read_text("utf-8")
    for m in re.finditer(r"([^{}]+)\{[^}]*position:\s*fixed", css):
        sel = m.group(1).strip().splitlines()[-1].strip()
        if re.fullmatch(r"\.(modal|toast)", sel) or excepted("overlay", "css/app.css", sel):
            continue
        out.append(f"css/app.css:{line_of(css, m.start(1))}: position: fixed on {sel!r} — only .modal and .toast are fixed overlays")
    return out


# ---------------------------------------------------------------- 4. agent skills
def check_skills():
    out = []
    skills = sorted((ROOT / ".claude" / "skills").glob("*/SKILL.md"))
    claude_md = (ROOT / "CLAUDE.md").read_text("utf-8") if (ROOT / "CLAUDE.md").exists() else ""
    if not claude_md:
        out.append("CLAUDE.md missing")
    for f in skills:
        name = f.parent.name
        rel = f.relative_to(ROOT).as_posix()
        text = f.read_text("utf-8")
        m = re.match(r"---\n(.*?)\n---\n", text, re.S)
        if not m:
            out.append(f"{rel}: no front matter (--- name / description ---)")
            continue
        meta = dict(re.findall(r"^(\w+):\s*(.+)$", m.group(1), re.M))
        if meta.get("name") != name:
            out.append(f"{rel}: name {meta.get('name')!r} differs from the folder {name!r}")
        if "Use when" not in meta.get("description", ""):
            out.append(f"{rel}: the description must say when to use the skill (\"Use when…\")")
        if f"`{name}`" not in claude_md:
            out.append(f"CLAUDE.md: skill {name!r} is not listed")
    return out


def check_deploy():
    """The Unraid template and compose.yaml must only use variables the backend reads."""
    import xml.etree.ElementTree as ET

    out = []
    read = set()
    for f in (ROOT / "backend" / "app").glob("*.py"):
        read |= {"DRAWCAD_" + m for m in re.findall(r'_env\("([A-Z_]+)"', f.read_text("utf-8"))}
    read |= {"PUID", "PGID"}  # used by docker/entrypoint.sh
    tpl = ROOT / "unraid" / "drawcad.xml"
    try:
        root = ET.parse(tpl).getroot()
    except (OSError, ET.ParseError) as e:
        return [f"unraid/drawcad.xml: {e}"]
    targets = {}
    for c in root.iter("Config"):
        targets.setdefault(c.get("Type"), []).append(c.get("Target"))
    for v in targets.get("Variable", []):
        if v not in read:
            out.append(f"unraid/drawcad.xml: variable {v} is not read by the backend")
    if targets.get("Port") != ["8080"]:
        out.append("unraid/drawcad.xml: the container port must be 8080")
    if "/data" not in targets.get("Path", []):
        out.append("unraid/drawcad.xml: /data must be mapped")
    compose = (ROOT / "compose.yaml").read_text("utf-8")
    env = re.search(r"\n    environment:\n((?:      .*\n)+)", compose)
    for v in re.findall(r"^      ([A-Z_]+):", env.group(1) if env else "", re.M):
        if v not in read:
            out.append(f"compose.yaml: variable {v} is not read by the backend")
    return out


def main():
    checks = [
        ("colors", check_colors),
        ("i18n", check_i18n),
        ("overlays", check_overlays),
        ("skills", check_skills),
        ("deploy", check_deploy),
    ]
    bad = 0
    for name, fn in checks:
        errs = fn()
        bad += len(errs)
        print(f"{name}: {'OK' if not errs else f'{len(errs)} violation(s)'}")
        for e in errs:
            print(f"  {e}")
    stale = [e for i, e in enumerate(EXCEPTIONS) if i not in USED]
    if stale:
        bad += len(stale)
        print(f"exceptions: {len(stale)} no longer needed — remove them from EXCEPTIONS")
        for r, f, needle, _why in stale:
            print(f"  {r} · {f} · {needle!r}")
    if bad:
        print(f"\n{bad} violation(s). Fix them, or add an entry with its reason to EXCEPTIONS in tools/check_rules.py.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
