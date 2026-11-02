# DrawCAD — editor PDF pentru desene tehnice

Aplicație web self-hosted (Docker) pentru a adăuga pe un PDF sau pe un scan:

- **cote** liniare, aliniate, de diametru, de rază și unghiulare, plus teșituri, linii de indicație și text liber;
- **toleranțe**: ±, abateri, câmpuri ISO 286 cu calcul automat (ex. `Ø25k6 (+0,015/+0,002)`);
- **GD&T** după ISO 1101: cele 14 caracteristici, Ø, modificatori Ⓜ Ⓛ Ⓟ Ⓕ CZ, baze A/B/C, plus simboluri de bază;
- **rugozitate** după ISO 1302 / ISO 21920-1: cu sau fără îndepărtare de material, parametru (Ra, Rz…), procedeu, direct pe suprafață sau cu linie de indicație;
- **revizii**: cotă tăiată + valoare nouă + triunghi de revizie, plus **tabel de revizii** (Rev. / Modificare / Data / Nume) completat din cotele tăiate;
- **note tehnice** pe mai multe rânduri, numerotate automat, cu titlu și chenar opțional;
- **listă de componente** (ISO 7573) completată din reperele de poziție;
- **vederi**: plan de secționare A–A (ISO 128-44), cerc de detaliu, etichete de vedere și repere de poziție (ISO 6433);
- **desen**: linie, polilinie, dreptunghi, cerc, arc, axe de cerc, hașură și linie de ruptură, cu tipurile de linie ISO 128 (continuă, întreruptă, linie-punct, linie-două puncte, punctată) și grosimile standard;
- **ștergere** din original, cu acoperire albă sau eliminare reală a obiectelor PDF;
- **înnegrirea originalului pentru tipărire**: desenele colorate (verde deschis, galben) ies negre, pe tot desenul sau doar pentru liniile alese; scanurile devin alb-negru;
- **export PDF** vectorial, cu font ISO 3098 încorporat și strat editabil atașat;
- **căutare și OCR**: caută orice text din desen (Ctrl+F); pe desenele scanate textul se recunoaște cu Tesseract și se poate pune invizibil în PDF (PDF căutabil);
- **export DXF** pentru AutoCAD / Allplan: geometria PDF-ului ca linii, arce, cercuri și texte reale, cotele DrawCAD pe stratul lor, la scara hârtiei sau la mărimea reală; scanurile se vectorizează (experimental), cu textul recunoscut ca text.

Originalul nu se modifică. Adnotările se păstrează separat și se aplică abia la export.

## Instalare

Imaginea `ghcr.io/movidiu64/drawcad:latest` e construită de GitHub Actions la fiecare push pe `main`, după ce trec testele și testul în browser pe container. Pentru instalare e suficient `compose.yaml`.

### Cu Dockhand (stack din Git) — recomandat

Dockhand clonează repo-ul și construiește imaginea direct pe server. Nu e nevoie de registry și nici de token pentru `ghcr.io`.

1. **Acces la repo.** Pe GitHub creează un token fine-grained, doar pentru `DrawCAD`, cu **Contents: Read-only**. În Dockhand adaugă-l la credențialele Git: utilizator `movidiu64`, parola = tokenul.
2. **Stack nou din Git:**
   - repository: `https://github.com/movidiu64/DrawCAD.git`
   - ramura: `main`
   - fișierul compose: **`compose.build.yaml`**
3. **Variabile ale stack-ului** (opțional; lista completă e în `.env.example`):
   - `DRAWCAD_PORT=8478`
   - `DRAWCAD_DATA_DIR=/mnt/user/appdata/drawcad` — cale absolută pe server, nu relativă
   - `PUID=99`, `PGID=100`
4. **Deploy.** Primul build durează 1–2 minute. Aplicația pornește pe `http://<ip>:8478`.

**Trecerea de la numele vechi (Cotare):** containerul se numește acum `drawcad`. Înainte de primul redeploy oprește și șterge containerul vechi `cotare`, altfel portul 8478 rămâne ocupat. Datele implicite stau acum în `/mnt/user/appdata/drawcad`. Documentele de lucru din `/mnt/user/appdata/cotare` se pot muta acolo sau se poate păstra calea veche cu `DRAWCAD_DATA_DIR`. Variabilele `COTARE_*` merg în continuare.

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

### Aplicația desktop pentru Windows

Aceeași aplicație, fără server și fără Docker. Rulează pe calculator, într-o fereastră proprie, și merge și fără internet.

**Instalare:**
1. Descarcă din **Releases** fișierul `DrawCAD-<versiune>-setup.exe` și rulează-l. Nu cere drepturi de administrator. Se instalează pentru utilizatorul curent, în `%LOCALAPPDATA%\Programs\DrawCAD`.
2. Opțional, installerul pune o iconiță pe desktop și adaugă „Deschide cu → DrawCAD” la PDF-uri și imagini, fără să devină aplicația implicită.
3. Varianta `…-portabil.zip` nu se instalează: dezarhivezi și pornești `DrawCAD.exe`.

