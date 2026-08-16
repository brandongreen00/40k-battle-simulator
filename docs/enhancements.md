# Enhancements — in-game status of all 64

*(2026-07-17. Requested by the owner: "Check that all of my enhancements are working …
perhaps a thorough review of all enhancements?" Until this session, enhancements were
validated in the List Builder and then **ignored in-game**. Units now carry their
`enhancementId` onto the battlefield and `src/core/enhancements.ts` binds everything listed
as **bound** below. Ids refer to `data/game/enhancements.json`.)*

**Legend** — ✅ bound (works in-game) · 🟡 partial (bound with a documented approximation) ·
📖 text-only (no engine binding; the reason is given).

## The owner's current lists

| List | Enhancement | Status | Notes |
|---|---|---|---|
| Rogue Trader's Army (Imperialis Fleet) | **Clandestine Operation** | ✅ | Declare Battle Formations picker in the deployment panel: select up to 3 AoI INFANTRY units (GK Terminator Squad excluded) → they gain Infiltrators and may deploy anywhere >9" from the enemy (Subductors blocking a flank). The AI uses it too. Deployment is gated until the pick is confirmed or skipped. |
| Inquisitors (Purgation Force) | **Ignis Judicium** | ✅ | The bearer's own ranged weapons (and only those — a led squad's guns are unaffected) gain [DEVASTATING WOUNDS], [MELTA 1] and [PRECISION]. |
| Inquisitors (Purgation Force) | **Liber Heresius** | ✅ | After both armies deploy: pull up to 3 AGENTS OF THE IMPERIUM units back into the deployment flow (board or Reserves) — Warrant-of-Trade-style UI block. |

## Imperialis Fleet

| Enhancement | Status | Notes |
|---|---|---|
| Clandestine Operation | ✅ | See above. |
| Combat Landers | ✅ | Same picker: up to 3 VOIDFARERS units gain Deep Strike (place them in Reserves; arrivals validate as Deep Strike). |
| Digital Weapons | 🟡 | When the bearer's unit is selected to fight: 3D6, each 4+ = 1 mortal wound to the fight target; the target's Feel No Pain applies. ([PRECISION]-style allocation simplified to the normal mortal-wound order.) |
| Fleetmaster | 📖 | Once-per-round 0 CP stratagem plays — the CP-discount bookkeeping isn't modelled. |

## Ordo Hereticus Purgation Force

| Enhancement | Status | Notes |
|---|---|---|
| Ignis Judicium | ✅ | Bearer-weapon grant (see above). |
| Liber Heresius | ✅ | Redeploy 3 (see above). |
| No Escape (Aura) | 📖 | Fall Back Ld-test aura — Fall Back interception isn't an engine hook yet. |
| Witch Hunter | ✅ | While leading: re-roll Hit rolls vs PSYKER units. |

## Ordo Xenos Alien Hunters

