<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';
  import { reportFreshnessTime } from './report-view-model';

  let {
    displayedRevision,
    generatedAt,
    fetching,
    updateAvailable,
    detailOpen,
    onApply,
  }: {
    displayedRevision: string;
    generatedAt: string;
    fetching: boolean;
    updateAvailable: boolean;
    detailOpen: boolean;
    onApply: () => Promise<void>;
  } = $props();

  const meta = css({ mb: '16px', color: 'muted', fontSize: '11px', lineHeight: 1.5 });
  const update = css({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px 16px',
    mt: '8px',
    color: 'ink',
    fontSize: '12px',
  });
</script>

<section aria-label="Report freshness" class={meta} data-freshness-revision={displayedRevision}>
  <span data-report-freshness title="When the report currently displayed was assembled from collected usage.">
    Data as of <time datetime={generatedAt}>{reportFreshnessTime(generatedAt)}</time>
  </span>
  {#if updateAvailable}
    <div class={update} data-session-revision-update>
      <p aria-live="polite">
        {#if detailOpen}
          New data is ready. Close the session detail to update this view.
        {:else}
          New data is ready. Your current exploration is preserved until you apply it.
        {/if}
      </p>
      <button class={ghostButton} disabled={detailOpen || fetching} onclick={onApply} type="button">
        {fetching ? 'Updating report…' : 'Apply new session data'}
      </button>
    </div>
  {/if}
</section>
