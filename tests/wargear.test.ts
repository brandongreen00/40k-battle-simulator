import { describe, it, expect } from 'vitest';
import type { Datasheet } from '../src/core/types';
import {
  maxModelsForOption,
  unitWargearOptions,
  validateUnitLoadout,
  defensiveProfileForItem,
  defensiveItemsInText,
} from '../src/core/wargear';

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
