/**
 * Combat Patrol data builder.
 *
 * Reads the four hand-extracted patrol files under tools/combatpatrol/extracted/
 * (transcribed from the owner's Warhammer-app screenshots — see the *_flags.md
 * files for every ambiguity/gap that survived extraction) and emits:
 *
 *   data/game/cp_datasheets.json   — Datasheet[] for the 16 patrol units
 *   data/game/cp_patrols.json      — per-patrol rules/stratagems/enhancements meta
 *   data/rosters/cp_<patrol>.json  — the four fixed Combat Patrol rosters
 *
 * Run: pnpm build:cp
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

interface XWeapon {
  name: string;
  profileOf?: string | null;
  range?: string;
  A: string;
  BS?: string;
  WS?: string;
  S: number;
  AP: number;
  D: string;
  tags?: string[];
}
interface XProfile { name: string; M: string; T: number; SV: string; W: number; LD: string; OC: number }
interface XUnit {
  name: string;
  profiles: XProfile[];
  invuln?: string;
  invulnNote?: string;
  rangedWeapons?: XWeapon[];
  meleeWeapons?: XWeapon[];
  factionAbilities?: string[];
  datasheetAbilities?: { name: string; text: string }[];
  wargearAbilities?: { name: string; text: string }[];
  composition?: { bullets?: string[]; equipment?: string[]; notes?: string; baseSize?: string };
  leaderAttach?: string | null;
  transport?: string | null;
  keywords?: string[];
  factionKeywords?: string[];
  multiProfileFootnote?: boolean;
}
interface XPatrol {
  id: string;
  name: string;
  faction: string;
  patrolRules?: { name: string; text: string }[];
  enhancements?: { name: string; text: string }[];
  stratagems?: { name: string; cp?: number; when?: string; target?: string; effect?: string; restrictions?: string }[];
  forceDispositions?: string[];
  rosterList?: { name: string; count?: string }[];
  units: XUnit[];
}

const PATROLS = ['crowes_sanctifiers', 'inquisitors_hand', 'sudden_dawn_cadre', 'vengeful_brethren'];

const slug = (s: string) =>
  s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const parsePlus = (s: string | undefined): number => {
  if (!s) return 0;
  const m = s.match(/(\d+)\s*\+/);
  return m ? parseInt(m[1]!, 10) : 0; // "-" / "N/A" (e.g. Torrent) → 0, like the Wahapedia data
};
const parseInches = (s: string | undefined): number => {
  const m = (s ?? '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]!) : 0;
};
const MM_TO_IN = 1 / 25.4;
// One shape per datasheet — for mixed-base squads we take the most numerous models' base
// (noted in docs/combat_patrol.md). "Large Flying Base" vehicles get a hull-footprint
// approximation, the same convention the 10e ingest used for "Use model" vehicles.
function baseShape(unit: XUnit): { kind: 'circle'; radius: number } | { kind: 'oval'; rx: number; ry: number } {
  const size = unit.composition?.baseSize ?? '';
  if (/large flying base/i.test(size)) return { kind: 'oval', rx: 2.3622, ry: 1.2795 }; // ≈ Chimera hull
  const sizes = [...size.matchAll(/([\d.]+)\s*mm/g)].map((m) => parseFloat(m[1]!));
  if (sizes.length === 0) return { kind: 'circle', radius: 0.63 };
  // Mixed-base squads list two sizes; the rank-and-file's size is 28.5 on the Vigilant sheet
  // (25 is the lone Cyber-Mastiff) and the SMALLER size elsewhere (Agents: 5×25mm + 1×32mm).
  const pick = sizes.length > 1 ? (sizes.includes(28.5) ? 28.5 : Math.min(...sizes)) : sizes[0]!;
  return { kind: 'circle', radius: Math.round((pick * MM_TO_IN / 2) * 10000) / 10000 };
}

/** "Grenade Launcher - Frag" (+profileOf "Grenade Launcher") → "Grenade Launcher – frag"
 *  (the repo-wide multi-profile convention: "<base> – <profile>", collapsed at use). */
function weaponName(w: XWeapon): string {
  if (w.profileOf) {
    const suffix = w.name.replace(new RegExp(`^${w.profileOf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–]\\s*`, 'i'), '');
    return `${w.profileOf} – ${suffix}`;
  }
  return w.name;
}

