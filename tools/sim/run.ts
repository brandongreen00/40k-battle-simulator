// Headless AI-vs-AI simulator — the "which AI / which team is better?" harness.
//
//   pnpm sim                                          # default: 10 games, balanced vs balanced
//   pnpm sim -- --games 50 --a aggressive --b defensive
//   pnpm sim -- --rosterA "Cadian Bulwark" --rosterB "Deathwatch Vigil" --seed 1000
//   pnpm sim -- --a my-weights.json                   # tuned profile from disk (the training loop)
//   pnpm sim -- --tournament --games 6                # round-robin: every roster pair, both ways
//   pnpm sim -- --dispA priority_assets --dispB purge_the_foe   # 11e Force Dispositions
//                                                      (picks a recommended layout + tuned profiles)
//   pnpm sim -- --list                                # show available rosters / layouts / profiles
//
// A/B are SEATS in a pairing, not board sides: seats alternate the player/ai board side each game
// so neither contender owns a deployment zone. Results print as a table and are written to
// out/sim/ as JSONL (one game per line, full log included) + a summary JSON — the logs are the
// training signal: compare win rates, read the losing games, tweak weights, re-run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Roster, Side } from '../../src/core/types';
import { runMatch, type MatchResult } from '../../src/core/ai/match';
import { AI_PROFILES, profileForDisposition, type AiProfile } from '../../src/core/ai/profile';
import type { DispositionId } from '../../src/core/missions11';
import { loadLayouts, loadMatchData, loadRosters, repoRoot } from './data';

// ── tiny argv parser ──────────────────────────────────────────────────────────
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, 'true');
  }
}

const data = loadMatchData();
const rosters = loadRosters();
const layouts = loadLayouts();

if (args.has('list')) {
  console.log('Rosters:');
  for (const r of rosters) console.log(`  - ${r.name} (${r.faction} · ${r.detachment} · ${r.points} pts · ${r.units.length} units)`);
  console.log('Layouts:', layouts.length, `(default ca2025-hammer-and-anvil-1)`);
  console.log('Profiles:', Object.keys(AI_PROFILES).join(', '), '— or a path to a JSON file of AiProfile weights');
  process.exit(0);
}

