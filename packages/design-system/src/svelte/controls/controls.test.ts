import { afterAll, describe, expect, test } from 'bun:test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { segmentBarWidth, visibleBarSegments } from './segment-bar';

interface RenderResult {
  body: string;
}

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => RenderResult;
}

const componentFrom = (loaded: unknown, label: string): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error(`${label} did not expose a Svelte component`);
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: process.cwd(),
  server: { hmr: false, middlewareMode: true, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);

const loadSsrModules = async (): Promise<readonly [unknown, unknown, unknown]> => {
  try {
    return await Promise.all([
      viteServer.ssrLoadModule('/packages/design-system/src/svelte/controls/controls.fixture.svelte'),
      viteServer.ssrLoadModule('/packages/design-system/src/svelte/controls/metric-tile.svelte'),
      viteServer.ssrLoadModule('svelte/server'),
    ]);
  } catch (error) {
    const [cleanup] = await Promise.allSettled([closeViteServer()]);
    if (cleanup?.status === 'rejected') {
      throw new AggregateError([error, cleanup.reason], 'Svelte SSR module load and Vite cleanup both failed');
    }
    throw error;
  }
};

const [fixtureModule, metricModule, svelteServerModule] = await loadSsrModules();
const fixture = componentFrom(fixtureModule, 'controls fixture');
const metricTile = componentFrom(metricModule, 'metric tile');
const { render } = rendererFrom(svelteServerModule);

const fixtureHtml = render(fixture).body;

describe('Svelte basic controls fixture', () => {
  test('renders controlled Toggle semantics and the disabled state', () => {
    expect(fixtureHtml).toContain('type="button"');
    expect(fixtureHtml).toContain('aria-label="Toggle synthetic feature"');
    expect(fixtureHtml).toContain('title="Toggle synthetic feature"');
    expect(fixtureHtml).toContain('aria-pressed="false"');
    expect(fixtureHtml).toContain('aria-label="Disabled synthetic feature"');
    expect(fixtureHtml).toContain('disabled=""');
    expect(fixtureHtml).toContain('data-disabled=""');
  });

  test('renders HarnessBadge passive and interactive branches', () => {
    expect(fixtureHtml).toContain('aria-label="Filter by Claude Code"');
    expect(fixtureHtml).toContain('title="Filter by Claude Code"');
    expect(fixtureHtml).toContain('bg_harness.claude.bg');
    expect(fixtureHtml).toContain('>Unknown Agent</span>');
    expect(fixtureHtml).toContain('bg_surfaceMuted');
    expect(fixtureHtml).toContain('data-parent-clicks="0"');
  });

  test('renders Checkbox native input, label, state and indicator', () => {
    expect(fixtureHtml).toContain('type="checkbox"');
    expect(fixtureHtml).toContain('checked=""');
    expect(fixtureHtml).toContain('data-part="control" data-state="checked"');
    expect(fixtureHtml).toContain('data-part="label" data-state="checked"');
    expect(fixtureHtml).toContain('Synthetic checkbox');
    expect(fixtureHtml).toContain('Disabled synthetic checkbox');
    expect(fixtureHtml).toContain('data-disabled-changes="0"');
    expect(fixtureHtml).toContain('✓');
  });

  test('renders only positive SegmentBar entries with stable widths and titles', () => {
    expect(fixtureHtml).toContain('aria-label="Synthetic proportions"');
    expect(fixtureHtml).toContain('role="img"');
    expect(fixtureHtml).toContain('title="Alpha: 1" style="width: 25%;"');
    expect(fixtureHtml).toContain('title="Custom beta title" style="width: 75%;"');
    expect(fixtureHtml).not.toContain('segment-hidden');
    expect(fixtureHtml).toContain('aria-label="Empty proportions"');
  });

  test('renders MetricTile value, hint and AT-hidden comparison arrow', () => {
    expect(fixtureHtml).toContain('title="Synthetic metric hint"');
    expect(fixtureHtml).toContain('Synthetic metric');
    expect(fixtureHtml).toContain('>42</div>');
    expect(fixtureHtml).toContain('title="Compared with synthetic baseline"');
    expect(fixtureHtml).toContain('<span aria-hidden="true"');
    expect(fixtureHtml).toContain('▼');
    expect(fixtureHtml).toContain('Down 2%');

    const withoutDelta = render(metricTile, { props: { label: 'No delta', value: '7' } }).body;
    expect(withoutDelta).toContain('No delta');
    expect(withoutDelta).toContain('>7</div>');
    expect(withoutDelta).not.toContain('aria-hidden="true"');
  });
});

describe('SegmentBar model', () => {
  test('keeps input order while excluding non-positive entries', () => {
    const segments = [
      { class: 'first', label: 'First', value: 2 },
      { class: 'zero', label: 'Zero', value: 0 },
      { class: 'negative', label: 'Negative', value: -1 },
      { class: 'last', label: 'Last', value: 3 },
    ] as const;

    expect(visibleBarSegments(segments).map(({ label }) => label)).toEqual(['First', 'Last']);
    expect(segmentBarWidth(segments, 2)).toBe(50);
    expect(segmentBarWidth([], 0)).toBe(0);
  });
});
