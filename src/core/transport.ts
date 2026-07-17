// Transports (11e, 18) — capacity parsing, embark/disembark legality queries, Firing Deck X
// (24.14), and the Aircraft basics (23). PURE — no React, no DOM, no I/O.
//
// An embarked unit is modelled as `inReserves: true` + `embarkedIn: <transport unit id>` so every
// existing "on the battlefield" filter treats it correctly; the two flags together distinguish it
// from a Strategic Reserves unit (which is destroyed if it never arrives, contributes to reserve
// caps, etc.).

import type { Datasheet, GameState, UnitInstance } from './types';
import type { EngineContext } from './engine';

// ── capacity parsing ──────────────────────────────────────────────────────────
export interface TransportCapacity {
  /** Model slots. */
  capacity: number;
  /** Alternative keyword requirements — a model may embark if ONE alternative's keywords are all
   *  present (e.g. [["astra militarum","infantry"], ["astra militarum","infantry","character"]]). */
  allowed: string[][];
  /** Model descriptors that cannot embark at all (e.g. "artillery"). */
  excluded: string[];
  /** Models that consume extra space ("Each Ogryn model takes up the space of 3 models"). */
  bulky: { match: string; space: number }[];
}

/**
 * Parse a datasheet's transport-capacity rules text, e.g.
 * "This model has a transport capacity of 12 Astra Militarum Infantry models. Each Ogryn model
 *  takes up the space of 3 models. It cannot transport Artillery models."
 */
export function parseTransportCapacity(text?: string): TransportCapacity | null {
  if (!text) return null;
  const m = /transport capacity of (\d+)\s+(.+?)\s+models?/i.exec(text);
  if (!m) return null;
  const capacity = parseInt(m[1]!, 10);
  const allowed = m[2]!
    .split(/\s+or\s+/i)
    .map((phrase) => phrase.trim().toLowerCase())
    .filter(Boolean)
    .map((phrase) => phrase.split(/\s+/));
  const bulky: { match: string; space: number }[] = [];
  const bulkyRe = /Each (.+?) takes up the space of (\d+)/gi;
  for (let b = bulkyRe.exec(text); b; b = bulkyRe.exec(text)) {
    const space = parseInt(b[2]!, 10);
    for (const subject of b[1]!.split(/\s+model(?:s)?\s+and\s+/i)) {
      bulky.push({ match: subject.replace(/\s+models?$/i, '').trim().toLowerCase(), space });
    }
  }
  const excluded: string[] = [];
  const ex = /cannot transport (.+?) models/i.exec(text);
  if (ex) {
    // "cannot transport TERMINATOR or OFFICIO ASSASSINORUM models" — each alternative excludes.
    for (const alt of ex[1]!.split(/\s+or\s+/i)) {
      const t = alt.trim().toLowerCase();
      if (t) excluded.push(t);
    }
  }
  return { capacity, allowed, excluded, bulky };
}

/** The transport capacity of a datasheet (null when it is not a transport). */
export function transportCapacity(ds: Datasheet | undefined): TransportCapacity | null {
  return parseTransportCapacity(ds?.transport);
}

