<!-- Repo copy of the mission-deck research dossier that drives src/core/missions11.ts,
     missionflow.ts and secondaries.ts. Personal-use reference (GW IP); do not publish.
     Sources and unverified gaps are listed at the bottom of the file. -->

# Warhammer 40,000 11th Edition — Chapter Approved Mission Deck (June 2026)
## Research dossier: Force Dispositions, Primary Missions, Secondary Missions, scoring caps, actions

**Research date:** 2026-07-03.
**Primary source:** GDM 2026 (gdmissions.app, "Game Datacards & Missions") — a complete, card-by-card transcription of the 11th edition Chapter Approved Mission Deck, with structured card data embedded in each page and card-image renders. ALL 25 primary-mission card faces were visually read from GDM's full-card image renders and cross-checked against the structured data — the scoring blocks matched exactly in every case. Four cards carry a rules preamble that exists ONLY on the card face (not in GDM's structured data): Punishment, Consecrate, Locate and Deny, Surveil the Foe — transcribed from the images and included below. One primary-mission back side (Death Trap/Booby Trap) and four secondary cards (Assassination and Defend Stronghold, attacker AND defender versions) were also image-verified.
**Corroborating sources:** warhammer-community.com CA-deck article, Tabletop Battles (Goonhammer's 40k site) 11th-edition mission articles (reviewed a GW preview copy), spikeybits/BoLS coverage.
**NOT available:** Wahapedia has NOT yet published the 11th-ed Force Disposition deck as of 2026-07-03 — its `wh40k11ed` namespace still hosts 10th-ed-style content (the old CA 2025-26 deck with Leviathan/Pariah Nexus packs; no "Force Disposition" anywhere). Do not use wahapedia for this deck yet.

**Caveat on fidelity:** everything below is quoted from GDM 2026's transcription (a fan transcription of the official cards, used widely for tournament play and self-consistent with its own card renders and with GW's official FAQ wording quoted in the Event Companion). Official GW card scans were not directly available. Anything I could not verify is flagged in §8.

---

## 1. System overview (verified)

- Each **Detachment** grants access to a **Force Disposition**; when building an army the player selects one Force Disposition available to them (in the tournament/Event pack it is recorded on the roster at muster and fixed for the event; in casual core-rules play it is chosen before each game). *(Source: Tabletop Battles "An Introduction to Missions in 11th Edition", 2026-06-01; GDM Event Companion step 1.)*
- The five Force Dispositions: **Take and Hold, Purge the Foe, Disruption, Reconnaissance, Priority Assets**.
- Event Companion, step 2 ("Determine Mission"), exact text: "Each player finds their opponent's Force Disposition symbol on their Force Disposition card. The Primary Mission that is listed below that symbol is that player's Primary Mission, which describes how to score VP."
- So in any game each player plays **their own Primary Mission** determined by the ordered pair (own disposition, opponent disposition). 15 unordered matchups → **25 distinct primary missions** (5 mirror + 20 off-diagonal). The retail deck reportedly contains **30 Primary Mission cards** (warhammer-community) — 25 distinct missions with duplicates of the 5 mirror-match cards so both players can hold one.
- Battles are 5 battle rounds on a 44"×60" battlefield. Each combination of Primary Missions has three recommended layouts (A/B/C) in the Warhammer 40,000 app / Event Companion.
- **Attacker/Defender** (Event Companion step 5, exact text): "Players look at the selected layout and agree which edges of the battlefield the players have set up correspond with the Attacker's and Defender's battlefield edges labelled on the card. Roll off: the winner decides who will be the Attacker and who will be the Defender." Defender deploys first (step 8); Attacker resolves redeploys first (step 9); separate roll-off for first turn (step 10).
- **Objective designations** (new official terminology; per Tabletop Battles terrain/objectives deep dive): **Home Objective** = the single objective in each player's deployment zone; **Expansion Objectives** = two objectives in no-man's-land, each closer to one player's zone; **Central Objective(s)** = one central objective (30 of 45 official layouts) or two slightly offset from centre (the other 15). Official layouts label which is which. In 11th ed objectives are normally **terrain areas** (a model is within range if within the terrain area); a rulebook-appendix variant uses 40mm markers with a 3" control radius. Control = highest total OC of models within range, checked at end of each phase and end of turn; "a unit controls an objective" = it has a model with OC≥1 within range of an objective its owner controls. Some rules make an objective **Secured**: it stays under a player's control until the opponent has a higher Level of Control at the end of a phase.

### Mission sequence (Warhammer Event / tournament; GDM Event Companion, abridged headings)
1. Muster Armies (select Force Disposition on roster) · 2. Determine Mission (disposition cross-reference) · 3. Determine a Layout (A/B/C) · 4. Create the Battlefield (44"×60") · 5. Determine Attacker and Defender (roll-off) · 6. Select Secondary Missions (secretly note Tactical or Fixed; if Fixed, note which two) · 7. Declare Battle Formations (secretly note embarked units + strategic reserves) · 8. Deploy Armies (alternating, Defender first; TITANIC counts double) · 9. Redeploy Units (alternate, Attacker first) · 10. Determine First Turn (roll-off) · 11. Resolve Pre-battle Rules · 12. Begin the Battle · 13. End the Battle (after 5 rounds) · 14. Determine Victor.

### Scoring caps (Event Companion step 14, exact text)
> "Each player scores 10VP if their army is painted to a Battle Ready standard. At the end of the battle, the player with the most VP is the victor. If the players are tied, the battle is a draw. The maximum VP that can be scored from each source of VP is listed below. Any VP you score in excess of these maximums are ignored."
>
> "PRIMARY MISSION 45VP — Up to 15VP per battle round. SECONDARY MISSIONS 45VP — Up to 15VP per battle round*. BATTLE READY ARMY 10VP. (*) In addition, you can gain a maximum of 20VP per Fixed Secondary Mission card."

