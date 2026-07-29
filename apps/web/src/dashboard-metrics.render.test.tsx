import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';

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
  metrics: MetricTileProps[];
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
if (
  !(
    loaded &&
    typeof loaded === 'object' &&
    'MetricTile' in loaded &&
    typeof loaded.MetricTile === 'function' &&
    'MetricComparisonNotice' in loaded &&
    typeof loaded.MetricComparisonNotice === 'function' &&
    'ValueBasesPanel' in loaded &&
    typeof loaded.ValueBasesPanel === 'function'
  )
) {
  throw new Error('Vite did not load dashboard metric components');
}
const MetricTile = loaded.MetricTile as Component<MetricTileProps>;
const MetricComparisonNotice = loaded.MetricComparisonNotice as Component<MetricComparisonNoticeProps>;
const ValueBasesPanel = loaded.ValueBasesPanel as Component<ValueBasesPanelProps>;
const pendingSurfaceLoaded: unknown = await viteServer.ssrLoadModule('/src/dashboard-pending-surface.tsx');
if (
  !(
    pendingSurfaceLoaded &&
    typeof pendingSurfaceLoaded === 'object' &&
    'DashboardPendingSurface' in pendingSurfaceLoaded &&
    typeof pendingSurfaceLoaded.DashboardPendingSurface === 'function'
  )
) {
  throw new Error('Vite did not load DashboardPendingSurface');
}
const DashboardPendingSurface = pendingSurfaceLoaded.DashboardPendingSurface as Component;
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
      hint: 'Estimated cost at standard API prices',
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
          { hint: 'Standard API prices', label: 'API value · measured', value: '$12.00' },
          { hint: 'Out-of-pocket spend', label: 'Actual cost', value: '$3.00' },
          { hint: 'Covered by subscription quota', label: 'Sub value', value: '$9.00' },
        ],
      }),
    );

    expect(html).toContain('data-value-bases-panel');
    expect(html).toContain('Value bases');
    expect(html.match(/data-value-bases-row/g)).toHaveLength(3);
    expect(html).toContain('API-equivalent value');
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
