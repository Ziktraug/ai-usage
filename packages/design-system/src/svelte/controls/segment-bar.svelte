<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import type { BarSegment } from './segment-bar';

  const segmentBarTrack = css({
    display: 'flex',
    h: '10px',
    borderRadius: 'full',
    bg: 'track',
    overflow: 'hidden',
  });

  const segmentBarPart = css({ h: '100%', minW: '0' });

  export interface SegmentBarProps {
    ariaLabel?: string;
    segments: readonly BarSegment[];
  }
</script>

<script lang="ts">
  import { segmentBarWidth, visibleBarSegments } from './segment-bar';

  let { ariaLabel, segments }: SegmentBarProps = $props();
  const visibleSegments = $derived(visibleBarSegments(segments));
</script>

<div aria-label={ariaLabel} class={segmentBarTrack} role="img">
  {#each visibleSegments as segment}
    <div
      class={cx(segmentBarPart, segment.class)}
      title={segment.title ?? `${segment.label}: ${segment.value}`}
      style:width={`${segmentBarWidth(segments, segment.value)}%`}
    ></div>
  {/each}
</div>
