---
name: valentina-grading
description: Turn a Valentina pattern (.val + per-size .vit tables) into one seam-only SVG with all sizes, a 1:1 A0 PDF and a self-checking pipeline. Use when generating, checking or fixing multi-size pattern sheets, and before touching measurements in the .vit files.
---

# Valentina grading

## What this is

Reference implementation: `/home/mark/Downloads/patronen`. Nothing there is a git
repo, so read it, run it, and edit it in place.

| file | what |
|---|---|
| `patroon_context.py` | reads `patroon.json` (manifest), defaults, warnings |
| `valentina_engine.py` | computes `.val` nodes with `.vit` measures → piece polylines |
| `valentina_validatie.py` | fail-loud layer: typed errors, collect mode, CLI |
| `valentina_grainline.py` | grainline from the `.vlt` `<grainline>`, 2 mm margin |
| `valentina_notches.py` | passmark → 10 mm notch, tip inside, foot on the seam |
| `maak-alle-maten-svg.py` | generator: SVG (1 mm = 1 mm) + preview PNG |
| `maak-a0-pdf.py` | A0 1:1 PDF, packed **per piece** (no cut pieces) + `*.indeling.json` |
| `controleer-svg.py` | checker, ends in `RESULTAAT: OK` |
| `verifieer-rechtdraad.py` | per piece × size table: drawn angle, source, source angle, arrow end |
| `valideer-tegen-vlt.py` | engine vs. `layout <maat>.vlt` per piece, mm |
| `verifieer-splinepunten.py` | every `cutSpline`/`cutArc` point lies on its curve |

Formats:

- **`.val`** — Valentina project XML. Points (`single`, `endLine`, `alongLine`,
  `normal`, `lineIntersectAxis`, `cutSpline`, `cutArc`, `pointOfIntersection`),
  splines (`simpleInteractive`), arcs (`arcWithLength`, `simple`), `line`
  helper elements, `rotation` operations (with `source`/`destination` `idObject`
  lists), details with `nodes` (`NodePoint`/`NodeSpline`/`NodeArc`,
  `reverse`) and `passmark="true"` nodes. Coordinates are in the `<unit>`;
  the frame is **y-down**.
- **`.vit`** — `body-measurements` as `@name` with formulas per size.
- **`.vlt`** — export of one size, screen coordinates at **3.7795 px/mm**,
  y-down. `seamLine` points are child `<point>` elements per piece, **not** a
  text payload. Carries `<grainline>` (`x1,y1;x2,y2` piece-local px,
  `arrowDirection`) and `<notch>` elements with `builtIn` true/false.
- **`patroon.json`** — one per pattern, only pattern facts. Required keys
  `val`, `draw`, `vlt`. Optional `maten`, `maattabel` (`maat rok %d.vit`),
  `svg`, `pdf`, `titel`, `onderdelen` (`{"anker": "min|max", "rechtdraad":
  "val|uit"}`), `banden` (rows side by side), `intekeningen`, `feit`
  (`details_aantal`, `keeps_per_deel`, `rechtdraad_aantal`,
  `vlt_past_bij_vit`, `groei`), `toleranties` (`vlt_mm`, `schaal_mm`,
  `invariant_mm`, `knik_graden`, `rechtdraad_marge_mm`), `anker_marge_mm`,
  `note`. Without a manifest the generator falls back and prints its choices.

## Workflow, in this order

```
cd <pattern dir>
python3 valentina_validatie.py <pattern.val> "maat rok 34.vit"   # 0 errors before anything else
python3 maak-alle-maten-svg.py --patroon-json patroon.json
python3 maak-a0-pdf.py --patroon-json patroon.json
python3 controleer-svg.py --patroon-json patroon.json            # RESULTAAT: OK
python3 verifieer-rechtdraad.py --patroon-json patroon.json      # angle + arrow per size
python3 verifieer-splinepunten.py                                # cut points on their curve
python3 valideer-tegen-vlt.py                                    # only if the .vlt is current
```

Step 0 is never skipped: never grade, generate or edit a pattern until the
validator is clean. Warnings are allowed, errors are not.

CLI flags still work next to the manifest: `--val --vlt --draw --vit --pieces
--out --preview --per-rij --note --titel --patroon --patroon-json`, plus
`--hulplijnen` (draw construction geometry, off by default) and
`--converteer-eenheid` (on the validator).

## Output rules

