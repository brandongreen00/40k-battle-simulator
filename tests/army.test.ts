import { describe, it, expect } from 'vitest';
import type { Datasheet, Enhancement } from '../src/core/types';
import {
  addUnit,
  createArmyList,
  defaultModelCount,
  listPoints,
  removeUnit,
  setDetachments,
  setEnhancement,
  setModelCount,
  setWarlord,
  toRoster,
  unitCost,
  validate,
  type DataIndex,
} from '../src/core/army';

// ── fixtures ──
function ds(partial: Partial<Datasheet> & Pick<Datasheet, 'id' | 'name'>): Datasheet {
  return {
    faction: 'AM',
    models: [],
    weapons: [],
    baseShape: { kind: 'circle', radius: 0.5 },
    keywords: [],
    abilityIds: [],
    ...partial,
  };
}

const cadians = ds({
  id: 'cad',
  name: 'Cadian Shock Troops',
  keywords: ['Infantry', 'Battleline'],
  points: [{ models: 10, cost: 65 }, { models: 20, cost: 120 }],
});
const kasrkin = ds({ id: 'kas', name: 'Kasrkin', keywords: ['Infantry'], points: [{ models: 10, cost: 110 }] });
const castellan = ds({ id: 'cas', name: 'Cadian Castellan', keywords: ['Infantry', 'Character'], points: [{ models: 1, cost: 30 }] });
const straken = ds({ id: 'str', name: 'Iron Hand Straken', keywords: ['Infantry', 'Character', 'Epic Hero'], points: [{ models: 1, cost: 80 }] });

const enhA: Enhancement = { id: 'e1', name: 'Drill Commander', faction: 'AM', cost: 20, detachment: 'Combined Arms', detachmentId: 'd1', description: '' };
const enhWrongDet: Enhancement = { id: 'e2', name: 'Other', faction: 'AM', cost: 15, detachment: 'Recon Element', detachmentId: 'd2', description: '' };

const ix: DataIndex = {
  datasheets: new Map([cadians, kasrkin, castellan, straken].map((d) => [d.id, d])),
  enhancements: new Map([enhA, enhWrongDet].map((e) => [e.id, e])),
};

describe('points', () => {
  it('unitCost reads the matching model-count tier', () => {
    expect(unitCost(cadians, 10)).toBe(65);
    expect(unitCost(cadians, 20)).toBe(120);
    expect(unitCost(cadians, 15)).toBe(0); // no such tier
  });

  it('listPoints sums unit tiers plus enhancement costs', () => {
    let list = createArmyList('AM', 'Combined Arms');
    list = addUnit(list, cadians); // 65
    list = addUnit(list, kasrkin); // 110
    list = addUnit(list, castellan); // 30
    const charUid = list.units[2]!.uid;
    list = setEnhancement(list, charUid, 'e1'); // +20
    expect(listPoints(list, ix)).toBe(225);
  });

  it('11e escalating copies: later copies read their copyFrom/copyTo tier', () => {
    // The real Hellhound shape: 1st–2nd copies 125, 3rd+ 135.
    const hellhound = ds({
      id: 'hh',
      name: 'Hellhound',
      keywords: ['Vehicle'],
      points: [
        { models: 1, cost: 125, copyFrom: 1, copyTo: 2 },
        { models: 1, cost: 135, copyFrom: 3 },
      ],
    });
    expect(unitCost(hellhound, 1)).toBe(125); // default = 1st copy
    expect(unitCost(hellhound, 1, 2)).toBe(125);
    expect(unitCost(hellhound, 1, 3)).toBe(135);
    expect(unitCost(hellhound, 1, 5)).toBe(135); // open-ended range

    const hhIx: DataIndex = { datasheets: new Map([[hellhound.id, hellhound]]), enhancements: new Map() };
    let list = createArmyList('AM', 'Hammer of the Emperor');
    list = addUnit(list, hellhound);
    list = addUnit(list, hellhound);
    expect(listPoints(list, hhIx)).toBe(250); // 125 + 125
    list = addUnit(list, hellhound);
    expect(listPoints(list, hhIx)).toBe(385); // 125 + 125 + 135
  });

  it('11e priced wargear: wargearCosts items add points per bearer, everything else stays free', () => {
    // The real Leman Russ Commander shape: per Demolisher battle cannon 15 pts.
    const lrc = ds({
      id: 'lrc',
      name: 'Leman Russ Commander',
      keywords: ['Vehicle', 'Character'],
      points: [{ models: 1, cost: 215 }],
      wargearCosts: [{ item: 'Demolisher battle cannon', cost: 15 }],
    });
    const lrcIx: DataIndex = { datasheets: new Map([[lrc.id, lrc]]), enhancements: new Map() };
    let list = addUnit(createArmyList('AM', 'Hammer of the Emperor'), lrc);
    expect(listPoints(list, lrcIx)).toBe(215);
    list = { ...list, units: [{ ...list.units[0]!, loadout: { 'Demolisher battle cannon': 1, 'Hunter-killer missile': 1 } }] };
    expect(listPoints(list, lrcIx)).toBe(230); // +15 for the cannon; the missile stays free
  });
});