**Ce conține:** totul, inclusiv OCR-ul (Tesseract, română și engleză).

**Unde stau documentele de lucru:** în `%LOCALAPPDATA%\DrawCAD`. Ele rămân până le ștergi din Recente, fără curățare automată.

**Exportul:** deschide dialogul „Salvează ca” al Windows.

**Fereastra** folosește Microsoft Edge WebView2, care vine cu Windows 11 și cu Edge pe Windows 10. Dacă lipsește, DrawCAD se deschide în browserul implicit.

**Serverul intern** ascultă doar pe `127.0.0.1` și răspunde doar la numele `127.0.0.1` și `localhost`. Alte calculatoare nu ajung la el, iar un site străin nu-l poate accesa prin DNS rebinding.

**Construire:** GitHub Actions (`.github/workflows/desktop.yml`) face automat, la fiecare push pe `main`:
- executabilul, cu PyInstaller;
- un autotest pe executabil: citire, randare, OCR, export PDF și DXF, vectorizarea unui scan;
- testul complet în browser pe serverul din executabil;
- installerul, cu Inno Setup.

Rezultatul se descarcă din pagina rulării (Artifacts). Un tag `v1.2.3` publică installerul în Releases.

**Actualizare:** rulezi installerul versiunii noi peste cea veche. Documentele și setările rămân.

### Folderul de date și permisiuni

Containerul pornește ca root doar cât să creeze folderul de date și să-i dea proprietarul `PUID:PGID`, implicit `99:100` (nobody:users pe Unraid). Apoi rulează aplicația ca acel utilizator. Nu mai e nevoie de `chown` manual. Dacă folosești `user:` în compose, folderul trebuie să fie deja scriibil de acel utilizator.

Aplicația nu are autentificare, așa că trebuie ținută în rețeaua locală (sau în spatele unui reverse proxy cu login).

### Variabile de mediu

Aplicația s-a numit inițial „Cotare”: variabilele vechi `COTARE_*` sunt acceptate în continuare, iar PDF-urile exportate de versiunile vechi se redeschid editabile.

| Variabilă | Implicit | Rol |
|---|---|---|
| `DRAWCAD_TAG` | `latest` | tag-ul imaginii; un SHA de commit fixează versiunea |
| `DRAWCAD_PORT` | `8478` | portul de pe server |
| `DRAWCAD_DATA_DIR` | `/mnt/user/appdata/drawcad` | folderul de date de pe server |
| `PUID` / `PGID` | `99` / `100` | utilizatorul cu care rulează aplicația |
| `DRAWCAD_MAX_UPLOAD_MB` | `200` | dimensiunea maximă a unui fișier încărcat |
| `DRAWCAD_MAX_RENDER_PX` | `12000` | latura maximă, în pixeli, a randării unei pagini |
| `DRAWCAD_MODE` | `private` | `personal`, `private` sau `session` (vezi „Mod de lucru”) |
| `DRAWCAD_MAX_PAGES` | `300` | numărul maxim de pagini al unui document |
| `DRAWCAD_MAX_IMAGE_MPX` | `400` | megapixelii maximi ai unei imagini încărcate |
| `DRAWCAD_PASSWORD` | gol | parolă HTTP Basic (utilizator `drawcad`); gol = fără parolă |
| `DRAWCAD_CACHE_MB` | `512` | memoria pentru cache-ul de randări |
| `DRAWCAD_RETENTION_DAYS` | `30` | zile după care un document nefolosit se șterge de pe server; `0` = niciodată |
| `DRAWCAD_OCR_LANG` | `ron+eng` | limbile pentru OCR (coduri Tesseract; imaginea are română și engleză) |
| `DRAWCAD_OCR_TIMEOUT` | `150` | secunde maxime pentru OCR-ul unei pagini |
| `DRAWCAD_VECTOR_TIMEOUT` | `240` | secunde maxime pentru vectorizarea unei pagini scanate |

## Utilizare

**Flux de lucru:**
1. Deschide un PDF sau o imagine (trage fișierul pe pagină).
2. Alege o unealtă și dă click pe desen.
3. Editează valoarea și toleranța în panoul din dreapta.
4. Apasă **Exportă PDF**.

**Snap (ca în AutoCAD):** cursorul se prinde de geometria vectorială a PDF-ului și de ce ai desenat tu. Tooltip-ul de lângă cursor arată modul.
- **Capăt** □, **Mijloc** △, **Centru** ○ (cercuri, dar și centrele racordărilor), **Cadran** ◇, **Intersecție** ⊠ (linii, cercuri, arce), **Pe obiect** ⧗
- **Intersecție aparentă** ⊠… — punctul în care s-ar întâlni prelungirile a două linii: colțul teoretic al unei teșituri sau al unei racordări, la care se cotează
- **Extensie** — oprește cursorul o clipă pe capătul unei linii (apare o cruciuliță verde), apoi mergi în prelungirea ei; tooltip-ul arată distanța față de capăt
- **Urmărire** — tot din punctele achiziționate: aliniere pe orizontală și verticală, inclusiv punctul care are X-ul unuia și Y-ul altuia
- **Perpendicular** ⊥ și **Tangent** față de punctul anterior al comenzii
- **Paralel** // — în timpul unei comenzi oprește-te pe o linie, apoi mișcă-te aproape paralel cu ea
- **Polar** — pe razele de 5°…90° față de punctul anterior (implicit 15°), cu distanță și unghi în tooltip; se exclude cu Ortho