Max total = 45 + 45 + 10 = **100VP**. This CONFIRMS the caps you asked about (primary 45 @ 15/round; secondary 45 @ 15/round with 20 per fixed card; Battle Ready 10).

### Secondary mission selection & lifecycle (Event Companion step 6, exact text)
- "Players now secretly note down whether they will use Tactical or Fixed Secondary Missions. If using Fixed Missions, they also note down which two Fixed Missions they will use." Then reveal.
- **Fixed:** "Fixed Missions are those marked with the symbol shown on the left. If you are using Fixed Missions, display your selected Fixed Mission cards face-up. Fixed Missions cannot be discarded and are active for you throughout the battle." (You pick **two** of the **four** Fixed-capable cards.)
- **Tactical:** "shuffle your Secondary Mission deck face-down. • At the start of your Command phase, draw two Secondary Missions face-up from your Secondary Missions deck; these Secondary Missions are active for you. • (Once per battle) At the end of your Command phase, you can spend 1CP to discard one of your active Secondary Mission cards and draw one new Secondary Mission card." There is **no hand-size limit**; unscored cards carry over (Tabletop Battles).
- **Achieving:** "At the end of each player's turn, each player does the following, starting with the player whose turn it is: • First, if you met the conditions on one or more Secondary Missions, you can gain the VP specified on that card. If you do, and if you are using Tactical Secondary Missions, discard that Secondary Mission — it is achieved. • Then, if it is your turn and you are using Tactical Secondary Missions, you can discard one or more of your active Secondary Missions. If you do, you gain 1CP." (Scoring is a MAY — you can decline to score a partially-met card and keep it.)
- Each player has their **own** secondary deck: the boxed deck provides an **Attacker deck and a Defender deck** with the same 18 missions. Spot-check of Assassination and Defend Stronghold attacker-vs-defender card images: **rules text identical**, only the deck badge (red crossed-swords = Attacker / green shield = Defender) differs. Conditions are written relative to "your"/"enemy" deployment zone, so the decks are functionally symmetric.

### Card terminology (Event Companion, exact text)
- **Cumulative:** "Some cards include a condition marked as 'cumulative' that follows a normal condition. If a player achieves the cumulative condition, they gain the VP for both that and the normal condition."
- **Or:** "Some cards include one or more conditions marked 'or' that follow a normal condition. A player can only gain VP for one of these conditions or the normal condition."
- **Leaves the battlefield:** "A unit leaves the battlefield if it is destroyed, if it embarks on a TRANSPORT, or if a rule removes that unit from the battlefield (e.g. to place it in strategic reserves)."
- **One:** "When a card states 'one', underlined, it means exactly one, not one or more."
- **VP up to a limit:** "Some cards award VP up to a limit, e.g. (up to 5VP). In such cases, any VP you score in excess of this limit are ignored."
- **When Drawn:** "Some Secondary Mission cards begin with a 'When Drawn' section. Note that this section only applies if you are using Tactical Secondary Missions."

### Actions — general rules (11th ed Core Rules §16, via GDM core-rules transcription; exact text)
> "Some rules allow units to perform actions. Each action states: STARTS: When it is started. UNITS: Which friendly units can perform it. USE LIMIT: How many times friendly units can start it. COMPLETES: When it completes. EFFECT: What the effects of completing it are. Any additional restrictions that may apply."
>
> "STARTING AN ACTION — A unit is eligible to start an action unless one or more of the following apply to that unit: It is not on the battlefield. It is an AIRCRAFT/FORTIFICATION unit. It is battle-shocked. It has an OC characteristic of 0 or '-'. It is engaged (unless it is a TITANIC unit). It made an advance or fall-back move this turn. It started another action this turn. If a unit starts an action, until the end of the turn: It is not eligible to shoot (excluding TITANIC units). It is not eligible to declare a charge."
>
> "COMPLETING AN ACTION — If a unit performing an action makes a move (excluding pile-in and consolidation moves) or leaves the battlefield, that unit does not complete that action. Otherwise, when an action is completed, its 'Effect' section is triggered."

(Related: a unit that shoots is "not eligible to start an action" until end of phase — Core Rules §15 'After Shooting'.)

**Operation markers:** several primary missions have an **Objective Action on the card's reverse** that places the mission's *operation markers* (mission-specific tokens). Official FAQ (Event Companion): "Your Primary Mission card will specify how and when you can remove operation markers from the battlefield. If it doesn't, you cannot remove operation markers."

---

## 2. Disposition pairing → Primary Mission matrix (CONFIRMED, authoritative)

