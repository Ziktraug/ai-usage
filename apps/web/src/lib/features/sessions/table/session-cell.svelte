<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits the closed boolean WAI-ARIA value asserted by SSR tests -->
<script lang="ts">
  import CellWithProvenance from '@ai-usage/design-system/svelte/cell-with-provenance';
  import HarnessBadge from '@ai-usage/design-system/svelte/harness-badge';
  import { filterTextButton, highlightMark, muted, sessionTitleClamp } from '@ai-usage/design-system/svelte/passive';
  import ProvenanceMarker from '@ai-usage/design-system/svelte/provenance-marker';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { SessionColumnId } from '../../../../session-table-schema';
  import { applySessionFieldFilter, projectSessionCell } from './session-cell-projection';

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
  <div class={sessionTitleClamp} style:padding-left={`${depth * 14}px`}>
    {#if canExpand}
      <button
        aria-expanded={expanded ? 'true' : 'false'}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} campaign ${row.sessionLabel}`}
        class={filterTextButton}
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
        <mark class={highlightMark}>{segment.text}</mark>
      {:else}
        {segment.text}
      {/if}
    {/each}
    {#if projection.provenanceFacts.length > 0}
      {' '}<ProvenanceMarker facts={projection.provenanceFacts} />
    {/if}
    {#if depth > 0 && projection.originLabel}
      <span class={muted} data-session-origin="classifier"> {projection.originLabel}</span>
    {/if}
    {#if projection.campaignLabel}
      <span class={muted} data-session-campaign-annotation title={projection.campaignLabel}>
        {projection.campaignLabel}</span
      >
    {/if}
    {#if projection.classifierLabel}
      <span class={muted} data-campaign-classifier-rollup title={projection.classifierLabel}>
        {projection.classifierLabel}
      </span>
    {/if}
  </div>
{:else if projection.kind === 'harness-filter'}
  <HarnessBadge name={projection.label} onClick={() => onHarnessFilter(projection.value)} title={projection.title} />
{:else if projection.kind === 'field-filter'}
  <button
    aria-pressed="false"
    class={filterTextButton}
    onclick={(event) => applySessionFieldFilter(event, onFieldFilter, projection.field, projection.value)}
    title={projection.title}
    type="button"
  >
    {projection.label}
  </button>
{:else}
  <CellWithProvenance facts={projection.provenanceFacts}>
    <span title={projection.title}>{projection.label}</span>
  </CellWithProvenance>
{/if}
