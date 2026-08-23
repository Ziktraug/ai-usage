import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ProviderLimitWindow, ProviderStatusState } from '@ai-usage/report-core/provider-status';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { ProviderStatusTone, ProviderStatusView } from '../../../../provider-status-model';

const SVELTE_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const WINDOW_GROUP_PATTERN = /<div class="([^"]*)" data-provider-window-group="">/g;
const WINDOWS_GRID_PATTERN = /<div class="([^"]*)">\s*<div class="[^"]*" data-provider-window-group="">/;
const NO_QUOTA_LINE_PATTERN = /<li class="[^"]*" data-provider-no-quota-line="">([\s\S]*?)<\/li>/g;
const STATUS_SUMMARY_PATTERN = /<p class="[^"]*" data-provider-status-summary="">([\s\S]*?)<\/p>/;
const GLOSSARY_PATTERN = /<ul aria-label="[^"]*" class="[^"]*" data-provider-state-glossary="">([\s\S]*?)<\/ul>/;
const GLOSSARY_ITEM_PATTERN = /<li>([\s\S]*?)<\/li>/g;
const DETAIL_CARD_PATTERN = /<li class="/g;
const SEPARATOR_SPACING_PATTERN = /\S·|·\S/;

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Provider status panel did not expose a Svelte component.');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());

const [panelModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/overview/provider-status.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const ProviderStatus = componentFrom(panelModule);
const { render } = rendererFrom(svelteServerModule);

const quotaWindow = (id: string, group: string, usedPercent: number): ProviderLimitWindow => ({
  blocked: false,
  group,
  id,
  label: id,
  limitSeconds: group === '5h' ? 18_000 : 604_800,
  remainingPercent: 100 - usedPercent,
  resetsAt: '2026-08-24T00:00:00.000Z',
  scope: 'provider',
  usedPercent,
});

const providerView = (input: {
  key: string;
  label: string;
  machineContext?: string | null;
  /** Defaults to the label, so a distinct machine name means a distinct machine. */
  machineId?: string;
  state: ProviderStatusState;
  tone?: ProviderStatusTone;
  warnings?: string[];
  windowGroups?: ProviderStatusView['windowGroups'];
}): ProviderStatusView => ({
  accountContext: null,
  creditsSummary: null,
  machineContext: input.machineContext ?? null,
  nextResetAt: null,
  provider: {
    generatedAt: '2026-08-23T10:00:00.000Z',
    key: input.key,
    label: input.label,
    source: input.state === 'unsupported' ? 'unsupported' : 'local-history',
    state: input.state,
    ...(input.machineContext ? { machineLabel: input.machineContext } : {}),
    ...((input.machineId ?? input.machineContext)
      ? { machineId: input.machineId ?? (input.machineContext as string) }
      : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
    windows: (input.windowGroups ?? []).flatMap(({ windows }) => windows),
  },
  // Mirrors `sourceLabelFor` in provider-status-model.ts, which this plan holds read-only.
  sourceLabel: input.state === 'unsupported' ? 'No quota source' : 'Local history',
  tone: input.tone ?? 'ok',
  windowGroups: input.windowGroups ?? [],
  worstUsedPercent: null,
});

const codexWithWindows = providerView({
  key: 'codex',
  label: 'Codex',
  state: 'ok',
  windowGroups: [
    { key: '5h', label: '5h', windows: [quotaWindow('5h', '5h', 41)] },
    {
      key: 'weekly',
      label: 'Weekly',
      windows: [quotaWindow('weekly', 'weekly', 63), quotaWindow('weekly-opus', 'weekly', 12)],
    },
  ],
});
const claudeUnsupported = providerView({
  key: 'claude',
  label: 'Claude',
  machineContext: 'MacBook-Pro',
  state: 'unsupported',
  tone: 'muted',
});
const cursorPartial = providerView({
  key: 'cursor',
  label: 'Cursor',
  machineContext: 'Workstation',
  state: 'partial',
  tone: 'warning',
});
const opencodeCritical = providerView({
  key: 'opencode',
  label: 'OpenCode',
  state: 'error',
  tone: 'critical',
  warnings: ['The last collection run failed.'],
});

const renderPanel = (providers: readonly ProviderStatusView[]): string =>
  render(ProviderStatus, { props: { providers } }).body.replaceAll(SVELTE_COMMENT_PATTERN, '');

const detailsBlock = (html: string): string => {
  const start = html.indexOf('<details');
  if (start < 0) {
    return '';
  }
  return html.slice(start, html.indexOf('</details>', start));
};

describe('rendered provider status panel', () => {
  test('top-aligns every window column so a single window is not centred against a taller neighbour', () => {
    const html = renderPanel([codexWithWindows]);
    const groupClasses = [...html.matchAll(WINDOW_GROUP_PATTERN)].map(([, className]) => className ?? '');

    expect(groupClasses).toHaveLength(2);
    for (const className of groupClasses) {
      expect(className).toContain('ac_start');
    }
    expect(html.match(WINDOWS_GRID_PATTERN)?.[1]).toContain('ai_start');
  });

  // The expected strings below are written out rather than recomputed with the production helpers:
  // a test that calls `providerMachineLines` to build its own expectation can only catch a wiring
  // mistake, never a wrong rule inside the helper.
  test('renders one line per machine with a space on both sides of every separator', () => {
    const html = renderPanel([
      providerView({ key: 'codex', label: 'Codex', machineContext: 'MacBook-Pro', state: 'partial', tone: 'warning' }),
      claudeUnsupported,
      cursorPartial,
      providerView({
        key: 'cursor',
        label: 'Cursor',
        machineContext: 'MacBook-Pro',
        state: 'partial',
        tone: 'warning',
      }),
    ]);
    const renderedLines = [...html.matchAll(NO_QUOTA_LINE_PATTERN)].map(([, text]) => (text ?? '').trim());

    expect(renderedLines).toEqual([
      'MacBook-Pro · Codex, Cursor — partial · Claude — unsupported',
      'Workstation · Cursor — partial',
    ]);
    for (const line of renderedLines) {
      expect(line).not.toMatch(SEPARATOR_SPACING_PATTERN);
    }
  });

  test('states the panel as one sentence instead of five counter chips', () => {
    const html = renderPanel([codexWithWindows, claudeUnsupported, cursorPartial, opencodeCritical]);

    expect(html.match(STATUS_SUMMARY_PATTERN)?.[1]?.trim()).toBe(
      '4 providers · 1 reporting a usage limit · 2 with no limit reading (1 partial, 1 unsupported) · 1 critical',
    );
    expect(html).not.toContain('Quota windows:');
    expect(html).not.toContain('Attention without');
    expect(html).not.toContain('Provider categories');
  });

  test('counts the same provider on two machines twice in the sentence', () => {
    const html = renderPanel([
      cursorPartial,
      providerView({
        key: 'cursor',
        label: 'Cursor',
        machineContext: 'MacBook-Pro',
        state: 'partial',
        tone: 'warning',
      }),
    ]);

    expect(html.match(STATUS_SUMMARY_PATTERN)?.[1]?.trim()).toBe(
      '2 providers · 0 reporting a usage limit · 2 with no limit reading (2 partial)',
    );
  });

  test('shows both machines when two of them share a display name', () => {
    const onSharedName = (machineId: string) =>
      providerView({
        key: 'cursor',
        label: 'Cursor',
        machineContext: 'Shared machine',
        machineId,
        state: 'partial',
        tone: 'warning',
      });
    const html = renderPanel([onSharedName('machine-a'), onSharedName('machine-b')]);
    const renderedLines = [...html.matchAll(NO_QUOTA_LINE_PATTERN)].map(([, text]) => (text ?? '').trim());

    // The sentence counts two, so two lines have to be visible: partial data is always shown.
    expect(renderedLines).toEqual(['Shared machine · Cursor — partial', 'Shared machine · Cursor — partial']);
    expect(html.match(STATUS_SUMMARY_PATTERN)?.[1]?.trim()).toBe(
      '2 providers · 0 reporting a usage limit · 2 with no limit reading (2 partial)',
    );
  });

  test('keeps internal mechanism names out of everything the panel renders', () => {
    const html = renderPanel([codexWithWindows, claudeUnsupported, cursorPartial, opencodeCritical]);
    // Plan 086's copy rule names "quota windows" for replacement. Asserted over the whole panel, not
    // only the glossary: the summary sentence used to carry it too.
    expect(html.toLowerCase()).not.toContain('quota window');
  });

  test('explains what each provider state means, one idea per line', () => {
    const glossary = renderPanel([claudeUnsupported, cursorPartial]).match(GLOSSARY_PATTERN)?.[1] ?? '';
    const items = [...glossary.matchAll(GLOSSARY_ITEM_PATTERN)].map(([, text]) => (text ?? '').trim());

    expect(items).toEqual([
      'Ok = this provider reported how much of its limit is used.',
      'Partial = usage was collected here, but no limit reading arrived for this provider.',
      'Unsupported = this provider does not publish a limit ai-usage can read.',
    ]);
    // Cross-cutting copy rule: internal mechanism names are replaced by what the reader can act on.
    expect(glossary).not.toContain('quota window');
  });

  test('gives a detail card only to providers that carry something to act on, in the ranked order', () => {
    // Ranked the way `buildProviderStatusViews` ranks live views: critical first, then windows.
    const details = detailsBlock(renderPanel([opencodeCritical, codexWithWindows, claudeUnsupported, cursorPartial]));
    const cardOrder = ['Claude', 'Codex', 'Cursor', 'OpenCode']
      .filter((label) => details.includes(label))
      .sort((left, right) => details.indexOf(left) - details.indexOf(right));

    expect(cardOrder).toEqual(['OpenCode', 'Codex']);
    expect(details.match(DETAIL_CARD_PATTERN)).toHaveLength(2);
    expect(details.split('No usage limit was read for this provider.')).toHaveLength(2);
    expect(details).toContain('Provider details (2 providers)');
  });

  test('omits the disclosure entirely when no provider carries a detail', () => {
    const html = renderPanel([claudeUnsupported, cursorPartial]);

    expect(html).not.toContain('Provider details (');
    expect(html).not.toContain('No usage limit was read for this provider.');
  });
});
