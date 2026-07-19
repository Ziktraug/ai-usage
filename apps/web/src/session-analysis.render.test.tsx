import { afterAll, describe, expect, test } from 'bun:test';
import type {
  SessionDetail,
  SessionDetailConsistency,
  SessionDetailResponse,
} from '@ai-usage/report-core/session-detail';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { demoReportPayload } from './report-data';
import type { SessionAnalysisTarget } from './session-analysis-target';

interface RenderedSessionAnalysisProps {
  harnessKey: string;
  loading: boolean;
  response: SessionDetailResponse | null;
  target: SessionAnalysisTarget;
}

const isSessionAnalysisModule = (
  value: unknown,
): value is { SessionAnalysis: Component<RenderedSessionAnalysisProps> } =>
  typeof value === 'object' &&
  value !== null &&
  'SessionAnalysis' in value &&
  typeof value.SessionAnalysis === 'function';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loadedModule: unknown = await viteServer.ssrLoadModule('/src/session-analysis.tsx');
if (!isSessionAnalysisModule(loadedModule)) {
  throw new Error('Vite did not load the SessionAnalysis component');
}
const SessionAnalysis: Component<RenderedSessionAnalysisProps> = loadedModule.SessionAnalysis;
afterAll(async () => {
  await viteServer.close();
});

const row = enrichSessionPresentationRow(demoReportPayload.rows[0]!);
const sessionTarget: SessionAnalysisTarget = { kind: 'session', reportRowId: row.rowId, summaryRow: row };
const campaignTarget = (visibleCount: number): SessionAnalysisTarget => ({
  campaignKey: 'fixture-campaign',
  kind: 'campaign-root',
  reportRowId: row.rowId,
  summaryRow: row,
  totalCount: 15,
  visibleCount,
});
const detail: SessionDetail = {
  activeDurationMs: 60_000,
  durationStatus: 'recorded',
  efforts: ['high'],
  elapsedDurationMs: 60_000,
  endedAt: '2026-07-18T10:01:00.000Z',
  idleDurationMs: 0,
  models: ['gpt-5.6-sol'],
  observedAt: '2026-07-18T10:01:01.000Z',
  phases: [],
  prompts: [],
  promptsTruncated: false,
  sourceSessionId: 'session-a',
  startedAt: '2026-07-18T10:00:00.000Z',
  turns: [],
  turnsStatus: 'recorded',
};
const matches: SessionDetailConsistency = { checkedFields: ['tokens'], status: 'matches-report' };
const forbiddenFreshnessClaims = [
  ['may', 'be', 'newer'],
  ['source', 'newer'],
].map((words) => words.join(' '));

const renderAnalysis = (
  consistency: SessionDetailConsistency = matches,
  detailOverrides: Partial<SessionDetail> = {},
  target: SessionAnalysisTarget = sessionTarget,
): string => {
  const response: SessionDetailResponse = {
    consistency,
    detail: { ...detail, ...detailOverrides },
    revision: 'revision-a',
    status: 'available',
  };
  return renderToString(() =>
    createComponent(SessionAnalysis, { harnessKey: 'codex', loading: false, response, target }),
  );
};

const itemMarkup = (html: string, kind: string): string => {
  const start = html.indexOf(`data-session-analysis-item="${kind}"`);
  if (start < 0) {
    throw new Error(`Missing rendered session analysis item: ${kind}`);
  }
  return html.slice(Math.max(0, start - 200), start + 500);
};

describe('SessionAnalysis SSR semantics', () => {
  test.each([
    [matches, 'comparable metrics match this report revision'],
    [
      {
        checkedFields: ['duration'],
        reason: 'insufficient-comparable-facts',
        status: 'cannot-compare',
      } satisfies SessionDetailConsistency,
      'comparison unavailable for this row',
    ],
  ])('renders non-alarming consistency as neutral metadata', (consistency, text) => {
    const html = renderAnalysis(consistency);
    const markup = itemMarkup(html, 'consistency-meta');
    expect(markup).toContain('data-tone="neutral"');
    expect(markup).not.toContain('role="status"');
    expect(html).toContain(text);
  });

  test('renders divergence as a targeted status with humanized fields', () => {
    const html = renderAnalysis({
      checkedFields: ['duration', 'model-attribution'],
      differingFields: ['duration', 'model-attribution'],
      status: 'differs-from-report',
    });
    const markup = itemMarkup(html, 'consistency-warning');
    expect(markup).toContain('data-tone="warning"');
    expect(markup).toContain('role="status"');
    expect(html).toContain('duration, model attribution');
  });

  test.each([
    [campaignTarget(15), 'Root rollout · 15 rollouts'],
    [campaignTarget(6), 'Root rollout · 6 visible of 15 rollouts'],
  ])('renders campaign scope as neutral metadata', (target, text) => {
    const html = renderAnalysis(matches, {}, target);
    const markup = itemMarkup(html, 'scope');
    expect(markup).toContain('data-tone="neutral"');
    expect(markup).not.toContain('role="status"');
    expect(html).toContain(text);
  });

  test('renders privacy beside Prompts as neutral metadata', () => {
    const html = renderAnalysis();
    const markup = itemMarkup(html, 'privacy');
    expect(markup).toContain('data-tone="neutral"');
    expect(markup).not.toContain('role="status"');
    expect(html.indexOf('session-prompts')).toBeLessThan(html.indexOf('data-session-analysis-item="privacy"'));
  });

  test.each([
    [{ durationStatus: 'partial' } satisfies Partial<SessionDetail>, 'partial-duration'],
    [{ turnsStatus: 'partial' } satisfies Partial<SessionDetail>, 'partial-turns'],
    [{ promptsTruncated: true } satisfies Partial<SessionDetail>, 'prompt-truncation'],
  ])('renders each metric limitation as a warning status', (overrides, kind) => {
    const markup = itemMarkup(renderAnalysis(matches, overrides), kind);
    expect(markup).toContain('data-tone="warning"');
    expect(markup).toContain('role="status"');
  });

  test('renders exactly two warning items for divergence plus partial duration', () => {
    const html = renderAnalysis(
      { checkedFields: ['tokens'], differingFields: ['tokens'], status: 'differs-from-report' },
      { durationStatus: 'partial' },
    );
    expect(html.match(/data-tone="warning"/g)).toHaveLength(2);
  });

  test('never claims that a differing local source is newer', () => {
    for (const html of [
      renderAnalysis(),
      renderAnalysis({ checkedFields: ['tokens'], differingFields: ['tokens'], status: 'differs-from-report' }),
    ]) {
      for (const freshnessClaim of forbiddenFreshnessClaims) {
        expect(html.toLowerCase()).not.toContain(freshnessClaim);
      }
    }
  });
});
