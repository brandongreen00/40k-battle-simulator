import { describe, it, expect } from 'vitest';
import type { Datasheet } from '../src/core/types';
import {
  maxModelsForOption,
  unitWargearOptions,
  wargearOptionGroups,
  groupFits,
  validateUnitLoadout,
  defaultLoadoutCounts,
  defensiveProfileForItem,
  defensiveItemsInText,
} from '../src/core/wargear';
import datasheetsJson from '../data/game/datasheets.json';

function ds(partial: Partial<Datasheet> & Pick<Datasheet, 'id' | 'name'>): Datasheet {
  return {
    faction: 'AoI',
    models: [],
    weapons: [],
    baseShape: { kind: 'circle', radius: 0.5 },
    keywords: [],
    abilityIds: [],
    ...partial,
  };
}

describe('maxModelsForOption — the "N per M models" ratio', () => {
  it('thunder hammers: up to 2 per 5 models → 4 in a 10-model unit (the headline example)', () => {
    const text =
      'For every 5 models in this unit, up to 2 models can each have their boltgun and power weapon replaced with 1 Deathwatch thunder hammer.';
    expect(maxModelsForOption(text, 10)).toBe(4);
    expect(maxModelsForOption(text, 5)).toBe(2);
    expect(maxModelsForOption(text, 9)).toBe(2); // floor(9/5)=1 → 2
  });

  it('1 per 5 models', () => {
    const text =
      'For every 5 models in this unit, 1 model can have their boltgun and power weapon replaced with 1 stalker-pattern boltgun and 1 close combat weapon.';
    expect(maxModelsForOption(text, 10)).toBe(2);
    expect(maxModelsForOption(text, 5)).toBe(1);
  });

  it('"One model" / "The Sergeant" → 1', () => {
    expect(maxModelsForOption("One model's boltgun and power weapon can be replaced with 1 Black Shield blades.", 10)).toBe(1);
    expect(maxModelsForOption("The Watch Sergeant's power weapon can be replaced with 1 xenophase blade.", 10)).toBe(1);
  });

  it('"1 Navis Armsman ... can be replaced with one of the following" → 1', () => {
    expect(maxModelsForOption('1 Navis Armsman’s Navis las-volley can be replaced with one of the following:', 10)).toBe(1);
  });

  it('"Up to one Recon Trooper" → 1; "Any number of models" → all', () => {
    expect(maxModelsForOption('Up to one Recon Trooper can replace their lasgun with 1 autosaw.', 10)).toBe(1);
    expect(maxModelsForOption('Any number of models can each have their multi-laser replaced with 1 lascannon.', 6)).toBe(6);
  });
});

describe('unitWargearOptions + validation', () => {
  const deathwatch = ds({
    id: 'dw',
    name: 'Deathwatch Kill Team',
    weapons: [
      { name: 'Boltgun', type: 'ranged', attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [] },
      { name: 'Power weapon', type: 'melee', attacks: '3', skill: 3, S: 5, AP: -2, D: '1', keywords: [] },
      { name: 'Deathwatch thunder hammer', type: 'melee', attacks: '3', skill: 4, S: 8, AP: -2, D: '2', keywords: [] },
    ],
    wargearOptions: [
      {
        text: 'For every 5 models in this unit, up to 2 models can each have their boltgun and power weapon replaced with one of the following:',
        choices: ['1 boltgun and 1 Astartes shield', '1 power weapon and 1 Astartes shield'],
      },
      {
        text: 'For every 5 models in this unit, up to 2 models can each have their boltgun and power weapon replaced with 1 Deathwatch thunder hammer.',
        choices: [],
      },
    ],
  });

  it('resolves caps and pulls the signature item from choices', () => {
    const opts = unitWargearOptions(deathwatch, 10);
    expect(opts).toHaveLength(2);
    // Both shield variants collapse to the one trackable item, sharing the cap of 4.
    expect(opts[0]!.choices.map((c) => c.item)).toEqual(['Astartes shield']);
    expect(opts[0]!.max).toBe(4);
    expect(opts[1]!.choices[0]!.item).toBe('Deathwatch thunder hammer');
    expect(opts[1]!.max).toBe(4);
  });

  it('flags an over-cap loadout', () => {
    const ok = validateUnitLoadout(deathwatch, 10, { 'Deathwatch thunder hammer': 4 });
    expect(ok).toHaveLength(0);
    const bad = validateUnitLoadout(deathwatch, 10, { 'Deathwatch thunder hammer': 5 });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.message).toContain('only 4 may');
    // At 5 models the cap halves to 2.
    expect(validateUnitLoadout(deathwatch, 5, { 'Deathwatch thunder hammer': 4 })).toHaveLength(1);
  });
});

