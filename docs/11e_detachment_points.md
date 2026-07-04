# 11th edition Detachment Points (DP) — curated data & sources

*Researched 2026-07-04. Drives `src/core/detachments.ts` (list-builder DP display + validation).*

## Budget (official)

| Battle size | Points | DP budget | Enhancements |
|---|---|---|---|
| Incursion | 1000 | **2 DP** | 2 |
| Strike Force | 2000 | **3 DP** | 4 |

Source: Warhammer Community, "Building an army in the new edition of Warhammer 40,000"
(https://www.warhammer-community.com/en-gb/articles/95fucn12/...). No published budgets found
for 500/3000 pts. An army may take **multiple detachments** within the budget; the enhancement
cap is **army-wide**, not per-detachment (Wargamer detachments guide).

**Lone-detachment allowance:** GW has stated on Warhammer Community that it *intends* any single
lone detachment to be legal regardless of DP cost, but as of early July 2026 this is **not in
errata or the app** (Wargamer). The simulator applies the stated-intent rule: a lone detachment
over budget validates with a **warning**, not an error. (Consequence: 3 DP Imperial Agents
detachments are RAW-illegal at 1000 pts but playable here.)

## DP costs — Astra Militarum (11 detachments)

Two independent sources agree exactly: tabletopbattles.com "11th Edition Faction Pack Review:
Astra Militarum" (James "One_Wing" Grover, 2026-06-11) and the GDM 2026 fan database
(game-datamissions.com/11th/detachments). Confidence: HIGH.

| Detachment | DP |
|---|---|
| Abhuman Auxiliaries | 1 |
| Bridgehead Strike | 1 |
| Designation Force | 1 |
| Armoured Infantry | 2 |
| Hammer of the Emperor | 2 |
| Mechanised Assault | 2 |
| Siege Regiment | 2 |
| Steel Hammer | 2 |
| Combined Arms | 3 |
| Grizzled Company | 3 |
| Recon Element | 3 |

## DP costs — Imperial Agents (5 detachments, all 3 DP)

"Nothing new for Agents here – all five of their Detachments just become 3DP" (tabletopbattles).
Imperialis Fleet = Disruption is certain; the review and GDM **disagree** on the dispositions of
Hereticus/Malleus/Veiled Blade (irrelevant for DP — all cost 3).

| Detachment | DP |
|---|---|
| Imperialis Fleet | 3 |
| Ordo Hereticus Purgation Force | 3 |
| Ordo Malleus Daemon Hunters | 3 |
| Ordo Xenos Alien Hunters | 3 |
| Veiled Blade Elimination Force | 3 |

**Fallback rule** (`detachmentPoints`): detachments in the 10e data without a researched cost
(Grotmas leftovers like Embarked Regiment, Interdiction Team, Tempestus Boarding Regiment,
Voidship's Company) default to 2 DP for AM and 3 DP for Agents.

**Not modelled:** multi-detachment armies (the list builder carries one detachment per list; the
DP budget would allow e.g. two 1-DP AM detachments at 1000 pts). The 11e "Designation Force" and
"Abhuman Auxiliaries" detachments do not exist in the 10e Wahapedia data, so they cannot be
picked yet — costs are recorded for when 11e data lands.

## Twist cards — researched, ruled OUT of scope

The retail Chapter Approved 11e deck contains **6 Twist cards** (count confirmed via retailer
product listings quoting GW copy). Only two names are attested (Night Fighting, Martial Pride —
via Bell of Lost Souls reveal coverage); the **full rules text is not published anywhere
accessible** (GDM has no 11e twists page; the widely-indexed 9-twist list is the *10e*
CA 2025-26 deck). Twists are optional variety cards and are **excluded from Event
Companion/tournament missions** — which is what this simulator plays — so they remain
unimplemented by design, not omission.

## Wahapedia 11e data status (re-checked 2026-07-04)

Still a stale 10e mirror: `wh40k11ed/Last_update.csv` = 2026-05-09 (predates the edition);
`Factions.csv` under the 11e path links to `wh40k10ed` URLs; the 10e path is NEWER
(2026-06-13). Keep the 10e datasheets; re-run `pnpm ingest` when real 11e exports appear.
