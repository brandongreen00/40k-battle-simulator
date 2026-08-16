# 11th edition pre-made teams (1000 & 2000 points)

Five new prebuilt rosters (in `tools/rosters/prebuilt.ts` → `pnpm build:rosters` →
`data/rosters/prebuilt_*.json`), built from early-11e community sentiment and the first
tournament results, within the two factions the project supports (Astra Militarum,
Imperial Agents). Each carries a `recommended` Force Disposition + AI profile that the
sim (`pnpm sim -- --dispA … --dispB …`) and the board default to.

## The lists

*(Points and dispositions revised 2026-08-16 to the printed Faction Pack v1.1 values — the
Wahapedia 11e pages now carry real 11e points, and each detachment's Force Disposition is
printed on the pack, replacing the July review-era guesses.)*

| List | Pts | Detachment | Disposition (printed) | Profile | Anchor |
|---|---|---|---|---|---|
| **Solar Spearpoint (2k)** | 1960 | Mechanised Assault | Reconnaissance | operative | The "Moxley pattern" — 2nd place, first 11e GT (Commencing Armageddon): Lord Solar hub, 3× Kasrkin damage core, Rogal Dorn + Enginseer, Hellhound, Scions, Gaunt's Ghosts + Sly Marbo disruption, Rough/Death Riders counterpunch, Chimera/Taurox pressure |
| **Grizzled Greatest Hits (2k)** | 1970 | Grizzled Company | Priority Assets | operative | The Vasquez toolbox that won the final 10th GT, trimmed per the 11e points review (one Dorn Commander + one Dorn, 6 Bullgryn, Kasrkin, Basilisk, double Scions) |
| **Idavoll Vigil (2k)** | 1960 | Imperialis Fleet | Reconnaissance | operative | The Nanaimo undefeated Agents list: 3× Deathwatch Kill Team + Watch Masters/Artemis, Rogue Trader warlord + Inquisitor suite, 2× Navy Breachers in Chimeras, 3× Subductors (Hidden-friendly shield walls), Vindicare (11e anti-Hidden tech) |
| **Bridgehead Pattern (1k)** | 970 | Bridgehead Strike | Priority Assets | operative | The reviewers' natural 1k skeleton: Scions + Kasrkin core, Taurox Prime, Scout Sentinel, Hellhound, Gaunt's Ghosts, Sly Marbo |
| **Vigil Strike (1k)** | 980 | Imperialis Fleet | Reconnaissance | operative | Idavoll Vigil scaled to 1k: DWKT ×2 + Watch Master, Breachers + Chimera, Subductors, Vindicare, cheap Inquisitorial activations |

The six original 1000pt sparring lists (Cadian Bulwark, Krieg Siege Echelon, Armoured
Spearhead, Fleet Boarding Party, Deathwatch Vigil, Hereticus Purgation Force) remain in
the pool.

## Research basis (July 2026, ~3 weeks into the edition)

*(Historical — two claims below aged badly once the printed pack landed: Agents detachments
cost 1–2 DP, not "the max 3", and Imperialis Fleet's printed disposition is Reconnaissance,
not Disruption.)*

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

1. **Datasheet stats are still the 10th-edition Wahapedia export, but POINTS are 11e.**
   As of 2026-08-16 the `wh40k11ed` pages carry real 11e data (Faction Pack v1.1) —
   there are still no 11e CSV exports, so `pnpm ingest` converts 10e stats and
   `pnpm apply:points11e` overlays the 11e points/costs (see `tools/ingest/README.md`).
   These lists use 10e stat blocks with 11e points under the 11e *rules engine*.
2. **Detachments are the 10e set** — Designation Force does not exist in the data, so the
   Moxley list's second detachment is folded into Mechanised Assault. Multi-detachment
   armies are NOT modelled; each list uses one detachment as before — even though the
   v1.1 DP costs (all Imperial Agents at 1–2 DP) make a two-detachment Agents army legal
   at 2000 pts (3 DP budget). See `docs/11e_detachment_points.md`.
3. Detachment rules/stratagems have engine bindings only where the 10e set already did
   (Grizzled Company re-roll rider, Imperialis Fleet Eliminate/Acquire).
4. ~~At 1000 points, Imperial Agents are RAW-illegal in real 11e~~ — resolved by the
   v1.1 costs: every Agents detachment is 1–2 DP and fits the 1000 pt / 2 DP budget.
   The only over-budget lone detachments left are Grizzled Company and Recon Element
   (3 DP) at 1000 pts, which validate with a warning under GW's stated intent.
