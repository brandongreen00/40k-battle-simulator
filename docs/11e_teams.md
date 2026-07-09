# 11th edition pre-made teams (1000 & 2000 points)

Five new prebuilt rosters (in `tools/rosters/prebuilt.ts` → `pnpm build:rosters` →
`data/rosters/prebuilt_*.json`), built from early-11e community sentiment and the first
tournament results, within the two factions the project supports (Astra Militarum,
Imperial Agents). Each carries a `recommended` Force Disposition + AI profile that the
sim (`pnpm sim -- --dispA … --dispB …`) and the board default to.

## The lists

| List | Pts | Detachment | Disposition | Profile | Anchor |
|---|---|---|---|---|---|
| **Solar Spearpoint (2k)** | 1985 | Mechanised Assault | Purge the Foe | attrition | The "Moxley pattern" — 2nd place, first 11e GT (Commencing Armageddon): Lord Solar hub, 3× Kasrkin damage core, Rogal Dorn + Enginseer, Hellhound, Scions, Gaunt's Ghosts + Sly Marbo disruption, Rough/Death Riders counterpunch, Chimera/Taurox pressure |
| **Grizzled Greatest Hits (2k)** | 1995 | Grizzled Company | Priority Assets | operative | The Vasquez toolbox that won the final 10th GT, trimmed per the 11e points review (one Dorn Commander + one Dorn, 6 Bullgryn, Kasrkin, Basilisk, double Scions) |
| **Idavoll Vigil (2k)** | 1980 | Imperialis Fleet | Disruption | objective_rusher | The Nanaimo undefeated Agents list: 3× Deathwatch Kill Team + Watch Masters/Artemis, Rogue Trader warlord + Inquisitor suite, 2× Navy Breachers in Chimeras, 3× Subductors (Hidden-friendly shield walls), Vindicare (11e anti-Hidden tech) |
| **Bridgehead Pattern (1k)** | 985 | Bridgehead Strike | Reconnaissance | operative | The reviewers' natural 1k skeleton: Scions + Kasrkin core, Taurox Prime, Scout Sentinel, Hellhound, Gaunt's Ghosts, Sly Marbo |
| **Vigil Strike (1k)** | 990 | Imperialis Fleet | Disruption | objective_rusher | Idavoll Vigil scaled to 1k: DWKT ×2 + Watch Master, Breachers + Chimera, Subductors, Vindicare, cheap Inquisitorial activations |

The six original 1000pt sparring lists (Cadian Bulwark, Krieg Siege Echelon, Armoured
Spearhead, Fleet Boarding Party, Deathwatch Vigil, Hereticus Purgation Force) remain in
the pool.

## Research basis (July 2026, ~3 weeks into the edition)

- **AM** rated "Neutral" by the Goonhammer-team launch reviews: the new 1-DP detachments
  (Bridgehead Strike, Designation Force) are the hot picks; Grizzled Company keeps its
  toolbox reputation at 3 DP; the points pass taxes spam (stepped costs on Kasrkin/Scions/
  Dorns) and buys back Hellhounds, Death Riders, first Basilisk, Gaunt's Ghosts.
- **Imperial Agents** rated "Loser" — "Imperialis or bust": every Agents detachment costs
  the max 3 DP and the faction's competitive proof is the Deathwatch-heavy horde (2nd
  undefeated at a 65-player GT in 10th's final week, datasheets barely touched). The
  Vindicare gained +15" detection while shooting and ignores Lone Operative — premier
  anti-Hidden tech.
- **Dispositions**: Purge the Foe is rated strongest (3.6/5), Priority Assets 3.3,
  Take and Hold 2.6, Disruption weakest — but Imperialis Fleet is locked to Disruption.

Full sources in `docs/11e_missions.md` §6 and the session research notes; headline
sources are the tabletopbattles.com faction-pack/points/disposition reviews (2026-06-11)
and the Spikey Bits "Commencing Armageddon" GT report.

## Caveats (documented, not hidden)

1. **Datasheets and points are still the 10th-edition Wahapedia export.** Wahapedia has no
   11e data yet (verified 2026-07-03: the `wh40k11ed` path is a stale 10e mirror), so
   these lists use 10e stat blocks and points under the 11e *rules engine*. When Wahapedia
   publishes 11e data, re-run `pnpm ingest` and re-check the tiers in `prebuilt.ts`.
2. **Detachments are the 10e set** — Designation Force does not exist in the data, so the
   Moxley list's second detachment is folded into Mechanised Assault. The 11e Detachment
   Points system (1 detachment at 1k = 2 DP, multi-detachment armies) is NOT modelled;
   each list uses one detachment as before.
3. Detachment rules/stratagems have engine bindings only where the 10e set already did
   (Grizzled Company re-roll rider, Imperialis Fleet Eliminate/Acquire).
4. At 1000 points, Imperial Agents are RAW-illegal in real 11e (3 DP > 2 DP budget) —
   Vigil Strike ships anyway because GW has stated intent to allow any single lone
   detachment, and the simulator does not model DP.
