# The Vengeful Brethren — extraction flags

Source: 14 Warhammer-app iPad screenshots, IMG_4436.PNG–IMG_4449.PNG.
All values below were transcribed from the screenshots only; nothing was filled from prior-edition knowledge.

## Anomalies transcribed-as-shown (please confirm)

1. **Bladeguard Veteran Sergeant T3 while Bladeguard Veteran is T4** (IMG_4440).
   Re-verified with a 2x crop of both stat plaques: Veteran = M 6" / T 4 / SV 3+ / W 3 / LD 6+ / OC 1;
   Sergeant = M 6" / T **3** / SV 3+ / W 3 / LD 6+ / OC 1. This matches the exact anomaly pattern the
   owner previously confirmed as genuinely correct in the app, but spot-check it anyway.
2. **Master Zacharial has NO Leader/attachment section** (IMG_4442–4443). A CHARACTER CAPTAIN with no
   visible "Leader" ability is unusual; I verified the scroll seam between the two screenshots
   overlaps completely (ranged table → melee table → abilities → composition → keywords, nothing
   hidden). Transcribed as absent — confirm the app really shows no Leader block for him.
3. **Bladeguard datasheet ability text renders oddly in the app** (IMG_4441, re-verified at 1.6x):
   a stray bullet splits the sentence ("…when this unit is selected **• to fight** or when…") and
   "one of.the following" has a period instead of a space. Transcribed verbatim including both
   quirks; they look like app typesetting bugs, not rules content.
4. **Intercessors are OC 2 on both profiles** (IMG_4447, crop-verified) while every other unit in the
   patrol is OC 1 — consistent with BATTLELINE, noted as-shown.
5. **All units are LD 6+** including the Captain — as shown on every stat plaque.
6. **Hellblaster equipment line names a profile**: "Every model is equipped with: … 1 Plasma
   Incinerator - Standard." (IMG_4446) — the "- Standard" is in the app text, transcribed verbatim.

## Verified-absent weapon tags (checked with targeted crops, not assumed)

- Master-crafted Power Weapon (Bladeguard): no tags — ABILITIES header sits directly under the row (IMG_4441 crop).
- Power Fist (Zacharial): no tags — clear gap then next weapon header (IMG_4443 crop).
- Knives and Fists (Hellblasters, IMG_4445 crop; Intercessors, IMG_4448): no tags.
- All other weapons carry the tags recorded in the JSON (CLOSE-QUARTERS / ASSAULT / HEAVY /
  HAZARDOUS / EXTRA ATTACKS), each read from its dashed box.

## Data gaps / collapsed sections

1. **IMG_4449 "Opponent's Mission — Purification" card is COLLAPSED** (chevron down). Its contents
   were NOT captured and are NOT in the JSON. (This screenshot is a Battle Setup screen, not part of
   the patrol reference; recorded in sourceImages only.)
2. **"Seize their Strongholds" mission card** (IMG_4449) shows only a "SECOND BATTLE ROUND ONWARDS"
   block. If the card has a first-battle-round block, it is above the captured viewport — data gap.
3. **Oath of Moment** (IMG_4439) is only a pointer: "This ability is described in full in the Army
   Rules section of Codex: Space Marines." The full rule text is not in these screenshots.
4. **No points values, unit-size options, wargear options, Leader, or Transport sections** appear
   anywhere in the captured datasheets (normal for combat-patrol datasheets); nothing was invented.
5. All datasheet accordions (Ranged/Melee/Abilities/Composition/Keywords) were expanded in every
   screenshot; no collapsed datasheet sections were observed.

## Page-completeness checks

- Stratagems page (IMG_4437): a bottom-strip crop confirms the page ends after "Determined to the
  Last" — no fourth card below the fold. None of the three cards shows a "Restrictions:" line, so
  the JSON `restrictions` fields are empty strings.
- Enhancements page (IMG_4438): only two cards, with empty page space below — complete.
- Landing page (IMG_4436): Datasheets list and Force Dispositions ("Take and Hold") re-verified at 1.6x.
- Datasheet scroll seams reconciled: 4440→4441 (Master-crafted Power Weapon row repeats),
  4442→4443 (melee table repeats), 4444→4445 (Bolt Pistol/Plasma rows repeat), 4445→4446
  (Knives and Fists/abilities repeat), 4447→4448 (melee header). Every equipment item named in a
  composition sentence has a matching weapon row; no missing rows.

## Validation re-checks performed (crop → diff vs JSON)

- **Bladeguard stat plaques** (IMG_4440 crop `bg_stats.png`): both rows match JSON, incl. Sergeant T3.
- **Heavy Bolt Pistol** (IMG_4440 crop `bg_hbp.png`): 18" / 1 / 3+ / 4 / -1 / 1 [CLOSE-QUARTERS] — matches.
- **Master Zacharial plaque + Boltstorm Gauntlet** (IMG_4442 crops): 5"/6/3+/6/6+/1 and
  12" / 3 / 2+ / 4 / -1 / 1 [CLOSE-QUARTERS] — match.
- **Plasma Incinerator profiles** (IMG_4445 crop `hb_plasma.png`): Standard 24"/2/3+/7/-2/1
  [ASSAULT, HEAVY]; Supercharge 24"/2/3+/8/-3/2 [ASSAULT, HAZARDOUS, HEAVY] — match, multi-profile
  marker + footnote present.
- **Intercessor plaques + Bolt Rifle** (IMG_4447 crops): 6"/4/3+/2/6+/2 both rows; Bolt Rifle
  24"/2/3+/4/-1/1 [ASSAULT, HEAVY] — match.

## OCR-ambiguous values

None remaining — every stat that was small or seam-adjacent was re-read from an upscaled crop.

## Resolution log

- **2026-08-06 (owner):** all transcribed-as-shown stats confirmed intentional (incl. the
  Bladeguard Sergeant T3 vs squad T4). Accepted, never re-litigate.
