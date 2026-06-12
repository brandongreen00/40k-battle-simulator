import type { Side } from '../core/types';
import { AI_PROFILES } from '../core/ai/profile';
import { OWNER_COLOR } from './view';

export interface AiSeat {
  enabled: boolean;
  profile: string;
}
export type AiSeats = Record<Side, AiSeat>;

interface Props {
  seats: AiSeats;
  onSeats: (s: AiSeats) => void;
  auto: boolean;
  onAuto: (v: boolean) => void;
  /** Take exactly one AI action now (enabled when an AI seat is on and it's its decision). */
  onStep: () => void;
  canStep: boolean;
  /** Last AI action description, for the human to follow along. */
  note: string;
  /** True while a match/setup is live (the bar hides itself on the free sandbox board). */
  active: boolean;
}

/**
 * Seat controls for the AI: who is a human and who is the computer, with a profile per AI seat.
 * Both sides AI = a watchable AI-vs-AI game (auto-play steps it; Step single-steps it).
 */
export function AiBar({ seats, onSeats, auto, onAuto, onStep, canStep, note, active }: Props) {
  if (!active) return null;
  const profiles = Object.keys(AI_PROFILES);
  const set = (side: Side, patch: Partial<AiSeat>) => onSeats({ ...seats, [side]: { ...seats[side], ...patch } });

  return (
    <section className="game-panel ai-bar">
      <h2>Players</h2>
      {(['player', 'ai'] as const).map((side) => (
        <div className="ai-seat" key={side}>
          <span className="ai-side" style={{ color: OWNER_COLOR[side].fill }}>{side}</span>
          <div className="seg">
            <button className={seats[side].enabled ? '' : 'seg-on'} onClick={() => set(side, { enabled: false })}>
              Human
            </button>
            <button className={seats[side].enabled ? 'seg-on' : ''} onClick={() => set(side, { enabled: true })}>
              AI
            </button>
          </div>
          {seats[side].enabled && (
            <select value={seats[side].profile} onChange={(e) => set(side, { profile: e.target.value })} title="AI personality">
              {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </div>
      ))}
      {(seats.player.enabled || seats.ai.enabled) && (
        <div className="btnrow">
          <button className={auto ? 'seg-on' : ''} onClick={() => onAuto(!auto)}>
            {auto ? '⏸ Auto-play on' : '▶ Auto-play off'}
          </button>
          <button onClick={onStep} disabled={!canStep} title="Take one AI action">
            Step
          </button>
        </div>
      )}
      {note && <p className="hint ai-note">🤖 {note}</p>}
    </section>
  );
}
