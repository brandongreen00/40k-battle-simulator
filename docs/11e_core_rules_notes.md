# Warhammer 40,000 — 11th Edition Core Rules: extraction notes & 10e→11e gap analysis

> Source: `eng_01-06_warhammer40k_new40k_core_rules` PDF (88 pp., June 2026), read cover to
> cover on 2026-07-03. Section numbers below (e.g. 05.03) are the PDF's own reference numbers.
> This document drives the 11e refactor of `src/core/`. Companion docs:
> `docs/11e_missions.md` (Chapter Approved deck / Event Companion) and
> `docs/11e_layouts.md` (terrain layouts).

## 1. Core concepts (01)

- **Active player / opposing player (01.03)**: while it is neither player's turn, the player
  who takes the first turn each round is active. A unit selected to move/shoot/fight makes its
  controller the active player until resolved (matters for reactive windows).
- **Measuring (01.04)**: closest part of the **base** (FRAME models: closest point of model, 17.02).
- **Leadership rolls (01.06)**: Ld is now a *target* (e.g. "7+"). Roll 2D6 ≥ any Ld
  characteristic in the unit ⇒ success.
- **Battle-shock rolls (01.07)** = leadership roll. While battle-shocked:
  - OC modified to '-' (cannot control objectives),
  - controller cannot target the unit with **stratagems**,
  - not eligible to start an **action**; started actions cannot complete.

## 2. Datasheets (02)

- Profile stats: `M T Sv W Ld OC` **plus first-class InSv** (invulnerable save).
- Ld printed as dice target ("6+"/"7+"), NOT a 10e number. OC can be '-'.
- Weapons: R/A/BS-or-WS/S/AP/D. Abilities in brackets `[BLAST]`; keyword-scoped abilities
  exist (`[LETHAL HITS: VEHICLE]` only applies vs VEHICLE targets).

## 3. Moving (03)

- Move = per-model straight lines + free rotations; total straight-line distance ≤ max.
- Models can move **through friendly models** (all units!); not through enemies (exceptions:
  Desperate Escape, MONSTER/VEHICLE 17.01, FLY 21.03, SUPER-HEAVY WALKER).
- **Ending a move**: unit must be in coherency; otherwise the whole move is illegal and is
  rewound (the unit has then NOT been selected to move and may move later — 03.02 sidebar).
- **Coherency (03.03)**: every model within **2" of ≥1 other model AND within 9" of *every*
  other model** (no more 7-model/two-neighbour rule). *Regaining coherency:* at the **End of
  Turn step**, units out of coherency must remove models (destroyed, no death triggers) until
  coherent.
- **Engagement range (03.04): 2" horizontally** (5" vertically). "Engaged"/"unengaged" are
  the terms of art everywhere.

## 4. Making attacks (04) and the attack sequence (05)

- **Select Weapons (04.01)**: shooting — each model selects any/all of its ranged weapons;
  fighting — each model selects **one** melee weapon ( + all its [EXTRA ATTACKS] weapons).
- **Select Targets (04.02)**: **per weapon** (different weapons in one unit may split fire).
  Ranged target must be visible to the bearer, in range, and **unengaged** (exception:
  close-quarters shooting, and shooting at engaged MONSTER/VEHICLE 17.03 at -1 to hit).
  Melee: a weapon may target multiple engaged units, splitting its A between them.
- **Resolve (04.03)**: per target unit, gather **attack dice** per weapon; *identical attacks*
  (same BS/WS,S,AP,D + same modifiers) pool their dice.
- **Attack sequence (05)**: 1. Hit rolls (unmod 1 fails, unmod 6 critical hit) → 2. Wound
  rolls (unmod 1 fails, unmod 6 critical wound; 2×S≥2T:2+, S>T:3+, S=T:4+, S<T:5+, 2S≤T:6+) →
  3. **Save rolls** → 4. Inflict damage.