Extracted from GDM 2026's matrix data (rows = YOUR disposition, columns = OPPONENT's). This confirms your Event Companion extraction and fills the gaps: the "one more" alongside Vital Link is **Destroyer's Wrath** (the Purge player's mission vs Priority Assets); Vital Link itself is the **Priority Assets** player's mission vs Purge the Foe. Note also **Purge and Secure is the Take-and-Hold player's mission vs RECONNAISSANCE** (and Reconnaissance Sweep is the Recon player's mission in the same matchup), and **Secure Asset is the Priority-Assets player's mission vs Take and Hold** (Inescapable Dominion being the T&H player's).

| You \ Opponent | Take and Hold | Purge the Foe | Disruption | Reconnaissance | Priority Assets |
|---|---|---|---|---|---|
| **Take and Hold** | Battlefield Dominance | Immovable Object | Determined Acquisition | Purge and Secure | Inescapable Dominion |
| **Purge the Foe** | Unstoppable Force | Meatgrinder | Punishment | Consecrate | Destroyer's Wrath |
| **Disruption** | Death Trap | Delaying Action | Outmanoeuvre | Smoke and Mirrors | Locate and Deny |
| **Reconnaissance** | Reconnaissance Sweep | Triangulation | Surveil the Foe | Gather Intel | Search and Scour |
| **Priority Assets** | Secure Asset | Vital Link | Extract Relic | Vanguard Operation | Sabotage |

Source: https://gdmissions.app/11th/matrix (data embedded in the page's JS module, verified against every individual card page's "vs" field and each card render's footer, e.g. Battlefield Dominance footer: "OPPONENT: TAKE AND HOLD — MIRROR").

---

## 3. Primary Missions — full card rules (all 25)

Formatting notes: each card is a list of scoring blocks. `[WHEN window] — When: trigger` then the conditions. "per instance" = the card's stacked-VP icon ("For each …"). "+ CUMULATIVE" rows add to the row above when both are met; "OR" rows are alternatives (see §1 terminology). "Second battle round onwards" Command-phase scoring uses the standard rider "(or the end of your turn in the fifth battle round)" — i.e. in round 5 the player scores it at end of turn instead (helps the player going second). Cards with an **Objective Action** show it after the scoring blocks (it is printed on the card's reverse; 11 of 25 primaries have one). Rows in the SAME block separated without a chip (rendered on the cards as a dashed divider) are independent conditions — each can be scored in the same scoring window, subject to the 15VP/round cap. VP numbers are per-scoring-event unless marked per instance; the 15VP/round primary cap always applies.


### Take and Hold player's missions

#### Battlefield Dominance — *Take and Hold* vs *Take and Hold* (mirror match — both players play this card)

**[FIRST & SECOND BATTLE ROUND]** — When: End of your turn
  - You control more **objectives** than your opponent. → **2VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - For each **objective** you control. → **3VP** **per instance ("for each")**
  - + CUMULATIVE: For each of those **objectives** (excluding your **home objective**) if you control your **home objective**. → **2VP** **per instance ("for each")**

Source: https://gdmissions.app/11th/primary-missions/take-and-hold/battlefield-dominance

#### Immovable Object — *Take and Hold* vs *Purge the Foe*

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control one or more **central objectives**. → **3VP**

**[SECOND TO FOURTH BATTLE ROUND]** — When: End of your Command phase
  - For each **objective** you control (excluding your **home objective**). → **5VP** **per instance ("for each")**

**[FIFTH BATTLE ROUND]** — When: End of your turn
  - For each **objective** you control (excluding your **home objective**). → **5VP** **per instance ("for each")**

Source: https://gdmissions.app/11th/primary-missions/take-and-hold/immovable-object

#### Determined Acquisition — *Take and Hold* vs *Disruption*

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each **objective** you control that you did not control at the start of the turn (excluding your **home objective**). → **2VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - For each **objective** you control. → **3VP** **per instance ("for each")**
  - + CUMULATIVE: For each of those **objectives** that is within your opponent's territory. → **3VP** **per instance ("for each")**

Source: https://gdmissions.app/11th/primary-missions/take-and-hold/determined-acquisition

#### Purge and Secure — *Take and Hold* vs *Reconnaissance*

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units were **destroyed** this turn by a friendly unit that was within range of one or more **objectives**. → **3VP**
  - OR: One or more enemy units that started the turn within range of one or more **objectives** were **destroyed** this turn. → **3VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - For each **objective** you control (excluding your **home objective**). → **4VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - You control one or more **objectives** you did not control at the start of the turn (excluding your **home objective**). → **3VP**

Source: https://gdmissions.app/11th/primary-missions/take-and-hold/purge-and-secure

#### Inescapable Dominion — *Take and Hold* vs *Priority Assets*

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control **three or more objectives**. → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control **two or more objectives**. → **5VP**
  - You control more **objectives** than your opponent. → **4VP**

**[END OF BATTLE]**
  - You control your opponent's **home objective**. → **5VP**

Source: https://gdmissions.app/11th/primary-missions/take-and-hold/inescapable-dominion


### Purge the Foe player's missions

#### Unstoppable Force — *Purge the Foe* vs *Take and Hold*

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units were **destroyed** this turn. → **3VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - For each **objective** you control (excluding your **home objective**). → **4VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - You control one or more **objectives** you did not control at the start of the turn (excluding your **home objective**). → **3VP**

**[END OF BATTLE]**
  - You control one or more **central objectives**. → **5VP**

Source: https://gdmissions.app/11th/primary-missions/purge-the-foe/unstoppable-force

#### Meatgrinder — *Purge the Foe* vs *Purge the Foe* (mirror match — both players play this card)

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units were **destroyed** this turn. → **3VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - More enemy units were **destroyed** this turn than friendly units were **destroyed** in the previous turn. → **5VP**
  - You control your opponent's **home objective**. → **5VP**

Source: https://gdmissions.app/11th/primary-missions/purge-the-foe/meatgrinder

#### Punishment — *Purge the Foe* vs *Disruption*

**Card preamble (setup rule, printed above the scoring blocks; transcribed from the card face):** "START OF YOUR TURN: Choose one to three enemy units on the battlefield that are within range of objectives and/or **destroyed** at least one friendly unit during the previous turn. If you cannot do so, choose any enemy unit on the battlefield instead. From now until the start of your next turn, those units are **condemned**."

**[ANY BATTLE ROUND]** — When: End of a turn
  - One or more **condemned** enemy units left the battlefield this turn. → **5VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**
  - You control more **objectives** than your opponent. → **5VP**

**[END OF BATTLE]**
  - You control your opponent's **home objective**. → **8VP**

Source: https://gdmissions.app/11th/primary-missions/purge-the-foe/punishment

#### Consecrate — *Purge the Foe* vs *Reconnaissance*

**Card preamble (transcribed from the card face):** "CONSECRATE: When a friendly unit **destroys** an enemy unit it becomes a **consecration unit**. At the end of your turn, each consecration unit in range of an **objective** (excluding your **home objective**) not yet **consecrated** consecrates it — place an operation marker there; the unit then is no longer a consecration unit."

**[ANY BATTLE ROUND]** — When: End of your turn
  - **One or two** objectives are **consecrated**. → **3VP**
  - OR: **Three or more** objectives are **consecrated**. → **6VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**
  - You control **more** objectives than your opponent. → **4VP**

**[END OF BATTLE]**
  - The enemy **home objective** has been **consecrated**. → **5VP**

Source: https://gdmissions.app/11th/primary-missions/purge-the-foe/consecrate

#### Destroyer's Wrath — *Purge the Foe* vs *Priority Assets*

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units were **destroyed** this turn. → **3VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**
  - You control more **objectives** than your opponent. → **6VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - More enemy units were **destroyed** this turn than friendly units were **destroyed** in the previous turn. → **4VP**

Source: https://gdmissions.app/11th/primary-missions/purge-the-foe/destroyers-wrath


### Disruption player's missions

#### Death Trap — *Disruption* vs *Take and Hold*

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each terrain area **trapped** this turn (see reverse). → **2VP** **per instance ("for each")**
  - + CUMULATIVE: For each of those **terrain areas** that is an **objective**. → **3VP** **per instance ("for each")**

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units that started the turn within a terrain area were destroyed, if that terrain area is **trapped**. → **3VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**Objective Action (card reverse): “Booby Trap”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of an **objective** (excluding your **home objective**), or within a terrain area outside your deployment zone that is not yet **trapped**.
  - **USE LIMIT**: Unlimited. Each unit initiating this action this phase must be within a different terrain area.
  - **COMPLETES**: Immediately.
  - **EFFECT**: That terrain area is **trapped** — place one of your operation markers within that terrain area.

Source: https://gdmissions.app/11th/primary-missions/disruption/death-trap

#### Delaying Action — *Disruption* vs *Purge the Foe*

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each enemy unit **destroyed** this turn. → **2VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding **home objectives**). → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - You control one or more **central objectives** and one or more **expansion objectives**. → **3VP**

