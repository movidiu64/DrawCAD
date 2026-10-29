# Cotare — editor PDF pentru desene tehnice

Aplicație web self-hosted (Docker) pentru a adăuga pe un PDF sau pe un scan:

- **cote** liniare, aliniate, de diametru, de rază și unghiulare, plus teșituri, linii de indicație și text liber;
- **toleranțe**: ±, abateri, câmpuri ISO 286 cu calcul automat (ex. `Ø25k6 (+0,015/+0,002)`);
- **GD&T** după ISO 1101: cele 14 caracteristici, Ø, modificatori Ⓜ Ⓛ Ⓟ Ⓕ CZ, baze A/B/C, plus simboluri de bază;
- **revizii**: cotă tăiată + valoare nouă + triunghi de revizie;
- **ștergere** din original, cu acoperire albă sau eliminare reală a obiectelor PDF;
- **export PDF** vectorial, cu font ISO 3098 încorporat și strat editabil atașat.

Originalul nu se modifică. Adnotările se păstrează separat și se aplică abia la export.

## Instalare

Imaginea `ghcr.io/gg64nou/drawcad:latest` e construită de GitHub Actions la fiecare push pe `main`, după ce trec testele și testul în browser pe container. Pentru instalare e suficient `compose.yaml`.

### Cu Dockhand (stack din Git) — recomandat

Dockhand clonează repo-ul și construiește imaginea direct pe server. Nu e nevoie de registry și nici de token pentru `ghcr.io`.

1. **Acces la repo.** Pe GitHub creează un token fine-grained, doar pentru `DrawCAD`, cu **Contents: Read-only**. În Dockhand adaugă-l la credențialele Git: utilizator `gg64nou`, parola = tokenul.
2. **Stack nou din Git:**
   - repository: `https://github.com/gg64nou/DrawCAD.git`
   - ramura: `main`
   - fișierul compose: **`compose.build.yaml`**
3. **Variabile ale stack-ului** (opțional; lista completă e în `.env.example`):
   - `COTARE_PORT=8478`
   - `COTARE_DATA_DIR=/mnt/user/appdata/cotare` — cale absolută pe server, nu relativă
   - `PUID=99`, `PGID=100`
4. **Deploy.** Primul build durează 1–2 minute. Aplicația pornește pe `http://<ip>:8478`.

La fiecare redeploy după un git sync imaginea se reconstruiește (`pull_policy: build`). Pentru sincronizare automată la push, setează în Dockhand webhook-ul stack-ului și adaugă-l în GitHub la **Settings → Webhooks** al repo-ului.

### Cu Dockhand și imaginea gata construită din GHCR

Fișierul compose este `compose.yaml`. Imaginea e privată, deci daemonul Docker trebuie să primească credențiale la pull. Tokenul trebuie să fie classic, cu `read:packages`, pentru că GitHub Packages nu acceptă tokenuri fine-grained.

Dacă pull-ul dă `unauthorized` chiar cu registry-ul `ghcr.io` adăugat în Dockhand, înseamnă că acesta nu trimite credențialele la deploy-ul stack-ului. Atunci folosește varianta cu build de mai sus.

Pachetul poate fi făcut și public, dar imaginea conține tot codul aplicației.

### Cu Dockhand (stack lipit manual)

Creează un stack nou și lipește conținutul din `compose.yaml`. Pașii 2 și 4 de mai sus rămân valabili.

### Cu docker compose din linia de comandă

```bash
cp .env.example .env          # opțional: ajustează portul și folderul de date
docker compose up -d          # cu imaginea din GHCR
# sau, fără GHCR, construind local din sursă:
docker compose -f compose.build.yaml up -d --build
```

### Folderul de date și permisiuni

Containerul pornește ca root doar cât să creeze folderul de date și să-i dea proprietarul `PUID:PGID`, implicit `99:100` (nobody:users pe Unraid). Apoi rulează aplicația ca acel utilizator. Nu mai e nevoie de `chown` manual. Dacă folosești `user:` în compose, folderul trebuie să fie deja scriibil de acel utilizator.

Aplicația nu are autentificare, așa că trebuie ținută în rețeaua locală (sau în spatele unui reverse proxy cu login).

### Variabile de mediu

| Variabilă | Implicit | Rol |
|---|---|---|
| `COTARE_TAG` | `latest` | tag-ul imaginii; un SHA de commit fixează versiunea |
| `COTARE_PORT` | `8478` | portul de pe server |
| `COTARE_DATA_DIR` | `/mnt/user/appdata/cotare` | folderul de date de pe server |
| `PUID` / `PGID` | `99` / `100` | utilizatorul cu care rulează aplicația |
| `COTARE_MAX_UPLOAD_MB` | `200` | dimensiunea maximă a unui fișier încărcat |
| `COTARE_MAX_RENDER_PX` | `12000` | latura maximă, în pixeli, a randării unei pagini |

## Utilizare

**Flux de lucru:**
1. Deschide un PDF sau o imagine (trage fișierul pe pagină).
2. Alege o unealtă și dă click pe desen.
3. Editează valoarea și toleranța în panoul din dreapta.
4. Apasă **Exportă PDF**.

