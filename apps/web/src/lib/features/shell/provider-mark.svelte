<script lang="ts">
  import type { HarnessKey } from '@ai-usage/report-core/harness-metadata';

  /**
   * Geometric stand-ins, not brand assets: the repository ships no vendor logos, and each mark only
   * has to separate four providers at 12px. They inherit `currentColor` so the rail can tint them
   * with the harness token that already identifies the same provider elsewhere in the report.
   */
  let { name, size = 12 }: { name: HarnessKey; size?: number } = $props();
</script>

<svg
  aria-hidden="true"
  fill="none"
  height={size}
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  viewBox="0 0 24 24"
  width={size}
  xmlns="http://www.w3.org/2000/svg"
>
  {#if name === 'claude'}
    <!-- Radiating burst. -->
    <g stroke-width="2.4">
      <path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6"></path>
      <path d="M5.2 5.2l4.3 4.3M14.5 14.5l4.3 4.3M18.8 5.2l-4.3 4.3M9.5 14.5l-4.3 4.3"></path>
    </g>
  {:else if name === 'codex'}
    <!-- Nested hexagons. -->
    <path d="M12 2.2l8.5 4.9v9.8L12 21.8 3.5 16.9V7.1z" stroke-width="2"></path>
    <path d="M12 8l4 2.3v4.6L12 17.2 8 14.9v-4.6z" stroke-width="1.6"></path>
  {:else if name === 'cursor'}
    <!-- Folded prism. -->
    <path d="M12 2.4l9 5.2v10.8L12 21.6 3 18.4V7.6z" stroke-width="2"></path>
    <path d="M3 7.6l9 5.2 9-5.2M12 12.8v8.8" stroke-width="1.8"></path>
  {:else}
    <!-- Terminal prompt. -->
    <path d="M4.5 3.5h15a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" stroke-width="2"></path>
    <path d="M8 9.5l3 2.5-3 2.5M13.2 15.2h3.2" stroke-width="2"></path>
  {/if}
</svg>
