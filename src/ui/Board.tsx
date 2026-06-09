import { useMemo, useRef, useState, type PointerEvent } from 'react';
import type { BaseShape, Datasheet, Layout, ModelInstance, Side, UnitInstance, Vec2 } from '../core/types';
import { baseRadius, baseToBaseGap, dist, gapBetweenBases } from '../core/geometry';
import { INCH_TO_PX } from './view';
import { TerrainLayer } from './TerrainLayer';
import { ModelToken } from './ModelToken';
import { MeasureOverlay } from './MeasureOverlay';

interface Props {
  layout: Layout;
  units: UnitInstance[];
  datasheetsById: Map<string, Datasheet>;
  onMoveModel: (modelId: string, pos: Vec2) => void;
}

const FALLBACK_SHAPE: BaseShape = { kind: 'circle', radius: 0.63 };

interface Resolved {
  model: ModelInstance;
  shape: BaseShape;
  owner: Side;
  unitName: string;
}

export function Board({ layout, units, datasheetsById, onMoveModel }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const widthPx = layout.boardWidth * INCH_TO_PX;
  const heightPx = layout.boardHeight * INCH_TO_PX;

  // model id -> resolved render/measure info
  const index = useMemo(() => {
    const map = new Map<string, Resolved>();
    for (const u of units) {
      const ds = datasheetsById.get(u.datasheetId);
      const shape = ds?.baseShape ?? FALLBACK_SHAPE;
      for (const m of u.models) {
        map.set(m.id, { model: m, shape, owner: u.owner, unitName: ds?.name ?? u.datasheetId });
      }
    }
    return map;
  }, [units, datasheetsById]);

  function clientToInches(e: PointerEvent): Vec2 {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const sx = rect.width / widthPx;
    const sy = rect.height / heightPx;
    const px = (e.clientX - rect.left) / sx;
    const py = (e.clientY - rect.top) / sy;
    return { x: px / INCH_TO_PX, y: layout.boardHeight - py / INCH_TO_PX };
  }

  function selectModel(id: string) {
    setSelectedIds((prev) => (prev.length === 1 && prev[0] !== id ? [prev[0], id] : [id]));
  }

  function handleTokenDown(modelId: string, e: PointerEvent<SVGElement>) {
    e.stopPropagation();
    selectModel(modelId);
    setDragId(modelId);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    const pos = clientToInches(e);
    setCursor(pos);
    if (dragId) onMoveModel(dragId, pos);
  }

  function handlePointerUp(e: PointerEvent) {
    setDragId(null);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
  }

  // ── measurement ──
  const a = selectedIds[0] ? index.get(selectedIds[0]) : undefined;
  const b = selectedIds[1] ? index.get(selectedIds[1]) : undefined;

  let measure: { from: Vec2; to: Vec2; gap: number; centre: number } | null = null;
  if (a && b) {
    measure = {
      from: a.model.pos,
      to: b.model.pos,
      gap: gapBetweenBases(a.model.pos, a.shape, b.model.pos, b.shape),
      centre: dist(a.model.pos, b.model.pos),
    };
  } else if (a && cursor) {
    measure = {
      from: a.model.pos,
      to: cursor,
      gap: baseToBaseGap(a.model.pos, baseRadius(a.shape), cursor, 0),
      centre: dist(a.model.pos, cursor),
    };
  }

  const hud = measure
    ? a && b
      ? `${a.unitName} → ${b.unitName}: ${measure.gap.toFixed(2)}" base-to-base (${measure.centre.toFixed(2)}" centre)`
      : `${a!.unitName} → cursor: ${measure.gap.toFixed(2)}" to base edge`
    : 'Click a model to select; click a second to measure between them. Drag to move.';

  return (
    <div className="board-wrap">
      <div className="board-hud">{hud}</div>
      <svg
        ref={svgRef}
        className="board-svg"
        viewBox={`0 0 ${widthPx} ${heightPx}`}
        width={widthPx}
        height={heightPx}
        style={{ touchAction: 'none' }}
        onPointerDown={() => setSelectedIds([])}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setCursor(null)}
      >
        <rect x={0} y={0} width={widthPx} height={heightPx} fill="#1f2430" stroke="#3a4150" strokeWidth={2} />
        <TerrainLayer layout={layout} />

        {units.map((u) =>
          u.models.map((m) => {
            const r = index.get(m.id)!;
            return (
              <ModelToken
                key={m.id}
                model={m}
                shape={r.shape}
                owner={r.owner}
                selected={selectedIds.includes(m.id)}
                boardHeight={layout.boardHeight}
                onPointerDown={handleTokenDown}
              />
            );
          }),
        )}

        {measure && (
          <MeasureOverlay
            from={measure.from}
            to={measure.to}
            label={`${measure.gap.toFixed(2)}"`}
            boardHeight={layout.boardHeight}
          />
        )}
      </svg>
    </div>
  );
}
