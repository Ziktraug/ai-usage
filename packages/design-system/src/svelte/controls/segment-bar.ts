export interface BarSegment {
  readonly class: string;
  readonly label: string;
  readonly title?: string;
  readonly value: number;
}

export const visibleBarSegments = (segments: readonly BarSegment[]): readonly BarSegment[] =>
  segments.filter((segment) => segment.value > 0);

export const segmentBarWidth = (segments: readonly BarSegment[], value: number): number => {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (value / Math.max(1, total)) * 100;
};
