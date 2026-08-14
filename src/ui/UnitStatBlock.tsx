import type { Datasheet, ModelProfile, UnitInstance } from '../core/types';
import { availableUnitWeapons, unitDatasheetIds, type EngineContext } from '../core/engine';
import { OWNER_COLOR } from './view';

interface Props {
  unit: UnitInstance;
  datasheetsById: Map<string, Datasheet>;
  onClose: () => void;
}

/** Short human labels for the unit-status flags worth surfacing on the sheet. */
const STATUS_CHIPS: { key: keyof UnitInstance['status']; label: string; bad?: boolean }[] = [
  { key: 'battleShocked', label: 'Battle-shocked', bad: true },
  { key: 'moved', label: 'Moved' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'fellBack', label: 'Fell Back' },
  { key: 'remainedStationary', label: 'Stationary' },
  { key: 'hasShot', label: 'Has shot' },
  { key: 'charged', label: 'Charged' },
  { key: 'hasFought', label: 'Has fought' },
];

/**
 * The tap-a-unit stat block: everything you'd read off the printed datasheet for the unit you
 * just tapped on the map — profile line(s), weapons with their full profiles, abilities and
 * keywords — plus the live state (models left, wounds remaining, this turn's status flags).
 *
 * Read-only by design: it never dispatches an intent, so tapping a unit is always safe in any
 * phase. Built mobile-first — it sits under the board on the phone's Board page, caps its own
 * height and scrolls internally, and every row wraps instead of running off screen.
 */
export function UnitStatBlock({ unit, datasheetsById, onClose }: Props) {
  const ctx: EngineContext = { datasheets: datasheetsById };
  const ds = datasheetsById.get(unit.datasheetId);
  const name = ds?.name ?? unit.datasheetId;
  const alive = unit.models.filter((m) => m.alive);
  const dsIds = unitDatasheetIds(unit);

  // Alive models per datasheet (a merged Leader keeps its own profile within the unit).
  const aliveOf = (dsId: string) =>
    unit.models.filter((m) => m.alive && (m.datasheetId ?? unit.datasheetId) === dsId).length;

  // Wounds remaining across the unit vs its full-health total (per-model max from its profile).
  const maxW = (m: (typeof unit.models)[number]) =>
    datasheetsById.get(m.datasheetId ?? unit.datasheetId)?.models[0]?.W ?? 0;
  const woundsLeft = alive.reduce((s, m) => s + m.wounds, 0);
  const woundsFull = alive.reduce((s, m) => s + maxW(m), 0);

  const weapons = availableUnitWeapons(unit, ctx);
  const ranged = weapons.filter((w) => w.weapon.type === 'ranged');
  const melee = weapons.filter((w) => w.weapon.type === 'melee');

  const abilities = dsIds.flatMap((id) =>
    (datasheetsById.get(id)?.abilities ?? []).map((a) => ({ ...a, dsId: id })),
  );
  const keywords = [...new Set(dsIds.flatMap((id) => datasheetsById.get(id)?.keywords ?? []))];

  const statRow = (p: ModelProfile, label: string | null) => (
    <div className="sb-statrow" key={`${label ?? ''}-${p.name}`}>
      {label && <span className="sb-proflabel">{label}</span>}
      <span><b>M</b> {p.M}"</span>
      <span><b>T</b> {p.T}</span>
      <span><b>Sv</b> {p.Sv}+</span>
      {p.invuln ? <span className="inv"><b>Inv</b> {p.invuln}++</span> : null}
      <span><b>W</b> {p.W}</span>
      <span><b>Ld</b> {p.Ld}+</span>
      <span><b>OC</b> {p.OC}</span>
    </div>
  );

  return (
    <div className="statblock">
      <div className="sb-head">
        <span className="sb-dot" style={{ background: OWNER_COLOR[unit.owner].fill }} aria-hidden />
        <span className="sb-title">
          {name} <span className="muted">×{alive.length}/{unit.startingModels}</span>
        </span>
        <button type="button" className="sb-close" onClick={onClose} aria-label="Close stat block">
          ✕
        </button>
      </div>

      <div className="sb-chips">
        <span className="sb-chip side">{unit.owner === 'player' ? 'player' : 'ai'} side</span>
        {woundsFull > 0 && (
          <span className={`sb-chip${woundsLeft < woundsFull ? ' hurt' : ''}`}>
            {woundsLeft}/{woundsFull} wounds
          </span>
        )}
        {STATUS_CHIPS.filter((c) => unit.status[c.key]).map((c) => (
          <span key={c.label} className={`sb-chip${c.bad ? ' hurt' : ''}`}>{c.label}</span>
        ))}
      </div>

      {dsIds.map((id) => {
        const d = datasheetsById.get(id);
        if (!d) return null;
        // Multi-datasheet units (a merged Leader) label each block; a plain unit needs no label.
        const heading = dsIds.length > 1 ? `${d.name} ×${aliveOf(id)}` : null;
        return (
          <div className="sb-profile" key={id}>
            {heading && <p className="sb-sub">{heading}</p>}
            {d.models.map((p) => statRow(p, d.models.length > 1 ? p.name : null))}
          </div>
        );
      })}

      {ranged.length > 0 && (
        <div className="sb-weapons">
          <p className="sb-sub">Ranged weapons</p>
          {ranged.map((w) => (
            <div className="sb-w" key={`r-${w.sourceDsId}|${w.weapon.name}`}>
              <span className="sb-wname">{w.carriers}× {w.weapon.name}</span>
              <span className="sb-wstats">
                {w.weapon.range}" · A{w.weapon.attacks} · BS {w.weapon.skill}+ · S{w.weapon.S} · AP{w.weapon.AP} · D{w.weapon.D}
              </span>
              {w.weapon.keywords.length > 0 && <span className="sb-wkw">[{w.weapon.keywords.join(', ')}]</span>}
            </div>
          ))}
        </div>
      )}

      {melee.length > 0 && (
        <div className="sb-weapons">
          <p className="sb-sub">Melee weapons</p>
          {melee.map((w) => (
            <div className="sb-w" key={`m-${w.sourceDsId}|${w.weapon.name}`}>
              <span className="sb-wname">{w.carriers}× {w.weapon.name}</span>
              <span className="sb-wstats">
                A{w.weapon.attacks} · WS {w.weapon.skill}+ · S{w.weapon.S} · AP{w.weapon.AP} · D{w.weapon.D}
              </span>
              {w.weapon.keywords.length > 0 && <span className="sb-wkw">[{w.weapon.keywords.join(', ')}]</span>}
            </div>
          ))}
        </div>
      )}

      {abilities.length > 0 && (
        <div className="sb-abilities">
          <p className="sb-sub">Abilities</p>
          {abilities.map((a, i) => (
            // Tap the name to read the rule (phones have no hover, so text is never a tooltip).
            <details key={`${a.dsId}-${a.name}-${i}`} className="sb-ability">
              <summary>
                {a.name}
                {a.parameter ? ` ${a.parameter}` : ''}
                {a.type ? <span className="muted"> · {a.type}</span> : null}
              </summary>
              <p>{a.description}</p>
            </details>
          ))}
        </div>
      )}

      {keywords.length > 0 && <p className="sb-keywords">{keywords.join(' · ')}</p>}
    </div>
  );
}