Source: https://gdmissions.app/11th/primary-missions/disruption/delaying-action

#### Outmanoeuvre — *Disruption* vs *Disruption* (mirror match — both players play this card)

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control the enemy **home objective**. → **10VP**

**[FIRST BATTLE ROUND]** — When: End of your turn
  - For each **objective** you control (excluding your **home objective**). → **4VP** **per instance ("for each")**

**[SECOND & THIRD BATTLE ROUND]** — When: End of your Command phase
  - For each **objective** you control (excluding your **home objective**). → **5VP** **per instance ("for each")**

**[FOURTH BATTLE ROUND ONWARDS]** — When: End of your turn
  - For each **objective** you control (excluding your **home objective**). → **6VP** **per instance ("for each")**

Source: https://gdmissions.app/11th/primary-missions/disruption/outmanoeuvre

#### Smoke and Mirrors — *Disruption* vs *Reconnaissance*

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each **objective** that is **decoyed** (see reverse). → **2VP** **per instance ("for each")**
  - + CUMULATIVE: For each of those **objectives** that is within your opponent's territory. → **2VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[END OF BATTLE]**
  - **Four or more objectives** are **decoyed**. → **10VP**

**Objective Action (card reverse): “Decoy”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of an **objective** (excluding your **home objective**) that is not a **decoy**.
  - **USE LIMIT**: Unlimited. Each unit that starts this action this phase must be within range of a different **objective**.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: That **objective** becomes a **decoy** — place one of your operation markers within range of that **objective**.

Source: https://gdmissions.app/11th/primary-missions/disruption/smoke-and-mirrors

#### Locate and Deny — *Disruption* vs *Priority Assets*

**Card preamble (transcribed from the card face):** "START OF THE BATTLE: Select five terrain areas not within your deployment zone and place one of your operation markers in each. If this is not possible, place one in each terrain area outside your deployment zone."

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units that started the turn within range of one or more **objectives** are **destroyed**. → **4VP**
  - Only one of your operation markers remains (see reverse), with a unit of yours in that terrain area and no enemy units there. → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[END OF BATTLE]**
  - Only one of your operation markers remains, with a unit of yours in that terrain area and no enemy units there. → **5VP**

**Objective Action (card reverse): “Sensor Sweep”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of a central **objective**.
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: Your unit performs a **sensor sweep** — remove one operation marker from the battlefield.
  - **RESTRICTION**: A unit cannot start this action if only one operation marker remains on the battlefield.

Source: https://gdmissions.app/11th/primary-missions/disruption/locate-and-deny


### Reconnaissance player's missions

#### Reconnaissance Sweep — *Reconnaissance* vs *Take and Hold*

**[ANY BATTLE ROUND]** — When: End of your turn
  - Three or more friendly units are wholly within three different table quarters and not within 6" of the centre of the battlefield. → **3VP**
  - OR: Four or more friendly units are wholly within four different table quarters and not within 6" of the centre of the battlefield. → **6VP**

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each enemy unit **destroyed** this turn. → **1VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **3VP**

Source: https://gdmissions.app/11th/primary-missions/reconnaissance/reconnaissance-sweep

#### Triangulation — *Reconnaissance* vs *Purge the Foe*

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - One **objective** is **triangulated** (see reverse). → **3VP**
  - OR: Two **objectives** are **triangulated**. → **6VP**
  - OR: Three or more **objectives** are **triangulated**. → **10VP**

**[END OF BATTLE]**
  - You control **four or more objectives**. → **10VP**

**Objective Action (card reverse): “Triangulate”**

  - **STARTS**: Your Shooting phase, from the second battle round onwards.
  - **UNITS**: One friendly unit within range of an **objective** (excluding your **home objective**).
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: That **objective** is **triangulated** — place one of your **operation markers** within range of that **objective**.

Source: https://gdmissions.app/11th/primary-missions/reconnaissance/triangulation

#### Surveil the Foe — *Reconnaissance* vs *Disruption*