Modurile se aleg din săgeata de lângă „Snap”, în bara de jos. Taste: **F3** snap, **F8** ortho, **F10** polar, **F11** urmărire, **Alt** ținut = fără snap, **Shift** = ortho temporar, **Esc** golește punctele achiziționate.

**Scanuri:** după deschidere folosește **Calibrare (K)**. Dai click pe capetele unei cote cunoscute și introduci valoarea reală.

**Taste și comenzi:** sunt două moduri. Se aleg din **Setări → Taste și comenzi** sau scriind comanda `ALIASEDIT`.
- **Taste directe** (implicit): o tastă pornește unealta (tabelul de mai jos). **Enter** deschide linia de comandă din bara de jos: scrii `DLI`, `C`, `PL`… și dai Spațiu sau Enter.
- **Comenzi AutoCAD:** scrii comanda oriunde pe desen. Ea apare în linia de comandă, cu sugestii, iar **Spațiu** sau **Enter** o pornește. Spațiu sau Enter fără nimic scris repetă ultima comandă, iar la polilinie o termină. Spațiu ținut + tragere mută foaia.

Prescurtările implicite urmează AutoCAD: `L` linie, `PL` polilinie, `REC` dreptunghi, `C` cerc, `A` arc, `H` hașură, `CM` axe cerc, `DLI` / `DAL` / `DDI` / `DRA` / `DAN` cote, `LE` indicație, `T` / `MT` text, `TOL` GD&T, `E` șterge (cu selecție: șterge selecția), `DI` măsoară, `P` mută, `U` anulează, `Z` potrivește pagina, `OS` / `OR` snap / ortho, `OP` setări. Comenzile fără echivalent în AutoCAD au nume scurte: `RUG` rugozitate, `NOTE`, `REV` tabel de revizii, `BOM`, `SEC` secțiune, `DET` detaliu, `BAL` reper, `STR` taie cota, `WO` acoperire, `CALIB` calibrare. Merge și numele uneltei („cerc”, „rază”).

În același dialog fiecare unealtă poate primi altă tastă și alte prescurtări. Dublurile se semnalează și blochează salvarea. Configurarea se păstrează în browser (în aplicația desktop, pe calculator), pentru toate documentele.

Tastele directe implicite:

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
| U | cotă unghiulară | Q | rugozitate |
| N | note tehnice | E | tabel de revizii |
| I | linie | P | polilinie |
| J | dreptunghi | Y | cerc |
| Z | arc | M | măsoară (fără să adauge nimic) |

**Mouse:**
- **click dreapta** = Esc: termină polilinia, oprește lanțul de linii, renunță la punctele date sau deselectează
- **click dreapta ținut** = meniu radial cu comenzile tale favorite (le alegi în **Setări**, pe cele 8 poziții). Sus e ultima comandă folosită, apoi Diametru, Rază, Text, Linie (sau Șterge selecția), Indicație, Anulează, Măsoară. Alegi trăgând în direcția comenzii și eliberând, sau eliberezi pe loc și dai click pe comandă.
- **click dreapta tras** sau rotița apăsată = mută foaia

**Tabletă și telefon:** panoul de proprietăți devine un sertar (pe telefon, o foaie care urcă de jos). Se deschide singur când alegi o adnotare sau ai de scris un text, iar butonul cu glisoare din antet îl deschide oricând. Pe ecran tactil:
- **două degete** mută foaia și fac zoom
- **punctul** se pune la ridicarea degetului, așa că îl poți ajusta cu snap
- **apăsare lungă** deschide meniul radial

**Original la tipărire:** desenele colorate ies palid la imprimantă. Ai două variante:
- **Tot desenul.** În panoul documentului (sau în dialogul de export) bifezi „Linii și text negre, pe tot desenul”. Liniile și textul originalului devin negre, inclusiv cele din blocuri (indicatorul). Albul rămâne alb, iar cotele tale nu se schimbă.
  - Suprafețele pline colorate pot deveni negre, gri sau rămâne neschimbate.
  - Imaginile (și scanurile) pot deveni alb-negru: tot ce nu e hârtie devine negru.
  - Se vede pe ecran și se aplică la export.
- **Doar unele linii.** Unealta **Înnegrește** din grupul Revizie: tragi o zonă și bifezi obiectele care devin negre.

**Taste generale:**
- Ctrl+Z / Ctrl+Y: anulează / refă
- Ctrl+C / Ctrl+V: copiază adnotarea selectată / o lipește la cursor
- Ctrl+D: duplică adnotarea selectată, decalat cu 5 mm
- Ctrl+A: selectează toate adnotările de pe pagină
- săgeți: mută selecția cu 0,5 mm (cu Shift: 5 mm)
- Delete: șterge adnotarea selectată
- Esc: renunță la operația curentă
- rotița mouse-ului: zoom
- Space + tragere, sau butonul din mijloc: mută foaia

