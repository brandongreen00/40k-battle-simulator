import type { Datasheet, GameState, UnitInstance } from '../core/types';
import { baseRadius } from '../core/geometry';
import { objectivePoints, withinObjectiveRange } from '../core/missions11';
import { OWNER_COLOR } from './view';

/** The two halves of the Imperialis Fleet "At all Costs" detachment rule (Command phase). */
export type AtacKind = 'eliminate' | 'acquire';

/** An armed At All Costs pick: the chosen action, and (once tapped) the unit awaiting Confirm. */
export interface AtacPick {
  kind: AtacKind;
  unitId?: string;
}

export const ATAC_META: Record<
  AtacKind,
  { icon: string; name: string; desc: string; intentName: string; effectId: string }
> = {
  eliminate: {
    icon: '🎯',
    name: 'Eliminate',
    desc: 'your army adds 1 to Hit rolls against it this turn',
    intentName: 'Eliminate At All Costs',
    effectId: 'mark_eliminate',
  },
  acquire: {
    icon: '🛡️',
    name: 'Acquire',
    desc: 'it gains a 5+ invulnerable save and +1 OC/Ld',
    intentName: 'Acquire At All Costs',
    effectId: 'acquire_buff',
  },
};

/** Does any alive model of the unit stand within objective range (area-aware on 11e maps)?
 *  Advisory only — Acquire's "on an objective" wording is surfaced as a warning, never a block. */
export function unitOnObjective(state: GameState, unit: UnitInstance, datasheetsById: Map<string, Datasheet>): boolean {
  const shape = datasheetsById.get(unit.datasheetId)?.baseShape;
  const r = shape ? baseRadius(shape) : 0.63;
  return objectivePoints(state.layout).some((o) =>
    unit.models.some((m) => m.alive && withinObjectiveRange(m.pos, r, o, state.layout)),
  );
}

/**
 * The confirmation bar for an armed At All Costs pick. Lives directly UNDER the board (the
 * proven ShootingBar slot), so on a phone the whole flow — arm, tap the unit, confirm — happens
 * on the Board page. Nothing is dispatched until ✓ Confirm.
 */
export function AtAllCostsBar({
  state,
  pick,
  datasheetsById,
  onClearUnit,
  onConfirm,
  onCancel,
}: {
  state: GameState;
  pick: AtacPick;
  datasheetsById: Map<string, Datasheet>;
  /** Back to "tap a unit" (keeps the armed action). */
  onClearUnit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const meta = ATAC_META[pick.kind];
  const unit = pick.unitId ? state.units.find((u) => u.id === pick.unitId) : undefined;
  const name = unit ? datasheetsById.get(unit.datasheetId)?.name ?? unit.id : '';
  const offObjective = pick.kind === 'acquire' && unit && !unitOnObjective(state, unit, datasheetsById);
  return (
    <div className="atac-bar" data-kind={pick.kind}>
      {!unit ? (
        <>
          <span className="atac-info">
            {meta.icon} <strong>{meta.name} at all costs</strong> — tap{' '}
            {pick.kind === 'eliminate' ? 'an enemy unit' : 'one of your units on an objective'} on the board
          </span>
          <button onClick={onCancel}>✕ Cancel</button>
        </>
      ) : (
        <>
          <span className="atac-info">
            {meta.icon} <strong>{meta.name}</strong>{' '}
            <span className="atac-dot" style={{ background: OWNER_COLOR[unit.owner].fill }} />{' '}
            <strong>{name}</strong> — {meta.desc}
            {offObjective && <span className="warn"> · ⚠ not within range of an objective</span>}
          </span>
          <button className="ok" onClick={onConfirm}>✓ Confirm</button>
          <button onClick={onClearUnit}>↺ Pick another</button>
          <button onClick={onCancel}>✕ Cancel</button>
        </>
      )}
    </div>
  );
}