**Card preamble (transcribed from the card face):** "Each time a friendly unit ends a move within range of an **objective** that has enemy **operation markers** within range of it, remove those **operation markers** from the battlefield."

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more enemy units were **surveilled** this turn (see reverse), unless each of those units is within range of one or more **objectives** that have one or more **operation markers** within range of them. → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**
  - You control more **objectives** than your opponent. → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - No enemy **operation markers** are on the battlefield. → **5VP**

**Objective Action (card reverse): “Surveil the Foe”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit.
  - **USE LIMIT**: Unlimited.
  - **COMPLETES**: Immediately.
  - **EFFECT**: Select one enemy unit within 18" of your unit that is visible to it and has not yet been **surveilled** this turn. Until the end of the turn, that enemy unit is **surveilled**.

Source: https://gdmissions.app/11th/primary-missions/reconnaissance/surveil-the-foe

#### Gather Intel — *Reconnaissance* vs *Reconnaissance* (mirror match — both players play this card)

**[FIRST BATTLE ROUND]** — When: End of your turn
  - You control one or more **central objectives**. → **6VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your turn
  - For each friendly unit that **extracted intelligence** this turn (see reverse). → **7VP** **per instance ("for each")**

**[END OF BATTLE]**
  - Three or more of your **operation markers** are on the battlefield. → **5VP**
  - One of your **operation markers** is within range of your opponent's **home objective**. → **5VP**

**Objective Action (card reverse): “Extract Intelligence”**

  - **STARTS**: Your Shooting phase, from the second battle round onwards.
  - **UNITS**: One friendly unit within range of an **objective** (excluding your **home objective**) that does not have any of your **operation markers** within range of it.
  - **USE LIMIT**: Unlimited. Each unit that starts this action this phase must be within range of a different **objective**.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: Your unit **extracts intelligence** — place one of your **operation markers** within range of that **objective**.

Source: https://gdmissions.app/11th/primary-missions/reconnaissance/gather-intel

#### Search and Scour — *Reconnaissance* vs *Priority Assets*

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control one or more **central objectives**. → **3VP**
  - One or more enemy units that started the turn within a **terrain area** are **destroyed**. → **2VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - For each **objective** you control (excluding your **home objective**). → **4VP** **per instance ("for each")**

**[END OF BATTLE]**
  - No enemy units are wholly within your territory. → **5VP**

Source: https://gdmissions.app/11th/primary-missions/reconnaissance/search-and-scour


### Priority Assets player's missions

#### Secure Asset — *Priority Assets* vs *Take and Hold*

**[ANY BATTLE ROUND]** — When: End of your turn
  - A friendly unit **secured the asset** this turn (see reverse). → **4VP**
  - One or more enemy units that started the turn within range of one or more **central objectives** are **destroyed**. → **2VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**
  - You control **three or more objectives**. → **4VP**

**Objective Action (card reverse): “Secure Asset”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of an **objective** (excluding your **home objective**).
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: Your unit **secures the asset**.

Source: https://gdmissions.app/11th/primary-missions/priority-assets/secure-asset

#### Vital Link — *Priority Assets* vs *Purge the Foe*

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control one or more **central objectives**. → **2VP**
  - + CUMULATIVE: For each of your **operation markers** within range of one of those **objectives** (see reverse). → **1VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**
  - + CUMULATIVE: One or more of those **objectives** is a **central objective**. → **4VP**

**[END OF BATTLE]**
  - You control your opponent's **home objective**. → **10VP**

**Objective Action (card reverse): “Maintain Control”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of one **central objective**.
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: Place one of your **operation markers** within range of that **objective**.

Source: https://gdmissions.app/11th/primary-missions/priority-assets/vital-link

#### Extract Relic — *Priority Assets* vs *Disruption*

**[ANY BATTLE ROUND]** — When: End of your turn
  - A friendly unit performed a **sensor sweep** this turn (see reverse). → **4VP**
  - One or more enemy units that started the turn within range of one or more **objectives** are **destroyed**. → **3VP**
  - Only one of your opponent's **operation markers** is on the battlefield, if one or more of your units are within the same terrain area as that **operation marker**, and no enemy units are within that terrain area. → **4VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[END OF BATTLE]**
  - Only one of your opponent's **operation markers** is on the battlefield, if one or more of your units are within the same terrain area as that **operation marker**, and no enemy units are within that terrain area. → **5VP**

**Objective Action (card reverse): “Sensor Sweep”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of a **central objective**.
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: End of your turn, if your unit controls that **objective**.
  - **EFFECT**: Your unit performs a **sensor sweep** — remove one **operation marker** from the battlefield.
  - **RESTRICTIONS**: A unit cannot start this action if only one **operation marker** remains on the battlefield.

Source: https://gdmissions.app/11th/primary-missions/priority-assets/extract-relic

#### Vanguard Operation — *Priority Assets* vs *Reconnaissance*

**[ANY BATTLE ROUND]** — When: End of your turn
  - A friendly unit performed a **vanguard operation** this turn (see reverse). → **4VP**
  - One or more enemy units were **destroyed** this turn. → **2VP**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**[END OF BATTLE]**
  - You control your opponent's **home objective**. → **10VP**

**Objective Action (card reverse): “Vanguard Operation”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within a terrain area located in enemy territory.
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: End of your turn, provided no enemy units are within that terrain area.
  - **EFFECT**: Your unit performs a **vanguard operation**.

Source: https://gdmissions.app/11th/primary-missions/priority-assets/vanguard-operation

#### Sabotage — *Priority Assets* vs *Priority Assets* (mirror match — both players play this card)

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each friendly unit that **committed sabotage** this turn (see reverse). → **3VP** **per instance ("for each")**
  - + CUMULATIVE: For each of those **units** that is within range of one or more **objectives** in your opponent's territory. → **2VP** **per instance ("for each")**

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your Command phase (or the end of your turn in the fifth battle round)
  - You control one or more **objectives** (excluding your **home objective**). → **4VP**

