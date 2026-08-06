# Combat Patrol (11e) — data, maps, and battle mode

> Status after step 3 (2026-08-06): **army selection, deployment, mission
> scoring AND stratagems work end-to-end.** The four patrol lists and the three
> 30"×44" maps are in the app; a Combat Patrol battle runs the full setup flow,
> the five phases, scores each side's own patrol mission card (§4a), and plays
> each patrol's three stratagems plus the owner-trimmed core set (§4b). The
> patrols' *enhancements in play* and the per-unit *special abilities* are
> later steps (see §5).

## 1. Sources

- **Patrol data**: 57 Warhammer-app screenshots supplied by the owner
  (Drive folder "40K Combat Patrol 11th", four sub-folders). Extracted with the
  screenshot→datasheet methodology (native vision, crop-and-upscale verification,
  transcribe-never-reconstruct). The raw extraction + per-patrol flag lists are
  committed under `tools/combatpatrol/extracted/`.
- **Maps**: three Warhammer-app Combat Patrol map screenshots (IMG_9886/9887/9888).
  GW publishes no PDF of the 11e CP missions (app-only), so the layouts were
  measured from the screenshots — see §3 for the method and confidence.

## 2. The four patrols (`data/game/cp_datasheets.json`, `data/rosters/cp_*.json`)

| Patrol | Faction | Units | Notes |
|---|---|---|---|
| Crowe's Sanctifiers | Grey Knights | Strike Squad ×10, Castellan Crowe, Venerable Dreadnought, Brotherhood Terminator Squad ×5 | Strike from the Warp: Terminators/Dreadnought **must start in Strategic Reserves** (arrive round 2/3) — enforced in-game |
| Inquisitor's Hand | Agents of the Imperium | Preacher Teguen, Vigilant Squad ×10, Eversor Assassin, Inquisitorial Agents ×6 | Stratagems + enhancements captured 2026-08-06; owner-confirmed the patrol has **no faction/detachment rule**, so nothing is missing |
| Sudden Dawn Cadre | T'au Empire | Pathfinder Team ×10, Breacher Team ×10, Devilfish, Commander Cloudspear | Devilfish transports 12 INFANTRY (embark/disembark work via the existing transport engine) |
| The Vengeful Brethren | Dark Angels | Intercessor Squad ×10, Master Zacharial, Hellblaster Squad ×5, Bladeguard Veteran Squad ×3 | Bladeguard **Sergeant is T3 while Veterans are T4** — crop-verified, transcribed as shown |

Each roster carries `combatPatrol: true`, fixed model counts, and per-weapon
carrier counts parsed from the datasheets' equipment sentences (so fire plans cap
attacks at the real bearers, e.g. 8 Storm Bolters in the 10-strong Strike Squad).

**Regenerate** with `pnpm build:cp` (reads `tools/combatpatrol/extracted/*.json`).

### Extraction flags (full lists + resolution logs in `tools/combatpatrol/extracted/*_flags.md`)

**Owner-confirmed 2026-08-06** (accepted, never re-litigate): "FOESIGHT" is
intentional (not a typo); all transcribed-as-shown stats are intentional
(Psycannon S8, NFW A3 vs A4, Bladeguard Sergeant T3 vs squad T4, Eversor pistol
A4 + Sustained Hits 3 at 2+, "BLAST 1", Zealot "+3 A and S", …); the missing
Gate of Infinity battle-size table is an accepted source gap; map numbering 1–3
is fine.

All extraction gaps are now closed: the owner confirmed the Inquisitor's Hand
has no faction/detachment rule (so its landing page holds no rules content),
and all four mission cards were captured in full via follow-up screenshots
(their canonical texts live in `src/core/cpmissions.ts`).

### Conversion decisions

- Multi-profile weapons use the repo convention `"<base> – <profile>"`.
- Torrent/"-" BS → `skill 0` (same as the Wahapedia-converted data).
- Mixed-base squads take the rank-and-file base (Vigilants 28.5mm — the 25mm is
  the lone Cyber-Mastiff; Agents 25mm — the 32mm is the Gun Servitor). The
  Devilfish ("Large Flying Base") uses the owner-measured hull **rectangle**:
  17.5cm × 13cm (6.89" × 5.12"; 7cm tall incl. antenna — height not modelled,
  the sim is 2D). Rect bases are axis-aligned (rotation untracked, like ovals)
  and use the same gap/overlap approximations.
- Patrol/faction ability TEXT rides on every unit's `abilities`; none of the CP
  units has Deep Strike/Infiltrators/Scouts, so deployment abilities are standard
  (+ the mandatory-reserves rule below).

## 3. The three maps (`data/layouts_cp/cp2026-layout-{1,2,3}.json`)

Board is **30" wide × 44" tall** (portrait). All three maps use the same 10-mat
terrain set — 2× 11.5"×7.5" ruins, 4× 6"×4" mats, 4× 6"×2" plates — arranged
180°-rotationally symmetric about the board centre, with green (dense/tall) and
gold (light/low) features on the mats.