describe('list edits', () => {
  it('addUnit uses the default (smallest) tier; setModelCount changes it', () => {
    let list = addUnit(createArmyList('AM', 'Combined Arms'), cadians);
    expect(list.units[0]!.modelCount).toBe(defaultModelCount(cadians));
    expect(listPoints(list, ix)).toBe(65);
    list = setModelCount(list, list.units[0]!.uid, 20);
    expect(listPoints(list, ix)).toBe(120);
  });

  it('removeUnit drops the unit and detaches leaders pointed at it', () => {
    let list = addUnit(addUnit(createArmyList('AM', 'Combined Arms'), cadians), castellan);
    const bodyguardUid = list.units[0]!.uid;
    const leaderUid = list.units[1]!.uid;
    list = { ...list, units: list.units.map((u) => (u.uid === leaderUid ? { ...u, attachedTo: bodyguardUid } : u)) };
    list = removeUnit(list, bodyguardUid);
    expect(list.units).toHaveLength(1);
    expect(list.units[0]!.attachedTo).toBeUndefined();
  });

  it('setWarlord makes exactly one unit the warlord', () => {
    let list = addUnit(addUnit(createArmyList('AM', 'Combined Arms'), castellan), straken);
    list = setWarlord(list, list.units[0]!.uid);
    list = setWarlord(list, list.units[1]!.uid);
    expect(list.units.filter((u) => u.warlord)).toHaveLength(1);
    expect(list.units[1]!.warlord).toBe(true);
  });
});