- Only finished geometry: seam contours, notches, grainlines, internal lines
  (`intekeningen`). Construction points and helper lines never reach the sheet;
  `--hulplijnen` is the exception.
- All lines black. Sizes differ only in dash and width: 34 `0.35` solid, 36
  `1.10` solid, 38 `12 3`, 40 `3 2`, 42 `9 2 1.2 2`, 44 `1.2 2.2`. Legend lists
  exactly those.
- **Style goes on every path**, never on the `<g>` and never as `class`-only
  (write `class` not `cls`). A group stroke silently overrides per-size styles
  and the legend then lies.
- `viewBox` and `width`/`height` come from the **real bounding box** of
  everything drawn, including half the stroke width, labels, title, legend and
  the note — not from the piece boxes. A viewBox from piece boxes clipped 5.7%
  off one side. Checker compares `viewBox` with `width`/`height` (0.01 mm).
- 5 × 5 cm calibration block labelled for scale, 50 × 50 mm in the 1:1 frame.
- A0 PDF is A0 (841 × 1189 mm portrait or landscape), 22 mm frame, 1:1
  (`2.835 pt/mm`), print instruction on the sheet ("print op 100% – niet
  schalen"), per-sheet `blad n van m`, a 100 mm scale bar and
  `geprint op (100%)`. Verify page size (`pdfinfo`) and the scale from a
  raster of the scale bar, never from the PDF's own claim.
- **The measurement table is a real table**: header row with the full names out
  of the `.vit` `full_name` attributes (parsed, never hardcoded), one row per
  size, first column `maat`, order tw/hw/hh/rl, `(mm)` exactly once in the
  header. Column width comes from the widest text in the column (`CHAR_W`), so
  values sit under their own header and headers never overlap the next column.
  Abbreviations (`tw / hw / hh / rl`) on the sheet are the old bug.
- **Every header cell sits on its column's alignment edge.** The values are
  `text-anchor="end"` at `kolom_x[i] + breedtes[i]`, so each header is drawn the
  same way, at that same right edge. Drawing a header at `kolom_x[i]` with the
  default start anchor
  made it hang ~50 mm (about one column gap, `KOLOM_GAT_MM = 7`) left of its
  own numbers — the eye followed the header and landed in the wrong column.
  Checker 9e asserts `|header_right - column_value_right| <= 0.1 mm` per column
  and names the column when it fails.
- **The table is ruled like a table, under the text.** `tabel_lijnen()` in
  `maak-alle-maten-svg.py` computes: one rule under the header row, one under
  every size row, one vertical separator per column gap (mid-gap, never in a
  cell) and a closed box around the whole table. Stroke `0.2 mm` `#bbbbbb`
  (`TABEL_LIJN`, `TABEL_LIJN_DIKTE`) so the rules never compete with the 1:1
  pattern lines, every one tagged `data-role="maattabel-lijn"`, appended
  before the table text so they render underneath. `TABEL_OPKOM = 0.9` and
  `TABEL_NEERKOM = 0.25` (per font size) place every rule **between** two text
  bands: the header rule clears the descenders of `heuphoogte`, the row rules
  sit in the free 3.5 mm strip between 8 mm rows of 5 mm text. The box's bottom
  edge is the last row rule, so the table closes under its last row instead of
  leaving a 2.5 mm strip below it. Checker 9e asserts the rules exist inside
  the legend box, that the box stays clear of the 5 × 5 cm block, and that no
  text bbox crosses a rule or the box (`FAIL` names the rule coordinate and the
  text).
- **One term per thing**: the grainline reads `recht van draad` both on the
  line and in the legend row (`GRAIN_LABEL`). Two terms for the same line
  ("rechtdraad - alle maten" next to a legend row saying something else) is a
  checker FAIL, not a style choice.
- **No red (#a33) text on a sheet.** The notes that used to be printed in red
  are human documentation: `patroon.json` `note` and the markdown files.

## A0 layout: pack units, never tile the sheet

Blind tiling the whole sheet (20 mm overlap, row/column marks) cut pieces in
half even when they easily fit and printed the same fragment twice: 3 snippets
on 2 sheets for the skirt, 5 on 2 for the spijkerrok. Unusable for a plotter.

- **A unit is one thing that must stay whole**: every spec of one piece across
  all six sizes (`data_piece`) plus that piece's label, the header (`kop`),
  and the legend block (`legenda`) — the legend carries the 5 × 5 cm block and
  the measurement table. The legend rect carries `data-role="legenda-kader"`,
  which is how checker 9e proves the table's rules stay inside the legend. The
  red note block is gone from the sheet: those
  notes live in the `note` blocks of `patroon.json` and in the markdown docs.
- Pack with first-fit shelves inside the frame, `GAP = 12 mm`, after trying
  both orientations and three orders (`kop`-then-height, reading order, all by
  height). Pick fewest sheets, then fewest used mm. Result: both patterns on
  **one** landscape A0, 0 snippets.
- Every unit is drawn exactly once, `clip` to its own box, translated by
  `dx = FRAME + x - box[0]`, `dy = FRAME + y - box[2]`. No scaling, ever: 1:1
  is the point of the sheet.
- Split only a unit that is larger than the drawing window (never a normal
  piece); then cut/registration marks plus `deel n van m – lijm hier`, strips
  overlapping 20 mm. `controleer_indeling()` fails a piece that appears twice,
  once whole and once split, or that is split while it would have fit.
- Write `<pdf>.indeling.json` (pages, units, boxes, placements, square
  position) and let the checker read it. Recomputing the plan in the checker
  proves nothing about the file that got printed.
- Boxes are `(xmin, xmax, ymin, ymax)`. Unpacking them as `x0, y0, x1, y1`
  silently collapsed every clip rect and drew an empty sheet — the whole title
  block vanished without an error.
- Anchors are chosen **per piece** (non-moving edge, waist on top so sizes
  overlay), never from the bbox of the whole sheet; a bbox fallback must print
  and be a checker FAIL, not silence.

## Engine conventions that cost a full cycle

- **`Arc.length_total` keeps the sign.** `CurrentLength` is signed; returning
  `abs()` moved a `cutArc` point 50 mm to the wrong side of the arc and caused
  a 175° kink. A `simple` arc has no length attribute: build
  `Arc(center, radius, angle1, radius*radians((angle2-angle1) % 360))`, a
  near-zero sweep is 360.
- **`rotation` in a `.val` is counter-clockwise in pattern space.** With the
  opposite sign only the two panels match the `.vlt`; facings are off by tens
  of mm.
- **`AngleLine_A_B`** follows Qt `QLineF::angle()`: `degrees(atan2(dy,dx))`
  normalized to [0,360), floored to 5 decimals. Horizontal right = 0, straight
  up on the printed sheet = 90 (math convention, not 270). The engine frame is
  the `.val` frame with y negated.
- **`pointOfIntersection` / `intersectXY` is not a line–line intersection.** It
  takes **x of `firstPoint` and y of `secondPoint`**
  (`PointIntersectXYTool::Create`). The helper lines in the visual are
  decoration. `pointOfIntersectionCurves`/`...Arcs` are different tools.
- **`Spl_A_B` / `Spl_B_A`** both name the same curve, value = full arc length.
  Register each spline under both names. `Spl_A68_A4` evaluating to 0 means no
  curve has those endpoints — check for renamed or moved points.
- Formulas in `angle`, `radius`, `x`, `y` must go through the formula
  evaluator; `float(el.get("angle"))` gives `ValueError` on
  `AngleLine_A_B+90`.
- Formula substitution order: `AngleLine_` before `Line_` before `Spl_`, each
  regex with a negative lookbehind `(?<![A-Za-z])`. Without it `Line_A4_A58`
  matches inside `AngleLine_A4_A58` and produces `SyntaxError` garbage.
  Substitute longest measurement names first (`@tu` before `@t`).
- **Units: cm is the Valentina default.** The engine reads `<unit>` and warns
  `UnitMismatch` when the scale is not 1.0; with `--converteer-eenheid` only
  literal x/y are converted, formula-derived lengths stay in the source unit.
  An unread `unit cm` yields a pattern 10× too small with no error.
- **`piece_path` trimming rule.** A curve node's start/end is trimmed to the
  nearest previous/next non-excluded node **only when that point lies on the
  curve** (`CurvePoint`/`CurveStartPoint`/`CurveEndPoint`); otherwise the
  nominal endpoint is used and the piece shows a break. The engine repairs
  gaps up to `GAP_TOL_MM = 1.0` and reports anything above `GAP_RUIS_MM = 0.05`.
  `strict=True` turns the gap into `OpenPath`; use it in production callers —
  `strict` off silently draws a jump instead of a contour.
- Fail loud types to expect: `UnknownNodeType`, `MissingMeasurement`,
  `UnitMismatch`, `OpenPath`, `UnplaceableFeature`, `InvalidFormula`,
  `MissingObject`. `vv.meld()` never raises and always downgrades to
  `"waarschuwing"`; use `with vv.verzamel():` to collect all errors in one run.

## Notches (pastekens)

The `.vlt` writes every passmark as **two collinear halves**, `builtIn=true` on
the seam and `builtIn=false` in the seam allowance, split where the slit
crosses the seam line. Collinear halves carry no direction: the inside of the
piece does, and the `builtIn=true` half lies inside.

- One 10 mm keep per passmark, `passmarkLength` is read from the `.val`, not
  assumed 10.
- Foot exactly on the seam (0.000 mm), **tip points inward** toward the inside
  of the piece — confirmed with a point-in-polygon test on the tip, minimum
  10 mm from the seam. Never derive the direction from the winding alone (the
  signed-area normal breaks on a concave side seam); use the winding then
  confirm and flip with point-in-polygon.
- A passmark on a curve node, or `passmarkLine != "one"`, or
  `passmarkAngle != "straightforward"`, must raise instead of being skipped or
  flattened into a single straight keep.
- Verify against the `.vlt` halves with the perpendicular deviation
  (`1.5 mm` limit; achieved 0.320 mm).

## Grainline (rechtdraad)

- Source of truth is the `<grainline>` in the `.vlt`: `x1,y1;x2,y2` in
  piece-local px, `3.7795 px/mm`, y-down. Three of four pieces had one; the
  fourth is disabled in the `.val` and empty in the `.vlt`.
- Express it as **distance to the piece's own anchor edge plus two y fractions
  of the height**, so every size gets the same place in the piece. Store it as
  that, not as `.vlt` points: the points scale with width.
- **Minimum margin 2 mm** (`toleranties.rechtdraad_marge_mm` /
  `anker_marge_mm`): both ends and 20 intermediate points inside the polygon,
  the line crosses the contour nowhere, never on the contour. Achieved exactly
  2.00 mm for all sizes; source deviation 0.001 mm over 24 lines.
- **Arrow direction: tail on the waist, point at the hem** — the thread runs
  that way, and the user rejected the reverse (`OMGEKEERD`) on the print.
  `oneWayDown` = apex on the hem end (`p_bot`) pointing toward the hem with
  the arms on the waist side; `oneWayUp` = apex at the waist;
  `twoWay*` = an outward point at both ends. 4.5 mm at 22°, say so in the
  legend. `none` or an unknown value means no arrow, not a guess. Get the sign
  wrong once and the whole sheet is wrong: prove it geometrically (apex y vs
  barb y), never by trusting the `data-pijl` label the drawing itself wrote.
- **A horizontal grainline is legitimate**: a waistband's grain runs along the
  band, from a `.vlt` without a grainline for that piece the longest straight
  edge is horizontal. The hem test then does not apply — skip it and say so
  (`niet op zoom-richting te toetsen`), do not demand "points down".
- `verifieer-rechtdraad.py` is the evidence: per piece × size the drawn angle
  (measured from the path, not from `data-hoek`), the source (`vlt` points /
  `val` `rotation` / geometry), the source angle modulo 180, and which end
  carries the point. Skirt: 24/24 lines 0.00° off vertical; spijkerrok: 48/54
  vertical, the 6 horizontal vp-tailleband lines named.
- **The label on the line is `recht van draad`** (`GRAIN_LABEL`), the same term
  as the legend row. It sits an offset beside the line (3.2 mm), shrinks with a
  short line but never below 2.6 mm, and carries `data-grainline-label` plus
  `data-piece` — without `data-piece` every label lands in the legend unit of
  the A0 layout and that block grows to the whole sheet.
- No fallback by piece name. A piece without a grainline inherits nothing
  silently: derive one from the longest straight edge, parallel, at margin,
  or leave it out with a legend line.
- Read the angle from the two points. Hard-coding `90.0` drew a slanted grain
  line vertically.
- Open case worth naming rather than hiding: the `.vlt` puts the back grainline
  on x = 1011.22 px while the centre-back seam is at 1010.59 px, i.e. on the
  seam; the `.val` puts it 20 mm inside. A grainline on a seam is not a
  grainline — draw the `.val` position and report both deviations.

## Checker (`controleer-svg.py`)

Split the checks: **invariants** (closed contours, no self-intersection,
nothing outside the viewBox, per-path style, one grainline per piece, keep foot
on the seam, 50 mm block, 1:1 scale, page exactly A0) versus **pattern facts
from the manifest** (piece count, keeps per piece, expected `.vlt` deviation,
anchor side, band pairs).

- **Count per (piece, size), not totals.** "15 keeps" passes while one piece
  has none. Same for grainlines and arrows: 4 × 6 = 24 lines and 24 arrowheads,
  per size 4.
- **The sheet's own text is checked** (section 9): every `data-grainline-label`
  reads exactly `recht van draad`, the legend row keeps its explanation, no
  `#a33` remains in the element tree *or* in the SVG source, the table header
  carries the `.vit` full names (uniform across sizes), `(mm)` appears once, and
  each size row's cells sit inside their own column and do not overlap. Section
  9e adds the table itself: per header cell its right edge equals its column's
  value edge within 0.1 mm, the 1 header rule + 6 row rules + 4 column
  separators + closed box exist inside the legend and clear of the 5 × 5 cm
  block, they are 0.2 mm light grey, and no text bbox crosses a rule or the box.
  This is
  what caught the generator reading the skirt's `.vit` for the spijkerrok
  (`@hh` 215 instead of 210 in size 42): take the `.vit` template from the
  manifest (`ctx.pad("maattabel")`), not from the default constant.
- Thresholds and expectations come from `patroon.json`; never from the skirt.
  A correct trouser must not FAIL on skirt facts (four fixed piece names, six
  fixed sizes, exactly three keeps, 2+1 split, exactly 90°, exactly 4.5 mm
  arrows, `2×(voor+achter) = @tw+20`). `verify-maten.py` is skirt-specific by
  design; do not reuse it as a generic gate.
- **Per-size measurement check first.** Dump `@Ger` and `@rl` from every `.vit`
  before reasoning about a size curve:
  `for f in *.vit; do echo "== $f"; grep -nE 'name="@(Ger|rl)"' "$f"; done`
  Seen: `@Ger` 40 in size 34 and 15 in 36–44 (size 36 came out *narrower* than
  34); `@rl` 500/400/450 across files and folders, a 100 mm length step between
  sizes. Only two hem arcs use `@Ger`, yet it moves the bbox width of every
  piece.
- **`feit.groei: true` is stricter than it looks.** It demands every piece get
  strictly wider per size; a constant-width piece (`ondertree` 55 mm,
  `gulp beleg` 45 mm) fails it on a correct garment. Leave it `false` and write
  the measured widths in the manifest `note`.
- **`feit.middenrand_vast`** is about the straight run at the anchor edge, not
  about `@Ger`. Measure before naming a cause.
- `knik_graden = 170` flags sharp corners (a < 10° dart tip, a trouser crotch)
  as kinks; keep the neighbour-length exception and an explicit override
  (`feit.kink_limit_mm`) instead of raising the limit until green.
- Edit a `.vit` only after `cp -p "$f" "$f.bak-$(date +%Y%m%d-%H%M)"`, and only
  the `value` attribute, byte for byte. `@rl` often carries a trailing
  newline entity (`value="450&#10;"`); dropping it silently changes the file.

## Pitfall: a stale `.vlt` produces false FAILs

The `.vlt` is one export of one size at one moment. Changing `@rl` 500 → 450
made the checker report `FAIL: contour wijkt af` by 24.534 mm (achterpand) and
11.449 mm (voorpand) and keeps off by 20.273 mm — the 50 mm length difference,
not a bug. Declare it: `feit.vlt_past_bij_vit: false` turns those into printed
diagnoses with the numbers intact, and the `.vlt` becomes an indicative
comparison with a generous sanity limit plus a bbox-height cross-check. Set it
back to `true` only after a fresh export.

`valideer-tegen-vlt.py` normalizes bounding boxes, so a uniform scale error is
invisible there; an `sy` of 1.30 means the pieces are ~30% short, not scaled.
Load it with `importlib.util.spec_from_file_location` (plain `import valideer`
fails).

## The rule above all others

**Never guess a convention — take it from the source and test it
geometrically.** Angle sign, rotation sign, `pointOfIntersection`, arc sweep,
spline handles and notch direction each looked plausible the wrong way round.
Read the implementation (Seamly2D `develop`, the `.val` tool classes), then
prove the guess with a measurement against the `.vlt` or an invariant; when in
doubt the `.vlt` is the truth, unless the `.vlt` contradicts itself — then name
the contradiction and both deviations.
