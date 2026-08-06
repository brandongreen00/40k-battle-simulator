# Combat Patrol layout builder

Builds the three 30"×44" Combat Patrol maps (`data/layouts_cp/cp2026-layout-*.json`)
from geometry measured off the owner's Warhammer-app map screenshots
(IMG_9886/9887/9888, 2026-08). GW publishes no PDF of the 11e CP missions, so the
screenshots are the source of truth.

## Method

Calibration: the board area in the 1170×2532 screenshots spans x 154–1015,
y 721–1982 → 28.67 px/inch (consistent across width/height and all three maps).

- **Deployment zones** — HSV/colour-mask segmentation of the blue/red fills,
  contour trace, vertex snap to 0.25" and the board edges; mat-overlay notches
  removed by line fitting. Verified 180°-symmetric per map.
- **Terrain mats** — dark-outline tracing + local-texture (rubble) detection for
  seeds, then per-mat window measurement of the plate edges (projection peaks of
  the dark outline). Every map resolves to the same 10-mat set: 2× 11.5"×7.5",
  4× 6"×4", 4× 6"×2", mirrored about the board centre. Stored as clean rectangles
  (the printed torn edges are decorative).
- **Printed measurements** — every corner-offset callout on the maps was read
  from 2–3× crops and reconciled; offsets reference the **nearest** board edges
  (e.g. "17"/8"" = 17" from the top, 8" from the right).
- **Dotted lines** — small-dot detection + RANSAC line fits. All maps carry
  dotted table-quarter guides (y=11/22/33, x=15, drawn only outside zones/mats);
  the territory divider is y=22 on maps 1–2 and the (0,44)→(30,0) diagonal on
  map 3 (the paired blue/red divider markers sit on it).
- **Icons** — white-shape detection classified by interior colour: castle circles
  (home objectives), skull diamonds (expansion objectives), droplet/cross divider
  marker pairs; ⊘ separate-area markers and the AB/CD/EF/GH ruin letters read
  visually. All icon sets are mirror-consistent.
- **Features** — green (dense) / gold (light) colour-mask traces, assigned to
  their containing mat; the teal skull-diamond icons are excluded from the
  feature masks by position.
- Final geometry was overlay-rendered on top of each screenshot and visually
  diffed before committing.

## Files

- `spec.json` — the hand-verified geometry (zones, mat rects, icons, dividers).
- `raw_98*.json` — the traced feature polygons per map.
- `build.py` — assembles `data/layouts_cp/*.json` in the same raw shape as the
  Event Companion files (consumed by `convertCp` in `src/data/loaders.ts`), plus
  CP extras: `name`, `dividerMarkers`, per-area `letter`.

Run: `python3 tools/layouts_cp/build.py`
