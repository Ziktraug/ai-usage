<script lang="ts" module>
  import {
    advancedAnalysis,
    advancedAnalysisContent,
    advancedAnalysisHeader,
    advancedAnalysisHeaderText,
    emptyPanel,
    overviewGrid,
    twoColumns,
  } from '@ai-usage/design-system/report';
</script>

<script lang="ts">
  import type { FocusedOverviewResult, FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
  import type { LocalTimeCell } from '@ai-usage/report-core/session-query';
  import type { ComponentProps } from 'svelte';
  import type { DashboardDateRangeSearch } from '../../../../dashboard-search';
  import ActivityExplorer from '../range/activity-explorer.svelte';
  import ActivityHeatmap from './activity-heatmap.svelte';
  import OverviewHero from './overview-hero.svelte';
  import Punchcard from './punchcard.svelte';
  import Records from './records.svelte';
  import SessionShape from './session-shape.svelte';
  import TokenAnatomy from './token-anatomy.svelte';
  import { overviewHasContent } from './view-model';

  interface Props {
    activity?: ComponentProps<typeof ActivityExplorer>;
    /** Headline value of the window being dragged, or null when the brush is settled. */
    draggedWindowApiValue?: number | null;
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    onSelectTimeCell?: (cell: LocalTimeCell) => void;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    range: DashboardDateRangeSearch;
    result: FocusedOverviewResult;
  }

  const unchangedSessionItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem => item;

  let {
    activity,
    draggedWindowApiValue = null,
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    onSelectTimeCell = () => undefined,
    presentSessionItem = unchangedSessionItem,
    range,
    result,
  }: Props = $props();
</script>

<div class={overviewGrid} data-report-overview data-report-revision={result.revision}>
  {#if overviewHasContent(result)}
    <OverviewHero {draggedWindowApiValue} {range} summary={result.summary} />
    {#if activity}
      <ActivityExplorer {...activity} />
    {/if}
    <ActivityHeatmap heatmap={result.view.heatmap} {onSelectDay} />
    <TokenAnatomy summary={result.summary} />
    <Records
      {onSelectDay}
      {onSelectSession}
      {presentSessionItem}
      records={result.view.records}
      topSessions={result.view.topSessions}
    />
    <section aria-labelledby="advanced-analysis-title" class={advancedAnalysis} data-overview-advanced-analysis>
      <header class={advancedAnalysisHeader}>
        <h2 id="advanced-analysis-title">Advanced analysis</h2>
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
  {:else}
    <p class={emptyPanel}>No sessions match the selected report range and filters.</p>
  {/if}
</div>
