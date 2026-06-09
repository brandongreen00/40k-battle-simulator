import type { PointerEvent } from 'react';
import type { BaseShape, ModelInstance, Side } from '../core/types';
import { OWNER_COLOR, pxLen, pxX, pxY } from './view';

interface Props {
  model: ModelInstance;
  shape: BaseShape;
  owner: Side;
  selected: boolean;
  boardHeight: number;
  onPointerDown: (modelId: string, e: PointerEvent<SVGElement>) => void;
}

/** A single model rendered as its base (circle or oval) at the correct physical size. */
export function ModelToken({ model, shape, owner, selected, boardHeight, onPointerDown }: Props) {
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

  return shape.kind === 'circle' ? (
    <circle cx={cx} cy={cy} r={pxLen(shape.radius!)} {...common} />
  ) : (
    <ellipse cx={cx} cy={cy} rx={pxLen(shape.rx!)} ry={pxLen(shape.ry!)} {...common} />
  );
}
