# Adversarial review — data ingestion

Method: every §6 parsing trap was re-checked against the fetched HTML after the
ingester ran, by reading the source markup for a specific datasheet rather than
trusting the parser's output shape.

| Trap (§6) | Check performed | Verdict |
|---|---|---|
| 6.4 — every weapon appears twice (collapsed header, then the profile) | Read the Cadian Shock Troops markup; only rows carrying six profile cells are taken | ✅ |
| 6.4 — keywords are printed one `<span>` per WORD | "rapid fire 1" arrived as three spans; the parser groups by the enclosing `kwbw` span | ✅ `RAPID FIRE 1`, tested |
| 6.4 — keyword words bleeding into the weapon name | Name is taken as the text *before* the first keyword span | ✅ tested (`test_weapon_names_are_clean`) |
| 6.5 — dual points columns on Agents datasheets | Eversor Assassin prints 100 (Army Faction) and 110 (Assigned Agent) | ✅ both captured with the column recorded |
| 6.6 — escalating squadron costs | Hellhound prints "YOUR 1ST TO 2ND UNITS COST 125 / YOUR 3RD + UNIT COSTS 135" | ✅ per-copy tiers, tested |
| 6.7 — damaged brackets | Hellhound's "DAMAGED: 1-4 WOUNDS REMAINING" is an ability, not a second statline, in 11e | ✅ captured as ability text; the bracket fields exist in the schema for sheets that print a second line |
| 6.7 — Boarding Actions contamination | Both faction pages carry BA detachments (Voidship's Company, Interdiction Team, Embarked Regiment, Tempestus Boarding Regiment) and their stratagems | ✅ excluded: a detachment is only ingested if it carries a Force Disposition, and a stratagem is only ingested if its type line names an ingested detachment. Tested |
| 6.8 — Wahapedia strips numerals from the wound table | Compared the rendered table against the printed rule | ✅ the S-vs-T table is transcribed in `attacks.wound_target`, not scraped |
| 6.x — Legends flagged, not dropped | The expansion logo reads "(Warhammer Legends)" | ✅ 78 of 179 sheets flagged; the optimizer excludes them, the replayer can still render one |
| §1 — detachment strips | All 16 detachments' Force Disposition and DP re-read from the pages | ✅ exactly matches the brief's verified table, including **Imperialis Fleet = Reconnaissance**. Pinned by a test so a re-snapshot that changes it fails loudly |

## Second pass, 2026-08-14 — four claims re-checked against source

Writing the gap register meant auditing the snapshot field by field rather than
trusting the parser's output shape. That found three real defects and one false
alarm. All four are now settled.

| Claim | Verdict | Outcome |
|---|---|---|
| Invulnerable saves missing | **Real** — captured on 1 of 179 sheets. The value is a `dsCharInvulValue` markup block; the parser searched the block text for the words "INVULNERABLE SAVE", which almost never appear | Fixed: 47 sheets now carry one. The Callidus Assassin's 4++ is pinned by a test, as is the save step preferring it over a 4+ worsened by AP-3 |
| Core abilities inert | **Real** — the datasheet prints them as one comma-separated `CORE:` line, stored under a single `"CORE"` key, so the loader's name matching found none of them. Deep Strike, Leader, Infiltrators, Scouts, Stealth, Feel No Pain and Fights First did nothing on any unit | Fixed: each ability is its own entry with its parameter (`Scouts 6"`, `Firing Deck 2`). 13 of 18 units in a 500 pt game now carry at least one |
| Transport capacity 0 everywhere | **Real** — the search matched a keyword tooltip long before the TRANSPORT section | Fixed: 19 transports, Chimera reads 12 with its OGRYN multiplier and ARTILLERY exclusion preserved. Conditional capacities (Valkyrie Sky Talon: "1 TAUROS **or** 2 WALKER models") take the first figure and log a `GAP` |
| Multi-profile statlines collapsing | **False alarm** — inferred from "no sheet yields >1 profile" without checking the source. Scanning all 179 datasheet blocks finds zero sheets printing more than one `M` characteristic: 11th edition consolidated mixed units onto one statline. The Rogue Trader Entourage fields four differently-named models under a single profile | Withdrawn, and pinned by a test so the assumption is explicit rather than incidental |

The lesson repeats the one from the agent review: the defects were invisible in
the tests (which asserted shape, not coverage) and obvious the moment the data
was counted field by field. Coverage counts belong in the test suite, not in a
one-off audit — hence the "far too few invulnerable saves parsed" style
assertions now guarding each one.

## Honest gaps recorded rather than filled

* **MFM reconciliation (Phase D2) has not been performed.** Points come from the
  Wahapedia faction pages, which state their pack version, not from the
  Munitorum Field Manual app. Under the §6.1 hierarchy MFM is the authority for
  points, so every points record is provisional until reconciled — including the
  named open item (Sanctifiers). Logged in STATUS.md as the first next task.
* **Datasheet abilities are ingested as text, not as bound effects.** The
  ontology is in place and the text is captured verbatim per sheet; binding them
  is per-sheet work.
* **Base sizes** come from the datasheet header ("⌀25mm", "32mm"), which is the
  Base Size Guide's value as printed on the sheet. "Hull" entries fall back to a
  flagged rectangular estimate — a `GAP`, per §3.8.
* **Layouts** are converted from this repository's earlier vector/visual
  extraction of the Event Companion, with page numbers preserved. A fresh
  region-level crop-and-inspect verification (mandate 5) was **not** re-performed
  this session; the outlines were additionally simplified to ≤24 vertices within
  0.35" of the traced footprint for tractable line-of-sight, and that
  simplification is recorded in each layout's provenance note.
