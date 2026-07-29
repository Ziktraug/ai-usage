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

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/dashboard-metrics.tsx');
if (!(loaded && typeof loaded === 'object' && 'MetricTile' in loaded && typeof loaded.MetricTile === 'function')) {
  throw new Error('Vite did not load MetricTile');
}
const MetricTile = loaded.MetricTile as Component<MetricTileProps>;
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
