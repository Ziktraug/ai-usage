<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits the closed boolean WAI-ARIA value asserted by SSR tests -->
<script lang="ts">
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { SessionColumnId } from '../../../../session-table-schema';
  import { applySessionFieldFilter, projectSessionCell } from './session-cell-projection';
  import {
    expandButton,
    filterButton,
    highlightedMark,
    provenanceMarker,
    sessionAnnotation,
    sessionCellContent,
  } from './session-table-styles';

  let {
    canExpand,
    columnId,
    depth,
    expanded,
    onFieldFilter,
    onHarnessFilter,
    onToggleExpanded,
    query,
    row,
  }: {
    canExpand: boolean;
    columnId: SessionColumnId;
    depth: number;
    expanded: boolean;
    onFieldFilter: (key: 'campaign' | 'model' | 'project' | 'provider', value: string) => void;
    onHarnessFilter: (value: string) => void;
    onToggleExpanded: () => void;
    query: string;
    row: SessionPresentationRow;
  } = $props();

  const projection = $derived(projectSessionCell(row, columnId, query));
</script>

{#if projection.kind === 'session'}
  <span class={sessionCellContent} style:padding-left={`${depth * 14}px`}>
    {#if canExpand}
      <button
        aria-expanded={expanded ? 'true' : 'false'}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} campaign ${row.sessionLabel}`}
        class={expandButton}
        onclick={(event) => {
          event.stopPropagation();
          onToggleExpanded();
        }}
        title={expanded ? 'Collapse campaign' : 'Expand campaign'}
        type="button"
      >
        {expanded ? '▾' : '▸'}
      </button>
    {/if}
    {#each projection.segments as segment, index (`${index}:${segment.text}`)}
      {#if segment.match}
        <mark class={highlightedMark}>{segment.text}</mark>
      {:else}
        {segment.text}
      {/if}
    {/each}
    {#if projection.provenanceTitle}
      <span class={provenanceMarker} data-session-provenance title={projection.provenanceTitle}> ⓘ</span>
    {/if}
    {#if depth > 0 && projection.originLabel}
      <span class={sessionAnnotation} data-session-origin="classifier"> · {projection.originLabel}</span>
    {/if}
    {#if projection.campaignLabel}
      <span class={sessionAnnotation} title={projection.campaignLabel}> · {projection.campaignLabel}</span>
    {/if}
    {#if projection.classifierLabel}
      <span class={sessionAnnotation} data-campaign-classifier-rollup title={projection.classifierLabel}>
        · {projection.classifierLabel}
      </span>
    {/if}
  </span>
{:else if projection.kind === 'harness-filter'}
  <HarnessBadge name={projection.label} onClick={() => onHarnessFilter(projection.value)} title={projection.title} />
{:else if projection.kind === 'field-filter'}
  <button
    aria-pressed="false"
    class={filterButton}
    onclick={(event) => applySessionFieldFilter(event, onFieldFilter, projection.field, projection.value)}
    title={projection.title}
    type="button"
  >
    {projection.label}
  </button>
{:else}
  <span title={projection.title}>{projection.label}</span>
  {#if projection.provenanceTitle}
    <span class={provenanceMarker} data-session-provenance title={projection.provenanceTitle}> ⓘ</span>
  {/if}
{/if}
