import type { Layout, OperationMarker, Vec2 } from '../core/types';
import { INCH_TO_PX, OWNER_COLOR, polygonPoints, pxLen, pxX, pxY, TERRAIN_STYLE } from './view';
import { pointInPolygon } from '../core/geometry';

interface Props {
  layout: Layout;
  /** Operation markers placed by 11e mission rules (rendered as small flags). */
  markers?: OperationMarker[];
}

const AREA_FILL = 'rgba(148, 148, 140, 0.30)';
const AREA_STROKE = 'rgba(210, 210, 200, 0.55)';
const DENSE_FILL = 'rgba(13, 110, 90, 0.55)';
const DENSE_STROKE = '#0d6e5a';
const LIGHT_FILL = 'rgba(201, 162, 39, 0.5)';
const LIGHT_STROKE = '#c9a227';

const OBJ_COLOR: Record<'home' | 'central' | 'expansion', string> = {
  home: '#eab308',
  central: '#22c55e',
  expansion: '#a855f7',
};

/** Static board: deployment zones, terrain (10e pieces or 11e areas+features), objectives. */
export function TerrainLayer({ layout, markers }: Props) {
  const { boardWidth, boardHeight } = layout;
  const objR = pxLen((layout.objectiveMarkerDiameterIn ?? 40 / 25.4) / 2);
  const controlR = pxLen(layout.objectiveControlRadiusIn ?? 3);
  const is11e = !!layout.terrainAreas?.length;

  /** The side whose zone contains a point (colours the home objectives after the zone swap). */
  const zoneSideOf = (p: Vec2): 'player' | 'ai' | null => {
    if (layout.deploymentZones.player.length && pointInPolygon(p, layout.deploymentZones.player)) return 'player';
    if (layout.deploymentZones.opponent.length && pointInPolygon(p, layout.deploymentZones.opponent)) return 'ai';
    return null;
  };

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

      {is11e ? (
        <>
          {/* 11e terrain areas (the rules boundaries) with their dense/light features */}
          {layout.terrainAreas!.map((a) => (
            <g key={a.id}>
              <polygon
                points={polygonPoints(a.polygon, boardHeight)}
                fill={AREA_FILL}
                stroke={AREA_STROKE}
                strokeWidth={1.5}
              >
                <title>{`Terrain area ${a.id}${a.groupId ? ` (grouped: ${a.groupId})` : ''}`}</title>
              </polygon>
              {a.features.map((f, i) => (
                <polygon
                  key={i}
                  points={polygonPoints(f.polygon, boardHeight)}
                  fill={f.kind === 'dense' ? DENSE_FILL : LIGHT_FILL}
                  stroke={f.kind === 'dense' ? DENSE_STROKE : LIGHT_STROKE}
                  strokeWidth={1.5}
                >
                  <title>{`${f.kind === 'dense' ? 'Dense' : 'Light'} terrain${f.letter ? ` (${f.letter})` : ''} — ${
                    f.kind === 'dense' ? 'blocks sight (Solid), grants Hidden' : 'obscuring, cover'
                  }`}</title>
                </polygon>
              ))}
            </g>
          ))}

          {/* territory divider */}
          {layout.territoryDivider && (
            <line
              x1={pxX(layout.territoryDivider[0].x)}
              y1={pxY(layout.territoryDivider[0].y, boardHeight)}
              x2={pxX(layout.territoryDivider[1].x)}
              y2={pxY(layout.territoryDivider[1].y, boardHeight)}
              stroke="#e5e7eb"
              strokeOpacity={0.5}
              strokeWidth={2}
              strokeDasharray="3 7"
            >
              <title>Territory divider (Attacker's / Defender's territory)</title>
            </line>
          )}

          {/* typed objectives: terrain objectives outline their area; markers get the 3" ring */}
          {(layout.objectivePoints ?? []).map((o, i) => {
            const cx = pxX(o.pos.x);
            const cy = pxY(o.pos.y, boardHeight);
            const colour =
              o.kind === 'home' ? OWNER_COLOR[zoneSideOf(o.pos) ?? 'player'].fill : OBJ_COLOR[o.kind];
            const area = o.areaId ? layout.terrainAreas!.find((a) => a.id === o.areaId) : undefined;
            const label = `${o.kind === 'home' ? 'Home' : o.kind === 'central' ? 'Central' : 'Expansion'} objective${
              area ? ` — the whole terrain area ${area.id} is the objective` : ' (40mm marker, 3" range)'
            }`;
            return (
              <g key={`obj${i}`}>
                {area ? (
                  <polygon
                    points={polygonPoints(area.polygon, boardHeight)}
                    fill="none"
                    stroke={colour}
                    strokeWidth={2.5}
                    strokeDasharray="8 5"
                    strokeOpacity={0.9}
                  >
                    <title>{label}</title>
                  </polygon>
                ) : (
                  <circle cx={cx} cy={cy} r={controlR} fill={`${colour}11`} stroke={colour} strokeOpacity={0.45} strokeDasharray="4 4">
                    <title>{label}</title>
                  </circle>
                )}
                <circle cx={cx} cy={cy} r={objR} fill={`${colour}55`} stroke={colour} strokeWidth={2}>
                  <title>{label}</title>
                </circle>
                {o.kind === 'expansion' && (
                  <rect
                    x={cx - objR * 0.55}
                    y={cy - objR * 0.55}
                    width={objR * 1.1}
                    height={objR * 1.1}
                    transform={`rotate(45 ${cx} ${cy})`}
                    fill="none"
                    stroke={colour}
                    strokeWidth={1.5}
                  />
                )}
                {o.kind === 'home' && (
                  <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fill="#fff" pointerEvents="none">⌂</text>
                )}
              </g>
            );
          })}
        </>
      ) : (
        <>
          {/* 10e terrain pieces */}
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
        </>
      )}

      {/* Operation markers (11e mission rules) */}
      {(markers ?? []).map((m, i) => {
        const cx = pxX(m.pos.x);
        const cy = pxY(m.pos.y, boardHeight);
        return (
          <g key={`opm${i}`}>
            <circle cx={cx} cy={cy} r={6} fill={OWNER_COLOR[m.side].fill} stroke="#111" strokeWidth={1.5} />
            <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={9} fill="#fff" pointerEvents="none">◆</text>
            <title>{`${m.side} operation marker`}</title>
          </g>
        );
      })}
    </g>
  );
}
