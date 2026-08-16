import { useEffect, useMemo, useRef, useState } from 'react';
import type { BattleLog, BoardSnapshot, LogFrame } from './artifacts';
import { checkLogVersion } from './artifacts';

/**
 * Battle-log replay (brief §11).
 *
 * Pure log playback: the viewer never computes a rule, it draws what the engine
 * recorded. Board snapshots are emitted at phase boundaries, so a frame without
 * one inherits the most recent board — that is what keeps logs small.
 */

const PX_PER_INCH = 9;

interface Props {
  log: BattleLog;
  onClose?: () => void;
}

export function ReplayViewer({ log, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(400);
  const timer = useRef<number | null>(null);

  const frames = log.frames ?? [];
  const versionWarning = checkLogVersion(log.log_schema_version);
  const frame: LogFrame | undefined = frames[Math.min(index, frames.length - 1)];

  // The latest board at or before the current frame.
  const board: BoardSnapshot | undefined = useMemo(() => {
    for (let i = Math.min(index, frames.length - 1); i >= 0; i--) {
      if (frames[i].board) return frames[i].board;
    }
    return undefined;
  }, [frames, index]);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setIndex((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, speed);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, speed, frames.length]);

  if (!frame) return <p className="ap-empty">This battle log has no frames.</p>;

  const layout = log.meta.layout;
  const W = layout.width * PX_PER_INCH;
  const H = layout.height * PX_PER_INCH;
  const flip = (y: number) => H - y * PX_PER_INCH;   // board origin is bottom-left

  return (
    <div className="ap-replay">
      <div className="ap-replay-head">
        <div>
          <strong>{log.meta.armies[0]}</strong> vs <strong>{log.meta.armies[1]}</strong>
          <span className="ap-dim">
            {' '}· {log.meta.battle_size}pts · seed {log.seed} · {layout.id}
          </span>
        </div>
        {onClose && (
          <button className="ap-ghost" onClick={onClose}>
            ✕ close
          </button>
        )}
      </div>

      {versionWarning && <p className="ap-warn">⚠ {versionWarning}</p>}

      <div className="ap-replay-body">
        <svg
          className="ap-board"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="battlefield replay"
        >
          <rect x={0} y={0} width={W} height={H} className="ap-ground" />

          {Object.entries(layout.deployment_zones ?? {}).map(([side, polys]) =>
            polys.map((poly, i) => (
              <polygon
                key={`${side}-${i}`}
                className={`ap-zone ap-zone-${side}`}
                points={poly.map(([x, y]) => `${x * PX_PER_INCH},${flip(y)}`).join(' ')}
              />
            )),
          )}

          {layout.terrain.map((t) => (
            <polygon
              key={t.id}
              className={`ap-terrain ap-terrain-${t.category}`}
              points={t.polygon.map(([x, y]) => `${x * PX_PER_INCH},${flip(y)}`).join(' ')}
            />
          ))}

          {layout.objectives.map((o) => {
            const holder = board?.objectives?.[o.id];
            return (
              <g key={o.id}>
                <circle
                  cx={o.pos[0] * PX_PER_INCH}
                  cy={flip(o.pos[1])}
                  r={3 * PX_PER_INCH}
                  className={
                    holder === 0 ? 'ap-obj-range p0'
                      : holder === 1 ? 'ap-obj-range p1' : 'ap-obj-range'
                  }
                />
                <circle
                  cx={o.pos[0] * PX_PER_INCH}
                  cy={flip(o.pos[1])}
                  r={0.79 * PX_PER_INCH}
                  className="ap-obj"
                />
              </g>
            );
          })}

          {(board?.units ?? []).map((u) =>
            u.models.map((m, i) => (
              <circle
                key={`${u.uid}-${i}`}
                cx={m.x * PX_PER_INCH}
                cy={flip(m.y)}
                r={Math.max(2, m.r * PX_PER_INCH)}
                className={`ap-model p${u.owner}${u.shocked ? ' shocked' : ''}`}
              >
                <title>{`${u.name} (${m.w}W)`}</title>
              </circle>
            )),
          )}
        </svg>

        <aside className="ap-replay-side">
          <div className="ap-scoreline">
            <span className="p0">
              {log.meta.armies[0]}: <strong>{frame.vp?.[0] ?? 0}</strong> VP
              <span className="ap-dim"> · {frame.cp?.[0] ?? 0} CP</span>
            </span>
            <span className="p1">
              {log.meta.armies[1]}: <strong>{frame.vp?.[1] ?? 0}</strong> VP
              <span className="ap-dim"> · {frame.cp?.[1] ?? 0} CP</span>
            </span>
          </div>
          <p className="ap-dim ap-missions">
            Primary: {log.meta.primaries[0]} / {log.meta.primaries[1]}
            <br />
            Disposition: {log.meta.dispositions[0]} / {log.meta.dispositions[1]}
          </p>

          <div className="ap-turnline">
            Round <strong>{frame.round}</strong> · {frame.phase} ·{' '}
            <span className={`p${frame.active}`}>{log.meta.armies[frame.active]}</span>
          </div>

          <div className="ap-feed">
            {frames
              .slice(Math.max(0, index - 14), index + 1)
              .reverse()
              .map((f) => (
                <div key={f.t} className={f.t === frame.t ? 'ap-feed-row now' : 'ap-feed-row'}>
                  <span className="ap-dim">r{f.round}</span> {f.action.label || f.action.kind}
                  {f.events
                    .filter((e) => ['shoot', 'fight', 'vp', 'unit_destroyed', 'charge',
                      'battle_shock', 'stratagem', 'order'].includes(String(e.kind)))
                    .map((e, i) => (
                      <span key={i} className="ap-event">
                        {describeEvent(e)}
                      </span>
                    ))}
                </div>
              ))}
          </div>
        </aside>
      </div>

      <div className="ap-transport">
        <button className="ap-ghost" onClick={() => setIndex(0)} aria-label="restart">⏮</button>
        <button className="ap-ghost" onClick={() => setIndex((i) => Math.max(0, i - 1))}>◀</button>
        <button className="ap-primary" onClick={() => setPlaying((p) => !p)}>
          {playing ? '⏸ pause' : '▶ play'}
        </button>
        <button
          className="ap-ghost"
          onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))}
        >
          ▶
        </button>
        <button className="ap-ghost" onClick={() => setIndex(frames.length - 1)}>⏭</button>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          aria-label="frame"
        />
        <span className="ap-dim">
          {index + 1}/{frames.length}
        </span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="speed">
          <option value={800}>0.5×</option>
          <option value={400}>1×</option>
          <option value={160}>2.5×</option>
          <option value={60}>7×</option>
        </select>
      </div>

      {index >= frames.length - 1 && (
        <p className="ap-result">
          Final {log.result.vp[0]} : {log.result.vp[1]} —{' '}
          {log.result.winner === null
            ? 'draw'
            : `${log.meta.armies[log.result.winner]} wins`}{' '}
          <span className="ap-dim">
            (primary {log.result.primary.join('/')} · secondary {log.result.secondary.join('/')}
            {' '}· battle ready {log.result.battle_ready.join('/')})
          </span>
        </p>
      )}
    </div>
  );
}

function describeEvent(e: Record<string, unknown>): string {
  switch (e.kind) {
    case 'shoot':
      return ` 🎯 ${e.slain ?? 0} slain`;
    case 'fight':
      return ` ⚔ ${e.slain ?? 0} slain`;
    case 'charge':
      return ' ➜ charge!';
    case 'unit_destroyed':
      return ` ☠ ${e.name ?? ''}`;
    case 'vp':
      return ` +${e.vp}VP (${e.vp_kind})`;
    case 'battle_shock':
      return e.passed ? ' ✓ shock passed' : ' ✗ battle-shocked';
    case 'stratagem':
      return ` ⚡ ${e.name ?? ''}`;
    case 'order':
      return ` 📣 ${e.name ?? ''}`;
    default:
      return '';
  }
}
