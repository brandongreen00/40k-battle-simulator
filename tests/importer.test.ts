import { describe, it, expect } from 'vitest';
import type { Datasheet, Enhancement } from '../src/core/types';
import { parseArmyText, type ImportDeps } from '../src/core/importer';
import datasheetsJson from '../data/game/datasheets.json';
import enhancementsJson from '../data/game/enhancements.json';

const deps: ImportDeps = {
  datasheets: datasheetsJson as unknown as Datasheet[],
  enhancements: enhancementsJson as unknown as Enhancement[],
};

// The exact export from the task description.
const SAMPLE = `Rogue Trader's Army (985 Points)

Imperial Agents
Imperialis Fleet
Incursion (1,000 Points)

CHARACTERS

Callidus Assassin (100 Points)
  • 1x Neural shredder
  • 1x Phase sword and poison blades

Eversor Assassin (110 Points)
  • 1x Executioner pistol
  • 1x Power sword and neuro gauntlet

Inquisitor Draxus (75 Points)
  • 1x Dirgesinger
  • 1x Power fist
  • 1x Psychic Tempest

Rogue Trader Entourage (90 Points)
  • 1x Rogue Trader
     • Warlord
     ◦ 1x Household pistol
     ◦ 1x Monomolecular cane-rapier
     ◦ Enhancements: Clandestine Operation
  • 1x Death Cult Assassin
     ◦ 1x Dartmask
     ◦ 1x Death Cult power blade
  • 1x Lectro-Maester
     ◦ 1x Close combat weapon
     ◦ 1x Voltaic pistol
  • 1x Rejuvenat Adept
     ◦ 1x Close combat weapon
     ◦ 1x Healing serum
     ◦ 1x Laspistol

Watch Captain Artemis (65 Points)
  • 1x Hellfire Extremis
  • 1x Master-crafted power weapon

BATTLELINE

Deathwatch Kill Team (190 Points)
  • 1x Watch Sergeant
     ◦ 1x Combi-weapon
     ◦ 1x Xenophase blade
  • 9x Deathwatch Veterans
     ◦ 2x Astartes shield
     ◦ 3x Close combat weapon
     ◦ 4x Deathwatch thunder hammer
     ◦ 1x Frag cannon
     ◦ 1x Infernus heavy bolter
     ◦ 2x Power weapon
     ◦ 1x Stalker-pattern boltgun

Imperial Navy Breachers (90 Points)
  • 1x Navis Sergeant-at-Arms
     ◦ 1x Close combat weapon
     ◦ 1x Navis shotgun
  • 9x Navis Armsman
     ◦ 9x Close combat weapon
     ◦ 1x Demolition charge
     ◦ 1x Endurant Shield
     ◦ 1x Meltagun
     ◦ 1x Navis heavy shotgun
     ◦ 7x Navis shotgun

Imperial Navy Breachers (90 Points)
  • 1x Navis Sergeant-at-Arms
     ◦ 1x Bolt pistol
     ◦ 1x Close combat weapon
     ◦ 1x Power weapon
  • 9x Navis Armsman
     ◦ 2x Autopistol
     ◦ 1x Chainfist
     ◦ 9x Close combat weapon
     ◦ 1x Demolition charge
     ◦ 1x Endurant Shield
     ◦ 1x Meltagun
     ◦ 1x Navis heavy shotgun
     ◦ 5x Navis shotgun
     ◦ 1x Power weapon

OTHER DATASHEETS

Exaction Squad (90 Points)
  • 1x Proctor-Exactant
     ◦ 1x Arbites combat shotgun
     ◦ 1x Arbites shotpistol
     ◦ 1x Close combat weapon
     ◦ 1x Nuncio-acquila
  • 9x Exaction Vigilant
     ◦ 1x Arbites Medi-kit
     ◦ 7x Arbites combat shotgun
     ◦ 9x Arbites shotpistol
     ◦ 9x Close combat weapon
  • 1x Cyber-mastiff
     ◦ 1x Mechanical bite

Subductor Squad (85 Points)
  • 1x Proctor-Subductor
     ◦ 1x Arbites shotpistol
     ◦ 1x Shock maul
  • 9x Subductor
     ◦ 9x Arbites shotpistol
     ◦ 9x Shock maul
  • 1x Cyber-mastiff
     ◦ 1x Mechanical bite

Exported with App Version: v1.53.0 (1), Data Version: v780`;

describe('parseArmyText — the team importer', () => {
  const { list, warnings } = parseArmyText(SAMPLE, deps);

  it('reads the army header (name / faction / detachment / battle size)', () => {
    expect(list.name).toBe("Rogue Trader's Army");
    expect(list.faction).toBe('AoI');
    expect(list.detachment).toBe('Imperialis Fleet');
    expect(list.battleSize).toBe('Incursion');
  });

  it('resolves every unit in the list (no unresolved warnings)', () => {
    const unresolved = warnings.filter((w) => w.includes('Could not resolve'));
    expect(unresolved).toEqual([]);
    // 5 characters + 3 battleline (2 Breachers) + 2 other = 10 units.
    expect(list.units).toHaveLength(10);
  });

  it('infers model counts from the model-group bullets', () => {
    const byName = (n: string) =>
      list.units.filter((u) => deps.datasheets.find((d) => d.id === u.datasheetId)?.name === n);
    expect(byName('Callidus Assassin')[0]!.modelCount).toBe(1); // single model, weapon-only bullets
    expect(byName('Deathwatch Kill Team')[0]!.modelCount).toBe(10); // 1 Sergeant + 9 Veterans
    expect(byName('Rogue Trader Entourage')[0]!.modelCount).toBe(4); // 4 model groups
    expect(byName('Imperial Navy Breachers')).toHaveLength(2); // two separate units
  });

  it('captures the per-item loadout, including the 4 thunder hammers', () => {
    const dw = list.units.find(
      (u) => deps.datasheets.find((d) => d.id === u.datasheetId)?.name === 'Deathwatch Kill Team',
    )!;
    expect(dw.loadout?.['Deathwatch thunder hammer']).toBe(4);
    expect(dw.loadout?.['Astartes shield']).toBe(2);
  });

  it('captures the Warlord and the Enhancement', () => {
    const warlord = list.units.find((u) => u.warlord);
    expect(deps.datasheets.find((d) => d.id === warlord?.datasheetId)?.name).toBe('Rogue Trader Entourage');
    const enh = enhancementsJson.find((e: Enhancement) => e.id === warlord?.enhancementId);
    expect(enh?.name).toBe('Clandestine Operation');
  });

  it('produces a legal-shaped list (defensive wargear survives for the game)', () => {
    const breachers = list.units.find(
      (u) => deps.datasheets.find((d) => d.id === u.datasheetId)?.name === 'Imperial Navy Breachers',
    )!;
    expect(breachers.loadout?.['Endurant Shield']).toBe(1);
  });
});