/** Firing Deck X (24.14) — 0 when the datasheet has no Firing Deck ability. */
export function firingDeckX(ds: Datasheet | undefined): number {
  const a = ds?.abilities?.find((x) => /firing deck/i.test(x.name));
  const n = a?.parameter ? parseInt(a.parameter, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export const isAircraft = (ds: Datasheet | undefined): boolean =>
  !!ds?.keywords.some((k) => k.toLowerCase() === 'aircraft');

export const canFly = (ds: Datasheet | undefined): boolean =>
  !!ds?.keywords.some((k) => k.toLowerCase() === 'fly');

// ── keyword matching ──────────────────────────────────────────────────────────
/**
 * Does a keyword phrase (token list, lowercased) match a datasheet's keywords? The phrase must be
 * coverable by a sequence of the datasheet's keywords — e.g. tokens ["astra","militarum","infantry"]
 * are covered by keywords "Astra Militarum" + "Infantry".
 */
function phraseMatches(tokens: string[], keywords: Set<string>): boolean {
  if (tokens.length === 0) return true;
  for (let take = tokens.length; take >= 1; take--) {
    const head = tokens.slice(0, take).join(' ');
    if (keywords.has(head) && phraseMatches(tokens.slice(take), keywords)) return true;
  }
  return false;
}

const keywordSet = (ds: Datasheet): Set<string> =>
  new Set([...ds.keywords.map((k) => k.toLowerCase()), ds.name.toLowerCase()]);

/** May models of this datasheet embark at all under the capacity's keyword rules? */
export function datasheetMayRide(ds: Datasheet, cap: TransportCapacity): boolean {
  const kws = keywordSet(ds);
  if (cap.excluded.some((e) => phraseMatches(e.split(/\s+/), kws))) return false;
  return cap.allowed.some((alt) => phraseMatches(alt, kws));
}

/** Space one model of this datasheet consumes. */
function modelSpace(ds: Datasheet, cap: TransportCapacity): number {
  const kws = keywordSet(ds);
  for (const b of cap.bulky) if (kws.has(b.match)) return b.space;
  return 1;
}

// ── unit-level queries ────────────────────────────────────────────────────────
/** Units currently embarked within `transportId`. */
export function embarkedUnits(state: GameState, transportId: string): UnitInstance[] {
  return state.units.filter((u) => u.embarkedIn === transportId && u.models.some((m) => m.alive));
}

/** Total capacity space `unit`'s alive models take up (Infinity if a model may not ride). */
export function unitSpace(unit: UnitInstance, ctx: EngineContext, cap: TransportCapacity): number {
  let space = 0;
  for (const m of unit.models) {
    if (!m.alive) continue;
    const ds = ctx.datasheets.get(m.datasheetId ?? unit.datasheetId);
    if (!ds || !datasheetMayRide(ds, cap)) return Infinity;
    space += modelSpace(ds, cap);
  }
  return space;
}

/** Capacity space still free in `transport`. */
export function remainingCapacity(state: GameState, transport: UnitInstance, ctx: EngineContext): number {
  const cap = transportCapacity(ctx.datasheets.get(transport.datasheetId));
  if (!cap) return 0;
  let used = 0;
  for (const u of embarkedUnits(state, transport.id)) {
    const s = unitSpace(u, ctx, cap);
    used += Number.isFinite(s) ? s : 0;
  }
  return cap.capacity - used;
}

/** Capacity + keyword legality for `unit` embarking within `transport` (distance not checked —
 *  the reducer checks 3" for in-battle embarks; deployment embarks skip it). */
export function canEmbark(
  state: GameState,
  unit: UnitInstance,
  transport: UnitInstance,
  ctx: EngineContext,
): { ok: boolean; reason?: string } {
  if (transport.owner !== unit.owner) return { ok: false, reason: 'not a friendly transport' };
  if (!transport.models.some((m) => m.alive)) return { ok: false, reason: 'transport destroyed' };
  const tDs = ctx.datasheets.get(transport.datasheetId);
  const cap = transportCapacity(tDs);
  if (!cap) return { ok: false, reason: 'not a transport' };
  const space = unitSpace(unit, ctx, cap);
  if (!Number.isFinite(space)) return { ok: false, reason: 'unit may not ride this transport' };
  if (space > remainingCapacity(state, transport, ctx)) {
    return { ok: false, reason: 'insufficient transport capacity' };
  }
  return { ok: true };
}

/** Friendly transports `unit` could legally embark within (capacity + keywords only). */
export function embarkOptions(state: GameState, unit: UnitInstance, ctx: EngineContext): UnitInstance[] {
  return state.units.filter(
    (t) =>
      t.id !== unit.id &&
      !t.inReserves &&
      t.owner === unit.owner &&
      canEmbark(state, unit, t, ctx).ok,
  );
}

// ── deployment split (Sisters of Battle Immolator) ────────────────────────────
/**
 * Some transports carry a Declare Battle Formations split rule in their transport text, e.g. the
 * Sisters of Battle Immolator: "you can select one SISTERS OF BATTLE SQUAD from your army. If you
 * do, that unit is split into two units, each containing as equal a number of models as possible
 * ... One of these units must start the battle embarked within this TRANSPORT; the other can start
 * the battle embarked within another TRANSPORT, or it can be deployed as a separate unit."
 */
export interface TransportSplitRule {
  /** Lowercased tokens of the selectable unit phrase (e.g. ["sisters","of","battle","squad"]). */
  selectTokens: string[];
}

/** Parse a transport datasheet's split clause (null when it has none). */
export function transportSplitRule(ds: Datasheet | undefined): TransportSplitRule | null {
  const text = ds?.transport;
  if (!text || !/split into two units/i.test(text)) return null;
  const m = /select one (.+?) from your army/i.exec(text);
  if (!m) return null;
  const tokens = m[1]!.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length ? { selectTokens: tokens } : null;
}

/** May this transport's split rule select a unit of `unitDs`? (Matched on keywords + name.) */
export function splitRuleSelects(rule: TransportSplitRule, unitDs: Datasheet): boolean {
  return phraseMatches(rule.selectTokens, keywordSet(unitDs));
}

/** The legal "as equal as possible" riding-group sizes for a unit of `total` models. */
export function splitRideCounts(total: number): number[] {
  if (total < 2) return [];
  const lo = Math.floor(total / 2);
  const hi = Math.ceil(total / 2);
  return lo === hi ? [lo] : [hi, lo];
}

// ── disembark modes (18.04) ───────────────────────────────────────────────────
export type DisembarkMode = 'rapid' | 'tactical' | 'combat';

/**
 * The disembark mode available right now, by the 11e mandatory priority. Returns null when the
 * unit may not disembark at all (transport advanced/fell back this phase, or the unit embarked
 * this turn). 'tactical_or_combat' means the anchor decides: a placement satisfying the tactical
 * constraints (3", unengaged) is a Tactical Disembark, otherwise Combat (6", hazard, shocked).
 */
export function disembarkMode(
  unit: UnitInstance,
  transport: UnitInstance,
): DisembarkMode | 'tactical_or_combat' | null {
  if (unit.status.justEmbarked) return null;
  const t = transport.status;
  if (t.advanced || t.fellBack) return null;
  // `moved` covers both a normal move and an ingress arrival (ArriveFromReserves sets it).
  if (t.moved) return 'rapid';
  return 'tactical_or_combat';
}
