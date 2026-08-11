# STATUS — Warhammer 40,000 11th edition simulator (v2)

Single end-of-run report, per autonomy mandate 7. Everything below is measured
or read from source; where something is incomplete it says so.

**Built:** a fully independent v2 simulator — Python rules kernel, versioned
data snapshot ingested from source, effect interpreter, agents, harness,
optimizer, and a static **Auto Player** surface in the existing React app
(top bar → *Auto Player*) that configures runs, reads result artifacts and
replays battle logs.

The v1 project (TypeScript measuring board, list builder, Combat Patrol) is
untouched and still works. v2 shares nothing with it but reference data.

---

## 1. What is in place

| Stage (§10) | State | Where |
|---|---|---|
| 0 — schemas + core-rules ingestion | ✅ | `sim2/schema.py`, `data2/` |
| 1 — geometry, movement, terrain/LoS | ✅ | `sim2/geometry.py`, `sim2/kernel/{movement,measure,visibility}.py` |
| 2 — attack sequence + core abilities | ✅ | `sim2/kernel/attacks.py` |
| 3 — phase machine, stratagems, actions | ✅ engine; ⚠️ Actions unused by cards | `sim2/kernel/{engine,stratagems,unit_actions}.py` |
| 4 — transports, attached units, aircraft | ❌ not implemented | — |
| 5 — faction ingestion + effect coverage | ✅ ingested; ⚠️ 19/175 records bound | `tools2/ingest_wahapedia.py`, `tools2/bindings.py` |
| 6 — missions, dispositions, layouts, scoring | ✅ | `sim2/kernel/missions.py`, `data2/layouts/` |
| 7 — agents A/B | ✅ random + heuristic; search scaffold | `sim2/agents/` |
| 8 — harness + optimizer | ✅ | `sim2/harness/` |
| 9 — search/RL scaffolding | ✅ scaffold + smoke run | `sim2/agents/search.py`, `train.py` |
| 10 — control plane + Pages app | ✅ | `src/ui/autoplayer/`, `.github/workflows/` |

Reviews (mandate 2b): [`reviews/rules-kernel.md`](reviews/rules-kernel.md) ·
[`reviews/data-ingestion.md`](reviews/data-ingestion.md) ·
[`reviews/agents-and-harness.md`](reviews/agents-and-harness.md)

### Data snapshot (`data2/`, ingested 2026-08-11 from Wahapedia `wh40k11ed`)

* **179 datasheets** (46 Imperial Agents, 133 Astra Militarum), 78 flagged Legends
* **16 detachments** — every Force Disposition and DP cost matches the brief's
  verified strip exactly, including **Imperialis Fleet = Reconnaissance**
* **175 effect records** (97 stratagems, 54 enhancements, 16 detachment rules,
  6 Orders, 2 army rules) with printed text + provenance; **19 bound** to effect
  primitives, the rest text-only and listed as gaps
* **45 Event Companion layouts**, 3 per disposition pairing, with typed
  objectives and dense/light terrain areas
* **44 mission cards** and the full asymmetric 5×5 disposition matrix
* **193 logged `GAP` entries** — nothing was guessed

---

## 2. Metrics

| Metric | Target (§8) | Measured |
|---|---|---|
| Illegal actions, random agent, full game | 0 | **0** (`test_random_agent_plays_a_legal_game`) |
| Illegal actions, 12-game heuristic batch @500pts | 0 | **0** (`results/batch.json`) |
| Illegal actions, 1000pt game | 0 | **0** (`test_thousand_point_game_is_legal`) |
| Determinism: same seed → same game | byte-identical | **✅** (`test_battle_log_replays_identically`) |
| Heuristic beats random | >95% | **met — 20 wins, 0 losses, 0 draws (100%)** over 20 games, avg VP 57.7 : 43.8 (`results/heuristic_vs_random/batch.json`) |
| Batch + optimizer produce dashboard artifacts | yes | **✅** `results/batch.json`, `results/optimizer.json` |
| Tests | — | **56 passing** (`pytest tests_py`, incl. 7 full-game), **534** front-end (`pnpm test`) |
| Speed | — | ~8s per 500pt game, ~40s per 1000pt game |

---

## 3. RULING: entries (interpretations made under mandate 1)

1. **`RULING:` Snap Shooting (15.09) is engine behaviour, not a Stratagem record.**
   The brief lists it among the eleven core Stratagems; the source page prints it
   as a shooting-type card with no CP cost, referenced by Fire Overwatch. It is
   implemented as a shooting mode; the other ten core cards are records.