function resolveProfileArg(v: string | undefined): AiProfile {
  if (!v) return AI_PROFILES.balanced!;
  if (AI_PROFILES[v]) return AI_PROFILES[v]!;
  if (v.endsWith('.json')) {
    const p = JSON.parse(readFileSync(v, 'utf-8')) as AiProfile;
    if (!p.name) p.name = v.replace(/.*\//, '').replace(/\.json$/, '');
    return p;
  }
  console.error(`Unknown profile "${v}" (known: ${Object.keys(AI_PROFILES).join(', ')}, or a .json file)`);
  process.exit(1);
}

function resolveRosterArg(v: string | undefined): Roster | undefined {
  if (!v || v === 'random') return undefined;
  const r = rosters.find((x) => x.name.toLowerCase() === v.toLowerCase());
  if (!r) {
    console.error(`Unknown roster "${v}". Available: ${rosters.map((x) => x.name).join(' | ')}`);
    process.exit(1);
  }
  return r;
}

const games = parseInt(args.get('games') ?? '10', 10);
const baseSeed = parseInt(args.get('seed') ?? `${Date.now() % 100000}`, 10);
// 11e Force Dispositions per seat. When set, the default layout becomes the pairing's Layout A
// and each seat defaults to the profile tuned for its disposition.
const dispA = (args.get('dispA') ?? args.get('dispositions')?.split(',')[0]) as DispositionId | undefined;
const dispB = (args.get('dispB') ?? args.get('dispositions')?.split(',')[1]) as DispositionId | undefined;
const dispositions = dispA && dispB ? { a: dispA, b: dispB } : undefined;
const recommended = dispositions
  ? layouts.filter((l) => {
      const d = l.pairing?.dispositions;
      return !!d && ((d[0] === dispA && d[1] === dispB) || (d[0] === dispB && d[1] === dispA));
    })
  : [];
const layoutId = args.get('layout') ?? (recommended[0]?.id ?? 'ca2025-hammer-and-anvil-1');
const layout = layouts.find((l) => l.id === layoutId) ?? recommended[0] ?? layouts[0]!;
const profileA = resolveProfileArg(args.get('a') ?? (dispA ? profileForDisposition(dispA) : undefined));
const profileB = resolveProfileArg(args.get('b') ?? (dispB ? profileForDisposition(dispB) : undefined));
const outDir = join(repoRoot, args.get('out') ?? 'out/sim');
mkdirSync(outDir, { recursive: true });

interface SeatRecord {
  label: string;
  wins: number;
  draws: number;
  losses: number;
  vpFor: number;
  vpAgainst: number;
}

function play(
  rosterA: Roster,
  rosterB: Roster,
  seed: number,
  swap: boolean,
): { result: MatchResult; seatA: Side; seatB: Side } {
  const seatA: Side = swap ? 'ai' : 'player';
  const seatB: Side = swap ? 'player' : 'ai';
  const result = runMatch(
    {
      layout,
      rosters: { [seatA]: rosterA, [seatB]: rosterB } as Record<Side, Roster>,
      profiles: { [seatA]: profileA, [seatB]: profileB } as Record<Side, AiProfile>,
      ...(dispositions
        ? { dispositions: { [seatA]: dispositions.a, [seatB]: dispositions.b } as Record<Side, DispositionId> }
        : {}),
      seed,
    },
    data,
  );
  return { result, seatA, seatB };
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const jsonlPath = join(outDir, `games-${stamp}.jsonl`);
const lines: string[] = [];
const records = new Map<string, SeatRecord>();
const rec = (label: string): SeatRecord => {
  if (!records.has(label)) records.set(label, { label, wins: 0, draws: 0, losses: 0, vpFor: 0, vpAgainst: 0 });
  return records.get(label)!;
};

function recordGame(rosterA: Roster, rosterB: Roster, game: number, seed: number): void {
  const swap = game % 2 === 1; // alternate board sides so neither seat owns a deployment zone
  const { result, seatA, seatB } = play(rosterA, rosterB, seed, swap);
  const labelA = `${rosterA.name} [${profileA.name}]`;
  const labelB = `${rosterB.name} [${profileB.name}]`;
  const vpA = result.score[seatA];
  const vpB = result.score[seatB];
  const winner = result.winner === 'draw' ? 'draw' : result.winner === seatA ? labelA : labelB;
  const a = rec(labelA);
  const b = rec(labelB);
  a.vpFor += vpA; a.vpAgainst += vpB;
  b.vpFor += vpB; b.vpAgainst += vpA;
  if (winner === 'draw') { a.draws++; b.draws++; }
  else if (winner === labelA) { a.wins++; b.losses++; }
  else { b.wins++; a.losses++; }

  const health = result.ended && result.forcedAdvances === 0 && result.rejectedLog.length === 0 ? 'ok' : 'CHECK';
  console.log(
    `#${String(game + 1).padStart(3)} seed=${seed} ${labelA} ${String(vpA).padStart(2)} : ${String(vpB).padEnd(2)} ${labelB}` +
    `  → ${winner === 'draw' ? 'draw' : winner} (${result.intentCount} intents, ${health})`,
  );
  lines.push(JSON.stringify({ ...result, game: game + 1, layout: layout.id, seatA: { label: labelA, side: seatA, vp: vpA }, seatB: { label: labelB, side: seatB, vp: vpB }, seatWinner: winner }));
}

console.log(`Layout: ${layout.id} · ${games} game(s) · base seed ${baseSeed}\n`);

if (args.has('tournament')) {
  // Round-robin: every ordered roster pair plays `games` matches (sides alternating).
  let g = 0;
  for (let i = 0; i < rosters.length; i++) {
    for (let j = i + 1; j < rosters.length; j++) {
      for (let k = 0; k < games; k++) recordGame(rosters[i]!, rosters[j]!, g, baseSeed + g++);
    }
  }
} else {
  const rosterA = resolveRosterArg(args.get('rosterA')) ?? rosters[0]!;
  const rosterB = resolveRosterArg(args.get('rosterB')) ?? rosters.find((r) => r !== rosterA) ?? rosters[0]!;
  for (let g = 0; g < games; g++) recordGame(rosterA, rosterB, g, baseSeed + g);
}

// ── league table ──────────────────────────────────────────────────────────────
const table = [...records.values()].sort(
  (a, b) => b.wins - a.wins || b.vpFor - b.vpAgainst - (a.vpFor - a.vpAgainst) || a.label.localeCompare(b.label),
);
console.log('\n═══ Results ═══');
const width = Math.max(...table.map((r) => r.label.length));
for (const r of table) {
  const played = r.wins + r.draws + r.losses;
  console.log(
    `${r.label.padEnd(width)}  ${r.wins}W ${r.draws}D ${r.losses}L` +
    `  avg VP ${(r.vpFor / Math.max(1, played)).toFixed(1)} for / ${(r.vpAgainst / Math.max(1, played)).toFixed(1)} against`,
  );
}

writeFileSync(jsonlPath, lines.join('\n') + '\n');
const summaryPath = join(outDir, `summary-${stamp}.json`);
writeFileSync(summaryPath, JSON.stringify({ layout: layout.id, games: lines.length, baseSeed, profiles: { a: profileA, b: profileB }, table }, null, 2) + '\n');
console.log(`\nWrote ${lines.length} game log(s) → ${jsonlPath}\nSummary → ${summaryPath}`);
