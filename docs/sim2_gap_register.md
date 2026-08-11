# v2 simulator — gap register

**Audience:** a planning agent with no prior context on this codebase. This
document is self-contained: it explains what exists, then lists every known gap
with evidence, file locations, impact and acceptance criteria.

Everything marked *measured* was produced by running the code on 2026-08-11, not
estimated. Commands to reproduce each measurement are given.

---

## Part 1 — Orientation

### What the system is

A Warhammer 40,000 **11th edition** matched-play simulator that plays complete
games between two army lists. It is "v2": a Python engine (`sim2/`) plus a
versioned data snapshot (`data2/`), independent of the repository's older
TypeScript measuring board. Its browser surface is the **Auto Player** tab of
the existing React app (`src/ui/autoplayer/`), which cannot run the engine —
GitHub Pages serves static files only — so it configures runs, reads committed
JSON artifacts, and replays battle logs.

v1 (TypeScript: measuring board, list builder, Combat Patrol) is untouched and
still works. Do not refactor v1 to serve v2; they share no code by design.

### Repository map (v2 only)

```
sim2/                     the engine (Python 3.11, standard library only)
  rng.py                  the ONLY source of randomness (SplitMix64, seeded)
  geometry.py             continuous 2D + height: bases, polygons, LoS sampling
  schema.py               record types (Datasheet, EffectRecord, Layout, …)
  loader.py               data2/ -> typed DataIndex; kernel never reads past it
  log.py                  versioned battle log (the replay viewer's only input)
  effects/
    selectors.py          selector algebra + parser, e.g. unit(INFANTRY & !engaged)
    predicates.py         predicate registry; unknown predicates RAISE
    interpreter.py        folds effects into AttackMods / UnitMods
  kernel/                 the rules; contains no faction content
    state.py measure.py visibility.py movement.py attacks.py shooting.py
    fighting.py objectives.py missions.py orders.py stratagems.py
    unit_actions.py legal.py engine.py datacache.py dice.py actions.py
  agents/                 base.py (random), heuristic.py, search.py (MCTS scaffold)
  harness/                run.py (batches), optimizer.py, analysis.py
  cli.py                  python3 -m sim2.cli {data,armies,play,batch,optimize}

tools2/
  ingest_wahapedia.py     HTML -> data2/datasheets.json, effects_ingested.json,
                          detachments.json  (the scraper/parser)
  bindings.py             printed rules text -> effect primitives (hand-authored)
  build_data.py           layouts, mission cards, matrix, armies, effects.json
  sync_results.py         results/ -> public/results/ + index.json for the app
  lint_determinism.py     fails if anything but rng.py touches randomness

data2/                    the immutable snapshot (committed)
tests_py/                 pytest suite (conftest, geometry, attacks, effects,
                          data, engine)
results/, public/results/ run artifacts (batches, optimizer, battle logs)
train.py                  self-play loop scaffold
STATUS.md                 end-of-run status; reviews/ per-area adversarial reviews
docs/sim2_architecture.md architecture narrative
```

### How to run anything

```bash
python3 -m sim2.cli data       # snapshot coverage counts
python3 -m sim2.cli armies     # the 5 generated sample armies
python3 -m sim2.cli play  --a "Alien Hunters Strike" --b "Siege Regiment Vanguard" \
                          --battle-size 500 --seed 1 --out results/logs/x.json
python3 -m sim2.cli batch --a A --b B --games 20 --battle-size 500
python3 -m sim2.cli optimize --faction AM --vs "Alien Hunters Strike" --candidates 20

python3 -m pytest tests_py -q -m "not slow"   # ~0.2s, 50 tests
python3 -m pytest tests_py -q                 # + 7 full-game tests, ~90s
python3 tools2/lint_determinism.py
pnpm typecheck && pnpm test && pnpm build     # front end (534 tests)
```

Re-ingesting data is a two-step refresh (raw HTML is NOT committed; it lives in
a scratch directory and must be re-fetched from `https://wahapedia.ru/wh40k11ed/…`):

```bash
python3 tools2/ingest_wahapedia.py --raw <dir-of-fetched-html> --out data2
python3 tools2/build_data.py
```

### Invariants that must not be broken

These are architectural commitments from the brief. A plan that violates one is
wrong even if it passes tests.

