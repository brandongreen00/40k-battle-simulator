import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { BaseShape, Datasheet, Layout, ModelInstance, Side, UnitInstance, Vec2 } from '../core/types';
import { baseRadius, baseToBaseGap, dist, gapBetweenBases } from '../core/geometry';
import { formationPositions, FORMATION_LABEL, type Formation } from '../core/formation';
import { INCH_TO_PX, OWNER_COLOR, pxLen, pxX, pxY } from './view';
import { TerrainLayer } from './TerrainLayer';
import { ModelToken } from './ModelToken';
import { MeasureOverlay } from './MeasureOverlay';

/** A unit being placed: the ghost follows the cursor until the user clicks to commit. */
export interface Placement {
  baseShape: BaseShape;
  modelCount: number;
  owner: Side;
  formation: Formation;
  rotation: number;
  /** Optional legality predicate (deployment zone / Infiltrators). Red ghost + no-drop when false. */
  legal?: (positions: Vec2[]) => boolean;
}

const ROTATE_STEP = Math.PI / 12; // 15° per scroll notch / R keypress

/** Movement-phase interaction: drag-box select, group nudge, and coherency warnings. */
export interface MovementUI {
  selectedUnitIds: string[];
  /** Units mid-activation (BeginMove) — dragging any of their models nudges them as a group. */
  movingUnitIds: string[];
  onSelectUnits: (unitIds: string[], additive: boolean) => void;
  /** Incremental translate of the moving units (delta since the last pointer event), inches. */
  onGroupNudge: (delta: Vec2) => void;
  /** Units (centroids) currently out of coherency — a warning triangle hovers over each. */
  warnings: { unitId: string; centroid: Vec2 }[];
}

interface Props {
  layout: Layout;
  units: UnitInstance[];
  datasheetsById: Map<string, Datasheet>;
  onMoveModel: (modelId: string, pos: Vec2) => void;
  /** When set, the board is in deployment-placement mode (ghost preview). */
  placement?: Placement | null;
  onPlacementCommit?: (anchor: Vec2) => void;
  onPlacementRotate?: (deltaRadians: number) => void;
  onPlacementCycle?: () => void;
  onPlacementCancel?: () => void;
  /** When set, the board is in Movement-phase mode (select + group move + coherency). */
  movement?: MovementUI | null;
}

const FALLBACK_SHAPE: BaseShape = { kind: 'circle', radius: 0.63 };

interface Resolved {
  model: ModelInstance;
  shape: BaseShape;
  owner: Side;
  unitId: string;
  unitName: string;
}

