# Crowe's Sanctifiers — extraction flags

All values transcribed from the screenshots only. Items below are the ones a human should
spot-check, plus explicit data gaps and verified-absent notes.

## Data gaps (content not present in the screenshots)

1. **Gate of Infinity battle-size table missing (IMG_4454).** The card text ends with
   "The maximum number of units you can select depends on the battle size, as follows:" and
   then jumps straight to "Once you have made your selections…". The referenced battle-size
   table is NOT rendered by the app on this page. Crop-verified at 2x — there is genuinely no
   table between the two paragraphs. The JSON transcribes exactly what is shown.
2. **IMG_4450 is a Battle Setup (missions) screen, not patrol reference data.** "Seize their
   Strongholds" (Your Mission) is a collapsed accordion — its contents were never displayed and
   are not captured. The opponent's "Purification" mission is partially shown (Sanctification
   twist selector; End of the Battle: 5VP per objective you control; 10VP per objective
   sanctified by your army). None of this went into the patrol JSON since it is mission-deck
   content, not the patrol itself.
3. **"Lore" accordions everywhere are collapsed** (patrol card, stratagems, enhancements, army
   rule). Lore/flavour text was not captured — by design, and it is not rules data.
4. **No points/cost values appear anywhere** (Combat Patrol app format): enhancements show no
   cost, datasheets show no points. Nothing to capture; noting so nobody expects them.
5. **Stratagems have no Restrictions line** — all three cards show only When/Target/Effect.
   `restrictions` is recorded as "" (verified, not an OCR miss).

## Likely app typo — transcribed as shown

6. **"FOESIGHT (PSYCHIC)" (IMG_4464, Castellan Crowe).** The black ability pill really reads
   FOESIGHT, not FORESIGHT — verified with a 3x crop. Almost certainly a Warhammer-app typo,
   but per the cardinal rule it is transcribed exactly as shown. Please confirm before
   normalizing the name.

## Real anomalies / differs-from-prior-edition — transcribed as shown, please confirm

7. **Psycannon S 8** (both Strike Squad IMG_4456 and Terminator Squad IMG_4461). Prior-edition
   Psycannon was S7. Crop-verified at 2x on the Strike Squad sheet: 24" / 3 / 3+ / 8 / -1 / 2.
8. **Nemesis Force Weapon A differs between datasheets**: Strike Squad A 3 (IMG_4456) vs
   Brotherhood Terminators A 4 (IMG_4461). Both crop-verified; a genuine datasheet difference,
   not a transcription slip. All other NFW numbers identical (WS 3+, S 6, AP -2, D 2, PSYCHIC).
9. **Venerable Dreadnought has CHARACTER and SMOKE keywords, OC 3, T 9, W 8** (IMG_4458/4459)
   and **no invulnerable save**. All as shown on screen.
10. **LD 6+ on every profile in the patrol** (all four datasheets). Consistent with the app's
    current edition; noted because prior-edition Grey Knights values differ.
11. **Castellan Crowe is BS/WS 2+ on everything** (Purifying Flame 2+, Storm Bolter 2+, Black
    Blade 2+) while squad models are 3+ — crop-verified, as shown.
12. **Crowe has no Leader/attachment section** on his datasheet (IMG_4463/4464) — verified
    absent (ABILITIES goes straight to UNIT COMPOSITION). `leaderAttach` omitted.
13. **Strike Squad keyword list includes EXPLOSIVES** (also on Terminators and Crowe) — an
    11th-edition keyword; transcribed as shown.

## Verified-absent (targeted checks, not assumptions)

14. **Ceramite Fists: no keyword tags** (IMG_4456) — 2x crop shows clean white space between the
    stat line and the next weapon bar.
15. **Dreadnought Fist: no keyword tags** (IMG_4459) — 2x crop shows the stat line runs straight
    into the ABILITIES header.
16. **Strike Squad has no INVULNERABLE SAVE banner** — the IMG_4455/IMG_4456 overlap covers the
    Justicar plaque → RANGED WEAPONS seam with no banner between (2x crop of the seam).
17. **Terminator INVULNERABLE SAVE 4+ banner has no conditional note** (IMG_4460/4461 crop) —
    just the shield icon. Same for Crowe's 4+ banner (IMG_4463).
18. **No multi-profile (➤) weapons anywhere in this patrol** — no profile markers or footnotes
    on any datasheet; `multiProfileFootnote` therefore not set on any unit.

## Scroll-seam reconciliation notes

19. Datasheet runs overlap cleanly: IMG_4455/56 (Justicar plaque + Incinerator row repeated),
    IMG_4458/59 (Twin Lascannon TWIN-LINKED tag + Dreadnought Fist repeated), IMG_4460/61
    (invuln banner + Psycannon repeated), IMG_4461/62 (NFW row + Force Edge repeated),
    IMG_4463/64 (Black Blade stat line repeated, its tags only visible in 4464). No weapon row
    or ability is hidden in a seam; every composition equipment item has a matching weapon row.
20. The Venerable Dreadnought and Castellan Crowe sheets show no blue profile-name bar above the
    stat plaque (single-model sheets); the profile name in the JSON uses the datasheet title.
    Model-count tables give the model names ("Venerable Dreadnought", "Castellan Crowe").

## Validation re-checks performed (crop → diff against JSON)

- **Castellan Crowe stat plaque** (IMG_4463 crop): M 6" / T 4 / SV 2+ / W 5 / LD 6+ / OC 1 —
  matches JSON. Purifying Flame row re-read: 18" / 3 / 2+ / 4 / -2 / 1 with ANTI-INFANTRY 2+,
  IGNORES COVER, PSYCHIC — matches JSON.
- **Brotherhood Terminator Justicar plaque** (IMG_4460 crop): 5" / 5 / 2+ / 3 / 6+ / 2 —
  matches JSON. Invuln banner 4+ — matches.
- **Venerable Dreadnought Twin Lascannon** (IMG_4458 crop): 48" / 1 / 3+ / 12 / -3 / D6+1,
  TWIN-LINKED — matches JSON.
- **Strike Squad Psycannon + Nemesis Force Weapon** (IMG_4456 crops): 24"/3/3+/8/-1/2 PSYCHIC
  and Melee/3/3+/6/-2/2 PSYCHIC — match JSON.
- **FOESIGHT pill + ability text** (IMG_4464 3x crop): matches JSON verbatim.
