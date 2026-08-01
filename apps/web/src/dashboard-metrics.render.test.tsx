import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { DashboardMetricKind } from './dashboard-metric-model';
import { assertFunctionExports } from './render-test-module';

interface MetricTileProps {
  delta?: { hint: string; pct: number } | null;
  hint?: string;
  label: string;
  value: string;
}
type MetricComparisonState = 'available' | 'full-range' | 'no-prior-data';
interface MetricComparisonNoticeProps {
  state: MetricComparisonState;
}
interface ValueBasesPanelProps {
  metrics: (MetricTileProps & { kind: DashboardMetricKind })[];
}

interface DashboardMetricsModule {
  MetricComparisonNotice: Component<MetricComparisonNoticeProps>;
  MetricTile: Component<MetricTileProps>;
  ValueBasesPanel: Component<ValueBasesPanelProps>;
}

interface DashboardPendingSurfaceModule {
  DashboardPendingSurface: Component;
}

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/dashboard-metrics.tsx');
assertFunctionExports<DashboardMetricsModule>(
  loaded,
  ['MetricTile', 'MetricComparisonNotice', 'ValueBasesPanel'],
  'dashboard metric components',
);
const { MetricComparisonNotice, MetricTile, ValueBasesPanel } = loaded;
const pendingSurfaceLoaded: unknown = await viteServer.ssrLoadModule('/src/dashboard-pending-surface.tsx');
assertFunctionExports<DashboardPendingSurfaceModule>(
  pendingSurfaceLoaded,
  ['DashboardPendingSurface'],
  'DashboardPendingSurface',
);
const { DashboardPendingSurface } = pendingSurfaceLoaded;
afterAll(async () => viteServer.close());

const render = (props: MetricTileProps): string => renderToString(() => createComponent(MetricTile, props));
const renderPending = (): string => renderToString(() => createComponent(DashboardPendingSurface, {}));
const renderComparison = (state: MetricComparisonState): string =>
  renderToString(() => createComponent(MetricComparisonNotice, { state }));

describe('MetricTile', () => {
  test('renders an on-face comparison basis and discoverable provenance control', () => {
    const html = render({
      delta: {
        hint: 'Previous period of equal length: $1.00',
        pct: 200,
      },
      hint: 'Estimated API-equivalent value at standard prices',
      label: 'API value',
      value: '$3.00',
    });

    expect(html).toContain('data-metric-tile');
    expect(html).toContain('data-metric-value');
    expect(html).toContain('data-metric-delta');
    expect(html).toContain('200% vs previous period');
    expect(html).toContain('aria-label="About API value"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('title="About API value"');
  });

  test('groups the three monetary definitions into labelled Value bases rows', () => {
    const html = renderToString(() =>
      createComponent(ValueBasesPanel, {
        metrics: [
          { hint: 'Standard API prices', kind: 'api-value', label: 'API value · measured', value: '$12.00' },
          { hint: 'Out-of-pocket spend', kind: 'actual-cost', label: 'Actual cost', value: '$3.00' },
          { hint: 'Covered by subscription quota', kind: 'subscription-value', label: 'Sub value', value: '$9.00' },
        ],
      }),
    );

    expect(html).toContain('data-value-bases-panel');
    expect(html).toContain('Value bases');
    expect(html.match(/data-value-bases-row/g)).toHaveLength(3);
    expect(html).toContain('Estimated API-equivalent value');
    expect(html).toContain('Actual recorded cost');
    expect(html).toContain('Subscription value');
    expect(html).toContain('aria-label="About API value · measured"');
    expect(html).toContain('aria-label="About Actual cost"');
    expect(html).toContain('aria-label="About Sub value"');
  });
});

describe('MetricComparisonNotice', () => {
  test('renders one distinct explanation only when previous data is unavailable', () => {
    const available = renderComparison('available');
    const fullRange = renderComparison('full-range');
    const noPriorData = renderComparison('no-prior-data');

    expect(available).not.toContain('data-metric-comparison-state');
    expect(fullRange).toContain('data-metric-comparison-state="full-range"');
    expect(fullRange).toContain('No previous period exists before the full recorded range.');
    expect(fullRange).not.toContain('No sessions exist in the previous period.');
    expect(noPriorData).toContain('data-metric-comparison-state="no-prior-data"');
    expect(noPriorData).toContain('No sessions exist in the previous period.');
    expect(noPriorData).not.toContain('No previous period exists before the full recorded range.');
  });
});

describe('DashboardPendingSurface', () => {
  test('announces loading without definitive zero or empty-result claims', () => {
    const html = renderPending();

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-report-pending');
    expect(html).toContain('Loading report…');
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('hidden by filters');
    expect(html).not.toContain('No sessions');
  });
});
