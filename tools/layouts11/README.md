# 11th-edition Event Companion layout extractor

Extracts the **45 official terrain layouts** (15 Force Disposition pairings x layouts A/B/C)
from the GW *Warhammer Event Companion* v1.1 (July 2026) PDF into `data/layouts11/*.json`.

## Source documents (not committed — GW IP, personal use only)

- Event Companion v1.1 (layout pages 9–53; the committed data's source):
  `https://assets.warhammer-community.com/eng_22-07_warhammer_40,000_event_companion-alyapl19us-b2drgwkji4.pdf`
  - v1.1 changed 8 layouts vs v1.0 (its own changelog, verified by re-extraction diff):
    Take and Hold vs Purge the Foe A/B/C, Purge the Foe vs Disruption A/B/C,
    Disruption ("Reconnaissance") vs Reconnaissance A and C. The other 37 extract
    byte-identically from both PDFs.
  - previous v1.0 (June 2026):
    `https://assets.warhammer-community.com/eng_12-06_warhammer40000_event_companion-s3bfb5f9s1-ivswuij3fo.pdf`
- Terrain area footprints (the five 1:1-scale mats the layouts use):
  `https://assets.warhammer-community.com/eng_12-06_warhammer40000_terrainareafootprints-biavo5zf9f-gxdahkydbj.pdf`

## Method (vector extraction, no eyeballing)

The layout diagrams are vector art. Each page is calibrated via the battlefield
photo's bounding box (44"x60" -> ~7.7445 pt/inch), then objects are classified by
their CMYK fill colours (documented at the top of the script) and converted to
board inches (origin bottom-left, y up):

- **Deployment zones** — red/blue filled paths and rects; bezier arcs flattened
  (8 samples/segment); vertices snapped to board edges within 0.35".
- **Terrain areas** — the 16 grey (20% black) polygons per layout; these are the
  five canonical footprint mats (4x 6"x4", 2x 10"x2.5", 4x 6"x2", 4x 7"x11.5",
  2x 8"x11.5" polygon). Organic outlines kept, Douglas-Peucker at 0.06".
- **Terrain features** — the printed silhouettes, **traced** off a 46 px/inch page
  render: the green (`dense`) and gold (`light`) tinted pixels are masked, closed,
  labelled and contour-traced, then simplified at 0.09" (`trace_features`). The
  tinted art is *placed* as rectangular photo quads, so reading the placement
  matrices — what the extraction did until 2026-08-16 — squared off every L-shaped
  ruin, bridge span and barricade run; the render is the only place the real
  footprint exists. The placements are still read, purely to assert that tracing
  found a silhouette on every one of them.
  Printed icons (objectives, AB/CD/EF/GH roundels, area markers, the territory
  divider roundels) are punched out of the mask first — the teal ones read as
  "dense" — and the hole is then inpainted from its rim, so a silhouette running
  behind a badge carries straight through while a badge on bare mat stays bare.
  Tinted blobs under 0.35 sq in (rubble flecks smaller than a 25 mm base) are
  dropped as print noise: ~5 sq in per layout, ~2.5% of the traced terrain.
- **Area binding** — features and objectives bind to the terrain area they sit
  *deepest* inside (the mats are printed overlapping, so a point near a shared
  edge falls inside two of them and a first-match rule flips on hundredths of an
  inch).
- **Objectives** — home (red/blue castle circle, `owner` recorded), central
  (teal skull circle), expansion (teal skull diamond). Each is bound to the
  terrain area whose polygon contains it (`areaId`) — under 11e rules that whole
  terrain area IS the objective. Objectives with no `areaId` (5 open-field
  centrals) are 40 mm objective markers (3" control range).
- **Area markers** — the key's "single terrain area" (eye) / "separate terrain
  areas" (slashed eye) badges, so adjacent mats can be merged/kept separate.
- **Territory divider** — the dashed diagonal where drawn; otherwise the straight
  midline between the deployment edges. `attackerEdge` records which board edge
  the attacker's zone hugs.
- **Header** — Force Disposition + Primary Mission per player, read positionally
  from the two header boxes.

## Run

```sh
pip install pdfplumber pypdfium2 pillow numpy scipy scikit-image
python3 tools/layouts11/extract_event_companion.py /path/to/event_companion.pdf
```

Takes ~25 s per page (the feature tracing renders each page at scale 6), ~20 min
for the 45 layouts.

Output: `data/layouts11/ec2026-<pairingA>_vs_<pairingB>-<a|b|c>.json` + `index.json`.

## Validation performed

- 45/45 pages extract 16 terrain areas (matches the companion's footprint table),
  1 attacker + 1 defender zone, 5–6 objectives (2 owned homes each), a divider.
- Pages 9, 10 and 24 verified visually against the PDF renders (zones incl.
  quarter-circle arc cutouts, rotated features, objective/marker placement).
- All 18 features on page 9 audited crop-by-crop for dense/light classification.
- **v1.1 re-review (2026-08-14):** all 45 pages re-verified with geometry-on-page
  overlay renders (every element class audited page by page). Three systematic
  defects found and fixed:
  1. **Territory dividers** — the bbox-corner endpoint pairing mirrored all 34
     diagonal dividers (they all rise left-to-right); dividers now use the
     stroke's true endpoints. 11 layouts print no divider and correctly fall
     back to the midline. The dashed ~9"-radius circle printed around the
     battlefield centre on some pages is a mission illustration, not part of
     the divider, and is ignored (its arcs are ~87 pt, under the 100 pt divider
     threshold).
  2. **Single/separate markers** — inverted on every badge of every page: the
     old "slash stroke" test actually matched the PLAIN badge's stroked eye
     outline (the slashed badge draws its eye as two grey-FILLED halves and has
     no stroked path at all). Classification now keys on those filled halves.
  3. **Baked-in features** — some mats carry their tinted rails/ruins inside
     the neutral mat photo (no separate tinted placement), so one copy of a
     mirrored pair could miss its gold rails, and two mats on p51 had a
     mat-sized composite quad swallowing everything. Pixel recovery now runs
     for every area (per-connected-blob boxes, printed badges masked out,
     blob centre required inside the area, placed quads win over blobs).
  Also: one badge on p35 exists in the vector stream but is painted over by
  the red zone fill — markers now require their badge to be visible in the
  render, so the invisible fifth badge is dropped (players only see four).
  Known convention: the tiny (~0.5"x1.5") rust hook motif printed at the tip
  of some triangle/strip mats is part of the mat's outline art (the footprint
  polygon traces its silhouette) and is deliberately NOT a terrain feature —
  it appears identically on ~38 pages.
- **Feature tracing (2026-08-16):** features are traced silhouettes now, not
  photo-placement quads (see Method). Checks over the regenerated 45:
  - all 45 pages keep 16 areas / 5-6 objectives / 1+1 zones / a divider, and
    every one of the ~30 tinted photo placements per page has a traced
    silhouette on it (the extractor prints a warning otherwise: none fired).
  - **pixel ground truth** (10 layouts re-rendered and compared against the
    polygons): dense recall 93.7%, light 89.9%; the ~7 sq in per page not
    covered is 1/3 anti-aliased edge slivers (≤0.05 sq in each) and 2/3
    tinted specks under the 0.35 sq in noise floor. Precision (85% / 89%) is
    deliberately below 100: a traced footprint is filled, while the printed
    art has interior gaps (windows, texture, the badge disks).
  - **180-degree symmetry**: the companion mirrors each layout about the board
    centre; traced dense+light coverage matches its own mirror to within 0.3"
    on a median 98.6% of its area (worst page 84.9%) — the residue is print
    registration plus the badges, which sit on one copy of a mirrored pair but
    not the other.
  - pages 9, 22, 28, 35 and 51 (the composite-photo and buried-badge cases from
    the v1.1 review) re-checked crop-by-crop against the print.
  Two central objectives (`take-and-hold_vs_reconnaissance` A and B) moved
  `areaId` between two OVERLAPPING mats — they are printed within 0.1" of the
  shared edge, and both mats carry a "single terrain area" badge, so they are
  one rules-area either way. Binding now picks the area a point sits deepest
  inside instead of whichever was parsed first.
