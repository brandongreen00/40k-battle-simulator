# CLAUDE.md — Warhammer 40,000 Battle Simulator

> **This file is the persistent guide for every Claude Code session on this project.**
> Read it in full before doing anything. Then read `docs/40k_simulator_plan.md` (the
> full rationale) and the three army-list files in `docs/lists/`. When you finish a
> work session, update the **Progress Log** at the bottom so the next session has context.

---

## 1. What we are building (and what we are NOT)

A **personal, single-machine tool** that plays the owner's three saved 40k army lists against
each other on fixed terrain layouts, with an AI controlling the opposing army. 10th edition,
Pariah Nexus mission structure, 1000-point ("Incursion") games.

**We are NOT building a general 40k simulator.** We never implement a faction, datasheet,
stratagem, or ability that does not appear in one of the three owned lists. The whole project
is only feasible *because* the scope is fixed to those lists — they turn an infinite rules
surface into a finite checklist. Treat scope creep as the primary risk.

The three lists (in `docs/lists/`):
- **Imperialis Fleet** — Imperial Agents (`agents_of_imperium_suggested_list.md`)
- **Grizzled Company** — Astra Militarum (`grizzled_company_suggested_list.md`)
- **"Bane"** — Krieg/AM thematic list (`jacks_army_unit_reference.md`)

**Legal / privacy constraint:** All 40k rules and IP belong to Games Workshop; Wahapedia data
is personal-use only. This repository is **private and non-commercial**. Do not publish it, do
not host rules text publicly, do not add a license that implies redistribution rights over GW
content. The converted game data lives in the repo only to make the personal tool work offline.

---

## 2. Non-negotiable architecture rules

These exist to prevent the rewrites that kill projects like this. Honor them from day one,
even before the features that need them exist.

1. **The rules core is pure and framework-free.** Everything under `src/core/` must be
   deterministic TypeScript with **no React, no DOM, no I/O imports**. It is the only code
   allowed to mutate game state, and it does so only in response to *validated intents* plus
   *RNG results*. The UI and the AI both talk to it through the same intent interface.

2. **Seeded, injectable RNG.** Define an RNG interface in core now and pass it in. Never call
   `Math.random()` inside core. This makes every game reproducible and every test deterministic.
   (Stage 1 barely rolls dice, but establish the seam now.)

3. **Reactive timing is first-class.** The phase/turn model must allow actions during the
   *opponent's* turn (overwatch, Displacer Field, Death Riders' Screening Line, Yarrick's
   Counterstrategist). Do **not** model a turn as "active player does everything." This is the
   single most expensive thing to retrofit, so the state machine must support reactive windows
   from the start — even though Stage 1 doesn't fire any.

4. **The turn structure is data, not UI.** Do not hard-code the Pariah Nexus phase sequence
   into React components. 11th edition launches mid-2026; the rules core should be re-pointable
   without rewriting the UI.

5. **Distances are base-to-base, in inches.** 40k measures between the *closest points of
   bases*, never centre-to-centre. The canonical distance function is:
   `gap(a, b) = max(0, dist(centre_a, centre_b) − radius_a − radius_b)`.
   Get this right once in `core/geometry.ts` and use it everywhere. Board coordinates are in
   inches; origin bottom-left, x along the long (60") edge, y along the short (44") edge.

6. **Ask before changing scope or stack.** If a task seems to require implementing a unit/rule
   not in the three lists, or changing the tech stack below, stop and surface it rather than
   guessing.

---

## 3. Tech stack (decided — don't re-litigate without asking)

- **Language:** TypeScript (strict mode).
- **Build/dev:** Vite. **Package manager:** pnpm (npm is acceptable if pnpm is unavailable).
- **UI:** React. **Board rendering:** SVG for now (free hit-testing and drag via DOM events;
  ample for a measuring board). Canvas is a *possible* later optimization — do not start with it.
- **Rules core:** plain TypeScript modules. **Do not add boardgame.io yet** — it's a candidate
  for later, but adopting a game-framework before the core exists is premature. Revisit only
  when the combat engine is stable.
