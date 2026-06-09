import { useState } from 'react';
import type { Datasheet, Enhancement } from '../../core/types';
import { isCharacter, isEpicHero, type ArmyList, type ListUnit } from '../../core/army';
import { getDatasheet } from '../../data/loaders';

interface Props {
  unit: ListUnit;
  ds: Datasheet;
  list: ArmyList;
  points: number;
  enhancements: Enhancement[];
  hasError: boolean;
  onModelCount: (uid: string, n: number) => void;
  onEnhancement: (uid: string, id?: string) => void;
  onWarlord: (uid: string) => void;
  onAttach: (uid: string, targetUid?: string) => void;
  onLoadout: (uid: string, groupIdx: number, selected: string[]) => void;
  onRemove: (uid: string) => void;
}

export function ListUnitCard(props: Props) {
  const { unit, ds, list, points, enhancements, hasError } = props;
  const [open, setOpen] = useState(false);

  const character = isCharacter(ds);
  const canEnhance = character && !isEpicHero(ds);

  // Bodyguard units already in the list that this leader can attach to.
  const attachTargets = list.units
    .filter((u) => u.uid !== unit.uid && (ds.canLead ?? []).includes(u.datasheetId))
    .map((u) => ({ uid: u.uid, name: getDatasheet(u.datasheetId)?.name ?? u.datasheetId }));

  function toggleChoice(groupIdx: number, choice: string) {
    const cur = unit.loadout?.[groupIdx] ?? [];
    const next = cur.includes(choice) ? cur.filter((c) => c !== choice) : [...cur, choice];
    props.onLoadout(unit.uid, groupIdx, next);
  }

  return (
    <div className={`lu-card${hasError ? ' lu-error' : ''}`}>
      <div className="lu-head">
        <span className="lu-name">
          {ds.name}
          {unit.warlord && <span className="lu-warlord" title="Warlord">★</span>}
        </span>
        <span className="lu-pts">{points} pts</span>
        <button className="remove" title="Remove" onClick={() => props.onRemove(unit.uid)}>
          ×
        </button>
      </div>

      <div className="lu-row">
        {ds.points && ds.points.length > 1 ? (
          <label className="lu-field">
            <span>Size</span>
            <select
              value={unit.modelCount}
              onChange={(e) => props.onModelCount(unit.uid, Number(e.target.value))}
            >
              {ds.points.map((t) => (
                <option key={t.models} value={t.models}>
                  {t.models} models — {t.cost} pts{t.note ? ` (${t.note})` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="lu-static">
            {unit.modelCount} model{unit.modelCount === 1 ? '' : 's'}
          </span>
        )}

        {character && (
          <button
            className={`lu-tag${unit.warlord ? ' on' : ''}`}
            onClick={() => props.onWarlord(unit.uid)}
            title="Set as Warlord"
          >
            Warlord
          </button>
        )}

        <button className="lu-tag" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide options' : 'Options'}
        </button>
      </div>

      {canEnhance && (
        <label className="lu-field">
          <span>Enhancement</span>
          <select
            value={unit.enhancementId ?? ''}
            onChange={(e) => props.onEnhancement(unit.uid, e.target.value || undefined)}
          >
            <option value="">— none —</option>
            {enhancements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} (+{e.cost})
              </option>
            ))}
          </select>
        </label>
      )}

      {open && (
        <div className="lu-options">
          {ds.loadout && (
            <p className="lu-loadout">
              <strong>Default:</strong> {ds.loadout}
            </p>
          )}

          {attachTargets.length > 0 && (
            <label className="lu-field">
              <span>Attach to</span>
              <select
                value={unit.attachedTo ?? ''}
                onChange={(e) => props.onAttach(unit.uid, e.target.value || undefined)}
              >
                <option value="">— not attached —</option>
                {attachTargets.map((t) => (
                  <option key={t.uid} value={t.uid}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {(ds.wargearOptions ?? []).map((opt, i) => (
            <div key={i} className="lu-opt">
              <div className="lu-opt-text">{opt.text}</div>
              {opt.choices.length > 0 ? (
                <div className="lu-choices">
                  {opt.choices.map((c) => (
                    <label key={c} className="lu-choice">
                      <input
                        type="checkbox"
                        checked={unit.loadout?.[i]?.includes(c) ?? false}
                        onChange={() => toggleChoice(i, c)}
                      />
                      {c}
                    </label>
                  ))}
                </div>
              ) : (
                <label className="lu-choice">
                  <input
                    type="checkbox"
                    checked={(unit.loadout?.[i]?.length ?? 0) > 0}
                    onChange={() => toggleChoice(i, 'take')}
                  />
                  take this option
                </label>
              )}
            </div>
          ))}

          {(ds.wargearNotes ?? []).map((n, i) => (
            <p key={i} className="lu-note">
              {n}
            </p>
          ))}

          <p className="lu-hint">Wargear is free in 10th edition — these choices don't change points.</p>
        </div>
      )}
    </div>
  );
}
