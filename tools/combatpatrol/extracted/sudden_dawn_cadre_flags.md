# Sudden Dawn Cadre — extraction flags & spot-check list

Source: 14 Warhammer-app iPad screenshots, `patrols/sudden_dawn_cadre/IMG_4422.PNG`–`IMG_4435.PNG`.
All flagged values were transcribed exactly as displayed; nothing was reconstructed from prior-edition knowledge.

## Anomalies transcribed-as-shown (please confirm)

1. **"BLAST 1" weapon tag** — Commander Cloudspear's Airbursting Fragmentation Projector carries the
   tags `BLAST 1` and `INDIRECT FIRE` (IMG_4434, verified with a 3x crop). "BLAST" with a numeric
   parameter is unusual; transcribed exactly as shown. Spot-check the AFP tag row on IMG_4434.

2. **For the Greater Good bracket typo** — the army rule's second paragraph reads
   "…eligible to shoot (excluding FORTIFICATION and Battle-shocked units**]** select one enemy unit…"
   (IMG_4426, verified with a 1.6x crop). The parenthetical opens with "(" but closes with "]" and has
   no comma before "select". Transcribed verbatim, typo included.

3. **"Sha'sui" vs "Shas'ui" spelling** — the Breacher Team's sergeant profile and composition both
   read **"Sha'sui"** (IMG_4430/IMG_4431, verified with 2.5–3x crops), while the Pathfinder Team's
   sergeant reads **"Shas'ui"** (IMG_4427). Inconsistent in the app; both transcribed as shown.

4. **No invulnerable save on Commander Cloudspear** — the datasheet shows SV 2+ and **no
   INVULNERABLE SAVE banner** between the stat plaque and RANGED WEAPONS (IMG_4434, verified with a
   2x crop of that seam). Prior editions gave this suit an invuln; the screenshot does not. Recorded
   as `invuln: null` with an explanatory `invulnNote`. Spot-check the plaque region of IMG_4434.

5. **"Close Combat Weapon" vs "Gun Stocks"** — Pathfinder model names say "…and Close Combat Weapon",
   but every equipment sentence and the melee table list only **Gun Stocks**. As shown in the app;
   the name's "close combat weapon" evidently maps to the Gun Stocks row.

6. **Suppressing Fire's "pinned" and Earth Caste Modifications' "suppressed"** define bespoke
   conditions inline (−2" M / −1 to hit); transcribed with their bullet structure intact.

## Verified-absent weapon tags (targeted crop checks, not assumptions)

- Pathfinder **Pulse Carbine** (20" 2 4+ 5 0 1) — no tags (IMG_4428 crop: clear gap to next row).
- Devilfish **Accelerator Burst Cannon** (18" 4 4+ 6 -1 1) — no tags (IMG_4432 crop).
- Commander **Plasma Rifle** (18" 1 3+ 8 -3 3) — no tags (IMG_4434 crop); also no multi-profile ➤ marker.
- **Gun Stocks** (both infantry units), **Armoured Hull**, **Battlesuit Fists** — no tags
  (IMG_4428/4431/4433/4435: each row runs straight into the next section header).
- No weapon on any of the four datasheets carries the ➤ multi-profile marker; `profileOf` is null throughout.

## Data gaps / coverage limits

7. **IMG_4422 is not patrol data** — it is a Battle Setup missions screen ("Inquisitorial Sanction"
   card **collapsed — contents not captured**; "Expansionary Campaign" expanded). Excluded from the
   JSON except as a sourceImages description. If the Inquisitorial Sanction mission text is wanted,
   a screenshot with that accordion expanded is needed.

8. **Single-screenshot pages** — Stratagems (3 cards) and Enhancements (2 cards) were each captured
   in one screenshot ending in a large empty region after the last card, which suggests the list end,
   but content scrolled below the fold cannot be strictly ruled out. Same for the patrol landing page
   below "Force Dispositions".

9. **All "Lore" accordions collapsed** on every page (patrol rule, stratagems, enhancements, army
   rules). Flavor text intentionally not captured; rules text is complete.

10. **IMG_4429 melee-section render** — shows the MELEE WEAPONS header + column row with no weapon
    row before ABILITIES (scroll-seam/sticky-header artifact). The Gun Stocks row IS present and was
    captured in IMG_4428. No data gap; noted so nobody "finds" a missing row later.

11. **No Leader/attach section** on Commander Cloudspear as displayed (no "Leader" ability, no
    attachment text). `leaderAttach` is null for all units. If the app hides an attachment section
    behind another screen, it was not captured.

12. **Devilfish and Commander profile names** — single-profile datasheets are displayed with a stat
    plaque but **no blue profile-name bar**; the profile `name` in the JSON is taken from the unit
    composition model table ("Devilfish", "Commander Cloudspear").

## Re-verification performed (validation pass)

- **Breacher Team both stat plaques** (IMG_4430 fresh crop): Sha'sui and Breacher Team both
  M 6" / T 3 / SV 4+ / W 1 / LD 7+ / OC 2 — matches JSON. ✔
- **Devilfish Twin Pulse Carbine row** (IMG_4432 fresh crop): 20" / 2 / 4+ / 5 / 0 / 1 with
  ASSAULT + TWIN-LINKED — matches JSON. ✔
- **Commander Cloudspear abilities** (IMG_4435 fresh crop): Shield Drone "This model has +1 W.";
  Superior Weapon Support System "…can ignore modifiers to: • BS. • Hit rolls." — matches JSON. ✔
- Earlier targeted crops also verified: Pathfinder 3 profile bars + stats, Pathfinder full ranged
  table, Devilfish plaque (M12" T9 SV3+ W13 LD7+ OC2), Commander plaque (M8" T5 SV2+ W6 LD7+ OC2),
  AFP tag row, Plasma Rifle row, Breacher Pulse Blaster row (10" 2 3+ 6 -1 1 ASSAULT),
  Co-ordinated Eradication text, For the Greater Good full text, "Sha'sui" bar + composition line.

No OCR values remain uncertain beyond the items listed above.

## Resolution log

- **2026-08-06 (owner):** all transcribed-as-shown values confirmed intentional. Accepted.
