<script lang="ts">
  import type { WorkThreadFactEventKind } from '@ai-usage/report-core/work-thread-view';

  /** One shape per pull request milestone: color only reinforces it (merged, approved, changes requested). */
  let { kind, size = 11 }: { kind: WorkThreadFactEventKind; size?: number } = $props();
</script>

<svg
  aria-hidden="true"
  fill="none"
  height={size}
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  stroke-width="1.5"
  viewBox="0 0 12 12"
  width={size}
>
  {#if kind === 'pull-request-merged'}
    <circle cx="3.5" cy="2.75" r="1.25" />
    <circle cx="3.5" cy="9.25" r="1.25" />
    <circle cx="9" cy="6.5" r="1.25" />
    <path d="M3.5 4v4M3.5 4c0 1.8 1.6 2.5 4.25 2.5" />
  {:else if kind === 'pull-request-approved'}
    <path d="M2.5 6.25 5 8.75l4.5-5.5" />
  {:else if kind === 'pull-request-changes-requested'}
    <path d="M6 2v5M3.5 4.5h5M3.5 10h5" />
  {:else if kind === 'pull-request-closed'}
    <path d="m3 3 6 6M9 3 3 9" />
  {:else if kind === 'pull-request-reopened'}
    <path d="M9.5 6.5A3.5 3.5 0 1 1 8.4 3.6" />
    <path d="M9.25 1.5v2.5h-2.5" />
  {:else if kind === 'pull-request-ready'}
    <path d="M1.25 6S3 2.75 6 2.75 10.75 6 10.75 6 9 9.25 6 9.25 1.25 6 1.25 6Z" />
    <circle cx="6" cy="6" r="1.25" />
  {:else if kind === 'pull-request-draft'}
    <circle cx="6" cy="6" r="3.75" stroke-dasharray="1.8 1.6" />
  {:else}
    <circle cx="3.5" cy="2.75" r="1.25" />
    <circle cx="3.5" cy="9.25" r="1.25" />
    <circle cx="9" cy="9.25" r="1.25" />
    <path d="M3.5 4v4M9 8V5.25c0-.85-.65-1.5-1.5-1.5H5.75M7 2.5 5.75 3.75 7 5" />
  {/if}
</svg>