- **Tests:** Vitest.
- **Data ingest:** fork/vendor the converter from the open-source `fjlaubscher/depot` project,
  which already turns Wahapedia's pipe-delimited CSV exports into typed JSON. Do not scrape
  Wahapedia HTML. The converter runs offline as a build-time tool; its JSON output is committed
  so the app has no runtime network dependency.

---

## 4. Repository layout (target)

```
/
├─ CLAUDE.md                      ← this file
├─ docs/
│  ├─ 40k_simulator_plan.md       ← full plan & rationale
│  └─ lists/                      ← the three army-reference .md files
├─ data/
│  ├─ raw/                        ← downloaded Wahapedia CSVs (gitignore if large)
│  ├─ game/                       ← converted datasheet/weapon/ability JSON
│  ├─ layouts/                    ← terrain layouts as polygon JSON (+ type tags)
│  └─ rosters/                    ← the three armies as structured JSON
├─ tools/
│  └─ ingest/                     ← CSV→JSON converter (forked from depot)
├─ src/
│  ├─ core/                       ← PURE rules core, no React/DOM
│  │  ├─ types.ts
│  │  ├─ rng.ts                   ← seeded RNG interface + impl
│  │  ├─ geometry.ts              ← distance, base-to-base, (later) LoS
│  │  └─ state.ts                 ← GameState + intent reducer skeleton
│  ├─ data/                       ← loaders that read data/* into typed objects
│  ├─ ui/                         ← React components
│  │  ├─ Board.tsx
│  │  ├─ TerrainLayer.tsx
│  │  ├─ ModelToken.tsx
│  │  └─ MeasureOverlay.tsx
│  └─ main.tsx
├─ tests/
├─ package.json · tsconfig.json · vite.config.ts
```

---

## 5. Starter data contracts

These are **starting points** to make the data shape concrete — extend fields as needed, but
keep the core/UI boundary and the inch-based coordinate system. Put shared types in
`src/core/types.ts`.

```ts
// Geometry — all distances in inches
export interface Vec2 { x: number; y: number; }

export interface BaseShape {            // model bases
  kind: "circle" | "oval";
  radius?: number;                      // circle, inches
  rx?: number; ry?: number;             // oval, inches
}

// --- Static game data (from Wahapedia conversion) ---
export interface ModelProfile {
  name: string;
  M: number; T: number; Sv: number;     // move/toughness/save
  invuln?: number;                      // e.g. 4 means 4++
  W: number; Ld: number; OC: number;
}

export interface WeaponProfile {
  name: string;
  type: "ranged" | "melee";
  range?: number;                       // inches; omit for melee
  attacks: string;                      // "20" or "D6" or "2D6" — parse at use
  skill: number;                        // BS/WS, e.g. 3 means 3+
  S: number; AP: number;                // AP stored as negative or 0
  D: string;                            // "1" | "D6" | "D3+1"
  keywords: string[];                   // ["RapidFire 1","Torrent","Melta 2",...]
}

export interface Datasheet {
  id: string;
  name: string;
  faction: string;
  models: ModelProfile[];               // multi-profile units allowed
  weapons: WeaponProfile[];
  baseShape: BaseShape;
  keywords: string[];                   // INFANTRY, VEHICLE, TITANIC, CHARACTER...
  abilityIds: string[];                 // resolved later by the ability system
}

// --- Roster (an owned army list) ---
export interface RosterUnit {
  datasheetId: string;
  modelCount: number;
  wargear?: string[];                   // chosen options
  enhancementId?: string;
  attachedCharacterId?: string;         // leader attachment
}
export interface Roster {
  name: string;                         // "Bane", "Imperialis Fleet", ...
  faction: string;
  detachment: string;                   // "Grizzled Company", "Imperialis Fleet"
  points: number;
  units: RosterUnit[];
}

// --- Terrain & board ---
export type TerrainType = "ruin_blocking" | "area_cover" | "obstacle";
export interface TerrainPiece {
  id: string;
  type: TerrainType;
  polygon: Vec2[];                      // footprint, inches, board coords
}
export interface Layout {
  id: string;                           // "ca2025-hammer-and-anvil-1"
  boardWidth: number;                   // 60
  boardHeight: number;                  // 44
  deployment: string;                   // "Hammer and Anvil"
  terrain: TerrainPiece[];
  objectives: Vec2[];                   // marker centres (40mm markers)
  deploymentZones: { player: Vec2[]; opponent: Vec2[] }; // polygons
}

// --- Live game state (skeleton; grows in later stages) ---
export interface ModelInstance {
  id: string; unitId: string;
  pos: Vec2; wounds: number; alive: boolean;
}
export interface UnitInstance {
  id: string; owner: "player" | "ai";
  datasheetId: string; models: ModelInstance[];
  // status flags (battle-shock, under-order, etc.) added in later stages
}
export interface GameState {
  layout: Layout;
  units: UnitInstance[];
  round: number; activePlayer: "player" | "ai";
  phase: string;                        // keep as data; see rule #4
  cp: { player: number; ai: number };
  score: { player: number; ai: number };
}
```