2. **`RULING:` Fight-phase activation does not alternate between players.**
   12.x alternates activations; this engine gives the Fight phase to the active
   player and enforces Fights First priority *within* each army. The conservative
   half (priority) is kept; the alternation is a known simplification.
3. **`RULING:` a move action means "advance toward this point as far as legal".**
   Positions are continuous, so an enumeration cannot list every destination. The
   engine resolves the furthest legal end position along the path, which is what
   a player does at the table, and never silently teleports a unit.
4. **`RULING:` point-in-polygon treats a point exactly on an edge by the crossing
   rule.** Every rules query that cares about the boundary measures a base radius
   against the edge distance instead, so the ambiguity cannot reach a rule.
5. **`RULING:` an ingested Stratagem with no primitive binding is not offered as
   a legal play.** Playing it would spend CP for no effect. It stays in the data
   and in the coverage report so the gap is visible.
6. **`RULING:` terrain outlines are simplified to ≤24 vertices within 0.35"** of
   the traced footprint (recorded in each layout's provenance). Line of sight is
   tested against every edge; the raw organic outlines made a game take minutes.

## 4. Open GAP headlines (full list: `data2/gaps.json`, 189 entries)

> **Planning input:** [`docs/sim2_gap_register.md`](docs/sim2_gap_register.md) is
> the complete, self-contained gap register — every gap with evidence, file
> locations, impact and acceptance criteria, written for an agent with no code
> context. It supersedes this summary and includes several parser defects found
> after this section was written (missing invulnerable saves, inert core
> abilities, collapsed multi-profile statlines, unparsed transport capacity).

* **MFM reconciliation (Phase D2) not performed.** Points come from the faction
  pages, not the Munitorum Field Manual app, which §6.1 makes the authority. Every
  points figure is provisional; the named Sanctifiers item is unverified.
* **156 effect records are text-only** — ingested verbatim, not yet expressible.
* **DP budget per battle size not ingested** from core rules §25 (the per-detachment
  DP cost *is* ingested).
* **Mission card text** comes from the project's research dossier (a community
  transcription), not the printed deck; unmapped VP lines are logged per card.
  Cards whose scoring depends on operation markers and card-reverse Actions
  (most of the Disruption deck) therefore score only through their other
  clauses, which skews those pairings — visible as a lopsided mirror batch.
* **Hull-based vehicle footprints** are flagged rectangular estimates.
* **Transports, attached units, aircraft (§4.7)** are not implemented at all.
* **Layout transcription was not re-verified** at region level this session; it is
  inherited from the repository's earlier extraction with page provenance.

## 5. The exact next three tasks

1. **Reconcile every points figure against MFM v1.2** (Phase D2), recording each
   discrepancy, and settle the Sanctifiers open item. Points feed list legality
   and the optimizer, so everything downstream inherits this uncertainty.
2. **Even out the mission cards.** Heuristic-vs-heuristic currently runs 12–0 to
   the Purge the Foe side against Disruption, because Disruption's cards score
   through *trapped* terrain areas placed by card-reverse Actions, and those
   clauses are unmapped (they score nothing). Binding the operation-marker
   Actions is the single biggest fidelity win left in the mission layer.
3. **Bind the next tranche of effect records**, starting with the detachment rules
   of the two sample armies and the enhancements that alter Orders — the ontology
   and the interpreter are in place, so each is a data edit plus a test.

---

## 6. Running it

```bash
python3 -m sim2.cli data                    # snapshot coverage
python3 -m sim2.cli armies                  # the sample armies
python3 -m sim2.cli play  --a "Alien Hunters Strike" --b "Siege Regiment Vanguard" \
                          --battle-size 500 --seed 1 --out results/logs/battle.json
python3 -m sim2.cli batch --a "Imperialis Fleet Patrol" --b "Grizzled Company Line" --games 20
python3 -m sim2.cli optimize --faction AM --vs "Imperialis Fleet Patrol" --candidates 20
python3 train.py --iterations 3             # RL smoke run (see the caveat above)

python3 tools2/sync_results.py              # publish artifacts to the Pages app
python3 -m pytest tests_py -q -m "not slow" # rules + data tests
python3 tools2/lint_determinism.py          # randomness must live in sim2/rng.py
```

Re-snapshotting the data is a two-step refresh, not a rebuild:

```bash
python3 tools2/ingest_wahapedia.py --raw <dir-of-fetched-html> --out data2
python3 tools2/build_data.py
```
