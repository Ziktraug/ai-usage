<script lang="ts">
  import { css } from '@ai-usage/design-system/css';

  let { pending }: { pending: boolean } = $props();
  const tone = css({ color: 'accent' });
</script>

{#if pending}
  <div aria-hidden="true" class={[tone, 'report-progress']} data-report-progress></div>
{/if}

<style>
  .report-progress {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    height: 2px;
    overflow: hidden;
    pointer-events: none;
  }
  .report-progress::after {
    display: block;
    width: 35%;
    height: 100%;
    content: "";
    background: currentColor;
    animation: report-progress 1.2s ease-in-out infinite;
  }
  @keyframes report-progress {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(390%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .report-progress::after {
      width: 100%;
      transform: none;
      animation: none;
    }
  }
  @media (forced-colors: active) {
    .report-progress::after {
      forced-color-adjust: none;
      background: Highlight;
    }
  }
</style>