**Cota de diametru** are întotdeauna săgeți pline, ca linia de indicație, chiar dacă pentru celelalte cote ai ales capete deschise, oblice sau punct.

**Editare:** la o adnotare selectată, pătrățelele mută punctele, iar cercul alb mută textul cotei de-a lungul liniei. Tragerea de corp mută toată adnotarea.

**Selecție multiplă:**
- **Shift+click** adaugă sau scoate o adnotare din selecție.
- **Dreptunghi tras pe o zonă goală** selectează:
  - de la stânga la dreapta: doar ce e complet înăuntru;
  - de la dreapta la stânga: tot ce atinge (ca în AutoCAD).
- **Grupul selectat** se mută trăgând de oricare dintre adnotări sau cu săgețile. Se copiază, se duplică și se șterge împreună.
- **Din panou** setezi pentru tot grupul mărimea și stratul.

**Mărime:** orice adnotare selectată (cote, rugozitate, GD&T, bază, tabel de revizii etc.) are în colț un pătrățel alb cu diagonală. Tragi de el spre ancoră ca să micșorezi sau în sens opus ca să mărești, între 30% și 500%. Același lucru se face din panou, cu butoanele −/+ sau 50…200%. Se scalează textul, săgețile și distanțele; grosimea liniilor rămâne. Pătrățelul de mărire merge și cu altă unealtă activă.

**Text pe mai multe rânduri:** câmpurile de text, linie de indicație și note acceptă Enter pentru rând nou. La text, înălțimea se alege direct în mm (2,5 / 3,5 / 5 / 7 / 10).

**Textul cotelor:** dacă eticheta nu încape între săgeți, se mută automat lângă săgeată, iar linia de cotă se prelungește până sub text. Dacă muți textul manual, butonul „Text automat” readuce poziționarea automată.

**Simboluri în text:** sub câmpurile de text sunt butoane pentru ⌀ ⌴ (lamaj) ⌵ (teșire) ↧ (adâncime) ± ° × √, pentru indicații de găuri și filete de tipul `4× M8 ↧12`.

**Note (N):** dai click pe colțul stânga-sus al blocului și scrii notele în panou, câte una pe rând. Numerotarea e automată, iar rândurile goale se sar. Ai și note uzuale de adăugat cu un click: teșiri, raze, ISO 2768, tratament termic.

**Tabel de revizii (E):** dai click pe colțul dreapta-sus al cartușului (se prinde cu snap). Tabelul se așază deasupra, aliniat la dreapta, cu antetul jos și revizia cea mai nouă sus. La creare se completează din cotele tăiate: câte un rând pentru fiecare număr de revizie. Butonul „Din cotele tăiate” adaugă ulterior reviziile noi. Numele implicit se setează în Setări.

**Listă de componente:** dai click pe colțul dreapta-sus al cartușului. Lista se așază deasupra, cu antetul jos și poziția 1 lângă antet (ISO 7573), câte un rând pentru fiecare reper de pe desen. Coloane: Poz., Denumire, Buc., Material, Observații. „Din repere” adaugă reperele puse ulterior.

**Apucat, mutat, mărit:** în modul Selecție cursorul și o etichetă scurtă arată ce se apucă la click:
- **peste o adnotare:** conturul ei se aprinde, cursorul devine cruce de mutare;
- **peste un mâner al adnotării selectate:** mânerul primește un inel, iar eticheta spune ce face („Punct de cotă”, „Poziția liniei de cotă”, „Mută textul cotei”, „Cotul liniei”…);
- **peste un colț de mărire:** colțurile albe ale casetei punctate, cu săgeată de redimensionare;
- **peste marginea unei casete:** săgeata de redimensionare, ca la Windows.

În timpul tragerii eticheta arată valoarea: deplasarea Δx/Δy, procentul de mărire, noua cotă sau dimensiunile casetei.

**Ștergerile se văd direct în editor:** pagina e randată cu ștergerile aplicate, exact ca în PDF-ul exportat; rămâne doar conturul roșu al zonei.

**Casete (acoperiri, ștergeri, înnegriri, cote tăiate, dreptunghiuri desenate):** ca la ferestrele din Windows, cursorul se schimbă în săgeată de redimensionare pe margini și colțuri; tragi de margine și caseta se mărește sau se micșorează, cu snap.

**Cadrul GD&T:** linia de indicație are un pătrățel în cot. Îl tragi oriunde ca s-o frângi în orice unghi; „Cot automat (90°)” din panou revine la varianta implicită.

**Bara de unelte și straturile:** grupurile din bară se pliază din titlul lor (starea se ține minte); tasta unei unelte deschide grupul ei. În panoul documentului, ochiul de lângă fiecare strat (Original, Adăugate, Revizii, Ștergeri) îl ascunde doar pe ecran, pentru verificare; exportul conține tot.

