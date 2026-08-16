# Data ingest — Wahapedia CSV → typed JSON

Converts the official Wahapedia 10th-edition data exports into the typed JSON the app reads at
runtime. Forked-in-spirit from [`fjlaubscher/depot`](https://github.com/fjlaubscher/depot): we
consume the same pipe-delimited CSV exports rather than scraping HTML.

## Run it

```bash
pnpm ingest            # downloads (and caches) CSVs, writes data/game/*.json
REFRESH=1 pnpm ingest  # force re-download even if data/raw/*.csv exist
pnpm apply:points11e   # REQUIRED after every ingest — overlays the 11e points (see below)
```

The converter is a single dependency-free TypeScript file (`convert.ts`) run via `tsx`.

## 11th-edition points overlay (`apply-points11e.ts` + `points11e.json`)

Wahapedia's 11e section has **no CSV exports** — the 11e data is HTML-only — so datasheet
*stats* still come from the 10e CSVs while **points, priced wargear and enhancement costs are
11e values** (Faction Pack v1.1) extracted from the `wh40k11ed` faction pages into
`points11e.json` (2026-08-16). `pnpm apply:points11e` overwrites those fields in
`data/game/datasheets.json` / `enhancements.json`; running `pnpm ingest` alone REVERTS points
to 10e, so always re-apply. The file's `detachments` block is the provenance record for the DP
cost table in `src/core/detachments.ts`. 11e points features carried by the overlay:

- **Per-copy escalation** (`copyFrom`/`copyTo` on a tier): e.g. "YOUR 3RD+ UNIT COSTS" — a 3rd
  Hellhound costs 135, the first two 125. `army.ts unitCost/listPoints` price copies in list
  order.
- **Priced wargear** (`Datasheet.wargearCosts`): 11e prices five wargear options ("per
  Demolisher battle cannon: 15 pts"); all other wargear remains free.
- **Agents dual pricing**: the AGENTS OF THE IMPERIUM Detachment price vs the higher
  "Assigned Agent" (allied) price, kept as the existing tier `note` convention.
- The 11e-only datasheet **Tarantula Battery** (AM, Legends) has no 10e datasheet to patch and
  is omitted.

## Source

Base URL: **https://wahapedia.ru/wh40k10ed/** — each file is `<Name>.csv`.

Files fetched:

| File | Used for |
|---|---|
| `Factions.csv` | faction id/name (we keep only `AoI`, `AM`) |
| `Datasheets.csv` | unit id, name, faction |
| `Datasheets_models.csv` | per-model M/T/Sv/inv/W/Ld/OC + base size |
| `Datasheets_wargear.csv` | weapon profiles (range/type/A/BS-WS/S/AP/D + keywords) |
| `Datasheets_keywords.csv` | datasheet keywords |
| `Datasheets_abilities.csv` | ability id references |
| `Abilities.csv` | ability catalog (scoped) |
| `Stratagems.csv` | stratagem catalog (scoped) |
| `Enhancements.csv` | enhancement catalog (scoped) |
| `Detachment_abilities.csv` | detachment-rule catalog (scoped) |
| `Last_update.csv` | provenance stamp recorded in `meta.json` |

Raw CSVs are cached in `data/raw/` (git-ignored). Converted JSON is written to `data/game/`
and **is committed**, so the app needs no network at runtime.

## Scope

Only the two factions used by the three owned lists are kept: **Imperial Agents (`AoI`)** and
**Astra Militarum (`AM`)**. Everything else is filtered out to keep the data small. Change
`KEEP_FACTIONS` in `convert.ts` to adjust.

## Output (`data/game/`)

- `datasheets.json` — `Datasheet[]` (matches `src/core/types.ts`)
- `abilities.json`, `stratagems.json`, `enhancements.json`, `detachments.json` — scoped catalogs
  (used to resolve roster enhancements and as a head start for later stages)
- `factions.json`
- `meta.json` — source URL, generation date, Wahapedia last-update stamp, counts, and **warnings**

## Conversion notes & assumptions

- **Stat decoration is stripped:** `6"`→6, `4+`→4. Invulnerable saves are stored as a bare
  number (Wahapedia gives e.g. `5`, meaning 5++); `-`/empty means none.
- **Weapon keywords** come from the wargear `description` field (comma-separated, e.g.
  `rapid fire 1, devastating wounds`). Source casing is inconsistent (`pistol` vs `PISTOL`) and
  is preserved verbatim here; the Stage-2 keyword library will normalize.
- **Base sizes:** circular (`40mm`) and oval (`100 x 40mm`) bases are parsed exactly into inch
  radii. Hull-measured models (`base_size = "Use model"`) get an approximate physical footprint
  — a small curated table (`HULL_FOOTPRINTS_MM`) for common chassis, otherwise a keyword
  heuristic (Titanic/Vehicle/Monster/Walker). These are **rendering approximations, not rules
  data**, and every one is listed in `meta.json` `warnings`.
- **Abilities:** only non-empty `ability_id` references are captured into `Datasheet.abilityIds`
  for now. Inline/unit-specific ability *text* is deferred to Stage 4 (the ability system).
- **Determinism:** arrays are sorted (datasheets by name, catalogs by id) and inch values rounded
  to 4dp so re-running the converter produces stable, diff-friendly output.
