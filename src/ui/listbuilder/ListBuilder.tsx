import { useMemo, useState } from 'react';
import type { Datasheet, Roster } from '../../core/types';
import {
  addUnit,
  addUnitWithCount,
  BATTLE_SIZES,
  createArmyList,
  enhancementCost,
  extremisSurcharge,
  listPoints,
  patrolArmyList,
  removeUnit,
  setAttachedTo,
  setDetachments,
  setEnhancement,
  setLoadoutCount,
  setModelCount,
  setWarlord,
  toRoster,
  unitCost,
  unitWargearPoints,
  validate,
  type ArmyList,
  type BattleSize,
} from '../../core/army';
import {
  dataIndex,
  datasheets,
  detachmentsForFaction,
  enhancements,
  enhancementsForDetachment,
  getDatasheet,
  patrolEnhancements,
  rosters,
} from '../../data/loaders';
import {
  checkDetachmentPoints,
  detachmentPoints,
  dpBudget,
  isKnownDetachment,
  normalizeDetachmentName,
  splitDetachments,
} from '../../core/detachments';
import { Catalog } from './Catalog';
import { ListUnitCard } from './ListUnitCard';
import { ImportPanel } from './ImportPanel';
import { loadSavedArmyLists, writeSavedArmyLists } from '../savedLists';

const FACTIONS = [
  { id: 'AM', name: 'Astra Militarum' },
  { id: 'AoI', name: 'Imperial Agents' },
];

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'army';
}

interface Props {
  onOpenInBoard: (roster: Roster) => void;
}