**Rugozitate (Q):** dai două click-uri în același punct pentru simbol direct pe suprafață, sau al doilea click în altă parte pentru simbol cu linie de indicație. Simbolul direct se poate așeza deasupra suprafeței sau la stânga ei; pentru suprafețe văzute de jos sau din dreapta, ISO 1302 cere linie de indicație.

**Cota unghiulară (U):** dai click pe vârf, pe un punct de pe fiecare latură, apoi pe poziția arcului. Poziția arcului alege unul din cele patru sectoare: unghiul, suplementul sau opusul lor.

**Desen:**
- **Linie (I):** start → capăt; următoarea linie pornește din capătul celei precedente, ca LINE din AutoCAD. Esc sau Enter oprește lanțul.
- **Polilinie (P):** click pe fiecare vârf; Enter, dublu-click sau Esc termină. Click pe primul punct închide conturul.
- **Dreptunghi (J), Cerc (Y):** două click-uri; lățimea, înălțimea sau diametrul exact se scriu apoi în panou.
- **Arc (Z):** centrul → începutul → sfârșitul. Sensul e cel în care miști cursorul după al doilea click; „Arcul complementar” din panou îl întoarce.
- **Axe cerc:** centrul (snap ○) → un punct pe cerc. Axele linie-punct depășesc conturul cu 3 mm (2 / 3 / 5 mm din panou) și se intersectează pe liniuțe.
- **Ruptură:** capetele liniei; zigzag la mijloc sau ondulată (din panou), linie subțire tip 01.1.
- **Snap pe ce ai desenat:** capete, mijloace, centre, cadrane de cerc și intersecții, inclusiv cu geometria PDF-ului.
- **Hașură:** click pe vârfurile zonei secționate, cu snap pe contur; Enter sau click pe primul punct termină. Unghiul (45°, 135°…), pasul și varianta încrucișată se aleg din panou.
- **Tipul de linie și grosimea** se aleg din panou înainte de desen (cu unealta activă) sau după, pe forma selectată. Sunt și presetări ISO 128-24: contur vizibil 0,5, contur ascuns, axă, piese vecine etc. Ultima alegere rămâne implicită.
- **Modelul liniei** respectă lungimile din ISO 128-20 (liniuță 12d, linie lungă 24d, gol 3d) și se ajustează la lungimea fiecărei linii, astfel încât să înceapă și să se termine cu liniuță. „Scara modelului” îl mărește pentru desene mari.

**Vederi:**
- **Secțiune:** capetele planului de secționare → un click pe partea spre care privești. Se desenează linie-punct subțire, groasă la capete, cu săgeți și litere (A, B, C…, fără I, O, Q). Pătrățelul din mijloc întoarce săgețile.
- **Detaliu:** centrul zonei → raza; litera următoare se pune lângă cerc și se poate muta.
- **Etichetă:** propune „A–A” pentru prima secțiune neetichetată, apoi „B (2:1)” pentru detalii. Același lucru îl face butonul „Adaugă eticheta” din panoul secțiunii sau al detaliului.
- **Reper:** punct pe piesă → poziția cercului; numerele cresc automat. Din panou: încercuit sau pe linie, capăt cu punct (în interiorul piesei) sau săgeată (pe contur).
- **Măsoară (M):** două puncte cu snap; arată distanța, Δx, Δy și unghiul, la scara desenului.

**Ștergere din original:** după ce tragi zona, dialogul arată obiectele găsite și o previzualizare înainte/după. Ai patru moduri:
- **Acoperă zona** (implicit): un dreptunghi plin peste zonă, fără să elimine ceva din fișier. Culoarea e albă, dar o poți schimba: alegi din paletă, iei o mostră cu „Pipetă” direct din previzualizarea „Înainte” sau, în Chrome/Edge, de oriunde de pe ecran cu „Ecran”. Așa acoperirea se potrivește cu fundalul unui desen colorat sau scanat.
- **Selecție pe obiecte:** bifezi exact ce se elimină. Sunt bifate din start obiectele aflate cel puțin 90% în zonă (lungimea liniei, aria textului) și literele mici cu centrul în zonă, chiar dacă o codiță iese afară (g, p, y la textele AutoCAD exportate ca linii). Lista arată procentul pentru fiecare. „Bifează tot ce atinge zona” le bifează pe toate.
- **Doar textul:** elimină valorile, iar liniile de cotă rămân.
- **Tot din zonă:** elimină ce e în zonă și taie liniile care trec prin ea exact la marginea zonei (conturul rămâne, cu o întrerupere; arcele și cercurile se taie la fel). Ce nu se poate tăia (suprafețe pline, imagini, obiecte din blocuri) poate fi acoperit cu alb: opțiunea „Acoperă zona cu alb” e bifată automat când e cazul.

**Export pe pagini:** la un document cu mai multe pagini, dialogul de export oferă toate paginile (implicit), doar pagina curentă sau o listă („1, 3-5”). Bifa „Fiecare pagină într-un PDF separat” descarcă o arhivă ZIP cu câte un PDF pe pagină (`nume_p1.pdf`…). Fiecare fișier poartă stratul editabil doar pentru paginile lui, deci se redeschide corect.