**Objective Action (card reverse): “Sabotage”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One unit within range of an **objective** (excluding your **home objective**).
  - **USE LIMIT**: Unlimited. Each unit that starts this action this phase must be within range of a different **objective**.
  - **COMPLETES**: End of your turn, if that unit controls that **objective**.
  - **EFFECT**: Your unit **commits sabotage**.

Source: https://gdmissions.app/11th/primary-missions/priority-assets/sabotage


---

## 4. Secondary Missions — full card rules (all 18)

The deck is 18 cards per player (Attacker deck + Defender deck, same contents — see §1). **Four cards are dual FIXED/TACTICAL** (usable as Fixed missions): **Assassination, Bring it Down, A Grievous Blow, Engage on All Fronts**; the FIXED block on those cards is the version used when the card is one of your two chosen Fixed Missions, and the TACTICAL block is the version used when it is drawn from the deck. All other cards are Tactical-only. Per Tabletop Battles: A Grievous Blow ≈ renamed Cull the Horde; Forward Position reworks Capture Enemy Outpost; Plunder replaces Sabotage; Centre Ground replaces Area Denial; Burden of Trust moved from primary (10th) to secondary; Beacon is new.

#### A Grievous Blow — **FIXED-capable**

> **WHEN DRAWN:** If no enemy units with a **Starting Strength** of 13 or more are on the battlefield, _you may_ discard this card and draw one new **Secondary Mission** card.

**[ANY BATTLE ROUND]** *(applies to the FIXED version of the card)* — When: End of a turn
  - For each enemy unit with a **Starting Strength** of 13 or more that is **destroyed** this turn. → **4VP**

**[ANY BATTLE ROUND]** *(applies to the TACTICAL version of the card)* — When: End of a turn
  - One or more enemy units with a **Starting Strength** of 13 or more were **destroyed** this turn. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/a-grievous-blow-defender (attacker version identical bar deck badge)

#### A Tempting Target

> **WHEN DRAWN:** Your opponent selects one **objective** (excluding **home objectives**) within No Man's Land to be your **tempting target**.

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control your **tempting target**. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/a-tempting-target-defender (attacker version identical bar deck badge)

#### Assassination — **FIXED-capable**

**[ANY BATTLE ROUND]** *(applies to the FIXED version of the card)* — When: End of a turn
  - For each enemy **CHARACTER** model **destroyed** this turn. → **3VP**
  - + CUMULATIVE: For each of those models with a **Wounds** characteristic of 4 or more. → **+1VP**

**[ANY BATTLE ROUND]** *(applies to the TACTICAL version of the card)* — When: End of either player's turn
  - One or more enemy **CHARACTER** models were **destroyed** this turn. → **5VP**
  - OR: All enemy **CHARACTER** models have been **destroyed** during the battle. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/assassination-defender (attacker version identical bar deck badge)

#### Beacon

> **WHEN DRAWN:** Choose one friendly unit on the battlefield, or embarked within a **TRANSPORT** on the battlefield, to be your **beacon** unit.

**[ANY BATTLE ROUND]** — When: End of your opponent's turn or the end of the fifth battle round (whichever comes first)
  - Your **beacon** unit is on the battlefield and not within your deployment zone. → **3VP**
  - OR: Your **beacon** unit is on the battlefield and not within your territory. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/beacon-defender (attacker version identical bar deck badge)

#### Behind Enemy Lines

> **WHEN DRAWN:** During the first battle round, _you may_ shuffle this card back into your **Secondary Mission** deck and then draw one new **Secondary Mission** card.

**[ANY BATTLE ROUND]** — When: End of your turn
  - For each friendly unit (excluding **AIRCRAFT** and **battle-shocked** units) wholly within your opponent's deployment zone. → **3VP**

Source: https://gdmissions.app/11th/secondary-missions/behind-enemy-lines-defender (attacker version identical bar deck badge)

#### Bring It Down — **FIXED-capable**

> **WHEN DRAWN:** If there are no enemy models on the battlefield with a **Wounds** characteristic of 10 or more, _you may_ discard this card and draw one new **Secondary Mission** card.

**[ANY BATTLE ROUND]** *(applies to the FIXED version of the card)* — When: End of a turn
  - For each enemy model with a **Wounds** characteristic of 10 or more that is **destroyed** this turn. → **4VP**

**[ANY BATTLE ROUND]** *(applies to the TACTICAL version of the card)* — When: End of a turn
  - One or more enemy models with a **Wounds** characteristic of 10 or more were **destroyed** this turn. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/bring-it-down-defender (attacker version identical bar deck badge)

#### Burden of Trust

> **WHEN DRAWN / START OF YOUR TURN:** For each **objective**, _you may_ pick one friendly unit on the battlefield to guard that **objective**. From then until the start of your next turn, that **objective** counts as **guarded** by your army for as long as the chosen unit is within range of it and you control it.

**[ANY BATTLE ROUND]** — When: End of your opponent's turn or the end of the fifth battle round (whichever comes first)
  - For each **objective** **guarded** by your army. → **2VP**

Source: https://gdmissions.app/11th/secondary-missions/burden-of-trust-defender (attacker version identical bar deck badge)

#### Centre Ground

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more friendly units (excluding **AIRCRAFT** and **battle-shocked** units) are within 3" of the centre of the battlefield, and _no_ enemy units are within _3"_ of the centre of the battlefield. → **3VP**
  - OR: One or more friendly units (excluding **AIRCRAFT** and **battle-shocked** units) are within 3" of the centre of the battlefield, and _no_ enemy units are within _6"_ of the centre of the battlefield. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/centre-ground-defender (attacker version identical bar deck badge)

#### Cleanse

> **WHEN DRAWN:** If you have the **Plunder** Secondary Mission active, _you may_ shuffle this card back into your **Secondary Mission** deck and then draw one new **Secondary Mission** card.

