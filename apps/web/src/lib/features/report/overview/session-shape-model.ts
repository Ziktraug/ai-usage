import type { FocusedOverviewSessionItem, FocusedSessionShape } from '@ai-usage/report-core/focused-report-query';

export const SESSION_SHAPE_POINT_RADIUS = 4;

const logRatio = (value: number, domain: { readonly max: number; readonly min: number }): number =>
  (Math.log10(Math.max(value, Number.EPSILON)) - domain.min) / Math.max(Number.EPSILON, domain.max - domain.min);

export const sessionShapePosition = (
  shape: Pick<FocusedSessionShape, 'xDomain' | 'yDomain'>,
  durationMs: number,
  cost: number,
): { readonly x: number; readonly y: number } => ({
  x: 4 + logRatio(durationMs, shape.xDomain) * 92,
  y: 92 - logRatio(cost, shape.yDomain) * 84,
});

export const presentSessionShape = (
  shape: FocusedSessionShape,
  presentItem: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem,
): FocusedSessionShape => ({
  ...shape,
  outliers: shape.outliers.map(presentItem),
  points: shape.points.map((item) => ({ ...presentItem(item), aggregateCount: item.aggregateCount })),
});