describe('overlapping options share their caps across the group (Sisters of Battle Squad)', () => {
  // The datasheet lists the Battle Sister boltgun swap TWICE with overlapping choice lists —
  // one Sister may take from the short list AND another from the long list, so e.g.
  // meltagun + heavy bolter (or two meltaguns) is legal, but two heavy bolters is not.
  const sisters = ds({
    id: 'sob',
    name: 'Sisters of Battle Squad',
    weapons: [
      { name: 'Artificer-crafted storm bolter', type: 'ranged', range: 24, attacks: '2', skill: 3, S: 4, AP: 0, D: '1', keywords: [] },
      { name: 'Heavy bolter', type: 'ranged', range: 36, attacks: '3', skill: 4, S: 5, AP: -1, D: '2', keywords: [] },
      { name: 'Meltagun', type: 'ranged', range: 12, attacks: '1', skill: 3, S: 9, AP: -4, D: 'D6', keywords: [] },
      { name: 'Ministorum flamer', type: 'ranged', range: 12, attacks: 'D6', skill: 0, S: 4, AP: 0, D: '1', keywords: [] },
      { name: 'Ministorum heavy flamer', type: 'ranged', range: 12, attacks: 'D6', skill: 0, S: 5, AP: -1, D: '1', keywords: [] },
      { name: 'Multi-melta', type: 'ranged', range: 18, attacks: '2', skill: 4, S: 9, AP: -4, D: 'D6', keywords: [] },
    ],
    wargearOptions: [
      {
        text: '1 Battle Sister’s boltgun can be replaced with one of the following:',
        choices: ['1 artificer-crafted storm bolter', '1 meltagun', '1 Ministorum flamer'],
      },
      {
        text: '1 Battle Sister’s boltgun can be replaced with one of the following:',
        choices: [
          '1 artificer-crafted storm bolter',
          '1 heavy bolter',
          '1 meltagun',
          '1 Ministorum flamer',
          '1 Ministorum heavy flamer',
          '1 multi-melta',
        ],
      },
    ],
  });

  it('groups the two swaps into one pool of 2 with the union of items', () => {
    const groups = wargearOptionGroups(sisters, 10);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.options).toHaveLength(2);
    expect(groups[0]!.max).toBe(2);
    expect(groups[0]!.choices.map((c) => c.item)).toContain('Heavy bolter');
    expect(groups[0]!.choices.map((c) => c.item)).toContain('Meltagun');
  });

  it('meltagun + heavy bolter is legal (one swap from each option)', () => {
    expect(validateUnitLoadout(sisters, 10, { Meltagun: 1, 'Heavy bolter': 1 })).toHaveLength(0);
  });

  it('two meltaguns are legal (the item appears in both options)', () => {
    expect(validateUnitLoadout(sisters, 10, { Meltagun: 2 })).toHaveLength(0);
  });

  it('two heavy bolters are flagged — only the second option grants one', () => {
    const v = validateUnitLoadout(sisters, 10, { 'Heavy bolter': 2 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('Heavy bolter');
    expect(v[0]!.message).toContain('only 1 may');
  });

  it('heavy bolter + multi-melta is flagged — both live only in the 1-model second option', () => {
    const v = validateUnitLoadout(sisters, 10, { 'Heavy bolter': 1, 'Multi-melta': 1 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('only 1 may');
  });

  it('three specials total are flagged against the pooled cap of 2', () => {
    const v = validateUnitLoadout(sisters, 10, { Meltagun: 2, 'Heavy bolter': 1 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('only 2 may');
  });

  it('groupFits gates the UI steppers the same way', () => {
    const group = wargearOptionGroups(sisters, 10)[0]!;
    expect(groupFits(group, { Meltagun: 1, 'Heavy bolter': 1 })).toBe(true);
    expect(groupFits(group, { Meltagun: 2 })).toBe(true);
    expect(groupFits(group, { 'Heavy bolter': 2 })).toBe(false);
    expect(groupFits(group, { Meltagun: 2, 'Ministorum flamer': 1 })).toBe(false);
  });

  it('the REAL Sisters of Battle Squad datasheet accepts the app-legal loadout', () => {
    const real = (datasheetsJson as unknown as Datasheet[]).find((d) => d.name === 'Sisters of Battle Squad');
    expect(real).toBeDefined();
    const pool = wargearOptionGroups(real!, 10).find((g) => g.options.length === 2);
    expect(pool).toBeDefined();
    const item = (name: string) => pool!.choices.find((c) => c.item.toLowerCase() === name)!.item;
    // Legal in the official app: one Sister with a meltagun, another with a heavy bolter.
    expect(validateUnitLoadout(real!, 10, { [item('meltagun')]: 1, [item('heavy bolter')]: 1 })).toHaveLength(0);
    // Still illegal: two heavy bolters.
    expect(validateUnitLoadout(real!, 10, { [item('heavy bolter')]: 2 })).toHaveLength(1);
  });
});

describe('default wargear credits the option caps (HOLD OBJECTIVES import false positives)', () => {
  // The GW app's export lists a unit's FULL equipment, default wargear included — the caps must
  // only be charged for picks beyond the default bearers. Both cases below are app-legal lists
  // that used to be flagged ("5 models take Ministorum hand flamer but only 1 may").
  const real = (name: string) => {
    const d = (datasheetsJson as unknown as Datasheet[]).find((x) => x.name === name);
    expect(d, name).toBeDefined();
    return d!;
  };

  it('parses default bearers from the loadout text, resolving "Every <Type>" via composition', () => {
    const sanctifiers = real('Sanctifiers');
    const defaults = defaultLoadoutCounts(sanctifiers, 9);
    expect(defaults['Ministorum hand flamer']).toBe(4); // "Every Sanctifier" → 4 per composition
    expect(defaults['Sanctifier melee weapon']).toBe(6); // 2 Missionaries + 4 Sanctifiers
    expect(defaults['plasma gun']).toBe(1); // "1 Missionary is equipped with"
    expect(defaults['holy fire']).toBe(1); // "The Miraculist"
    const subductors = real('Subductor Squad');
    // "Every Proctor-Subductor and Subductor" sums the two composition entries.
    expect(defaultLoadoutCounts(subductors, 11)['Arbites shotpistol']).toBe(10);
  });

  it('Sanctifiers: 5 hand flamers = 4 default + 1 legal swap — no violation; a 6th is flagged', () => {
    const sanctifiers = real('Sanctifiers');
    // The exact loadout of the owner's app export (defaults included).
    const appLoadout = {
      'Burning hands': 1, 'Holy fire': 2, 'Close combat weapon': 3, 'Salvationist Medikit': 1,
      'Death Cult blades': 1, 'Ministorum flamer': 1, 'Plasma gun': 1, 'Sanctifier melee weapon': 4,
      'Ministorum hand flamer': 5, 'Simulacrum Imperialis': 1,
    };
    expect(validateUnitLoadout(sanctifiers, 9, appLoadout)).toHaveLength(0);
    // Only ONE Sanctifier may swap for an extra hand flamer — a 6th total is over.
    const v = validateUnitLoadout(sanctifiers, 9, { ...appLoadout, 'Ministorum hand flamer': 6 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('beyond the default wargear');
  });

  it('Inquisitorial Chimera: hull + turret heavy flamers pool to 2 (the * footnote strips); 3 are flagged', () => {
    const chimera = real('Inquisitorial Chimera');
    // Two separate options grant a heavy flamer — replacing the heavy bolter (hull) and the
    // multi-laser (turret, printed "1 Heavy flamer*"). They must land in ONE pooled group.
    const flamerGroups = wargearOptionGroups(chimera, 1).filter((g) =>
      g.choices.some((c) => c.item.toLowerCase() === 'heavy flamer'),
    );
    expect(flamerGroups).toHaveLength(1);
    expect(flamerGroups[0]!.options.length).toBeGreaterThanOrEqual(2);
    // The owner's app export: both swaps taken.
    const appLoadout = {
      'Armoured tracks': 1, 'Heavy flamer': 2, 'Heavy stubber': 1,
      'Hunter-killer missile': 1, 'Lasgun array': 1,
    };
    expect(validateUnitLoadout(chimera, 1, appLoadout)).toHaveLength(0);
    expect(validateUnitLoadout(chimera, 1, { ...appLoadout, 'Heavy flamer': 3 })).toHaveLength(1);
    // Keeping the default hull heavy bolter while taking the turret one is also legal (1 default
    // + 1 from the multi-laser swap) — but a third heavy bolter has no option to grant it.
    expect(validateUnitLoadout(chimera, 1, { 'Heavy bolter': 2 })).toHaveLength(0);
    expect(validateUnitLoadout(chimera, 1, { 'Heavy bolter': 3 })).toHaveLength(1);
  });

  it('groupFits credits defaults the same way (UI steppers)', () => {
    const sanctifiers = real('Sanctifiers');
    const defaults = defaultLoadoutCounts(sanctifiers, 9);
    const group = wargearOptionGroups(sanctifiers, 9).find((g) =>
      g.choices.some((c) => c.item.toLowerCase() === 'ministorum hand flamer'),
    )!;
    expect(groupFits(group, { 'Ministorum hand flamer': 5 }, defaults)).toBe(true);
    expect(groupFits(group, { 'Ministorum hand flamer': 6 }, defaults)).toBe(false);
    // Without the credit the old false positive comes back — pinning the mechanism.
    expect(groupFits(group, { 'Ministorum hand flamer': 5 })).toBe(false);
  });
});

describe('defensive wargear', () => {
  it('recognises shields as 4++ invuln', () => {
    expect(defensiveProfileForItem('Astartes shield')).toEqual({ invuln: 4 });
    expect(defensiveProfileForItem('Endurant Shield')).toEqual({ invuln: 4 });
    expect(defensiveProfileForItem('Meltagun')).toBeUndefined();
  });
  it('finds shields in default-loadout prose', () => {
    const text = 'One other Navis Armsman is equipped with: Navis heavy shotgun; close combat weapon; endurant shield.';
    expect(defensiveItemsInText(text)).toContain('Endurant Shield');
  });
});