**Lista adnotărilor:** în panoul documentului (fără selecție) apar adnotările paginii, cu valoarea lor. Click = selectează și centrează, coșul = șterge. **Shift+F** face zoom pe selecție, **dublu-click** pe o adnotare duce cursorul direct în câmpul de editat. În antet, lângă numele documentului, se vede dacă modificările sunt salvate pe server. La o eroare de rețea salvarea se reîncearcă singură.

**Închidere și păstrare pe server:**
- **Butonul ✕** de lângă numele documentului îl închide și te întoarce la pagina de start.
- **Fără modificări neexportate**, documentul se închide direct. Altfel te întreabă:
  - **Exportă PDF și închide:** salvezi PDF-ul pe calculator, apoi documentul se închide;
  - **Închide fără export:** lucrul rămâne pe server și îl redeschizi din Recente;
  - **Închide și șterge de pe server.**
- **Salvarea pe server** e automată, la fiecare modificare, și se face și la închiderea tab-ului.
- **Cât stau documentele pe server:** `DRAWCAD_RETENTION_DAYS` zile (implicit 30) de la ultima folosire; deschiderea unui document resetează termenul. Curățarea rulează la pornire și apoi la 6 ore.
- **În Recente** vezi câte zile mai are fiecare document. Butonul coș îl șterge imediat.
- **PDF-urile exportate pe calculator** nu sunt afectate de această curățare.

**Redeschidere:** un PDF exportat cu „strat editabil” se poate redeschide. Cotele revin editabile, iar originalul este recuperat din fișier, deci nimic nu se desenează de două ori.

### Pagini: rotire, ordine, ștergere

Lângă filele paginilor sunt două butoane, ⟲ și ⟳, care rotesc pagina curentă cu 90° (comenzile `ROTL` / `ROTR`). Al treilea buton (sau comanda `PAGES`) deschide dialogul **Pagini**. Acolo vezi miniaturile și ai, pentru fiecare pagină:
- rotire la stânga / dreapta;
- mutare înainte / după;
- ștergere (cere confirmare dacă pagina are adnotări).

Tot de acolo se rotesc toate paginile odată (90° sau 180°).

- **Exportul păstrează rotirea și ordinea** (PDF și DXF). Fișierul încărcat rămâne neschimbat pe server; ordinea și rotirea stau separat și se aplică la randare și la export.
- **Cotele și celelalte adnotări se rotesc odată cu pagina.** O cotă orizontală devine verticală și măsoară la fel, textele se rotesc, iar tabelele (revizii, componente) rămân orizontale, mutate în locul corespunzător.
- **Ctrl+Z nu anulează operația pe pagină.** Pentru asta rotești sau muți înapoi. Istoricul adnotărilor se transformă și el, deci anularea modificărilor de dinainte merge corect.
- **OCR-ul** se ține minte pentru fiecare orientare a paginii.

### Zoom

Zoom-ul merge până la 3000%. Peste rezoluția randării întregii pagini (~20 MP), serverul randează doar zona vizibilă, la rezoluția ecranului. Liniile rămân clare la orice mărire, iar zona se reîncarcă singură la deplasare.

### Limbă

Interfața e în română sau engleză: se alege în **Setări** sau pe pagina de start; implicit urmează limba browserului. Separat, pentru fiecare document, **Setări → Limba textelor din desen** alege limba antetelor de tabel (Rev. / Modificare / Data / Nume sau Rev. / Description / Date / Name, Poz. / Denumire / Buc. sau Item / Description / Qty) și a notelor implicite. Documentele noi pornesc cu limba interfeței (în engleză și cu punct zecimal).

### Text, căutare și OCR

Butonul **Text** din antet (sau **Ctrl+F**) caută în textele desenului: cele reale din PDF și cele recunoscute prin OCR. Căutarea ignoră spațiile și diacriticele, deci „ø25” găsește „Ø 25”. Click pe un rezultat duce la pagina lui, mărește zona și o încadrează portocaliu.

**OCR (recunoașterea textului):** „Recunoaște pagina” citește textul din imaginea paginii cu Tesseract (română + engleză). E util la desenele scanate și la PDF-urile din AutoCAD cu fonturi SHX, unde textul e desenat din linii. O pagină durează de obicei 5–30 s. Rezultatul rămâne pe server, deci nu se reface la redeschidere.

Pentru desene, OCR-ul face câțiva pași în plus:
- îndreaptă întâi scanul înclinat;
- șterge liniile lungi (chenare, linii de cotă) ca să nu se lipească de litere;
- citește a doua oară pagina rotită, pentru cotele scrise pe verticală;
- corectează Ø citit greșit ca „O”, „0” sau „@”.

Bifa „Arată pe desen” desenează casetele textului găsit: verde pentru citiri sigure, portocaliu pentru cele de verificat. „Copiază textul paginii” pune tot textul în clipboard.