**Snap:** cursorul se prinde de geometria vectorială a PDF-ului:
- capete de linii (□)
- mijloace (△)
- centre de cercuri (○)
- puncte pe linie (×)

Ține **Alt** apăsat ca să dezactivezi snap-ul. **Shift** activează modul ortho.

**Scanuri:** după deschidere folosește **Calibrare (K)**. Dai click pe capetele unei cote cunoscute și introduci valoarea reală.

| Tastă | Unealtă | Tastă | Unealtă |
|---|---|---|---|
| V | selecție | G | cadru GD&T |
| H | mută | B | bază de referință |
| D | cotă liniară | S | taie cota (revizie) |
| A | cotă aliniată | W | acoperire albă |
| O | diametru | X | șterge din original |
| R | rază | K | calibrare scară |
| C | teșitură | T | text |
| L | linie de indicație | F | potrivește pagina |
| U | cotă unghiulară | | |

**Taste generale:**
- Ctrl+Z / Ctrl+Y: anulează / refă
- Delete: șterge adnotarea selectată
- Esc: renunță la operația curentă
- rotița mouse-ului: zoom
- Space + tragere, sau butonul din mijloc: mută foaia

**Editare:** la o adnotare selectată, pătrățelele mută punctele, iar cercul alb mută textul cotei de-a lungul liniei. Tragerea de corp mută toată adnotarea.

**Textul cotelor:** dacă eticheta nu încape între săgeți, se mută automat lângă săgeată, iar linia de cotă se prelungește până sub text. Dacă muți textul manual, butonul „Text automat” readuce poziționarea automată.

**Cota unghiulară (U):** dai click pe vârf, pe un punct de pe fiecare latură, apoi pe poziția arcului. Poziția arcului alege unul din cele patru sectoare: unghiul, suplementul sau opusul lor.

**Ștergere din original:** după ce tragi zona, dialogul arată obiectele găsite și o previzualizare înainte/după. Ai trei moduri:
- **Selecție pe obiecte:** bifezi exact ce se elimină. E modul recomandat.
- **Doar textul:** elimină valorile, iar liniile de cotă rămân.
- **Tot din zonă:** elimină ce e complet în zonă și acoperă cu alb ce trece doar parțial.

**Redeschidere:** un PDF exportat cu „strat editabil” se poate redeschide. Cotele revin editabile, iar originalul este recuperat din fișier, deci nimic nu se desenează de două ori.

## Arhitectură

```
frontend/   HTML + module ES, fără build (canvas 2D, font osifont)
  js/iso286.js   tabele IT și abateri fundamentale + calcul
  js/annots.js   modelul adnotărilor → primitive de desen (linii, poligoane, text)
  js/gdt.js      simbolurile ISO 1101
  js/view.js     afișare, zoom, snap
  js/main.js     unelte, istoric, salvare automată, export
backend/    Starlette
  app/pdfcore.py randare (PDFium), geometrie pentru snap, obiecte din zonă,
                 eliminare obiecte, overlay vectorial (reportlab + pikepdf), atașamente
  app/main.py    API + servire frontend
```

Frontend-ul calculează o singură dată geometria fiecărei cote și o trimite la export ca primitive. Ce vezi pe ecran e ce iese în PDF, cu același font și aceleași lățimi de text.

**Față de planul inițial:** PDF.js + PyMuPDF au fost înlocuite cu PDFium (`pypdfium2`) pe server, din două motive:
- PDFium dă acces la obiectele paginii, deci permite ștergerea pe obiecte și extragerea geometriei pentru snap;
- licențele bibliotecilor sunt permisive, în timp ce PyMuPDF e AGPL.

**Licențe:**

| Componentă | Licență |
|---|---|
| pypdfium2 / PDFium | Apache-2.0 / BSD |
| pikepdf | MPL-2.0 |
| reportlab | BSD |
| img2pdf | LGPL-3.0 |
| Starlette, uvicorn | BSD |
| osifont | LGPL-3 cu excepție pentru fonturi |

## Teste

```bash
cd backend && python -m unittest discover -s tests      # API: deschidere, snap, ștergere, export, redeschidere
cd frontend && npm test                                 # ISO 286 (31 de cazuri din tabele), geometria cotelor
python tools/e2e_smoke.py http://127.0.0.1:8080 out     # browser: flux complet cu Playwright
```

`tools/make_sample.py` generează un PDF de test asemănător unui export CAD. Conține un arbore cu trepte, un cartuș într-un Form XObject, cercuri și o pagină rotită.

## Limitări cunoscute

- **ISO 286** acoperă literele d–s și D–S, treptele IT1–IT16 și nominalele până la 500 mm. Literele a/b/c, j, t–zc nu sunt incluse.
- **Ștergerea pe obiecte** elimină obiecte PDF întregi. Dacă un contur e un singur obiect care trece prin zonă, nu poate fi tăiat parțial: modul „Tot din zonă” îl acoperă cu alb.
- **Textul exportat de AutoCAD cu fonturi SHX** apare în PDF ca linii, nu ca text. În dialogul de ștergere se vede ca „Linie / contur”.
- **Adnotările se pot așeza doar orizontal sau vertical** (plus cotele aliniate). Nu există încă text rotit la unghi oarecare.
- **Fără autentificare și fără editare simultană** a aceluiași document de către mai mulți utilizatori.
