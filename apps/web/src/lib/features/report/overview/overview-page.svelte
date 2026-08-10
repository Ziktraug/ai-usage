<script lang="ts" module>
  import {
    advancedAnalysis,
    advancedAnalysisContent,
    advancedAnalysisHeader,
    advancedAnalysisHeaderText,
    editorialSection,
    emptyPanel,
    overviewGrid,
    sectionDivider,
    twoColumns,
  } from '@ai-usage/design-system/report';
</script>

<script lang="ts">
  import type { FocusedOverviewResult, FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
  import type { LocalTimeCell } from '@ai-usage/report-core/session-query';
  import type { ComponentProps } from 'svelte';
  import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import type ActivityExplorer from '../range/activity-explorer.svelte';
  import ActivityHeatmap from './activity-heatmap.svelte';
  import ExecutiveOverview from './executive-overview.svelte';
  import { buildExecutiveOverviewModel } from './executive-overview-model';
  import ProviderStatus from './provider-status.svelte';
  import Punchcard from './punchcard.svelte';
  import Records from './records.svelte';
  import SessionShape from './session-shape.svelte';
  import TokenAnatomy from './token-anatomy.svelte';

  interface Props {
    activity?: ComponentProps<typeof ActivityExplorer>;
    /** Headline value of the window being dragged, or null when the brush is settled. */
    draggedWindowApiValue?: number | null;
    modelsHref: string;
    onClearFilters?: () => void;
    onOpenModels: () => void;
    onOpenQuotaHistory?: () => void;
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    onSelectTimeCell?: (cell: LocalTimeCell) => void;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    providers?: readonly ProviderStatusView[];
    range: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
    totalSessionCount: number;
  }

  const unchangedSessionItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem => item;

  let {
    activity,
    draggedWindowApiValue = null,
    modelsHref,
    onClearFilters = () => undefined,
    onOpenModels,
    onOpenQuotaHistory,
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    onSelectTimeCell = () => undefined,
    presentSessionItem = unchangedSessionItem,
    providers = [],
    range,
    result,
    totalSessionCount,
  }: Props = $props();

  const executiveModel = $derived(
    buildExecutiveOverviewModel({
      executive: result.view.executive,
      previousSummary: result.view.previousSummary,
      rangeMode: range.mode,
      summary: result.summary,
      topItems: result.view.topSessions,
      totalSessionCount,
    }),
  );
</script>

<div class={overviewGrid} data-report-overview data-report-revision={result.revision}>
  <ExecutiveOverview
    {...(activity === undefined ? {} : { activity })}
    {draggedWindowApiValue}
    model={executiveModel}
    {modelsHref}
    {onClearFilters}
    {onOpenModels}
  />
  {#if executiveModel.emptyState === null}
    <section aria-labelledby="overview-investigate-title" class={editorialSection}>
      <header>
        <h2 id="overview-investigate-title">Investigate</h2>
        <p>Open the sessions, rhythms, and token structure behind the executive answer.</p>
      </header>
      <Records
        {onSelectDay}
        {onSelectSession}
        {presentSessionItem}
        records={result.view.records}
        topSessions={result.view.topSessions}
      />
      <ActivityHeatmap heatmap={result.view.heatmap} {onSelectDay} />
      <TokenAnatomy summary={result.summary} />
      <section aria-labelledby="advanced-analysis-title" class={advancedAnalysis} data-overview-advanced-analysis>
        <header class={advancedAnalysisHeader}>
          <h3 id="advanced-analysis-title">Advanced analysis</h3>
          <span class={advancedAnalysisHeaderText}
            >{result.view.advancedSummary?.summary ?? 'Session shape and weekly/hourly activity'}</span
          >
        </header>
        <div class={advancedAnalysisContent}>
          {#if result.view.advancedSummary}
            <div class={twoColumns}>
              {#if result.view.advancedSummary.hasSessionShape}
                <SessionShape
                  advancedSummary={result.view.advancedSummary}
                  {onSelectSession}
                  {presentSessionItem}
                  shape={result.view.sessionShape}
                />
              {/if}
              {#if result.view.advancedSummary.hasPunchcard}
                <Punchcard {onSelectTimeCell} punchcard={result.view.punchcard} />
              {/if}
            </div>
          {:else}
            <p class={emptyPanel}>No advanced analysis is available for these filters.</p>
          {/if}
        </div>
      </section>
    </section>
  {/if}
  {#if providers.length > 0}
    <div class={sectionDivider}>
      <ProviderStatus
        {...(onOpenQuotaHistory === undefined ? {} : { onOpenHistory: onOpenQuotaHistory })}
        {providers}
      />
    </div>
  {/if}
</div>
