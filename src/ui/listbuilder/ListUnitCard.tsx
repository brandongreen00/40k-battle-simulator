import { useState } from 'react';
import type { Datasheet, Enhancement } from '../../core/types';
import { isCharacter, isEpicHero, type ArmyList, type ListUnit } from '../../core/army';
import { defaultLoadoutCounts, groupFits, loadoutCount, normalizeItemName, wargearOptionGroups } from '../../core/wargear';
import { extremisAbilityId, leaderGrantTargets } from '../../core/enhancements';
import { armyHasDetachment } from '../../core/detachments';
import { dataIndex, getDatasheet, type CpEnhancement } from '../../data/loaders';

interface Props {
  unit: ListUnit;
  ds: Datasheet;
  list: ArmyList;
  points: number;
  enhancements: Enhancement[];
  /** Combat Patrol only: the patrol enhancement(s) printed for THIS unit's datasheet. */
  cpEnhancements?: CpEnhancement[];
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
  // Veiled Blade's Extremis Sanction: an assassin in that army automatically has its temple's
  // Extremis ability and pays its cost — surfaced here so the higher price is explained.
  const extremis = list.combatPatrol ? undefined : dataIndex.enhancements.get(extremisAbilityId(ds, list.detachment) ?? '');
  // Combat Patrol enhancements are printed for a specific unit (Character or not) — the select
  // appears exactly on the bearers; the standard Character rule applies to normal lists only.
  const cpEnh = props.cpEnhancements ?? [];
  const kws = ds.keywords.map((k) => k.toLowerCase());
  // Steel Hammer's KEYWORDS rule: an AM TITANIC unit in that army may gain CHARACTER, so it can
  // take enhancements (taking one is the opt-in).
  const steelHammerTitanic =
    !list.combatPatrol && kws.includes('titanic') && kws.includes('astra militarum') &&
    armyHasDetachment(list.detachment, 'Steel Hammer');
  // Upgrades go only on their printed bearers; other units see none. Characters (and opted-in
  // Steel Hammer tanks) see the full catalog minus foreign-bearer Upgrades.
  const upgradeFits = (e: Enhancement): boolean =>
    !e.bearerKeywords?.length || e.bearerKeywords.some((b) => kws.includes(b) || ds.name.toLowerCase() === b);
  const offered = list.combatPatrol || isEpicHero(ds)
    ? []
    : character || steelHammerTitanic
      ? enhancements.filter((e) => !e.upgrade || upgradeFits(e))
      : enhancements.filter((e) => e.upgrade && upgradeFits(e));
  const canEnhance = list.combatPatrol ? cpEnh.length > 0 : offered.length > 0;
  const cpPicked = cpEnh.find((e) => e.id === unit.enhancementId);

  // Bodyguard units already in the list that this leader can attach to — from the datasheet's
  // Leader list, or granted by its enhancement (Exemplar of Duty → Ogryn/Bullgryn squads).
  const grantNames = leaderGrantTargets(unit.enhancementId);
  const attachTargets = list.units
    .filter((u) => {
      if (u.uid === unit.uid) return false;
      if ((ds.canLead ?? []).includes(u.datasheetId)) return true;
      return grantNames.includes((getDatasheet(u.datasheetId)?.name ?? '').toLowerCase());
    })
    .map((u) => ({ uid: u.uid, name: getDatasheet(u.datasheetId)?.name ?? u.datasheetId }));

  // Real, cap-aware wargear options for this unit's current model count. Options that share
  // items (e.g. the Sisters of Battle Squad's two boltgun swaps) render as one pooled group.
  // Default-wargear bearers (an imported list's export includes them) don't charge the caps.
  const wargearGroups = wargearOptionGroups(ds, unit.modelCount);
  const defaults = defaultLoadoutCounts(ds, unit.modelCount);

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
            {cpEnh.map((e) => (
              <option key={e.id} value={e.id} title={e.text}>
                {e.name}
              </option>
            ))}
            {offered.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} (+{e.cost}){e.upgrade ? ' · Upgrade' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {cpPicked && cpPicked.text && <p className="lu-note">{cpPicked.text}</p>}
      {extremis && (
        <p className="lu-note" title={extremis.description}>
          Extremis Sanction (Veiled Blade): has <strong>{extremis.name}</strong> — +{extremis.cost} pts, automatic.
        </p>
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

          {wargearGroups.map((group) => {
            const used = group.choices.reduce(
              (s, c) => s + Math.max(0, loadoutCount(unit.loadout, c.item) - loadoutCount(defaults, c.item)),
              0,
            );
            const over = !groupFits(group, unit.loadout ?? {}, defaults);
            const texts = Array.from(new Set(group.options.map((o) => o.text)));
            return (
              <div key={group.options[0]!.optionIndex} className={`lu-opt${over ? ' lu-opt-over' : ''}`}>
                <div className="lu-opt-text">
                  {texts.join(' / ')}
                  {group.options.length > 1 && (
                    <span title="This swap is listed more than once on the datasheet — the caps pool, but items only in one of the lists stay capped by that list.">
                      {' '}(×{group.options.length})
                    </span>
                  )}
                  <span className="lu-opt-cap">
                    {used}/{group.max} model{group.max === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="lu-choices">
                  {group.choices.map((c) => {
                    // An imported list's loadout keys can spell an item differently than the
                    // option data (casing/punctuation) — resolve to the actual stored key so the
                    // count and the steppers act on the imported entry.
                    const lkey =
                      Object.keys(unit.loadout ?? {}).find((k) => normalizeItemName(k) === normalizeItemName(c.item)) ??
                      c.item;
                    const count = loadoutCount(unit.loadout, c.item);
                    // One more of this item is only offered if some assignment of every pick to
                    // an option still fits the caps (items shared across options pool; items in
                    // a single option stay capped by it; default-wargear bearers don't charge).
                    const canAdd = groupFits(group, { ...unit.loadout, [lkey]: count + 1 }, defaults);
                    return (
                      <div key={c.item} className="lu-stepper">
                        <button
                          type="button"
                          className="lu-step"
                          disabled={count <= 0}
                          onClick={() => props.onLoadout(unit.uid, lkey, count - 1)}
                        >
                          −
                        </button>
                        <span className="lu-step-count">{count}</span>
                        <button
                          type="button"
                          className="lu-step"
                          disabled={!canAdd}
                          onClick={() => props.onLoadout(unit.uid, lkey, count + 1)}
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
