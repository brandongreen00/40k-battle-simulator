# Adversarial review — agents, harness, artifacts

## Stage A exit metric: "zero illegal actions"

Measured, not asserted. The runner counts every action the engine refuses after
an agent picked it from the enumeration; `results/batch.json` publishes the
count. Current state:

* 12-game batch, heuristic vs heuristic, 500pts — **0 rejected actions**
* 24-game batch, heuristic vs random, 500pts — **0 rejected actions**
* `tests_py/test_engine.py::test_random_agent_plays_a_legal_game` pins it at 0
  for a full random game, and `test_thousand_point_game_is_legal` at 1000pts.

Getting there took five separate fixes (see `reviews/rules-kernel.md`), each
found by a rejection rather than by inspection.

## Stage A exit metric: "heuristic beats random >95%"

**Met: 20 wins, 0 draws, 0 losses (100%) over 20 games at 500pts**, average VP
57.7 : 43.8 (`results/heuristic_vs_random/batch.json`). Getting there required
two fixes that a win-rate number alone would have hidden:

1. **Primary missions never scored.** The layout pages print mission names in
   caps; the cards are stored under normalised ids, so every lookup missed. Every
   game ended 10–10 on Battle Ready and no amount of good play could move the
   result. The first measurement — heuristic 33% vs random 37.5% — was measuring
   nothing.
2. **Threshold clauses were scored per objective.** "You control one or more
   objectives → 5VP" pays once; "for each objective you control → 3VP" pays per
   objective. The dossier marks the difference explicitly and the parser ignored
   it, so cards paid 5 objectives × their VP, every card saturated the 15VP
   per-round cap by round three, and both sides finished on the 45VP primary cap
   regardless of play. Fixed by honouring the per-instance marker and adding a
   `control_at_least` evaluator; re-measured 8W/8D/8L → 20W/0D/0L.

The lesson worth keeping: an agent-strength metric is only as meaningful as the
scoring underneath it. Both bugs were invisible in the tests and obvious in the
published artifacts.

### A caveat the win rate does not show

Heuristic-vs-heuristic runs 12–0 to the Purge the Foe side against Disruption.
That is not a bug in the agent: the Disruption deck scores through *trapped*
terrain areas placed by card-reverse Actions, and those clauses are unmapped, so
that side is playing with part of its scoring missing. Recorded in STATUS.md as
the next mission-layer task.

## What the heuristic does and does not weigh

Weighs: objective proximity and current holder, analytic expected damage
(mirroring the attack sequence without rolling), overkill capped at the target's
remaining wounds, charge probability against retaliation, threat exposure.

Does **not** weigh: screening, mission-specific play (it plays objectives
generically, not its own primary card), reserves timing, CP economy beyond
"don't spend on an unbound card", or any faction rule.

## Search and RL

`SearchAgent` is a working rollout search (heuristic policy, VP-differential
value) — a scaffold, not a tuned player. `train.py` runs a real self-play loop
over the heuristic's weight vector with a replay buffer and a `PolicyValue`
seam. **RL to strength is a multi-day compute job and is out of scope here; what
is delivered is that the loop starts learning, not that it has learned.**

## Artifact contract

One schema, three executors. `sim2/harness/run.py` (CLI), the two GitHub Actions
workflows, and any future server all emit `result_schema_version: 2.0.0`
artifacts; the Pages app validates the version and shows a warning rather than
rendering a mismatched shape (`checkResultVersion`, tested).

## Performance — the honest number

A 500-point game runs in ~8s; a 1000-point game in ~40s. That is slow enough
that large batches need Actions runners or an afternoon. The profile is
dominated by line-of-sight and legality checks in pure Python. The caching and
polygon simplification already applied took a 1000pt game from >120s to ~40s;
the next wins are vectorising the sightline tests and caching per-phase
enumerations.
