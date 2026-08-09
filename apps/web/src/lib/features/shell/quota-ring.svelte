<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';
  import type { ProviderQuotaSeverity } from './provider-quota-rail';

  const RADIUS = 16.25;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  const wrapper = css({ display: 'grid', placeItems: 'center', position: 'relative' });
  const ring = css({ display: 'block', transform: 'rotate(-90deg)' });
  const mark = css({ position: 'absolute', display: 'grid', placeItems: 'center' });

  /**
   * The fill carries pressure and the track is the same hue a few steps lighter, so an anxious ring
   * reads as one object rather than a coloured arc on neutral grey. Provider identity is carried by
   * the mark in the middle, never by the arc — status colours are reserved.
   */
  const trackTones: Record<ProviderQuotaSeverity, string> = {
    danger: css({ stroke: 'status.dangerSoft' }),
    ok: css({ stroke: 'status.okSoft' }),
    unknown: css({ stroke: 'track' }),
    warning: css({ stroke: 'status.warnSoft' }),
  };
  const arcTones: Record<ProviderQuotaSeverity, string> = {
    danger: css({ stroke: 'status.danger' }),
    ok: css({ stroke: 'status.ok' }),
    unknown: css({ stroke: 'transparent' }),
    warning: css({ stroke: 'status.warn' }),
  };
  // Unmeasured providers get a dashed track instead of an empty solid one: a 0% ring and a
  // "nothing is being read" ring must not look the same.
  const trackUnmeasured = css({ strokeDasharray: '2 4' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';

  let {
    center,
    severity,
    size = 26,
    usedPercent,
  }: {
    center?: Snippet;
    severity: ProviderQuotaSeverity;
    size?: number;
    usedPercent: number | null;
  } = $props();

  const filled = $derived(usedPercent === null ? 0 : (CIRCUMFERENCE * Math.min(100, Math.max(0, usedPercent))) / 100);
</script>

<span class={wrapper} style={`width:${size}px;height:${size}px`}>
  <svg aria-hidden="true" class={ring} height={size} viewBox="0 0 36 36" width={size}>
    <circle
      class={cx(trackTones[severity], usedPercent === null ? trackUnmeasured : undefined)}
      cx="18"
      cy="18"
      fill="none"
      r={RADIUS}
      stroke-width="3.5"
    />
    {#if usedPercent !== null}
      <circle
        class={arcTones[severity]}
        cx="18"
        cy="18"
        fill="none"
        r={RADIUS}
        stroke-dasharray={`${filled} ${CIRCUMFERENCE - filled}`}
        stroke-linecap="round"
        stroke-width="3.5"
      />
    {/if}
  </svg>
  {#if center}
    <span class={mark}>{@render center()}</span>
  {/if}
</span>
