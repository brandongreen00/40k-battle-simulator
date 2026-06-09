import type { Layout } from '../core/types';
import { INCH_TO_PX, OWNER_COLOR, polygonPoints, pxLen, pxX, pxY, TERRAIN_STYLE } from './view';

interface Props {
  layout: Layout;
}

/** Static board: deployment zones, terrain polygons (colored by type), and objective markers. */
export function TerrainLayer({ layout }: Props) {
  const { boardWidth, boardHeight } = layout;
  // Objective marker radius (40mm marker) and 3" horizontal control range, in px.
  const objR = pxLen((layout.objectiveMarkerDiameterIn ?? 40 / 25.4) / 2);
  const controlR = pxLen(layout.objectiveControlRadiusIn ?? 3);

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

      {/* objective markers: 3" control-range ring + 40mm marker */}
      {layout.objectives.map((o, i) => {
        const cx = pxX(o.x);
        const cy = pxY(o.y, boardHeight);
        return (
          <g key={`obj${i}`}>
            <circle
              cx={cx}
              cy={cy}
              r={controlR}
              fill="rgba(234, 179, 8, 0.07)"
              stroke="#eab308"
              strokeOpacity={0.45}
              strokeDasharray="4 4"
            >
              <title>{`Objective control range — 3" (centre ${o.x}", ${o.y}")`}</title>
            </circle>
            <circle cx={cx} cy={cy} r={objR} fill="rgba(234, 179, 8, 0.3)" stroke="#eab308" strokeWidth={2}>
              <title>{`Objective marker — 40mm (${o.x}", ${o.y}")`}</title>
            </circle>
          </g>
        );
      })}
    </g>
  );
}
