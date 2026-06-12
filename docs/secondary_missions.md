# Secondary (Tactical) Missions — implementation notes

> Code: `src/core/secondaries.ts` (pure). Tests: `tests/secondaries.test.ts`.
> Personal-use re-implementation of the Pariah Nexus Tactical Mission structure for this
> simulator; card texts are paraphrased, values are best-effort and centralized for correction.

## How it works

- **Decks.** At `NewBattle`, each side shuffles its OWN copy of the 12-card deck (seeded RNG —
  games stay reproducible). Sandbox boards have no secondaries.
- **Drawing.** During your Command phase (Run Command), you discard *stale* cards and draw back
  up to a 2-card hand. A card is stale when it has been held for 2+ of your own turns without
  scoring (the real rule is a discard *choice* at the end of your turn; the automatic rule keeps
  the reducer free of an extra decision point — a human can also discard any of their active
  cards at any time in their turn via the `DiscardSecondary` intent / the panel button).
- **Scoring.** Cards score automatically at the relevant turn end (`AdvancePhase` out of the
  Fight phase): the ending player's *end-of-your-turn* cards, the opponent's
  *end-of-opponent's-turn* cards, and *either-turn* kill cards. Scored cards are discarded.
- **Cap.** Secondary VP is capped at **40** per side (50 primary + 40 secondary = 90 max; no
  paint score). `GameState.score` is the combined total; `state.secondaries[side].vp` is the
  secondary share.
- **Kill ledger.** The reducer records every unit destroyed by Attack/ShootUnit/FightUnit into
  `state.turnKills` (victim side, all datasheets in the unit incl. merged Leaders, max Wounds
  characteristic, whether it died on an objective). The ledger resets at every turn end.
- **The AI plays its cards**: active Assassination / Bring It Down multiply shooting & charge EV
  against matching targets; the position cards (Behind Enemy Lines, Capture Enemy Outpost,
  Secure No Man's Land, Extend Battle Lines, Storm Hostile Objective, Defend Stronghold) add
  move-candidate score where the card would pay.

## The deck (12 cards)

| Card | Scored at | VP (as implemented) |
|---|---|---|
| Assassination | either turn end | 5 per enemy CHARACTER unit destroyed this turn |
| Bring It Down | either | 4 per enemy MONSTER/VEHICLE destroyed (+3 if 15+ W) |
| No Prisoners | either | 2 per enemy unit destroyed (max 6) |
| Overwhelming Force | either | 3 per enemy unit destroyed on an objective (max 9) |
| Behind Enemy Lines | your turn | 1 unit wholly in enemy DZ = 3; 2+ = 5 |
| Engage on All Fronts | your turn | units wholly in a quarter, >6" from centre: 3 quarters = 2; 4 = 5 |
| Area Denial | your turn | own unit near centre AND no enemy within 3" of centre = 2; within 6" = 5 |
| Secure No Man's Land | your turn | control 1 NML objective = 2; 2+ = 5 |
| Extend Battle Lines | your turn | control 1+ own-territory AND 1+ NML objective = 5 (own only = 2) |
| Capture Enemy Outpost | your turn | control 1+ objective in enemy DZ = 8 |
| Storm Hostile Objective | your turn | control an objective the opponent held at the start of your turn = 4 |
| Defend Stronghold | opponent's turn | control an objective in your own DZ = 3 |

## Assumptions / known deviations (fix in `SECONDARY_CARDS`, one place)

1. **VP values are best-effort** readings of the Pariah Nexus deck — treat the table above as
   data; correcting a number is a one-line edit.
2. **Action-based cards are not in the deck** (Cleanse, Sabotage, Containment, Establish Locus,
   Recover Assets…): the engine has no Actions mechanic yet. The deck is therefore 12 cards, not
   the full set — drawing odds differ from the real deck.
3. **"Wholly within" uses model centre points**, consistent with the LoS simplification.
4. **Fixed Missions are not offered** — Tactical only (the Pariah Nexus default). A fixed-pair
   mode would be a small extension on the same evaluators.
5. **Stale auto-discard after 2 of your turns** replaces the end-of-turn discard choice (see
   above); the AI relies on it, humans can discard manually earlier.
6. Discards are never re-shuffled into the deck: each deck is drawn through once (12 cards
   comfortably cover 5 turns of draw-to-2).