- **Save rolls (05.03) — NEW allocation-group system** (defender resolves):
  1. *Create groups*: one group per CHARACTER model; one group per distinct (W,Sv,InSv) among
     the rest.
  2. *Allocation order* (declared by defender): a non-CHARACTER group containing a wounded
     model must be first; CHARACTER groups cannot precede non-CHARACTER groups; wounded
     CHARACTER groups precede unwounded ones.
  3. All save rolls are rolled (one per wounding attack).
  4. **Inflict damage lowest roll first**: for each save, check vs *current group*:
     unmodified 1 damages; InSv (unmodified) saves; else Sv modified by AP saves; else damage.
     Select a wounded model in the current group if possible; model loses D wounds; excess
     within one attack does NOT spill (per-model), excess attacks are lost when unit dies.
- **[PRECISION] (24.28)**: attacker may make a visible CHARACTER's group the *current* group.

## 5. Other attack concepts (06)

- **Visibility (06.01)**: 1mm-wide line from any part → any part; own unit's and target
  unit's models ignored. New *fully visible* concept (nothing but the model itself blocks any
  facing part); *unit fully visible* = every model fully visible (see through that unit's own
  models).
- **Mortal wounds (06.02)**: one at a time; must go to a wounded non-CHARACTER model first,
  then non-CHARACTERs, then wounded CHARACTERs, then CHARACTERs. Mixed damage: normal damage
  first, then mortals.
- **Hazard rolls (06.03)**: D6, fails on **1-2** ⇒ 1 mortal wound (3 if all models
  MONSTER/VEHICLE). Used by Desperate Escape, Combat/Emergency Disembark, [HAZARDOUS].

## 6. Battle round & phases (07–12)

- Round: Start of Battle Round → both player turns (**same player is first every round** —
  decided once by roll-off in mission sequence) → End of Battle Round (mission scoring hooks).
- Turn: Start of Turn step → **Command → Movement → Shooting → Charge → Fight** → End of Turn
  step (mission scoring hooks; coherency enforcement).
- **Command (08)**: 1 Start → 2 Gain Core CP (**both players gain 1CP**) → 3 Battle-shock
  (active player rolls for every unit at/below half-strength *or already battle-shocked*;
  success clears the state) → 4 Command abilities → 5 End (mission hooks, e.g. Tactical
  secondary draws).
- **Half-strength (Appendix)**: at-or-below **half**, including exactly half. Single-model
  units use remaining wounds vs W.
- **Movement (09)**: every unit must be *selected to move* incl. reserves/embarked. Move
  types: Remain Stationary / Normal / Advance / Fall Back / Disembark (18.04) / Ingress
  (20.04).
  - **Advance (09.06)**: +D6"; afterwards may not charge or start actions — **may still
    shoot** (assault shooting only, 10.05).
  - **Fall back (09.07)** modes: *Ordered Retreat* (only if not battle-shocked) or *Desperate
    Escape* (hazard roll per model; may move through enemies; battle-shock roll after if not
    already shocked). After falling back: no shooting/charging/actions.