describe('validation', () => {
  it('flags going over the points limit', () => {
    let list = createArmyList('AM', 'Combined Arms', 'Incursion');
    for (let i = 0; i < 3; i++) list = addUnit(list, cadians); // legal count, 195pts
    expect(validate(list, ix).some((x) => x.message.startsWith('Over points'))).toBe(false);
    list = { ...list, battleSize: 'Combat Patrol' }; // 500 cap is fine too
    // force over by switching to a tiny cap via many units
    for (let i = 0; i < 10; i++) list = addUnit(list, cadians);
    expect(validate(list, ix).some((x) => x.severity === 'error' && x.message.startsWith('Over points'))).toBe(true);
  });

  it('enhancement must go on a non-Epic-Hero Character from the right detachment', () => {
    let list = createArmyList('AM', 'Combined Arms', 'Incursion');
    list = addUnit(list, kasrkin); // not a character
    list = setEnhancement(list, list.units[0]!.uid, 'e1');
    expect(validate(list, ix).some((x) => /not a Character/.test(x.message))).toBe(true);

    let list2 = addUnit(createArmyList('AM', 'Combined Arms', 'Incursion'), straken); // epic hero
    list2 = setEnhancement(list2, list2.units[0]!.uid, 'e1');
    expect(validate(list2, ix).some((x) => /Epic Hero/.test(x.message))).toBe(true);

    let list3 = addUnit(createArmyList('AM', 'Combined Arms', 'Incursion'), castellan);
    list3 = setEnhancement(list3, list3.units[0]!.uid, 'e2'); // wrong detachment
    expect(validate(list3, ix).some((x) => /not Combined Arms/.test(x.message))).toBe(true);
  });

  it('enforces datasheet copy limits (battleline vs other) and epic-hero uniqueness', () => {
    let list = createArmyList('AM', 'Combined Arms', 'Incursion');
    for (let i = 0; i < 3; i++) list = addUnit(list, kasrkin); // "other": max 2 at Incursion
    expect(validate(list, ix).some((x) => /exceeds the limit of 2/.test(x.message))).toBe(true);

    let list2 = createArmyList('AM', 'Combined Arms', 'Incursion');
    for (let i = 0; i < 3; i++) list2 = addUnit(list2, cadians); // battleline: max 3 — ok
    expect(validate(list2, ix).some((x) => /exceeds the limit/.test(x.message))).toBe(false);

    let list3 = addUnit(addUnit(createArmyList('AM', 'Combined Arms', 'Incursion'), straken), straken);
    expect(validate(list3, ix).some((x) => /Epic Hero — only 1/.test(x.message))).toBe(true);
  });

  it('warns when no warlord and errors on multiple', () => {
    let list = addUnit(createArmyList('AM', 'Combined Arms', 'Incursion'), castellan);
    expect(validate(list, ix).some((x) => x.severity === 'warning' && /Warlord/.test(x.message))).toBe(true);
    list = setWarlord(list, list.units[0]!.uid);
    expect(validate(list, ix).some((x) => /Warlord/.test(x.message))).toBe(false);
  });
});

describe('setDetachments (multi-detachment picker)', () => {
  it('joins components canonically and prunes only stranded enhancements', () => {
    let list = createArmyList('AM', 'Combined Arms', 'Strike Force');
    list = addUnit(list, castellan);
    list = setEnhancement(list, list.units[0]!.uid, 'e1'); // a Combined Arms enhancement
    // Adding a second detachment keeps the pick — its detachment is still in the army.
    list = setDetachments(list, ['Combined Arms', 'Bridgehead Strike'], ix);
    expect(list.detachment).toBe('Combined Arms and Bridgehead Strike');
    expect(list.units[0]!.enhancementId).toBe('e1');
    // Dropping Combined Arms strands the pick — cleared; a pick from the surviving
    // detachment would have stayed (e2 is Recon Element — stranded immediately).
    list = setEnhancement(list, list.units[0]!.uid, 'e2');
    list = setDetachments(list, ['Combined Arms', 'Bridgehead Strike'], ix);
    expect(list.units[0]!.enhancementId).toBeUndefined();
    list = setEnhancement(list, list.units[0]!.uid, 'e1');
    list = setDetachments(list, ['Bridgehead Strike'], ix);
    expect(list.detachment).toBe('Bridgehead Strike');
    expect(list.units[0]!.enhancementId).toBeUndefined();
    // Empty selection → no detachment (validate then flags the list).
    expect(setDetachments(list, [], ix).detachment).toBe('');
  });
});

describe('toRoster', () => {
  it('maps an army list to the Roster shape with computed points', () => {
    let list = createArmyList('AM', 'Combined Arms');
    list = addUnit(list, cadians); // 65
    list = addUnit(list, castellan); // 30
    list = setEnhancement(list, list.units[1]!.uid, 'e1'); // +20
    // total = 115
    const roster = toRoster(list, ix);
    expect(roster.faction).toBe('AM');
    expect(roster.detachment).toBe('Combined Arms');
    expect(roster.points).toBe(115);
    expect(roster.units[1]!.enhancementId).toBe('e1');
  });
});
