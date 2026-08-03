import { unavailableText } from '@ai-usage/design-system/report';
import { Tabs } from '@ai-usage/design-system/solid';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import { lazy, Suspense } from 'solid-js';
import type { ProjectGroup } from './dashboard-analytics';
import { HarnessBreakdownPanel } from './dashboard-breakdown-harness-panel';
import { type BreakdownSort, breakdownTabFor, type DashboardTab, type FieldFilterKey } from './dashboard-search';
import type { CursorCommitAttributionFacet } from './report-data';
import type { WebReportPayloadWithoutRows } from './web-report-payload';

const ModelsBreakdownPanel = lazy(async () => {
  const module = await import('./dashboard-breakdown-panels');
  return { default: module.ModelsBreakdownPanel };
});

const ProjectsBreakdownPanel = lazy(async () => {
  const module = await import('./dashboard-breakdown-panels');
  return { default: module.ProjectsBreakdownPanel };
});

const CursorBreakdownPanel = lazy(async () => {
  const module = await import('./dashboard-breakdown-panels');
  return { default: module.CursorBreakdownPanel };
});

interface DashboardBreakdownData {
  cursorRows: CursorCommitAttributionFacet[];
  generatedAt: string;
  harnesses: AnalyticsGroup[];
  harnessProviders: AnalyticsGroup[];
  models: AnalyticsGroup[];
  projects: ProjectGroup[];
}

interface DashboardBreakdownNavigation {
  onSortChange: (sort: BreakdownSort) => void;
  onTabChange: (tab: string) => void;
  sort: BreakdownSort;
  tab: DashboardTab;
}

interface DashboardProjectGroupEditor {
  disabled: boolean;
  onSave: (projectGroups: ProjectGroupConfig[]) => Promise<void>;
  payload: Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>;
}

export interface DashboardBreakdownProps {
  data: DashboardBreakdownData;
  navigation: DashboardBreakdownNavigation;
  onFieldFilter: (key: FieldFilterKey, value: string) => void;
  onHarnessFilter: (value: string) => void;
  projectEditor: DashboardProjectGroupEditor;
}

const withPanelFallback = (panel: () => ReturnType<typeof ModelsBreakdownPanel>) => (
  <Suspense fallback={<div class={unavailableText}>Loading breakdown…</div>}>{panel()}</Suspense>
);

export const DashboardBreakdown = (props: DashboardBreakdownProps) => (
  <Tabs
    ariaLabel="Breakdown dimension"
    items={[
      {
        content: () => withPanelFallback(() => <ModelsBreakdownPanel {...props} />),
        label: 'Models',
        value: 'models',
      },
      {
        content: () => <HarnessBreakdownPanel {...props} />,
        label: 'Harnesses & providers',
        value: 'harness-providers',
      },
      {
        content: () => withPanelFallback(() => <ProjectsBreakdownPanel {...props} />),
        label: 'Projects',
        value: 'projects',
      },
      {
        content: () => withPanelFallback(() => <CursorBreakdownPanel {...props} />),
        label: 'Cursor AI',
        value: 'cursor-ai',
      },
    ]}
    onValueChange={(value) => {
      if (value !== breakdownTabFor(props.navigation.tab)) {
        props.navigation.onTabChange(value);
      }
    }}
    value={breakdownTabFor(props.navigation.tab)}
  />
);
