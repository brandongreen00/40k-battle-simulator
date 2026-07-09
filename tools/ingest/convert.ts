/**
 * Wahapedia 10th-edition CSV -> typed JSON converter.
 *
 * Vendored/forked-in-spirit from `fjlaubscher/depot` (per the build plan): we fetch the
 * official pipe-delimited CSV exports and convert them into the typed shapes in
 * `src/core/types.ts`, SCOPED to only the factions our three lists use (Imperial Agents +
 * Astra Militarum). Output is committed under `data/game/` so the app has no runtime network
 * dependency.
 *
 * Run with:  pnpm ingest
 *
 * Licensing: Wahapedia data is personal-use only; all 40k rules/IP belong to Games Workshop.
 * This converter and its output exist solely to make a private, non-commercial tool work offline.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Datasheet,
  ModelProfile,
  WeaponProfile,
  BaseShape,
  PointsTier,
  WargearOption,
  UnitAbility,
  Enhancement,
} from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const RAW_DIR = resolve(REPO_ROOT, 'data/raw');
const OUT_DIR = resolve(REPO_ROOT, 'data/game');

const BASE_URL = 'https://wahapedia.ru/wh40k10ed';

/** Only these factions appear in the three owned lists; everything else is filtered out. */
const KEEP_FACTIONS = new Set(['AoI', 'AM']);

const MM_PER_INCH = 25.4;
const warnings: string[] = [];

// ── CSV download + parse ─────────────────────────────────────────────────────
const CSV_FILES = [
  'Factions',
  'Datasheets',
  'Datasheets_models',
  'Datasheets_wargear',
  'Datasheets_keywords',
  'Datasheets_abilities',
  'Datasheets_models_cost', // points per model-count tier (the list builder's backbone)
  'Datasheets_options', // wargear swap options (natural-language + <li> choices)
  'Datasheets_unit_composition', // valid unit compositions
  'Datasheets_leader', // leader -> bodyguard attachment map
  'Abilities',
  'Stratagems',
  'Enhancements',
  'Detachment_abilities',
  'Last_update',
] as const;

