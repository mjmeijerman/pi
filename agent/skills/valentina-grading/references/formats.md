# Formats and scripts

Open this when you need to parse or write a `.val`, `.vit`, `.vlt` or `patroon.json`,
or to know which script computes what. It answers: *what is in this file, and which
script owns this number?* The order of operations lives in `SKILL.md`.

## Scripts, one row each

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

## Formats

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

The `.vit` is read through `ctx.pad("maattabel")`, never from a default
constant: a generator that ignored the manifest read the skirt's `.vit` for the
spijkerrok (`@hh` 215 instead of 210 in size 42) and the measurement table was
wrong for every size.

Load `valideer-tegen-vlt.py` with
`importlib.util.spec_from_file_location` (plain `import valideer` fails).
