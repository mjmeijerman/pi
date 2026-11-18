---
name: valentina-grading
description: Turn a Valentina pattern (.val + per-size .vit tables) into one seam-only SVG with all sizes, a 1:1 A0 PDF and a self-checking pipeline. Use when generating, checking or fixing multi-size pattern sheets, and before touching measurements in the .vit files.
---

# Valentina grading

Reference implementation: `/home/mark/Downloads/patronen`. Nothing there is a git repo, so read it, run it, and edit it in place.

## Workflow, in this order

```
cd <pattern dir>
python3 valentina_validatie.py <pattern.val> "maat rok 34.vit"   # 0 errors before anything else
python3 maak-alle-maten-svg.py --patroon-json patroon.json
python3 maak-a0-pdf.py --patroon-json patroon.json
python3 controleer-svg.py --patroon-json patroon.json            # RESULTAAT: OK
python3 verifieer-rechtdraad.py --patroon-json patroon.json      # angle + arrow per size
python3 verifieer-splinepunten.py                                # cut points on their curve
python3 valideer-tegen-vlt.py                                    # OK, or INDICATIEF (exit 0) when the .vlt is stale
```

Step 0 is never skipped: never grade, generate or edit a pattern until the validator is clean. Warnings are allowed, errors are not.

CLI flags still work next to the manifest: `--val --vlt --draw --vit --pieces --out --preview --per-rij --note --titel --patroon --patroon-json`, plus `--hulplijnen` (draw construction geometry, off by default) and `--converteer-eenheid` (on the validator).

## References — open only when the question is theirs

- [`references/formats.md`](references/formats.md) — which script computes what, and the `.val` / `.vit` / `.vlt` / `patroon.json` grammar. Open it before parsing or writing a format, or before adding a manifest key.
- [`references/failure-modes.md`](references/failure-modes.md) — the measurement behind each rule below: arc sign, rotation sign, notch direction, grainline derivation, A0 packing, checker 9e, the stale-`.vlt` proof. Open it when a check fails, when a size or piece looks wrong, or before touching engine, notch, grainline, packing or checker code.

## Output rules