Measured from the screenshots by scripted colour segmentation (deployment zones),
dark-outline tracing + texture analysis (mats), RANSAC line fits over the printed
dot patterns (dividers/guides), and white-shape detection (icons) — calibrated at
28.67 px/inch and cross-checked against every printed corner-offset measurement
(offsets reference the **nearest** board edges) and the 180° symmetry. Overlay
renders of the final geometry were visually verified against all three
screenshots. Method + committed spec: `tools/layouts_cp/`.

| Map | Source | Deployment zones | Divider |
|---|---|---|---|
| Layout 1 | IMG_9886 | 15"×11" corner rectangles (blue top-right, red bottom-left) | y = 22" |
| Layout 2 | IMG_9887 | full-width triangles (16" tall at one edge, to a point) | y = 22" |
| Layout 3 | IMG_9888 | corner pentagons (x=15 vertical + diagonal to the far edge) | corner-to-corner diagonal |

Per map: 2 **home objectives** (castle icons, attacker/defender) + 2 **expansion
objectives** (skull diamonds), each bound to its terrain area (the area is the
objective, 11e-style); the AB/CD/EF/GH ruin letters (rendered on the board — CP
missions reference them); the ⊘ "separate terrain areas" markers; and the two
paired blue/red **divider markers** whose mission semantics arrive with the CP
mission deck (stored as `dividerMarkers`, rendered as paired dots).

Assumptions/simplifications (flagged): mats are stored as clean rectangles (the
printed torn edges are decorative); the dotted quarter-guides (y=11/22/33, x=15)
are not stored — only the actual territory divider; map numbering 1–3 follows
the screenshot order (official names unknown, app shows none).

## 4. Playing a Combat Patrol battle

Measuring Board → **Battle type: Combat Patrol** → pick one of the three maps and
a patrol per side → **⚔ New Combat Patrol battle**. The normal setup flow runs
(roll-off → alternating deployment → leaders → first turn → battle), with:

- Only the four patrol rosters offered (standard lists hidden, and patrol lists
  hidden from standard battles).
- `GameState.battleType = 'combat_patrol'`: the 11e Chapter Approved mission
  layer, the Tactical Missions deck and the legacy Pariah primary are all off —
  scoring comes exclusively from the patrol mission cards (§4a).
- **Strike from the Warp** enforced: Brotherhood Terminators and the Venerable
  Dreadnought cannot be set up on the battlefield; they must be placed in
  Strategic Reserves and arrive from their stated round, **wholly within their
  own deployment zone** (reducer-enforced; the AI plays it the same way).
- The AI plays both sides if asked (tests pin full AI-vs-AI CP games at zero
  rejected intents on maps 1 and 3).

## 4a. Missions & scoring (step 2)

Each patrol plays its **own** mission card (`src/core/cpmissions.ts`), scored at
the end of that player's turn and at the end of the battle; mission VP is the
only VP source in a Combat Patrol battle (the 11e Chapter Approved primary, the
Tactical deck and the legacy Pariah scoring are all off). The game panel shows
both cards, their capture status, and a per-event VP log.

| Patrol | Mission | Captured | Scoring implemented |
|---|---|---|---|
| Inquisitor's Hand | Inquisitorial Sanction | full | 10VP per enemy CHARACTER model destroyed in this/previous turn (end of your turn, any round); round 2+: control 1+ objectives 5VP, control 2+ another 5VP; end of battle: all enemy CHARACTERs destroyed 10VP |
| Sudden Dawn Cadre | Expansionary Campaign | full | end of your turn — rounds 1–2: control 1+ expansion objectives 10VP, 2+ another 15VP; rounds 3–5: 5VP / another 10VP |
| Crowe's Sanctifiers | Purification | full | **Sanctification action**: starts in your Shooting phase (16.01 eligibility, once per turn, unit within range of an unsanctified objective), completes at your **next Command phase** or the end of the battle; end of battle: 5VP per objective controlled + 10VP per objective sanctified |
| The Vengeful Brethren | Seize their Strongholds | full | round 2+ at the **end of your Command phase** (end of your turn in round 5): more objectives than opponent 5VP + your home objective 5VP + 1+ non-home objectives 5VP |

Interpretation (recorded): the cards' stacked lines score **cumulatively**
(every satisfied line pays — GW's Combat Patrol card convention), so e.g.
holding both expansion objectives in round 1 pays 10+15=25VP. The
patrol↔mission pairing is owner-confirmed. Sanctification simplification: a
pending action fails only if the unit is destroyed, leaves the battlefield or
is battle-shocked at completion (attacks made mid-window are not tracked).

The AI plays its card: Inquisitorial Sanction boosts CHARACTER-kill EV,
Expansionary Campaign pulls units toward the expansion objectives (strongest in
rounds 1–2), and Purification starts Sanctifications whenever a unit in range
is worth more sanctifying than shooting (probed: 3–7 sanctification events per
AI game). Seize their Strongholds rides the AI's normal objective play.
Humans get a "⚡ Sanctify" unit+objective picker in the missions panel during
their Shooting phase.

## 4b. Stratagems in play (step 3, 2026-08-06)

**Core set (owner-ruled):** every core stratagem is fair game in Combat Patrol
**except Explosives, Rapid Ingress and Crushing Impact** (`CP_BANNED_CORE` in
`stratagems.ts`). `usableStratagems` filters them out when
`battleType: 'combat_patrol'`, the reducer rejects the banned intents outright
("not available in Combat Patrol battles"), and the AI's Explosives /
Rapid Ingress / Crushing Impact plays are gated off in CP.

**Command Re-roll (owner's card text):** 1 CP to re-roll an advance, charge,
damage, hazard, hit, save, wound, or number-of-attacks roll — ONE die, except
charge rolls which re-roll both (2D6). Engine bindings: **charge** (the
existing 2D6 re-roll via `ChargeParams.commandReroll`) and **advance** (new
`RerollAdvance` intent + a "↻ Re-roll Advance (1 CP)" button in the Movement
panel, legal only before any model has moved). Both share the once-per-phase
`rerollUsed` tracker. The single-die re-rolls (hit/save/wound/damage/hazard/
attacks) need an interactive dice layer the app doesn't have — dice resolve in
one batch — so those uses stay **text-only** for now (recorded gap).

**The 12 patrol cards** (`patrolStratagems` in `loaders.ts`, ids
`cp:<patrol>:<slug>`, offered only to the side playing that patrol via the
detachment filter; all engine-bound unless noted):

| Patrol | Card (1 CP each) | Binding |
|---|---|---|
| Crowe's Sanctifiers | Exigent Assignments | `cp:consolidate_extended` — that unit's Consolidate this phase is 3+D3" |
| | Refusal to Yield | `cp:wound_shield_strong` — −1 to wound vs the unit when the attack's S > its T (ranged) |
| | Psi-reactive Ammunition | `cp:psychic_ammo` — storm bolters gain [PSYCHIC] (ignores negative hit modifiers, 24.29) |
| Inquisitor's Hand | Urban Enforcers | `cp:ap_shield` — incoming AP worsened by 1 while the unit is wholly within a terrain area (area check at play time) |
| | Superior Weaponry | `cp:ap_boost` — the unit's attacks improve AP by 1 |
| | Inquisitorial Mandate | `cp:secure_objective` — "secure" a controlled objective (14.03): it stays yours while uncontested, pruned when the enemy takes live control |
| Sudden Dawn Cadre | Suppressing Fire | `cp:pin` — the target is pinned: −2" Move through its next Movement phase (`pinnedUntil`, survives the turn reset) |
| | Rapid Acquisition | `cp:secure_objective` (same secured-objective engine as Mandate) |
| | Swift Embarkation | `cp:swift_embark` — in the opponent's Fight phase an unengaged unit within 6" of the Devilfish embarks |
| The Vengeful Brethren | For the Lion | `cp:oc_plus1` — +1 OC per model (flows through every objective-control sum) |
| | Mission Focus | `cp:plus1_hit` — +1 to hit (objective-range condition checked at play time, noted on the card) |
| | Determined to the Last | **text-only**: fights-on-death is not automated — resolve manually (noted on the card) |

**UI**: the Stratagems block lists Core + the side's patrol cards for the
current phase; Inquisitorial Mandate / Rapid Acquisition get a unit + objective
picker and Swift Embarkation a unit + transport picker (`CpSpecialStrat`).
**AI**: the defender plays Refusal to Yield (Strike Squad under real fire) and
Urban Enforcers (unit wholly inside a terrain area) through the same reactive
seam as Smokescreen/Go to Ground, gated by the profile's reaction threshold —
probed AI-vs-AI: Urban Enforcers fires in real games with zero rejected
intents; Refusal to Yield verified at the seam (it emits whenever the incoming
fire clears the threshold).

## 5. Not yet implemented (honest gaps → next steps)

1. **Patrol enhancements in play** — texts are extracted into `cp_patrols.json`
   (Killer Reflexes, Sanctic Slayers, …); no engine bindings yet.
2. **Per-unit specials** — abilities ride on the datasheets as text; none are
   bound to effects yet (Shield Drone, For the Greater Good, Honoured Knights,
   Zealot, Overkill, Gate of Infinity teleport, Co-ordinated Eradication, …).
   Determined to the Last's fights-on-death belongs to this pass too.
3. **Leaders**: only Preacher Teguen has a Leader rule (→ Inquisitorial Agents);
   the pairing works in Declare Battle Formations.
4. Drone tokens (T'au) are modelled as ability text only (Shield Drone's +1 W is
   not applied yet — it belongs with the specials pass).
5. **Command Re-roll single-die uses** (hit/save/wound/damage/hazard/attacks)
   are text-only — see §4b.
