import { css, cx } from '@ai-usage/design-system/css';

export const segmentBarTrack = css({
  display: 'flex',
  h: '10px',
  borderRadius: 'full',
  bg: 'track',
  overflow: 'hidden',
});

export const segmentBarPart = css({
  h: '100%',
  minW: '0',
});

export const barTrack = css({
  h: '6px',
  mt: '8px',
  borderRadius: 'full',
  bg: 'track',
  overflow: 'hidden',
});

export const barFill = css({
  h: '100%',
  borderRadius: 'full',
});

export const accentFill = css({ bg: 'accent' });

export const inkFill = css({ bg: 'ink' });

export const tokenSegmentClasses = {
  cacheRead: cx(accentFill, css({ opacity: 0.22 })),
  cacheWrite: cx(accentFill, css({ opacity: 0.42 })),
  input: cx(accentFill, css({ opacity: 0.68 })),
  output: accentFill,
};

export type BarSegment = { label: string; value: number; class: string; title?: string };

export const SegmentBar = (props: { segments: BarSegment[]; ariaLabel?: string }) => {
  const total = () => props.segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div class={segmentBarTrack} role="img" aria-label={props.ariaLabel}>
      {props.segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <div
            class={cx(segmentBarPart, segment.class)}
            style={{ width: `${(segment.value / Math.max(1, total())) * 100}%` }}
            title={segment.title ?? `${segment.label}: ${segment.value}`}
          />
        ))}
    </div>
  );
};
