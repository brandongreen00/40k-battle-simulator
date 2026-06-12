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

## 6. STAGE HISTORY — Stage 1: Data & Scaffolding ("the measuring board") — ✅ DONE

> **STATUS (2026-06-09):** Stage 1 is complete, and **Stages 2–4 (Phases 1–3 of the plan) —
> deterministic combat core, a real game (LoS/cover/objectives/scoring/CP/battle-shock/movement),
> and the ability/effect hook system — are now implemented and tested.** See the top Progress Log
> entry for the full breakdown and the remaining work (the three owned lists' *specific* content,
> enforced movement, and Phases 4–5: AI + polish). The task list below is retained as the Stage 1
> record.

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

- **[2026-06-12] — Text-export roster importer CLI + the owner's two real lists, simulated AI-vs-AI.**
  The owner supplied two 40k-app text exports (Bane 985pts / Grizzled Company, Rogue Trader's Army
  985pts / Imperialis Fleet) and asked for AI battles between them. All gates green: `pnpm typecheck`,
  `pnpm test` (**298 tests**, 5 new in `tests/importText.test.ts`), `pnpm build`.
  - **New `pnpm import:roster <export.txt> [--out name]`** (`tools/rosters/import-text.ts`): runs the
    existing pure `parseArmyText` on a saved app export, validates with `army.validate` (errors abort —
    an illegal roster is never written), and emits the same `toRoster` shape the prebuilt builder does
    to `data/rosters/`. Source exports live in `tools/rosters/imports/*.txt` so rosters are reproducible;
    the test suite sync-checks the committed JSON against re-parsing the text (prebuilt-style).
  - **`normalizeExport`**: the owner's Bane paste had lost bullet glyphs on continuation lines
    ("• 1x Bale Eye" then "    1x Laspistol") — the parser would silently drop those wargear counts.
    The CLI re-bullets an indented glyphless "Nx item" line as a sibling of the previous bullet
    (headers reset the carry; intact exports pass through unchanged). Unit-tested.
  - **`data/rosters/bane.json` is no longer an empty scaffold** — it's the real 7-unit list (Yarrick,
    2× Death Korps of Krieg, Artillery Team, Death Riders, Krieg Combat Engineers, Stormlord), 985pts,
    0 import warnings. New `data/rosters/rogue_traders_army.json` (10 units, 985pts, 0 warnings).
    Both now appear in the board's pickers and `pnpm sim --list`.
  - **Sim results** (`pnpm sim -- --rosterA Bane --rosterB "Rogue Trader’s Army" --games 10 --seed 42`,
    hammer-and-anvil-1, balanced vs balanced, sides alternating): **Rogue Trader's Army 9W–1L**,
    avg VP 43.0 : 26.5. All 10 games ended naturally, zero rejected intents/forced advances. Reading:
    consistent with the earlier 84-game finding that bodies win Primary — the Fleet list has ~50 OC-rich
    models across 10 units vs Bane's 7 units with 430pts in one Stormlord. In Bane's one win (seed 47,
    per the round snapshots) it took the objectives first — 10-0 Primary lead by round 2 with the unit
    count even — and stayed ahead to 40 : 25. Full logs in `out/sim/` (gitignored).
  - **Note:** `docs/lists/*.md` still don't exist; these imports are the owner's current app exports
    and serve as the de-facto Bane + Fleet lists. The Grizzled Company roster scaffold remains empty.