1. **The kernel knows no faction.** Faction content is `EffectRecord` data in
   `data2/effects.json`, bound to primitives in `tools2/bindings.py`. Writing a
   unit's rule into `sim2/kernel/*.py` is a design violation.
2. **One RNG.** All randomness flows through `sim2/rng.py`; `tools2/lint_determinism.py`
   enforces it. Determinism is what makes replays and the search agent possible.
3. **Agents choose; they never construct.** `kernel/legal.py` enumerates legal
   actions; `Engine.apply` re-validates. Batches publish a count of refused
   actions, currently 0 — that number must stay 0.
4. **Transcribe, never reconstruct.** No rules value from memory or a prior
   edition. A value the source does not carry becomes an entry in
   `data2/gaps.json` with `what` / `why` / `attempted`.
5. **Provenance on every record**: pack version + retrieval date for rules,
   MFM version for points.

### Current measured state (baseline for any plan)

| Thing | Value |
|---|---|
| Datasheets ingested | 179 (46 Imperial Agents, 133 Astra Militarum); 78 flagged Legends |
| Detachments | 16, all with correct Force Disposition + DP (pinned by test) |
| Effect records | 175 total; **19 bound** to primitives (13 stratagems, 6 Orders) |
| Mission cards | 26 primaries (25 with scoring blocks), 18 secondaries (**2** with blocks) |
| Layouts | 45 Event Companion layouts, 3 per disposition pairing |
| Logged gaps | 189 in `data2/gaps.json` |
| Illegal actions | 0 across random + heuristic full games |
| Heuristic vs random | 20–0 (100%), avg VP 57.7 : 43.8 |
| Speed | ~8 s per 500 pt game, ~40 s per 1000 pt game |

---

## Part 2 — The gap register

Each gap: **what exists → what's missing → evidence → where → why it matters →
done when**. Severity is my judgement of impact on simulation fidelity.

---

### A. Data fidelity — the highest-impact cluster

These are parser defects in `tools2/ingest_wahapedia.py`. They are cheap to fix
and each one silently degrades every game played. **A1–A4 should almost
certainly be the first work done.**

#### A1 — Invulnerable saves are missing from 178 of 179 datasheets 🔴 critical

* **Exists:** `ModelProfile.invuln` field, and the save resolution in
  `sim2/kernel/attacks.py::_best_save` correctly takes the better of armour and
  invulnerable.
* **Missing:** the ingester never finds the value. It searches the block text for
  the phrase `"INVULNERABLE SAVE"`, but Wahapedia renders it as a separate
  markup block: `<div class="dsInvulWrap"><div class="dsCharInvulText">INSV</div>
  <div class="dsCharInvul">…`.
* **Evidence (measured):** `sheets with invuln parsed: 1` out of 179.
  Reproduce: `python3 -c "import json;d=json.load(open('data2/datasheets.json'));
  print(sum(1 for x in d if any(m.get('invuln') for m in x['models'])))"`
* **Where:** `tools2/ingest_wahapedia.py::parse_profiles` (the `m_inv` regex).
* **Why it matters:** every Terminator, character, assassin and daemon-hunting
  unit is fighting without its invulnerable save. Combat outcomes — and therefore
  every VP number, win rate and optimizer ranking — are systematically wrong
  against high-AP weapons.
* **Done when:** invulns are parsed from `dsInvulWrap`; a test asserts a known
  value (e.g. Callidus Assassin) and that the count of sheets with an invuln is
  in the expected range; the asterisk footnotes that exclude specific models
  (trap §6.9 — e.g. cyber-mastiffs) are captured as text.

#### A2 — Core abilities are inert on every unit 🔴 critical

* **Exists:** the kernel honours Deep Strike, Infiltrators, Scouts, Lone
  Operative, Stealth, Feel No Pain, Fights First, Leader, Deadly Demise via
  `UnitState.innate_abilities` / `has_ability`, populated by
  `sim2/loader.py::innate_abilities_for`.
* **Missing:** the ingester stores the datasheet's core-ability line under the
  single key `"CORE"` with a comma-separated value (`"Deep Strike, Fights First,
  Infiltrators, Lone Operative"`). `innate_abilities_for` iterates ability *keys*
  looking for names like `DEEP STRIKE`, sees only the literal key `CORE`, and
  returns nothing.
