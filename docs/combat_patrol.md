# Combat Patrol (11e) — data, maps, and battle mode

> Status after step 2 (2026-08-06): **army selection, deployment AND mission
> scoring work end-to-end.** The four patrol lists and the three 30"×44" maps are
> in the app; a Combat Patrol battle runs the full setup flow, the five phases,
> and scores each side's own patrol mission card (§4a). The patrols'
> *stratagems/enhancements in play* and the per-unit *special abilities* are
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

Still open:
- **Inquisitor's Hand landing page** (its detachment-rule card + DP cost, roster
  list, Force Disposition) and the ASSIGNED AGENTS faction-ability text — the
  only pages of that patrol never captured.
- Mission cards seen in the captures ("Inquisitorial Sanction", "Expansionary
  Campaign", plus collapsed "Seize their Strongholds"/"Purification") are stored
  in `cp_patrols.json` rules text for the missions step.

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
  layer and Tactical Missions deck are **not** initialised (CP missions come in
  a later step; primary scoring currently falls back to the objective markers).
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
| Crowe's Sanctifiers | Purification | **partial** | only the END OF BATTLE block was captured: 5VP per objective controlled (the "10VP per objective sanctified" mechanic is uncaptured and scores nothing) |
| The Vengeful Brethren | Seize their Strongholds | **none** | card contents never captured — scores nothing, and the panel says so |

Interpretation (recorded): the cards' stacked lines score **cumulatively**
(every satisfied line pays — GW's Combat Patrol card convention), so e.g.
holding both expansion objectives in round 1 pays 10+15=25VP. Patrol↔mission
pairing for Purification / Seize their Strongholds is inferred (theme + which
battle-setup screen showed which card) — flag open for owner confirmation.

The AI plays its card: Inquisitorial Sanction boosts CHARACTER-kill EV, and
Expansionary Campaign pulls units toward the expansion objectives (strongest in
rounds 1–2).

## 5. Not yet implemented (honest gaps → next steps)

1. **The two incomplete mission cards** — screenshot the full *Purification*
   card (incl. the Sanctification mechanic/twist selector) and *Seize their
   Strongholds*, and confirm which patrol owns each; then their scoring slots
   into the existing registry. The divider markers' meaning likely lands with
   the sanctification/mission actions too.
2. **Patrol stratagems/enhancements in play** — texts are extracted into
   `cp_patrols.json`; no engine bindings yet. Core 11e stratagems still apply in
   CP battles except AI Rapid Ingress (disabled); a later step should swap the
   whole stratagem list per battle type (incl. "secured" objectives for
   Inquisitorial Mandate, 14.03).
3. **Per-unit specials** — abilities ride on the datasheets as text; none are
   bound to effects yet (Shield Drone, For the Greater Good, Honoured Knights,
   Zealot, Overkill, Gate of Infinity teleport, Co-ordinated Eradication, …).
4. **Leaders**: only Preacher Teguen has a Leader rule (→ Inquisitorial Agents);
   the pairing works in Declare Battle Formations.
5. Drone tokens (T'au) are modelled as ability text only (Shield Drone's +1 W is
   not applied yet — it belongs with the specials pass).
