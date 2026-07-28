import { afterAll, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { BreakdownSort } from './dashboard-search';

interface GroupPanelProps {
  countLabel: string;
  groups: AnalyticsGroup[];
  onSortChange: (value: BreakdownSort) => void;
  sort: BreakdownSort;
  title: string;
}

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/group-panel.tsx');
if (!(loaded && typeof loaded === 'object' && 'GroupPanel' in loaded && typeof loaded.GroupPanel === 'function')) {
  throw new Error('Vite did not load GroupPanel');
}
const GroupPanel = loaded.GroupPanel as Component<GroupPanelProps>;
afterAll(async () => viteServer.close());

const partiallyMeasuredGroup: AnalyticsGroup = {
  ambiguous: 0,
  cache: 0,
  cacheHitPct: 0,
  costPer100Lines: null,
  costPercent: 100,
  costPerSession: 2,
  costSum: 2,
  fresh: 57_500_100,
  harness: 'Codex',
  inp: 57_500_100,
  key: 'gpt-unknown',
  lineCount: 0,
  linesA: 0,
  linesD: 0,
  medianCost: 2,
  priced: 1,
  provider: 'Codex API',
  sessions: 2,
  tools: 0,
  turns: 0,
  unpriced: 1,
  unpricedFreshTokens: 57_500_000,
  usageUnavailable: 0,
};

const sortableGroup = (key: string, costSum: number, fresh: number, sessions: number): AnalyticsGroup => ({
  ...partiallyMeasuredGroup,
  costPercent: 0,
  costSum,
  fresh,
  inp: fresh,
  key,
  medianCost: costSum,
  priced: sessions,
  sessions,
  unpriced: 0,
  unpricedFreshTokens: 0,
});

const ACTIVE_TOKENS_PATTERN = /aria-checked="true"[^>]*>Tokens<\/button>/;

test('describes partially measured breakdown value with the unpriced fresh-token volume', () => {
  const html = renderToString(() =>
    createComponent(GroupPanel, {
      countLabel: 'models',
      groups: [partiallyMeasuredGroup],
      onSortChange: () => undefined,
      sort: 'value',
      title: 'Models',
    }),
  );

  expect(html).toContain('57.5M tokens in this slice come from models with no published price');
  expect(html).not.toContain('1 of 2 sessions in this slice');
});

test('renders one keyboard-accessible sort control with active state and sorted rows', () => {
  const html = renderToString(() =>
    createComponent(GroupPanel, {
      countLabel: 'models',
      groups: [sortableGroup('alpha', 7, 10, 1), sortableGroup('beta', 5, 20, 1), sortableGroup('gamma', 6, 20, 1)],
      onSortChange: () => undefined,
      sort: 'tokens',
      title: 'Models',
    }),
  );
  const gammaIndex = html.indexOf('gamma');
  const betaIndex = html.indexOf('beta');
  const alphaIndex = html.indexOf('alpha');

  expect(html.split('aria-label="Sort breakdown"')).toHaveLength(2);
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('tabIndex="0"');
  expect(html.split('role="radio"')).toHaveLength(4);
  expect(html).toMatch(ACTIVE_TOKENS_PATTERN);
  expect(gammaIndex).toBeGreaterThan(-1);
  expect(gammaIndex).toBeLessThan(betaIndex);
  expect(betaIndex).toBeLessThan(alphaIndex);
});