* **Evidence (measured):** 148 of 179 sheets carry a `CORE` line, containing
  Leader ×34, Deep Strike ×13, Infiltrators ×11, Scouts ×15, Lone Operative ×9,
  Stealth ×9, Feel No Pain ×7, Fights First ×2, Firing Deck ×8, Deadly Demise ×84.
  Yet `[x['name'] for x in d if any('DEEP STRIKE' in k.upper() for k in x['ability_text'])]`
  returns `[]`.
* **Where:** `tools2/ingest_wahapedia.py::parse_abilities` (capture) and
  `sim2/loader.py::innate_abilities_for` (interpretation).
* **Why it matters:** no unit can Deep Strike, Infiltrate, Scout, benefit from
  Stealth or Feel No Pain, or be a Leader. Reserves are effectively random
  placement, and roughly a third of the two factions' distinguishing rules do
  nothing.
* **Done when:** the `CORE` and `FACTION` lines are split into individual
  abilities with their parameter (`Scouts 6"` → name `SCOUTS`, value 6); a test
  asserts the Callidus Assassin has Deep Strike + Lone Operative + Infiltrators
  and that a Chimera has Firing Deck with its number.

#### A3 — Multi-profile datasheets collapse to one statline 🟠 high

* **Exists:** `Datasheet.models: List[ModelProfile]`, and
  `state.new_unit_from_datasheet` already assigns the first profile to the first
  model and the last profile to the rest.
* **Missing:** the parser produces exactly one profile for every sheet.
* **Evidence (measured):** `sheets with >1 model profile: 0` out of 179 — yet
  many squads print a sergeant/leader line plus a trooper line.
* **Where:** `tools2/ingest_wahapedia.py::parse_profiles` and `_profile_names`
  (the `dsProfileName` regex never matches, so profile boundaries are wrong).
* **Why it matters:** squad leaders lose their better statlines; the Toughness
  used for the whole unit is derived from a single profile, so
  `attacks._target_toughness` (majority Toughness) can never disagree with it.
* **Done when:** a known multi-profile sheet parses into ≥2 profiles with
  correct names, and `new_unit_from_datasheet` is verified to build the printed
  composition.

#### A4 — Transport capacity is never parsed 🟠 high

* **Exists:** `Datasheet.transport_capacity`, and it is consumed by nothing yet
  (see C1 — transports are unimplemented).
* **Missing:** the regex grabs the wrong region; the Chimera comes out with
  capacity 0 and `transport_text` containing an unrelated Orders sentence.
* **Evidence (measured):** `with transport capacity: 0` of 179.
* **Where:** `tools2/ingest_wahapedia.py::parse_transport`.
* **Why it matters:** blocks C1 entirely, and Astra Militarum is a
  transport-heavy faction.
* **Done when:** the Chimera and other transports carry their printed capacity
  and the full transport text, including the "cannot transport X" exclusions and
  the Kill Team "counts as 2" clause.

#### A5 — Points are not reconciled against the Munitorum Field Manual 🟠 high

* **Exists:** per-copy points tiers with the dual-column trap handled (Eversor
  100 army-faction / 110 assigned-agent) and escalating squadron costs (third
  Hellhound 135). Every points record carries provenance.
* **Missing:** the brief's §6.1 hierarchy makes the **MFM app the sole authority
  for points**; ours come from the Wahapedia faction pages. Phase D2
  reconciliation was never performed, and the named open item (Sanctifiers) is
  unverified.
* **Where:** new work; `PointsTier.column` and `Provenance.mfm_version` already
  exist in `sim2/schema.py`.
* **Why it matters:** list legality and every optimizer ranking are built on
  points. A systematic error invalidates the optimizer's output.
* **Done when:** every points figure is confirmed against MFM v1.2, each
  discrepancy is logged with both values and the chosen authority, `mfm_version`
  is stamped on points records, and Sanctifiers has a recorded finding either
  way.

#### A6 — Datasheet abilities are text, not bound effects 🟡 medium (large)

* **Exists:** 563 named ability texts captured verbatim across the 179 sheets;
  the effect ontology and interpreter are in place.
* **Missing:** none of them are expressed as effect primitives, so no datasheet
  ability does anything mechanically.
* **Where:** `tools2/bindings.py` (add entries), `data2/datasheets.json` (source
  text), `sim2/effects/interpreter.py` (extend primitives only if genuinely
  needed — extension is a kernel change requiring its own tests).
* **Why it matters:** this is the long tail of faction identity. It is large but
  perfectly parallelisable: each ability is a data edit plus a test.
