<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import type { Snippet } from 'svelte';
  import RecoverableRegion from '../../shell/recoverable-region.svelte';

  let {
    children,
    kind,
    pending,
    stale = pending,
    onRetry,
  }: {
    children: Snippet;
    kind: 'overview' | 'panel';
    pending: boolean;
    stale?: boolean;
    onRetry: () => Promise<void>;
  } = $props();
  const output = css({ minW: 0, transition: 'opacity 120ms ease' });
  const staleOutput = css({ opacity: 0.5, transitionDelay: '180ms' });
</script>

<RecoverableRegion
  busy={pending && stale}
  class={cx(output, stale && staleOutput)}
  label={kind === 'overview' ? 'Report overview' : 'Report table'}
  {onRetry}
  region={kind}
  {stale}
>
  {@render children()}
</RecoverableRegion>
