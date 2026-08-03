<script lang="ts">
  import { unavailablePanel, unavailableText } from '@ai-usage/design-system/report';

  let { pending, refreshError }: { pending: boolean; refreshError?: string | null } = $props();
</script>

{#if refreshError}
  <section aria-live="polite" class={unavailablePanel} data-report-refresh-error>
    <div class={unavailableText}>{refreshError}</div>
  </section>
{:else if pending}
  <p aria-live="polite" data-report-refresh-pending>Updating report…</p>
{/if}