* **Done when:** a chosen tranche (suggest: every ability on the datasheets used
  by the five sample armies) is bound, with per-ability tests, and any ability
  that cannot be expressed is logged as a mandatory ontology-extension task
  rather than skipped.

#### A7 — Hull-based vehicle footprints are estimates 🟢 low

* **Exists:** `BaseShape(kind="hull", rx, ry)` and a fallback of 2.0 × 3.5 inches.
* **Missing:** 77 model profiles use that flagged estimate rather than a measured
  hull.
* **Where:** `tools2/ingest_wahapedia.py::parse_base`.
* **Why it matters:** affects engagement, coherency and objective range for
  vehicles — real but second-order compared with A1–A4.
* **Done when:** each hull vehicle has a sourced or measured footprint, or an
  explicit `GAP` entry carrying the estimate and its basis.

---

### B. Missions and scoring

#### B1 — 16 of 18 secondary missions score nothing 🔴 critical

* **Exists:** the secondary deck is drawn, held and discarded correctly; VP caps
  (45 primary / 45 secondary / 10 Battle Ready) are enforced.
* **Missing:** only 2 of 18 secondaries have scoring blocks. The other 16 sit in
  hand and never pay out.
* **Evidence (measured):** `secondaries with no scoring:` A Grievous Blow, A
  Tempting Target, Assassination, Beacon, Bring It Down, Burden of Trust, Centre
  Ground, Cleanse, Defend Stronghold, Display of Might, Engage on All Fronts,
  Forward Position, Outflank, Overwhelming Force, Plunder, Secure No Man's Land.
* **Where:** `tools2/build_data.py::SECONDARY_BLOCKS` (the binding table) and
  `sim2/kernel/missions.py::EVALUATORS` (the evaluator vocabulary).
* **Why it matters:** a whole 45 VP scoring axis is dead. Games are decided by
  primary + Battle Ready alone, which distorts every win rate and every
  optimizer verdict.
* **Done when:** every secondary either has an evaluator binding or a `GAP`
  entry naming the mechanic it needs; the caps are exercised by a test.

#### B2 — Secondary card names carry markdown artifacts 🟢 low (trivial)

* **Evidence:** card names include the literal string
  `"A Grievous Blow — **FIXED-capable**"`.
* **Where:** `tools2/build_data.py::SECONDARY_RE` / `build_secondaries`.
* **Why it matters:** the name is the id source and is shown in the UI; the
  Fixed-capable flag should be parsed into `fixed_capable`, not left in the name.
* **Done when:** names are clean and `fixed_capable` is set from the marker.

#### B3 — Operation markers and card-reverse Actions are unimplemented 🟠 high

* **Exists:** an Actions subsystem (`sim2/kernel/unit_actions.py`) with
  eligibility rules, start/complete lifecycle and void-on-move.
* **Missing:** no mission card drives an Action, and there is no operation-marker
  state. 32 primary cards have printed VP lines that could not be mapped —
  overwhelmingly the "trapped terrain area", "place an operation marker",
  "sanctify" style clauses.
* **Evidence (measured):** 32 `scoring block` gap entries in `data2/gaps.json`;
  heuristic-vs-heuristic runs **12–0** to the Purge the Foe side against
  Disruption, because Disruption's deck scores mainly through trapped areas.
* **Where:** `sim2/kernel/missions.py` (evaluators + marker state),
  `sim2/kernel/unit_actions.py` (the Action records), `tools2/build_data.py`
  (mapping the printed lines).
* **Why it matters:** whole dispositions are unable to score their cards, so
  matchup results are not comparable and the mission matrix is unbalanced in a
  way that is an artifact, not a rule.
* **Done when:** operation markers are state, the card-reverse Actions are
  records, the Disruption deck scores, and a heuristic mirror across all five
  dispositions produces no lopsided pairing attributable to unmapped clauses.

#### B4 — Mission card text is a community transcription 🟡 medium

* **Missing:** card text comes from the repository's research dossier
  (`docs/11e_missions.md`, sourced from a fan transcription), not the printed
  Chapter Approved deck, and the Event Companion FAQ rulings were never ingested.
  One mission named by the layout pages has no card text at all.
* **Where:** `tools2/build_data.py::build_missions`.
* **Done when:** card text is verified against the printed deck, each
  discrepancy recorded with both values, and the FAQ rulings (especially
  operation-marker removal edge cases) are ingested.

