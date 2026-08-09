<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import {
    actionRow,
    groupCount,
    groupHeader,
    groupPanel,
    groupRow,
    groupRows,
    groupTitle,
    searchInput,
    unavailableText,
  } from '@ai-usage/design-system/svelte/passive';
  import SegmentedControl from '@ai-usage/design-system/svelte/segmented-control';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { BreakdownSort } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import BreakdownRow from './breakdown-row.svelte';
  import { harnessProviderView, providerPairCountLabel } from './harness-provider-model';
  import { projectBreakdownRow } from './model';

  let {
    generatedAt,
    groups,
    harnessProviderGroups,
    onHarnessFilter,
    onProviderFilter,
    onSortChange,
    sort,
  }: {
    generatedAt: string;
    groups: readonly AnalyticsGroup[];
    harnessProviderGroups: readonly AnalyticsGroup[];
    onHarnessFilter: (value: string) => void;
    onProviderFilter: (value: string) => void;
    onSortChange: (sort: BreakdownSort) => void;
    sort: BreakdownSort;
  } = $props();

  let query = $state('');
  let expandedHarnesses: readonly string[] = $state([]);
  const view = $derived(harnessProviderView(groups, harnessProviderGroups, query, sort, expandedHarnesses));
  const maxKnownCost = $derived(Math.max(0, ...view.parents.map(({ group }) => group.costSum)));
  const sortItems = [
    { label: 'Value', value: 'value' },
    { label: 'Tokens', value: 'tokens' },
    { label: 'Sessions', value: 'sessions' },
  ];
  const changeSort = (value: string): void => {
    if (value === 'value' || value === 'tokens' || value === 'sessions') {
      onSortChange(value);
    }
  };
  const toggleHarness = (harness: string): void => {
    expandedHarnesses = expandedHarnesses.includes(harness)
      ? expandedHarnesses.filter((value) => value !== harness)
      : [...expandedHarnesses, harness];
  };
  const createExport = async (): Promise<{ csv: string; filename: string }> => ({
    csv: analyticsBreakdownCsv(view.exportRows),
    filename: reportCsvFilename('harnesses', generatedAt),
  });
  const hierarchyBlock = css({
    borderBottom: '1px solid token(colors.line)',
    _last: { borderBottom: '0' },
  });
  const hierarchyChildren = css({ minW: 0, border: '0', m: 0, p: 0 });
</script>

<section class={groupPanel} data-breakdown-panel="harness-providers">
  <header class={groupHeader}>
    <h2 class={groupTitle}>Harnesses & providers</h2>
    <span
      class={groupCount}
      title={`${fmtNum(view.parents.length)} harnesses · ${providerPairCountLabel(view.pairCount)}`}
      >{fmtNum(view.parents.length)}
      harnesses · {providerPairCountLabel(view.pairCount)}</span
    >
    <div class={actionRow} style:grid-column="1 / -1">
      <input
        aria-label="Search this breakdown"
        class={searchInput}
        placeholder="Search this breakdown"
        type="search"
        bind:value={query}
      >
      <SegmentedControl
        ariaLabel="Sort breakdown"
        defaultValue="value"
        items={sortItems}
        onValueChange={changeSort}
        value={sort}
      />
      <ReportSharingActions {createExport} />
    </div>
  </header>
  <div class={groupRows}>
    {#if view.parents.length === 0}
      <div class={groupRow} role="status"><div class={unavailableText}>No breakdown rows match this search</div></div>
    {:else}
      {#each view.parents as parent (parent.group.key)}
        {@const parentView = projectBreakdownRow(parent.group, parent.group.key, maxKnownCost)}
        <section class={hierarchyBlock} data-harness-total={parent.group.harness}>
          <BreakdownRow
            controlsId={parent.controlsId}
            expanded={parent.expanded}
            hierarchy
            onFilter={() => onHarnessFilter(parent.group.key)}
            {...(!view.searchActive ? { onToggle: () => toggleHarness(parent.group.key) } : {})}
            view={parentView}
          />
          {#if parent.children.length > 0}
            <fieldset aria-label={`Providers for ${parent.group.key}`} class={hierarchyChildren} id={parent.controlsId}>
              {#each parent.children as child (child.group.provider)}
                <BreakdownRow
                  child
                  hierarchy
                  onFilter={() => onProviderFilter(child.group.provider)}
                  view={projectBreakdownRow(child.group, child.label, maxKnownCost)}
                />
              {/each}
            </fieldset>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</section>
