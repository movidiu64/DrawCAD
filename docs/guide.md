# DrawCAD — full guide

> The short overview and quick install are in the [README](../README.md). This is the complete documentation: installing on Unraid / Dockhand, every tool, the keys, export and known limitations.

DrawCAD is a self-hosted web app (Docker) for adding to a PDF or a scan:

- **dimensions**: linear, aligned, diameter, radius, angular, chain and baseline series, and ordinate (from a base point, on X or Y) with a hole table built from them, plus chamfers, leaders and free text;
- **tolerances**: ±, deviations, ISO 286 fits with automatic limits (e.g. `Ø25k6 (+0,015/+0,002)`), and the ISO 2768-1 general tolerance of every dimension without one;
- **GD&T** to ISO 1101: all 14 characteristics, Ø, the Ⓜ Ⓛ Ⓟ Ⓕ CZ modifiers, datums A/B/C, plus datum symbols;
- **surface roughness** to ISO 1302 / ISO 21920-1: with or without material removal, parameter (Ra, Rz…), process, directly on the surface or with a leader;
- **revisions**: struck dimension + new value + revision triangle, plus a **revision table** (Rev. / Description / Date / Name) filled in from the struck dimensions;
- multi-line **technical notes**, numbered automatically, with an optional title and frame;
- a **parts list** (ISO 7573) filled in from the item balloons;
- **views**: section plane A–A (ISO 128-44), detail circle, view labels and item balloons (ISO 6433);
- **drawing**: line, polyline, rectangle, circle, arc, center mark, hatch and break line, with the ISO 128 line types (continuous, dashed, chain, double-dashed chain, dotted) and the standard widths;
- **removal** from the original, either covered in white or by truly removing the PDF objects;
- **blackening the original for printing**: colored drawings (light green, yellow) come out black, for the whole drawing or only for chosen lines; scans become black and white;
- vector **PDF export**, with an embedded ISO 3098 font and an attached editable layer;
- **search and OCR**: find any text on the drawing (Ctrl+F); on scanned drawings the text is recognized with Tesseract and can be placed invisibly in the PDF (searchable PDF);
- **opening DXF and DWG** drawings (DWG through LibreDWG): each layout becomes a page at its scale, or the model space is fitted on an ISO sheet; the drawing can be printed to PDF, annotated, and exported back to DXF as the original drawing plus the annotations;
- **DXF export** for AutoCAD / Allplan: the PDF geometry as real lines, arcs, circles and texts, the DrawCAD dimensions on their own layer, at paper size or at real size; scans are vectorized (experimental), with the recognized text as text.

The original is never modified. Annotations are stored separately and applied only on export.

## Installation

The `ghcr.io/movidiu64/drawcad:latest` image is built by GitHub Actions on every push to `main`, after the tests and the browser test on the container pass. Releases are also published under their version (`:1.2.3` and `:1.2`). The running version is shown at the bottom of **Settings**. `compose.yaml` is all you need to install it.

### On Unraid, from the template — recommended on Unraid

