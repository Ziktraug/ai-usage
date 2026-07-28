import { afterAll, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';

interface GroupPanelProps {
  countLabel: string;
  groups: AnalyticsGroup[];
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

test('describes partially measured breakdown value with the unpriced fresh-token volume', () => {
  const html = renderToString(() =>
    createComponent(GroupPanel, {
      countLabel: 'models',
      groups: [partiallyMeasuredGroup],
      title: 'Models',
    }),
  );

  expect(html).toContain('57.5M tokens in this slice come from models with no published price');
  expect(html).not.toContain('1 of 2 sessions in this slice');
});
