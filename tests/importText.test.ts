// The text-export → roster import pipeline (tools/rosters/import-text.ts) and the two
// committed rosters it produced: the owner's "Bane" and "Rogue Trader's Army" lists.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeExport } from '../tools/rosters/import-text';
import { parseArmyText } from '../src/core/importer';
import { validate, listPoints, toRoster } from '../src/core/army';
import { dataIndex, enhancementsForDetachment } from '../src/data/loaders';
import { DISPOSITIONS } from '../src/core/missions11';
import { profileForDisposition } from '../src/core/ai/profile';
import type { Roster } from '../src/core/types';

const root = join(__dirname, '..');
const deps = {
  datasheets: [...dataIndex.datasheets.values()],
  enhancements: [...dataIndex.enhancements.values()],
};

describe('normalizeExport', () => {
  it('re-bullets glyphless "Nx item" continuation lines as siblings of the previous bullet', () => {
    const text = ['Unit (10 points)', '  • 1x Bale Eye', '    1x Laspistol', '    2x Power sword'].join('\n');
    expect(normalizeExport(text).split('\n')).toEqual([
      'Unit (10 points)',
      '  • 1x Bale Eye',
      '  • 1x Laspistol',
      '  • 2x Power sword',
    ]);
  });

  it('does not attach continuations across a header line and leaves intact exports unchanged', () => {
    const headerReset = ['  • 1x Lasgun', 'OTHER DATASHEETS', '  1x Heavy mortar'].join('\n');
    expect(normalizeExport(headerReset).split('\n')[2]).toBe('  1x Heavy mortar');

    const intact = ['List (985 Points)', '  • 1x Neural shredder', '     ◦ 1x Dartmask'].join('\n');
    expect(normalizeExport(intact)).toBe(intact);
  });
});

