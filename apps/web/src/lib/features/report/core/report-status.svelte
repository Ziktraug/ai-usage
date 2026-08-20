<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton } from '@ai-usage/design-system/report';

  let {
    onRetry = () => Promise.resolve(),
    pending,
    refreshError,
  }: { onRetry?: () => Promise<void>; pending: boolean; refreshError?: string | null } = $props();

  const unavailablePanel = css({
    border: '1px solid token(colors.line)',
    borderColor: 'status.danger',
    borderRadius: 'lg',
    bg: 'status.dangerSoft',
    p: '24px',
  });
  const unavailableText = css({ color: 'ink', fontSize: '13px' });
  const unavailableContent = css({ alignItems: 'start', display: 'grid', gap: '12px', justifyItems: 'start' });
  const retryButton = css({ minH: '44px' });
  const retry = async (): Promise<void> => {
    await onRetry();
  };
</script>

{#if refreshError}
  <section aria-live="polite" class={unavailablePanel} data-report-refresh-error>
    <div class={unavailableContent}>
      <div class={unavailableText}>{refreshError}</div>
      <button class={cx(ghostButton, retryButton)} onclick={retry} type="button">Retry</button>
    </div>
  </section>
{:else if pending}
  <p aria-live="polite" data-report-refresh-pending>Updating report…</p>
{/if}