function convertWeapon(w: XWeapon, type: 'ranged' | 'melee') {
  return {
    name: weaponName(w),
    type,
    ...(type === 'ranged' ? { range: parseInches(w.range) } : {}),
    attacks: String(w.A),
    skill: parsePlus(type === 'ranged' ? w.BS : w.WS),
    S: w.S,
    AP: w.AP,
    D: String(w.D),
    keywords: w.tags ?? [],
  };
}

/** Per-profile model counts from the composition bullets ("7 Grey Knight with … models"). */
function profileCounts(unit: XUnit): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of unit.composition?.bullets ?? []) {
    const m = b.match(/^(\d+)\s+(.*?)\s+models?$/i);
    if (m) out.set(m[2]!.toLowerCase(), parseInt(m[1]!, 10));
  }
  return out;
}
const unitModelCount = (unit: XUnit): number => {
  const counts = [...profileCounts(unit).values()];
  return counts.length ? counts.reduce((a, b) => a + b, 0) : 1;
};

/** Weapon-carrier counts from the equipment sentences (drives per-bearer fire plans). */
function wargearCounts(unit: XUnit): Record<string, number> {
  const counts = profileCounts(unit);
  const total = unitModelCount(unit);
  const out: Record<string, number> = {};
  const weaponNames = new Set(
    [...(unit.rangedWeapons ?? []), ...(unit.meleeWeapons ?? [])].map((w) => (w.profileOf ?? w.name).toLowerCase()),
  );
  for (const sentence of unit.composition?.equipment ?? []) {
    const m = sentence.match(/^(This model|Every model|The (.+?)|Every (.+?))\s+is equipped with:\s*(.*)$/i);
    if (!m) continue;
    const head = m[1]!.toLowerCase();
    let n = 1;
    if (head === 'every model') n = total;
    else if (head.startsWith('every ')) n = counts.get(m[3]!.toLowerCase()) ?? 1;
    else if (head.startsWith('the ')) n = counts.get(m[2]!.toLowerCase()) ?? 1;
    for (const rawItem of m[4]!.replace(/\.$/, '').split(';')) {
      const item = rawItem.trim().replace(/^\d+\s+/, '');
      // Multi-profile items are listed by their first profile ("1 Plasma Pistol - Standard") —
      // count carriers against the base weapon name.
      const base = item.replace(/\s*[-–]\s*(Standard|Supercharge|Frag|Krak)$/i, '');
      const key = weaponNames.has(base.toLowerCase()) ? base : item;
      if (!weaponNames.has(key.toLowerCase())) continue; // wargear abilities (Nuncio-Aquila, Tome Skull)
      out[key] = (out[key] ?? 0) + n;
    }
  }
  return out;
}

/** "• BROTHERHOOD TERMINATOR SQUAD: Battle round 2." lines in a patrol rule force those units
 *  into Strategic Reserves (Combat Patrol) until the stated round. */
