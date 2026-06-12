// The prebuilt AI sparring lists — six legal 1000pt Incursion armies (3 Astra Militarum,
// 3 Imperial Agents) built from the converted Wahapedia data, so the AI always has a varied,
// playable team pool even before the three owned lists are encoded.
//
// Single source of truth: `tools/rosters/build-prebuilt.ts` writes these to data/rosters/*.json,
// and tests/prebuilt.test.ts validates the same definitions against the army engine and asserts
// the committed JSON is in sync. Edit HERE, then re-run `pnpm build:rosters`.
//
// NOTE: these are NOT the owner's three lists (those still await docs/lists/*.md). Wargear stays
// on datasheet defaults; enhancements are intentionally omitted (they have no in-game effect in
// the engine yet, so they would only burn points).

import type { ArmyList } from '../../src/core/army';

export interface PrebuiltDef {
  /** data/rosters/<fileName>.json */
  fileName: string;
  list: ArmyList;
}

/** Shorthand: a ListUnit with uid `<dsId>~<n>` (n disambiguates duplicates). */
function u(datasheetId: string, modelCount: number, n = 1, warlord = false) {
  return { uid: `${datasheetId}~${n}`, datasheetId, modelCount, ...(warlord ? { warlord: true } : {}) };
}

export const PREBUILT: PrebuiltDef[] = [
  {
    fileName: 'prebuilt_cadian_bulwark',
    list: {
      name: 'Cadian Bulwark',
      faction: 'AM',
      detachment: 'Grizzled Company',
      battleSize: 'Incursion',
      units: [
        u('000002607', 1, 1, true), // Cadian Castellan (Warlord, Officer) — 55
        u('000002609', 5), //          Cadian Command Squad (Officer) — 65
        u('000002612', 10, 1), //      Cadian Shock Troops — 65
        u('000002612', 10, 2), //      Cadian Shock Troops — 65
        u('000002615', 10), //         Kasrkin — 110
        u('000000723', 3), //          Bullgryn Squad — 100
        u('000000686', 3), //          Cadian Heavy Weapons Squad — 65
        u('000000692', 1), //          Chimera — 85
        u('000000700', 1), //          Leman Russ Battle Tank — 185
        u('000000690', 1), //          Scout Sentinels — 55
        u('000000691', 1), //          Armoured Sentinels — 65
        u('000000716', 1), //          Commissar — 30
        u('000001394', 1), //          Ministorum Priest — 35
      ], //                            total 980
    },
  },
  {
    fileName: 'prebuilt_krieg_siege',
    list: {
      name: 'Krieg Siege Echelon',
      faction: 'AM',
      detachment: 'Siege Regiment',
      battleSize: 'Incursion',
      units: [
        u('000003889', 6, 1, true), // Krieg Command Squad (Warlord, Officer) — 65
        u('000002613', 20, 1), //      Death Korps of Krieg — 145
        u('000002613', 10, 2), //      Death Korps of Krieg — 65
        u('000002374', 10), //         Death Korps Grenadier Squad — 110
        u('000003893', 5), //          Krieg Combat Engineers — 60
        u('000003895', 4), //          Krieg Heavy Weapons Squad — 75
        u('000003898', 5), //          Death Riders — 60
        u('000000743', 1), //          Earthshaker Carriage Battery — 120
        u('000000745', 1), //          Heavy Mortar Team — 50
        u('000000695', 1), //          Basilisk — 140
        u('000000716', 1), //          Commissar — 30
        u('000000724', 5), //          Ratlings — 60
      ], //                            total 980
    },
  },
  {
    fileName: 'prebuilt_armoured_spearhead',
    list: {
      name: 'Armoured Spearhead',
      faction: 'AM',
      detachment: 'Hammer of the Emperor',
      battleSize: 'Incursion',
      units: [
        u('000000680', 1, 1, true), // Leman Russ Commander (Warlord, Officer) — 235
        u('000002745', 1), //          Leman Russ Vanquisher — 145
        u('000000700', 1), //          Leman Russ Battle Tank — 185
        u('000000694', 1), //          Hellhound — 125
        u('000000692', 1), //          Chimera — 85
        u('000002612', 10, 1), //      Cadian Shock Troops — 65
        u('000002612', 10, 2), //      Cadian Shock Troops — 65
        u('000000690', 1), //          Scout Sentinels — 55
      ], //                            total 960
    },
  },
  {
    fileName: 'prebuilt_fleet_boarding',
    list: {
      name: 'Fleet Boarding Party',
      faction: 'AoI',
      detachment: 'Imperialis Fleet',
      battleSize: 'Incursion',
      units: [
        u('000002762', 4, 1, true), // Rogue Trader Entourage (Warlord) — 75
        u('000002587', 10, 1), //      Imperial Navy Breachers — 90
        u('000002587', 10, 2), //      Imperial Navy Breachers — 90
        u('000002509', 6, 1), //       Voidsmen-at-arms — 50
        u('000002509', 6, 2), //       Voidsmen-at-arms — 50
        u('000002765', 1), //          Navigator — 60
        u('000002683', 11), //         Vigilant Squad — 85
        u('000002685', 11), //         Exaction Squad — 90
        u('000002684', 11), //         Subductor Squad — 85
        u('000004174', 5), //          Aquila Kill Team — 100
        u('000000871', 1), //          Callidus Assassin — 100
        u('000003820', 1), //          Inquisitorial Chimera — 70
        u('000002766', 1), //          UR-025 — 55
      ], //                            total 1000
    },
  },
  {
    fileName: 'prebuilt_deathwatch_vigil',
    list: {
      name: 'Deathwatch Vigil',
      faction: 'AoI',
      detachment: 'Ordo Xenos Alien Hunters',
      battleSize: 'Incursion',
      units: [
        u('000003815', 1, 1, true), // Watch Master (Warlord) — 95
        u('000003816', 10, 1), //      Deathwatch Kill Team — 190
        u('000003816', 5, 2), //       Deathwatch Kill Team — 100
        u('000003822', 5), //          Deathwatch Terminator Squad — 210
        u('000003825', 5), //          Fortis Kill Team — 100
        u('000003817', 1), //          Corvus Blackstar — 180
        u('000000870', 1), //          Vindicare Assassin — 110
      ], //                            total 985
    },
  },
  {
    fileName: 'prebuilt_hereticus_purgation',
    list: {
      name: 'Hereticus Purgation Force',
      faction: 'AoI',
      detachment: 'Ordo Hereticus Purgation Force',
      battleSize: 'Incursion',
      units: [
        u('000000877', 1, 1, true), // Inquisitor (Warlord) — 55
        u('000003818', 10, 1), //      Sisters of Battle Squad — 100
        u('000003818', 10, 2), //      Sisters of Battle Squad — 100
        u('000003819', 1), //          Sisters of Battle Immolator — 100
        u('000002683', 11, 1), //      Vigilant Squad — 85
        u('000002683', 11, 2), //      Vigilant Squad — 85
        u('000002685', 11), //         Exaction Squad — 90
        u('000004074', 9), //          Sanctifiers — 100
        u('000003812', 1), //          Ministorum Priest — 40
        u('000000872', 1), //          Eversor Assassin — 110
        u('000003828', 1), //          Daemonhost — 40
        u('000002767', 6), //          Inquisitorial Agents — 50
      ], //                            total 955
    },
  },
];

export const PREBUILT_NOTE =
  'Prebuilt AI sparring list — a legal 1000pt Incursion army generated from the converted data ' +
  'by tools/rosters/build-prebuilt.ts (edit tools/rosters/prebuilt.ts and re-run pnpm build:rosters). ' +
  'Not one of the three owned lists.';
