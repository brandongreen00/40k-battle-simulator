# 11th-edition Event Companion layout extractor

Extracts the **45 official terrain layouts** (15 Force Disposition pairings x layouts A/B/C)
from the GW *Warhammer Event Companion* v1.0 (June 2026) PDF into `data/layouts11/*.json`.

## Source documents (not committed — GW IP, personal use only)

- Event Companion (layout pages 9–53):
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
- **Terrain features** — the tinted photos placed on the mats, recovered as true
  rotated quads via pdfium image matrices; green tint = `dense`, gold = `light`
  (11e terrain categories). Where a mat's features are baked into a composite
  photo, they are recovered from the page render by colour masking
  (`"recovered": true`). Feature polygons are the photo placements — the PDF has
  no exact per-ruin footprint outlines, so this is the best available ground truth.
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
pip install pdfplumber pypdfium2 pillow
python3 tools/layouts11/extract_event_companion.py /path/to/event_companion.pdf
```

Output: `data/layouts11/ec2026-<pairingA>_vs_<pairingB>-<a|b|c>.json` + `index.json`.

## Validation performed

- 45/45 pages extract 16 terrain areas (matches the companion's footprint table),
  1 attacker + 1 defender zone, 5–6 objectives (2 owned homes each), a divider.
- Pages 9, 10 and 24 verified visually against the PDF renders (zones incl.
  quarter-circle arc cutouts, rotated features, objective/marker placement).
- All 18 features on page 9 audited crop-by-crop for dense/light classification.
