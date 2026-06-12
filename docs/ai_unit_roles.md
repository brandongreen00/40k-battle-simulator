# AI unit roles & per-unit ability audit (2026-06-12)

Research for the owner's review request: *"the AI sent the Vindicare Assassin far out front when it
should be kept in the back sniping — research each available model and note how they should be
played"*, plus *"do a deep research of abilities that individual units have and if we've missed
anything"*.

Two deliverables live here:

1. **§1 — the role system** the AI now plays by (`src/core/ai/roles.ts`), with the resulting
   assignment and play notes for every unit in the six prebuilt rosters (the pool the AI plays)
   plus the Officio Assassinorum models.
2. **§2 — the ability audit**: every named datasheet ability in that pool, and whether the engine
   implements it (✅), approximates it (＋), or does not yet model it (✗).

---

## 1 · How each unit should be played (the role system)

Roles are derived from the data — abilities, weapon ranges, Indirect Fire, keywords, stats — so
every datasheet gets one without a hand-maintained table. First matching rule wins:

| Role | Signals | The AI now… | Deploys | Keeps |
|---|---|---|---|---|
| **sniper** | Lone Operative + ranged ≥ 36" | sits far back, shoots **CHARACTERS** first (2× target bonus), never charges, kites when approached | deepest (0.85) | ≥ 24–36" away |
| **assassin** | Lone Operative, melee-leaning | pushes up (Infiltrate/Scout), hunts characters & weak units, charge-happy (1.5×) | forward (0.2) | 0" |
| **artillery** | Indirect Fire ≥ 36" | hugs the back edge, fires without line of sight, ignores objectives | deepest (0.9) | 24–36" |
| **gunline** | Vehicle/Monster or ranged ≫ melee, ≥ 24" | holds a range band (≈½ gun range), shoots the scariest legal target | mid-back (0.65) | 12–30" |
| **battleline** | BATTLELINE keyword | takes and **holds** markers (1.4× objective pull); first pick for the home garrison | mid (0.35) | 6" |
| **assault** | melee > ranged | closes and charges (1.3×) | front (0.1) | 0" |
| **skirmisher** | fast (M ≥ 8) + Scouts/Infiltrators | grabs far markers, screens, trades space | forward (0.25) | 8" |
| **support** | CHARACTER (leaders) | pairs with a unit pre-battle (see §Battle formations) or stays with the squads it buffs | middle (0.5) | 14" |
| **transport** | DEDICATED TRANSPORT / Firing Deck | played as light gunline until embark rules exist | middle (0.5) | 12" |

Two behaviours sit on top of the roles (the *"maximise points"* request):

- **Home garrison** — every Movement phase the AI designates one unit (battleline first, then
  skirmisher/gunline; snipers, assassins and artillery only as a last resort; cheaper and closer
  preferred) to hold the objective nearest its own zone. That unit's move-goal list collapses to
  the home marker (with a 3× scoring boost), so the home Primary VP keeps ticking.