---

## 6. CURRENT STAGE — Stage 1: Data & Scaffolding ("the measuring board")

> **Mapping note:** "Stage 1" = **Phase 0** in `docs/40k_simulator_plan.md`. It is the
> foundation the combat core (next stage) is built on. **No combat, no line-of-sight, no
> abilities, no AI in this stage** — those are explicitly out of scope below. If the project
> owner actually wanted the combat core first, stop and confirm, because it depends on this.

### Goal
A board you can look at, place your models on, drag them around, and measure with — backed by
a real data layer. By the end, the three lists exist as structured data and at least one
terrain layout renders correctly.

### Tasks (build roughly in this order)

1. **Project scaffold.** Vite + React + TS (strict) + Vitest. Set up the directory layout in
   §4. Add `pnpm dev`, `pnpm test`, `pnpm typecheck` scripts. Commit the empty skeleton.

2. **Core seams (no features yet).** Create `core/types.ts` (from §5), `core/rng.ts` (seeded
   RNG interface + a simple implementation, e.g. mulberry32), and `core/geometry.ts` with the
   **base-to-base distance** function (rule #5) plus point-in-polygon. Unit-test geometry.

3. **Data ingest.** Stand up `tools/ingest/` by forking the `depot` converter. Download the
   Wahapedia 10th-edition CSV exports, convert to JSON, write to `data/game/`. You only need
   the factions in the three lists (Imperial Agents, Astra Militarum) — filter the rest out to
   keep the data small. Document the exact source URLs and the run command in
   `tools/ingest/README.md`.

4. **Rosters.** Encode the three lists in `docs/lists/` as `Roster` JSON in `data/rosters/`,
   referencing `datasheetId`s from the converted data. Where a list names a unit, link it to the
   real Wahapedia datasheet. Flag any unit you can't resolve rather than inventing it.

5. **Terrain layout.** Transcribe **one** labrador.dev layout — the owner's example,
   *GW Chapter Approved 2025–2026, Hammer and Anvil, Terrain Layout 1* — into a `Layout` JSON
   in `data/layouts/`. Board is 60"×44". Read footprint positions off the labrador layout's
   corner-offset measurements; record each piece's polygon and **manually tag its `TerrainType`**
   (labrador does not provide type or height — assume large central/ruin pieces are
   `ruin_blocking`, low pieces `area_cover`; note assumptions in the file). Add objective marker
   positions and the two deployment-zone polygons for Hammer and Anvil.

6. **Board UI.** `Board.tsx` renders the 60"×44" board to scale (define a single
   `INCH_TO_PX` constant). `TerrainLayer.tsx` draws terrain polygons colored by type, plus
   objective markers and deployment zones. `ModelToken.tsx` renders a unit's models as bases at
   correct base size. Support **drag-to-move** a model/unit. `MeasureOverlay.tsx` shows a live
   **base-to-base distance read-out** between a selected model and the cursor (and between two
   selected models). Let the user spawn units from any of the three rosters onto the board.

### Definition of Done (acceptance criteria)
- [ ] `pnpm dev`, `pnpm test`, `pnpm typecheck` all run clean; CI-style green.
- [ ] `core/` imports nothing from React/DOM; `geometry.ts` has passing tests, including a
      base-to-base case (two 32mm bases 2" apart centre-to-centre report ~0.74" gap, not 2").
- [ ] `tools/ingest` converts Wahapedia CSVs → JSON reproducibly via one documented command,
      output committed under `data/game/`, scoped to the two needed factions.
- [ ] All three lists exist as valid `Roster` JSON, every unit resolved to a real datasheet
      (or explicitly flagged as unresolved with a note).
- [ ] The Hammer-and-Anvil layout renders to scale with terrain (type-colored), objectives, and
      deployment zones in the right places.
- [ ] You can spawn units from a chosen roster, drag models, and read an accurate live
      base-to-base distance. No errors in console.
- [ ] Progress Log (below) updated; any assumptions/decisions recorded.

### Explicitly OUT of scope for Stage 1
Combat math (hit/wound/save/damage), line-of-sight, cover, movement legality (Advance/Fall
Back/charge), Deep Strike/Infiltrate rules, abilities/stratagems/Orders/detachment rules,
objective *scoring*, battle-shock, CP economy, save/load, and the AI. Do not start any of these.
Stub their state fields if convenient, but implement no behavior.

---

## 7. Working agreement for each session

- **Start by reading:** this file → `docs/40k_simulator_plan.md` → the relevant list file(s).
- **Verify, don't assume:** run `pnpm typecheck` and `pnpm test` before declaring a task done.
- **Write tests for anything with logic** (geometry first; data loaders next). UI can be lighter.
- **Small, labeled commits.** One coherent change per commit, present-tense message.
- **Record decisions.** When you pick something the plan left open (exact RNG, INCH_TO_PX,
  terrain-type guesses, unresolved units), note it in the Progress Log with a one-line reason.
- **Stay in scope.** If a task pulls you toward combat/abilities/AI or a new dependency, stop
  and flag it — those are future stages with their own acceptance criteria.
- **Hand off cleanly.** End each session by updating the Progress Log: what's done, what's
  half-done, what the next session should pick up, and any blockers.

---

## 8. Roadmap beyond Stage 1 (context only — do not build yet)

- **Stage 2 — Deterministic combat core:** phase/turn state machine, hit→wound→save→damage
  pipeline, universal keyword library, dice log. Validate against a dice calculator.
- **Stage 3 — A real game:** 2D line-of-sight (segment-vs-polygon over terrain footprints) +
  cover, objectives & Primary scoring, CP, movement edge cases, battle-shock. Full 5-round
  human-vs-human game with a final score.
- **Stage 4 — Your lists, faithfully:** the ability/effect hook system, then the 3 detachment
  rules, ~25 stratagems (incl. reactive Displacer Field), AM Orders, and per-unit specials.
- **Stage 5 — AI opponent:** heuristic/utility AI first; optional Claude-driven strategic brain
  later (LLM picks intent/priorities, engine translates to legal measured actions — never let an
  LLM emit raw coordinates).

See `docs/40k_simulator_plan.md` §4–§9 for the reasoning, the line-of-sight decision, and the
ability-system design that these stages depend on.

---

## 9. Progress Log

*(Newest entries at top. Each session appends what it did, decided, and left for the next.)*

- **[2026-06-09] — Real terrain layouts extracted (all 48 GW Chapter Approved 2025-26 maps).**
  Replaces the single approximate Hammer-and-Anvil stand-in with the real data, merged on top of the
  ghost-preview placement work below. All gates green: `pnpm typecheck`, `pnpm test` (51 tests),
  `pnpm build`.

  **Done:**
  - **Extractor** (`tools/layouts/extract-gw-ca-2025.ts`, `pnpm extract:layouts`) — reads the
    GW CA 2025-26 layout data out of labrador.dev's client JS bundle (SvelteKit; no API) and emits
    **48 `Layout` JSON** files to `data/layouts/` (`ca2025-<deployment>-<1..8>.json`): the 6 Strike
    Force deployments (Crucible of Battle, Search and Destroy, Dawn of War, Hammer and Anvil,
    Sweeping Engagement, Tipping Point) × 8 terrain layouts. Source symbols + method documented in
    `tools/layouts/README.md`. No network needed (values embedded verbatim).
  - **Faithful geometry** — reproduces labrador's model exactly: a layout stores half the terrain and
    is mirrored **180° about (30,22)**; each piece is `{feature, point, rotation°, flip}` rendered as
    `point + flipX(rotate(rotation, localFootprintCorner))`. Splits are two adjacent features that
    butt into a clean rectangle (verified: edges coincide): **12×6 = 8×6 grey `z` + 4×6 blue `y`**
    (4" line); **10×5 = 6.5×5 grey `T` + 3.5×5 blue `R`** (3.5" line). grey `#5C6061` ⇒
    `ruin_blocking`/`tall`; blue `#065475` ⇒ `area_cover`/`low`. Composition for layouts 1-6,8 is
    exactly 6×12×6 + 2×10×5 + 4×6×4; layout 7 is a denser GW variant, reproduced as-is.
  - **Deployment zones + objectives per deployment** — zones parsed from the source SVG paths
    (`attacker→player`, `defender→opponent`; Search-and-Destroy's 9" arcs tessellated). Objectives
    taken from the deployment data; every marker is 40mm with a 3" control range
    (`objectiveMarkerDiameterIn`/`objectiveControlRadiusIn` on `Layout`).
  - **Schema** — `TerrainPiece` gained optional `height`('tall'|'low') + `source`; `Layout` gained
    `deploymentId`, `source`, and the two objective fields (all optional, backward compatible).
  - **Core** — added a `SetLayout` intent so the board can switch maps (resets the board).
  - **UI** — `MeasuringBoard` now has a **Map picker** (48 maps grouped by deployment); terrain is
    recoloured grey(ruin)/blue(area) to match GW/labrador; objectives now draw the **3" control ring**
    plus the 40mm marker. `tools/layouts/preview.ts` (`pnpm preview:layouts`) renders a contact-sheet
    `preview.svg` of all 48.
  - **Tests** — `tests/layouts.test.ts` (6 tests) asserts 48 maps, on-board 4-corner footprints,
    grey/blue+height, the objective spec, 180° symmetry, and that the 8 terrain layouts are shared
    across deployments.

  **Decisions:** coords converted to our bottom-left origin via `(x,y)→(x,44−y)` so maps render
  identically to labrador; objective control radius set to 3" (Pariah Nexus / CA range), marker 40mm.
  Only the **Strike Force** deployments were extracted (the user's `-sf-2025` URLs); the source also
  has Incursion (`-inc-2025`) and asymmetric (`-asym-2025`) variants with different objectives — easy
  to add to the extractor's `DEPLOYMENTS` table if wanted later.

  **Handoff:** terrain-layout approximation blocker (below) is **resolved**. Still open: the three
  owned `docs/lists/*.md` rosters. Next: encode those, or start Stage 2 (combat core) per the roadmap.

- **[2026-06-09] — Deployment placement: ghost preview + rotation + formation cycling.**
  Replaced instant-spawn with a "pick up a unit, position it, drop it" flow on the measuring
  board. All gates green: `pnpm typecheck`, `pnpm test` (45 tests), `pnpm build`.

  **Done:**
  - **New pure core module `src/core/formation.ts`** — `formationPositions({anchor, count,
    baseShape, formation, rotation})` returns every model's position. Five strategic shapes
    (`block`/`line`/`column`/`circle`/`wedge`) with `nextFormation` cycling + `FORMATION_LABEL`.
    Each is centred on the anchor (wedge recentres on its model centroid) and rotated around it.
    Framework-free; 9 unit tests in `tests/formation.test.ts`.
  - **Reducer reuses it** — `SpawnUnit` gained optional `formation`/`rotation` and now lays models
    out via `formationPositions` (block/0 default, so old call-sites are unchanged). The old
    bespoke grid in `state.ts` is gone — one layout path, shared by preview and commit.
  - **Board placement mode** (`src/ui/Board.tsx`) — a `Placement` prop drives a translucent,
    dashed **ghost** of the whole unit that tracks the cursor. **Scroll wheel rotates** (15°/notch,
    native non-passive listener so the page doesn't scroll), **`c` cycles formation**, `r`/`R`
    nudge rotation, **click drops**, **Esc cancels**. HUD shows formation + heading + controls;
    measuring is suppressed while placing.
  - **Sidebar** — "+ Spawn" became "+ Place" (toggles to "Placing…"); the held unit's owner
    follows the live "Spawn as" toggle.

  **Decisions:**
  - **Free placement, by request** — no deployment-zone legality, coherency, or base-overlap
    enforcement (those are later-stage rules; the owner asked to place units "wherever they want").
  - Rotation step = 15° (π/12). Formation cycle order is the `FORMATIONS` array order.
  - `clientToInches` now guards a zero-sized `getBoundingClientRect` (pre-layout / jsdom) so it
    can't divide by zero. (jsdom's synthetic `PointerEvent` also drops `clientX`; the smoke test
    fires a `MouseEvent` typed `pointerdown` to carry real coords — a test-env workaround only.)

  **Handoff:** Formation set is easily extended (add to `FORMATIONS` + `localOffsets`). Natural
  follow-ups when Stage 2/3 land: snap/forbid placement outside the deployment zone, coherency
  warnings, and re-placing a unit already on the board. Spawned units still don't persist across
  the board/builder tab switch (pre-existing).

- **[2026-06-09] — Army List Builder (Imperial Agents + Astra Militarum).** Built on a separate
  branch/PR off merged main. All gates green: `pnpm typecheck`, `pnpm test` (37 tests), `pnpm build`.

  **Done:**
  - **Data ingest extended** — now also pulls `Datasheets_models_cost` (points per model-count
    tier), `Datasheets_options` (parsed into lead-in text + `<li>` choices), `Datasheets_unit_composition`,
    `Datasheets_leader`, plus `role` and default `loadout` from `Datasheets`. Added an HTML-stripper.
    Reshaped `enhancements.json` into a typed `Enhancement` (numeric cost). Datasheet type extended
    with `role/loadout/points/composition/wargearOptions/wargearNotes/canLead/canBeLedBy`.
  - **Pure army engine** (`src/core/army.ts`) — `unitCost`/`listPoints`, `validate` (points limit,
    enhancement legality [Character & not Epic Hero, ≤1/unit, ≤3/army, detachment-scoped], datasheet
    copy limits by battle size, Epic-Hero uniqueness, Warlord), pure list edits, and `toRoster()`.
    10 unit tests.
  - **List builder UI** (`src/ui/listbuilder/`, reachable from a new top-nav) — searchable catalog
    grouped by role; add units; model-count tier selector (points-correct); detachment-scoped
    enhancement picker; Warlord; leader attach; wargear-swap selection. Live points bar + validation
    panel. Save to localStorage, export Roster JSON, "Open in board". The board was refactored into
    `MeasuringBoard.tsx` and accepts a built roster.

  **Decisions:**
  - **Wargear is free in 10e** — confirmed from the cost data (tiers are purely "N models"). Points
    come only from unit size + enhancements. Weapon swaps are tracked as advisory loadout choices
    (official option text shown) but never change points. Communicated in-UI and in the README.
  - Wargear swap *limits* (e.g. "1 per 5 models") are natural-language in Wahapedia and are NOT
    hard-enforced — the builder shows the rule text and lets you select; enforcement would need
    hand-curated data (BattleScribe-style). Flagged as advisory.
  - Battle-size copy limits: Incursion 3 Battleline / 2 other, Strike Force 6/3, Combat Patrol
    treated as a 500pt cap. Epic Heroes 0-1. Imperial-Agents *allying* into other armies is not
    modelled (each list is single-faction).
  - The 4 new CSVs are downloaded by `pnpm ingest`; re-run with `REFRESH=1` to refresh.

  **Handoff / possible next:** weapon-swap limit enforcement would need curated data; the board
  could preserve spawned units across tab switches; and the three owned `docs/lists/*.md` are still
  missing (rosters remain empty scaffolds — the builder is now the fastest way to create lists).

- **[2026-06-09] — Stage 1 (Phase 0) implemented: the measuring board.**
  Built the foundation end-to-end. All gates green: `pnpm typecheck`, `pnpm test` (26 tests),
  `pnpm build` all pass, and the production build uses the correct Pages base path.

  **Done:**
  - **Scaffold** — Vite + React 18 + TS (strict) + Vitest. Scripts: `dev/build/test/typecheck/ingest`.
  - **GitHub Pages deploy** — `.github/workflows/deploy.yml` (typecheck→test→build→`deploy-pages`),
    triggered on push to `main` + manual dispatch. Vite `base = /40k-battle-simulator/`.
  - **Pure core** (`src/core/`, imports nothing from React/DOM): `types.ts`, `rng.ts` (mulberry32),
    `geometry.ts` (base-to-base gap, point-in-polygon, vector + base-extent helpers), and
    `state.ts` (intent reducer: SpawnUnit/MoveModel/RemoveUnit/ClearUnits; phases kept as data;
    reactive-window seam acknowledged). Geometry/RNG/reducer unit-tested incl. the 32mm@2"→~0.74"
    acceptance case.
  - **Ingest** (`tools/ingest/convert.ts`, run via `pnpm ingest`) — dependency-free converter that
    downloads the Wahapedia 10e pipe-delimited CSVs, parses stats/weapons/keywords/base sizes,
    filters to **AoI + AM**, and writes typed JSON to `data/game/` (180 datasheets + ability/
    stratagem/enhancement/detachment catalogs + `meta.json`). Documented in `tools/ingest/README.md`.
  - **UI** (`src/ui/`) — `Board` (SVG at `INCH_TO_PX=12`, bottom-left origin via y-flip),
    `TerrainLayer` (type-colored terrain + objectives + deployment zones + 1" grid), `ModelToken`
    (circle/oval bases at true size), `MeasureOverlay` (live base-to-base tape). Spawn from a
    roster, drag models, select one→measure-to-cursor or two→measure-between. State mutates only
    through the core reducer.

  **Decisions made (where the plan left things open):**
  - `INCH_TO_PX = 12`; board renders responsively via SVG `viewBox` + CSS `max-width`.
  - RNG = mulberry32, seeded; injected everywhere (core never calls `Math.random`).
  - Vitest bumped to v3 to match Vite 6 (v2 dragged in a second copy of Vite and broke typecheck).
    pnpm `onlyBuiltDependencies: [esbuild]` committed so CI installs are reproducible.
  - Weapon keywords are taken verbatim from the Wahapedia wargear `description` (source casing is
    inconsistent, e.g. `pistol` vs `PISTOL`) — the Stage-2 keyword library will normalize.
  - Invuln saves stored as bare numbers (Wahapedia gives `5` meaning 5++); `-`/empty ⇒ none.
  - Hull-measured vehicles (`base_size = "Use model"`) get an approximate physical footprint —
    a small curated table + Titanic/Vehicle/Monster/Walker heuristic — so tanks don't render as
    32mm dots. These are rendering approximations (flagged in `data/game/meta.json` warnings),
    NOT rules data.
  - Only non-empty `ability_id` refs captured into `Datasheet.abilityIds`; inline ability *text*
    deferred to Stage 4.

  **Blocked / needs the owner (⚠️ pick up next):**
  1. **The three army-list files were never uploaded.** `docs/lists/{agents_of_imperium_suggested_list,
     grizzled_company_suggested_list,jacks_army_unit_reference}.md` do not exist. The three real
     rosters (`data/rosters/{imperialis_fleet,grizzled_company,bane}.json`) are therefore valid but
     **empty**, each flagged with a `note`. A `_demo_measuring_board.json` roster of real AM units
     exists so the board is usable. **Next session: once the .md lists are provided, encode their
     units** (datasheetId + modelCount + wargear + enhancementId), flagging any unresolved unit.
     Bane's detachment is unset (likely "Siege Regiment" — confirm from the list).
  2. **Terrain layout is an approximation.** ✅ RESOLVED 2026-06-09 — see the top Progress Log entry.
     The stand-in was replaced by all 48 real GW CA 2025-26 layouts, extracted from labrador.dev via
     `tools/layouts/extract-gw-ca-2025.ts`.

  **Handoff:** Foundation is solid and in scope. The next concrete work is (a) drop in the two
  missing inputs above, then (b) begin Stage 2 (deterministic combat core) per the roadmap —
  but only after confirming the owner wants combat next.