**Action: “CLEANSE”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One friendly unit within range of one **objective** (excluding your **home objective**).
  - **USE LIMIT**: Unlimited. Each unit that starts this action this phase must be within range of a different **objective**.
  - **COMPLETES**: End of your turn, if that unit is controlling that **objective**.
  - **EFFECT**: That **objective** is **cleansed** by your army.

**[ANY BATTLE ROUND]** — When: End of your turn
  - One **objective** was **cleansed** by your army this turn. → **2VP**
  - OR: Two or more **objectives** were **cleansed** by your army this turn. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/cleanse-defender (attacker version identical bar deck badge)

#### Defend Stronghold

> **WHEN DRAWN:** During the _first battle round_, shuffle this card back into your **Secondary Mission** deck and then draw one new **Secondary Mission** card.

**[SECOND BATTLE ROUND ONWARDS]** — When: End of your opponent's turn or the end of the fifth battle round (whichever comes first)
  - You control your **home objective**. → **3VP**
  - + CUMULATIVE: No enemy units are within your deployment zone. → **+2VP**

Source: https://gdmissions.app/11th/secondary-missions/defend-stronghold-defender (attacker version identical bar deck badge)

#### Display of Might

**[ANY BATTLE ROUND]** — When: End of your turn
  - There are more friendly units than enemy units (excluding **AIRCRAFT** and **battle-shocked** units) wholly within No Man's Land. → **2VP**

**[ANY BATTLE ROUND]** — When: End of your opponent's turn
  - There are more friendly units than enemy units (excluding **AIRCRAFT** and **battle-shocked** units) wholly within No Man's Land. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/display-of-might-defender (attacker version identical bar deck badge)

#### Engage on All Fronts — **FIXED-capable**

> You have a **presence** in a table quarter if one or more friendly units (excluding **AIRCRAFT** and **battle-shocked** units) are wholly within that table quarter and are not within 6" of the centre of the battlefield.

**[ANY BATTLE ROUND]** *(applies to the FIXED version of the card)* — When: End of your turn
  - You have a **presence** in **three** table quarters. → **2VP**
  - OR: You have a **presence** in **four** table quarters. → **4VP**

**[ANY BATTLE ROUND]** *(applies to the TACTICAL version of the card)* — When: End of your turn
  - You have a **presence** in **three** table quarters. → **3VP**
  - OR: You have a **presence** in **four** table quarters. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/engage-on-all-fronts-defender (attacker version identical bar deck badge)

#### Forward Position

> **WHEN DRAWN:** During the first battle round, _you may_ shuffle this card back into your **Secondary Mission** deck and then draw one new **Secondary Mission** card.

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control your opponent's **home objective** and/or each **expansion objective**. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/forward-position-defender (attacker version identical bar deck badge)

#### No Prisoners

**[ANY BATTLE ROUND]** — When: End of a turn
  - For each enemy unit **destroyed** this turn. → **2VP**

Source: https://gdmissions.app/11th/secondary-missions/no-prisoners-defender (attacker version identical bar deck badge)

#### Outflank

> Designer's note (printed on card): "Opposite battlefield edges are the ones that run parallel to each other."

**[ANY BATTLE ROUND]** — When: End of your turn
  - One or more friendly units (excluding **AIRCRAFT** and **battle-shocked** units) are within 6" of one or more battlefield edges and not within your territory. → **3VP**
  - OR: Two or more friendly units (excluding **AIRCRAFT** and **battle-shocked** units) are within 6" of opposite battlefield edges and one or more of those units is not within your territory. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/outflank-defender (attacker version identical bar deck badge)

#### Overwhelming Force

**[ANY BATTLE ROUND]** — When: End of a turn
  - For each enemy unit that started the turn within range of one or more **objectives** and is **destroyed**. → **3VP**

Source: https://gdmissions.app/11th/secondary-missions/overwhelming-force-defender (attacker version identical bar deck badge)

#### Plunder

> **WHEN DRAWN:** If you have the **Cleanse** Secondary Mission active, _you may_ shuffle this card back into your **Secondary Mission** deck and then draw one new **Secondary Mission** card.

**Action: “PLUNDER”**

  - **STARTS**: Your Shooting phase.
  - **UNITS**: One unit within a **terrain area** that is not within your territory.
  - **USE LIMIT**: Once per turn.
  - **COMPLETES**: Immediately.
  - **EFFECT**: That **terrain area** is **plundered**.

**[ANY BATTLE ROUND]** — When: End of your turn
  - A **terrain area** was **plundered** this turn. → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/plunder-defender (attacker version identical bar deck badge)

#### Secure No Man's Land

**[ANY BATTLE ROUND]** — When: End of your turn
  - You control two or more **objectives** within No Man's Land (excluding your **home objective**). → **5VP**

Source: https://gdmissions.app/11th/secondary-missions/secure-no-man-s-land-defender (attacker version identical bar deck badge)


---

## 5. Official FAQ / errata on the deck (Event Companion, exact text; current answer set = "None" errata + 4 FAQs)

- Q: "Some Primary Mission cards let a player place operation markers on the battlefield. Can I remove these?" A: "Your Primary Mission card will specify how and when you can remove operation markers from the battlefield. If it doesn't, you cannot remove operation markers."
- Q (Death Trap): "…'One or more enemy units that started the turn within a terrain area were destroyed, if that terrain area is trapped.' Does that terrain area have to have been trapped at the point that enemy unit was destroyed?" A: "No."
- Q (Surveil the Foe): for an enemy unit within range of an objective that has an operation marker in range, "can I achieve this objective if I remove the operation marker after surveilling that unit, as long as it is within the same turn?" A: "Yes."
- Q (Vital Link): "if there is more than one central objective, can I score the cumulative VP for my operation markers regardless of which central objective(s) they are within?" A: "Yes, as long as you control the objective(s) those operation markers are within."