**PDF căutabil:** la exportul PDF, bifa „Text recunoscut (OCR) invizibil” pune textul recunoscut peste imagine, invizibil. În PDF-ul rezultat textul se poate căuta și copia, ca într-un PDF vectorial.

### Export DXF

În dialogul de export alegi **DXF**. Fiecare pagină devine un fișier DXF (AutoCAD 2010, milimetri); mai multe pagini ies într-o arhivă ZIP.

Ce conține:
- **geometria PDF-ului** (strat PDF-GEOMETRIE): liniile și contururile ca polilinii, cu racordările ca arce adevărate (bulge); cercurile ca CIRCLE, curbele oarecare ca SPLINE; grosimile de linie, culorile și liniile întrerupte (tip de linie generat din modelul PDF-ului) se păstrează;
- **umplerile** ca hașuri pline (PDF-UMPLERI);
- **textele** ca TEXT (PDF-TEXT), cu stilul ISOCPEUR;
- **cotele și adnotările DrawCAD** (DRAWCAD-COTE, DRAWCAD-REVIZIE); acoperirile albe devin WIPEOUT;
- **chenarul paginii** (PAGINA).

Obiectele șterse din original lipsesc și din DXF.

**Scara:** „Mărimea hârtiei” dă desenul 1:1 cu foaia. „Mărime reală” folosește scara calibrată (K): un desen 1:2 iese de două ori mai mare, deci cotele măsurate în CAD sunt cele reale.

**Scanuri (experimental):** pe o pagină scanată exportul face patru lucruri:
- rulează OCR, dacă nu s-a făcut deja;
- scoate din imagine textul citit sigur și îl pune ca TEXT (OCR-TEXT);
- vectorizează restul (SCAN-VECTORI): subțiere la un pixel, urmărirea liniilor, cercuri și arce potrivite pe pixeli, racordări tangente la linii, scanul îndreptat și liniile aproape orizontale / verticale aliniate;
- opțional, pune imaginea ca fundal (IMAGE + PNG în ZIP), pentru comparație.

Rezultatul e o bază de lucru, nu un desen curat:
- liniile întrerupte ies ca segmente scurte;
- săgețile și hașurile ies simplificate;
- textul citit nesigur rămâne desenat din linii.

Verifică dimensiunile importante.

## Mod de lucru: personal sau pentru serviciu

`DRAWCAD_MODE` alege cine vede ce documente:

| Mod | Cine vede documentele | Potrivit pentru |
|---|---|---|
| `private` (implicit) | doar browserul care le-a încărcat (cookie secret, 1 an) | serviciu, mai mulți colegi pe același server |
| `personal` | oricine deschide aplicația, din orice browser | un singur utilizator: acasă, pe Unraid; continui pe alt calculator fără nimic în plus |
| `session` | doar browserul care le-a încărcat, până la închiderea lui | calculatoare comune; după închidere nu mai rămâne nimic vizibil |

În `private` și `session`, un document al altui browser nu apare în Recente și nici nu se poate deschide, randa sau șterge, nici dacă cineva îi știe adresa: serverul răspunde ca și cum n-ar exista. Ca să continui pe alt calculator, în **Setări → Spațiul tău de lucru** copiezi codul și îl lipești în celălalt browser („Folosește”). Codul e ca o cheie, așa că nu-l da altcuiva. Documentele încărcate în modul `personal` (sau înainte de apariția modurilor) nu apar în spațiile private; pentru folosire doar acasă pune `DRAWCAD_MODE=personal`.

## Securitate

Fișierele încărcate sunt tratate ca nesigure:
- **Citire izolată.** Prima citire a unui fișier (decodarea imaginii, parsarea PDF-ului, randarea fiecărei pagini, extragerea geometriei) se face într-un proces separat, limitat la 3 GB de memorie și 120 s. Un fișier construit să blocheze, să umple memoria sau să dărâme biblioteca de citire e respins, iar serverul merge mai departe.
- **Conținut activ eliminat.** Din PDF se scot JavaScript-ul, acțiunile automate (la deschidere, la pagină, la câmpuri), linkurile care pornesc programe sau deschid alte fișiere, trimiterea de formulare, fișierele atașate, adnotările multimedia și formularele XFA. Linkurile web obișnuite rămân. Desenul nu se schimbă, iar exporturile ies curate. La deschidere apare un mesaj cu ce s-a eliminat.
- **Limite:** mărimea fișierului (`DRAWCAD_MAX_UPLOAD_MB`, citit în flux, fără să fie ținut tot în memorie), numărul de pagini (`DRAWCAD_MAX_PAGES`), megapixelii unei imagini (`DRAWCAD_MAX_IMAGE_MPX`, apără de „bombele de decompresie”), dimensiunea paginii și a datelor primite la export.
- **Browser.** Content-Security-Policy strictă (doar scripturile aplicației, fără `eval`), `nosniff`, fără referrer și fără încadrare pe alte site-uri. Cererile care modifică date și vin de pe alt site sunt refuzate, așa că o pagină străină deschisă în browser nu poate încărca sau șterge documente.
- **Container:** rulează ca utilizator neprivilegiat, cu `no-new-privileges`, fără capabilități în afara celor necesare pregătirii folderului `/data`, cu sistemul de fișiere doar-citire (se scrie doar în `/data` și `/tmp`) și număr limitat de procese.
- **Acces:** aplicația nu are conturi; e gândită pentru rețeaua locală. Dacă o faci accesibilă din afară, pune-o în spatele unui reverse proxy cu HTTPS și setează `DRAWCAD_PASSWORD` (utilizator `drawcad`). Dacă proxy-ul folosește alt domeniu decât cel din bara browserului, adaugă-l în `DRAWCAD_ALLOWED_ORIGINS`.