export function ListBuilder({ onOpenInBoard }: Props) {
  const [list, setList] = useState<ArmyList>(() =>
    createArmyList('AM', detachmentsForFaction('AM')[0] ?? '', 'Incursion'),
  );
  const [savedNames, setSavedNames] = useState<string[]>(() => Object.keys(loadSavedArmyLists()));
  // On phones the three columns become tabs (the army list first — it's the thing being built).
  const [mTab, setMTab] = useState<'list' | 'catalog' | 'setup'>('list');

  const points = listPoints(list, dataIndex);
  const limit = BATTLE_SIZES[list.battleSize].points;
  const over = points > limit;
  const violations = useMemo(() => validate(list, dataIndex), [list]);
  const errorUids = new Set(violations.filter((v) => v.severity === 'error' && v.uid).map((v) => v.uid));
  const detachEnhancements = enhancementsForDetachment(list.detachment);

  // The four boxed Combat Patrols (fixed lists) — offered as the "faction" when the battle
  // size is Combat Patrol.
  const cpPatrols = useMemo(() => rosters.filter((r) => r.combatPatrol), []);
  const isCP = list.battleSize === 'Combat Patrol';
  // The loaded patrol's two enhancements — each is printed for one specific unit, and the
  // rule is pick ONE per battle (validate flags a second pick).
  const cpEnhOptions = isCP ? patrolEnhancements.filter((e) => e.patrolName === list.detachment) : [];
  const ask = (msg: string) => typeof confirm !== 'function' || confirm(msg);

  // ── settings handlers ──
  function setFaction(faction: string) {
    if (list.units.length > 0 && !ask('Switching faction clears the current list. Continue?')) return;
    setList(createArmyList(faction, detachmentsForFaction(faction)[0] ?? '', list.battleSize, list.name));
  }
  function loadPatrol(name: string) {
    const roster = cpPatrols.find((r) => r.name === name);
    if (!roster) return;
    if (list.units.length > 0 && list.detachment !== roster.detachment && !ask(`Load the fixed ${roster.name} patrol? The current list is replaced.`)) return;
    setList(patrolArmyList(roster, dataIndex));
  }
  function setBattleSize(size: BattleSize) {
    if (size === list.battleSize) return;
    if (size === 'Combat Patrol') {
      // Combat Patrol = one of the four fixed boxes, not a 500pt build.
      if (list.units.length > 0 && !ask('Combat Patrol uses one of the four fixed patrol boxes — switching clears the current list. Continue?')) return;
      setList({ name: list.name, faction: '', detachment: '', battleSize: 'Combat Patrol', combatPatrol: true, units: [] });
      return;
    }
    if (list.combatPatrol) {
      if (list.units.length > 0 && !ask('Leaving Combat Patrol clears the fixed patrol list. Continue?')) return;
      setList(createArmyList('AM', detachmentsForFaction('AM')[0] ?? '', size, list.name));
      return;
    }
    setList({ ...list, battleSize: size });
  }
  // ── multi-detachment picker (11e: several detachments may share the DP budget) ──
  // The army's single `detachment` string stays the storage format (a combined name joins with
  // " and ", exactly what the GW app exports) — the checkboxes just compose/decompose it.
  const selectedDetachments = list.detachment ? splitDetachments(list.detachment) : [];
  const selectedNorms = new Set(selectedDetachments.map(normalizeDetachmentName));
  // Catalog detachments for the faction, plus any selected component the catalog doesn't
  // carry (an imported combined/unknown name stays visible and un-checkable).
  const detachmentOptions = (() => {
    const catalog = isCP ? [] : detachmentsForFaction(list.faction);
    const catalogNorms = new Set(catalog.map(normalizeDetachmentName));
    return [...selectedDetachments.filter((d) => !catalogNorms.has(normalizeDetachmentName(d))), ...catalog];
  })();
  const dpLimit = dpBudget(BATTLE_SIZES[list.battleSize].points).dp;
  const selectedCost = list.detachment ? detachmentPoints(list.detachment, list.faction) : 0;
  function toggleDetachment(name: string) {
    const on = selectedNorms.has(normalizeDetachmentName(name));
    const next = on
      ? selectedDetachments.filter((d) => normalizeDetachmentName(d) !== normalizeDetachmentName(name))
      : [...selectedDetachments, name];
    // setDetachments joins canonically and clears only the enhancements whose detachment left.
    setList(setDetachments(list, next, dataIndex));
  }
  /** Why an UNCHECKED option can't join the current selection (undefined = it can). */
  function detachmentBlockReason(name: string): string | undefined {
    if (selectedDetachments.length === 0) return undefined; // any lone pick is legal (lone allowance)
    if (!isKnownDetachment(name)) return 'legacy detachment — lone pick only';
    if (selectedDetachments.some((d) => !isKnownDetachment(d)))
      return 'the selected legacy detachment cannot be combined';
    if (selectedCost + detachmentPoints(name, list.faction) > dpLimit)
      return `over the ${dpLimit} DP budget`;
    return undefined;
  }

  // ── persistence / export ──
  function save() {
    const map = loadSavedArmyLists();
    map[list.name] = list;
    writeSavedArmyLists(map);
    setSavedNames(Object.keys(map));
  }
  function loadByName(name: string) {
    const m = loadSavedArmyLists();
    if (m[name]) setList(m[name]!);
  }
  function del(name: string) {
    const m = loadSavedArmyLists();
    delete m[name];
    writeSavedArmyLists(m);
    setSavedNames(Object.keys(m));
  }

  function setLoadout(uid: string, item: string, count: number) {
    setList(setLoadoutCount(list, uid, item, count));
  }

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  return (
    <div className="lb-layout" data-mtab={mTab}>
      {/* Mobile-only bottom nav with a live points chip. */}
      <div className="m-tabs" role="tablist">
        <button role="tab" aria-selected={mTab === 'list'} className={mTab === 'list' ? 'on' : ''} onClick={() => setMTab('list')}>
          <span className="m-ico" aria-hidden>📜</span>
          <span>My list</span>
        </button>
        <button role="tab" aria-selected={mTab === 'catalog'} className={mTab === 'catalog' ? 'on' : ''} onClick={() => setMTab('catalog')}>
          <span className="m-ico" aria-hidden>➕</span>
          <span>Add units</span>
        </button>
        <button role="tab" aria-selected={mTab === 'setup'} className={mTab === 'setup' ? 'on' : ''} onClick={() => setMTab('setup')}>
          <span className="m-ico" aria-hidden>⚙️</span>
          <span>Setup</span>
        </button>
        <span className={`m-points${over ? ' over' : ''}`}>{points}/{limit}</span>
      </div>
      <aside className="sidebar">
        <label className="field">
          <span>List name</span>
          <input value={list.name} onChange={(e) => setList({ ...list, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Faction</span>
          {isCP ? (
            // Combat Patrol: the "faction" is one of the four boxed patrols — picking one loads
            // its fixed list (units, sizes and wargear come from the box).
            <select value={cpPatrols.find((r) => r.detachment === list.detachment)?.name ?? ''} onChange={(e) => loadPatrol(e.target.value)}>
              <option value="">— pick a Combat Patrol —</option>
              {cpPatrols.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name} — {r.faction}
                </option>
              ))}
            </select>
          ) : (
            <select value={list.faction} onChange={(e) => setFaction(e.target.value)}>
              {FACTIONS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <div className="field">
          <span>
            Detachment{selectedDetachments.length > 1 ? 's' : ''}
            {list.detachment && !isCP && (() => {
              const dp = checkDetachmentPoints(list.detachment, list.faction, BATTLE_SIZES[list.battleSize].points);
              return (
                <span className="muted" title="Detachment Points (11e): 2 DP budget at 1000 pts, 3 DP at 2000. An army may combine detachments within the budget; a lone detachment over budget is legal per GW's stated intent.">
                  {' '}· {dp.cost}/{dp.budget.dp} DP{dp.overBudgetLone ? ' (lone-detachment allowance)' : dp.overBudgetMulti ? ' (over budget)' : ''}
                </span>
              );
            })()}
          </span>
          {isCP ? (
            // A patrol IS its detachment — nothing to choose.
            <select value={list.detachment} disabled>
              <option value={list.detachment}>{list.detachment || '— pick a Combat Patrol above —'}</option>
            </select>
          ) : (
            <>
              {/* Multiselect: check several detachments within the DP budget (11e). A single
                  detachment may exceed it (the printed lone-detachment allowance), so with
                  nothing checked every option is open; once one is checked, options that
                  would bust the budget are disabled. */}
              <div className="detach-multi" role="group" aria-label="Detachments">
                {detachmentOptions.map((d) => {
                  const checked = selectedNorms.has(normalizeDetachmentName(d));
                  const blocked = checked ? undefined : detachmentBlockReason(d);
                  return (
                    <label key={d} className={`detach-opt${checked ? ' on' : ''}${blocked ? ' blocked' : ''}`} title={blocked}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!!blocked}
                        onChange={() => toggleDetachment(d)}
                      />
                      <span className="detach-name">{d}</span>
                      <span className="detach-dp">{detachmentPoints(d, list.faction)} DP</span>
                    </label>
                  );
                })}
              </div>
              <span className="hint">
                Combine detachments up to {dpLimit} DP ({BATTLE_SIZES[list.battleSize].points} pts) — e.g. a 2 DP and a
                1 DP detachment at 3 DP. A lone detachment may exceed the budget.
              </span>
            </>
          )}
        </div>
        <label className="field">
          <span>Battle size</span>
          <select value={list.battleSize} onChange={(e) => setBattleSize(e.target.value as BattleSize)}>
            {(Object.keys(BATTLE_SIZES) as BattleSize[]).map((b) => (
              <option key={b} value={b}>
                {b} ({BATTLE_SIZES[b].points} pts)
              </option>
            ))}
          </select>
        </label>
        {isCP && (
          <p className="hint">
            Combat Patrol plays one of the four fixed boxes — picking a patrol loads its exact
            units and wargear. You may take ONE of the patrol's two enhancements: the Enhancement
            picker appears on the unit each card is printed for. Open it in the board and start a
            Combat Patrol battle.
          </p>
        )}

        <div className={`points-bar${over ? ' over' : ''}`}>
          <div className="points-fill" style={{ width: `${Math.min(100, (points / limit) * 100)}%` }} />
          <span className="points-text">
            {points} / {limit} pts
          </span>
        </div>

        <section>
          <h2>Validation</h2>
          {errors.length === 0 && warnings.length === 0 && <p className="ok">✓ Legal list.</p>}
          {errors.map((v, i) => (
            <p key={`e${i}`} className="v-error">
              ✕ {v.message}
            </p>
          ))}
          {warnings.map((v, i) => (
            <p key={`w${i}`} className="v-warn">
              ⚠ {v.message}
            </p>
          ))}
        </section>

        <ImportPanel
          datasheets={datasheets}
          enhancements={enhancements}
          onImport={(imported) => setList(imported)}
        />

        <section className="actions">
          <h2>Save / export</h2>
          <div className="btn-row">
            <button onClick={save}>Save</button>
            <button onClick={() => setList(createArmyList('AM', detachmentsForFaction('AM')[0] ?? '', 'Incursion'))}>
              New
            </button>
          </div>
          <div className="btn-row">
            <button onClick={() => download(`${slug(list.name)}.roster.json`, JSON.stringify(toRoster(list, dataIndex), null, 2))}>
              Export JSON
            </button>
            <button className="primary" onClick={() => onOpenInBoard(toRoster(list, dataIndex))}>
              Open in board →
            </button>
          </div>
          {savedNames.length > 0 && (
            <div className="saved">
              <span className="muted">Saved lists</span>
              {savedNames.map((n) => (
                <div key={n} className="saved-row">
                  <button className="link" onClick={() => loadByName(n)}>
                    {n}
                  </button>
                  <button className="remove" onClick={() => del(n)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>

      <main className="lb-main">
        <Catalog
          faction={list.faction}
          onAdd={(ds: Datasheet) => {
            if (!list.combatPatrol) return setList(addUnit(list, ds));
            // Re-adding a removed patrol unit restores its FIXED size and wargear from the box.
            const src = cpPatrols
              .find((r) => r.detachment === list.detachment)
              ?.units.find((u) => u.datasheetId === ds.id);
            setList(addUnitWithCount(list, ds, src?.modelCount ?? 1, src?.wargearCounts));
          }}
        />

        <div className="lb-list">
          <h2>
            Your list — {list.units.length} unit{list.units.length === 1 ? '' : 's'}
          </h2>
          {list.units.length === 0 && <p className="muted">Add units from the catalog to begin.</p>}
          {list.units.map((u, i) => {
            const ds = getDatasheet(u.datasheetId);
            if (!ds) return null;
            // Copy index in list order — escalating 11e tiers price a 3rd Hellhound higher.
            const copyIndex = list.units.slice(0, i).filter((x) => x.datasheetId === u.datasheetId).length + 1;
            const pts =
              unitCost(ds, u.modelCount, copyIndex) +
              unitWargearPoints(ds, u.loadout) +
              enhancementCost(u.enhancementId, dataIndex) +
              // Veiled Blade's Extremis Sanction: assassins pay their Extremis ability's cost.
              extremisSurcharge(ds, list.detachment, dataIndex);
            return (
              <ListUnitCard
                key={u.uid}
                unit={u}
                ds={ds}
                list={list}
                points={pts}
                enhancements={detachEnhancements}
                cpEnhancements={cpEnhOptions.filter((e) => e.targetDsId === u.datasheetId)}
                hasError={errorUids.has(u.uid)}
                onModelCount={(uid, n) => setList(setModelCount(list, uid, n))}
                onEnhancement={(uid, id) => setList(setEnhancement(list, uid, id))}
                onWarlord={(uid) => setList(setWarlord(list, uid))}
                onAttach={(uid, target) => setList(setAttachedTo(list, uid, target))}
                onLoadout={setLoadout}
                onRemove={(uid) => setList(removeUnit(list, uid))}
              />
            );
          })}
        </div>
      </main>
    </div>
  );
}