Source: https://gdmissions.app/11th/rules/event-companion

---

## 6. Sources

- GDM 2026 (all card text + matrix + Event Companion + Core Rules §15–16): https://gdmissions.app/11th (primary missions: /11th/primary-missions/<deck>/<mission>; secondaries: /11th/secondary-missions/<name>-defender; matrix: /11th/matrix; companion: /11th/rules/event-companion)
- Warhammer Community, "The Chapter Approved deck – What is it and how does it work?": https://www.warhammer-community.com/en-gb/articles/p3i6aa3h/the-chapter-approved-deck-what-is-it-and-how-does-it-work/ (deck contents: 6 Deployment, 10 Force Disposition, 30 Primary Mission cards + Secondary + Twist cards; 15 matchups; 15VP/turn primary; included in the Armageddon box)
- Tabletop Battles (Goonhammer), "An Introduction to Missions in 11th Edition" (2026-06-01, GW preview copy): https://www.tabletopbattles.com/40k-an-introduction-to-missions-in-11th-edition/ (disposition selection, 45VP caps, fixed-vs-tactical, no hand limit, per-disposition mission character)
- Tabletop Battles, "11th Edition Rules Deep Dive: Terrain and Objectives": https://www.tabletopbattles.com/11th-edition-40k-rules-deep-dive-terrain-and-objectives (Home/Expansion/Central designations, terrain-area objectives, Level of Control, Secured, 40mm/3" appendix variant)
- Tabletop Battles per-disposition reviews (context/commentary): /40k-11th-edition-force-disposition-review-take-and-hold, …-purge-the-foe, …-disruption, …-priority-assets
- Bell of Lost Souls / Spikeybits coverage (deck reveal, disposition system): https://www.belloflostsouls.net/2026/05/warhammer-40k-chapter-approved-missions-deck-for-11th-edition-revealed.html , https://spikeybits.com/chapter-approved-deck-2026-force-dispositions-decide-what-the-game-is-about/

## 7. Structural facts for the simulator (summary)

- 5 dispositions; ordered-pair lookup → your primary mission; 25 distinct primaries (5 mirror). Both players can be scoring completely different things.
- Universal skeleton shared by most primaries: (a) an "ANY BATTLE ROUND / end of your turn" disposition-flavoured block (kills, actions, first-blood-style objective grabs, etc., typically 2-4VP), and (b) a "SECOND BATTLE ROUND ONWARDS / end of your Command phase (or end of your turn in round 5)" hold-objectives block. Take-and-Hold cards are the only ones paying for the **home objective**; several cards pay extra for **central objectives** or objectives **in enemy territory**; three cards have END OF BATTLE bonuses (Vital Link 10VP for opponent's home objective; see cards for others).
- 11 of 25 primaries have a reverse side with an Objective Action: Gather Intel, Surveil the Foe, Triangulation (Reconnaissance deck); Death Trap, Locate and Deny, Smoke and Mirrors (Disruption deck); and ALL five Priority Assets missions (Secure Asset, Vital Link, Extract Relic, Vanguard Operation, Sabotage). Take and Hold and Purge the Foe primaries have NO reverse-side actions — but Punishment (condemned units) and Consecrate (consecration units/markers) have front-face preamble mechanics, and Locate and Deny additionally pre-places 5 operation markers at the start of the battle. Extract Relic scores off destroying the OPPONENT's operation markers' terrain (interacts with the opponent's marker placement); Surveil the Foe both places its own markers (via its action) and removes ENEMY operation markers when its units reach objectives.
- Secondaries: 18-card personal deck; draw 2 per own Command phase, no hand limit, may decline to score; discard-for-1CP at end of own turn; once per battle 1CP to mulligan one card; Fixed mode = pick 2 of the 4 FIXED-capable cards, 20VP cap each.
- Caps: Primary 45 (15/round) · Secondary 45 (15/round) · Battle Ready 10 · total 100.

## 8. Could NOT verify / gaps (flagged, not invented)

- **Official GW card scans**: not obtainable; all card text is via GDM 2026 (a fan re-render of the official cards). Every primary front was read from GDM's card images and they agree with GDM's own structured data, and GDM's wording agrees verbatim with GW's official FAQ quotes reproduced in the Event Companion — but an independent second transcription source does not exist yet. Wahapedia hasn't published this deck (checked wahapedia.ru/wh40k11ed on 2026-07-03 — still 10th-ed content).
- **Twist cards**: exist in the retail deck (warhammer-community: "can fundamentally alter rules, like providing Hidden for the entire army, or simply mix up what mission you're playing") but are NOT part of the Warhammer Event missions and are not transcribed on GDM (no /11th/twists page). Full Twist list/text: NOT OBTAINED.
- **Deployment cards / the 45 official layouts** (A/B/C per matchup, which objectives are Home/Expansion/Central per layout): live in the 40k app and the Event Companion appendix; not extracted here.
- **Force Disposition card faces**: image-only on GDM (they carry the 5-mission cross-reference table, i.e. the matrix in §2, plus a symbol); no other rules text is known to be on them — but I could not read every pixel of all five images, so any additional rider text on those cards is unverified.
- **The 16 remaining attacker-deck secondaries**: verified identical to defender versions only for Assassination and Defend Stronghold (image comparison); the other 16 are asserted identical by pattern (GDM publishes one text per mission and labels it for both decks). Low risk, flagged for completeness.
- **"30 Primary Mission cards"** count is from warhammer-community; my "25 distinct + 5 mirror duplicates" reading is an inference (marked as such).
- The Plunder card's wording ambiguity (unit vs terrain feature in opponent's territory) is noted by Tabletop Battles as likely needing a future FAQ; the Event Companion FAQ already answers the equivalent question for the OLD 10th-ed Sabotage — no 11th-ed Plunder FAQ exists yet.
