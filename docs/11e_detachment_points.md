# 11th edition Detachment Points (DP) — data & sources

*Originally researched 2026-07-04 from launch-window reviews (Wahapedia's 11e section was still
a stale 10e mirror). **Revised 2026-08-16 from the real printed values** on the Wahapedia 11e
faction pages (Faction Pack v1.1) — which replaced most of the review guesses. Drives
`src/core/detachments.ts` (list-builder DP display + validation); the extraction snapshot lives
in `tools/ingest/points11e.json` (`detachments` block).*

## Budget (official)

| Battle size | Points | DP budget | Enhancements |
|---|---|---|---|
| Incursion | 1000 | **2 DP** | 2 |
| Strike Force | 2000 | **3 DP** | 4 |

Source: Warhammer Community, "Building an army in the new edition of Warhammer 40,000". No
published budgets found for 500/3000 pts. An army may take **multiple detachments** within the
budget; the enhancement cap is **army-wide**, not per-detachment.

**Lone-detachment allowance:** GW has stated on Warhammer Community that it *intends* any single
lone detachment to be legal regardless of DP cost, but this is **not in errata or the app**. The
simulator applies the stated-intent rule: a lone detachment over budget validates with a
**warning**, not an error. After the v1.1 costs below, that only affects the two 3 DP Astra
Militarum detachments (Grizzled Company, Recon Element) at 1000 pts.

## DP costs — Astra Militarum (11 detachments, Faction Pack v1.1)

| Detachment | DP | Force Disposition |
|---|---|---|
| Abhuman Auxiliaries | 1 | Take and Hold |
| Bridgehead Strike | 1 | Priority Assets |
| Designation Force | 1 | Reconnaissance |
| Armoured Infantry | 2 | Take and Hold |
| Combined Arms | 2 | Take and Hold |
| Hammer of the Emperor | 2 | Purge the Foe |
| Mechanised Assault | 2 | Reconnaissance |
| Siege Regiment | 2 | Disruption |
| Steel Hammer | 2 | Purge the Foe |
| Grizzled Company | 3 | Priority Assets |
| Recon Element | 3 | Reconnaissance |

Change vs the 2026-07-04 review-sourced table: **Combined Arms is 2 DP** (the reviews had 3);
all other AM costs were confirmed.

## DP costs — Imperial Agents (5 detachments, Faction Pack v1.1)

The launch reviews claimed "all five become 3 DP" — the printed pack prices them at **1–2 DP**:

| Detachment | DP | Force Disposition |
|---|---|---|
| Veiled Blade Elimination Force | 1 | Disruption |
| Imperialis Fleet | 2 | Reconnaissance |
| Ordo Hereticus Purgation Force | 2 | Take and Hold |
| Ordo Malleus Daemon Hunters | 2 | Priority Assets |
| Ordo Xenos Alien Hunters | 2 | Purge the Foe |

**Consequence the owner flagged:** at 2000 pts (3 DP budget) an Imperial Agents army can now
legally field **two detachments** (2+1, or 1+2 — e.g. Imperialis Fleet + Veiled Blade). Every
Agents detachment is also now RAW-legal alone at 1000 pts (no more over-budget warning).

**Fallback rule** (`detachmentPoints`): detachments in the 10e data without a printed 11e cost
(Grotmas leftovers like Embarked Regiment, Interdiction Team, Tempestus Boarding Regiment,
Voidship's Company) default to **2 DP** — the modal cost of both factions' packs (the old
"Agents default to 3" rule died with the v1.1 prices).

**Not modelled:** multi-detachment armies — the list builder still carries **one detachment per
list**, so the newly-legal two-detachment Agents army at 2000 pts (and e.g. two 1-DP AM
detachments at 1000 pts) cannot be built yet. Cross-detachment stratagem/enhancement scoping,
per-detachment rules coexistence and the UI all depend on that model; treat it as its own
feature. The 11e-only "Designation Force" and "Abhuman Auxiliaries" detachments still do not
exist in the 10e datasheet data, so they cannot be picked yet — costs are recorded for when
they land.

## Twist cards — researched, ruled OUT of scope

The retail Chapter Approved 11e deck contains **6 Twist cards** (count confirmed via retailer
product listings quoting GW copy). Only two names are attested (Night Fighting, Martial Pride —
via Bell of Lost Souls reveal coverage); the **full rules text is not published anywhere
accessible**. Twists are optional variety cards and are **excluded from Event
Companion/tournament missions** — which is what this simulator plays — so they remain
unimplemented by design, not omission.

## Wahapedia 11e data status (re-checked 2026-08-16)

The 11e faction pages are now REAL 11e data (Faction Pack v1.1): printed DP costs + Force
Dispositions per detachment, full 11e points (including per-copy escalation and priced wargear)
and enhancement costs. There are still **no 11e CSV exports** — `pnpm ingest` keeps converting
the 10e CSVs for datasheet stats, and `pnpm apply:points11e` overlays the 11e points/costs
(see `tools/ingest/README.md`). The v2 engine (`data2/`) ingested the same pages on 2026-08-14.
