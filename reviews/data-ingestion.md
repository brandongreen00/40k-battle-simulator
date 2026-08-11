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
