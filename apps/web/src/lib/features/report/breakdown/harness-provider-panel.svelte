<script lang="ts">
  import { SegmentedControl } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import { analyticsBreakdownCsv, reportCsvFilename } from '@ai-usage/report-core/csv';
  import type { BreakdownSort } from '../../../../dashboard-search';
  import { fmtNum } from '../../../foundation/presentation/format';
  import ReportSharingActions from '../actions/report-sharing-actions.svelte';
  import BreakdownRow from './breakdown-row.svelte';
  import { harnessProviderView, providerPairCountLabel } from './harness-provider-model';
  import { projectBreakdownRow } from './model';
  import { field, list, muted, panel, panelHeader, row, title } from './styles';

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
</script>

<section class={panel} data-breakdown-panel="harness-providers">
  <header class={panelHeader}>
    <h2 class={title}>Harnesses & providers</h2>
    <span class={muted}>{fmtNum(view.parents.length)} harnesses · {providerPairCountLabel(view.pairCount)}</span>
  </header>
  <div class={row}>
    <input
      aria-label="Search this breakdown"
      class={field}
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
  {#if view.parents.length === 0}
    <p class={muted} role="status">No breakdown rows match this search</p>
  {:else}
    <div class={list}>
      {#each view.parents as parent (parent.group.key)}
        {@const parentView = projectBreakdownRow(parent.group, parent.group.key, maxKnownCost)}
        <section data-harness-total={parent.group.harness}>
          <BreakdownRow
            controlsId={parent.controlsId}
            expanded={parent.expanded}
            onFilter={() => onHarnessFilter(parent.group.key)}
            {...(!view.searchActive ? { onToggle: () => toggleHarness(parent.group.key) } : {})}
            view={parentView}
          />
          {#if parent.children.length > 0}
            <fieldset aria-label={`Providers for ${parent.group.key}`} id={parent.controlsId}>
              {#each parent.children as child (child.group.provider)}
                <BreakdownRow
                  child
                  onFilter={() => onProviderFilter(child.group.provider)}
                  view={projectBreakdownRow(child.group, child.label, maxKnownCost)}
                />
              {/each}
            </fieldset>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</section>
