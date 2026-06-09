# 40k-battle-simulator

A personal Warhammer 40,000 (10th edition, Pariah Nexus) battle simulator that plays three
fixed army lists against each other on labrador.dev terrain layouts, with an AI opponent.
Private, non-commercial, single-machine tool. See [`CLAUDE.md`](./CLAUDE.md) for the project
charter and [`docs/40k_simulator_plan.md`](./docs/40k_simulator_plan.md) for the full plan.

> **Status: Stage 1 (Phase 0) + a points-correct List Builder.** A data layer, a measuring
> board you can place/drag/measure models on, and a full Imperial Agents / Astra Militarum army
> list builder. No combat / LoS / abilities / AI yet (those are later stages, out of scope).

## Quick start

```bash
pnpm install
pnpm dev        # run the measuring board locally
pnpm test       # vitest (geometry, RNG, reducer, app smoke)
pnpm typecheck  # tsc --noEmit (strict)
pnpm build      # production build to dist/
pnpm ingest     # regenerate data/game/*.json from Wahapedia (see tools/ingest/README.md)
```

## What works now

- **Pure rules core** (`src/core/`, no React/DOM): shared types, a seeded RNG (mulberry32),
  base-to-base geometry (the canonical 40k gap), and a minimal intent reducer.
- **Data ingest**: a converter that turns the Wahapedia 10e CSV exports into typed JSON, scoped
  to the two factions the lists use (Imperial Agents + Astra Militarum). Output committed under
  `data/game/`.
- **Measuring board UI**: the Hammer-and-Anvil layout rendered to scale with type-colored
  terrain, objectives, and deployment zones; spawn units from a roster; drag models; and a live
  base-to-base distance read-out.
- **List builder** (Imperial Agents + Astra Militarum): searchable catalog grouped by role, add
  units, choose the model-count tier (points update live), add detachment-scoped enhancements,
  set a Warlord, attach leaders, and pick wargear with **cap-aware steppers** — e.g. a 10-strong
  Deathwatch Kill Team correctly allows up to **4** thunder hammers (2 per 5 models), enforced
  live. A points bar vs the battle-size limit (Combat Patrol/Incursion/Strike Force) plus a
  validation panel (points, enhancement legality, datasheet copy limits, Epic-Hero uniqueness,
  wargear caps). Save to your browser, export a Roster JSON, or send the list to the board.
- **Team importer**: paste the plain-text export from the official Warhammer 40,000 app's team
  builder and the list is rebuilt automatically — faction, detachment, battle size, every unit's
  model count, per-item wargear (including which models carry **shields**), the Warlord and any
  enhancement. Unresolvable lines are reported, never invented.
- **Loadout-aware saves**: a model's wargear carries into the game. Shield-bearers (Astartes /
  Endurant shields) get their **4++ invulnerable save** resolved per model in the combat pipeline,
  so the right models take the right saves.

  > **10th-edition points note:** wargear costs **0 points** in 10e — a unit's cost comes only
  > from its model count, and enhancements. So swapping weapons never changes points (by design);
  > the builder enforces the *number* of each upgrade (the caps), and the points stay exact.

## Deployment (GitHub Pages)

Pages is configured to **deploy from GitHub Actions**. The workflow
([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)) typechecks, tests, builds,
and publishes on every push to `main` (and via manual "Run workflow"). The Vite `base` is set
to `/40k-battle-simulator/`, so the site serves from
`https://<user>.github.io/40k-battle-simulator/`.

## Licensing

All 40k rules and IP belong to Games Workshop; Wahapedia data is personal-use only. This repo is
private and non-commercial — do not publish it or host the rules text publicly.
