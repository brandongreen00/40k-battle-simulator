# Terrain layout extraction — GW Chapter Approved 2025-26

`extract-gw-ca-2025.ts` produces the 48 `Layout` JSON files under `data/layouts/`
(`ca2025-<deployment>-<1..8>.json`) — the six Strike Force deployments × eight terrain layouts
from the GW Chapter Approved 2025-26 pack. Run it with:

```
pnpm extract:layouts      # regenerate data/layouts/ca2025-*.json (idempotent)
pnpm preview:layouts      # render tools/layouts/preview.svg (a 48-map contact sheet)
```

Neither command needs network access — the source values are embedded in the extractor.

## Source & provenance

Data was read from the **labrador.dev** 40k layout tool
(`https://labrador.dev/40k_layouts?mapPack=gw-chapter-approved-2025-2026`), a SvelteKit app that
ships its layout data inside the client JS bundle (there is no public API; the route's
`__data.json` is empty). The values embedded in `extract-gw-ca-2025.ts` were transcribed verbatim
from the production bundle (June 2026 build):

| What | Bundle file | Symbols |
|------|-------------|---------|
| Deployments: zones (SVG paths) + objectives | `_app/immutable/chunks/CW8xRr0c.js` | `b,x,S,C,w,T` (`*-sf-2025`) |
| Terrain feature shapes + footprints + colours | `_app/immutable/chunks/cqzbK7sO.js` | `Xe,Ze,Qe,et,tt,nt,rt,$e,it` |
| The 8 terrain layouts (half-board) | `_app/immutable/nodes/3.AeyLoVTb.js` | `tn,nn,rn,an,on,sn,fn,pn` |
| Mirror + render transforms | `cqzbK7sO.js`, `Sb5RK290.js` | `Ft,Pt,It` + the group `transform` |

All 40k rules/IP belong to Games Workshop; this data is for personal, offline use only (see the
repo's `CLAUDE.md`). Nothing here is published or redistributed.

## How a labrador board is modelled (and how we convert it)

- Board is **60"×44"**. A layout stores only **half** the terrain; labrador's `Ft()`/`Pt()` mirror
  every piece **180° about the centre (30, 22)** to fill the other half. We do the same, building
  each piece's 180° partner so the output is provably symmetric.
- Each placed piece is `{ feature, point:{x,y}, rotation°, flip }`. The render transform (in
  labrador's y-**down** screen space) is `final = point + flipX( rotate(rotation, localCorner) )`,
  where the feature footprint's local origin sits at `point`. We reproduce this exactly.
- **Splits** are encoded as two adjacent features that butt together (verified — the pair shares an
  exact edge once transformed):
  - 12×6 "grey+blue" = **8×6 grey (`z`)** + **4×6 blue (`y`)** — split on the 4" line, per spec.
  - 10×5 "grey+blue" = **6.5×5 grey (`T`)** + **3.5×5 blue (`R`)** — split on the 3.5" line.
- **Colour → type/height**: grey footprint (`#5C6061`) ⇒ `ruin_blocking` / `height: "tall"`
  (blocks LoS); blue (`#065475`) ⇒ `area_cover` / `height: "low"` (≤2").
- **Coordinates**: labrador is top-left origin (y down); our board is bottom-left origin (y up), so
  every extracted point is converted once: `(x, y) → (x, 44 − y)`. This makes our maps render
  identically to labrador's.
- **Deployment zones**: `attacker → player`, `defender → opponent`. Arc commands (`A …`, used by
  Search and Destroy) are tessellated into polygon vertices.
- **Objectives**: positions come straight from the deployment data; every marker is **40mm**
  (`objectiveMarkerDiameterIn`) with a **3" control range** (`objectiveControlRadiusIn`).

## Composition (sanity check)

For terrain layouts 1-6 & 8 the decoded footprints are exactly the GW set the project expects:
**6 × 12×6** (4 solid + 2 split), **2 × 10×5** (split), **4 × 6×4** (standalone blue). Layout 7 is
a denser GW variant (20 pieces) and is reproduced faithfully as-is. `tests/layouts.test.ts` asserts
counts, on-board bounds, the objective spec, and 180° symmetry for all 48 maps.
