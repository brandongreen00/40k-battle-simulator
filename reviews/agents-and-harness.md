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

**Not met, and not claimed.**

* First run (before the mission-lookup fix): heuristic 33% vs random 37.5%. No
  signal at all — because primary missions never scored, every game ended 10–10
  on Battle Ready and no amount of good play could move the result.
* Re-measured after the fix (24 games, 500pts,
  `results/heuristic_vs_random/batch.json`): **8 wins each, 8 draws, average VP
  57.6 : 55.9**. Scores are now realistic and both sides reach the 45 VP primary
  cap — but the heuristic still does not beat the baseline.

The diagnosis, stated plainly because it changes what "random" means: **the
action enumeration is goal-directed.** Movement candidates are generated toward
objectives and enemies, so `RandomAgent` is not a naive baseline — it is
"uniform choice among sensible destinations", which on an objective-scored
mission is already most of the game. Two consequences:

1. The 95% target cannot be assessed until the baseline is honest. The fix is to
   add uniformly-sampled lattice destinations to the enumeration so a random
   agent can genuinely wander, then re-measure.
2. The heuristic's own weakness is real regardless: it plays objectives
   generically instead of playing *its own primary card*, which is where the
   remaining VP lives.

Both are written up as next tasks in STATUS.md rather than papered over.

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