- Only finished geometry: seam contours, notches, grainlines, internal lines (`intekeningen`). Construction points and helper lines never reach the sheet; `--hulplijnen` is the exception.
- All lines black. Sizes differ only in dash and width: 34 `0.35` solid, 36 `1.10` solid, 38 `12 3`, 40 `3 2`, 42 `9 2 1.2 2`, 44 `1.2 2.2`. Legend lists exactly those.
- **Style goes on every path**, never on the `<g>` and never as `class`-only (write `class` not `cls`). A group stroke silently overrides per-size styles and the legend then lies.
- `viewBox` and `width`/`height` come from the **real bounding box** of everything drawn — labels, title, legend and note included, plus half the stroke width — not from the piece boxes: that clipped 5.7% off one side. Checker compares `viewBox` with `width`/`height` (0.01 mm).
- 5 × 5 cm calibration block labelled for scale, 50 × 50 mm in the 1:1 frame.
- A0 PDF is A0 (841 × 1189 mm portrait or landscape), 22 mm frame, 1:1 (`2.835 pt/mm`), print instruction on the sheet ("print op 100% – niet schalen"), per-sheet `blad n van m`, a 100 mm scale bar and `geprint op (100%)`. Verify page size (`pdfinfo`) and the scale from a raster of the scale bar, never from the PDF's own claim.
- **The measurement table is a real table**: header row with the full names out of the `.vit` `full_name` attributes (parsed, never hardcoded), one row per size, first column `maat`, order tw/hw/hh/rl, `(mm)` exactly once in the header. Column width from the widest text in the column (`CHAR_W`). Abbreviations (`tw / hw / hh / rl`) on the sheet are the old bug.
- **Every header cell sits on its column's alignment edge**: the values are `text-anchor="end"` at `kolom_x[i] + breedtes[i]`, so each header is drawn the same way at that same right edge. Checker 9e asserts each header lands within 0.1 mm of its column's values and names the column when it fails.
- **The table is ruled like a table, under the text.** `tabel_lijnen()` in `maak-alle-maten-svg.py`: one rule under the header, one under every size row, one vertical separator per column gap (mid-gap, never in a cell), a closed box; stroke `0.2 mm` `#bbbbbb` (`TABEL_LIJN`, `TABEL_LIJN_DIKTE`), every one tagged `data-role="maattabel-lijn"` and appended before the table text so they render underneath. `TABEL_OPKOM = 0.9` / `TABEL_NEERKOM = 0.25` place every rule **between** two text bands; the box's bottom edge is the last row rule.
- **One term per thing**: the grainline reads `recht van draad` both on the line and in the legend row (`GRAIN_LABEL`). Two terms for the same line ("rechtdraad - alle maten" next to a legend row saying something else) is a checker FAIL, not a style choice.
- **No red (#a33) text on a sheet.** Those notes are human documentation: `patroon.json` `note` and the markdown files.

## A0 layout: pack units, never tile the sheet

- **A unit is one thing that must stay whole**: every spec of one piece across all six sizes (`data_piece`) plus that piece's label, the header (`kop`), and the legend block (`legenda`, rect `data-role="legenda-kader"`), which carries the 5 × 5 cm block and the measurement table.
- Pack with first-fit shelves inside the frame, `GAP = 12 mm`, after trying both orientations and three orders (`kop`-then-height, reading order, all by height). Fewest sheets, then fewest used mm.
- Every unit is drawn exactly once, `clip` to its own box, translated by `dx = FRAME + x - box[0]`, `dy = FRAME + y - box[2]`. No scaling, ever: 1:1 is the point. Boxes are `(xmin, xmax, ymin, ymax)` — unpacking them as `x0, y0, x1, y1` draws an empty sheet without an error.
- Split only a unit larger than the drawing window (never a normal piece); then cut/registration marks plus `deel n van m – lijm hier`, strips overlapping 20 mm. `controleer_indeling()` fails a piece that appears twice, once whole and once split, or that is split while it would have fit.
- Write `<pdf>.indeling.json` (pages, units, boxes, placements, square position) and let the checker read it; recomputing the plan proves nothing about the file that got printed.
- Anchors are chosen **per piece** (non-moving edge, waist on top so sizes overlay), never from the bbox of the whole sheet; a bbox fallback must print and be a checker FAIL, not silence.

## Engine conventions that cost a full cycle

- **`Arc.length_total` keeps the sign.** Returning `abs()` of `CurrentLength` moved a `cutArc` point 50 mm to the wrong side and caused a 175° kink. A `simple` arc has no length attribute: build `Arc(center, radius, angle1, radius*radians((angle2-angle1) % 360))`, a near-zero sweep is 360.
- **`rotation` in a `.val` is counter-clockwise in pattern space.** With the opposite sign only the two panels match the `.vlt`; facings are off by tens of mm.
- **`AngleLine_A_B`** follows Qt `QLineF::angle()`: `degrees(atan2(dy,dx))` normalized to [0,360), floored to 5 decimals. The engine frame is the `.val` frame with y negated.
- **`pointOfIntersection` / `intersectXY` is not a line–line intersection**: it takes **x of `firstPoint` and y of `secondPoint`** (`PointIntersectXYTool::Create`). The helper lines are decoration. `pointOfIntersectionCurves`/`...Arcs` are different tools.
- **`Spl_A_B` / `Spl_B_A`** both name the same curve, value = full arc length; register each spline under both names. A 0 means no curve has those endpoints — check for renamed or moved points.
- Formulas in `angle`, `radius`, `x`, `y` must go through the formula evaluator; `float(el.get("angle"))` gives `ValueError` on `AngleLine_A_B+90`. Substitute `AngleLine_` before `Line_` before `Spl_`, each regex with a negative lookbehind `(?<![A-Za-z])`, longest measurement name first (`@tu` before `@t`).
- **Units: cm is the Valentina default.** Read `<unit>` and warn `UnitMismatch` when the scale is not 1.0; with `--converteer-eenheid` only literal x/y are converted. An unread `unit cm` yields a pattern 10× too small with no error.
- **`piece_path` trimming rule.** A curve node is trimmed to the nearest non-excluded node **only when that point lies on the curve**; otherwise the nominal endpoint is used and the piece shows a break. Gaps up to `GAP_TOL_MM = 1.0` are repaired, anything above `GAP_RUIS_MM = 0.05` is reported, and `strict=True` turns a gap into `OpenPath` — use it in production callers.
- Fail loud types to expect: `UnknownNodeType`, `MissingMeasurement`, `UnitMismatch`, `OpenPath`, `UnplaceableFeature`, `InvalidFormula`, `MissingObject`. `vv.meld()` never raises and always downgrades to `"waarschuwing"`; use `with vv.verzamel():` to collect all errors in one run.

## Notches (pastekens)

- The `.vlt` writes every passmark as **two collinear halves**, `builtIn=true` on the seam and `builtIn=false` in the allowance. The halves carry no direction: the inside of the piece does, and the `builtIn=true` half lies inside.
- One 10 mm keep per passmark, `passmarkLength` read from the `.val`, not assumed 10.
- Foot exactly on the seam (0.000 mm), **tip points inward** — proven with a point-in-polygon test on the tip, minimum 10 mm from the seam. Never derive the direction from the winding alone (the signed-area normal breaks on a concave side seam); use the winding then confirm and flip with point-in-polygon.
- A passmark on a curve node, or `passmarkLine != "one"`, or `passmarkAngle != "straightforward"`, must raise instead of being skipped or flattened into one straight keep.
- Verify against the `.vlt` halves with the perpendicular deviation (`1.5 mm` limit).

## Grainline (rechtdraad)

- Source of truth is the `<grainline>` in the `.vlt` (`x1,y1;x2,y2` piece-local px, `3.7795 px/mm`, y-down). Express it as **distance to the piece's own anchor edge plus two y fractions of the height**; store that, not `.vlt` points, which scale with width.
- **Minimum margin 2 mm** (`toleranties.rechtdraad_marge_mm` / `anker_marge_mm`): both ends and 20 intermediate points inside the polygon, never on the contour.
- **Arrow direction: tail on the waist, point at the hem.** `oneWayDown` = apex on the hem end (`p_bot`), `oneWayUp` = apex at the waist, `twoWay*` = an outward point at both ends. 4.5 mm at 22°, say so in the legend. `none` or an unknown value means no arrow, not a guess. Prove the sign geometrically (apex y vs barb y), never from the `data-pijl` label the drawing itself wrote.
- **A horizontal grainline is legitimate** (a waistband): skip the hem test and say so (`niet op zoom-richting te toetsen`), do not demand "points down".
- **The label on the line is `recht van draad`** (`GRAIN_LABEL`), an offset beside the line (3.2 mm), never below 2.6 mm, carrying `data-grainline-label` plus `data-piece` — without `data-piece` every label lands in the legend unit of the A0 layout and that block grows to the whole sheet.
- No fallback by piece name: derive one from the longest straight edge, parallel, at margin, or leave it out with a legend line. Read the angle from the two points; hard-coding `90.0` drew a slanted grain line vertically.
- `verifieer-rechtdraad.py` is the evidence; the measured results and the open `.vlt`-vs-`.val` case are in `references/failure-modes.md`.

## Checker (`controleer-svg.py`)

- Split the checks: **invariants** (closed contours, no self-intersection, nothing outside the viewBox, per-path style, one grainline per piece, keep foot on the seam, 50 mm block, 1:1 scale, page exactly A0) versus **pattern facts from the manifest** (piece count, keeps per piece, expected `.vlt` deviation, anchor side, band pairs).
- **Count per (piece, size), not totals.** "15 keeps" passes while one piece has none. Same for grainlines and arrows: 4 × 6 = 24 lines and 24 arrowheads, per size 4.
- Thresholds and expectations come from `patroon.json`; never from the skirt. A correct trouser must not FAIL on skirt facts (four fixed piece names, six fixed sizes, exactly three keeps, 2+1 split, exactly 90°, exactly 4.5 mm arrows, `2×(voor+achter) = @tw+20`). `verify-maten.py` is skirt-specific by design; do not reuse it as a gate.
- **Per-size measurement check first.** Dump `@Ger` and `@rl` from every `.vit` before reasoning about a size curve: `for f in *.vit; do echo "== $f"; grep -nE 'name="@(Ger|rl)"' "$f"; done`
- **`feit.groei: true` is stricter than it looks.** It demands every piece get strictly wider per size; a constant-width piece (`ondertree` 55 mm, `gulp beleg` 45 mm) fails it on a correct garment. Leave it `false` and write the measured widths in the manifest `note`.
- **`feit.middenrand_vast`** is about the straight run at the anchor edge, not about `@Ger`. Measure before naming a cause.
- `knik_graden = 170` flags sharp corners (a < 10° dart tip, a trouser crotch) as kinks; keep the neighbour-length exception and an explicit override (`feit.kink_limit_mm`) instead of raising the limit until green.
- Edit a `.vit` only after `cp -p "$f" "$f.bak-$(date +%Y%m%d-%H%M)"`, and only the `value` attribute, byte for byte. `@rl` often carries a trailing newline entity (`value="450&#10;"`); dropping it silently changes the file.

## Pitfall: a stale `.vlt` — INDICATIEF, never OK

The `.vlt` is always a valid source for the **grainline points**, and a source for the **contour** only while it belongs to the current `.vit` files. A mismatch is a stale export until proven otherwise: declare it with `feit.vlt_past_bij_vit: false`, and both tools then print `INDICATIEF` with the numbers intact and exit 0 — after **proving** the staleness with `zoek_bron_delta()`, not excusing it. A `.vlt` that cannot be reproduced that way stays **FOUT**, because then it is not merely old. Guard: a run with the flag `false` can never print `RESULTAAT: OK` for the contours; set the flag back to `true` only after a fresh export.

## The rule above all others

**Never guess a convention — take it from the source and test it geometrically.** Angle sign, rotation sign, `pointOfIntersection`, arc sweep, spline handles and notch direction each looked plausible the wrong way round. Read the implementation (Seamly2D `develop`, the `.val` tool classes), then prove the guess with a measurement against the `.vlt` or an invariant; when in doubt the `.vlt` is the truth, unless the `.vlt` contradicts itself — then name the contradiction and both deviations.