#### B5 — Fixed secondary mode is unexercised 🟢 low

* **Exists:** `PlayerState.secondary_mode` supports `"fixed"`, and
  `init_secondaries` picks the first two Fixed-capable cards.
* **Missing:** nothing selects the mode (the CLI always uses Tactical), the
  20 VP per-card Fixed cap is not enforced, and the once-per-battle 1 CP
  mulligan / discard-for-1CP mechanic is absent.
* **Where:** `sim2/kernel/missions.py`, `sim2/harness/run.py`, `sim2/cli.py`.

---

### C. Rules coverage

#### C1 — Transports, attached units and aircraft are not implemented 🔴 critical

* **Missing entirely:** core rules 18 (Transports: embark, all three disembark
  modes, emergency disembark hazard cascade, Firing Deck), 19 (Attached Units:
  Leader attachment, keyword/ability propagation, Bodyguard, the 01.02.01
  half-strength math for attached units), 23 (Aircraft).
* **Evidence:** no `embark`/`disembark` action kinds exist in
  `sim2/kernel/actions.py`; `UnitState.embarked_in` and `transporting` are
  declared but never set by any code path.
* **Where:** new modules under `sim2/kernel/`, plus action kinds in
  `actions.py`, enumeration in `legal.py`, and validation in `engine.py`.
* **Why it matters:** Astra Militarum is built around Chimeras and Leaders
  attached to squads; Imperial Agents around Inquisitors leading retinues. Lists
  containing them are being simulated as if those rules did not exist. Depends
  on A4 (transport capacity) and A2 (Leader as a core ability).
* **Done when:** the §4.7 checklist items are implemented with tests, including
  the emergency-disembark hazard cascade and the surviving-character
  below-half-strength worked example from 01.02.01.

#### C2 — Fight-phase activation does not alternate between players 🟠 high

* **Exists:** Fights First priority is enforced *within* each army
  (`engine.next_to_fight`).
* **Missing:** core rules 12 alternates activations between players; this engine
  gives the whole Fight phase to the active player. Counteroffensive's "must be
  the next unit selected" ordering therefore has nothing to attach to.
* **Where:** `sim2/kernel/engine.py` (`next_to_fight`, `fight_order`,
  `advance_phase`), `sim2/kernel/legal.py::_fight_actions`, and `Engine.to_act`
  which currently always returns the active player.
* **Why it matters:** melee trades resolve in the wrong order; the non-active
  player never gets fight-phase agency. This is the largest remaining
  turn-structure divergence.
* **Done when:** `to_act` can return the non-active player during the Fight
  phase, alternation is tested, and Counteroffensive can be bound.

#### C3 — Reactive windows have no plumbing 🟠 high

* **Exists:** the timing-window vocabulary is in the schema; several core cards
  (Fire Overwatch, Rapid Ingress, Heroic Intervention, Counteroffensive) are
  ingested with `opponent_*` windows and have primitive bindings authored.
* **Missing:** the engine never offers a decision to the non-active player, so
  none of those windows can actually fire. The trigger bus
  (`Interpreter.triggers`) exists but is not called from the phase machine.
* **Where:** `sim2/kernel/engine.py` (phase transitions), `legal.py`
  (enumeration for the reacting player), `effects/interpreter.py`.
* **Why it matters:** it is the difference between "the data models reactions"
  and "reactions happen". Shares its core change with C2 (`to_act`).
* **Done when:** at least Fire Overwatch and Heroic Intervention fire in a real
  game, with a test that asserts the reacting player was offered the choice.

#### C4 — Move and fight sub-modes are not offered as choices 🟡 medium

* **Fall Back:** the Ordered Retreat vs Desperate Escape choice is not offered;
  Desperate Escape currently fires only for Battle-shocked units
  (`sim2/kernel/movement.py::_desperate_escape`).
* **Consolidation:** the three modes (Ongoing / Engaging / Objective) are not
  offered; the engine always performs an Engaging-style consolidation
  (`movement.consolidate`).
* **Overrun fights (12.06):** not implemented — a unit engaged at the start of
  the Fight phase but no longer engaged gets no activation.
* **Where:** `sim2/kernel/movement.py`, `fighting.py`, `legal.py`.
* **Done when:** each mode is an enumerated choice and the §7 fixtures (overrun
  drags a fresh unit in; Engaging consolidation forces an unfought enemy to be
  selected) pass.

