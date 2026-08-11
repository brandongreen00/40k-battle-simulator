# v2 simulator — architecture

The v2 simulator (`sim2/`) is independent of the original TypeScript project.
It exists because the brief asks for something the v1 board cannot become
incrementally: a rules-as-data engine that plays complete 11th edition matched
play games between two lists, at a level worth improving by search and self-play.

```
sim2/
├─ rng.py            seeded RNG service — the ONLY source of randomness
├─ geometry.py       continuous 2D + height: bases, polygons, sightline sampling
├─ schema.py         versioned records with provenance (datasheets, effects, layouts…)
├─ loader.py         data2/ → typed index; the kernel never reaches past it
├─ log.py            versioned battle log — the replay viewer's whole input
├─ effects/          the effect interpreter
│  ├─ selectors.py   selector algebra + parser
│  ├─ predicates.py  the predicate registry (unknown predicates raise)
│  └─ interpreter.py trigger bus + modifier stack → AttackMods / UnitMods
├─ kernel/           the rules; knows no faction
│  ├─ state.py       GameState / UnitState / ModelState (cheap snapshot for search)
│  ├─ measure.py     engagement cylinder, coherency, memoised distances
│  ├─ visibility.py  Obscuring / Solid / cover / Hidden / detection
│  ├─ movement.py    move modes, charges, fight moves, ingress
│  ├─ attacks.py     hit → wound → allocate → save → damage
│  ├─ shooting.py    fire plans and shooting types
│  ├─ fighting.py    melee weapon assignment, pile in, consolidate
│  ├─ objectives.py  OC control, terrain objectives
│  ├─ missions.py    dispositions, primaries, secondaries, VP caps
│  ├─ orders.py      the Voice of Command subsystem
│  ├─ stratagems.py  CP economy and usage limits
│  ├─ legal.py       legal-action enumeration
│  └─ engine.py      phase machine + action application
├─ agents/           random, heuristic, search (scaffold)
└─ harness/          batch runner, optimizer, post-game analysis
```

## The three rules that shape everything

**1. The kernel knows no faction.** Every datasheet ability, stratagem,
enhancement, detachment rule and Order is an `EffectRecord` in `data2/`, and the
interpreter folds the matching ones into a modifier bundle the kernel reads.
Adding a rule is a data edit in `tools2/bindings.py`. Hardcoding one into kernel
source is a design violation.

**2. Randomness has exactly one source.** `sim2/rng.py` is a SplitMix64 stream
injected into the engine. `tools2/lint_determinism.py` fails the build if
anything else under `sim2/` touches `random`. That is what makes
`(lists, layout, seed)` replay byte-identically.

**3. Agents choose; they never construct.** `kernel/legal.py` enumerates the
legal actions and `Engine.apply` re-validates the chosen one. The count of
refused actions is published in every batch artifact, so "the engine is legal"
is a measurement rather than a claim.

## The one honest approximation in enumeration

Model positions are continuous, so "every legal destination" is uncountable.
Movement and placement are enumerated over a goal-directed candidate set
(objectives, enemies, a compass fan). The engine still validates any continuous
destination, so a search or RL agent may propose off-lattice moves — the
enumeration is a representative finite cover, not the definition of legality.

## Data flow

```
Wahapedia wh40k11ed  ──ingest_wahapedia.py──►  data2/datasheets.json
                                              data2/effects_ingested.json
                                              data2/detachments.json
Event Companion layouts (repo extraction) ──┐
mission dossier ────────────────────────────┼─build_data.py─►  data2/layouts/
tools2/bindings.py (primitive bindings) ────┘                  data2/missions.json
                                                               data2/effects.json
                                                               data2/armies/
                                                               data2/gaps.json
                                                                    │
                                        sim2.cli / GitHub Actions ──┴─► results/*.json
                                                                          │
                                                    tools2/sync_results.py │
                                                                          ▼
                                                        public/results/ → Auto Player
```

## Why the Pages app cannot run the engine

GitHub Pages serves static files. The engine is Python. So the app does the
three things a static page *can* do: build the exact command for you, dispatch a
`workflow_dispatch` run to GitHub Actions with a token you paste at runtime
(kept in browser storage — committing a token is prohibited), and replay the
committed JSON artifacts. Heavy runs (large batches, RL training) belong on a
local machine through the same CLI and emit the same artifacts.