async function download(file: string): Promise<string> {
  const dest = resolve(RAW_DIR, `${file}.csv`);
  if (existsSync(dest) && process.env.REFRESH !== '1') {
    return readFileSync(dest, 'utf8');
  }
  const url = `${BASE_URL}/${file}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(dest, text, 'utf8');
  return text;
}

type Row = Record<string, string>;

/**
 * Parse a Wahapedia pipe-delimited CSV. Every record ends with a trailing `|`, so we treat the
 * trailing pipe as the true record terminator — this lets us correctly re-join description
 * fields that contain embedded newlines. Fields never contain a literal `|`.
 */
function parseCsv(text: string): Row[] {
  const clean = text.replace(/^﻿/, ''); // strip BOM
  const physical = clean.split(/\r?\n/);

  const headerLine = physical[0] ?? '';
  const columns = splitRecord(headerLine);

  const rows: Row[] = [];
  let buffer = '';
  for (let i = 1; i < physical.length; i++) {
    const line = physical[i]!;
    if (buffer === '' && line === '') continue;
    buffer = buffer === '' ? line : `${buffer}\n${line}`;
    if (line.endsWith('|')) {
      rows.push(toRow(columns, splitRecord(buffer)));
      buffer = '';
    }
  }
  if (buffer.trim() !== '') rows.push(toRow(columns, splitRecord(buffer)));
  return rows;
}

/** Split one record on `|` and drop the single empty cell produced by the trailing pipe. */
function splitRecord(record: string): string[] {
  const parts = record.split('|');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function toRow(columns: string[], values: string[]): Row {
  const row: Row = {};
  for (let i = 0; i < columns.length; i++) row[columns[i]!] = (values[i] ?? '').trim();
  return row;
}

// ── value parsing helpers ────────────────────────────────────────────────────
/** Pull the first number out of a decorated stat string, e.g. `6"`->6, `4+`->4, `-`->NaN. */
function num(s: string | undefined): number {
  if (s == null) return NaN;
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

function intOr(s: string | undefined, fallback: number): number {
  const n = num(s);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Optional invuln save: bare number like `5` means 5++; `-` or empty means none. */
function parseInvuln(s: string | undefined): number | undefined {
  if (!s || s === '-') return undefined;
  const n = num(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Strip Wahapedia's inline HTML to readable plain text (lists become " • "-separated). */
function stripHtml(s: string | undefined): string {
  return (s ?? '')
    .replace(/<ky>(.*?)<\/ky>/gis, '$1')
    .replace(/<li>/gi, ' • ')
    .replace(/<\/(li|p|div|h\d)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse one wargear-option row into a lead-in sentence + the bulleted weapon choices.
 * e.g. "...replaced with one of the following:<ul><li>1 flamer</li>...</ul>" ->
 *      { text: "...replaced with one of the following:", choices: ["1 flamer", ...] }
 * Rows with no list (a single swap) yield choices: [].
 */
function parseWargearOption(html: string): WargearOption {
  const ulIdx = html.search(/<ul/i);
  const lead = ulIdx >= 0 ? html.slice(0, ulIdx) : html;
  const choices = [...html.matchAll(/<li>(.*?)<\/li>/gis)]
    .map((m) => stripHtml(m[1]))
    .filter(Boolean);
  return { text: stripHtml(lead), choices };
}

/** Parse a cost row's "10 models" / "1 model (Assigned Agent)" description into a tier. */
function parsePointsTier(description: string, cost: string): PointsTier {
  const models = intOr(description, 1); // leading integer
  const paren = description.match(/\(([^)]*)\)/);
  const note = paren ? stripHtml(paren[1]) : undefined;
  return { models, cost: intOr(cost, 0), ...(note ? { note } : {}) };
}

/**
 * Curated physical hull footprints (oval, [major, minor] in mm) for common hull-measured
 * Imperial Agents / Astra Militarum chassis. Wahapedia stores their base_size as "Use model"
 * (no base — you measure to the hull), so we supply an approximate footprint so the measuring
 * board renders them at a sane size. These are physical-model approximations, NOT rules data.
 */
const HULL_FOOTPRINTS_MM: Record<string, [number, number]> = {
  'Chimera': [120, 65],
  'Inquisitorial Chimera': [120, 65],
  'Storm Chimera': [120, 65],
  'Imperial Rhino': [110, 60],
  'Sisters of Battle Immolator': [110, 60],
  'Taurox': [105, 70],
  'Taurox Prime': [105, 70],
  'Hellhound': [120, 70],
  'Rogal Dorn Battle Tank': [145, 85],
  'Rogal Dorn Commander': [145, 85],
};

/** Keyword-based fallback footprint (oval [major, minor] mm) for hull-measured models. */
function heuristicHullMm(keywords: string[]): [number, number] {
  const kw = new Set(keywords.map((k) => k.toLowerCase()));
  if (kw.has('titanic')) return [200, 95]; // super-heavy hull (e.g. Baneblade chassis / Stormlord)
  if (kw.has('vehicle')) return [120, 70]; // generic tank hull
  if (kw.has('monster')) return [100, 60];
  if (kw.has('walker')) return [80, 60];
  return [32, 32]; // last resort: a 32mm circle's bounds
}

/**
 * Parse `40mm`, `100 x 40mm`, `28.5mm` into a BaseShape (radii in inches). For hull-measured
 * models ("Use model"/empty) we apply a curated or keyword-heuristic footprint and flag it.
 */
function parseBaseShape(raw: string | undefined, dsName: string, keywords: string[]): BaseShape {
  const s = (raw ?? '').toLowerCase().replace(/mm/g, '').trim();

  if (s === '' || s === '-' || s.includes('use')) {
    const curated = HULL_FOOTPRINTS_MM[dsName];
    const [major, minor] = curated ?? heuristicHullMm(keywords);
    warnings.push(
      `no base size for "${dsName}" (raw: "${raw ?? ''}") -> ${curated ? 'curated' : 'heuristic'} footprint ${major}x${minor}mm`,
    );
    return major === minor
      ? { kind: 'circle', radius: mm(major) / 2 }
      : { kind: 'oval', rx: mm(major) / 2, ry: mm(minor) / 2 };
  }

  if (s.includes('x')) {
    const [a, b] = s.split('x').map((t) => parseFloat(t.trim()));
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      warnings.push(`unparseable oval base "${raw}" for "${dsName}" -> defaulted to 32mm circle`);
      return { kind: 'circle', radius: mm(32) / 2 };
    }
    return { kind: 'oval', rx: mm(Math.max(a!, b!)) / 2, ry: mm(Math.min(a!, b!)) / 2 };
  }

  const d = parseFloat(s);
  if (!Number.isFinite(d)) {
    warnings.push(`unparseable base "${raw}" for "${dsName}" -> defaulted to 32mm circle`);
    return { kind: 'circle', radius: mm(32) / 2 };
  }
  return { kind: 'circle', radius: mm(d) / 2 };
}

function mm(v: number): number {
  return v / MM_PER_INCH;
}

/** Round inches to 4dp so committed JSON is stable and small. */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
function roundShape(s: BaseShape): BaseShape {
  return s.kind === 'circle'
    ? { kind: 'circle', radius: round4(s.radius!) }
    : { kind: 'oval', rx: round4(s.rx!), ry: round4(s.ry!) };
}

// ── conversion ───────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('Downloading Wahapedia CSVs (cached in data/raw; set REFRESH=1 to re-fetch)...');
  const csv: Record<string, Row[]> = {};
  for (const f of CSV_FILES) {
    csv[f] = parseCsv(await download(f));
    console.log(`  ${f}.csv: ${csv[f]!.length} rows`);
  }

  // Datasheets scoped to the two factions.
  const datasheetRows = csv['Datasheets']!.filter((r) => KEEP_FACTIONS.has(r['faction_id']!));
  const keepIds = new Set(datasheetRows.map((r) => r['id']!));

  // Index supporting tables by datasheet_id.
  const modelsBy = groupBy(csv['Datasheets_models']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');
  const wargearBy = groupBy(csv['Datasheets_wargear']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');
  const keywordsBy = groupBy(csv['Datasheets_keywords']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');
  const abilitiesBy = groupBy(csv['Datasheets_abilities']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');
  const costBy = groupBy(csv['Datasheets_models_cost']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');
  const optionsBy = groupBy(csv['Datasheets_options']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');
  const compositionBy = groupBy(csv['Datasheets_unit_composition']!.filter((r) => keepIds.has(r['datasheet_id']!)), 'datasheet_id');

  // Ability catalog (ALL rows, unfiltered) so Core/Faction ability_id references resolve to text.
  const abilityCatalog = new Map<string, { name: string; description: string }>();
  for (const r of csv['Abilities']!) {
    abilityCatalog.set(r['id']!, { name: r['name'] ?? '', description: stripHtml(r['description']) });
  }

  // Leader attachments, scoped so both ends are kept factions.
  const leaderRows = csv['Datasheets_leader']!.filter(
    (r) => keepIds.has(r['leader_id']!) && keepIds.has(r['attached_id']!),
  );
  const canLeadBy = groupBy(leaderRows, 'leader_id'); // leader id -> rows (attached_id = bodyguard)
  const ledByBy = groupBy(leaderRows, 'attached_id'); // bodyguard id -> rows (leader_id = leader)

  const datasheets: Datasheet[] = datasheetRows
    .map((r): Datasheet => {
      const id = r['id']!;
      const name = r['name']!;
      const models: ModelProfile[] = (modelsBy[id] ?? [])
        .sort((a, b) => intOr(a['line'], 0) - intOr(b['line'], 0))
        .map((m) => ({
          name: m['name'] || name,
          M: num(m['M']),
          T: intOr(m['T'], 0),
          Sv: intOr(m['Sv'], 7),
          ...(parseInvuln(m['inv_sv']) != null ? { invuln: parseInvuln(m['inv_sv']) } : {}),
          W: intOr(m['W'], 1),
          Ld: intOr(m['Ld'], 7),
          OC: intOr(m['OC'], 0),
        }));

      const weapons: WeaponProfile[] = (wargearBy[id] ?? [])
        .sort((a, b) => intOr(a['line'], 0) - intOr(b['line'], 0) || intOr(a['line_in_wargear'], 0) - intOr(b['line_in_wargear'], 0))
        .map((w): WeaponProfile => {
          const type = w['type']!.toLowerCase() === 'melee' ? 'melee' : 'ranged';
          const keywords = (w['description'] ?? '')
            .split(',')
            .map((k) => k.trim())
            .filter((k) => k.length > 0);
          const rangeRaw = w['range'] ?? '';
          const range = type === 'melee' || /melee/i.test(rangeRaw) ? undefined : num(rangeRaw);
          return {
            name: w['name']!,
            type,
            ...(range != null && Number.isFinite(range) ? { range } : {}),
            attacks: w['A'] || '1',
            skill: intOr(w['BS_WS'], 0),
            S: intOr(w['S'], 0),
            AP: intOr(w['AP'], 0),
            D: w['D'] || '1',
            keywords,
          };
        });

      const keywords = uniq((keywordsBy[id] ?? []).map((k) => k['keyword']!).filter(Boolean));

      // First model's base size is used for the unit's base shape (keyword-aware for hulls).
      const firstModelBase = (modelsBy[id] ?? [])[0]?.['base_size'];
      const baseShape = roundShape(parseBaseShape(firstModelBase, name, keywords));
      const abilityRows = (abilitiesBy[id] ?? []).sort((a, b) => intOr(a['line'], 0) - intOr(b['line'], 0));
      const abilityIds = uniq(abilityRows.map((a) => a['ability_id']!).filter((x) => x && x.length > 0));

      // Full ability list, incl. the unit's *special* rules: inline (type=Datasheet) rows carry the
      // name + description directly; Core/Faction rows resolve their text from the catalog.
      const abilities: UnitAbility[] = abilityRows
        .map((a): UnitAbility => {
          const cat = a['ability_id'] ? abilityCatalog.get(a['ability_id']) : undefined;
          const name = (a['name'] && a['name'].length ? a['name'] : cat?.name) ?? '';
          const description = a['description'] && a['description'].length ? stripHtml(a['description']) : (cat?.description ?? '');
          // Wahapedia decorates `type` with a layout hint, e.g. "Special (правая колонка)" — keep the
          // leading word only (Core / Faction / Datasheet / Wargear / Special / Primarch / …).
          const type = (a['type'] || '').split('(')[0].trim();
          // Parameterised Core abilities (Scouts 9", Deadly Demise D3, Feel No Pain 5+, Firing
          // Deck 12) carry their per-unit value in the `parameter` column — keep it.
          const parameter = (a['parameter'] || '').trim();
          return { name, description, ...(type ? { type } : {}), ...(parameter ? { parameter } : {}) };
        })
        .filter((x) => x.name.length > 0);

      // ── list-builder enrichment ──
      const points: PointsTier[] = (costBy[id] ?? [])
        .sort((a, b) => intOr(a['line'], 0) - intOr(b['line'], 0))
        .map((c) => parsePointsTier(c['description'] ?? '', c['cost'] ?? '0'));
      if (points.length === 0) warnings.push(`no points cost found for "${name}" (${id})`);

      const composition = (compositionBy[id] ?? [])
        .sort((a, b) => intOr(a['line'], 0) - intOr(b['line'], 0))
        .map((c) => stripHtml(c['description']))
        .filter(Boolean);

      const optionRows = (optionsBy[id] ?? []).sort((a, b) => intOr(a['line'], 0) - intOr(b['line'], 0));
      const wargearOptions = optionRows
        .filter((o) => o['button'] !== '*')
        .map((o) => parseWargearOption(o['description'] ?? ''))
        .filter((o) => o.text.length > 0 || o.choices.length > 0);
      const wargearNotes = optionRows
        .filter((o) => o['button'] === '*')
        .map((o) => stripHtml(o['description']))
        .filter(Boolean);

      const canLead = (canLeadBy[id] ?? []).map((l) => l['attached_id']!);
      const canBeLedBy = (ledByBy[id] ?? []).map((l) => l['leader_id']!);

      return {
        id,
        name,
        faction: r['faction_id']!,
        role: r['role'] ?? '',
        loadout: stripHtml(r['loadout']),
        models,
        weapons,
        baseShape,
        keywords,
        abilityIds,
        ...(abilities.length ? { abilities } : {}),
        points,
        composition,
        wargearOptions,
        ...(wargearNotes.length ? { wargearNotes } : {}),
        ...(canLead.length ? { canLead } : {}),
        ...(canBeLedBy.length ? { canBeLedBy } : {}),
        ...(stripHtml(r['transport']) ? { transport: stripHtml(r['transport']) } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Auxiliary catalogs (scoped) — small, and a head start for later stages / roster resolution.
  const abilities = csv['Abilities']!
    .filter((r) => KEEP_FACTIONS.has(r['faction_id']!) || r['faction_id'] === '')
    .map((r) => pick(r, ['id', 'name', 'faction_id', 'legend', 'description']))
    .sort((a, b) => a.id.localeCompare(b.id));

  const stratagems = csv['Stratagems']!
    .filter((r) => KEEP_FACTIONS.has(r['faction_id']!))
    .map((r) => pick(r, ['id', 'name', 'faction_id', 'type', 'cp_cost', 'turn', 'phase', 'detachment', 'detachment_id', 'legend', 'description']))
    .sort((a, b) => a.id.localeCompare(b.id));

  const enhancements: Enhancement[] = csv['Enhancements']!
    .filter((r) => KEEP_FACTIONS.has(r['faction_id']!))
    .map((r) => ({
      id: r['id']!,
      name: r['name']!,
      faction: r['faction_id']!,
      cost: intOr(r['cost'], 0),
      detachment: r['detachment'] ?? '',
      detachmentId: r['detachment_id'] ?? '',
      description: stripHtml(r['description']),
    }))
    .sort((a, b) => a.detachment.localeCompare(b.detachment) || a.name.localeCompare(b.name));

  const detachments = csv['Detachment_abilities']!
    .filter((r) => KEEP_FACTIONS.has(r['faction_id']!))
    .map((r) => pick(r, ['id', 'faction_id', 'name', 'detachment', 'detachment_id', 'legend', 'description']))
    .sort((a, b) => a.id.localeCompare(b.id));

  const factions = csv['Factions']!
    .filter((r) => KEEP_FACTIONS.has(r['id']!))
    .map((r) => pick(r, ['id', 'name', 'link']));

  // Write outputs.
  writeJson('factions.json', factions);
  writeJson('datasheets.json', datasheets);
  writeJson('abilities.json', abilities);
  writeJson('stratagems.json', stratagems);
  writeJson('enhancements.json', enhancements);
  writeJson('detachments.json', detachments);

  const lastUpdate = csv['Last_update']![0] ?? {};
  writeJson('meta.json', {
    source: BASE_URL,
    generatedAt: new Date().toISOString().slice(0, 10),
    wahapediaLastUpdate: lastUpdate,
    scope: { factions: [...KEEP_FACTIONS] },
    counts: {
      datasheets: datasheets.length,
      abilities: abilities.length,
      stratagems: stratagems.length,
      enhancements: enhancements.length,
      detachments: detachments.length,
    },
    warnings,
  });

  console.log(`\nWrote ${datasheets.length} datasheets (factions: ${[...KEEP_FACTIONS].join(', ')}).`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log('  - ' + w);
  }
}

// ── tiny utils ───────────────────────────────────────────────────────────────
function groupBy(rows: Row[], key: string): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const r of rows) (out[r[key]!] ??= []).push(r);
  return out;
}
function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
function pick<K extends string>(row: Row, keys: K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) out[k] = row[k] ?? '';
  return out;
}
function writeJson(name: string, data: unknown): void {
  writeFileSync(resolve(OUT_DIR, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
