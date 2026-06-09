import { useMemo, useState } from 'react';
import type { Datasheet, Roster } from '../../core/types';
import {
  addUnit,
  BATTLE_SIZES,
  createArmyList,
  enhancementCost,
  listPoints,
  removeUnit,
  setAttachedTo,
  setEnhancement,
  setModelCount,
  setWarlord,
  toRoster,
  unitCost,
  validate,
  type ArmyList,
  type BattleSize,
} from '../../core/army';
import {
  dataIndex,
  detachmentsForFaction,
  enhancementsForDetachment,
  getDatasheet,
} from '../../data/loaders';
import { Catalog } from './Catalog';
import { ListUnitCard } from './ListUnitCard';

const FACTIONS = [
  { id: 'AM', name: 'Astra Militarum' },
  { id: 'AoI', name: 'Imperial Agents' },
];

const LS_KEY = '40k-armylists';
function loadSaved(): Record<string, ArmyList> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, ArmyList>;
  } catch {
    return {};
  }
}
function writeSaved(map: Record<string, ArmyList>) {
  localStorage.setItem(LS_KEY, JSON.stringify(map));
}
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
  const [savedNames, setSavedNames] = useState<string[]>(() => Object.keys(loadSaved()));

  const points = listPoints(list, dataIndex);
  const limit = BATTLE_SIZES[list.battleSize].points;
  const over = points > limit;
  const violations = useMemo(() => validate(list, dataIndex), [list]);
  const errorUids = new Set(violations.filter((v) => v.severity === 'error' && v.uid).map((v) => v.uid));
  const detachEnhancements = enhancementsForDetachment(list.detachment);

  // ── settings handlers ──
  function setFaction(faction: string) {
    if (list.units.length > 0 && !confirm('Switching faction clears the current list. Continue?')) return;
    setList(createArmyList(faction, detachmentsForFaction(faction)[0] ?? '', list.battleSize, list.name));
  }
  function setDetachment(detachment: string) {
    // enhancements are detachment-scoped; clear them so none are left stranded
    setList({ ...list, detachment, units: list.units.map((u) => ({ ...u, enhancementId: undefined })) });
  }

  // ── persistence / export ──
  function save() {
    const map = loadSaved();
    map[list.name] = list;
    writeSaved(map);
    setSavedNames(Object.keys(map));
  }
  function loadByName(name: string) {
    const m = loadSaved();
    if (m[name]) setList(m[name]!);
  }
  function del(name: string) {
    const m = loadSaved();
    delete m[name];
    writeSaved(m);
    setSavedNames(Object.keys(m));
  }

  function setLoadout(uid: string, groupIdx: number, selected: string[]) {
    setList({
      ...list,
      units: list.units.map((u) => {
        if (u.uid !== uid) return u;
        const loadout = { ...(u.loadout ?? {}) };
        if (selected.length === 0) delete loadout[groupIdx];
        else loadout[groupIdx] = selected;
        return { ...u, loadout };
      }),
    });
  }

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  return (
    <div className="lb-layout">
      <aside className="sidebar">
        <label className="field">
          <span>List name</span>
          <input value={list.name} onChange={(e) => setList({ ...list, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Faction</span>
          <select value={list.faction} onChange={(e) => setFaction(e.target.value)}>
            {FACTIONS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Detachment</span>
          <select value={list.detachment} onChange={(e) => setDetachment(e.target.value)}>
            <option value="">— select —</option>
            {detachmentsForFaction(list.faction).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Battle size</span>
          <select value={list.battleSize} onChange={(e) => setList({ ...list, battleSize: e.target.value as BattleSize })}>
            {(Object.keys(BATTLE_SIZES) as BattleSize[]).map((b) => (
              <option key={b} value={b}>
                {b} ({BATTLE_SIZES[b].points} pts)
              </option>
            ))}
          </select>
        </label>

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
        <Catalog faction={list.faction} onAdd={(ds: Datasheet) => setList(addUnit(list, ds))} />

        <div className="lb-list">
          <h2>
            Your list — {list.units.length} unit{list.units.length === 1 ? '' : 's'}
          </h2>
          {list.units.length === 0 && <p className="muted">Add units from the catalog to begin.</p>}
          {list.units.map((u) => {
            const ds = getDatasheet(u.datasheetId);
            if (!ds) return null;
            const pts = unitCost(ds, u.modelCount) + enhancementCost(u.enhancementId, dataIndex);
            return (
              <ListUnitCard
                key={u.uid}
                unit={u}
                ds={ds}
                list={list}
                points={pts}
                enhancements={detachEnhancements}
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
