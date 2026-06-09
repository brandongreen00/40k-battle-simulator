import type { Vec2 } from '../core/types';
import { pxX, pxY } from './view';

interface Props {
  from: Vec2; // inches
  to: Vec2; // inches
  label: string;
  boardHeight: number;
}

/** A dashed measuring tape between two points with a distance label at its midpoint. */
export function MeasureOverlay({ from, to, label, boardHeight }: Props) {
  const x1 = pxX(from.x);
  const y1 = pxY(from.y, boardHeight);
  const x2 = pxX(to.x);
  const y2 = pxY(to.y, boardHeight);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const w = label.length * 7.5 + 12;

  return (
    <g pointerEvents="none">
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fde047" strokeWidth={1.5} strokeDasharray="5 3" />
      <circle cx={x1} cy={y1} r={2.5} fill="#fde047" />
      <circle cx={x2} cy={y2} r={2.5} fill="#fde047" />
      <g transform={`translate(${mx - w / 2}, ${my - 11})`}>
        <rect width={w} height={18} rx={4} fill="#111827" stroke="#fde047" strokeWidth={1} />
        <text x={w / 2} y={13} textAnchor="middle" fill="#fde047" fontSize={12} fontFamily="monospace">
          {label}
        </text>
      </g>
    </g>
  );
}
