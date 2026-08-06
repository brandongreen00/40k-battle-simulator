import type { PointerEvent } from 'react';
import type { BaseShape, ModelInstance, Side } from '../core/types';
import { OWNER_COLOR, pxLen, pxX, pxY } from './view';

interface Props {
  model: ModelInstance;
  shape: BaseShape;
  owner: Side;
  selected: boolean;
  boardHeight: number;
  /** Extra hit-area radius in board px (touch devices) — rendered as an invisible overlay so a
   *  fingertip can grab a 3px base without changing how the base LOOKS. 0 = exact base only. */
  hitBoostPx?: number;
  onPointerDown: (modelId: string, e: PointerEvent<SVGElement>) => void;
}

/** A single model rendered as its base (circle, oval or rect hull) at the correct size. */
export function ModelToken({ model, shape, owner, selected, boardHeight, hitBoostPx = 0, onPointerDown }: Props) {
  const color = OWNER_COLOR[owner];
  const cx = pxX(model.pos.x);
  const cy = pxY(model.pos.y, boardHeight);
  const stroke = selected ? '#fde047' : color.stroke;
  const strokeWidth = selected ? 2.5 : 1.25;
  const common = {
    className: 'model-token',
    fill: color.fill,
    fillOpacity: 0.9,
    stroke,
    strokeWidth,
    style: { cursor: 'grab' as const },
    onPointerDown: (e: PointerEvent<SVGElement>) => onPointerDown(model.id, e),
  };

  const rPx = shape.kind === 'circle' ? pxLen(shape.radius!) : Math.max(pxLen(shape.rx!), pxLen(shape.ry!));
  const hitR = Math.max(rPx, hitBoostPx);

  return (
    <g>
      {shape.kind === 'circle' ? (
        <circle cx={cx} cy={cy} r={pxLen(shape.radius!)} {...common} />
      ) : shape.kind === 'rect' ? (
        <rect
          x={cx - pxLen(shape.rx!)}
          y={cy - pxLen(shape.ry!)}
          width={pxLen(shape.rx!) * 2}
          height={pxLen(shape.ry!) * 2}
          rx={2}
          {...common}
        />
      ) : (
        <ellipse cx={cx} cy={cy} rx={pxLen(shape.rx!)} ry={pxLen(shape.ry!)} {...common} />
      )}
      {hitR > rPx + 0.5 && (
        <circle
          cx={cx}
          cy={cy}
          r={hitR}
          fill="transparent"
          stroke="none"
          style={{ cursor: 'grab' }}
          onPointerDown={(e) => onPointerDown(model.id, e)}
        />
      )}
    </g>
  );
}
