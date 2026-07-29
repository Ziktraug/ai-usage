import { afterAll, expect, test } from 'bun:test';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { CampaignView } from './dashboard-model';
import type { DashboardRow } from './shared';
import { enrichReportRow } from './shared';

interface SessionShapeProps {
  campaigns: CampaignView[];
  focused: null | undefined;
  labelFor: (campaignKey: string, derivedLabel: string) => string;
  onSelectSession: () => void;
  rows: DashboardRow[];
}

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loaded: unknown = await viteServer.ssrLoadModule('/src/overview.tsx');
if (!(loaded && typeof loaded === 'object' && 'SessionShape' in loaded && typeof loaded.SessionShape === 'function')) {
  throw new Error('Vite did not load SessionShape');
}
const SessionShape = loaded.SessionShape as Component<SessionShapeProps>;
afterAll(async () => viteServer.close());

const baseRow: SerializedRow = {
  activeDate: '2026-06-10T12:00:00.000Z',
  calls: 1,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  date: '2026-06-10T12:00:00.000Z',
  durationMs: 60_000,
  endDate: null,
  freshTokens: 17,
  harness: 'Codex',
  linesAdded: 4,
  linesDeleted: 1,
  lineDelta: 5,
  model: 'gpt-5',
  name: 'Base session',
  project: 'alpha',
  provider: 'Codex API',
  sessionLabel: 'Base session',
  tokCr: 3,
  tokCw: 2,
  tokIn: 10,
  tokOut: 5,
  tokenTotal: 20,
  tools: 3,
  turns: 2,
};

const row = (overrides: Partial<SerializedRow>): DashboardRow => enrichReportRow({ ...baseRow, ...overrides });

test('renders fixed Session Shape points, harness color key, and campaign language', () => {
  const rows = [
    row({ costApprox: 0.1, durationMs: 60_000, harness: 'Codex', sessionLabel: 'Short' }),
    row({ costApprox: 1, durationMs: 600_000, harness: 'Claude', sessionLabel: 'Medium' }),
    row({ costApprox: 10, durationMs: 3_600_000, harness: 'Codex', sessionLabel: 'Long' }),
  ];
  const html = renderToString(() =>
    createComponent(SessionShape, {
      campaigns: [],
      focused: undefined,
      labelFor: (_campaignKey, derivedLabel) => derivedLabel,
      onSelectSession: () => undefined,
      rows,
    }),
  );

  expect(html.match(/data-session-shape-point/g)).toHaveLength(3);
  expect(html.match(/r="4"/g)).toHaveLength(3);
  expect(html).toContain('data-session-shape-harness-key');
  expect(html).toContain('Codex');
  expect(html).toContain('Claude');
  expect(html).toContain('data-session-shape-summary');
  expect(html).toContain('session/campaign groups');
  expect(html).not.toContain('density mark');
});