#### C5 — Shooting-type fidelity is partial 🟡 medium

* **Missing:** Indirect Fire's 11e hit floor (unmodified 1–5 fails, 1–3 if
  stationary with a spotter) is not modelled — Indirect weapons currently shoot
  as normal at unseen targets; Plunging Fire is detected but only applied to
  [BLAST]; the Hazardous "pure MONSTER/VEHICLE takes 3 MW" test is coarser than
  the printed wording.
* **Where:** `sim2/kernel/shooting.py`, `sim2/kernel/attacks.py::_hazard`,
  `visibility.plunging_fire`.

#### C6 — Muster rules are partial 🟡 medium

* **Missing:** the **Detachment Points budget per battle size** was never
  ingested from core rules §25 (per-detachment DP cost *is* ingested); detachment
  mutual-exclusion tags (RECON, ABHUMAN) are parsed opportunistically and are
  currently empty on every detachment; enhancement limits (max four at Strike
  Force, named-character and assassin ineligibility) are not enforced; the
  Assigned Agents ally table (1/1/1 · 2/2/1 · 3/3/2 by battle size) is not
  implemented; multi-detachment armies are not supported (`Army.detachments` is
  a list but only the first is used).
* **Where:** `sim2/harness/optimizer.py` (legality), `sim2/schema.py::Army`,
  `sim2/loader.py::always_on_records`, `tools2/ingest_wahapedia.py`
  (`_attach_exclusion_tags`).
* **Why it matters:** the optimizer can currently generate rosters that a
  tournament would reject.

#### C7 — Effect bindings cover 19 of 175 records 🟠 high (large)

* **Measured:** bound/total by kind — stratagems **13/97**, enhancements
  **0/54**, detachment rules **0/16**, Orders 6/6, army rules 0/2.
* **Where:** `tools2/bindings.py`.
* **Note:** unbound stratagems are deliberately *not* offered as legal plays
  (spending CP for no effect would be worse), so this shows up as agents having
  fewer options rather than as wrong behaviour.
* **Done when:** a tranche is bound with tests. Highest value first: the
  detachment rules of the two headline detachments, then the enhancements that
  modify Orders, then the remaining core stratagems.

---

### D. Agents and AI

#### D1 — The heuristic does not play its own mission 🟠 high

* **Exists:** transparent scoring over objective proximity, analytic expected
  damage, overkill capping, charge probability, threat exposure
  (`sim2/agents/heuristic.py`, weights in a `Weights` dataclass).
* **Missing:** it plays objectives generically. It does not read
  `PlayerState.primary_mission` or the secondary hand, so it never plays toward
  the specific card it is scoring.
* **Why it matters:** this is the largest single strength gain available, and it
  is a prerequisite for the search and RL agents being worth training.
* **Done when:** mission-aware scoring exists and a heuristic-vs-heuristic batch
  shows the mission-aware variant beating the current one decisively.

#### D2 — The random baseline is not naive 🟡 medium

* **Context:** movement candidates in `kernel/legal.py::_move_targets` are
  goal-directed (toward objectives, toward enemies, plus an 8-point compass fan).
  `RandomAgent` therefore samples "sensible" destinations. The 100% win rate
  against it is real but easier than a truly uniform baseline would be.
* **Done when:** a uniformly-sampled destination set exists (even as an agent
  option), and the exit metric is re-measured against it.

#### D3 — The search agent is a scaffold 🟡 medium

* **Exists:** `sim2/agents/search.py` — rollouts from cloned states with the
  heuristic as rollout policy, picking the best average VP differential; UCB
  helper present.
* **Missing:** a real tree (no node expansion or backpropagation beyond one
  ply), no time budget, no transposition handling. At ~40 s per 1000 pt game it
  is not affordable at useful depth (see E1).
* **Done when:** MCTS with proper selection/expansion/backprop and a wall-clock
  budget beats the heuristic over a batch.

#### D4 — RL training is a smoke run only 🟡 medium (stated scope)

* **Exists:** `train.py` — a working loop with a replay buffer, a `PolicyValue`
  seam and a linear policy over the heuristic's weights; writes
  `results/training.json`.
* **Missing:** state/action tensor encoding, a neural policy-value head, and any
  actual training scale. **The brief scopes this out deliberately: "RL to
  strength is a multi-day compute job".** Keep it scoped out unless the owner
  asks otherwise — it is gated on E1 anyway.

