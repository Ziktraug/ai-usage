<script lang="ts">
  import { css } from '@ai-usage/design-system/css';

  const unavailablePanel = css({ border: '1px solid token(colors.border)', borderRadius: 'lg', p: '24px' });
  const unavailableText = css({ color: 'muted', fontSize: '13px' });
</script>

<section aria-live="polite" class={unavailablePanel} data-report-pending>
  <div class={unavailableText}>Loading report…</div>
</section>
