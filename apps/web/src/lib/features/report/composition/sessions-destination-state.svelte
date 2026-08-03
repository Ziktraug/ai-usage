<script lang="ts">
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { Snippet } from 'svelte';

  let {
    children,
    onRowsChange,
    onSessionCountChange,
    presentRow,
    sessionCount,
    sourceRows,
  }: {
    children: Snippet<[readonly SessionPresentationRow[]]>;
    onRowsChange: (rows: readonly SessionPresentationRow[]) => void;
    onSessionCountChange: (sessionCount: number | undefined) => void;
    presentRow: (row: SessionPresentationRow) => SessionPresentationRow;
    sessionCount: number | undefined;
    sourceRows: readonly SessionPresentationRow[];
  } = $props();

  const rows = $derived(sourceRows.map(presentRow));

  $effect(() => {
    onRowsChange(rows);
    onSessionCountChange(sessionCount);
  });
</script>

{@render children(rows)}
