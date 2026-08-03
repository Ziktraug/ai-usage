<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { Tabs } from '@ai-usage/design-system/svelte';
  import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
  import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
  import type { ProjectGroup } from '../../../../dashboard-analytics';
  import {
    type BreakdownSort,
    breakdownTabFor,
    type DashboardTab,
    type FieldFilterKey,
  } from '../../../../dashboard-search';
  import type { CursorCommitAttributionFacet } from '../../../../report-data';
  import type { WebReportPayloadWithoutRows } from '../../../../web-report-payload';
  import BreakdownPanel from './breakdown-panel.svelte';
  import CursorAttributionPanel from './cursor-attribution-panel.svelte';
  import HarnessProviderPanel from './harness-provider-panel.svelte';
  import ProjectsPanel from './projects-panel.svelte';

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
      models: readonly AnalyticsGroup[];
      projects: readonly ProjectGroup[];
    };
    navigation: {
      onSortChange: (sort: BreakdownSort) => void;
      onTabChange: (tab: string) => void;
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
    if (value !== selectedTab) {
      navigation.onTabChange(value);
    }
  };
</script>

{#snippet modelsPanel()}
  <section class={section}>
    <BreakdownPanel
      countLabel="models"
      dimension="models"
      generatedAt={data.generatedAt}
      groups={data.models}
      onFilter={onFieldFilter}
      onSortChange={navigation.onSortChange}
      sort={navigation.sort}
      title="By model"
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
      onProjectFilter={(value) => onFieldFilter('project', value)}
      onSave={projectEditor.onSave}
      payload={projectEditor.payload}
    />
  </section>
{/snippet}

{#snippet cursorPanel()}
  <section class={section}><CursorAttributionPanel rows={data.cursorRows} /></section>
{/snippet}

<Tabs
  ariaLabel="Breakdown dimension"
  items={[
    { content: modelsPanel, label: 'Models', value: 'models' },
    { content: harnessesPanel, label: 'Harnesses & providers', value: 'harness-providers' },
    { content: projectsPanel, label: 'Projects', value: 'projects' },
    { content: cursorPanel, label: 'Cursor AI', value: 'cursor-ai' },
  ]}
  onValueChange={changeTab}
  value={selectedTab}
/>