#### D5 — Post-game analysis is shallow 🟢 low

* **Exists:** `sim2/harness/analysis.py` attributes VP swings to decisions by
  comparing VP before/after a window.
* **Missing:** it does not compare the chosen action against the alternative the
  heuristic or search preferred, which is what the brief asks for; it is not
  wired into the CLI or the UI.

---

### E. Performance

#### E1 — ~40 s per 1000-point game blocks everything above it 🟠 high

* **Measured:** ~8 s per 500 pt game, ~40 s per 1000 pt game, single-threaded.
  A 100-game batch at 1000 pts is over an hour; 2000 pt games are untested at
  scale.
* **Already done:** memoised unit distances and visibility against a geometry
  epoch (`kernel/measure.py::bump_epoch`), bounding-box rejection in
  `geometry.segment_crosses_polygon`, a centre-line fast path in
  `visibility.model_visible`, and terrain outlines simplified to ≤24 vertices.
  These took a 1000 pt game from >120 s to ~40 s.
* **Remaining hot spots:** line-of-sight sampling and the legality checks inside
  `movement._furthest_legal` (a 7-step binary search, each step doing an O(models²)
  overlap test), plus re-enumeration of legal actions after every single action.
* **Options for the plan:** vectorise sightlines with numpy (allowed by the
  brief); cache enumerations per phase and invalidate on the geometry epoch;
  spatial hashing for overlap tests; multiprocessing in the batch runner (games
  are independent and seeded, so this is safe).
* **Done when:** a 1000 pt game runs in a few seconds and a 100-game batch fits
  comfortably in a GitHub Actions job.

---

### F. Product surface and operations

#### F1 — Sample armies are generated, not real lists 🟡 medium

* **Exists:** five sample armies built by `tools2/build_data.py::_fill_army`
  (a greedy fill: cheapest character, battleline spine, then whatever fits).
* **Missing:** they are not the owner's lists and are not tournament-shaped.
  There is no importer for the 40k app's text export into the v2 `Army` schema
  (v1 has one at `tools/rosters/import-text.ts`, for the old schema).
* **Done when:** the owner's real lists exist as `data2/armies/*.json`, ideally
  via an importer, and are validated against the muster rules of C6.

#### F2 — The Auto Player cannot browse the data snapshot 🟢 low

* **Exists:** run configurator, results dashboard, replay viewer, coverage
  counts.
* **Missing:** no way to inspect datasheets, effect records, gaps or the mission
  matrix in the browser — which is where the 189 gaps and 156 unbound rules would
  become visible to the owner rather than living in JSON.

#### F3 — Result artifacts are duplicated in the repository 🟢 low

* **Context:** `tools2/sync_results.py` copies `results/` into `public/results/`
  so Vite ships it. Both trees are committed, so artifacts are stored twice and
  every run produces a churny diff.
* **Options:** commit only `public/results/`, or generate the copy at build time
  and gitignore it.

#### F4 — The GitHub Actions workflows are unexercised 🟡 medium

* **Exists:** `.github/workflows/simulate.yml`, `optimize.yml`, `sim2-tests.yml`,
  and the Pages deploy runs `sync_results.py`.
* **Missing:** none has ever run — the branch has not been merged to `main`, and
  the workflows dispatch against `ref: main`. The token-dispatch path from the
  Auto Player has not been tested end to end.
* **Done when:** each workflow has run green once and the dispatch button has
  been exercised with a real fine-grained token.

---

### G. Verification debt

#### G1 — Layout transcription was not re-verified at region level 🟡 medium

* **Context:** the 45 Event Companion layouts are converted from this
  repository's earlier vector/visual extraction, with page numbers preserved in
  each layout's provenance. The brief mandates crop-and-inspect verification of
  visual extractions; that was **not** re-performed in this session.
* **Additional caveat:** outlines were simplified to ≤24 vertices within 0.35" of
  the traced footprint for tractable line-of-sight (recorded in provenance).
* **Done when:** each layout region is cropped from a render of the companion
  page and checked against the transcription, and the simplification tolerance is
  confirmed acceptable or tightened.

#### G2 — Most §7 scenario fixtures are not implemented 🟠 high