| Enhancement | Status | Notes |
|---|---|---|
| Amulet of Auto-Chastisement | 📖 | Reactive enemy-Shooting-phase debuff — no reactive shooting-phase hook. |
| Beacon Angelis | 🟡 | The bearer's unit gains Deep Strike (place in Reserves). The 0 CP Rapid Ingress rider is text-only. |
| Blackweave Shroud | 🟡 | FNP 4+ — bound while the bearer fights alone; suppressed when merged into a squad (a unit-wide FNP would over-buff the squad; per-model FNP isn't in the save pipeline). |
| Universal Anathema | ✅ | Bearer's melee weapons gain [ANTI-INFANTRY 2+] and [ANTI-MONSTER 4+]. |

## Ordo Malleus Daemon Hunters

| Enhancement | Status | Notes |
|---|---|---|
| Daemon Slayer | ✅ | Bearer's melee weapons: +1 Attack and [ANTI-DAEMON 3+] (no DAEMON armies in the owned pool, but the +1 A is live). |
| Formidable Resolve | 🟡 | +1 Ld (battle-shock) and +1 W at deployment (single-model bearers). The once-per-battle un-shock is text-only. |
| Gift of the Prescient | 📖 | Grey Knights Terminator carve-out — GK Terminators aren't in the owned lists. |
| Grimoire of True Names (Aura) | 📖 | Enemy Ld/hit/wound aura — enemy-side auras aren't in the effect gathering. |

## Veiled Blade Elimination Force — Extremis Abilities (NOT enhancements)

**These four cards are not pickable enhancements.** The printed detachment rule, *Extremis
Sanction* (Faction Pack v1.1), auto-grants each OFFICIO ASSASSINORUM unit its temple's card and
**mandatorily increases that unit's points cost** by the printed amount. In any army that
includes Veiled Blade (alone or in a multi-detachment pair), `toRoster` stamps the card into the
assassin's enhancement slot (always free — assassins are Epic Heroes), `listPoints` adds the
surcharge, the List Builder card explains the higher price, and the enhancement picker/validation
reject them as picks (`EXTREMIS_ABILITIES` in `core/enhancements.ts`). The rule's second half —
Overkill / Soulless Horror / Shieldbreaker usable twice per battle — is text-only (those
datasheet abilities have no engine binding).

| Extremis ability | Bearer | Surcharge | Status | Notes |
|---|---|---|---|---|
| Decoy Targets | Callidus Assassin | +15 pts | 📖 | Model-swap teleport — no engine primitive. |
| Esoteric Explosives | Culexus Assassin | +10 pts | 📖 | Grenades-stratagem interaction — the Grenades stratagem isn't dice-modelled per roll. |
| Intraneural Biotech | Eversor Assassin | +15 pts | 📖 | 0 CP Heroic Intervention/Counter-offensive — CP-discount bookkeeping isn't modelled. |
| Micromelta Rounds | Vindicare Assassin | +20 pts | ✅ | Exitus rifle gains [ANTI-MONSTER 4+] and [ANTI-VEHICLE 4+] — live via the auto-stamped id. |

## Grizzled Company

| Enhancement | Status | Notes |
|---|---|---|
| Abhuman Detail | 📖 | Ogryn orders/attachment — no Ogryn units in the owned data pool. |
| Aquilan Eye | ✅ | Unlocks the **Target Weak Spot** Order for the bearer (+1 AP within 12"). |
| Spec Ops Veteran | ✅ | Unlocks the **Move to the Shadows** Order (Stealth vs ranged attacks). |
| Laud Hailer | ✅ | The bearer issues Orders at 12" instead of 6". |

## Combined Arms

| Enhancement | Status | Notes |
|---|---|---|
| Death Mask of Ollanius | ✅ | Battle-shocked: models keep OC−1 instead of dropping to 0. |
| Drill Commander | ✅ | Ranged Critical Hits on unmodified 5+ while the unit Remained Stationary. |
| Grand Strategist | 🟡 | +1 Order — enforced for the AI's order budget; the human UI doesn't cap order counts, so it's implicitly available. |
| Reactive Command | 📖 | Order triggered by enemy set-up — no set-up-event hook. |

## Hammer of the Emperor

| Enhancement | Status | Notes |
|---|---|---|
| Calm Under Fire | 📖 | Order echo to a second SQUADRON — multi-target Orders aren't modelled. |
| Indomitable Steed | ✅ | Bearer has Feel No Pain 6+. |
| Regimental Banner | ✅ | +3 Objective Control on the bearer. |
| Veteran Crew | ✅ | Bearer's unit re-rolls Hit rolls of 1. |

## Siege Regiment

| Enhancement | Status | Notes |
|---|---|---|
| Eager Advance | ✅ | While leading a REGIMENT unit: the unit has Scouts 6". |
| Flash Grenades | ✅ | Enemy units cannot Fire Overwatch at the bearer's unit (reducer-enforced; the AI won't try). |
| Legacy Sidearm | ✅ | +2 Attacks on the bearer's Pistols (applies to pistols fired from the bearer's datasheet). |
| Stalwart's Honours | ✅ | An Order issued to the bearer's unit also applies Take Cover!. |

## Steel Hammer

**KEYWORDS rule (11e):** *"In the Muster Armies step, you can select one or more ASTRA
MILITARUM TITANIC units from your army to gain the CHARACTER keyword"* — so the selected tanks
can be given Enhancements and one can be the Warlord. Validation treats taking an enhancement
on an AM TITANIC unit in a Steel Hammer army as the opt-in; the in-game CHARACTER interactions
(Assassination scoring against the tank, Epic Challenge, Precision) are NOT reflected — the
keyword lives on the shared datasheet (known nit).