export function Board({
  layout,
  units,
  datasheetsById,
  onMoveModel,
  placement,
  onPlacementCommit,
  onPlacementRotate,
  onPlacementCycle,
  onPlacementCancel,
  movement,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // Movement mode: rubber-band selection + group drag.
  const [selectBox, setSelectBox] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const groupDrag = useRef<Vec2 | null>(null); // last cursor pos during a group nudge

  // Scroll rotates the ghost; bound natively so we can preventDefault the page scroll
  // (React's onWheel is passive and cannot). Only active while placing.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !placement) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onPlacementRotate?.(Math.sign(e.deltaY) * ROTATE_STEP);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [placement, onPlacementRotate]);

  // `c` cycles the formation; `r`/`R` nudge rotation; Esc cancels. Only while placing.
  useEffect(() => {
    if (!placement) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        onPlacementCycle?.();
      } else if (e.key === 'Escape') {
        onPlacementCancel?.();
      } else if (e.key === 'r') {
        onPlacementRotate?.(ROTATE_STEP);
      } else if (e.key === 'R') {
        onPlacementRotate?.(-ROTATE_STEP);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placement, onPlacementCycle, onPlacementCancel, onPlacementRotate]);

  const widthPx = layout.boardWidth * INCH_TO_PX;
  const heightPx = layout.boardHeight * INCH_TO_PX;

  // model id -> resolved render/measure info
  const index = useMemo(() => {
    const map = new Map<string, Resolved>();
    for (const u of units) {
      const ds = datasheetsById.get(u.datasheetId);
      for (const m of u.models) {
        // A merged Leader's model carries its own datasheet → render it at its own base size.
        const mds = m.datasheetId ? datasheetsById.get(m.datasheetId) : ds;
        const shape = mds?.baseShape ?? ds?.baseShape ?? FALLBACK_SHAPE;
        map.set(m.id, { model: m, shape, owner: u.owner, unitId: u.id, unitName: ds?.name ?? u.datasheetId });
      }
    }
    return map;
  }, [units, datasheetsById]);

  function clientToInches(e: PointerEvent): Vec2 {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    // Guard against a zero-sized rect (pre-layout / jsdom) so we never divide by zero → NaN.
    const sx = rect.width ? rect.width / widthPx : 1;
    const sy = rect.height ? rect.height / heightPx : 1;
    const px = (e.clientX - rect.left) / sx;
    const py = (e.clientY - rect.top) / sy;
    return { x: px / INCH_TO_PX, y: layout.boardHeight - py / INCH_TO_PX };
  }

  function selectModel(id: string) {
    setSelectedIds((prev) => (prev.length === 1 && prev[0] !== id ? [prev[0], id] : [id]));
  }

  function handleTokenDown(modelId: string, e: PointerEvent<SVGElement>) {
    // While placing, let the click fall through to the board so it commits the ghost.
    if (placement) return;
    e.stopPropagation();
    if (movement) {
      const unitId = index.get(modelId)?.unitId;
      // Grabbing a model of a moving unit drags ALL moving units as a group (Alt = reshape one model).
      if (unitId && movement.movingUnitIds.includes(unitId) && !e.altKey) {
        groupDrag.current = clientToInches(e);
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      if (e.altKey && unitId && movement.movingUnitIds.includes(unitId)) {
        setDragId(modelId); // reshape a single model within its budget
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      // Otherwise, select the whole unit (shift to add to the selection).
      if (unitId) movement.onSelectUnits([unitId], e.shiftKey);
      return;
    }
    selectModel(modelId);
    setDragId(modelId);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handleBoardDown(e: PointerEvent) {
    if (placement) {
      const anchor = clientToInches(e);
      // Block illegal drops (outside the deployment zone, etc.).
      if (placement.legal) {
        const positions = formationPositions({
          anchor, count: placement.modelCount, baseShape: placement.baseShape,
          formation: placement.formation, rotation: placement.rotation,
        });
        if (!placement.legal(positions)) return;
      }
      onPlacementCommit?.(anchor);
      return;
    }
    if (movement) {
      // Begin a rubber-band selection on empty board.
      const p = clientToInches(e);
      setSelectBox({ a: p, b: p });
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    setSelectedIds([]);
  }

  function handlePointerMove(e: PointerEvent) {
    const pos = clientToInches(e);
    setCursor(pos);
    if (groupDrag.current && movement) {
      const last = groupDrag.current;
      movement.onGroupNudge({ x: pos.x - last.x, y: pos.y - last.y });
      groupDrag.current = pos;
      return;
    }
    if (selectBox) {
      setSelectBox((s) => (s ? { ...s, b: pos } : s));
      return;
    }
    if (dragId) onMoveModel(dragId, pos);
  }

  function handlePointerUp(e: PointerEvent) {
    if (selectBox && movement) {
      const ids = unitsInBox(selectBox);
      movement.onSelectUnits(ids, e.shiftKey);
      setSelectBox(null);
    }
    groupDrag.current = null;
    setDragId(null);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
  }

  /** Unit ids with at least one alive model inside the rubber-band rect (active player handled upstream). */
  function unitsInBox(box: { a: Vec2; b: Vec2 }): string[] {
    const minX = Math.min(box.a.x, box.b.x);
    const maxX = Math.max(box.a.x, box.b.x);
    const minY = Math.min(box.a.y, box.b.y);
    const maxY = Math.max(box.a.y, box.b.y);
    const ids = new Set<string>();
    for (const u of units) {
      if (u.inReserves) continue;
      for (const m of u.models) {
        if (!m.alive) continue;
        if (m.pos.x >= minX && m.pos.x <= maxX && m.pos.y >= minY && m.pos.y <= maxY) {
          ids.add(u.id);
          break;
        }
      }
    }
    return [...ids];
  }

  // ── ghost preview (placement mode) ──
  const ghost = useMemo(() => {
    if (!placement || !cursor) return null;
    return formationPositions({
      anchor: cursor,
      count: placement.modelCount,
      baseShape: placement.baseShape,
      formation: placement.formation,
      rotation: placement.rotation,
    });
  }, [placement, cursor]);

  // Is the current ghost a legal placement? (deployment zone / Infiltrators)
  const ghostLegal = ghost && placement?.legal ? placement.legal(ghost) : true;

  // ── measurement (suppressed while placing) ──
  const a = !placement && selectedIds[0] ? index.get(selectedIds[0]) : undefined;
  const b = !placement && selectedIds[1] ? index.get(selectedIds[1]) : undefined;

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

  const placementHud = placement
    ? `Placing ${placement.modelCount}-model unit · ${FORMATION_LABEL[placement.formation]} · ${Math.round(
        (((placement.rotation * 180) / Math.PI) % 360 + 360) % 360,
      )}° — ${ghostLegal ? 'click to drop' : '✗ illegal here (outside your zone)'} · scroll to rotate · C to change formation · Esc to cancel`
    : null;

  const movementHud = movement
    ? movement.movingUnitIds.length > 0
      ? `Drag a selected model to move the group · Alt+drag to nudge one model · ${
          movement.warnings.length ? '⚠ a unit is out of coherency — fix before confirming' : '✓ in coherency'
        }`
      : 'Drag a box to select your units (Shift to add), then pick a move in the panel →'
    : null;

  const hud =
    placementHud ??
    movementHud ??
    (measure
      ? a && b
        ? `${a.unitName} → ${b.unitName}: ${measure.gap.toFixed(2)}" base-to-base (${measure.centre.toFixed(2)}" centre)`
        : `${a!.unitName} → cursor: ${measure.gap.toFixed(2)}" to base edge`
      : 'Click a model to select; click a second to measure between them. Drag to move.');

  return (
    <div className="board-wrap">
      <div className={`board-hud${placement ? ' placing' : ''}${movementHud && movement!.warnings.length ? ' warn' : ''}`}>{hud}</div>
      <svg
        ref={svgRef}
        className="board-svg"
        viewBox={`0 0 ${widthPx} ${heightPx}`}
        width={widthPx}
        height={heightPx}
        style={{ touchAction: 'none', cursor: placement ? 'crosshair' : 'default' }}
        onPointerDown={handleBoardDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setCursor(null)}
      >
        <rect x={0} y={0} width={widthPx} height={heightPx} fill="#1f2430" stroke="#3a4150" strokeWidth={2} />
        <TerrainLayer layout={layout} />

        {units.map((u) =>
          u.inReserves
            ? null
            : u.models.map((m) => {
                const r = index.get(m.id)!;
                const selected = movement ? movement.selectedUnitIds.includes(u.id) : selectedIds.includes(m.id);
                return (
                  <ModelToken
                    key={m.id}
                    model={m}
                    shape={r.shape}
                    owner={r.owner}
                    selected={selected}
                    boardHeight={layout.boardHeight}
                    onPointerDown={handleTokenDown}
                  />
                );
              }),
        )}

        {/* Rubber-band selection box (Movement phase) */}
        {selectBox && (
          <rect
            x={pxX(Math.min(selectBox.a.x, selectBox.b.x))}
            y={pxY(Math.max(selectBox.a.y, selectBox.b.y), layout.boardHeight)}
            width={Math.abs(selectBox.b.x - selectBox.a.x) * INCH_TO_PX}
            height={Math.abs(selectBox.b.y - selectBox.a.y) * INCH_TO_PX}
            fill="rgba(253,224,71,0.10)"
            stroke="#fde047"
            strokeDasharray="5 4"
            strokeWidth={1.25}
            pointerEvents="none"
          />
        )}

        {/* Coherency warning triangles (Movement phase) */}
        {movement?.warnings.map((w) => {
          const cx = pxX(w.centroid.x);
          const cy = pxY(w.centroid.y, layout.boardHeight) - 16;
          return (
            <g key={w.unitId} pointerEvents="none" className="coh-warn">
              <polygon points={`${cx},${cy - 9} ${cx - 9},${cy + 7} ${cx + 9},${cy + 7}`} fill="#f59e0b" stroke="#7c2d12" strokeWidth={1} />
              <text x={cx} y={cy + 6} textAnchor="middle" fontSize={12} fontWeight={800} fill="#7c2d12">!</text>
            </g>
          );
        })}

        {ghost && placement && (
          <g className="ghost" pointerEvents="none">
            {ghost.map((p, i) => {
              const s = placement.baseShape;
              const cx = pxX(p.x);
              const cy = pxY(p.y, layout.boardHeight);
              const stroke = ghostLegal ? OWNER_COLOR[placement.owner].stroke : '#fca5a5';
              const fill = ghostLegal ? OWNER_COLOR[placement.owner].fill : '#ef4444';
              return s.kind === 'circle' ? (
                <circle
                  key={i}
                  cx={cx}
                  cy={cy}
                  r={pxLen(s.radius!)}
                  fill={fill}
                  fillOpacity={0.28}
                  stroke={stroke}
                  strokeOpacity={0.9}
                  strokeDasharray="4 3"
                  strokeWidth={1.25}
                />
              ) : (
                <ellipse
                  key={i}
                  cx={cx}
                  cy={cy}
                  rx={pxLen(s.rx!)}
                  ry={pxLen(s.ry!)}
                  fill={fill}
                  fillOpacity={0.28}
                  stroke={stroke}
                  strokeOpacity={0.9}
                  strokeDasharray="4 3"
                  strokeWidth={1.25}
                />
              );
            })}
            {cursor && (
              <circle cx={pxX(cursor.x)} cy={pxY(cursor.y, layout.boardHeight)} r={2} fill="#fde047" />
            )}
          </g>
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