The brief lists 19 named scenario fixtures. Implemented: double-1 charge (1),
Monte-Carlo damage vs analytic (18), determinism (19), per-copy points tiers and
the dual column (12), Take Cover!'s 3+ cap (14, partial), objective control
ordering (16, partial). **Not implemented:** ground-floor ruin LoS at ≤3" vs 4"
(2), the engagement-cylinder charge at ≤5" vs 6" up (3), Ceaseless Cannonade (4),
overrun/Engaging consolidation chaining (5), emergency disembark cascade (6),
Hidden 16"/15" and Gone to Ground 13"/12" thresholds (7), the attached-unit
half-strength example (8), Rapid Ingress vs a reactive move (9), out-of-phase
exclusion (10), Insane Bravery / mutual-exclusion lockouts (11), Reinforcements!
rulings (13), Extremis surcharge legality (15), Desperate Escape stacking (17).

* **Where:** `tests_py/`.
* **Why it matters:** these encode known adjudications. Several of them (2, 3, 7)
  would test code that already exists, so they are cheap and would either
  validate or falsify the terrain and engagement implementations today.

#### G3 — Mutation testing covers one subsystem 🟢 low

* **Exists:** `tests_py/test_attacks.py::test_wound_table_mutation_is_caught`.
* **Missing:** the brief asks for ≥1 deliberate-bug mutation check per rules
  subsystem (movement, visibility, objectives, missions, stratagems).

---

## Part 3 — Suggested sequencing (rationale, not prescription)

**Wave 1 — make the numbers mean something (small, high leverage).**
A1 invulnerable saves, A2 core abilities, A3 multi-profile statlines, A4
transport capacity, B2 secondary card names. All are parser fixes in one file,
each independently testable. Until these land, every measured outcome — win
rates, optimizer rankings, agent comparisons — is built on wrong statlines.
Re-run the heuristic-vs-random batch afterwards and expect the numbers to move.

**Wave 2 — restore the missing scoring axis.**
B1 secondary evaluators, then B3 operation markers and card-reverse Actions.
Together these unblock a 45 VP axis and remove the artificial 12–0 disposition
skew, which is currently the biggest distortion in matchup results.

**Wave 3 — the turn-structure divergences.**
C2 fight alternation and C3 reactive windows share one change (`Engine.to_act`
must be able to return the non-active player). Doing them together avoids
touching the phase machine twice. C4 move/fight sub-modes follows naturally.

**Wave 4 — the units the factions are actually built around.**
C1 transports and attached units (gated on A2 and A4). Large, but Astra
Militarum without Chimeras and Leaders is not really Astra Militarum.

**Wave 5 — coverage and correctness debt, parallelisable.**
C7 effect bindings and A6 datasheet abilities are both "data edit + test" work
that many agents can do concurrently. G2 scenario fixtures should be interleaved
here — several test existing code and may surface defects for free.

**Cross-cutting, start early if anything above is slow to verify:** E1
performance. Everything is measured by playing games; at 40 s per 1000 pt game,
each verification loop is expensive, and D3/D4 are gated on it outright.

**Independent of the above:** A5 MFM points reconciliation (fetch-and-compare
work, no code dependencies) and F1 real army lists — both make the optimizer's
output trustworthy rather than illustrative.

---

## Part 4 — Guardrails for whoever executes the plan

* Do not put faction rules in `sim2/kernel/`. Bind them in `tools2/bindings.py`.
  If a rule cannot be expressed, extending the primitive vocabulary in
  `sim2/effects/interpreter.py` is legitimate — but it is a kernel change and
  needs its own tests, and the extension must be logged.
* Do not invent a rules value. If the source does not carry it, add a `GAP` entry
  (`data2/gaps.json`, written by the ingest/build tools) with `what`, `why`,
  `attempted`, and optionally `estimate` + `basis`.
* Keep the refused-action count at zero. If the enumeration offers something the
  engine then refuses, the enumeration is the bug — not the agent.
* Keep randomness in `sim2/rng.py`; `tools2/lint_determinism.py` will fail the
  build otherwise, and every replay depends on it.
* Re-run `python3 -m pytest tests_py -q` (including the slow full-game tests) and
  the front-end suite before declaring anything done. The tests that matter most
  are the ones that play whole games, because that is where the last five real
  bugs were found.
* After changing anything in `data2/`, re-run `python3 tools2/build_data.py` and
  `python3 tools2/sync_results.py` so the snapshot and the published app stay
  consistent.
