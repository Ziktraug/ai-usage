<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits the closed boolean WAI-ARIA value asserted by SSR tests -->
<script lang="ts">
  import {
    CellWithProvenance,
    filterTextButton,
    HarnessBadge,
    highlightMark,
    muted,
    ProvenanceMarker,
    provenanceTitle,
    sessionTitleClamp,
  } from '@ai-usage/design-system/svelte';
  import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
  import type { SessionColumnId } from '../../../../session-table-schema';
  import {
    applySessionFieldFilter,
    projectSessionCell,
    type SessionRowProvenanceSummary,
    sharedProvenanceMarkerFacts,
  } from './session-cell-projection';

  const EMPTY_ROW_PROVENANCE: SessionRowProvenanceSummary = { shared: [], sharedKinds: new Set() };

  let {
    campaignRootLabel,
    canExpand,
    columnId,
    depth,
    expanded,
    onFieldFilter,
    onHarnessFilter,
    onToggleExpanded,
    query,
    row,
    rowProvenance = EMPTY_ROW_PROVENANCE,
  }: {
    campaignRootLabel?: string | undefined;
    canExpand: boolean;
    columnId: SessionColumnId;
    depth: number;
    expanded: boolean;
    onFieldFilter: (key: 'campaign' | 'model' | 'project' | 'provider', value: string) => void;
    onHarnessFilter: (value: string) => void;
    onToggleExpanded: () => void;
    query: string;
    row: SessionPresentationRow;
    rowProvenance?: SessionRowProvenanceSummary;
  } = $props();

  const projection = $derived(projectSessionCell(row, columnId, query, campaignRootLabel));
</script>

{#if projection.kind === 'session'}
  {@const markerFacts = [...projection.provenanceFacts, ...sharedProvenanceMarkerFacts(rowProvenance)]}
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
    {#if projection.inheritedTitle}
      <span class={muted} data-session-inherited-title title="Title inherited from the campaign root session"
        >{projection.inheritedTitle}</span
      ><span class={muted}>{' · '}</span>
    {/if}
    {#each projection.segments as segment, index (`${index}:${segment.text}`)}
      {#if segment.match}
        <mark class={highlightMark}>{segment.text}</mark>
      {:else}
        {segment.text}
      {/if}
    {/each}
    {#if markerFacts.length > 0}
      {' '}<ProvenanceMarker facts={markerFacts} />
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
  {@const ownFacts = projection.provenanceFacts.filter((fact) => !rowProvenance.sharedKinds.has(fact.kind))}
  {@const suppressed = projection.provenanceFacts.filter((fact) => rowProvenance.sharedKinds.has(fact.kind))}
  <CellWithProvenance facts={ownFacts}>
    <span
      data-provenance-shared={suppressed.length > 0 ? suppressed.map((fact) => fact.kind).join(' ') : undefined}
      title={[projection.title, suppressed.length > 0 ? provenanceTitle(suppressed) : undefined]
        .filter(Boolean)
        .join('\n')}
      >{projection.label}</span
    >
  </CellWithProvenance>
{/if}
