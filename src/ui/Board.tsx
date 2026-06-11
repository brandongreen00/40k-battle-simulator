import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { BaseShape, Datasheet, Layout, ModelInstance, Side, UnitInstance, Vec2 } from '../core/types';
import { baseRadius, baseToBaseGap, dist, gapBetweenBases } from '../core/geometry';
import { formationPositions, FORMATION_LABEL, type Formation } from '../core/formation';
import { fullView, isFullView, panView, pinchView, zoomAt, zoomOf, type BoardView } from './boardView';
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

const ROTATE_STEP = Math.PI / 12; // 15° per scroll notch / R keypress / rotate button
const WHEEL_ZOOM = 1.18; // zoom factor per wheel notch (when not placing)

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

/** Touch-primary device? Drives the touch placement flow and bigger tap targets. */
function coarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    return false;
  }
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

  const widthPx = layout.boardWidth * INCH_TO_PX;
  const heightPx = layout.boardHeight * INCH_TO_PX;

  // ── viewport (pinch-zoom / pan); the viewBox is a window onto the fixed board ──
  const [view, setView] = useState<BoardView>(() => fullView(widthPx, heightPx));
  const zoomed = !isFullView(view, widthPx);
  // Active pointers (for pinch) + one-finger pan state.
  const pointers = useRef(new Map<number, { cx: number; cy: number }>());
  const pinchStart = useRef<{
    view: BoardView;
    a: number;
    b: number;
    a0: { x: number; y: number };
    b0: { x: number; y: number };
  } | null>(null);
  const panDrag = useRef<{ cx: number; cy: number } | null>(null);

  const coarse = useMemo(coarsePointer, []);

  // Touch placement: the ghost is positioned by tap/drag and committed with the ✓ button.
  const [ghostAnchor, setGhostAnchor] = useState<Vec2 | null>(null);
  const placingDrag = useRef(false);
  // Touch replacements for the keyboard modifiers (Alt = reshape one model, Shift = add to selection).
  const [reshapeSingle, setReshapeSingle] = useState(false);
  const [addSelect, setAddSelect] = useState(false);

  // Reset the per-gesture state when a placement starts/ends; on touch devices drop the ghost in
  // the middle of the current view so there is something to grab right away.
  useEffect(() => {
    placingDrag.current = false;
    if (!placement) {
      setGhostAnchor(null);
      return;
    }
    if (coarse) {
      setGhostAnchor({
        x: (view.x + view.w / 2) / INCH_TO_PX,
        y: layout.boardHeight - (view.y + view.h / 2) / INCH_TO_PX,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, coarse]);

  // Wheel: rotates the ghost while placing, zooms the board otherwise. Bound natively so we can
  // preventDefault the page scroll (React's onWheel is passive and cannot).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (placement) {
        onPlacementRotate?.(Math.sign(e.deltaY) * ROTATE_STEP);
        return;
      }
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const at = {
        x: view.x + ((e.clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((e.clientY - rect.top) / rect.height) * view.h,
      };
      setView(zoomAt(view, at, e.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM, widthPx, heightPx));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [placement, onPlacementRotate, view, widthPx, heightPx]);

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

  function clientToBoardPx(e: { clientX: number; clientY: number }): Vec2 {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    // Guard against a zero-sized rect (pre-layout / jsdom) so we never divide by zero → NaN.
    if (!rect.width || !rect.height) return { x: e.clientX, y: e.clientY };
    return {
      x: view.x + ((e.clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((e.clientY - rect.top) / rect.height) * view.h,
    };
  }
  function clientToInches(e: { clientX: number; clientY: number }): Vec2 {
    const p = clientToBoardPx(e);
    return { x: p.x / INCH_TO_PX, y: layout.boardHeight - p.y / INCH_TO_PX };
  }

  /** Track every pointer; entering two-pointer territory cancels game gestures and starts a pinch. */
  function trackPointerDown(e: PointerEvent): boolean {
    pointers.current.set(e.pointerId, { cx: e.clientX, cy: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.keys()];
      const pa = pointers.current.get(a!)!;
      const pb = pointers.current.get(b!)!;
      const svg = svgRef.current;
      const rect = svg?.getBoundingClientRect();
      if (svg && rect && rect.width && rect.height) {
        const toBoard = (c: { cx: number; cy: number }) => ({
          x: view.x + ((c.cx - rect.left) / rect.width) * view.w,
          y: view.y + ((c.cy - rect.top) / rect.height) * view.h,
        });
        pinchStart.current = { view, a: a!, b: b!, a0: toBoard(pa), b0: toBoard(pb) };
      }
      // A second finger means navigation — abandon any in-progress game gesture.
      setSelectBox(null);
      setDragId(null);
      groupDrag.current = null;
      panDrag.current = null;
      placingDrag.current = false;
      svgRef.current?.setPointerCapture(e.pointerId);
      return true;
    }
    return pointers.current.size > 2;
  }

  function selectModel(id: string) {
    setSelectedIds((prev) => (prev.length === 1 && prev[0] !== id ? [prev[0]!, id] : [id]));
  }

  function handleTokenDown(modelId: string, e: PointerEvent<SVGElement>) {
    // While placing, let the press fall through to the board (position / commit the ghost).
    if (placement) return;
    e.stopPropagation();
    e.preventDefault(); // never let a token drag start a native text selection / drag
    if (trackPointerDown(e)) return; // second finger -> pinch, not a game gesture
    if (movement) {
      const unitId = index.get(modelId)?.unitId;
      // Grabbing a model of a moving unit drags ALL moving units as a group
      // (Alt or the "one model" toggle reshapes a single model instead).
      const single = e.altKey || reshapeSingle;
      if (unitId && movement.movingUnitIds.includes(unitId) && !single) {
        groupDrag.current = clientToInches(e);
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      if (single && unitId && movement.movingUnitIds.includes(unitId)) {
        setDragId(modelId); // reshape a single model within its budget
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      // Otherwise, select the whole unit (Shift / the "add" toggle adds to the selection).
      if (unitId) movement.onSelectUnits([unitId], e.shiftKey || addSelect);
      return;
    }
    selectModel(modelId);
    setDragId(modelId);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function handleBoardDown(e: PointerEvent) {
    e.preventDefault(); // see handleTokenDown — board drags must stay pointer-only
    if (trackPointerDown(e)) return;
    if (placement) {
      const anchor = clientToInches(e);
      if (e.pointerType === 'touch') {
        // Touch flow: position the ghost (drag to fine-tune), commit with the ✓ button.
        setGhostAnchor(anchor);
        setCursor(anchor);
        placingDrag.current = true;
        svgRef.current?.setPointerCapture(e.pointerId);
        return;
      }
      // Mouse flow: click commits (blocked when illegal — outside the deployment zone, etc.).
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
    if (zoomed) {
      // Zoomed in outside the movement/placement modes: drag the empty board to pan.
      panDrag.current = { cx: e.clientX, cy: e.clientY };
      svgRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    setSelectedIds([]);
  }

  function handlePointerMove(e: PointerEvent) {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { cx: e.clientX, cy: e.clientY });
    }
    // Two-finger pinch: zoom/pan only. Both finger positions are converted into the PINCH-START
    // view's board coordinates so each move is computed against one stable reference frame.
    if (pinchStart.current && pointers.current.size >= 2) {
      const start = pinchStart.current;
      const pa = pointers.current.get(start.a);
      const pb = pointers.current.get(start.b);
      const svg = svgRef.current;
      if (pa && pb && svg) {
        const rect = svg.getBoundingClientRect();
        if (rect.width && rect.height) {
          const toStart = (c: { cx: number; cy: number }) => ({
            x: start.view.x + ((c.cx - rect.left) / rect.width) * start.view.w,
            y: start.view.y + ((c.cy - rect.top) / rect.height) * start.view.h,
          });
          setView(pinchView(start.view, start.a0, start.b0, toStart(pa), toStart(pb), widthPx, heightPx));
        }
      }
      return;
    }
    const pos = clientToInches(e);
    if (panDrag.current) {
      const svg = svgRef.current!;
      const rect = svg.getBoundingClientRect();
      if (rect.width) {
        const dx = ((panDrag.current.cx - e.clientX) / rect.width) * view.w;
        const dy = ((panDrag.current.cy - e.clientY) / rect.height) * view.h;
        panDrag.current = { cx: e.clientX, cy: e.clientY };
        setView(panView(view, dx, dy, widthPx, heightPx));
      }
      return;
    }
    if (placement && placingDrag.current && e.pointerType === 'touch') {
      setGhostAnchor(pos);
      setCursor(pos);
      return;
    }
    setCursor(pos);
    if (e.pointerType === 'mouse' && placement && !placingDrag.current) {
      // The mouse ghost follows the cursor (clears any touch-pinned anchor).
      if (ghostAnchor) setGhostAnchor(null);
    }
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
    pointers.current.delete(e.pointerId);
    if (pinchStart.current && pointers.current.size < 2) pinchStart.current = null;
    if (selectBox && movement) {
      const ids = unitsInBox(selectBox);
      movement.onSelectUnits(ids, e.shiftKey || addSelect);
      setSelectBox(null);
    }
    groupDrag.current = null;
    panDrag.current = null;
    placingDrag.current = false;
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
  const ghostPoint = ghostAnchor ?? cursor;
  const ghost = useMemo(() => {
    if (!placement || !ghostPoint) return null;
    return formationPositions({
      anchor: ghostPoint,
      count: placement.modelCount,
      baseShape: placement.baseShape,
      formation: placement.formation,
      rotation: placement.rotation,
    });
  }, [placement, ghostPoint]);

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
      )}° — ${
        ghostLegal
          ? coarse
            ? 'drag the ghost, then tap ✓ Place'
            : 'click to drop (or ✓ Place) · scroll to rotate · C formation · Esc cancels'
          : '✗ illegal here (outside your zone)'
      }`
    : null;

  const movementHud = movement
    ? movement.movingUnitIds.length > 0
      ? `Drag a selected model to move the group${reshapeSingle ? ' · ONE-MODEL mode' : ''} · ${
          movement.warnings.length ? '⚠ a unit is out of coherency — fix before confirming' : '✓ in coherency'
        }`
      : 'Drag a box to select your units, then pick a move in the panel'
    : null;

  const hud =
    placementHud ??
    movementHud ??
    (measure
      ? a && b
        ? `${a.unitName} → ${b.unitName}: ${measure.gap.toFixed(2)}" base-to-base (${measure.centre.toFixed(2)}" centre)`
        : `${a!.unitName} → cursor: ${measure.gap.toFixed(2)}" to base edge`
      : 'Tap a model to select; tap a second to measure between them. Drag to move.');

  // Bigger touch hit-areas: at least ~2% of the visible board width per tap, mouse stays precise.
  const hitBoostPx = coarse ? view.w * 0.02 : 0;

  const zoomPct = Math.round(zoomOf(view, widthPx) * 100);

  return (
    <div className="board-wrap">
      <div className={`board-hud${placement ? ' placing' : ''}${movementHud && movement!.warnings.length ? ' warn' : ''}`}>{hud}</div>
      <div className="board-stage">
        <svg
          ref={svgRef}
          className="board-svg"
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          width={widthPx}
          height={heightPx}
          style={{ touchAction: 'none', cursor: placement ? 'crosshair' : zoomed ? 'grab' : 'default' }}
          onPointerDown={handleBoardDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
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
                      hitBoostPx={hitBoostPx}
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
              {ghostPoint && (
                <circle cx={pxX(ghostPoint.x)} cy={pxY(ghostPoint.y, layout.boardHeight)} r={2} fill="#fde047" />
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

      {/* Control row UNDER the board — never overlays the play area (overlays steal board taps
          near the edges, exactly where deployment zones live). */}
      <div className="board-bar">
        <div className="board-zoom">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setView((v) => zoomAt(v, { x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1.5, widthPx, heightPx))}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={!zoomed}
            onClick={() => setView((v) => zoomAt(v, { x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1 / 1.5, widthPx, heightPx))}
          >
            −
          </button>
          <button type="button" aria-label="Fit board" disabled={!zoomed} onClick={() => setView(fullView(widthPx, heightPx))}>
            ⤢
          </button>
          {zoomed && <span className="zoom-pct">{zoomPct}%</span>}
        </div>

        {/* Placement controls (rotate / formation / place / cancel) — the touch path to every
            PC-only shortcut (scroll-rotate, C, Esc). */}
        {placement && (
          <div className="board-placebar">
            <button type="button" aria-label="Rotate left" onClick={() => onPlacementRotate?.(-ROTATE_STEP)}>⟲</button>
            <button type="button" aria-label="Rotate right" onClick={() => onPlacementRotate?.(ROTATE_STEP)}>⟳</button>
            <button type="button" className="formation" onClick={() => onPlacementCycle?.()}>
              {FORMATION_LABEL[placement.formation].split(' — ')[0]}
            </button>
            <button
              type="button"
              className="place"
              disabled={!ghostPoint || !ghostLegal}
              onClick={() => ghostPoint && ghostLegal && onPlacementCommit?.(ghostPoint)}
            >
              ✓ Place
            </button>
            <button type="button" className="cancel" onClick={() => onPlacementCancel?.()}>✕</button>
          </div>
        )}

        {/* Movement gesture toggles — touch replacements for Shift-select and Alt-drag. */}
        {movement && !placement && (
          <div className="board-togglebar">
            {movement.movingUnitIds.length === 0 ? (
              <button
                type="button"
                className={addSelect ? 'on' : ''}
                onClick={() => setAddSelect((v) => !v)}
                title="Add the next selection to the current one (Shift)"
              >
                + add to selection
              </button>
            ) : (
              <button
                type="button"
                className={reshapeSingle ? 'on' : ''}
                onClick={() => setReshapeSingle((v) => !v)}
                title="Drag moves one model instead of the whole group (Alt)"
              >
                ☐ one model
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

