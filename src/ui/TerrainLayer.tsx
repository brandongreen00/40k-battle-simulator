import type { Layout } from '../core/types';
import { INCH_TO_PX, OWNER_COLOR, polygonPoints, pxLen, pxX, pxY, TERRAIN_STYLE } from './view';

interface Props {
  layout: Layout;
}

/** Static board: deployment zones, terrain polygons (colored by type), and objective markers. */
export function TerrainLayer({ layout }: Props) {
  const { boardWidth, boardHeight } = layout;
  // 40mm objective marker radius in inches -> px.
  const objR = pxLen(20 / 25.4);

  return (
    <g>
      {/* deployment zones (under everything) */}
      <polygon
        points={polygonPoints(layout.deploymentZones.player, boardHeight)}
        fill={`${OWNER_COLOR.player.fill}22`}
        stroke={`${OWNER_COLOR.player.fill}88`}
        strokeDasharray="6 4"
      />
      <polygon
        points={polygonPoints(layout.deploymentZones.opponent, boardHeight)}
        fill={`${OWNER_COLOR.ai.fill}22`}
        stroke={`${OWNER_COLOR.ai.fill}88`}
        strokeDasharray="6 4"
      />

      {/* 1" grid for measuring reference */}
      <g stroke="#ffffff" strokeOpacity={0.06} strokeWidth={1}>
        {Array.from({ length: boardWidth + 1 }, (_, i) => (
          <line key={`v${i}`} x1={pxX(i)} y1={0} x2={pxX(i)} y2={boardHeight * INCH_TO_PX} />
        ))}
        {Array.from({ length: boardHeight + 1 }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={pxY(i, boardHeight)} x2={boardWidth * INCH_TO_PX} y2={pxY(i, boardHeight)} />
        ))}
      </g>

      {/* terrain */}
      {layout.terrain.map((piece) => {
        const style = TERRAIN_STYLE[piece.type];
        return (
          <polygon
            key={piece.id}
            points={polygonPoints(piece.polygon, boardHeight)}
            fill={style.fill}
            stroke={style.stroke}
            strokeWidth={1.5}
          >
            <title>{`${piece.id} — ${style.label}`}</title>
          </polygon>
        );
      })}

      {/* objective markers */}
      {layout.objectives.map((o, i) => (
        <circle
          key={`obj${i}`}
          cx={pxX(o.x)}
          cy={pxY(o.y, boardHeight)}
          r={objR}
          fill="rgba(234, 179, 8, 0.25)"
          stroke="#eab308"
          strokeWidth={2}
        >
          <title>{`Objective (${o.x}", ${o.y}")`}</title>
        </circle>
      ))}
    </g>
  );
}
