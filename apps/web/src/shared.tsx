import { cx } from '@ai-usage/design-system/css';
import { segmentBarPart, segmentBarTrack, unavailableCell } from '@ai-usage/design-system/report';
import { For } from 'solid-js';
import { fmtNum } from './lib/foundation/presentation/format';
import { USAGE_UNAVAILABLE_HINT } from './lib/foundation/presentation/report-value';

export {
  accentFill,
  badgeToneFor,
  HarnessBadge,
  harnessFamily,
  harnessFillFor,
  harnessSvgFillFor,
  tokenSegmentClasses,
} from '@ai-usage/design-system/report';
export {
  fmtCompact,
  fmtDate,
  fmtDateOnly,
  fmtDuration,
  fmtMaybeNum,
  fmtMoney,
  fmtNum,
  fmtPct,
  median,
} from './lib/foundation/presentation/format';
export * from './lib/foundation/presentation/report-value';

export interface BarSegment {
  class: string;
  label: string;
  title?: string;
  value: number;
}

export const UsageUnavailableCell = () => (
  <span class={unavailableCell} title={USAGE_UNAVAILABLE_HINT}>
    —
  </span>
);

// Proportional horizontal bar: token anatomy in the drawer and the overview.
export const SegmentBar = (props: { segments: BarSegment[]; ariaLabel?: string }) => {
  const total = () => props.segments.reduce((sum, segment) => sum + segment.value, 0);
  const visibleSegments = () => props.segments.filter((segment) => segment.value > 0);
  return (
    <div aria-label={props.ariaLabel} class={segmentBarTrack} role="img">
      <For each={visibleSegments()}>
        {(segment) => (
          <div
            class={cx(segmentBarPart, segment.class)}
            style={{ width: `${(segment.value / Math.max(1, total())) * 100}%` }}
            title={segment.title ?? `${segment.label}: ${fmtNum(segment.value)}`}
          />
        )}
      </For>
    </div>
  );
};