1. **Docker** tab → **Template repositories** (at the bottom): add `https://github.com/movidiu64/DrawCAD` and **Save**.
2. **Add Container** → **Template** → **DrawCAD**.
3. Adjust what you need and **Apply**:
   - **WebUI port** (8478) and **Data** (`/mnt/user/appdata/drawcad`);
   - **Password**: empty on the home network, set one if the app is reachable from outside;
   - **Mode**: `private`, `personal` or `session` (see [Modes](#modes-personal-or-for-work));
   - **Show more settings** for the limits, OCR languages and `PUID` / `PGID`.

Without the template repository, the same template can be added by hand: save [`unraid/drawcad.xml`](../unraid/drawcad.xml) as `/boot/config/plugins/dockerMan/templates-user/my-DrawCAD.xml` and it appears under **Add Container** → **Template**.

The template is `unraid/drawcad.xml`. It runs the container with the same hardening as `compose.yaml` (read-only filesystem, dropped capabilities, no new privileges, a process limit), passed in **Extra Parameters**; leave them there. It follows `:latest`; to pin a release, change **Repository** to `ghcr.io/movidiu64/drawcad:1.0.0`.

**Update:** the Docker tab shows "update ready" when a new image is out; **apply update** keeps the documents in the data folder.

### With Dockhand or Portainer (prebuilt image)

Create a new stack, paste the contents of `compose.yaml` and deploy. No account or token is needed: the image on `ghcr.io` is public.

1. **Stack variables** (optional; the full list is in `.env.example`):
   - `DRAWCAD_TAG=1.0.0` — pin a release; `latest` follows `main`
   - `DRAWCAD_PORT=8478`
   - `DRAWCAD_DATA_DIR=/mnt/user/appdata/drawcad` — an absolute path on the server, not a relative one
   - `PUID=99`, `PGID=100`
2. **Deploy.** The app starts on `http://<ip>:8478`.

**Update:** change `DRAWCAD_TAG` to the new version (or pull `latest` again) and redeploy. Documents and settings stay in the data folder.

### With Dockhand (Git stack, built from source)

Dockhand clones the repo and builds the image on the server, without the registry.

1. **New stack from Git:**
   - repository: `https://github.com/movidiu64/DrawCAD.git`
   - branch: `main` (or a release tag such as `v1.0.0`)
   - compose file: **`compose.build.yaml`**
2. **Stack variables:** as above, without `DRAWCAD_TAG`.
3. **Deploy.** The first build takes 1–2 minutes.

On every redeploy after a git sync the image is rebuilt (`pull_policy: build`). For automatic sync on push, set up the stack webhook in Dockhand and add it in GitHub under the repo's **Settings → Webhooks**.

**Moving from the old name (Cotare):** the container is now called `drawcad`. Stop and remove the old `cotare` container first, otherwise port 8478 stays taken. Data now lives in `/mnt/user/appdata/drawcad` by default; move the documents from `/mnt/user/appdata/cotare` there, or keep the old path with `DRAWCAD_DATA_DIR`. The `COTARE_*` variables still work.

### With docker compose from the command line

```bash
cp .env.example .env          # optional: adjust the port and the data folder
docker compose up -d          # with the image from GHCR
# or, without GHCR, building locally from source:
docker compose -f compose.build.yaml up -d --build
```

### Windows desktop app

The same app, without a server and without Docker. It runs on the computer, in its own window, and works offline.

**Installation:**
1. Download `DrawCAD-<version>-setup.exe` from **Releases** and run it. It needs no administrator rights and installs for the current user, in `%LOCALAPPDATA%\Programs\DrawCAD`.
2. Optionally, the installer adds a desktop icon and "Open with → DrawCAD" for PDFs and images, without becoming the default app.
3. The `…-portabil.zip` version is not installed: unzip it and start `DrawCAD.exe`.

**"Windows protected your PC":** the installer is not code-signed (a certificate costs a yearly fee), so SmartScreen warns on the first run. Click **More info → Run anyway**. The files are built by GitHub Actions from the public source, and the run that produced each release can be checked in the Actions tab.

**What it contains:** everything, OCR included (Tesseract, Romanian and English).

**Where working documents live:** in `%LOCALAPPDATA%\DrawCAD`. They stay until you delete them from Recent; there is no automatic cleanup.

**Export** opens the Windows "Save as" dialog.

**The window** uses Microsoft Edge WebView2, which ships with Windows 11 and with Edge on Windows 10. If it is missing, DrawCAD opens in the default browser.

**The internal server** listens only on `127.0.0.1` and answers only to the names `127.0.0.1` and `localhost`. Other computers cannot reach it, and a foreign site cannot access it through DNS rebinding.

**Log:** warnings, slow starts (over 5 s) and slow requests (over 3 s) are written to `%LOCALAPPDATA%\DrawCAD\drawcad.log`.

**Build:** GitHub Actions (`.github/workflows/desktop.yml`) produces automatically, on every push to `main`:
- the executable, with PyInstaller;
- a self-test on the executable: reading, rendering, OCR, PDF and DXF export, vectorization of a scan;
- the full browser test against the server inside the executable;
- the installer, with Inno Setup.

The result can be downloaded from the run page (Artifacts). A `v1.2.3` tag, or a release created on GitHub (which pushes that tag), attaches the installer and the ZIP to the release. To attach them again to an existing release: **Actions → Desktop Windows → Run workflow**, with the tag (`v1.2.3`).

**Update:** run the new version's installer over the old one. Documents and settings are kept.

### Data folder and permissions

The container starts as root only long enough to create the data folder and give it the owner `PUID:PGID`, `99:100` by default (nobody:users on Unraid). Then it runs the app as that user. No manual `chown` is needed. If you use `user:` in compose, the folder must already be writable by that user.

The app has no user accounts, so keep it on the local network (or behind a reverse proxy with a login).

### Environment variables

The app was originally called "Cotare": the old `COTARE_*` variables are still accepted, and PDFs exported by old versions reopen editable.

| Variable | Default | Role |
|---|---|---|
| `DRAWCAD_TAG` | `latest` | image tag; a release version (`1.2.3`, `1.2`) or a commit SHA pins the version |
| `DRAWCAD_PORT` | `8478` | port on the server |
| `DRAWCAD_DATA_DIR` | `/mnt/user/appdata/drawcad` | data folder on the server |
| `PUID` / `PGID` | `99` / `100` | user the app runs as |
| `DRAWCAD_MAX_UPLOAD_MB` | `200` | maximum size of an uploaded file |
| `DRAWCAD_MAX_RENDER_PX` | `12000` | maximum side, in pixels, of a page render |
| `DRAWCAD_MAX_RENDER_MP` | `40` | maximum megapixels of a whole-page render (high zoom is rendered in tiles) |
| `DRAWCAD_MODE` | `private` | `personal`, `private` or `session` (see [Modes](#modes-personal-or-for-work)) |
| `DRAWCAD_MAX_PAGES` | `300` | maximum number of pages per document |
| `DRAWCAD_MAX_IMAGE_MPX` | `400` | maximum megapixels of an uploaded image (a scan opened as a document; images placed on a drawing are limited to 100) |
| `DRAWCAD_MAX_DXF_ENTITIES` | `400000` | maximum entities of an opened DXF / DWG, counted with blocks expanded |
| `DRAWCAD_DWG_TIMEOUT` | `90` | maximum seconds for converting a DWG (LibreDWG) |
| `DRAWCAD_DWG2DXF` | — | path of LibreDWG's `dwg2dxf`, when it is not on PATH (the image and the Windows app have it) |
| `DRAWCAD_MAX_IMAGE_MB` | `40` | maximum size of an image placed on a drawing (logo, photo) |
| `DRAWCAD_PASSWORD` | empty | HTTP Basic password (user `drawcad`); empty = no password |
| `DRAWCAD_CACHE_MB` | `256` | maximum memory of the in-RAM caches (PDFs, renders); only used as needed |
| `DRAWCAD_RETENTION_DAYS` | `30` | days after which an unused document is deleted from the server; `0` = never |
| `DRAWCAD_OCR_LANG` | `ron+eng` | OCR languages (Tesseract codes; the image includes Romanian and English) |
| `DRAWCAD_OCR_TIMEOUT` | `150` | maximum seconds for OCR of one page |
| `DRAWCAD_VECTOR_TIMEOUT` | `240` | maximum seconds for vectorizing one scanned page |

## Usage

**The screen:** the header holds the document (name, save state, close), the text search, undo / redo, zoom, *Hide the panels*, Open, Settings and **Export ▾** (the arrow picks PDF or DXF first). On the left, the tool rail has one slot per family (Select, Pan, Measure, Dimensions, Tolerances, Annotations, Drawing, Views, Revision): a click runs the tool the slot shows (the one used last in that family) and opens the family's list next to it, with every tool, its alias and its key; pick another tool from the list, or move on to the drawing and the list closes by itself (a second click on the slot or Esc closes it too). Resting the mouse on a slot for a moment opens its list without changing the tool, and with a list open, moving along the rail switches to the next family's list; Settings → Interface → *Tool rail* turns this off. Above the drawing, the context bar shows the active tool, its hint and the options of the current step, or, with a selection, what is selected and its actions (Move, Copy, Zoom to selection, Erase; for a linear dimension also *Chain from here* and *Baseline from here*); the pages are on its right. The panel on the right has three tabs: **Properties** (the selection), **Layers** (document, drawing scale and Calibrate, layers, printing) and **Annotations** (the page's list with a filter and chips by kind). Panel sections open and close from their title, remembered; Size and Layer start closed. At the bottom: coordinates, the command line, the Snap / Tracking / Polar / Ortho toggles and the scale. **Ctrl+0** (or the header button) hides the rail, the context bar and the panel. In Settings → Interface → *Tool rail* you turn the labels off (icons only) or hide families you don't use; their tools stay reachable from the command line and their keys.

**Settings** has two groups of sections on the left. *Current document*: **Dimension style** (text height, dimension line ends, arrow length, thin line width, decimal separator, ISO 286 display and notation, with a preview of a Ø25k6 dimension that follows your choices) and **Sheet and revisions** (scale, revision number and name, ISO 2768 general tolerance class, language of drawing texts); these take effect on **Apply**, and *Use this style as the default for new documents* keeps them for the next documents. *All documents*: **Interface** (language, theme: dark, light or as the system, with the sheet white in both; tool rail), **Commands and menu** (keys mode, radial menu) and **Workspace** (the workspace code, in the private modes); these are saved at once.

**Workflow:**
1. Open a PDF or an image (or drag the file onto the page).
2. Pick a tool and click on the drawing.
3. Edit the value and the tolerance in the panel on the right.
4. Press **Export**.

**Snap (as in AutoCAD):** the cursor snaps to the PDF's vector geometry and to what you have drawn. The tooltip next to the cursor shows the mode.
- **Endpoint** □, **Midpoint** △, **Center** ○ (circles, and the centers of fillets too), **Quadrant** ◇, **Intersection** ⊠ (lines, circles, arcs), **Nearest** ⧗
- **Apparent intersection** ⊠… — the point where the extensions of two lines would meet: the theoretical corner of a chamfer or fillet, which is what gets dimensioned
- **Extension** — rest the cursor for a moment on the end of a line (a green cross appears), then move along its extension; the tooltip shows the distance from the end
- **Tracking** — also from acquired points: horizontal and vertical alignment, including the point that has the X of one and the Y of another; with "Tracking along the polar angles too" in the snap menu (and polar on) also along the polar angle nearest the cursor
- **Perpendicular** ⊥ and **Tangent** relative to the command's previous point
- **Parallel** // — during a command rest on a line, then move nearly parallel to it
- **Polar** — on the 5°…90° rays from the previous point (15° by default), with distance and angle in the tooltip; excludes Ortho. In the snap menu: **additional angles** (e.g. `7; 22,5`), angles measured **from the last segment** instead of from the horizontal, and a **step** along the polar direction (real mm: the point jumps 10, 20, 30… along the ray)
- **Node** — the points of the annotations already drawn (dimension origins, symbol anchors)
- **Geometric center** — the center of a closed outline from the PDF (a rectangle, a slot outline), and **Insertion** — where a PDF text starts (its baseline). Both are off by default; turn them on in the menu or type `GCE` / `INS` for one pick

Modes are chosen from the arrow next to "Snap" in the bottom bar. Keys: **F3** snap, **F8** ortho, **F10** polar, **F11** tracking, **Alt** held = no snap, **Shift** held = ortho the other way round (on when it is off, off when it is on), **Esc** clears the acquired points.

**One snap for the next pick:** type `END`, `MID`, `CEN`, `QUA`, `INT`, `APP`, `EXT`, `PER`, `TAN`, `NEA`, `PAR`, `NOD`, `GCE` or `INS` in the command line (the whole names work too) and only that snap is used for the next point, even with snap off; `NON` = no snap. With `CEN`, hovering the edge of a hole is enough to take its center. In direct-keys mode, click the command line first (letters there are tools).

**FROM, M2P and point filters:** at any point of a command, `FROM` asks for a base point and then takes the point as an offset from it (`@10,5`, `@20<45`); `M2P` (or `MTP`) takes the midpoint of the next two picks; `.X` takes X from the next pick and Y from the one after (`.Y` the other way round). `TK` (tracking) takes a first tracking point, then each next one only horizontally or vertically from the previous (`@20,0`, a click); Enter ends tracking and the last point goes to the command.

**Several snaps under the cursor:** **Tab** steps through them (Shift+Tab back); the label shows which one, e.g. "Endpoint (2/3, Tab)", and a click takes it.

**Snap on scans:** a scan has no lines for the snap. Tick **Snap și pe scanări** in the snap menu and the page is vectorized on the server (the first time takes from seconds to a minute; then it is cached): endpoints, midpoints, centers, quadrants and intersections work on the scanned drawing too. Text read by OCR (if you ran it) is left out. The vectorization is approximate, so check the points that matter.

**Scans:** after opening, use **Calibrate (K)**. Click the ends of a known dimension and enter its real value.

**Drawing to scale:** lines, circles and rectangles are drawn and edited in real mm, like dimension values. At scale 2, a line typed as 10 is 5 mm on paper and a dimension on it reads 10. In the panel, "· scale 2" appears next to the field. If you drew before calibrating, Calibrate asks what to do with the shapes:
- **Stay on the drawing** (default): for shapes snapped to the outline. They stay on the same lines and their real size is recalculated.
- **Keep their real dimensions**: for shapes drawn with typed values. They are scaled about their start point, so a line of 10 stays 10.

Dimensions do not change on calibration: they measure the drawing.

**Typed length and angle (as in AutoCAD):** after the first point of a line, polyline, circle, arc or dimension, **L** (the distance from the last point, in real mm) and **∠** (the angle, counter-clockwise: 0° to the right, 90° up) appear next to the cursor.
- Type the digits directly, no click in the box needed: `100` Enter puts the point 100 away along the cursor direction. The comma is the decimal separator (`12,5`).
- **Tab** switches between L and ∠. A typed value stays locked (🔒) and the other one follows the cursor: `100` Tab `30` Enter = 100 at 30°, while only Tab `45` fixes the direction and you pick the length with the mouse.
- Without a typed angle, the direction comes from the cursor, **ortho** (Shift / F8), **polar** (F10) or a snap. For a circle, L is the radius.
- **Enter** or **Space** places the point. **Backspace** corrects, and **Esc** drops the values (a second Esc stops the command).
- **F12** turns the box on / off.

**Typed points (as in AutoCAD):** while a command asks for a point, type it in the command line and press Enter.
- `x,y` absolute, from the **origin**: by default the bottom-left corner of the page, X to the right, Y up, in real mm (at drawing scale). `#x,y` is the same.
- `@dx,dy` relative to the last point; `@d<a` distance and angle from it (0° to the right, 90° up); `d<a` polar from the origin; `@` the last point itself; a number alone = that distance along the cursor direction.
- In the command line the **comma separates X and Y** and the decimal mark is a point (`@12.5,0`). In the L / ∠ box next to the cursor the comma stays the decimal mark.
- `@`, `#` and `<` open the command line from anywhere; so does the first digit of a first point. The line stays open for the next point; Enter on an empty line ends the command.
- The bottom bar shows X and Y from the same origin, in the same units.
- The boxes (struck dimension, cover, removal, blackening) take two typed corners: `x,y`, then `@width,height`.

**Origin (`UCS`):** the **Origin** tool (Navigation group, command `UCS`) makes the clicked point 0,0 for typed coordinates on this page, typically the corner or the datum of the part. A small X / Y symbol marks it on screen only (never exported); drag its square to move it, delete it or use `UCS` → `W` to go back to the page corner. It follows page rotation and sheet size like the annotations.

**Prompts and options:** while a command runs, the command line shows what it asks for and the options it has now, as buttons. Choose one by its letter + Enter (AutoCAD's letters, in both languages) or with a click. In direct-keys mode, an option letter typed on the drawing goes to the command line by itself.
- `DLI`: `T` text (a number sets the nominal value, other text replaces it), `H` horizontal, `V` vertical, `R` rotated (the angle of the dimension line, as AutoCAD's rotated dimension; it measures along that direction, and the panel keeps the angle editable). `DAL`, `DDL`, `DDI`, `DRA`, `DAN`: `T`.
- `DOR`: `X` / `Y` force the axis. `DOR`, `DCO`, `DBA`: `U` drops the last point.
- `DCO`, `DBA`: `S` (before the first point) picks an existing linear dimension to continue: the chain goes on from its second extension line on the same line, a baseline series from its first one, one step further out; Enter ends it, with no placement click.
- `L`: `U` undoes the last segment, `C` closes the chain. `PL`: `U`, `C`.
- `C` (circle): `D` diameter. `REC`: `D` length and width. `UCS`: `W` page corner.
- `T` (text): `H` height in paper mm, `R` angle. `DI` (measure): `M` a chain of points with a running total, until Enter; `A` area and perimeter (then `O` for an object, `D` back to distance).
- An option that needs a value asks for it in the command line; Esc or an empty Enter keeps the default.

**Prompt next to the cursor:** with dynamic input on (F12), the same prompt and option letters appear next to the cursor, above L / ∠. **↓** opens the options there (also from an empty command line), ↑ / ↓ move, Enter picks, Esc closes.

**F2** opens the session history: commands, typed points, options and answers.

**Erase, move, copy:** `E` deletes the selection; with nothing selected it asks to select objects, and Enter deletes them. At that prompt: click and window as usual, `W` / `C` force a window or a crossing for the next rectangle, `F` draws a fence line (clicks, then Enter) that takes what it crosses, `WP` / `CP` a polygon that takes what is inside it (or, for CP, also what it crosses), `ALL`, `L` the last one, `P` the previous selection, `R` removes from the selection and `A` adds again; they are also buttons in the command line. `M` (MOVE) and `CO` (COPY) work on the selection (or ask for one): a base point, then a second point or `@dx,dy`; COPY goes on placing copies from the same base point until Enter or Esc. The removal tool on the original is `X` / `STERGE`.

**Hot grips:** click a grip of the selected annotation without dragging and it becomes hot (dragging still stretches it). Space, Enter or right click go Stretch → Move → Rotate → Scale → Mirror; `B` picks another base point, `C` leaves a copy at every click (the grip stays hot), `X` or Esc ends. Points can be typed as anywhere else, relative to the base (`@0,-10`). In Stretch and Move, digits typed at the cursor give the length from the base in the cursor's direction (Tab for the angle), as for the next point of a line. Rotate turns texts, stamps, dimensions and drawn lines, polylines, hatches, circles and arcs by any angle (type it, or point the cursor: 0.1° steps, polar and ortho apply), a linear dimension becoming a rotated one that measures the same; when the selection holds anything else (tables, symbols, GD&T frames, rectangles) it turns in quarter turns (`90`, `180`, `270`), Scale takes the cursor's distance from the base when the mode starts as factor 1 (or type the factor), Mirror flips about a horizontal or vertical axis through the base, picked from the cursor's direction; texts stay readable. With several annotations selected each shows its grips (up to 100; no resize corners then). Shift+click makes several grips hot (red); a click on one of them then stretches all of them by the same displacement. Resting on a grip for a moment opens its menu: Stretch, Move, Rotate, Scale, Mirror and, on a vertex of a polyline or hatch, Add vertex (the new vertex follows the cursor until you click) and Remove vertex.

**Annotations on top of each other:** in Select mode the tip under the cursor shows `1/2 — Tab: next`; Tab changes which one is highlighted, and the click selects that one.

**Transparent commands:** `'Z` (or `Z`), `'ZS`, `'OS`, `'OR`, `'POLAR` work in the middle of a command without ending it. Other commands wait until the current one ends (Esc).

**Keys and commands:** there are two modes, chosen in **Settings → Commands and menu → Keys and commands** or by typing the `ALIASEDIT` command.
- **Direct keys** (default): one key starts a tool (table below). **Enter** opens the command line in the bottom bar: type `DLI`, `C`, `PL`… and press Space or Enter.
- **AutoCAD commands:** type the command anywhere on the drawing. It appears in the command line, with suggestions, and **Space** or **Enter** starts it. Space or Enter with nothing typed repeats the last command, and ends a polyline. Space held + drag pans the sheet. In this mode you can also turn on **selection as in AutoCAD**: a click or a window adds to the selection, Shift removes.

**Command history:** in the command line, arrow up / down browses previously used commands, most recent first, as in AutoCAD. The list appears above the command line and Enter starts the chosen one. In AutoCAD commands mode, arrow up works directly on the drawing when nothing is selected (with a selection, the arrows move it). Once you start typing, the arrows pick from the suggestions. The history keeps the last 50 commands, including those started from the toolbar or with keys, and is stored in the browser.

The default aliases follow AutoCAD: `L` line, `PL` polyline, `REC` rectangle, `C` circle, `A` arc, `H` hatch, `CM` center mark, `DLI` / `DAL` / `DDI` / `DRA` / `DAN` / `DOR` / `DCO` / `DBA` dimensions, `LE` leader, `T` / `MT` text, `TOL` GD&T, `E` erase, `M` move, `CO` copy, `UCS` origin, `DI` measure, `P` pan, `U` undo, `Z` fit page, `OS` / `OR` snap / ortho, `OP` settings. Commands without an AutoCAD equivalent have short names: `RUG` roughness, `NOTE`, `REV` revision table, `BOM`, `HT` hole table, `SEC` section, `DET` detail, `BAL` balloon, `STR` strike dimension, `WO` cover, `CALIB` calibration. The tool name works too ("circle", "radius", in Romanian or English).

In the same dialog every tool can get another key and other aliases. Duplicates are flagged and block saving. **Import acad.pgp…** reads your AutoCAD alias file (in AutoCAD: Manage → Edit Aliases, or the `acad.pgp` in the Support folder): aliases of commands DrawCAD has are added, an alias that belonged to another command moves to the one in the file, and the summary lists what has no equivalent. The file is read in the browser, nothing is uploaded, and nothing is saved before Apply. The configuration is kept in the browser (in the desktop app, on the computer), for all documents.

Default direct keys:

| Key | Tool | Key | Tool |
|---|---|---|---|
| V | select | G | GD&T frame |
| H | pan | B | datum |
| D | linear dimension | S | strike dimension (revision) |
| A | aligned dimension | W | white cover |
| O | diameter | X | delete from the original |
| R | radius | K | calibrate scale |
| C | chamfer | T | text |
| L | leader | F | fit page |
| U | angular dimension | Q | roughness |
| N | technical notes | E | revision table |
| I | line | P | polyline |
| J | rectangle | Y | circle |
| Z | arc | M | measure (adds nothing) |

**Mouse:**
- **right click** = Esc: finishes the polyline, stops the line chain, drops the picked points or deselects
- **right click held** = radial menu with your favorite commands (chosen in **Settings → Commands and menu**, in the 8 positions). At the top is the last command used, then Diameter, Radius, Text, Line (or Delete selection), Leader, Undo, Measure. Pick by dragging towards the command and releasing, or release in place and click the command.
- **right click dragged** or the pressed wheel = pan the sheet

**Tablet and phone:** the properties panel becomes a drawer (on a phone, a sheet sliding up from the bottom). It opens by itself when you pick an annotation or have text to type, and the panel button in the header opens it at any time. On a phone the tool rail is a bar at the bottom and a family's list opens upwards; Redo, Open, Settings and Keys are in the header's ⋯ menu. On touch screens:
- **two fingers** pan and zoom
- **the point** is placed when the finger lifts, so you can adjust it with snap
- **long press** opens the radial menu

**Original when printing:** colored drawings print pale. There are two options:
- **The whole drawing.** In the Layers tab (or in the export dialog) check "Black lines and text, whole drawing". The original's lines and text become black, including those in blocks (the title block). White stays white and your dimensions do not change.
  - Colored filled areas can become black, gray or stay unchanged.
  - Images (and scans) can become black and white: everything that is not paper becomes black.
  - It shows on screen and is applied on export.
- **Only some lines.** The **Blacken** tool in the Revision group: drag an area and check the objects that become black.

**General keys:**
- Ctrl+K (or *Search* at the bottom of the rail): command search: type a tool's name in Romanian or English, its AutoCAD alias or what it does ("raza", "radius", "DRA", "area", "scale"); ↑ ↓ and Enter run it, settings pages open at their section
- ? or F1: the sheet of all keys and commands by family, with a filter; from there *Change the keys…* and *Show the tips again* (the three tips shown when the first document is opened)
- Ctrl+Z / Ctrl+Y: undo / redo
- Ctrl+C / Ctrl+V: copy the selected annotation / paste it at the cursor
- Ctrl+D: duplicate the selected annotation, offset by 5 mm
- Ctrl+A: select all annotations on the page
- arrows: move the selection by 0.5 mm (with Shift: 5 mm)
- Delete: delete the selected annotation
- Esc: cancel the current operation
- mouse wheel: zoom
- Space + drag, or the middle button: pan the sheet

**Diameter dimensions** always have filled arrows, like the leader, even if you chose open, oblique or dot terminators for other dimensions.

**Circle diameter** (the `DDI` command, like DIMDIAMETER) takes three clicks: the center (with snap ○), a point on the circle, then the text position.
- The arrow sits on the outline and points to the center, and the leader is radial.
- The `Ø…` text is horizontal, on a short shoulder (as on shop drawings).
- If the position is inside the circle, the dimension goes through the center, with arrows at both ends.
- The panel switches between "Text on shoulder" and "Aligned with line", or between radius and diameter. The same "Text on shoulder" style works for radius dimensions too.

The diameter dimension between generatrices remains the **Diameter** tool (`DDL`).

**Editing:** on a selected annotation, the handles move the points and the white circle moves the dimension text along the line. Dragging the body moves the whole annotation.

**Multiple selection:**
- **Shift+click** adds an annotation to the selection or removes it.
- **A rectangle dragged over an empty area** selects:
  - left to right: only what is fully inside;
  - right to left: everything it touches (as in AutoCAD).
- **The selected group** moves by dragging any of its annotations or with the arrows. It is copied, duplicated and deleted together.
- **From the panel** you set the size and layer for the whole group.

**Size:** every selected annotation (dimensions, roughness, GD&T, datum, revision table, etc.) has a white square with a diagonal in its corner. Drag it towards the anchor to shrink or away to enlarge, between 30% and 500%. The panel does the same in its Size section, with the −/+ buttons or the list of sizes. Text, arrows and distances scale; line widths stay. Handles are grabbed in Select only: with a drawing or annotation tool active, a click next to the last object starts a new one, even on its handles (as grips inside a CAD command).

**Multi-line text:** the text, leader and notes fields accept Enter for a new line. For text, the height is picked directly in mm (2.5 / 3.5 / 5 / 7 / 10).

**Dimension text:** as on ISO 129-1 drawings, the value and the arrows go between the extension lines when they fit; if only the value fits, it stays inside and the arrows go outside; if the value does not fit either, it moves next to an arrow and the dimension line extends under it. A new dimension puts that value on the side where it covers no other text or line (for chain dimensions, the values that fit are placed first, then the others around them). If you move the text manually, the "Automatic text" button restores automatic placement.

**Struck dimension (S):** drag a rectangle over the old value and type the new one in the panel. The new value and the revision triangle go next to the struck value on the first free side: after it, above, before or below. To put them elsewhere, drag their square (Select). Several struck values side by side each find their own place.

**Symbols in text:** below the text fields there are buttons for ⌀ ⌴ (counterbore) ⌵ (countersink) ↧ (depth) ± ° × √, for hole and thread callouts like `4× M8 ↧12`.

**Notes (N):** click the top-left corner of the block and type the notes in the panel, one per line. Numbering is automatic and empty lines are skipped. Common notes can be added with one click: chamfers, radii, ISO 2768, heat treatment.

**Images:** the **Image** tool (Annotations family, command `IAT`) asks for a PNG, JPG or WebP file, then you drag its rectangle: the proportions are kept (Shift: free), a single click places it 50 mm wide. **Ctrl+V** pastes an image copied to the clipboard (a screenshot, a logo) at the cursor. Move it by dragging its inside, resize it from the corners and edges; the panel turns it by 90°, sets its opacity (100 / 70 / 40 %), restores its proportions or replaces the file. The server keeps a clean copy (decoded and written again, metadata removed, at most 4000 px on the long side). The image goes into the exported PDF at its resolution and stays editable when the export is reopened. In DXF it is an IMAGE entity, with the file next to the DXF in the ZIP.

**Revision cloud (`REVCLOUD`):** in the Revision family; drag a rectangle around the changed area. The outline is made of arcs (small / medium / large in the panel), with the revision triangle at its top-right corner, numbered from the document's revision; drag the corners to resize it. **Cloud on an outline** (`RVCP`) follows any shape: click its corners and close it with Enter, a right click or a click on the first point; its corners stay draggable.

**Highlighter (`HL`):** drag over what needs attention (Shift: a straight line). Green by default, yellow or pink, 3 / 6 / 10 mm wide; the next strokes start with the last color and width. It is transparent and multiplied over the drawing, so the lines and text under it stay readable, on screen and in the PDF (it keeps its color in a black export).

**Comments (`CMT`):** click where the comment goes and type it in the panel (author, date, *Mark resolved*). Comments live on their own layer, **Comments**: shown on screen, never printed. On export they become native PDF notes (the sticky-note icon Acrobat and other readers show, with author and text); the export dialog can leave them out.

**Revision compare (`COMPARE`, `CMP`):** Revision family in the left rail → *Compare revisions*, or Layers tab → *Compare with another revision…*: pick the older revision from your documents or upload it, and the page number in it. The current page (the newer revision) and that page are rendered at the same scale and laid over each other: **red** = only in the older one (removed), **green** = only in the open one (added), gray = in both. A small tolerance keeps anti-aliasing from showing as changes, and *Align automatically* removes an overall shift between two exports. A sheet of another size is stretched to the same size. For an older revision exported at another scale or rotated, check *Align with two points*: click two reference points on the open page (with snap), then the same two on the older revision, which is drawn in red over the page (its points snap to its own corners and ends); the older page is then moved, turned and scaled onto this one, and the toast says by how much. The context bar then shows three views: **Overlay** (the colored differences over the page, with the slider for how strong: 0 = the page alone), **Side by side** (the older revision, aligned, to the left of the open one, both in view) and **Curtain** (the older revision over the open one up to a vertical line: drag the line on the drawing, or the slider, left and right); and ◀ ▶ to step through the changed areas (zoom and a dashed outline), **PDF** to save the comparison with a legend, and Close. With *With the DrawCAD annotations* (on by default) both pages are compared as their exports look: dimensions, struck values, title blocks and images added in DrawCAD count; comments and the faint watermark do not. Rotating, resizing or reordering pages ends the comparison (the overlay would no longer line up).

**Stamps (`STAMP`):** the tool lets you pick a stamp: APROBAT, VERIFICAT, PENTRU EXECUȚIE, PRELIMINAR, ANULAT, COPIE NECONTROLATĂ (in English on drawings in English), or one of your own (kept in this browser, red / green / blue). Click to place it: the word in a double frame, with today's date and your name (Settings) under it. The panel changes the text, color, tilt (0 / ±15°), date and name, keeps it as your own stamp, and puts the word as a faint diagonal **watermark** on every page. Stamps keep their color in an "All black" export.

**QR code (`QR`):** click its top-left corner. It holds the drawing number (taken from a title block, or typed), the revision and its date, and a free line (text or a link); the revision and date update themselves. 15 / 20 / 30 mm; it is drawn with vector squares, so it stays sharp in PDF and DXF. The panel shows what it holds and warns when a module is under 0.4 mm.

**Title block (indicator):** the **Title block** tool (Annotations family, command `TB`) opens the library of title blocks kept in this browser. **New after ISO 7200** makes a 180 × 40 mm block (Drawn / Checked / Approved and the owner, title, material, mass, general tolerances, drawing number, revision, sheet, scale, format, date), with labels in Romanian or English and the company name or a logo (PNG / JPG up to 300 kB). **From the selection** turns lines, texts and an image you drew into a template; fields are written in braces: `{titlu}`, `{nr_desen}`, `{material}`, `{masa}`, `{tol}`, `{autor}`, `{verificat}`, `{aprobat}`, `{firma}`, or any name of your own. **Place on the drawing**, then click the bottom-right corner of the frame (it snaps); the fields are filled in the panel. `{rev}`, `{data}` (the date of the current revision), `{scara}`, `{format}` (A4…A0 from the page), `{foaia}` (sheet n / total) and `{tol}` (the ISO 2768 class from Settings) fill themselves; typing in them overrides the value. Templates move between computers with **Export** / **Import** (`.drawcad-tb.json`). A placed title block keeps its own copy: changing or deleting the template does not change drawings that use it.

**Revision number:** every document has a current revision (Settings → Sheet and revisions), rev 1 at the start. The export writes it into the file name (`_rev1`; a name that already ends in `_rev2`, `-Rev 2`, `_rev.2` keeps its style and gets the new number), into the PDF metadata (Keywords `rev 1`, `/DrawCADRevision`, XMP) and into the editable layer. When you open an exported revision again (the PDF itself, or the document from Recent after an export), the **first change** starts the next revision: rev 2, with a short message; further changes and exports in the same session keep rev 2. Struck values, new revision table rows and the title block use the same number. The number can be set by hand, and the automatic step turned off, in Settings.

**Revision table (E):** click the top-right corner of the title block (it snaps). The table sits above it, right-aligned, with the header at the bottom and the newest revision on top. On creation it is filled in from the struck dimensions: one row for each revision number. The "From struck dimensions" button adds new revisions later. The default name is set in Settings.

**Parts list:** click the top-right corner of the title block. The list sits above it, with the header at the bottom and item 1 next to the header (ISO 7573), one row for each balloon on the drawing. Columns: Item, Description, Qty, Material, Remarks. "From balloons" adds balloons placed later.

**Grab, move, resize:** in Select mode the cursor and a short label show what a click would grab:
- **over an annotation:** its outline lights up and the cursor becomes a move cross;
- **over a handle of the selected annotation:** the handle gets a ring and the label says what it does ("Dimension point", "Dimension line position", "Move dimension text", "Leader elbow"…);
- **over a resize corner:** the white corners of the dotted box, with a resize arrow;
- **over a box edge:** the resize arrow, as in Windows.

While dragging, the label shows the value: the Δx/Δy offset, the resize percentage, the new dimension or the box size.

**Removals show directly in the editor:** the page is rendered with the removals applied, exactly as in the exported PDF; only the red outline of the area remains.

**Boxes (covers, removals, blackening, struck dimensions, drawn rectangles):** as with Windows windows, the cursor becomes a resize arrow on the edges and corners; drag an edge and the box grows or shrinks, with snap.

**The GD&T frame (G):** the first click is the arrow point, the second the frame position, on any side: to the right of the feature the frame starts at the click, to the left it ends there, above or below it is centred on the click; dragging the frame's square to the other side turns it round. A new frame starts like the last one on the drawing (characteristic, value, modifiers, datums); the first is a flatness frame. Ø is off by default and only available where the zone can be cylindrical (straightness, parallelism, perpendicularity, angularity, position, coaxiality). The leader has a handle at its elbow: drag it anywhere to bend the leader at any angle; "Automatic elbow (90°)" in the panel returns to the default.

**Datum on a frame (B):** the frame's edges snap, so a datum triangle can sit on a GD&T frame (ISO 1101); it stays on the frame when the frame moves. Dimension lines, leaders and other lines of the annotations snap too (nearest, perpendicular, intersection), so a datum or a GD&T arrow can sit on a dimension line added in DrawCAD.

**Layers:** in the Layers tab, the eye next to each layer (Original, Added, Revisions, Deletions) hides it on screen only, for checking; the export contains everything.

**Roughness (Q):** click twice at the same point for a symbol directly on the surface, or click a second time elsewhere for a symbol with a leader. A direct symbol can sit above the surface or to its left; for surfaces seen from below or from the right, ISO 1302 requires a leader.

**Ordinate dimensions** (the `DOR` command, like DIMORDINATE): distances from a base point, without dimension lines, as in the drawing of a plate with holes.
1. Click the base (it gets the value 0), then each point to dimension, with snap.
2. Press Enter or right click: the cursor now places the row of values.
3. Click below or above the points for X values (vertical lines, text read from below), or to the left or right for Y values (horizontal lines). X and Y are done as two separate commands.

The values are absolute distances from the base, in real mm (at drawing scale). Measured on a PDF or a scan they are rarely round (10,04, 25,01…), so the panel offers both:
- **Rounding** of all measured values: exact, 0,1, 0,5 or 1 mm;
- **the values themselves**, one small field per dimension in drawing order, filled with the value as drawn: correct only what is wrong (e.g. the decimals). Changed fields get an orange border, Tab moves to the next one, and an emptied field goes back to the measured value.

Points with the same value appear once. Values too close to each other spread apart and their lines get a jog, as in AutoCAD. In the panel you can switch the axis; dragging the handle at the end of the lines moves the row.

**Chain and baseline dimensions** (`DCO` / DIMCONTINUE and `DBA` / DIMBASELINE): several linear dimensions at once.
1. Click the points to dimension, with snap. For a baseline series the first point is the base all dimensions start from.
2. Press Enter or right click, then click the position of the dimension line: below or above the points for horizontal dimensions, to the left or right for vertical ones.

**General tolerances (ISO 2768-1):** in Settings → Sheet and revisions pick the class (f, m, c, v) and, for the text only, the ISO 2768-2 letter (H, K, L). A dimension without its own tolerance then shows in the panel the deviation that applies to it, with its range, for example *±0,3 mm · ISO 2768-mK · 30…120 mm*; **Write on the dimension** turns it into a ± tolerance written on the drawing. Linear dimensions and diameters use Table 1, radii Table 1 or, with *Broken edge / external radius*, Table 2; angles use Table 3 by their shorter side, written in degrees and minutes (±0°30'). Below 0.5 mm, and where the standard has no value (f over 2000 mm, v up to 3 mm), the panel says so. The `{tol}` field of the title block and the default note follow the class.

A chain puts the dimensions end to end on one line, in order along the axis whatever order the points were clicked in. A baseline series starts every dimension from the base: the shortest one goes where you clicked, the longer ones are stacked outwards (7 mm apart, more with large text). Points at the same position along the axis are counted once. The result is ordinary linear dimensions, each editable on its own (tolerance, fit, value), and the whole series is undone in one step.

**Hole table** (the `HT` / `HOLETABLE` command): a table with X, Y and Ø of every hole, made from the ordinate dimensions of the page.
1. Dimension the holes with `DOR` from one base, on X and on Y (snap to the hole centers).
2. Start the hole table and click where its bottom-right corner goes.

X and Y are signed distances from the base (left of or below the base: negative), with the values typed over the measured ones in the ordinate dimensions. Ø is read from the smallest circle centered on the hole (for a counterbore, the through hole; for a thread, the tap drill: type `M8` over it). Holes of the same diameter share a letter (A1, A2…, B1…), written next to each hole on the drawing; on a scan, without circles, the holes are numbered 1, 2, 3… and Ø is typed by hand. Points without a circle (edges) are left out as soon as some points are holes; the base is a hole only if a circle is centered on it. With several sets of ordinates on the page, select one before starting: its base decides which holes are listed.

Every cell can be edited in the panel. **Update from dimensions** rebuilds the table after the ordinate dimensions changed; diameters typed by hand stay. Moving the table leaves the letters on the holes; they can be hidden in the panel.

**Angular dimension (U):** click the vertex, a point on each leg, then the arc position. The arc position picks one of the four sectors: the angle, its supplement or their opposites.

**Drawing:**
- **Line (I):** start → end; the next line starts at the end of the previous one, like LINE in AutoCAD. Esc or Enter stops the chain.
- **Polyline (P):** click each vertex; Enter, double click or Esc finishes. Clicking the first point closes the outline.
- **Rectangle (J), Circle (Y):** two clicks; the exact width, height or diameter can then be typed in the panel. After the first corner of a rectangle, digits typed at the cursor are its length on X, Tab goes to its width on Y, Enter places it (as AutoCAD's RECTANG): the cursor's side decides which way each goes, and a value left empty follows the cursor.
- **Arc (Z):** center → start → end. The direction is the one in which you move the cursor after the second click; "Complementary arc" in the panel flips it.
- **Center mark:** the center (snap ○) → a point on the circle. The chain lines extend past the outline by 3 mm (2 / 3 / 5 mm in the panel) and cross on dashes.
- **Break:** the ends of the line; a zigzag in the middle or wavy (from the panel), thin line type 01.1.
- **Snap on what you drew:** endpoints, midpoints, centers, circle quadrants and intersections, including with the PDF geometry.
- **Hatch:** click the vertices of the sectioned area, with snap on the outline; Enter or a click on the first point finishes. The angle (45°, 135°…), the spacing and the cross-hatched variant are picked in the panel.
- **Line type and width** are picked in the panel before drawing (with the tool active) or afterwards, on the selected shape. There are ISO 128-24 presets too: visible outline 0.5, hidden outline, center line, adjacent parts, etc. The last choice stays the default.
- **The line pattern** follows the ISO 128-20 lengths (dash 12d, long dash 24d, gap 3d) and is fitted to the length of each line so it starts and ends with a dash. "Pattern scale" enlarges it for large drawings.

**Views:**
- **Section:** the ends of the section plane → a click on the side you are looking towards. It is drawn as a thin chain line, thick at the ends, with arrows and letters (A, B, C…, no I, O, Q). The handle in the middle flips the arrows.
- **Detail:** the center of the area → the radius; the next letter goes next to the circle and can be moved.
- **Label:** proposes "A–A" for the first unlabeled section, then "B (2:1)" for details. The "Add label" button in the section or detail panel does the same.
- **Balloon:** a point on the part → the circle position; numbers increase automatically. From the panel: circled or on a line, ending with a dot (inside the part) or an arrow (on the outline).
- **Measure (M):** two points with snap; shows the distance, Δx, Δy and the angle, at drawing scale. Option **Area** (`A`): click the corners of an outline one after the other (snaps and typed points work); a click on the first point, `C` or Enter closes it and shows the area in mm² (and cm² from 10 000 mm²) and the perimeter in mm, at drawing scale, also in the F2 history. Then `O` (**Object**) measures a closed drawn shape with one click: rectangle, circle, closed polyline or hatch. Nothing is added to the drawing.

**Removal from the original:** after you drag the area, the dialog shows the objects found and a before/after preview. There are four modes:
- **Cover area** (default): a filled rectangle over the area, without removing anything from the file. The color is white, but you can change it: pick from the palette, take a sample with the "Eyedropper" directly from the "Before" preview or, in Chrome/Edge, from anywhere on screen. That way the cover matches the background of a colored or scanned drawing.
- **Select objects:** check exactly what is removed. Objects at least 90% inside the area (line length, text area) are checked from the start, and so are small letters with their center in the area, even if a tail sticks out (g, p, y in AutoCAD texts exported as lines). The list shows the percentage for each one. "Check everything touching the area" checks them all.
- **Text only:** removes the values; dimension lines stay.
- **Everything in area:** removes what is inside the area and cuts the lines passing through it exactly at the area's edge (the outline stays, with a gap; arcs and circles are cut the same way). What cannot be cut (filled areas, images, objects inside blocks) can be covered with white: the "Cover the area with white" option is checked automatically when needed.

**Export by pages:** for a multi-page document, the export dialog offers all pages (default), only the current page, or a list ("1, 3-5"). The "Each page as a separate PDF" checkbox downloads a ZIP archive with one PDF per page (`name_p1.pdf`…). Each file carries the editable layer only for its own pages, so it reopens correctly.

**Annotation list:** the Annotations tab of the panel lists the page's annotations with their values; the field filters by type or value and the chips by kind. Click = select and center, the bin = delete. **Shift+F** zooms to the selection, **double click** on an annotation puts the cursor straight into the field to edit. In the header, next to the document name, you can see whether changes are saved on the server. On a network error, saving is retried automatically.

**Closing and keeping documents on the server:**
- **The ✕ button** next to the document name closes it and returns to the start page.
- **Without unexported changes**, the document closes right away. Otherwise you are asked:
  - **Export PDF and close:** save the PDF to your computer, then the document closes;
  - **Close without export:** the work stays on the server and you reopen it from Recent;
  - **Close and delete from server.**
- **Saving to the server** is automatic, on every change, and also happens when the tab closes.
- **How long documents stay on the server:** `DRAWCAD_RETENTION_DAYS` days (30 by default) after the last use; opening a document resets the countdown. Cleanup runs at startup and then every 6 hours.
- **In Recent** you see how many days each document has left. The bin button deletes it immediately.
- **PDFs exported to your computer** are not affected by this cleanup.

**Reopening:** a PDF exported with the editable layer can be reopened. The dimensions come back editable and the original is recovered from the file, so nothing gets drawn twice.

### Pages: rotate, reorder, delete

Next to the page tabs, in the context bar, there are two buttons, ⟲ and ⟳, that rotate the current page by 90° (the `ROTL` / `ROTR` commands). The third button (or the `PAGES` command) opens the **Pages** dialog. There you see thumbnails and, for each page:
- rotate left / right;
- move before / after;
- delete (asks for confirmation if the page has annotations).

All pages can be rotated at once from there too (90° or 180°).

- **The export keeps rotation and order** (PDF and DXF). The uploaded file stays unchanged on the server; order and rotation are stored separately and applied on render and export.
- **Dimensions and other annotations rotate with the page.** A horizontal dimension becomes vertical and measures the same, texts rotate, and tables (revisions, parts list) stay horizontal, moved to the matching place.
- **Ctrl+Z undoes a page operation** like any other change (rotation, deletion, order, sheet size), with the annotations as they were; Ctrl+Y does it again. A deleted page comes back, because the uploaded file is never changed.
- **OCR** is remembered for each orientation of the page.

### Sheet size (scans and photos)

Dimensions and texts have their size in mm relative to the sheet (3.5 mm text, 3 mm arrows). For an image, the sheet size comes from the DPI. Photos and screenshots often have a default of 72 or 96 DPI. That way, an A3 drawing photographed at 3300 px would end up on a 1.16 m sheet, and dimensions would look tiny.

- **On opening:** if the image has a low DPI (≤ 96) and the sheet would be larger than A1, it is brought to A3. A DPI given explicitly in the open dialog takes precedence.
- **For a document already open:** in **Pages** pick "Sheet: A4 / A3 / A2 / A1 / A0" (or 50% / 200%). The Layers tab warns you when an image's sheet is unusually large. Existing dimensions stay on the drawing and the calibrated scale is adjusted, so measured values do not change. The export keeps the new size.

### Zoom

Zoom goes up to 3000%. Above the resolution of the whole-page render (~12 MP), the server renders only the visible area, at screen resolution. Lines stay sharp at any magnification, and the area reloads by itself when you pan.

### Language

The interface is in Romanian or English: pick it in **Settings** or on the start page; by default it follows the browser language. Separately, for each document, **Settings → Sheet and revisions → Language of drawing texts** picks the language of the table headers (Rev. / Modificare / Data / Nume or Rev. / Description / Date / Name, Poz. / Denumire / Buc. or Item / Description / Qty) and of the default notes. New documents start with the interface language (in English, with a decimal point too).

### Text, search and OCR

The **Text** button in the header (or **Ctrl+F**) searches the drawing's texts: the real ones in the PDF and those recognized by OCR. The search ignores spaces and diacritics, so "ø25" finds "Ø 25". Clicking a result goes to its page, zooms on the area and frames it in orange.

**OCR (text recognition):** "Recognize page" reads the text from the page image with Tesseract (Romanian + English). It is useful for scanned drawings and for AutoCAD PDFs with SHX fonts, where text is drawn as lines. A page usually takes 5–30 s. The result stays on the server, so it is not redone on reopening.

For drawings, OCR does a few extra steps:
- straightens a skewed scan first;
- removes long lines (borders, dimension lines) so they do not stick to the letters;
- reads the page a second time rotated, for vertical dimensions;
- corrects Ø misread as "O", "0" or "@".

The "Show recognized text on the drawing" checkbox draws the boxes of the found text: green for reliable readings, orange for those to check. "Copy page text" puts all the text on the clipboard.

**Searchable PDF:** in the PDF export, the "Invisible recognized text (OCR)" checkbox puts the recognized text over the image, invisibly. In the resulting PDF the text can be searched and copied, as in a vector PDF.

### Opening DXF and DWG

Open a `.dxf` (ASCII or binary, any version) or a `.dwg` like a PDF: from the start page, by dragging it onto the window, or with Open. A DWG is first converted to DXF by LibreDWG (`dwg2dxf`), shipped in the Docker image and the Windows app; where it is missing, the server says so and a DXF opens as usual.

How the pages are made:
- **paper-space layouts** with something on them: one page per layout, at the layout's paper size; the drawing scale is the scale of the layout's first viewport (a 1:2 viewport → scale 1:2);
- **model space only**: the drawing is fitted on an ISO sheet with a 10 mm margin, at a standard scale: a small part is enlarged on A4 (10:1, 5:1, 2:1), otherwise 1:1 on the smallest sheet it fits (A4 … A0), a larger drawing is reduced (1:2, 1:5, 1:10 …). A few entities lost far away (a point kilometres off) do not shrink the drawing: they are left off the sheet;
- **a DXF exported by DrawCAD** opens on its own page, at its own scale (DrawCAD writes both in the DXF header).
- **a sheet drawn in model space** (SolidWorks, Solid Edge and others export their drawing sheet there, often scaled to the drawing: an A4 at 2:1 comes as a half-size frame around real-size views): when a rectangle of an ISO size (A6 … A0) at a standard scale surrounds the drawing, that sheet is the page, edge to edge, and its scale is the drawing scale. When the frame could be two sizes (A6 at 1:1 or A4 at 2:1), the text heights decide (2.5 … 5 mm on paper).
- **a DWG / DXF saved from Inventor** keeps its views, border and title block in blocks placed by Inventor's own objects, which only Inventor's object enabler reads (AutoCAD without it shows an empty sheet too). DrawCAD places these blocks again: the border, title block and notes on the sheet, each view centred in the frame Inventor left for it, at its scale. The DXF export then has them as ordinary blocks.

The opening message says which pages were made and at what scale. The page tabs carry the layout names (Model, Sheet, Plansa 1…), and **each layout keeps its own drawing scale**: going to another tab switches the scale with it (Layers → Drawing scale), so dimensions measure real sizes on every sheet. A scale set by hand (typed or calibrated) stays with the page it was set on.

**Layers of the drawing:** Layers → *Layers from DXF / DWG* lists the drawing's layers, with their color and how many objects each has. The eye hides a layer: it is left out of the page, the snap, the text search and every export (in the DXF of the original drawing it is only turned off, so it is one click away in CAD). As in CAD, what a block or a dimension draws on layer 0 belongs to the layer of the block or dimension. *Show all* brings them back.

The drawing is plotted as with a monochrome plot style: every color black (yellow or cyan lines would be unreadable on paper), white wipeouts kept; Layers → *Colors* → *The drawing's colors* plots it again in its own colors (and back). Line weights come from the drawing (0.25 mm where not set). Texts are real text: searchable with Ctrl+F, copied with the page text, snapped at their insertion point. A TrueType font found on the machine (Arial on Windows, say) is used and embedded; SHX fonts (romans, isocp, txt…), which are not available outside AutoCAD, and fonts missing on the machine are drawn in osifont (ISO 3098). Lines, arcs and circles snap like on any vector PDF.

**Export:** PDF as for any drawing. **DXF** offers two choices:
- **The original DXF / DWG drawing** (default): the DXF itself, every entity, layer, block and layout unchanged, with the DrawCAD dimensions and annotations on their layers (DRAWCAD-COTE…), in the space the page shows (the layout's paper space, or model space in the drawing's units). What was removed in DrawCAD is deleted from the DXF: an entity whose objects were all removed is deleted; one only partly removed (a block, a line cut by a zone) stays and the zone is covered by a wipeout. A DWG comes out this way as DXF of the same version. Images placed in DrawCAD come next to the DXF, in a ZIP;
- **Rebuilt from the page**: the generic export below, as for a PDF.

Pages turned in the editor keep the annotations where they were drawn on the drawing. DXF R12 files cannot take the annotations: save them as DXF 2000 or newer.

Limits: `DRAWCAD_MAX_DXF_ENTITIES` (default 400 000) counts entities with blocks expanded, so a drawing whose few blocks stand for millions of lines is refused; a DWG conversion longer than `DRAWCAD_DWG_TIMEOUT` (90 s) is stopped.

### DXF export

In the export dialog pick **DXF**. Each page becomes one DXF file (AutoCAD 2010, millimeters); several pages come out in a ZIP archive.

What it contains:
- **the PDF geometry** (layer PDF-GEOMETRIE): lines and outlines as polylines, with fillets as true arcs (bulge); circles as CIRCLE, arbitrary curves as SPLINE; line weights, colors and dashed lines (a line type generated from the PDF pattern) are kept;
- **fills** as solid hatches (PDF-UMPLERI);
- **texts** as TEXT (PDF-TEXT), with the ISOCPEUR style;
- **DrawCAD dimensions and annotations** (DRAWCAD-COTE, DRAWCAD-REVIZIE); white covers become WIPEOUT; the highlighter (DRAWCAD-MARKER, a wide polyline with transparency), stamps (DRAWCAD-STAMPILE, in their color) and the watermark (DRAWCAD-FILIGRAN, transparent) have their own layers;
- **images placed in DrawCAD** (DRAWCAD-IMAGINI) as IMAGE entities: the files go next to the DXF, so the export becomes a ZIP; keep them in the same folder when opening the DXF;
- **the page border** (PAGINA).

Objects removed from the original are missing from the DXF too.

**Scale:** "Paper size (1:1)" gives the drawing 1:1 with the sheet. "Real size" uses the calibrated scale (K): a 1:2 drawing comes out twice as large, so dimensions measured in CAD are the real ones.

**Scans (experimental):** on a scanned page the export does four things:
- runs OCR, if it has not been done yet;
- removes the confidently read text from the image and adds it as TEXT (OCR-TEXT);
- vectorizes the rest (SCAN-VECTORI): thinning to one pixel, line tracing, circles and arcs fitted on the pixels, fillets tangent to the lines, the scan straightened and nearly horizontal / vertical lines aligned;
- optionally, adds the image as a background (IMAGE + PNG in the ZIP), for comparison.

The result is a starting point, not a clean drawing:
- dashed lines come out as short segments;
- arrows and hatches come out simplified;
- text read with low confidence stays drawn as lines.

Check the important dimensions.

## Modes: personal or for work

`DRAWCAD_MODE` decides who sees which documents:

| Mode | Who sees the documents | Suited for |
|---|---|---|
| `private` (default) | only the browser that uploaded them (secret cookie, 1 year) | work, several colleagues on the same server |
| `personal` | anyone opening the app, from any browser | a single user: at home, on Unraid; continue on another computer with nothing extra |
| `session` | only the browser that uploaded them, until it closes | shared computers; nothing stays visible after closing |

In `private` and `session`, a document of another browser does not appear in Recent and cannot be opened, rendered or deleted, even if someone knows its address: the server answers as if it did not exist. To continue on another computer, copy the code in **Settings → Workspace** and paste it in the other browser ("Use"). The code works like a key, so do not give it to anyone. Documents uploaded in `personal` mode (or before the modes existed) do not appear in the private spaces; for home-only use set `DRAWCAD_MODE=personal`.

## Security

Uploaded files are treated as untrusted:
- **Isolated reading.** The first read of a file (image decoding, PDF parsing, rendering each page, geometry extraction) happens in a separate process, limited to 3 GB of memory and 120 s. A file built to hang, fill the memory or crash the reading library is rejected, and the server carries on.
- **Active content removed.** JavaScript, automatic actions (on open, on page, on fields), links that start programs or open other files, form submission, attached files, multimedia annotations and XFA forms are stripped from the PDF. Ordinary web links stay. The drawing does not change and exports come out clean. On opening, a message lists what was removed.
- **Limits:** file size (`DRAWCAD_MAX_UPLOAD_MB`, read as a stream, never held fully in memory), number of pages (`DRAWCAD_MAX_PAGES`), megapixels per image (`DRAWCAD_MAX_IMAGE_MPX`, protects against "decompression bombs"), page size and the size of the data received on export.
- **Browser.** A strict Content-Security-Policy (only the app's scripts, no `eval`), `nosniff`, no referrer and no framing by other sites. Data-changing requests coming from another site are refused, so a foreign page open in the browser cannot upload or delete documents.
- **Container:** runs as an unprivileged user, with `no-new-privileges`, without capabilities beyond those needed to prepare the `/data` folder, with a read-only filesystem (writes only to `/data` and `/tmp`) and a limited number of processes.
- **Access:** the app has no accounts; it is meant for the local network. If you make it reachable from outside, put it behind a reverse proxy with HTTPS and set `DRAWCAD_PASSWORD` (user `drawcad`). If the proxy uses another domain than the one in the browser's address bar, add it to `DRAWCAD_ALLOWED_ORIGINS`.

CI checks all of this on the built container (`tools/security_smoke.py`), with a "trojan" test PDF.

## ISO 286 data

The IT tolerances and fundamental deviations (`frontend/js/iso286_data.js`) are taken from TechTools, where they were:
- read from ISO 286-2:2010 (Table 1 and Tables 8, 17–32) and checked against ISO 286-1:2010;
- validated by recomputing all 5907 limit deviations printed up to 500 mm. 5896 match exactly; the other 11 are misprints in ISO 286-2.

The computation follows the rules of ISO 286-1:2010:
- Δ for holes K…ZC in the fine grades;
- the special case M6 at 250–315 mm;
- JS/js = ±IT/2, without the round-to-even of the 1988 edition.

## Architecture

```
frontend/   HTML + ES modules, no build step (canvas 2D, osifont font)
  js/iso286.js   IT tables and fundamental deviations + computation
  js/annots.js   annotation model → drawing primitives (lines, polygons, text)
  js/gdt.js      ISO 1101 symbols
  js/view.js     display, zoom, snap
  js/main.js     the editor object (App): state, start-up; its methods are grouped in js/app/
  js/app/        state.js (history, autosave), mouse.js, keys.js (command line), input.js (typed
                 points), grips.js, edit.js (erase, move, copy, paste), ui.js (rail, panels),
                 contextbar.js, documents.js, review.js, sheet.js, radial.js, util.js
backend/    Starlette
  app/pdfcore.py rendering (PDFium), geometry for snap, objects in an area,
                 object removal, vector overlay (reportlab + pikepdf), attachments
  app/main.py    API + frontend serving, security headers, limits
  app/ingest.py  first read of uploaded files, in a separate, limited process
  app/sanitize.py removal of active content from PDFs (JavaScript, actions, attachments)
  app/ocr.py     OCR with Tesseract: straightening, line removal, horizontal and vertical text
  app/dxfout.py  DXF export (ezdxf): geometry, texts, annotations, layers
  app/dxfin.py   DXF / DWG opening: drawing → vector PDF (ezdxf drawing add-on), pages and scale,
                 the DXF export of the original drawing
  app/vectorize.py vectorization of scans, in a separate process (thinning, graph, arcs, circles)
desktop/    the Windows app: launcher (pywebview), PyInstaller spec, Inno Setup installer
```

The frontend computes the geometry of each dimension once and sends it to the export as primitives. What you see on screen is what comes out in the PDF, with the same font and the same text widths.

**Compared with the initial plan:** PDF.js + PyMuPDF were replaced by PDFium (`pypdfium2`) on the server, for two reasons:
- PDFium gives access to the page objects, which allows removal by object and extracting geometry for snap;
- the libraries' licenses are permissive, while PyMuPDF is AGPL.

**Third-party licenses:**

| Component | License |
|---|---|
| pypdfium2 / PDFium | Apache-2.0 / BSD |
| pikepdf | MPL-2.0 |
| reportlab | BSD |
| img2pdf | LGPL-3.0 |
| Starlette, uvicorn | BSD |
| osifont | LGPL-3 with a font exception |
| ezdxf | MIT |
| NumPy | BSD |
| Tesseract OCR | Apache-2.0 |
| LibreDWG (`dwg2dxf`, run as a separate program to open DWG; GPL text and source link shipped next to it) | GPL-3.0-or-later |
| pywebview | BSD |
| PyInstaller (build only; the bootloader has an exception for distributed programs) | GPL-2.0 with exception |

## Tests

```bash
cd backend && python -m unittest discover -s tests      # API: open, snap, removal, export, reopen
cd frontend && npm test                                 # ISO 286 (42 cases from the tables), dimension geometry
python tools/e2e_smoke.py http://127.0.0.1:8080 out     # browser: full workflow with Playwright
```

`tools/make_sample.py` generates a test PDF similar to a CAD export. It contains a stepped shaft, a title block in a Form XObject, circles and a rotated page.

## Known limitations

- **ISO 286**: letters a–zc for shafts and holes, except t, v and y; grades IT1–IT18; nominal sizes up to 500 mm (not 500–3150 mm).
- **Removal by object** removes whole PDF objects; to cut only part of an outline use "Everything in area". Cutting works only on lines (no fills); filled areas and images that are partly hit stay and can be covered with white.
- **Blocks (Form XObject)**, usually the title block or symbols inserted as blocks, are not modified: PDFium breaks the block's fonts when it changes its content. Their objects show as "in block — cover only" and can only be covered with white.
- **Text exported by AutoCAD with SHX fonts** appears in the PDF as lines, not as text. In the removal dialog it shows as "Line / outline".
- **Symbols, GD&T frames, tables and rectangles turn only by quarter turns.** Texts, stamps, dimensions and drawn shapes turn by any angle.
- **No authentication and no simultaneous editing** of the same document by several users.
- **OCR on drawings** is good on the title block, notes and clear dimensions, weaker on small, crowded text or text touching lines. Tesseract does not know the GD&T symbols, and Ø, ± and ° are recognized only partly (Ø is corrected from context). Uncertain readings show in orange.
- **Vectorization of scans** is experimental. Dashed lines, arrows and hatches come out simplified. On poor-quality scans (below 200 DPI, blots, faded lines) the result needs cleaning up in CAD.
- **Opening DXF / DWG:** what ezdxf does not draw stays out of the page: 3D solids (ACIS), OLE objects, fields not yet updated; proxy entities show their stored graphics. Texts cut by a viewport edge, and texts in fonts that cannot be embedded (OpenType / CFF, font collections), stay as outlines (not searchable). DWG reading is LibreDWG's: very new or damaged files may convert with errors (the message says how many were repaired).
- **DXF:** blocks in the PDF (Form XObject) come out as separate entities, not as blocks. Texts use the ISOCPEUR style: if the font is missing, the CAD program substitutes another one, with a different width.
