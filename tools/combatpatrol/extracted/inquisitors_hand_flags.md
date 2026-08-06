# Inquisitor's Hand — extraction flags (source: IMG_4409–IMG_4422)

## Data gaps — pages NOT in the screenshot set (do not exist in this capture; nothing was inferred)
1. **No patrol landing page.** The set contains no screenshot of the Combat Patrol overview page:
   the patrol ability card, the roster list with unit counts, and any Force Dispositions are all
   absent. `rosterList` and `forceDispositions` are therefore empty. The four datasheets
   photographed are: Preacher Teguen, Inquisitor's Hand Vigilant Squad, Inquisitor's Hand Eversor
   Assassin, Inquisitor's Hand Inquisitorial Agents.
2. **No stratagems page and no enhancements page.** `stratagems` and `enhancements` are empty for
   this reason only — not because the patrol lacks them.
3. **ASSIGNED AGENTS faction ability text not captured.** Every datasheet shows it only as a
   dashed reference tag; its rules text never appears in any screenshot.
4. **Weapon-keyword rules text** (IGNORES COVER, TORRENT, CLOSE-QUARTERS, BLAST 1, ASSAULT,
   DEVASTATING WOUNDS, HEAVY, SUSTAINED HITS X, ANTI-INFANTRY X+, PRECISION, PSYCHIC, HAZARDOUS)
   appears only as dashed tags — standard app behaviour, no expansions were open.
5. **Collapsed "Lore" accordions** on both mission cards (IMG_4421, IMG_4422) were not expanded —
   flavour text not captured.