- **[2026-06-12] — Owner review #2: movement-wedge fix, unit-level fighting, AI roles + point
  play, per-model visibility, Scouts, pre-battle Leader pairing (Backroom Deals) + Warrant of
  Trade, and an ability audit.** Implements all seven items of the owner's review. All gates
  green: `pnpm typecheck`, `pnpm test` (**293 tests**, 25 new in `tests/review.test.ts`),
  `pnpm build`; sim spot-runs (DW vs Fleet, Cadian vs Krieg, 6 games each) all end naturally with
  zero rejected intents, and a probe game confirms the new Vindicare behaviour (camps its own
  half at 17–24" standoff, kites, never charges) and the home objective staying garrisoned.

  **1 · "Units wouldn't move after Advancing" (bug).** The reducer was sound (regression-tested:
  flags reset at the owner's next turn) — the wedge was a unit left MID-ACTIVATION (`moveMode`
  set, never confirmed: auto-play toggled off between the AI's two move ticks, or "Next phase"
  clicked mid-move). The stale flag survived an entire enemy round and the Movement panel counted
  BOTH sides' open activations, locking the human behind Confirm/Cancel buttons that weren't
  theirs. Fixes: `AdvancePhase` cancels any open activation (models snap back to `moveStart`,
  logged); the panel's `movingUnits` is scoped to the active player. Also `BeginMove` is now
  stage-gated in matches (no battle moves during setup).

  **2 · Unit-level fighting** (`FightUnit` intent, mirrors `ShootUnit`): `planUnitFight` resolves
  EVERY melee weapon sequentially with per-model weapon picks — each model swings ONE melee
  weapon (best profile vs the target by a deterministic mini-EV; multi-profile weapons collapse),
  bearers of the best weapons first, remaining models on the next-best, `[EXTRA ATTACKS]` on top
  — capped by `wargearCounts` carriers. Fight-phase panel shows the fight plan + "⚔ Fight — all
  weapons" (weapon picker stays in the sandbox); the AI fights through the same intent.

  **3/4 · AI roles + playing for points** (`src/core/ai/roles.ts`, research in
  `docs/ai_unit_roles.md`): signal-based classification (sniper/assassin/artillery/gunline/
  battleline/assault/skirmisher/support/transport) drives deployment depth, a per-role standoff
  band (snipers/artillery stay 24–36" out and never charge), objective-pull scaling, and a
  CHARACTER-hunter shooting bonus. The Vindicare infiltrates DEEP instead of midfield. Each
  Movement phase one unit (battleline-first fitness) garrisons the HOME objective with a 3× goal
  boost, and safely-held markers score 0.45×/0.9×-when-threatened (was 0.3×) so units stop
  wandering off points.

  **5 · Visibility:** point LoS was already into-not-through (kept; now pinned by tests incl. the
  two-ruin case). The real leak was unit-level: ONE squad mate peeking let every hidden gun fire.
  Now per-model: only bearers with their own sightline shoot (`resolveAttack` clamps the firing
  count per weapon; `validShootingTargets` mirrors it per-bearer so the AI never plans a dead
  shot).

  **6 · Scouts X"** — new pre-battle step between the first-turn roll and Begin Battle (`setup.step
  'scouts'`): `BeginMove mode 'scout'` budgets X" from the data (converter + committed JSON now
  carry Wahapedia's ability `parameter` — Eversor 9", Kasrkin 6", Sentinels 9"…), `EndMove`
  enforces >9" from enemies and sets `scouted` (not `moved`), first-turn player resolves first,
  attached units need Scouts on every model, `BeginBattle` wipes pre-battle flags. Human flow in
  the DeploymentPanel (Begin/drag/Confirm/Skip), AI via `aiScoutAction`.

  **7 · Pre-deployment Leader pairing + Rogue Trader.** `DeclareFormation` (Declare Battle
  Formations) pairs a Leader entry to a Bodyguard entry BEFORE placement; the pair deploys as one
  merged unit (UI ghost drops both + merges; AI declares pairings as its first setup action) under
  the PAIR's deployment ability: **Backroom Deals** grants the led unit Infiltrators (one per
  army), otherwise abilities require every model (a non-Deep-Strike leader keeps a Terminator
  squad on the board — and the AI's pairing logic avoids such pairs). Leader join positions are
  now zone-legal during deployment. **Warrant of Trade**: once both armies are down, roll D3
  (`UseWarrant`) and pull up to that many IMPERIUM BATTLELINE units back into the deployment flow
  (`WarrantRedeploy`, Reserves allowed); whoActs gates the first-turn roll behind the decision;
  the heuristic AI declines (a future profile knob).

  **Ability audit (7.1)** — `docs/ai_unit_roles.md` §2 tables every ability in the AI pool with
  status. Implemented this pass beyond the above: **Lone Operative** (untargetable by ranged >12"
  unless attached; Vindicare's **Deadshot** ignores it; mirrored in AI EV), **innate Stealth** and
  **innate Feel No Pain X+** read off datasheet abilities (new `fnp_4` effect), **Fights First**
  innate fixed (the old check compared numeric ability ids to words — never matched; the Callidus
  now swings first), **Frenzon** (Advance-then-shoot/charge carve-out, text-matched). Still open
  (documented): Deadly Demise, Firing Deck/transports, Overkill, Shieldbreaker, Acrobatic Escape,
  Lord of Deceit, Soulless Horror/Psychic Assassin, Healing Serum, Screening Line, Shoot Sharp
  and Scarper, squad utility gear (medi-packs/vox/standards).

  **Decisions:** ability parameters were patched into the committed `datasheets.json` with the
  same serialisation the converter writes (117 abilities), and `convert.ts` now captures
  `parameter` so the next full `pnpm ingest` reproduces it; scout-move ORDER between sides is
  soft-enforced for humans (whoActs drives the AI strictly); Warrant order when both sides have
  one = Defender first; the AI declines Warrant redeploys for now; per-bearer LoS counts
  `min(carriers, seeing-bearers)` (which bearer holds which gun isn't tracked); fight-plan weapon
  ranking uses a local deterministic mini-EV (engine can't import ai/evaluate — cycle).

  **Handoff / next:** the three owned `docs/lists/*.md` remain absent (encode + bind specials);
  the ✗ rows of the audit table are the Stage-4 checklist; AI Warrant/Scout policy knobs could
  join `AiProfile`; possible UI nicety — surface "Already moved this turn" reasons inline on the
  board. Known nit: a human-driven scout move for the SECOND side can't box-select (activePlayer
  is the first-turn winner) — the panel's Begin/drag/Confirm flow covers it.

- **[2026-06-12] — Stage 5: the AI opponent. The AI plays the ENTIRE game — team pick, deployment,
  all five phases, vs a human or vs another AI — plus a headless simulator whose logs say who's
  better.** All gates green: `pnpm typecheck`, `pnpm test` (**268 tests**, 26 new across 6 AI test
  files incl. a jsdom test that watches the real UI auto-play into battle), `pnpm build`. An 84-game
  round-robin and profile mirrors ran clean: **every game ends naturally with ZERO rejected intents
  and zero forced advances**.

  **The AI core (`src/core/ai/`, PURE — the plan §7 "Approach A" heuristic/utility AI):**
  - The AI submits the SAME validated intents as the UI (rule #1) and reads legality ONLY through
    `phases.ts` — it cannot produce an illegal state. Stateless: every decision recomputes from
    `GameState`, so it can be stepped, interleaved with a human, or replayed.
  - `controller.ts` — the one seam both the browser and the simulator use: `whoActs(state)` (whose
    decision is the game waiting on — incl. the **Fight phase alternating across BOTH players**,
    and 'shared' for roll-offs) + `aiAction(state, side, profile)` → a batch of intents, each with
    an optional `skipIf` guard re-checked at dispatch (e.g. a melee target died to the first
    weapon) so the engine never rejects an AI intent.
  - `profile.ts` — JSON-serialisable weight sets (`balanced`/`aggressive`/`defensive`/`random`).
    **This is the training surface**: the sim loads tweaked weights from disk, pits them, and the
    winner is kept. `random` is a true wander/uniform-choice baseline (balanced beats it 8-0,
    45.0 : 7.5 avg VP — proof the heuristics carry real signal).
  - `evaluate.ts` — analytic hit→wound→save→damage expectations mirroring `combat.ts` (pool/crit/
    reroll probabilities, Rapid Fire/Melta/Blast/Torrent/Anti-X/Lethal/Sustained/Devastating,
    per-model overkill caps), 2D6 charge odds, points-based unit valuation, whole-unit shooting EV
    from real positions (real fire plan + range/LoS, sampled-point LoS for speed).
  - `deploy.ts` — alternating deployment with the UI's exact entry keys (`side:index`): legal-anchor
    grid search scored by objective pull / role depth (artillery back, melee forward) / spacing,
    Infiltrators (>9″ midfield), Deep-Strike Reserves policy (≤ half the army, no Characters),
    automatic **Leader pairing** via `canAttach`, Reserves fallback so deployment can never stall.
  - `command.ts` — `RunCommandPhase`, then per-Officer **AM Orders** picked by situation (engaged →
    Fix Bayonets!, holding under fire → Take Cover!, out of range → Move! Move! Move!, rapid-fire
    range → First Rank Fire!, else Take Aim!; Grizzled Company issues 2/Officer + the re-roll-1s
    rider) and the **Imperialis Fleet** Eliminate (scariest enemy) / Acquire (objective holder).
  - `move.ts` — two-tick activations (BeginMove → reducer rolls Advance → recompute under the REAL
    budget → one pre-clamped rigid `NudgeUnit` + `EndMove`, so coherency/board/budget can never
    bounce), candidate goals = hold / objectives / standoff approach / kite, scored by objective
    control + shooting EV + threat exposure; engaged units stay or Fall Back by melee trade math;
    never ends a normal move in Engagement Range (binary-search backoff); Deep Strike arrivals
    hunt the best legal >9″ anchor near objectives; coherency-broken units forfeit cleanly.
  - `shoot.ts`/`melee.ts` — EV-ranked target selection (bonus for killing killers, units on
    objectives, finishing units); charges by P(2D6) × melee value vs retaliation with an
    objective-steal bonus; Fight activations: Pile In → every melee weapon → Consolidate.
  - `react.ts` — **reactive plays on the opponent's turn** (rule #3): before an enemy ShootUnit
    resolves, the defender AI may spend 1 CP on Go to Ground/Smokescreen (stealth) when incoming
    EV justifies it. Wired into BOTH the runner and the UI dispatch path (so it reacts to YOU).
  - `match.ts` — seeded deterministic headless runner: full game from `NewBattle` to round 5 with
    per-turn VP/CP/units snapshots, the full dice log, and health counters (rejectedLog,
    forcedAdvances) that the tests pin to zero.
  - **Engine fidelity fix** (also for the human): a unit declares ONE charge per phase —
    `chargeAttempted` flag (match-only), set on success or failure; `eligibleToCharge` reports it.
    Closes the "re-roll a failed charge" exploit from the 06-10 review.

  **Prebuilt teams** (`tools/rosters/prebuilt.ts` → `pnpm build:rosters` → `data/rosters/prebuilt_*.json`):
  six legal 1000pt Incursion lists, validated by `army.validate` at generation AND in tests (sync-
  checked against the committed JSON): **Cadian Bulwark** (Grizzled Company), **Krieg Siege
  Echelon** (Siege Regiment, indirect-heavy), **Armoured Spearhead** (Hammer of the Emperor,
  tanks), **Fleet Boarding Party** (Imperialis Fleet), **Deathwatch Vigil** (Ordo Xenos, elite +
  Deep Strike), **Hereticus Purgation Force** (Ordo Hereticus). No enhancements (no in-game effect
  yet — decision noted in the file).

  **Simulator** (`pnpm sim`, `tools/sim/`): N seeded matches between any rosters/profiles (seats
  alternate board sides), per-game lines + league table, JSONL full-game logs + summary to
  `out/sim/` (gitignored). `--tournament` round-robins every playable roster; `--a/--b` take
  profile names or a JSON weights file; `--list` shows options. First 84-game tournament results:
  Fleet Boarding Party 22-2 (bodies win Primary), tank lists struggle — exactly the kind of
  insight the logs are for.

  **UI:** a **Players bar** on the game rail (match mode only — the sandbox is untouched): each
  side Human or AI with a profile picker, **auto-play** (350ms beat), **Step**, and a live "🤖
  last action" note. Defaults: you = `player`, computer = `ai`. Both sides AI = watchable
  AI-vs-AI. The AI deploys only on its alternating slot (jsdom-tested), and shared roll-offs stay
  human-clickable unless both seats are AI.

  **Decisions:** heuristic AI first per the roadmap (no LLM — that's the optional Stage-5b);
  training = profile-weight comparison through the sim, not ML; AI ignores the sandbox; reserves
  arrive ASAP from round 2; Insane Bravery/Command Re-roll/Counter-offensive/Overwatch not played
  by the AI (no engine binding yet — Overwatch resolution itself is still the open B2 carve-out);
  multi-target charges not declared (single-target only); demo roster left in the sim pool as a
  punching bag (0-24, as expected).

  **Handoff / next:** (1) the three owned lists still need `docs/lists/*.md` → encode + bind their
  specials in `EFFECT_REGISTRY`/`INNATE_ABILITY_EFFECTS`; the AI will use them automatically via
  the same effect ids. (2) Possible AI strengthening, all behind `AiProfile`: screening/charge-bait
  awareness, multi-target charges, smarter CP economy (Counter-offensive once Overwatch/interrupt
  carve-outs exist), per-weapon target splitting if the engine ever supports it. (3) Optional
  Stage-5b Claude-driven strategic brain on top of `whoActs`/`aiAction` (LLM picks among scored
  candidate actions — never raw coordinates, per plan §7). (4) A weight-evolution script over
  `pnpm sim` summaries would close the auto-training loop.

- **[2026-06-11] — 10e mechanics review + fidelity fixes: unit-level shooting, one Leader per unit,
  Leader joins physically, Benefit of Cover corrected, target highlighting.** Owner-requested review
  of the rules core against the 10e Core Rules (Wahapedia). All gates green: `pnpm typecheck`,
  `pnpm test` (**242 tests**, 6 new in `tests/mechanics.test.ts`), `pnpm build`.
  - **Benefit of Cover was implemented backwards** (`combat.ts effectiveSave`): the code capped the
    cover bonus at 3+ for AP'd attacks and let AP 0 improve without limit. 10e rule: +1 to the
    saving throw UNLESS the attack is AP 0 and the model's Save is already 3+ or better. Fixed +
    tests updated (a 2+ save vs AP-1 in cover now correctly saves on 2+; a 3+ save vs AP 0 gets
    nothing).
  - **Unit-level shooting** (`engine.ts planUnitShooting`/`resolveUnitShooting`, new `ShootUnit`
    intent): selecting a unit to shoot now fires EVERY ranged weapon its models carry, resolved
    sequentially (casualties from one weapon are removed before the next fires). Applies: one
    profile per multi-profile weapon (" – standard"/" – supercharge" collapse); the **Pistol rule**
    (a model fires either its Pistol or its other weapons — unit-level simplification: Pistols held
    when the unit has other guns, noted in the log); engaged shooters fire Pistols only (Monsters/
    Vehicles fire everything via **Big Guns Never Tire, now at -1 to hit**, Pistols exempt) and may
    only target a unit within Engagement Range. The Shooting-phase panel shows the fire plan
    (weapon × carriers) and a single "Shoot — all weapons" button; the weapon picker remains for
    the Fight phase / sandbox dice-calculator (`Attack` intent unchanged).
  - **One Leader per unit** (10e Leader rule): `AttachLeader` rejects a second Leader; the
    deployment panel no longer offers already-led bodyguards.
  - **Leader physically joins its unit**: attaching now snaps the Leader's models into base-to-base
    coherency with the Bodyguard (`leaders.ts leaderJoinPositions` — ring search around the unit,
    no overlaps, board-clamped), instead of leaving them wherever they were deployed.
  - **Board target highlighting**: picking an attacker/target in the game panel draws cyan rings on
    the attacker, pulsing red dashed rings on the target, and a dashed firing line between their
    closest models (`Board.tsx targeting` prop, wired via `GamePanel.onTargeting`).
  - **Review notes (unfixed, by scope):** Take Cover! keeps its 3+ cap (order-specific wording to
    re-check against the owned lists); per-model weapon→target split (a unit firing different
    weapons at different targets) not modelled — one target per shooting activation; Precision,
    the Overwatch carve-out (B2 note), and embark/transports still open from prior entries.

- **[2026-06-10] — Mobile (portrait phone) UI overhaul: tabbed layouts, pinch-zoom board, touch
  equivalents for every PC-only interaction.** All gates green: `pnpm typecheck`, `pnpm test`
  (**235 tests**, 7 new in `tests/boardview.test.ts`), `pnpm build`, **28/28 touch checks** in a
  scripted iPhone-13-emulated walkthrough with REAL touch events (CDP) — import → deploy by touch →
  battle — plus the desktop suite re-verified (29/29, zero console errors on both).
  - **Layouts (≤880px):** both views collapse to a single column behind mobile tab bars
    (`.m-tabs`, hidden on desktop). Board view: the board is **sticky under the nav** (always
    visible while the panel below scrolls) with tabs *Units & map / Game* that **auto-follow the
    flow** (roll-off→Game, deployment→Units, battle→Game). List Builder: tabs *My list / Add
    units / Setup* with a live points chip (e.g. `985/1000`). Touch sizing: 42-44px controls,
    15px field fonts (stops iOS focus-zoom), `touch-action: manipulation`, no overscroll.
  - **Board zoom/pan (new `src/ui/boardView.ts`, pure + tested):** the SVG viewBox is now a
    clamped window — **pinch to zoom** (two-finger, start-anchored math), **two-finger/one-finger
    pan** (one-finger pans when zoomed outside Movement/placement), **mouse-wheel zoom** (wheel
    still rotates the ghost while placing), and a +/−/⤢ cluster with a zoom % readout. A second
    finger always cancels game gestures (no accidental box-selects while pinching). Touch hit
    areas: invisible ~2%-of-view hit circles on models (coarse pointers only; mouse stays precise).
  - **Touch equivalents for PC-only actions:** placement on touch is **position-then-confirm**
    (tap/drag the ghost — pre-seeded at view centre — then **✓ Place**; mouse click-to-commit
    unchanged); a control row offers **⟲/⟳ rotate** (replaces scroll), **formation cycle**
    (replaces `C`) and **✕ cancel** (replaces Esc) for ALL devices; Movement gets **"+ add to
    selection"** (replaces Shift) and **"one model"** (replaces Alt-drag) toggles.
  - **Decision: board controls live in a row UNDER the board, never overlaid** — the first mobile
    run proved overlays steal taps exactly where deployment zones sit (bottom/top edges).
  - Files: `Board.tsx` (rework), `boardView.ts` (new), `ModelToken.tsx` (hit areas),
    `MeasuringBoard.tsx`/`listbuilder/ListBuilder.tsx` (tab bars), `styles.css` (media query +
    control row), `index.html` (viewport-fit).
  - **Known mobile nits (deferred):** the sticky board costs ~340px of viewport on short phones;
    measure-to-cursor needs a second model on touch (tap two models to measure); landscape phones
    get the desktop 3-column layout (>880px).

- **[2026-06-10] — All review fixes applied (A1, B1–B6, C1–C5, D1–D3 + E-nits).** Implements every
  fix from the same-day review below. All gates green: `pnpm typecheck`, `pnpm test` (**228 tests**,
  20 new in `tests/fixes.test.ts`), `pnpm build`, plus a 29/29-check scripted re-run of the full
  gameflow against the real dev app (import → deploy → battle → round-5 end) with **zero console
  errors**.
  - **A1 (critical):** `user-select: none` on `body` (inputs/textarea/dicelog re-enabled) +
    `preventDefault()` in the board's pointer-down handlers + an `onPointerCancel` cleanup. Unit
    drags no longer arm a text selection; box-select verified working after confirmed moves.
  - **`GameState.mode: 'sandbox' | 'match'`** (decision): `NewBattle` → `'match'`; the default
    board stays `'sandbox'`. All new rules guards apply ONLY to matches, so the measuring board /
    tests keep the free dice-calculator behaviour.
  - **B1:** `RunCommandPhase` rejected outside the Command phase / when already run this turn
    (`commandRun` flag, reset on turn change); button disabled+labelled. **B2:** `resolveAttack`
    requires Shooting (ranged) / Fight (melee), `resolveCharge` requires Charge, `resolveFightMove`
    requires Fight (match only; Overwatch will need a carve-out later). **B3:** `BeginMove` skips
    already-moved units (logged; movement panel names them and disables Move). Free `MoveModel`
    drags blocked outside an activation in matches. **B4:** `isEntryPlaced` (deployment.ts) counts
    merged Leaders as placed — no re-deploy/duplicate; leader rows + merged rows now side-labelled.
    **B5:** mid-match the sidebar swaps to a "Battle in progress" note (no spawn/remove/clear/
    spawn-as), map picker locked, "New battle" asks for confirmation. **B6:** First-turn switcher
    hidden in matches.
  - **C1 (fidelity):** per-model weapon counts. `UnitInstance.wargearCounts` rides in from the
    roster (Spawn/Deploy/Reserves), survives Leader merge/detach (`attachedLeaders[].wargearCounts`);
    `weaponCarrierCount`/`availableUnitWeapons` (engine) cap attacks at the bearers ("9× Infernus
    heavy bolter: 27 attacks" → "1× …: 3 attacks", verified in-app), reject weapons nobody carries,
    and the weapon picker shows "×N" + the source datasheet for Leader weapons (D2). Multi-profile
    names ("Infernus heavy bolter – heavy bolter") match their base item. Units without loadout
    data (demo/sandbox) keep the old all-models behaviour.
  - **C2:** casualty allocation is now coherency-aware: defensive-wargear bearers still soak first,
    then models die furthest-from-attacker first, skipping any whose removal would disconnect the
    survivors (greedy `casualtyOrder`); damage maps back by model id. EndMove + the movement panel
    name the out-of-coherency unit.
  - **C3:** charge pathing fans out over ±45° around the aim line (sidesteps screens — test
    proves a blocked straight line now succeeds); failure messages distinguish "needed X", rolled Y""
    from "no clear path".
  - **C4:** weapons from datasheets with no alive models / no bearers are filtered from pickers
    (no more "Attack rejected: no models" dead-ends). **C5:** standard deployment now requires
    bases *wholly within* the zone (clearance from interior zone edges; touching the battlefield
    edge stays legal).
  - **D1:** size tiers deduped (first row per size, matching `unitCost`) — the "(AGENTS OF THE
    IMPERIUM Detachment)" rows and "1 models" plural are gone; single-tier sizes render as text.
    **D2:** weapon options keyed/valued by `source|name` (+ `weaponSourceDsId` on the Attack
    intent). **D3:** `MeasuringBoard` now reduces outside React (ref + `setState(next)`) so
    StrictMode's double-invoke can't consume the RNG twice — in-app dice follow the seed again.
  - **E-nits:** "Finish deploying" gated until every unit is placed/reserved (tooltip explains);
    Shooting/Fight weapon pickers filter to the phase's weapon type; "(0 eligible)" no longer
    falls back to listing every unit in matches; final score + winner line when the game ends;
    the free effect-applicator block is retitled "Manual effects (debug)".
  - **Still open** (from the review, by design or deferred): C6 base/terrain overlap, E1 per-unit
    import confirmation, E3 move-budget rings, E5 single-block fight flow, and the Overwatch
    carve-out noted in B2.

- **[2026-06-10] — Deep visual review of the whole gameflow (no code changes).** Drove the real app
  headless (Playwright) through: import of the owner's 985-pt "Rogue Trader's Army" export → list
  builder checks → New Battle (roll-off, alternating deployment, Reserves, Infiltrators, Leader
  merge) → 3 scripted rounds of all five phases (group moves, Advance, Deep-Strike arrival,
  shooting, charges, a melee fight, stratagems, battle-shock) → fast-forward to the round-5 end →
  reload/persistence. ~64 screenshots reviewed; root causes isolated with targeted probes.
  **Full findings: `docs/ui_review_2026-06-10.md`.** Headlines:
  - **CRITICAL (A1):** no `user-select:none`/`preventDefault` on the board → a unit drag arms a
    native text-selection; the next drag becomes a browser drag + `pointercancel` and box-select
    dies for the rest of the session. Fix verified by injecting `body{user-select:none}`.
  - **Missing guards:** Run Command works in any phase and stacks (CP/VP farming); Attack/Charge
    aren't phase-gated; units can move twice; merged Leaders reappear as deployable (duplicate
    risk); sandbox spawn/remove/clear stays active mid-battle; the First-turn switcher resets a
    live game.
  - **Fidelity:** every alive model fires the unit's chosen weapon (27-attack heavy-bolter
    volleys decided every game — per-model loadout is on the roster but unread); front-loaded
    casualty removal breaks coherency (blocked an 8-unit group confirm) and empties Engagement
    mid-fight; charge path search fails on a 10" roll vs sub-10" target (rigid translate).
  - **UI defects:** duplicate React keys (`ListUnitCard.tsx:59` cost tiers — causes the
    "(AGENTS OF THE IMPERIUM Detachment)" size rows; `GamePanel.tsx:323` merged-unit weapon
    names); StrictMode double-invokes the RNG-impure reducer (dev dice diverge from the seed).
  - **Works well:** importer round-trips the export perfectly (985/1000, legal, 0 warnings);
    deployment flow + dice; eligibility messaging; phase/detachment-filtered stratagems incl.
    reactive use on the opponent's turn; the dice log. Suggested fix order is in the doc (§F).

- **[2026-06-09] — Bugfix: saved lists now appear when starting a game; deployment rail no longer
  clips the "ai army" picker.** Two user-reported UI bugs. All gates green: `pnpm typecheck`,
  `pnpm test` (**208 tests**), `pnpm build`.
  - **Saved lists survive a refresh.** The List Builder saves `ArmyList`s to `localStorage`
    (`40k-armylists`), but the board only ever read the on-disk rosters + the single list handed over
    this session via "Open in board" — so after a refresh, saved lists vanished from the army pickers.
    Extracted the localStorage logic into a shared `src/ui/savedLists.ts` (kept OUT of `core/`, which
    stays pure) with `loadSavedRosters(dataIndex)` (converts each saved list via `toRoster`, skipping
    any that fail). `MeasuringBoard` now merges saved rosters into `allRosters`, **deduped by name**
    with precedence *this-session build > saved > on-disk*. `ListBuilder` now imports the same helper
    (one source of truth for the key/shape). Both the deployment picker and the sandbox roster picker
    benefit. New `tests/savedLists.test.tsx` (4 tests) incl. an end-to-end check that a seeded saved
    list shows up in the deployment picker after a fresh mount (== a refresh).
  - **Deployment rail no longer cut off.** The two roster `<select>`s lived in a fixed `1fr 1fr`
    grid whose items default to `min-width:auto`, so on a narrow rail the right ("ai army") column
    overflowed and got clipped. Changed `.dep-rosters` to `repeat(auto-fit, minmax(150px, 1fr))`
    (collapses to one full-width column when there isn't room for two) and added `min-width:0` +
    `width:100%` to the fields/selects. Also added `min-width:0` to `.board-main` so the fixed-width
    right rail can't be pushed off-screen on narrow windows.

- **[2026-06-09] — Multi-charge pathing, true Leader merge, AM Orders + both detachment rules.**
  Closed the three remaining fidelity items. All gates green: `pnpm typecheck`, `pnpm test`
  (**204 tests**), `pnpm build`.
  - **Multi-target charge pathing** — `resolveCharge` takes `targetUnitIds[]` and *searches* for a
    legal coherent move (≤ 2D6) that ends within Engagement Range of **every** declared target while
    **not** ending within Engagement Range of a non-target enemy; declaration is rejected past 12".
    `GamePanel` Charge phase gets a multi-target checklist. (Path search is a 1-D scan along the
    aim direction; rigid translate keeps coherency. Single-target back-compat via `targetUnitId`.)
  - **True Leader merge (one unit instance)** — `AttachLeader` now MERGES the Leader's models into
    the Bodyguard (each tagged with `ModelInstance.datasheetId`); the Leader instance is removed.
    The merged unit renders each model at its **own base**, fires weapons from **both datasheets**
    (only the source datasheet's models count — `engine.unitWeapons`), uses **per-model** W/Sv/invuln
    (`defenderProfileFor`) and OC (`ocModels`), and moves/targets as one. `DetachLeader` splits it
    back out. *Simplification:* the wound roll uses the primary (Bodyguard) Toughness.
  - **AM Orders + detachment rules** —
    - The six **Orders** (`core/orders.ts`): Take Aim!, Fix Bayonets!, First Rank Fire! (+1 Attack to
      Rapid Fire, via new `EffectOutput.extraAttacks`), Take Cover! (+1 Save cap 3+, via `saveBonus`),
      Move! Move! Move! (+3" budget in `BeginMove`), Duty and Honour! (+1 OC in `ocModels`, +1 Ld in
      the Battle-shock test). **Voice of Command**: `phases.orderableUnits` = REGIMENT within 6", not
      Battle-shocked. `GamePanel` Command phase issues them per Officer.
    - **Grizzled Company (Ruthless Discipline)**: issuing an Order also grants **re-roll Hit 1s**.
    - **Imperialis Fleet (At all Costs)**: Command-phase **Eliminate** (mark an enemy: +1 to be hit)
      / **Acquire** (your unit on an objective: **5++**, +1 OC/Ld). Both via small effect ids.
  - **To exercise Orders in the UI** you need an **Officer** (Voice of Command) + REGIMENT units in
    the loaded list — build one in the List Builder (the empty owned rosters still have no units).
  - **Still open:** the per-unit *special* abilities (Yarrick's Will of Iron, Death Korps Medi-pack,
    Stormlord Firing Deck, etc.) and the ~25 *named* detachment stratagems' mechanical effects — these
    need the owned `docs/lists/*.md`; the effect/registry seams are ready (one line each).

- **[2026-06-09] — Fidelity pass: fight pile-in/consolidate, leaders move together, battle-shock dice.**
  Closed three of the gaps the previous entry left open. All gates green: `pnpm typecheck`,
  `pnpm test` (**192 tests**), `pnpm build`.
  - **Fight phase moves** — `engine.resolveFightMove` + the `FightMove` intent: **Pile In** and
    **Consolidate** move a unit up to **3" toward the nearest enemy** (coherency-preserving rigid
    translate, capped at base contact). `GamePanel`'s Fight block shows the **activation order**
    (Fights First then alternating) with each unit's fought/charged state, plus Pile In / Consolidate
    buttons. So a fight now reads: pick the unit → Pile In → resolve melee → Consolidate.
  - **Leaders move together** — selecting a unit for movement now also selects its **attached Leader /
    Bodyguard** (drag-box or click), so an Attached unit moves as one. (Targeting protection was
    already in via `isLeaderProtected`.)
  - **Battle-shock dice** — `runCommandPhase` records a `BattleShockReport[]` (unit, 2D6, Ld,
    pass/fail) on the state; the Command-phase panel renders the **2D6 as dice**.
  - **Still open (next):** multi-target charge pathing / not ending in a non-target's ER; a true
    single-activation Leader+Bodyguard *merge* (they're linked + move together, but still two unit
    instances); AM **Orders** + the 3 **detachment rules** + per-unit specials (need `docs/lists/*.md`).

- **[2026-06-09] — A playable game: deployment → all five phases, deeply programmed for the AI.**
  Turned the Measuring Board into an actual 10e game flow. The whole game-logic layer is **pure,
  framework-free, and AI-callable** (the explicit goal: an AI just calls functions). All gates green:
  `pnpm typecheck`, `pnpm test` (**190 tests**), `pnpm build`.

  **New pure-core modules (the AI's function library):**
  - `setup.ts` — roll-off (Attacker/Defender + first turn, re-rolls ties).
  - `deployment.ts` — deployment-zone legality, **Infiltrators** (>9" from enemy zone/models),
    **Deep Strike arrival** (battle round 2+, >9" from enemies), `deployAbilityFromKeywords`.
  - `leaders.ts` — `canLead`/`canBeLedBy` resolution both directions (e.g. **Rogue Trader → Imperial
    Navy Breachers**), `eligibleLeaderIds`/`eligibleBodyguardIds`.
  - `coherency.ts` — the 2" rule + the **7+-model two-neighbour rule** + single-group connectivity.
  - `phases.ts` — the per-phase **legality/targeting query layer**: `eligibleToShoot/Charge/Fight`
    (Advanced/Fell-Back/engagement, Big Guns Never Tire, Pistols, Aircraft), `validShootingTargets`
    (unit-to-unit "any model sees any model + in range", Indirect Fire), `chargeTargets`,
    `fightActivationOrder` (Fights First then alternating from the non-active player),
    `isLeaderProtected`, `unitCoherency`/`unitCentroid`, `reservesArrivable`.
  - `stratagems.ts` — `Stratagem` type, the **11 universal CORE_STRATAGEMS**, and pure filters
    (`usableStratagems`/`phaseMatches`/`turnMatches`); reactive (`turn:'opponent'`) stratagems are
    usable on the opponent's turn (rule #3). The loader merges in the **100 detachment stratagems**
    from the data.
  - `geometry.ts` — `distancePointToSegment/Polygon`, `clampToRange`.

  **Reducer (`state.ts`) — Stage('setup'/'battle'/'done') + SetupState, and new intents:**
  `NewBattle, RollRoles, SetAttacker, DeployUnit` (zone-validated), `PlaceInReserves, AttachLeader,
  DetachLeader, RollFirstTurn, BeginBattle, BeginMove, NudgeUnit` (incremental, budget-clamped),
  `MoveModel` (now clamps to M" from the move origin), `EndMove` (**rejects if a unit is out of
  coherency**), `CancelMove`, `ArriveFromReserves`. `closestAxis` charge move below.

  **Engine — charge now resolves into Engagement Range** (rigid translate toward the target, capped
  by the 2D6 roll, preserves coherency, marks `charged`+`moved`).

  **UI:**
  - **Deployment** (`DeploymentPanel.tsx`, `Dice.tsx`): assign a roster per side, **roll off with SVG
    dice** for Attacker/Defender and first turn, alternating zone-limited placement (the ghost turns
    **red and refuses illegal drops** outside the zone / <9" for Infiltrators), **attach Leaders**
    (eligible bodyguards only), place units in **Reserves** (⤓), Begin Battle.
  - **Movement** (`Board.tsx` + `GamePanel.tsx`): **drag-box select** (Shift adds), **group move**
    of selected units (rigid, budget-clamped; Alt+drag reshapes one model), **coherency warning
    triangles** over offending units, **Confirm disabled until coherency is restored**; Move/Advance/
    Fall Back/Remain; **Deep Strike arrivals** (round 2+) via a >9"-gated ghost.
  - **Shooting/Charge/Fight** (`GamePanel.tsx`): the attacker picker lists only **phase-eligible**
    units (with the reason when not), the target picker lists only **valid targets** (LoS+range /
    within-12" / engaged) — all driven by `phases.ts`.
  - **Stratagems** (`GamePanel.tsx`): pick a side (reactive use on the opponent's turn); lists **Core
    + that side's detachment** stratagems for the current phase, greys out unaffordable, spends CP.

  **Decisions:**
  - Roll-off **winner = Attacker**; **Defender deploys first** (mission-pack order); a separate roll
    decides first turn — both shown as dice (the user asked for "two rolls").
  - **New Battle** flow vs. the free **sandbox**: the old measuring board (free `+ Place`, any side)
    is preserved as `stage:'battle'` so all prior tests/behaviour stay green; "⚔ New battle" enters
    `stage:'setup'`. `createInitialState` still defaults to `'battle'`.
  - **Group move = rigid translate** (coherency-preserving by construction); coherency breaks — and
    the warning triangle appears — when individual models are dragged (Alt) or models clamp unevenly
    at the board edge/budget. The confirm gate (`EndMove`) enforces it for real.
  - **Any unit may go to Reserves** (Strategic Reserves); arrival uses the 9" Deep-Strike rule for
    all of them (documented simplification). Deep Strike auto-detected from the resolved ability names.
  - **Stratagems spend CP + log** by default (the long-tail mechanical effects need the owned lists,
    per `effects.ts`); a few Core ones carry an `effectId` that applies to the selected target.

  **Handoff / what's left (honest gaps):**
  1. **Charge declaration vs. legality detail.** The charge moves into ER, but doesn't yet verify the
     path avoids non-target enemies' ER or that it can reach *every* multi-charge target — single-target
     charges are faithful; multi-target pathing is the next refinement.
  2. **Fight phase pile-in/consolidate (3") aren't positional moves yet** — fights resolve via the
     `Attack` intent and `fightActivationOrder` gives the order, but the UI doesn't yet walk the
     alternating activation or move models 3". 
  3. **Leaders move/are-targeted together only partially** — attaching links them and hides the leader
     from targeting (`isLeaderProtected`); the bodyguard's move doesn't auto-drag the leader (select
     both with the drag-box). A true single-activation merge is the faithful next step.
  4. **Battle-shock has no dice popup** (it logs the 2D6); Orders (`IssueOrder`) and the detachment
     rules still need the owned `docs/lists/*.md` to enumerate (engine + effect seam are ready).
  5. The three owned lists are **still absent** — the importer/builder remain the way to load a list.

- **[2026-06-09] — Wargear: cap-aware options, a team importer, and loadout-driven saves.**
  Implements the three requested deliverables. All gates green: `pnpm typecheck`, `pnpm test`
  (**143 tests**), `pnpm build`.

  **1. Real wargear options (`src/core/wargear.ts`, PURE).** Parses a datasheet's free-text
  `wargearOption.text` into a numeric **cap** on how many models may take it, honouring the
  "for every N models, up to M" ratio — so a 10-strong Deathwatch Kill Team correctly allows
  **4** thunder hammers (2 per 5), **2** at 5 models. `unitWargearOptions(ds, modelCount)` returns
  UI-ready options (cap + the trackable items, sharing one pool); `validateUnitLoadout` enforces
  the caps and is wired into `army.validate`. Loadouts are now an **item→count map** (`Loadout`,
  e.g. `{"Deathwatch thunder hammer": 4}`) — the same granularity the app's export uses — replacing
  the old `Record<groupIdx,string[]>`. The Options UI (`ListUnitCard`) is now **+/− steppers** per
  item with live per-item ceilings and an over-cap warning. Verified the parser on **all 358** real
  options (no anomalies).

  **2. Team importer (`src/core/importer.ts`, PURE + `ImportPanel.tsx`).** `parseArmyText(text, deps)`
  rebuilds an `ArmyList` from the official 40k app's text export (the task's exact format): army
  name / faction / detachment / battle size from the header; each unit resolved to a real datasheet;
  **model count inferred** from the model-group bullets (nesting-aware, so single-model units →
  1, "1 Sgt + 9 Veterans" → 10, the 4-model Entourage → 4); **per-item loadout** (incl. the 4
  thunder hammers and the shields); Warlord and Enhancement captured. Unresolvable units/enhancements
  are returned as **warnings, never invented** (scope rule #6). Tested against the full task example
  (10 units incl. duplicate Breachers) end-to-end through `validate` + `toRoster` → 0 errors, points
  985.

  **3. Loadout-driven saves (`combat.ts` / `engine.ts` / `state.ts`).** `ModelInstance` gained
  `wargear?: string[]`; `SpawnUnit` pins defensive wargear onto distinct front models; the engine's
  `defenderProfileFor` reads each model's wargear → per-model invuln/save; and the combat save step
  was **restructured into a per-model allocate→save→damage loop** (`DefenderModel` gained
  `invuln`/`save`) so a shield-bearer rolls its own **4++**. Equivalent to the old aggregate math
  for uniform units (the combat Monte-Carlo test is unchanged); new `saves.integration.test.ts`
  proves shield units survive high-AP fire far better. Shields baked into a datasheet's *default*
  loadout (e.g. one Navis Armsman's Endurant Shield) are recovered by `resolveWargearCounts` and
  ride on the exported `Roster.wargearCounts` into the board.

  **Decisions:**
  - **Loadout granularity = item→count**, matching the app export. Multi-weapon "combo" choices
    (e.g. "boltgun **and** Astartes shield" vs "power weapon **and** Astartes shield") collapse to
    their single trackable item (the shield); the other half is a generic default weapon and the
    export doesn't preserve the combo either. Consistent with the prior "wargear swaps are advisory"
    stance.
  - **Generic-only swaps are not tracked/enforced.** When an option's only distinguishing items are
    base weapons (power weapon / chainsword / bolt pistol…), its count can't be told apart from a
    model's default loadout, so the option is dropped from the steppers + validation (avoids false
    "over-cap" positives against default-weapon counts). The meaningful upgrades (special weapons,
    shields) are non-generic and fully enforced.
  - **Defensive wargear table** (`DEFENSIVE_WARGEAR`): Astartes/Endurant/storm/boarding/brute shields
    → 4++. Best-effort 10e readings flagged as assumptions — the *mechanism* (per-model loadout →
    per-model save) is the deliverable; the exact numbers are one-line data edits.
  - Only **defensively-relevant** wargear is pinned to specific live models (each on its own model,
    front-packed); other wargear has no in-game effect yet, so it's left off the models to avoid
    crowding shields out, but the full counts persist on the Roster.

  **Handoff / what's left:** weapon-swaps that change a model's *offensive* profile still aren't
  applied in combat (the engine fires one chosen weapon for the whole unit — pre-existing). Natural
  next step: let the engine read per-model weapons from `ModelInstance.wargear` so a thunder-hammer
  model fights with the hammer. The three owned `docs/lists/*.md` are still absent; the importer is
  now the fastest way to load a real list. Multi-profile model points (Entourage tiers) snap to the
  stated points but per-sub-model loadout isn't modelled separately.

- **[2026-06-09] — Stages 2–4 (Phases 1–3) combat engine implemented: deterministic combat core,
  a real game, and the ability/effect hook system.** Owner explicitly authorised starting Phases 1–3
  (CLAUDE.md rule #6) and said to skip the 3 owned lists + tank-size approximations for now. All
  gates green: `pnpm typecheck`, `pnpm test` (**126 tests**), `pnpm build`.

  **Phase 1 — deterministic combat core (`src/core/`):**
  - `dice.ts` — dice-notation parser/roller (`N`, `DN`, `MDN`, `DN±K`) on the injected RNG.
  - `keywords.ts` — parses the universal 10e weapon abilities out of Wahapedia's inconsistently-cased
    keyword strings into a structured `ParsedKeywords` (Rapid Fire/Melta/Sustained/Lethal/Devastating/
    Anti-X/Blast/Torrent/Heavy/Pistol/Ignores Cover/Lance/Precision/Indirect/Hazardous/Twin-linked/…).
  - `combat.ts` — the full **hit→wound→save→damage** pipeline with criticals, re-rolls, the 10e wound
    chart, AP/cover/invuln save resolution, Devastating (no-save) wounds, FNP, −1 Damage, and no
    cross-model spill. Returns a step-by-step dice log. Validated by a **Monte-Carlo test vs analytic
    expectation**.
  - `engine.ts` — builds combat profiles from datasheet data (injected via `EngineContext`, not
    imported — same DI seam as the RNG), derives range/half-range/long-range from real model positions,
    applies casualties back to the unit, and logs.
  - `state.ts` — Pariah Nexus **turn/phase/round sequencer** (`AdvancePhase`, alternating turns, ends
    after round 5), `SetFirstPlayer`, `SetUnitStatus`, and the `Attack` intent. Per-unit `status` flags
    + `startingModels`; an event/dice `log` on `GameState`.

  **Phase 2 — a real game:**
  - `los.ts` — the **2D segment-vs-polygon line of sight** (plan §5) with the Ruins carve-out, plus
    cover from intervening/area terrain. Documented as the deliberate centre-to-centre simplification.
  - `objectives.ts` — OC-based objective control + Pariah Nexus **Primary scoring** (5/obj, 15/turn,
    50 cap). `battleshock.ts` — below-half detection + 2D6 Ld test. `movement.ts` — move/advance/
    fall-back distances, **2D6 charge**, **Deep Strike 9″** legality.
  - engine wiring: LoS+cover now **gate shooting** (Indirect Fire is the exception, at −1 to hit + forced
    cover), `runCommandPhase` (+1 CP → Battle-shock tests → Primary scoring; battle-shocked units count
    OC 0), `resolveCharge`, and `objectiveControl`. New intents: `Charge`, `RunCommandPhase`.

  **Phase 3 — ability/effect hook system (`effects.ts`):**
  - A **generic effect engine** (the §6 design): the combat pipeline hard-codes no specific rule;
    before each attack the engine gathers the `EffectOutput`s of every active effect on attacker
    (offensive) and target (defensive) and merges them into the `CombatSituation`
    (`gatherAttackModifiers`). Adding an ability is ~a registry entry.
  - A curated `EFFECT_REGISTRY` of mechanically-correct building blocks (Take Aim!/Fix Bayonets!,
    re-roll 1s, +1 wound, granted Lethal/Sustained/Ignores-Cover, −1 Damage, FNP 5/6, Stealth,
    Displacer-Field 4++) and `INNATE_ABILITY_EFFECTS` seam for datasheet specials.
  - New intents `IssueOrder` + `UseStratagem` with a **CP economy** and **reactive timing** — stratagems
    are not gated by the active player, so a Displacer-Field-style save buff fires in the opponent's
    turn (architecture rule #3). Active effects expire on the unit's next turn reset.

  **UI:** `GamePanel.tsx` (new right rail) surfaces the whole core — round/phase/turn controls,
  `Run Command`, the **CP + VP scoreboard**, attacker/weapon/target pickers with **Resolve attack** /
  **Charge**, an Order/Stratagem applier, and the **live dice log**. It dispatches the same intents the
  tests use; the board reducer now injects the datasheet `EngineContext`.

  **Decisions:**
  - Hit/Wound modifiers clamped to ±1 (10e); criticals read the *unmodified* die; default crit on 6.
  - **Devastating Wounds** modelled as the current rule (no save allowed, normal damage, FNP applies) —
    not mortal wounds. **Benefit of Cover** caps at 3+ unless AP 0 (Core rule).
  - LoS/cover is centre-to-centre single-point (fast, deterministic, competition-style); base-edge
    sampling is a noted later refinement.
  - Attacks assume every alive attacker model carries the chosen weapon (per-model wargear isn't tracked
    yet); `attackerCount` can override. A Phase-1 simplification, flagged for when rosters carry loadouts.

  **Handoff / what's left:**
  1. **The three owned lists + their *specific* content.** The engine + the *universal* effect set are
     done, but the named detachment rules, ~25 stratagems, AM Orders, and per-unit specials (Yarrick's
     Will of Iron, Death Korps Medi-pack, Stormlord Firing Deck, etc.) still need the `docs/lists/*.md`
     files to enumerate. Each binds to `EFFECT_REGISTRY`/`INNATE_ABILITY_EFFECTS` in ~1 line. Tank-size
     approximations also still deferred per the owner.
  2. **Movement is math + flags, not enforced placement.** Drag is still free (prior owner decision);
     `movement.ts` exposes the legality/distance helpers but the UI doesn't yet snap/forbid moves or
     enforce coherency. Embark/disembark and Fall-Back/Advance interactions are stubbed via status flags.
  3. **Secondary missions, save/load, and the AI (Phases 4–5)** are untouched per the roadmap.

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
