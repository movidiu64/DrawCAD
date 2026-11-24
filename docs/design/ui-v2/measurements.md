# UI v2 — measurements

Taken from the mockup sources (`mockup/*.dc.html`), in CSS pixels at 100 % zoom. Sizes are
flexible (README): map each one to the nearest existing size in `app.css` before adding a new one,
and keep neighbours consistent. Borders are 1 px unless stated.

## Editor (1440 × 900)

| Part | Size |
|---|---|
| Header | min height 44, padding 0 10 0 14, gap 10, bottom rule. Brand icon 20, name 14 / 600. Separator 1 × 22. |
| Document chip | height 30, radius 6, padding 0 6 0 10, gap 8, border `--line2`, fill `--raised`; file icon 14; "salvat" 11 px with a 12 px check; close 20 × 20. |
| Search field (`#btnText`) | 280 × 30, radius 6, padding 0 8 0 10, fill `--bg`; icon 14; text 12 px muted; key cap 10 px mono, padding 1 5, radius 4. |
| Icon buttons (header) | 32 × 32, radius 6, icon 18, stroke 1.8. |
| Zoom group | height 30, padding 2, gap 1, radius 6, fill `--raised`; buttons 26 × 26 radius 4; value 12 px mono, min width 46. |
| Export split button | height 32, radius 6; label padding 0 14, 13 px / 600; chevron part 28 wide with a 1 px divider. |
| Tool rail | width 56, padding 8 0; buttons 40 × 38, radius 6, gap 2; icon 20, stroke 1.7. Group divider: 1 px top rule with 6 px padding above and below. Active: 2 px inset bar on the left. Flyout mark: 5 × 5 triangle, 4 px from the bottom-right corner. |
| Context bar | min height 40, padding 0 12, gap 12, bottom rule. Tool icon 18, label 13 / 600, alias chip mono 11 padding 1 6 radius 4, hint 12 px muted with ellipsis. Option buttons height 26, radius 6, mono 12. Page tabs: container padding 2 radius 6 fill `--bg`, tabs height 24 padding 0 10 radius 4, 12 px. Page-operations button 28 × 28. |
| Canvas | padding 24 28 44 around the sheet; sheet shadow `0 10px 30px rgba(0,0,0,.45)`. Legend chip: 14 px from the left, 12 px from the bottom, padding 5 10, radius 6, 11 px, gap 14, dots 8 × 8 radius 2. |
| Panel | width 320, left rule. Tabs: row height 40, padding 0 8, labels 12 / 500; active tab: text `--text` and a 2 px accent line at the bottom. Body padding 14 16 18, 18 px between sections. Footer: padding 8 16, 11 px, top rule. |
| Section label | 11 px / 500, upper-case, letter spacing 0.08em, `--muted`, 10 px above the first field. |
| Selection head | type 11 px upper-case muted; value mono 20 / 500; meta 12 px muted; duplicate and delete buttons 30 × 30. |
| Fields | height 30, radius 6, padding 0 8, fill `--bg`, border `--line`; label 12 px `--text2` 4 px above. Numbers right-aligned, mono. Two fields side by side: gap 8. |
| Segmented control | padding 2, gap 2, radius 6, fill `--bg`, border `--line`; buttons height 26, radius 4, 12 px. |
| ISO 286 limits card | padding 10 12, radius 6, fill `--bg`; rows gap 6, columns gap 12; values mono, right-aligned; rule before max / min. |
| List rows (layers, annotations) | height 32–34, radius 6, padding 0 8; dot 6 (annotations) or 10 radius 3 (layers); selected row: `--accent-tint` with a 2 px inset accent bar. |
| Filter chips | height 24, radius 12, padding 0 9, 11 px; on: accent border, `--accent-tint`, accent text. |
| Status bar | min height 34, padding 0 10, gap 10, top rule. Coordinates mono 11, min width 170. Command field: height 26, radius 6, mono 12, grows (`flex: 1 1 280px`); prompt "›" in accent; "ultima: …" 11 px muted at the right. Toggles: height 24, padding 0 8, radius 4, mono 11, letter spacing 0.04em. |

## Popovers and dialogs (states board, 1280 × 820)

| Part | Size |
|---|---|
| Command suggestions | width 360, padding 4, radius 8, border `--line2`, fill `--panel2`, shadow `0 10px 24px rgba(0,0,0,.45)`. Rows 30 high, radius 5; alias column 96 wide, mono 12, the typed prefix in accent; label `--text2`; key 10 px mono muted. Footer 11 px muted with a top rule. |
| Rail flyout | width 300, padding 6, radius 8, border `--line2`, fill `--panel2`, shadow `0 12px 28px rgba(0,0,0,.5)`. Heading 11 px upper-case muted. Rows 26 high, radius 5, padding 0 8, gap 10: icon 16, label, alias mono 11 muted, key 10 px mono in an 18 px column. Current tool row: `--accent-tint`, accent text. |
| Tooltip | padding 7 10, radius 6, border `--line2`, fill `--panel2`; name 13 / 500 with alias and key mono 11 in accent; hint 11 px muted. |
| Snap menu | width 230, padding 6, radius 8; rows 27 high, 12 px; checkbox, 14 px glyph in `--ok`, label. Footer "F3 …" 11 px muted. |
| Export dialog | width 420, padding 18 20, radius 10, gap 14; title 15 / 600; format control rows 28 high; description 12 px `--text2`; options grid with a 110 px label column, rows 10 apart; footer buttons height 32 (ghost Anulează, primary Exportă PDF / DXF). |

## Start screen (1440 × 900)

| Part | Size |
|---|---|
| Page | content max width 1160, padding 40 28 32, 36 between the top row and the recent list. |
| Drop zone | flexible width (min 520), min height 280, padding 32 24, border 1.5 px dashed `--line3`, radius 12, fill `--panel2`. Icon tile 56 × 56 radius 14 `--accent-tint`, icon 28. Title 20 / 600; text 13 px `--text2`, max width 460; primary button height 36; formats line mono 11 muted. |
| Side card | min 300 wide, padding 20, radius 12, fill `--panel`, border `--line`. Command rows: 64 px mono accent column, 12 px label; 8 px between rows. |
| Recent documents | grid `repeat(auto-fill, minmax(240px, 1fr))`, gap 14. Card radius 10, border `--line`, fill `--panel`; thumbnail area 150 high on `--canvas` with the page centred; name 13 / 500; meta mono 11 muted; footer 12 px with the revision badge (11 px, radius 4, `--bad-bg`, `--bad`). |
