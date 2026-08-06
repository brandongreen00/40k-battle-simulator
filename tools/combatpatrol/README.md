# Combat Patrol data pipeline

`extracted/*.json` are the four patrols transcribed from the owner's
Warhammer-app screenshots (Drive: "40K Combat Patrol 11th", 57 images) using the
screenshot→datasheet methodology: native-vision reading with crop-and-upscale
verification, **transcribe-never-reconstruct** (no value is ever filled from
prior-edition memory), scroll-seam reconciliation, verified-absent checks for
weapon tags, and per-patrol flag lists (`extracted/*_flags.md`) recording every
ambiguity, anomaly and gap for the owner to spot-check.

`build.ts` converts the extraction into the app's data shapes:

- `data/game/cp_datasheets.json` — `Datasheet[]` (profiles, weapons with the
  `"<base> – <profile>"` multi-profile convention, base shapes, abilities with
  their rules text, transport capacity, `canLead`, and `cpReserveRound` for the
  mandatory-Strategic-Reserves units parsed from the patrol rules).
- `data/game/cp_patrols.json` — patrol meta (rules/stratagems/enhancements
  texts, Force Dispositions) for the later missions/stratagems steps.
- `data/rosters/cp_*.json` — the four fixed lists (`combatPatrol: true`), with
  per-weapon carrier counts parsed from the equipment sentences.

Run: `pnpm build:cp`

Known source gaps (see the flag files): the Inquisitor's Hand capture lacks its
landing/stratagems/enhancements pages; Gate of Infinity's battle-size table is
not rendered by the app.
