import { css } from '@ai-usage/design-system/css';
import { meta } from '@ai-usage/design-system/report';
import { For } from 'solid-js';
import { type Metric, type MetricComparisonState, splitDashboardMetrics } from './dashboard-metric-model';
import { dashboardMetricGrid, MetricComparisonNotice, MetricTile, ValueBasesPanel } from './dashboard-metrics';
import { DashboardProviderStatus, type DashboardProviderStatusProps } from './dashboard-provider-status';

const secondaryMetrics = css({
  my: '20px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

const secondaryMetricsHeader = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  p: '14px 16px',
  color: 'ink',
  fontWeight: 600,
  borderBottom: '1px solid token(colors.line)',
});

const secondaryMetricsTitle = css({
  m: 0,
  fontSize: 'inherit',
  fontWeight: 'inherit',
});

const secondaryMetricsGrid = css({
  display: 'block',
  px: '14px',
  pb: '14px',
  '& > div': { my: '14px' },
});

export interface DashboardStatusProps {
  comparisonState: MetricComparisonState;
  metrics: readonly Metric[];
  providerStatus: DashboardProviderStatusProps;
}

export const DashboardStatus = (props: DashboardStatusProps) => {
  const metricSections = () => splitDashboardMetrics(props.metrics);

  return (
    <>
      <section aria-labelledby="additional-report-metrics-title" class={secondaryMetrics}>
        <header class={secondaryMetricsHeader}>
          <h2 class={secondaryMetricsTitle} id="additional-report-metrics-title">
            More report metrics
          </h2>
          <span class={meta}>{props.metrics.length}</span>
        </header>
        <div class={secondaryMetricsGrid} id="additional-report-metrics">
          <div class={dashboardMetricGrid} data-metric-grid>
            <MetricComparisonNotice state={props.comparisonState} />
            <ValueBasesPanel metrics={metricSections().valueBases} />
            <For each={metricSections().remainingMetrics}>{(metric) => <MetricTile {...metric} />}</For>
          </div>
        </div>
      </section>
      <DashboardProviderStatus {...props.providerStatus} />
    </>
  );
};
