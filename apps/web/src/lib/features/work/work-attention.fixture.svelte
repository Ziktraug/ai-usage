<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import WebQueryProvider from '../../query/provider.svelte';
  import WorkAttentionBoard from './work-attention-board.svelte';
  import WorkAttentionDetail from './work-attention-detail.svelte';
  import WorkCoverageLine from './work-coverage-line.svelte';

  let {
    board,
    detail,
  }: {
    board: ComponentProps<typeof WorkAttentionBoard>;
    detail?: ComponentProps<typeof WorkAttentionDetail>;
  } = $props();
</script>

<WebQueryProvider>
  <WorkCoverageLine coverage={board.dataset.coverage} reference={board.dataset.generatedAt} synthetic />
  <WorkAttentionBoard {...board} />
  {#if detail}
    <WorkAttentionDetail {...detail} />
  {/if}
</WebQueryProvider>
