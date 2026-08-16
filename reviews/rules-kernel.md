# Adversarial review — rules kernel (movement, attacks, terrain, missions)

Method (mandate 2b): each clause below was re-read from the source text — the
11th edition Core Rules on Wahapedia and the faction pages fetched 11 Aug 2026 —
and compared against the implementation, hunting for divergence rather than
confirmation. Verdicts are honest; "partial" and "not implemented" are used
where they are true.

| Rule | Clause checked | Verdict |
|---|---|---|
| 01.05 | Distances measured between the closest points of bases | ✅ `geometry.gap`, tested at 32mm/2" → 0.74" |
| 01.02.01 | Below half strength = fewer than half the starting models (wounds for single-model units) | ✅ `UnitState.below_half_strength` |
| 01.02.02 | Persisting effects survive embarkation and reserves | ⚠️ partial — durations survive, but embarkation itself is not modelled (transports are §4.7, not implemented) |
| 03.04 | Engagement Range is a cylinder: 2" horizontal **and** 5" vertical | ✅ `measure.units_engaged`, tested at 4" and 6" vertical |
| 03.x | Coherency 2"/5" to a neighbour, two neighbours at 7+ models, 9" spread | ✅ `measure.coherency_ok`, tested both ways |
| 09.04–09.06 | Remain Stationary / Normal / Advance as distinct modes with their own eligibility | ✅ separate modes; Advance rolls a D6 and forbids shooting without [ASSAULT] |
| 09.05 | A Normal or Advance move may not END within Engagement Range | ✅ enforced by backing the move off to the furthest legal point |
| 09.07 / 09.07.01 | Fall Back must leave Engagement Range; Desperate Escape on 1–2 | ⚠️ partial — Desperate Escape fires for Battle-shocked units only; the Ordered Retreat vs Desperate Escape mode choice is not offered |
| 11.02 / 11.04 | Charge rolls 2D6 first; double 1 always fails; charge grants Fights First | ✅ roll-first order, double-1 auto-fail tested, `fights_first` stamped |
| 11.04 | A charge may not end within Engagement Range of a non-target | ✅ `_charge_score` rejects such end positions |
| 12.03 / 12.08 | Pile In and Consolidation up to 3" toward the nearest enemy | ⚠️ partial — Pile In and an Engaging consolidation are made automatically; the three consolidation *modes* are not offered as a choice |
| 12.x | Fights First before the rest | ⚠️ partial — priority is enforced within each army; activation does not alternate between players (the active player takes the whole Fight phase). Logged in STATUS.md |
| 04.x | One melee weapon per model, best profile first | ✅ `fighting.fight_plan` |
| 05.02 | S-vs-T wound table | ✅ transcribed from the PDF (Wahapedia strips the numerals — trap §6.8), tested at every band |
| 05.x | Unmodified 1 always fails, unmodified 6 is always a Critical, modifiers clamped to ±1 | ✅ `attacks.resolve_attack`, `clamp_mod` |
| 05.x | Allocation groups: wounded group first, CHARACTER groups last, [PRECISION] promotes | ✅ `attacks.allocation_groups` |
| 05.x | Damage never spills between models | ✅ `_apply_damage` is per model |
| 06.x | [DEVASTATING WOUNDS] → mortal wounds capped at one model per critical | ✅ `cap_one_model` |
| 06.x | Hazard rolls fail on 1–2; 3 MW for a pure MONSTER/VEHICLE unit | ⚠️ partial — the roll and the 1-vs-3 split are implemented; the "pure MONSTER/VEHICLE" test is coarser than the printed wording |
| 10.04–10.07 | Shooting types as distinct modes | ⚠️ partial — Normal, Assault, Close-Quarters and Indirect are enforced at weapon level; Indirect's 6+/4+ hit floor is not separately modelled |
| 10.06 | An engaged unit may only shoot the unit it is engaged with; MONSTER/VEHICLE at −1 | ✅ `engine.can_shoot` + `shooting.eligible_ranged` |
| 13.x | Obscuring areas block sightlines drawn across them; a model inside can see out | ✅ `visibility.point_los_blocked` |
| 13.x | Solid: dense features block within the ≤3" ground band | ✅ same function, `SOLID_GROUND_BAND` |
| 13.x | Benefit of Cover worsens the attacker's BS/WS by 1 (11e made cover a hit penalty) | ✅ `attacks.resolve_attack` applies `hit_mod -= 1`, not a save bonus |
| 13.x | Hidden at 15", Gone to Ground at 12", detection range modifiable per unit pair | ✅ `visibility.detection_range` is a function, not a constant |
| 22.05 | Plunging Fire | ⚠️ partial — detected (`plunging_fire`) and applied to [BLAST]; the full rule's other terms are not bound |
| 14.02.01 | Objective control determined before other end-of-phase rules | ✅ `advance_phase` refreshes control first |
| 14.x | Battle-shocked models have OC '-' | ✅ `objectives.unit_oc` returns 0 |
| 14.x | Terrain objectives: the area itself is the objective | ✅ `Objective.area_id` path in `objectives.model_in_range` |
| 08 | Both players gain 1 CP each Command phase | ✅ `_begin_command` |
| 08 | Battle-shock at or below half strength, 2D6 ≥ Ld | ✅ `_battle_shock_tests` |
| 15.01 | Same Stratagem once per phase; one Stratagem per unit per phase | ✅ `stratagems.limits_ok` |
| 15.02–15.12 | The core Stratagem set | ⚠️ 10 of the 11 are ingested as records; Snap Shooting (15.09) is a shooting-type card on the source page and is implemented as engine behaviour instead. 10 core cards carry primitive bindings |
| 16 | Actions: eligibility exclusions, moving voids completion | ⚠️ partial — the subsystem exists (`unit_actions`) but no mission card yet drives an Action, so marker-based primaries score through their other blocks only |
| 20.04 | Ingress: wholly within 6" of an edge, >8" from enemies, no enemy DZ before round 3 | ✅ `movement.ingress_legal` |
| 20.01 | Strategic Reserves capped at half the army's points | ✅ `_do_place_in_reserves` |
| 25 | Battle sizes, Legends exclusion, duplication limits, per-copy tiers, dual points column | ✅ in the optimizer's legality checks and the points schema |
| 25 | Detachment Points budget per battle size | ❌ **GAP** — not ingested; the DP cost of each detachment is (2/3/1 as printed), but the per-battle-size budget was not read from section 25. Logged, not assumed |

## Divergences found during this review, and what was done

1. **Primary missions never scored.** The layout pages print mission names in
   caps (`PUNISHMENT`); cards are stored under normalised ids (`punishment`).
   The lookup missed every time, so every game ended on Battle Ready alone and
   play could not affect the result. Fixed in `DataIndex.mission_card`;
   regression test `test_primary_missions_actually_score`.
2. **The enumeration offered illegal Fall Back moves.** A unit with no legal
   escape was offered one anyway and the engine then refused it. Fixed by
   pre-checking escape feasibility in `legal._fall_back_possible`.
3. **The enumeration offered out-of-order fight activations.** `_fight_actions`
   skipped past the first unit in the order instead of stopping. Fixed with
   `engine.next_to_fight`, which the enumeration and the validator now share.
4. **Battle-shocked units were offered as Stratagem targets** and then refused.
   Fixed in `stratagems.legal_stratagem_actions`.
5. **Army unit keys collided between players** (`"0"` for both), so one army
   silently overwrote the other and a side deployed nothing. Fixed by
   namespacing battlefield ids by side.

Each of these was found by running games and reading rejections, not by reading
code — which is why the "zero illegal actions" metric is worth keeping.