CI verifică toate acestea pe containerul construit (`tools/security_smoke.py`), cu un PDF „troian” de test.

## Date ISO 286

Toleranțele IT și abaterile fundamentale (`frontend/js/iso286_data.js`) sunt preluate din TechTools, unde au fost:
- citite din ISO 286-2:2010 (Tabelul 1 și Tabelele 8, 17–32) și verificate față de ISO 286-1:2010;
- validate prin recalcularea tuturor celor 5907 abateri limită tipărite până la 500 mm. 5896 coincid exact; celelalte 11 sunt greșeli de tipar din ISO 286-2.

Calculul urmează regulile ISO 286-1:2010:
- Δ pentru alezajele K…ZC în treptele fine;
- cazul special M6 la 250–315 mm;
- JS/js = ±IT/2, fără rotunjirea la valoare pară din ediția 1988.

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
  app/main.py    API + servire frontend, antete de securitate, limite
  app/ingest.py  prima citire a fișierelor încărcate, în proces separat și limitat
  app/sanitize.py eliminarea conținutului activ din PDF (JavaScript, acțiuni, atașamente)
  app/ocr.py     OCR cu Tesseract: îndreptare, ștergerea liniilor, text orizontal și vertical
  app/dxfout.py  export DXF (ezdxf): geometrie, texte, adnotări, straturi
  app/vectorize.py vectorizarea scanurilor, în proces separat (subțiere, graf, arce, cercuri)
desktop/    aplicația Windows: lansator (pywebview), specificația PyInstaller, installer Inno Setup
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
| ezdxf | MIT |
| NumPy | BSD |
| Tesseract OCR | Apache-2.0 |
| pywebview | BSD |
| PyInstaller (doar la construire; bootloader-ul are excepție pentru programe distribuite) | GPL-2.0 cu excepție |

## Teste

```bash
cd backend && python -m unittest discover -s tests      # API: deschidere, snap, ștergere, export, redeschidere
cd frontend && npm test                                 # ISO 286 (42 de cazuri din tabele), geometria cotelor
python tools/e2e_smoke.py http://127.0.0.1:8080 out     # browser: flux complet cu Playwright
```

`tools/make_sample.py` generează un PDF de test asemănător unui export CAD. Conține un arbore cu trepte, un cartuș într-un Form XObject, cercuri și o pagină rotită.

## Limitări cunoscute

- **ISO 286**: literele a–zc pentru arbori și alezaje, mai puțin t, v și y; treptele IT1–IT18; nominale până la 500 mm (fără 500–3150 mm).
- **Ștergerea pe obiecte** elimină obiecte PDF întregi; pentru a tăia doar o bucată dintr-un contur folosește „Tot din zonă”. Tăierea se face doar pe linii (fără umplere); suprafețele pline și imaginile atinse parțial rămân și se pot acoperi cu alb.
- **Blocurile (Form XObject)**, de obicei indicatorul sau simboluri inserate ca bloc, nu se modifică: PDFium strică fonturile blocului când îi schimbă conținutul. Obiectele din ele apar „în bloc — doar acoperire” și se pot doar acoperi cu alb.
- **Textul exportat de AutoCAD cu fonturi SHX** apare în PDF ca linii, nu ca text. În dialogul de ștergere se vede ca „Linie / contur”.
- **Adnotările se pot așeza doar orizontal sau vertical** (plus cotele aliniate). Nu există încă text rotit la unghi oarecare.
- **Fără autentificare și fără editare simultană** a aceluiași document de către mai mulți utilizatori.
- **OCR pe desene** e bun pe cartuș, note și cote clare, mai slab pe text mic, înghesuit sau lipit de linii. Tesseract nu cunoaște simbolurile GD&T, iar Ø, ± și ° sunt recunoscute doar parțial (Ø se corectează din context). Citirile nesigure apar portocaliu.
- **Vectorizarea scanurilor** e experimentală. Liniile întrerupte, săgețile și hașurile ies simplificate. Pe scanuri de calitate slabă (sub 200 DPI, pete, linii șterse) rezultatul cere curățare în CAD.
- **DXF:** blocurile din PDF (Form XObject) ies ca entități separate, nu ca blocuri. Textele folosesc stilul ISOCPEUR: dacă fontul lipsește, CAD-ul îl înlocuiește cu altul, cu altă lățime.
