<script lang="ts">
  import { css } from '@ai-usage/design-system/css';

  let { pending, refreshError }: { pending: boolean; refreshError?: string | null } = $props();

  const unavailablePanel = css({ border: '1px solid token(colors.border)', borderRadius: 'lg', p: '24px' });
  const unavailableText = css({ color: 'muted', fontSize: '13px' });
</script>

{#if refreshError}
  <section aria-live="polite" class={unavailablePanel} data-report-refresh-error>
    <div class={unavailableText}>{refreshError}</div>
  </section>
{:else if pending}
  <p aria-live="polite" data-report-refresh-pending>Updating report…</p>
{/if}
