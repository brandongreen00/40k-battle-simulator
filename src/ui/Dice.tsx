// SVG dice — rendered as proper pip faces so roll-offs (and any 2D6 test) read at a glance.

const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.5], [0.72, 0.5], [0.28, 0.72], [0.72, 0.72]],
};

interface DieProps {
  value: number;
  size?: number;
  /** Accent colour for the die body (e.g. the owner colour). */
  color?: string;
  highlight?: boolean;
}

/** A single D6 face. `value` 1..6; values outside that render blank. */
export function Die({ value, size = 34, color = '#e7e9ee', highlight = false }: DieProps) {
  const pips = PIPS[value] ?? [];
  const r = size * 0.09;
  return (
    <svg width={size} height={size} viewBox="0 0 1 1" className={`die${highlight ? ' die-hi' : ''}`} aria-label={`die showing ${value}`}>
      <rect x={0.03} y={0.03} width={0.94} height={0.94} rx={0.16} ry={0.16} fill={color} stroke="#11141b" strokeWidth={0.04} />
      {pips.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={r / size} fill="#11141b" />
      ))}
    </svg>
  );
}

interface RollOffProps {
  player: number;
  ai: number;
  winner: 'player' | 'ai';
  label?: string;
}

/** A pair of dice with the winner highlighted — used for the deployment roll-offs. */
export function RollOffDice({ player, ai, winner, label }: RollOffProps) {
  return (
    <div className="rolloff">
      {label && <span className="rolloff-label">{label}</span>}
      <div className="rolloff-dice">
        <span className={`rolloff-side${winner === 'player' ? ' won' : ''}`}>
          <Die value={player} color="#3b82f6" highlight={winner === 'player'} />
          <em>player</em>
        </span>
        <span className="rolloff-vs">vs</span>
        <span className={`rolloff-side${winner === 'ai' ? ' won' : ''}`}>
          <Die value={ai} color="#ef4444" highlight={winner === 'ai'} />
          <em>ai</em>
        </span>
      </div>
    </div>
  );
}
