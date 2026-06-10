import { useState } from 'react';
import type { Datasheet, Enhancement } from '../../core/types';
import { isCharacter, isEpicHero, type ArmyList, type ListUnit } from '../../core/army';
import { unitWargearOptions } from '../../core/wargear';
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
  onLoadout: (uid: string, item: string, count: number) => void;
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

  // Real, cap-aware wargear options for this unit's current model count.
  const wargearOptions = unitWargearOptions(ds, unit.modelCount);

  // Wahapedia repeats a size tier for allied pricing ("Agents of the Imperium Detachment") —
  // keep the first row per size (the one unitCost reads) so the options are unique and clean.
  const tiers = (ds.points ?? []).filter((t, i, arr) => arr.findIndex((x) => x.models === t.models) === i);

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
        {tiers.length > 1 ? (
          <label className="lu-field">
            <span>Size</span>
            <select
              value={unit.modelCount}
              onChange={(e) => props.onModelCount(unit.uid, Number(e.target.value))}
            >
              {tiers.map((t) => (
                <option key={t.models} value={t.models}>
                  {t.models} model{t.models === 1 ? '' : 's'} — {t.cost} pts
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

          {wargearOptions.map((opt) => {
            const used = opt.choices.reduce((s, c) => s + (unit.loadout?.[c.item] ?? 0), 0);
            const over = used > opt.max;
            return (
              <div key={opt.optionIndex} className={`lu-opt${over ? ' lu-opt-over' : ''}`}>
                <div className="lu-opt-text">
                  {opt.text}
                  <span className="lu-opt-cap">
                    {used}/{opt.max} model{opt.max === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="lu-choices">
                  {opt.choices.map((c) => {
                    const count = unit.loadout?.[c.item] ?? 0;
                    // This item's own ceiling: the shared pool minus what the option's *other* items use.
                    const otherUsed = used - count;
                    const itemMax = Math.max(0, opt.max - otherUsed);
                    return (
                      <div key={c.item} className="lu-stepper">
                        <button
                          type="button"
                          className="lu-step"
                          disabled={count <= 0}
                          onClick={() => props.onLoadout(unit.uid, c.item, count - 1)}
                        >
                          −
                        </button>
                        <span className="lu-step-count">{count}</span>
                        <button
                          type="button"
                          className="lu-step"
                          disabled={count >= itemMax}
                          onClick={() => props.onLoadout(unit.uid, c.item, count + 1)}
                        >
                          +
                        </button>
                        <span className="lu-step-label" title={c.label}>
                          {c.item}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {(ds.wargearNotes ?? []).map((n, i) => (
            <p key={i} className="lu-note">
              {n}
            </p>
          ))}

          <p className="lu-hint">
            Wargear is free in 10th edition — these choices don't change points, but the caps are
            enforced and shields carry into the game for saves.
          </p>
        </div>
      )}
    </div>
  );
}