| Enhancement | Status | Notes |
|---|---|---|
| Assault Hatches | ✅ | Units disembarking after the bearer's Normal move may still charge. |
| Battalion Commander | 🟡 | The bearer gains OFFICER/Voice of Command and may order AM TITANIC + SQUADRON units (human UI; the AI's target filter still prefers REGIMENT). |
| Engine Speaker | 📖 | Rides on Omnissiah's Blessing — that ability itself isn't modelled. |
| Titan Killer | 📖 | Damage-roll re-roll — the combat pipeline has no damage re-roll seam yet. |

## Abhuman Auxiliaries — Upgrades (11e-only detachment)

Both cards are **Upgrade**-tagged. Printed core rule: Upgrades may be given to non-CHARACTER
units, up to **three copies** of the same Upgrade per army, and only the FIRST copy counts
against the army's enhancement budget (each copy still costs its points). Records live in
`tools/ingest/points11e.json` (`addEnhancements`) so a re-ingest reproduces them; bearer
scoping is enforced via the curated `bearerKeywords` field.

The detachment rule, **Absolutist Principles**, is bound: Bullgryn/Ogryn Squads and Ratlings
count as ABHUMAN, and COMMISSAR officers may order them — restricted to **Take Aim!** (the one
Order the printed rule names) at the decision sites (GamePanel + AI).

| Upgrade | Bearer | Status | Notes |
|---|---|---|---|
| Exemplar of Duty (10 pts) | COMMISSAR | 🟡 | The **LEADER: OGRYN SQUAD, BULLGRYN SQUAD** grant is bound (canAttach + Declare Battle Formations + the List Builder's Attach-to). FNP 4+ binds only while the bearer fights alone (an attached Commissar's FNP would over-buff the merged squad — same rule as Blackweave Shroud). |
| Sharp eyes, Light fingers (10 pts) | RATLINGS | 📖 | Detection-range rider on the unit's own shooting — the Hidden detection seam is per-observer, not per-shooter-until-shot. |

## Designation Force — Upgrades (11e-only detachment)

| Upgrade | Bearer | Status | Notes |
|---|---|---|---|
| Long-Range Scout (10 pts) | SCOUT SENTINEL | 📖 | Infiltrators grant — the enhancement deploy-grant seam covers Deep Strike only (no owned list fields Scout Sentinels). |
| Recon Star (10 pts) | AM INFANTRY PLATOON | 📖 | Round-1 ingress move — no seam. `bearerKeywords` uses REGIMENT as the 10e-data stand-in for the 11e PLATOON keyword. |

## Armoured Infantry

| Enhancement | Status | Notes |
|---|---|---|
| Exemplary Officer | 📖 | Order echo to nearby Platoon units — multi-target Orders aren't modelled. |
| Grand Strategist | ✅ | Redeploy 2 REGIMENT/SQUADRON units after deployment. |
| Master Manoeuvrist | 📖 | Reactive embark at the end of the opponent's Fight phase — no such reactive window. |
| Omnissian Unguents (Aura) | 📖 | FNP aura keyed to the detachment-conferred ARMOURED SKIRMISHER keyword (not in the data). |

## Bridgehead Strike

| Enhancement | Status | Notes |
|---|---|---|
| Advance Augury | ✅ | Redeploy 3 REGIMENT units after deployment. |
| Bombast-class Vox-array | 📖 | Multi-target Orders aren't modelled. |
| Priority-drop Beacon | ✅ | The bearer's unit may Deep Strike from battle round 1. |
| Shroud Projector | ✅ | Enemy units cannot Fire Overwatch at the bearer's unit. |

## Mechanised Assault

| Enhancement | Status | Notes |
|---|---|---|
| Bold Leadership | 📖 | Sticky objectives aren't modelled (same gap as Defenders of the Faith). |
| Sacred Unguents | 📖 | Once-per-phase transport hit re-roll — no per-phase pick UI. |
| Smoke Grenades | ✅ | Benefit of Cover + Stealth while the unit is wholly within 3" of a friendly TRANSPORT. |
| Vanguard Honours | 🟡 | The bearer's unit may disembark after the transport Advanced (resolved as a Rapid disembark: 3", no charge — matches "counts as a Normal move, cannot charge"). |

## Recon Element

| Enhancement | Status | Notes |
|---|---|---|
| Guerrilla Honours | ✅ | Redeploy 3 AM INFANTRY units after deployment. |
| Scare Gas Grenades | 📖 | Once-per-battle activated battle-shock test — no activated-ability UI. |
| Survival Gear | ✅ | The bearer has Scouts 6". |
| Tripwires | 📖 | Move-end trigger within 9" — no move-end event hook. |

## Boarding Actions detachments (0 pt — Embarked Regiment, Interdiction Team, Tempestus Boarding Regiment, Voidship's Company)

| Enhancement | Status | Notes |
|---|---|---|
| Covert Breach | 🟡 | Pre-round-1 6" move, bound as Scouts 6" (functionally identical here). |
| Lathimon's Flock | 🟡 | IMPERIAL NAVY BREACHERS gain Infiltrators via the grant picker; the "opponent deploys first" rider is text-only. |
| Rigged Blind Grenades / Shipboard Veteran / Manhunter's Helm / Vasov's Auto-Oppressor / Elimination Force / Heirloom Blade | 📖 | Boarding-Actions mechanics (Hatchways, CP events, priority targets, once-per-battle buffs) aren't modelled on the open board. |

## Where things bind (for the next session)

- `src/core/enhancements.ts` — every table above (effect ids, weapon grants, deploy grants,
  redeploys, carve-out predicates). One-line additions for future bindings.
- `engine.effectsOf` merges enhancement effect ids into every attack; bearer-scoped weapon
  grants merge extra weapon keywords in `resolveAttack` only when the weapon's `sourceDsId`
  is the bearer's datasheet.
- `SetupState.grants` / `SetupState.redeploy` carry the Declare-Battle-Formations picks and
  post-deployment redeploys; `whoActs`/`aiAction` resolve them for AI seats.
- Known honest gaps: per-model FNP (Blackweave when merged), damage re-rolls (Titan Killer),
  multi-target Orders, enemy-side auras, CP discounts, sticky objectives. The AI's shooting/melee
  EV model does not price in enhancement weapon grants (it slightly under-values an Ignis
  Judicium bearer's guns when ranking targets — play is legal, just not optimal).
