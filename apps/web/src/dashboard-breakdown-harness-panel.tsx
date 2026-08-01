import { section } from '@ai-usage/design-system/report';
import type { DashboardBreakdownProps } from './dashboard-breakdown';
import { createAnalyticsExport } from './dashboard-breakdown-export';
import { HarnessProviderPanel, type VisibleBreakdownGroup } from './group-panel';
import { ReportSharingActions } from './report-sharing-actions';

export const HarnessBreakdownPanel = (props: DashboardBreakdownProps) => (
  <section class={section}>
    <HarnessProviderPanel
      groups={props.data.harnesses}
      harnessProviderGroups={props.data.harnessProviders}
      onHarnessFilter={props.onHarnessFilter}
      onProviderFilter={(value) => props.onFieldFilter('provider', value)}
      onSortChange={props.navigation.onSortChange}
      renderActions={(groups: readonly VisibleBreakdownGroup[]) => (
        <ReportSharingActions createExport={() => createAnalyticsExport('harnesses', props.data.generatedAt, groups)} />
      )}
      sort={props.navigation.sort}
    />
  </section>
);