- **Shooting (10)** — *shooting types*: Normal (unengaged, didn't advance) / **Assault**
  (advanced; [ASSAULT] weapons only) / **Close-quarters** (engaged; [CLOSE-QUARTERS] weapons
  at engaged targets only — MONSTER/VEHICLE may fire everything at -1 to hit except CQ
  weapons at engaged targets; [BLAST] can never target engaged units) / **Indirect**
  ([INDIRECT FIRE] weapons may target invisible units: target gets Benefit of Cover, no hit
  re-rolls, only unmodified 6 hits — or 4+ if shooter stationary and target visible to a
  friendly unit; note misses on hit rolls of 1-5 / 1-3 respectively). Snap shooting (15.09,
  Overwatch): one visible target ≤24", only unmodified 6 hits.
- **Charge (11)**: eligible if within 12" of an enemy, unengaged, didn't advance/fall back.
  Sequence: declare charge → **roll 2D6 first** → *then* select one or more charge targets
  (each within 12" AND within the rolled distance) → charge move: every model closer to a
  target; must end engaged with every target, not engaged with any non-target; models that
  *can* reach 1"/engagement must do so. **After a charge move the unit gains Fights First**
  until end of turn.
- **Fight (12)** — restructured:
  1. **Pile In step**: BOTH players (active first) make 3" pile-in moves with all eligible
     units (engaged, charged, or selected for overrun). Pile-in targets: all engaged units,
     or (if unengaged) units within 5". Models in base contact can't move; each moved model
     ends closer to closest target, engaged if possible.
  2. **Fight step**: units eligible if engaged (or engaged at start of step) or charged.
     *Resolve Fights First combats* (alternating, active player first), then *Remaining
     combats*. Fighting is **mandatory**. **Overrun fight (12.06)**: a unit that is
     unengaged (e.g. its target died / emergency disembark) may take one extra pile-in move,
     then fight. A player with only >5"-away eligible units may pass (Appendix).
  3. **Consolidate step**: both players (active first), 3", modes: *Ongoing* (engaged: stay
     engaged, close on closest) / *Engaging* (within 3" of enemy: must end engaged — enemy
     units engaged this way become eligible and are immediately selected to fight!) /
     *Objective* (within 3" of an objective: end within range of it).
- Charge move restrictions replace 10e "engagement range 1"": everything is 2" now.

## 7. Battlefield & terrain (13–14)

- **Terrain areas (13.01)**: a boundary (mat/base) or footprint containing terrain features.
  Missions define terrain area locations/dimensions — the Event Companion layouts do this.
- **Categories (13.02-05)**: **Exposed / Light / Dense** (replaces 10e ruins/woods/etc.).
- **Movement (13.06)**: INFANTRY/BEASTS/SWARM/MOBILE move through dense horizontally
  (I/B/S also vertically); other models only through sections ≤2" high. Vertical distance
  counts. FLY ("take to the skies", 21.03): -2" max distance, moves through everything,
  ignores vertical (HOVER skips the -2").
- **Benefit of Cover (13.08)**: if every model in target is (a) I/B/S within a terrain area,
  or (b) not *fully visible* due to intervening features/obscuring areas ⇒ **worsen the
  attack's BS by 1** (NOT a save bonus — this replaces 10e's +1 save).
- **Hidden (13.09)**: I/B/S model within a terrain area containing a dense feature, whose
  unit didn't make ranged attacks this or the previous turn ⇒ visible only within **15"
  detection range**.
- **Obscuring (13.10)**: terrain areas containing light or dense features. If every line of
  sight between two models crosses an obscuring area neither is within ⇒ not visible.
- **Solid (13.11)**: dense features; LoS can't cross enclosed gaps ≤3" from ground level.
- **Objectives (14)**: objective points usually coincide with a terrain area ⇒ the whole
  **terrain area is the objective** ("terrain objective"); in range = within the area.
  Otherwise a 40mm **objective marker**, in range = within 3" horizontally (Appendix).
  **Level of control** checked at the **end of each phase and turn**: sum OC within range;
  higher total controls. **Secured objectives (14.03)**: some rules secure an objective —
  it stays controlled with no models nearby until the opponent has *greater* control at the
  end of a phase.

## 8. Stratagems (15) — the 11 core stratagems

Rules: once per stratagem per phase per player; **max one stratagem per unit per phase**;
cannot target battle-shocked units (own).

| Stratagem | CP | When | Effect (abridged) |
|---|---|---|---|
| Command Re-roll | 1 | any roll listed | re-roll one die (charge rolls re-rolled in full) |
| Epic Challenge | 1 | your CHARACTER selected to fight | its melee weapons gain [PRECISION] |
| Insane Bravery | 1 | before your battle-shock roll | auto-pass (once per battle) |
| Explosives | 1 | your Shooting phase | EXPLOSIVES/GRENADES unit: 6D6, each 4+ = 1 MW to a unit ≤8" |
| Crushing Impact | 1 | after your M/V ends a charge move | roll T dice: 1 = self MW, 5+ = target MW (max 6) |
| Rapid Ingress | 1 | end of opponent's Movement | reserves unit makes an ingress move (not round 1) |
| Fire Overwatch | 1 | end of opponent's Movement | snap shooting (unmod 6s only, one target ≤24", non-TITANIC) |
| Smokescreen | 1 | start of opponent's Shooting | SMOKE unit (and units it blocks full visibility to) get cover |
| Heroic Intervention | 1(+1) | end of opponent's Charge | your unengaged unit ≤12" charges: *Leap to Defend* (chargers only) or +1CP *Into the Fray* (roll capped at 6, targets ≤6") |
| Counteroffensive | 2 | opponent's Fight step after an enemy fights | your unit gains Fights First and must be selected next |

## 9. Actions (16)

- STARTS/UNITS/USE LIMIT/COMPLETES/EFFECT structure. Ineligible: off-board,
  AIRCRAFT/FORTIFICATION, battle-shocked, OC 0/'-', engaged (non-TITANIC), advanced/fell
  back this turn, started another action this turn. Starting an action: not eligible to
  shoot (excl. TITANIC) or charge. Moving (except pile-in/consolidate) or leaving the board
  fails the action. Secondary/mission cards supply the actual actions.

## 10. Advanced rules (17–23)

- **MONSTER/VEHICLE (17)**: normal/advance moves through non-M/V models both ways; engaged
  M/V can be shot at by others at -1 to hit ([BLAST] cannot); FRAME keyword = measure to
  hull.
- **Transports (18)**: embark after normal/advance/fall-back move if all models ≤3";
  disembark modes — *Rapid* (transport made normal/ingress move: 3", no charge), *Tactical*
  (transport hasn't moved: 3", the unit is then selected to make a normal/advance move!),
  *Combat* (transport advanced/fell back… actually: otherwise-case: 6", hazard roll per
  model, battle-shocked, may be set up engaged, no charge). *Emergency* (transport
  destroyed): 6", hazard per model, battle-shocked, no charge.
- **Attached units (19)**: **Leader (24.22) + Support (24.34)** — a bodyguard can have one
  of each. Attacks use the **bodyguard's highest T**. Destruction triggers only when the
  last model dies. Unit has union of keywords. Leader/support abilities apply to the unit
  while the leader/support survives.
- **Strategic reserves (20)**: ≤50% of points limit; arrive via **ingress move** from round
  2 (wholly within 6" of any battlefield edge, >8" horizontal from enemies, not in enemy DZ
  before round 3); after ingress not eligible to make other moves until the start of the
  next Charge phase (i.e. CAN charge the same turn). Destroyed at end of round 3 if not
  arrived. **Deep Strike (24.09)** upgrades ingress: anywhere >8" from enemies (incl. enemy
  DZ).
- **Surge moves (21)**: reactive moves granted by abilities — toward *closest* enemy, must
  end engaged with the surge target if possible; not battle-shocked, unengaged.
- **FLY (21.03)**: see terrain; **TOWERING**: plunging fire within 12" (22.05).
- **Plunging fire (22.05)**: +1 BS (improve) when attacker is on a ≥3" section and target
  has models on ground level (or TOWERING attacker ≤12").
- **Aircraft (23)**: must start in reserves, only ingress moves, leave the board at end of
  opponent's turn, only FLY can charge/fight them. (Low priority for our lists.)

## 11. Core & weapon abilities (24) — full list

[ANTI-X Y+] (crit wound on Y+ vs X) · [ASSAULT] (enables assault shooting) ·
[BLAST]/[BLAST X] (+1/+X attack dice per 5 models in target) · [CLEAVE X] (+X dice per 5
models if single target — melee "blast") · [CLOSE-QUARTERS] (enables CQ shooting; model
fires CQ weapons *or* its other guns) · Deadly Demise X (D6 on model death: 6 ⇒ X MW to all
units ≤6") · Deep Strike · [DEVASTATING WOUNDS] (crit wound ⇒ D mortal wounds instead, ≤1
model damaged per crit) · [EXTRA ATTACKS] · Feel No Pain X+ · Fights First · Firing Deck X ·
[HAZARDOUS] (hazard roll per weapon after resolving) · [HEAVY] (+1 hit if unengaged, not set
up this turn, no model moved >3" this turn) · HOVER · [IGNORES COVER] · [INDIRECT FIRE] ·
Infiltrators (set up >8" from enemy DZ+units — was 9" in 10e) · [LANCE] (+1 wound on charge)
· Leader · [LETHAL HITS] (crit hit MAY auto-wound — optional now) · Lone Operative [X"]
(invisible beyond 12"/X"; blocks INDIRECT beyond that too) · [MELTA X] · [ONE SHOT] ·
[PISTOL] (= [CLOSE-QUARTERS], being renamed) · [PRECISION] · [PSYCHIC] (may ignore BS/WS &
hit-roll modifiers!) · [RAPID FIRE X] · Scouts X" (pre-battle move, end >8" from enemies; or
reserves→DZ redeploy; DEDICATED TRANSPORT full of Scouts moves too) · Stealth (benefit of
cover vs ranged) · Support · Super-heavy Walker · [SUSTAINED HITS X] · [TORRENT] ·
[TWIN-LINKED] (re-roll wound).

**Duplicated abilities (24.02)** are not cumulative — pick one instance.

## 12. Event Companion (missions) — see docs/11e_missions.md

- Mission sequence: muster (+ pick a **Force Disposition** card) → determine mission (my
  mission = row under opponent's disposition symbol on MY card) → pick 1 of **3 recommended
  layouts (A/B/C)** for the mission pairing → build 44"×60" battlefield from the layout →
  roll off: winner picks Attacker/Defender → select secondaries (Tactical vs 2 Fixed;
  secret, simultaneous reveal) → declare battle formations (transports, reserves) → deploy
  alternating **starting with the Defender** (TITANIC set-up skips your next set-up turn) →
  redeploys → roll off for first turn → pre-battle rules (Scout moves…) → 5 battle rounds →
  score: **Primary ≤45VP (≤15/round), Secondaries ≤45VP (≤15/round, ≤20 per Fixed card),
  Battle Ready 10VP**.
- Tactical secondaries: draw 2 at start of your Command phase (to hand of 2 active); once
  per battle at end of your Command phase spend 1CP to discard one + redraw. At end of
  *each player's* turn (scoring player first): score achieved cards (discard when scored);
  then on your turn you may discard any active cards for 1CP (total, not each).
- The five dispositions and 15 pairings' missions + 45 layouts: see docs/11e_missions.md.

## 13. Biggest 10e→11e implementation deltas for src/core (checklist)

1. ✅→ rewrite Ld semantics (2D6 ≥ Ld target; datasheet values change form).
2. Engagement range 1"→**2"**; coherency 2"+9"-spread; end-of-turn coherency kills.
3. Save resolution → **allocation groups**, batch save rolls, lowest-first damage,
   defender-declared order, PRECISION override; InSv unmodifiable; per-model damage no
   spill (already true).
4. Benefit of cover: +1 Sv → **worsen attacker BS by 1**; Stealth likewise.
5. Advance: shooting allowed only via [ASSAULT]; Heavy: +1 to hit under new conditions
   (moved ≤3"); Indirect: new to-hit table; Pistol→Close-Quarters semantics; engaged
   MONSTER/VEHICLE shooting at -1 both ways; snap shooting.
6. Charge: roll before target selection; Fights First on charge; 2" engagement; charge into
   base-contact requirement dropped (engaged = within 2").
7. Fight phase: three sub-steps, overrun fights, consolidation modes, mandatory fighting,
   both-players pile-in/consolidate.
8. Battle-shock: at-or-below half; recovery roll each Command phase; OC '-'; no stratagem
   targets; blocks actions. Insane Bravery once/battle.
9. CP: both players +1 each Command phase (2/round each).
10. Missions: replace Pariah Nexus scoring with Chapter Approved dispositions/primary/
    secondary system (45/45/10 caps, round-based 15VP caps).
11. Terrain: categories exposed/light/dense; areas; Hidden/Obscuring/Solid visibility model;
    terrain objectives (area = objective).
12. Reserves: ingress within 6" of edges >8" from enemies; Deep Strike >8" anywhere; round-3
    forfeit; ≤50% points.
13. Stratagems: new core set of 10 (+snap shooting rule); once-per-unit-per-phase rule.
14. Leaders: Support ability alongside Leader; bodyguard-T targeting; one leader + one
    support per bodyguard.
15. New weapon abilities: [CLEAVE], [CLOSE-QUARTERS], keyword-scoped abilities, [BLAST X],
    optional [LETHAL HITS], [DEVASTATING WOUNDS]→mortal wounds (≤1 model per crit),
    [PSYCHIC] modifier immunity, [ONE SHOT], hazard 1-2.
16. Mortal wounds: allocation rules (wounded non-characters first, characters last).
17. Actions system (needed by mission cards).
18. Transports: disembark modes (tactical disembark then move!), emergency disembark,
    Firing Deck as core.