6. **IMG_4421/4422 are Battle Setup mission cards, not patrol rules.** "Inquisitorial Sanction"
   appeared under YOUR MISSION (so it is presumably this patrol's mission); "Expansionary
   Campaign" appeared under OPPONENT'S MISSION and belongs to an unidentified opposing patrol.
   Both were stored in `patrolRules` with bracketed provenance notes since the schema has no
   mission field. A human should confirm Inquisitorial Sanction is indeed the Inquisitor's Hand
   patrol mission.

## Anomalies transcribed as shown — please confirm against the app
7. **"BLAST 1" tag** on Grenade Launcher - Frag (IMG_4412). Parameterised BLAST is unusual
   (10e used plain BLAST); re-checked at 2x zoom — it clearly reads "BLAST 1". Transcribed as
   shown.
8. **Vigilant Squad equipment sentence names only the Frag profile**: "The Vigilant with Grenade
   Launcher... is equipped with: 1 Grenade Launcher - Frag; ..." (IMG_4413/4414) even though the
   weapon has Frag AND Krak profiles marked as one multi-profile weapon. Same pattern on the
   Agents sheet: the plasma Agent is "equipped with ... 1 Plasma Pistol - Standard." Transcribed
   verbatim; likely an app data quirk (equipment lists the first profile's name).
9. **Preacher Teguen's Zealot ability**: "+3 A and S" — a large swing (3→6 A, 5→8 S). Re-read at
   2x zoom (IMG_4410); text is unambiguous. Transcribed as shown.
10. **Eversor Overkill**: "this unit's melee attacks have -4 AP" — replaces the sheet AP of -2
    with -4? The card only says "have -4 AP"; transcribed verbatim, interpretation left open.
11. **Executioner Pistol has A 4 with SUSTAINED HITS 3 and BS 2+** (IMG_4415) — strong but
    clearly printed; verified at 2x zoom.
12. **Inquisitorial Sanction scoring order** (IMG_4421): under SECOND BATTLE ROUND ONWARDS the
    "two or more objectives — 5VP" line is printed ABOVE "one or more objectives — 5VP" (both
    5VP). Odd ordering/equal values transcribed exactly as printed; presumably cumulative.
13. **Expansionary Campaign scoring order** (IMG_4422): THIRD BATTLE ROUND ONWARDS lists
    "one or more — 5VP" above "two or more — 10VP", while FIRST TO SECOND lists "two or more —
    15VP" above "one or more — 10VP". Inconsistent line order transcribed exactly as printed.
14. **Cyber-Mastiff OC 2** — every model in the Vigilant Squad, including the dog, is OC 2
    (verified in crop of IMG_4411). Transcribed as shown.
15. **Eversor Assassin has no LEADER section** despite being a CHARACTER (EPIC HERO) — verified
    absent between ABILITIES and UNIT COMPOSITION on IMG_4416.
16. **Nuncio-Aquila** is listed as *equipment* of the Proctor-Vigilant but appears under
    *Datasheet Abilities* (not as a wargear-ability section). Kept in `datasheetAbilities`;
    `wargearAbilities` left empty.

## Verified-absent weapon tags (targeted checks, not assumptions)
- Combat Shotgun (IMG_4412): no tags — gap before next weapon bar checked at 2x.
- Grenade Launcher - Krak (IMG_4412): no tags.
- Gun Stocks, Mechanical Bite (IMG_4412): no tags (ABILITIES header follows directly).
- Zealot's Vindictor melee (IMG_4409): no tags (ABILITIES header follows directly).
- Agent's Implement (IMG_4418): no tags (gap before Mystic Stave bar checked).
- Vigilant Squad and Inquisitorial Agents: no INVULNERABLE SAVE banner (profiles run straight
  into RANGED WEAPONS) — invuln correctly null.

## Scroll-seam checks (overlap reconciliation)
- IMG_4411→4412: the blue sliver at 4411's bottom edge is the RANGED WEAPONS header; the cut
  plaque row at 4412's top is the Webber Vigilant's stat row re-shown. No sixth profile hidden —
  composition confirms exactly 5 model types.
- IMG_4412→4413: ABILITIES follows Mechanical Bite directly; the melee header/column row at
  4413's top is the app's sticky section header, not a hidden row.
- IMG_4417→4418: the black bar starting at 4417's bottom is Agent's Firearm (first ranged row of
  4418). No hidden weapon.
- Equipment cross-check: every item in every equipment sentence has a matching weapon row
  (Nuncio-Aquila and Tome Skull are abilities, not weapons) — no missing rows.

## OCR-ambiguity notes
- All stat plaques, weapon rows and tags were re-read from 2x LANCZOS crops, not from the full
  page. LD plaques "7+"/"6+" and SV "4+"/"5+"/"6+" are crisp; no ambiguous glyphs remained.
- Curly apostrophes in the app ("Agent’s") were normalised to straight apostrophes in the JSON.

## Validation performed
Post-JSON diff of three fresh randomly-chosen crops against the written file:
1. IMG_4411 "Vigilant with Combat Shotgun, Shotpistol and Gun Stocks" stat row → 6"/3/4+/1/7+/2 — matches.
2. IMG_4416 Eversor keywords box → CHARACTER, EPIC HERO, EVERSOR ASSASSIN, EXPLOSIVES, IMPERIUM,
   INFANTRY, INQUISITOR'S HAND, OFFICIO ASSASSINORUM / AGENTS OF THE IMPERIUM — matches.
3. IMG_4417 Gun Servitor stat row → 6"/3/5+/1/7+/1 — matches.
Earlier targeted verifications (all matched the JSON): Teguen stats + Zealot/Holy Hatred text,
Teguen ranged/melee rows, Eversor stats + both weapon rows + Overkill text, all five Vigilant
weapon rows + both melee rows, Cyber-Mastiff/Proctor stat rows, Agents stats + all four ranged
rows + both melee rows, both mission cards' scoring lines.

## Resolution log

- **2026-08-06 (owner):** supplied follow-up screenshots IMG_0164–0166 — the STRATAGEMS page
  (Urban Enforcers 1CP / Superior Weaponry 1CP / Inquisitorial Mandate 1CP, all three cards
  captured expanded) and the ENHANCEMENTS page (Killer Reflexes, Sanctic Slayers). Items 1–2
  are now only PARTIALLY open: **the patrol landing page is still missing** (the patrol's
  detachment-rule card, its DP cost, the roster list and the Force Disposition), and the
  ASSIGNED AGENTS faction ability text (item 3) remains uncaptured.
- **2026-08-06 (owner):** all transcribed-as-shown anomalies confirmed intentional (items 7–12).
- Transcription note on Sanctic Slayers: the card reads "attacks that target a unit with a T
  greater than or equal to your attack's S have +1 to wound rolls" — transcribed verbatim.
