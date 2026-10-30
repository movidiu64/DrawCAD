"""Curățarea PDF-urilor încărcate de conținutul activ.

Un desen tehnic nu are nevoie de JavaScript, de acțiuni care pornesc programe sau trimit date,
de fișiere atașate ori de formulare XFA. Toate acestea se elimină din original înainte să fie
salvat pe server, așa că nici exporturile nu le mai conțin. Geometria, textul și fluxurile de
conținut ale paginilor nu se ating, deci id-urile obiectelor rămân aceleași.
"""
from __future__ import annotations

import io

import pikepdf
from pikepdf import Name

# acțiuni care pot rula cod, porni programe, deschide alte fișiere sau trimite date
DANGEROUS_ACTIONS = {
    "/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/GoToR", "/GoToE", "/Rendition",
    "/Sound", "/Movie", "/RichMediaExecute",
}
# adnotări cu conținut multimedia sau fișiere încorporate
DANGEROUS_ANNOTS = {"/FileAttachment", "/RichMedia", "/Screen", "/Movie", "/Sound", "/3D"}


def _is_dict(o):
    return isinstance(o, pikepdf.Dictionary)


class _Report(dict):
    def add(self, key, n=1):
        self[key] = self.get(key, 0) + n


def _clean_action(act, rep: _Report, depth=0):
    """Întoarce acțiunea curățată sau None dacă trebuie eliminată (urmează și lanțul /Next)."""
    if depth > 20 or not _is_dict(act):
        return act
    s = str(act.get("/S", ""))
    if s in DANGEROUS_ACTIONS:
        rep.add("javascript" if s == "/JavaScript" else "actiuni")
        return None
    nxt = act.get("/Next")
    if nxt is not None:
        if isinstance(nxt, pikepdf.Array):
            keep = [a for a in (_clean_action(x, rep, depth + 1) for x in nxt) if a is not None]
            if keep:
                act.Next = pikepdf.Array(keep)
            else:
                del act["/Next"]
        else:
            c = _clean_action(nxt, rep, depth + 1)
            if c is None:
                del act["/Next"]
    return act


def _strip_aa(obj, rep: _Report):
    if _is_dict(obj) and "/AA" in obj:
        del obj["/AA"]
        rep.add("actiuni")


def _clean_a(obj, rep: _Report):
    if _is_dict(obj) and "/A" in obj:
        if _clean_action(obj.A, rep) is None:
            del obj["/A"]


def sanitize_pdf(pdf_bytes: bytes) -> tuple[bytes, dict]:
    """Elimină conținutul activ. Întoarce (pdf, raport); dacă nu e nimic de eliminat, PDF-ul rămâne
    identic octet cu octet."""
    rep = _Report()
    with pikepdf.open(io.BytesIO(pdf_bytes)) as pk:
        root = pk.Root
        # acțiunea de la deschidere: rămâne doar dacă e un simplu salt la o pagină
        if "/OpenAction" in root:
            oa = root.OpenAction
            if _is_dict(oa) and _clean_action(oa, rep) is None:
                del root["/OpenAction"]
        _strip_aa(root, rep)
        names = root.get("/Names")
        if _is_dict(names):
            if "/JavaScript" in names:
                del names["/JavaScript"]
                rep.add("javascript")
            if "/EmbeddedFiles" in names:
                del names["/EmbeddedFiles"]
                rep.add("atasamente")
        if "/AcroForm" in root and _is_dict(root.AcroForm):
            af = root.AcroForm
            if "/XFA" in af:
                del af["/XFA"]
                rep.add("xfa")
            stack = list(af.get("/Fields", []))
            seen = set()
            while stack:
                f = stack.pop()
                if not _is_dict(f):
                    continue
                try:
                    key = f.objgen
                except Exception:  # noqa: BLE001
                    key = None
                if key in seen and key != (0, 0):
                    continue
                seen.add(key)
                _strip_aa(f, rep)
                _clean_a(f, rep)
                stack.extend(list(f.get("/Kids", [])))
        # semnele de carte (outline) pot purta acțiuni
        outl = root.get("/Outlines")
        stack = [outl.get("/First")] if _is_dict(outl) else []
        guard = 0
        while stack and guard < 100000:
            guard += 1
            it = stack.pop()
            if not _is_dict(it):
                continue
            _clean_a(it, rep)
            if "/First" in it:
                stack.append(it.First)
            if "/Next" in it:
                stack.append(it.Next)
        for page in pk.pages:
            po = page.obj
            _strip_aa(po, rep)
            annots = po.get("/Annots")
            if isinstance(annots, pikepdf.Array):
                keep = []
                for an in annots:
                    if not _is_dict(an):
                        continue
                    if str(an.get("/Subtype", "")) in DANGEROUS_ANNOTS:
                        rep.add("adnotari")
                        continue
                    _strip_aa(an, rep)
                    _clean_a(an, rep)
                    keep.append(an)
                if len(keep) != len(annots):
                    po.Annots = pikepdf.Array(keep)
        if not rep:
            return pdf_bytes, {}
        out = io.BytesIO()
        pk.save(out)
        return out.getvalue(), dict(rep)


def describe(rep: dict) -> str:
    names = {
        "javascript": "JavaScript",
        "actiuni": "acțiuni automate",
        "atasamente": "fișiere atașate",
        "adnotari": "adnotări multimedia / cu fișiere",
        "xfa": "formular XFA",
    }
    return ", ".join(f"{names.get(k, k)} ({v})" for k, v in rep.items())


__all__ = ["sanitize_pdf", "describe", "Name"]