function reserveRounds(patrol: XPatrol): { token: string; round: number }[] {
  const out: { token: string; round: number }[] = [];
  for (const r of patrol.patrolRules ?? []) {
    for (const m of (r.text ?? '').matchAll(/•\s*([A-Z][A-Z'’ ]+?):\s*Battle round (\d+)/g)) {
      out.push({ token: m[1]!.trim(), round: parseInt(m[2]!, 10) });
    }
  }
  return out;
}

const datasheets: unknown[] = [];
const patrolMeta: unknown[] = [];

for (const pid of PATROLS) {
  const patrol = JSON.parse(readFileSync(join(HERE, 'extracted', `${pid}.json`), 'utf8')) as XPatrol;
  const faction = patrol.faction.replace(/\s*\(.*\)$/, '');
  const reserves = reserveRounds(patrol);
  // Unit ids drop the patrol-name words from the front ("Vengeful Brethren Intercessor Squad"
  // → cp-vengeful_brethren-intercessor-squad).
  const patrolWords = new Set(patrol.name.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z']/g, '')));
  const shortName = (name: string): string => {
    const words = name.split(/\s+/);
    let i = 0;
    while (i < words.length - 1 && patrolWords.has(words[i]!.toLowerCase().replace(/[^a-z']/g, ''))) i++;
    return words.slice(i).join(' ');
  };
  const unitIds = new Map<string, string>();
  for (const u of patrol.units) unitIds.set(u.name, `cp-${slug(patrol.id)}-${slug(shortName(u.name))}`);

  const rosterUnits: unknown[] = [];
  for (const u of patrol.units) {
    const id = unitIds.get(u.name)!;
    const kws = [...(u.keywords ?? []), ...(u.factionKeywords ?? [])];
    const upperName = u.name.toUpperCase();
    const reserve = reserves.find(
      (r) => upperName.includes(r.token) || kws.some((k) => k.toUpperCase() === r.token),
    );
    const invuln = parsePlus(u.invuln ?? undefined);
    const leaderTargets = u.leaderAttach
      ? patrol.units
          .filter((t) => t !== u && u.leaderAttach!.toUpperCase().includes(t.name.toUpperCase()))
          .map((t) => unitIds.get(t.name)!)
      : [];
    const abilities = [
      ...(u.factionAbilities ?? []).map((name) => {
        const rule = (patrol.patrolRules ?? []).find((r) => r.name.toUpperCase() === name.toUpperCase());
        return { name, description: rule?.text ?? '', type: 'Faction' };
      }),
      ...(u.datasheetAbilities ?? []).map((a) => ({ name: a.name, description: a.text, type: 'Datasheet' })),
      ...(u.wargearAbilities ?? []).map((a) => ({ name: a.name, description: a.text, type: 'Wargear' })),
    ];
    datasheets.push({
      id,
      name: u.name,
      faction,
      role: kws.some((k) => /character/i.test(k))
        ? 'Characters'
        : kws.some((k) => /battleline/i.test(k))
          ? 'Battleline'
          : kws.some((k) => /dedicated transport/i.test(k))
            ? 'Dedicated Transports'
            : 'Other',
      loadout: (u.composition?.equipment ?? []).join(' '),
      models: u.profiles.map((p) => ({
        name: p.name,
        M: parseInches(p.M),
        T: p.T,
        Sv: parsePlus(p.SV),
        ...(invuln ? { invuln } : {}),
        W: p.W,
        Ld: parsePlus(p.LD),
        OC: p.OC,
      })),
      weapons: [
        ...(u.rangedWeapons ?? []).map((w) => convertWeapon(w, 'ranged')),
        ...(u.meleeWeapons ?? []).map((w) => convertWeapon(w, 'melee')),
      ],
      baseShape: baseShape(u),
      keywords: kws,
      abilityIds: [],
      abilities,
      composition: u.composition?.bullets ?? [],
      ...(leaderTargets.length ? { canLead: leaderTargets } : {}),
      ...(u.transport ? { transport: u.transport } : {}),
      ...(reserve ? { cpReserveRound: reserve.round } : {}),
      patrol: patrol.id,
    });
    rosterUnits.push({
      datasheetId: id,
      modelCount: unitModelCount(u),
      wargearCounts: wargearCounts(u),
    });
  }

  patrolMeta.push({
    id: patrol.id,
    name: patrol.name,
    faction,
    rules: patrol.patrolRules ?? [],
    enhancements: patrol.enhancements ?? [],
    stratagems: patrol.stratagems ?? [],
    forceDispositions: patrol.forceDispositions ?? [],
  });

  const roster = {
    name: patrol.name,
    faction,
    detachment: patrol.name,
    points: 0,
    combatPatrol: true,
    note: `Fixed Combat Patrol list (${faction}); extracted from the Warhammer app 2026-08 — see tools/combatpatrol/extracted/${pid}_flags.md`,
    units: rosterUnits,
  };
  writeFileSync(join(ROOT, 'data', 'rosters', `cp_${pid}.json`), JSON.stringify(roster, null, 1));
  console.log(`roster cp_${pid}: ${patrol.units.length} units, ${rosterUnits.reduce((a, u: any) => a + u.modelCount, 0)} models`);
}

writeFileSync(join(ROOT, 'data', 'game', 'cp_datasheets.json'), JSON.stringify(datasheets, null, 1));
writeFileSync(join(ROOT, 'data', 'game', 'cp_patrols.json'), JSON.stringify(patrolMeta, null, 1));
console.log(`cp_datasheets.json: ${datasheets.length} datasheets`);
