<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { Tabs } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { SessionQueryRange } from '@ai-usage/report-core/session-query';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import {
    type BreakdownSort,
    type BreakdownTab,
    breakdownTabFor,
    type DashboardTab,
    type FieldFilterKey,
  } from '../../../../dashboard-search';
  import type { CursorCommitAttributionFacet } from '../../../../report-data';
  import type { WebReportPayloadWithoutRows } from '../../../../web-report-payload';
  import CursorAttributionPanel from './cursor-attribution-panel.svelte';
  import HarnessProviderPanel from './harness-provider-panel.svelte';
  import ModelAnalysisTable from './model-analysis-table.svelte';
  import ProjectsPanel from './projects-panel.svelte';
  import { analysisTabs } from './styles';

  const section = css({ display: 'grid', gap: '14px', minW: 0 });

  let {
    data,
    navigation,
    onFieldFilter,
    onHarnessFilter,
    projectEditor,
  }: {
    data: {
      cursorRows: readonly CursorCommitAttributionFacet[];
      generatedAt: string;
      harnesses: readonly AnalyticsGroup[];
      harnessProviders: readonly AnalyticsGroup[];
      /** Exact store-wide machine count, or null when the option list is truncated. */
      machineCount?: number | null;
      models: readonly AnalyticsGroup[];
      projects: readonly ProjectGroup[];
      range: SessionQueryRange;
    };
    navigation: {
      onSortChange: (sort: BreakdownSort) => void;
      onTabChange: (tab: BreakdownTab) => void;
      sort: BreakdownSort;
      tab: DashboardTab;
    };
    onFieldFilter: (key: FieldFilterKey, value: string) => void;
    onHarnessFilter: (value: string) => void;
    projectEditor: {
      disabled: boolean;
      onSave: (projectGroups: readonly ProjectGroupConfig[]) => Promise<void>;
      payload: Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>;
    };
  } = $props();

  const selectedTab = $derived(breakdownTabFor(navigation.tab));
  const changeTab = (value: string): void => {
    if (
      value !== selectedTab &&
      (value === 'models' || value === 'harness-providers' || value === 'projects' || value === 'cursor-ai')
    ) {
      navigation.onTabChange(value);
    }
  };
</script>

{#snippet modelsPanel()}
  <section class={section}>
    <ModelAnalysisTable
      generatedAt={data.generatedAt}
      groups={data.models}
      onModelFilter={(value) => onFieldFilter('model', value)}
      onSortChange={navigation.onSortChange}
      sort={navigation.sort}
    />
  </section>
{/snippet}

{#snippet harnessesPanel()}
  <section class={section}>
    <HarnessProviderPanel
      generatedAt={data.generatedAt}
      groups={data.harnesses}
      harnessProviderGroups={data.harnessProviders}
      {onHarnessFilter}
      onProviderFilter={(value) => onFieldFilter('provider', value)}
      onSortChange={navigation.onSortChange}
      sort={navigation.sort}
    />
  </section>
{/snippet}

{#snippet projectsPanel()}
  <section class={section}>
    <ProjectsPanel
      disabled={projectEditor.disabled}
      generatedAt={data.generatedAt}
      groups={data.projects}
      machineCount={data.machineCount ?? null}
      onProjectFilter={(value) => onFieldFilter('project', value)}
      onSave={projectEditor.onSave}
      payload={projectEditor.payload}
    />
  </section>
{/snippet}

{#snippet cursorPanel()}
  <section class={section}><CursorAttributionPanel range={data.range} rows={data.cursorRows} /></section>
{/snippet}

<div class={analysisTabs}>
  <Tabs
    ariaLabel="Analysis dimension"
    items={[
      { content: modelsPanel, label: 'Models', value: 'models' },
      { content: harnessesPanel, label: 'Harnesses & providers', value: 'harness-providers' },
      { content: projectsPanel, label: 'Projects', value: 'projects' },
      { content: cursorPanel, label: 'Cursor AI', value: 'cursor-ai' },
    ]}
    onValueChange={changeTab}
    value={selectedTab}
  />
</div>