describe('imported owner lists', () => {
  const cases = [
    // Point totals are the 11e (Faction Pack v1.1) prices — the exports' printed "985 Points"
    // header is the 10e-app total and is informational only.
    { txt: 'bane.txt', json: 'bane.json', name: 'Bane', units: 7, points: 935 },
    { txt: 'rogue_traders_army.txt', json: 'rogue_traders_army.json', name: 'Rogue Trader’s Army', units: 10, points: 975 },
    // v2.0.5 (11e) export format: ATTACHED UNITS sections, "Attached as:" bullets, a detachment
    // line with a DP suffix and comma variant, and a Force Dispositions line.
    { txt: 'inquisitors.txt', json: 'inquisitors.json', name: 'Inquisitors', units: 11, points: 965 },
    // v2.4.0 (11e) MULTI-DETACHMENT export: two detachments joined with "and" in the header, a
    // bare disposition line ("Reconnaissance"), enhancements from BOTH detachments. The 2000
    // reconciles the app exactly: the Callidus is 100 base + 15 Extremis Sanction surcharge
    // (Veiled Blade auto-grants Decoy Targets and charges for it).
    { txt: 'hold_objectives.txt', json: 'hold_objectives.json', name: 'HOLD OBJECTIVES', units: 20, points: 2000 },
  ];

  for (const c of cases) {
    it(`${c.name}: parses with no warnings, is legal, and the committed JSON is in sync`, () => {
      const text = readFileSync(join(root, 'tools', 'rosters', 'imports', c.txt), 'utf-8');
      const { list, warnings, disposition } = parseArmyText(normalizeExport(text), deps);
      expect(warnings).toEqual([]);
      expect(list.name).toBe(c.name);
      expect(list.units).toHaveLength(c.units);
      expect(listPoints(list, dataIndex)).toBe(c.points);

      const errors = validate(list, dataIndex).filter((v) => v.severity === 'error');
      expect(errors, errors.map((e) => e.message).join('; ')).toEqual([]);

      // Committed JSON == regenerating from the text (run `pnpm import:roster` after edits).
      const onDisk = JSON.parse(
        readFileSync(join(root, 'data', 'rosters', c.json), 'utf-8'),
      ) as Roster;
      const note = `Imported from the 40k-app text export ${c.txt} via pnpm import:roster.`;
      const dispId = disposition
        ? DISPOSITIONS.find((d) => d.name.toLowerCase() === disposition.toLowerCase())?.id
        : undefined;
      expect(onDisk).toEqual({
        ...toRoster(list, dataIndex),
        ...(dispId ? { recommended: { disposition: dispId, profile: profileForDisposition(dispId) } } : {}),
        note,
      });
    });
  }

  it('Inquisitors (11e export): detachment normalized, disposition captured, attachments not wargear', () => {
    const text = readFileSync(join(root, 'tools', 'rosters', 'imports', 'inquisitors.txt'), 'utf-8');
    const { list, disposition } = parseArmyText(normalizeExport(text), deps);
    expect(list.detachment).toBe('Ordo Hereticus Purgation Force'); // comma + "(3 Detachment Points)" stripped
    expect(disposition).toBe('Purge the Foe');
    // "Attached as:" metadata bullets never end up in a loadout.
    for (const u of list.units) {
      expect(Object.keys(u.loadout ?? {}).some((k) => /attached as/i.test(k))).toBe(false);
    }
    // Both 11e "Enhancements:" (plural) lines resolved.
    const enhNames = list.units
      .map((u) => u.enhancementId && dataIndex.enhancements.get(u.enhancementId)?.name)
      .filter(Boolean);
    expect(enhNames.sort()).toEqual(['Ignis Judicium', 'Liber Heresius']);
  });

  it('HOLD OBJECTIVES (multi-detachment): both detachments parsed, both enhancements legal', () => {
    const text = readFileSync(join(root, 'tools', 'rosters', 'imports', 'hold_objectives.txt'), 'utf-8');
    const { list, warnings, disposition } = parseArmyText(normalizeExport(text), deps);
    expect(warnings).toEqual([]);
    expect(list.detachment).toBe('Imperialis Fleet and Veiled Blade Elimination Force');
    expect(disposition).toBe('Reconnaissance'); // bare disposition line (no "Force Dispositions:" prefix)
    // Enhancements resolve from BOTH component detachments and validate clean.
    const enhNames = list.units
      .map((u) => u.enhancementId && dataIndex.enhancements.get(u.enhancementId)?.name)
      .filter(Boolean)
      .sort();
    expect(enhNames).toEqual(['Clandestine Operation', 'Digital Weapons']);
    expect(validate(list, dataIndex).filter((v) => v.severity === 'error')).toEqual([]);
    // The former false positives stay dead: no wargear-cap or enhancement-scope errors on the
    // Sanctifiers' 5 hand flamers or the Chimera's twin heavy flamers.
    const kroyle = list.units.find((u) => dataIndex.datasheets.get(u.datasheetId)?.name === 'Inquisitor Kroyle');
    expect(kroyle?.warlord).toBe(true);
    // Extremis Sanction: the roster stamps Decoy Targets onto the Callidus (auto-granted in a
    // Veiled Blade army) so its in-game bindings apply, without it being a list "enhancement".
    const roster = toRoster(list, dataIndex);
    const callidus = roster.units.find((u) => dataIndex.datasheets.get(u.datasheetId)?.name === 'Callidus Assassin');
    expect(callidus?.enhancementId).toBeTruthy();
    expect(dataIndex.enhancements.get(callidus!.enhancementId!)?.name).toBe('Decoy Targets');
    // …and the Extremis cards are not offered by the enhancement picker.
    const offered = enhancementsForDetachment(list.detachment).map((e) => e.name);
    expect(offered).toContain('Fleetmaster');
    expect(offered).not.toContain('Decoy Targets');
    expect(offered).not.toContain('Micromelta Rounds');
    // An enhancement from a detachment NOT in the army is still flagged.
    const draxus = list.units.find((u) => dataIndex.datasheets.get(u.datasheetId)?.name === 'Inquisitor Draxus')!;
    const foreign = [...dataIndex.enhancements.values()].find((e) => e.detachment === 'Ordo Xenos Alien Hunters')!;
    const tampered = { ...list, units: list.units.map((u) => (u.uid === draxus.uid ? { ...u, enhancementId: foreign.id } : u)) };
    expect(
      validate(tampered, dataIndex).some((v) => v.severity === 'error' && v.message.includes(foreign.name)),
    ).toBe(true);
  });

  it('Bane carries the full per-model wargear through normalization (the glyphless lines)', () => {
    const onDisk = JSON.parse(
      readFileSync(join(root, 'data', 'rosters', 'bane.json'), 'utf-8'),
    ) as Roster;
    const stormlord = onDisk.units.find((u) => u.wargearCounts?.['Vulcan mega-bolter']);
    expect(stormlord?.wargearCounts).toMatchObject({ Lascannon: 4, 'Twin heavy flamer': 4 });
    const dkok = onDisk.units.find((u) => u.wargearCounts?.['Plasma gun']);
    expect(dkok?.modelCount).toBe(10);
    expect(dkok?.wargearCounts).toMatchObject({ Lasgun: 7, 'Death Korps Medi-pack': 1 });
  });
});