- **Hold what you own** — standing on an *already-held* marker now scores 0.45× (0.9× if enemies
  are within 12" of it) instead of the old 0.3×, so units no longer wander off a point the turn
  after taking it. Contested/empty markers still score full weight.

### Role assignments — the AI's roster pool

**Officio Assassinorum** (the user-named models):

| Unit | Role | How the AI plays it now |
|---|---|---|
| **Vindicare Assassin** | sniper | Infiltrates **deep in its own half** (not midfield — role depth 0.85 beats the objective pull), parks at 24–36" and snipes Characters with the 48" Exitus rifle (Deadshot ignores Lone Operative). Never charges; kites if approached. Verified in a probe game: it held 17–24" separation all game and backed away when pressed. |
| **Eversor Assassin** | assassin | Deploys forward, **Scout-moves 9" before round 1**, runs at the enemy (Advance is fine — Frenzon lets it still shoot *and* charge), dives on characters/objective holders. |
| **Callidus Assassin** | assassin | Sets up via Infiltrators near the midfield, fights in the **Fights First** tier, picks off weak units on objectives. |
| **Culexus Assassin** | assassin | Deep Strikes, hunts PSYKERS (Anti-Psyker weapons) — innate Stealth is applied to incoming fire. |

**Fleet Boarding Party** (Imperialis Fleet): Rogue Trader Entourage — *support*; pre-battle it
declares **Backroom Deals** and leads the Imperial Navy Breachers, which therefore **deploy as
Infiltrators** into the midfield. Breachers / Vigilant Squad / Aquila Kill Team — *battleline*
(objective holders, home-garrison picks). Subductor Squad — *assault* (shield wall pushes).
Exaction Squad / Voidsmen — *gunline*. Navigator — *support*. UR-025 — *assassin* (Lone Operative
brawler). Callidus — above. Inquisitorial Chimera — *transport*.

**Deathwatch Vigil** (Ordo Xenos): Watch Master — *support* (pairs with a Kill Team — the pairing
logic deliberately avoids eating the Terminators' Deep Strike). Deathwatch Kill Team — *assault*
(mixed melee loadouts). Terminator Squad — *battleline* with Deep Strike (Reserves). Fortis Kill
Team — *gunline*. Corvus Blackstar — *gunline* (flyer rules not modelled). Vindicare — above.

**Cadian Bulwark** (Grizzled Company): Castellan / Command Squad / Commissar — *support* Officers
(issue Orders; pair with squads pre-battle). Shock Troops — *battleline*. Kasrkin — *gunline*
with **Scouts 6"** (pre-battle move unless a leader without Scouts is attached — then the rule
correctly switches off). Bullgryns — *assault* (innate FNP 6+ applied). Heavy Weapons Squad —
*artillery* (mortars). Leman Russ / Hellhound / Armoured Sentinels — *gunline*. Scout Sentinels —
*skirmisher* (Scouts 9", grabs far markers). Chimera — *transport*. Ministorum Priest — *support*.

**Krieg Siege Echelon** (Siege Regiment): Death Korps / Combat Engineers (Scouts 6") —
*battleline*. Grenadiers / Heavy Weapons Squad / Ratlings (Infiltrators + Stealth) — *gunline*.
Death Riders — *assault*. Basilisk / Earthshaker Carriage / Heavy Mortar Team — *artillery*
(back-edge, Indirect). Krieg Command Squad / Commissar / Marshal — *support*.

**Armoured Spearhead / Hereticus Purgation Force**: tanks and Sisters fall out as *gunline*,
Leman Russ Commander an Order-issuing *support*, Inquisitor & Priest *support*, Daemonhost
*battleline*-brawler, Sanctifiers *gunline* with Scouts 6", Eversor as above.

---

## 2 · Ability audit — what's implemented, what's missed

### Universal / Core abilities (engine-wide)

| Ability | Status | Notes |
|---|---|---|
| Leader (attach) | ✅ | merged single unit; **now declarable BEFORE deployment** (Declare Battle Formations) so set-up grants apply |
| Deep Strike | ✅ | Reserves + round 2+, >9" arrival |
| Infiltrators | ✅ | >9" no-man's-land set-up; **pair-aware** (a led unit infiltrates only if every model has it, or it is granted — Backroom Deals) |
| **Scouts X"** | ✅ **new** | pre-battle Normal move up to X" (per-unit X from the data: Eversor 9", Sentinels 9", Kasrkin 6"…), must end >9" from enemies, first-turn player first; attached unit loses it unless every model has it; the AI makes its own scout moves |
| **Lone Operative** | ✅ **new** | untargetable by ranged attacks beyond 12" (unless attached); mirrored in the AI's target math |
| **Stealth** (innate) | ✅ **new** | −1 to be hit by ranged attacks, read straight off the datasheet ability list |
| **Feel No Pain X+** (innate) | ✅ **new** | bound from the data's ability parameter (Bullgryns 6+, Ostromandeus 4+…) |
| **Fights First** (innate) | ✅ **fixed** | the old check compared numeric ability IDs against the words "fights first", so it never fired; the Callidus now actually fights first |
| Deadly Demise X | ✗ | parameter now captured in the data; the on-death mortal-wound roll is not yet resolved |
| Firing Deck X | ✗ | transports/embarking not modelled |
| Hover / Aircraft | ✗ | flyer movement not modelled (Corvus treated as a ground gunline) |

### Per-unit specials in the AI pool

| Unit · ability | Status | Notes |
|---|---|---|
| Rogue Trader · **Backroom Deals** | ✅ **new** | declare the pairing pre-deployment; the led unit gains Infiltrators (one pick per army) |
| Rogue Trader · **Warrant of Trade** | ✅ **new** | after both armies deploy: roll D3, pull up to that many IMPERIUM BATTLELINE units back and redeploy them (board or Reserves); the heuristic AI currently declines |
| Rogue Trader · Healing Serum | ✗ | start-of-Command D3-model resurrection not modelled |
| Eversor · **Frenzon** | ✅ **new** | eligible to shoot *and* charge in a turn it Advanced (text-matched, so any same-worded ability benefits) |
| Eversor · Overkill | ✗ | once-per-battle +6" M / +3 A pre-move buff not modelled |
| Vindicare · **Deadshot** | ✅ **new** | its ranged attacks ignore Lone Operative |
| Vindicare · Shieldbreaker | ✗ | once-per-battle wound/invuln-bypass round not modelled |
| Callidus · Acrobatic Escape / Lord of Deceit | ✗ | end-of-phase D6 fall-back; +1 CP cost aura — not modelled (reactive seams exist) |
| Culexus · Psychic Assassin / Soulless Horror / Abomination | ✗ | A-characteristic swap vs PSYKERS; aura Battle-shock; FNP 2+ vs psychic (no psychic attacks in the pool yet) |
| Officio · Shadow Assignment | ✗ | pre-battle model swap is a list-building concern |
| AM Officers · Voice of Command / Orders | ✅ | six Orders + Grizzled Company rider (earlier stage) |
| Kasrkin/Engineers/Sentinels/Sanctifiers · Scouts | ✅ **new** | see Scouts above |
| Ratlings · Shoot Sharp and Scarper | ✗ | post-shooting D6 move not modelled |
| Bullgryn · Slabshield/Brute Shield | ＋ | defensive wargear table (4++/save) — per-model saves implemented earlier |
| Breachers · Endurant Shield | ＋ | as above |
| Death Riders · Screening Line | ✗ | reactive move — the reactive seam exists, the binding doesn't |
| Medi-pack / Master Vox / Regimental Standard / vox-casters | ✗ | squad utility effects pending the owned lists' enumeration |
| Astartes/Storm Shield (Deathwatch) | ＋ | 4++ via the defensive-wargear table |
| Chimera/Immolator etc. · transport rules | ✗ | embark/disembark out of scope so far |

**Read this table as the running checklist** for Stage 4's "your lists, faithfully" work: every ✗
binds to either `EFFECT_REGISTRY`/`INNATE_ABILITY_EFFECTS` (one line once implemented) or to a
small engine carve-out like the ones added in this pass.

### Visibility model (review item 5)

10e Ruins rules as implemented (`src/core/los.ts` + per-model gating in `engine.ts`):

- sight **into** a tall-ruin footprint: allowed (models within can be seen and targeted);
- sight **out of** a ruin a model is inside: allowed;
- sight **through** a footprint (both models outside it): **blocked** — and a model inside ruin A
  still cannot see through a *second* ruin B;
- **per-model**: only the bearers that themselves have a sightline fire — one squad mate peeking
  around a corner no longer lets ten hidden guns shoot (it used to);
- low (blue) area terrain never blocks, it grants the Benefit of Cover;
- Indirect Fire still ignores all of it at −1 to hit + cover.

Centre-to-centre sampling between model positions remains the documented simplification.
