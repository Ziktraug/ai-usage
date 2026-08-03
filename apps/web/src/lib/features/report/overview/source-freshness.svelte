<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const row = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
  const pill = css({
    px: '9px',
    py: '4px',
    borderRadius: 'full',
    bg: 'track',
    color: 'ink',
    fontSize: '11px',
    fontWeight: 650,
  });
</script>

<script lang="ts">
  import { Tooltip } from '@ai-usage/design-system/svelte';
  import type { FocusedMachineFreshness } from '@ai-usage/report-core/focused-report-query';
  import { fmtDate, fmtNum } from '../../../foundation/presentation/format';

  let { freshness }: { freshness?: FocusedMachineFreshness | undefined } = $props();
  const unavailableDescription = 'No source freshness observation is available for this report revision.';
</script>

<section aria-label="Report source freshness" class={row}>
  {#if freshness?.kind === 'available'}
    <Tooltip
      content={`Observed ${fmtDate(freshness.observedAt)} across ${fmtNum(freshness.machines.length)} machines.`}
    >
      <span class={pill}>Sources observed</span>
    </Tooltip>
    {#if freshness.omittedMachines > 0 || freshness.skippedRows > 0}
      <span class={pill}
        >{fmtNum(freshness.omittedMachines)}
        omitted · {fmtNum(freshness.skippedRows)} rows skipped</span
      >
    {/if}
  {:else}
    <Tooltip content={unavailableDescription}>
      <span class={pill}>Freshness unavailable</span>
    </Tooltip>
  {/if}
</section>
