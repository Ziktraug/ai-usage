import { afterAll, describe, expect, test } from 'bun:test';
import type {
  SessionDetail,
  SessionDetailConsistency,
  SessionDetailResponse,
  SessionDetailUnavailableReason,
} from '@ai-usage/report-core/session-detail';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { demoReportPayload } from './report-data';
import type { SessionAnalysisError } from './session-analysis-error';
import type { SessionAnalysisTarget } from './session-analysis-target';

interface RenderedSessionAnalysisProps {
  error?: SessionAnalysisError | null;
  harnessKey: string;
  loading: boolean;
  onRetry?: () => void;
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

const renderUnavailableAnalysis = (reason: SessionDetailUnavailableReason): string =>
  renderToString(() =>
    createComponent(SessionAnalysis, {
      harnessKey: 'codex',
      loading: false,
      onRetry: () => undefined,
      response: { message: `Unavailable: ${reason}`, reason, status: 'unavailable' },
      target: sessionTarget,
    }),
  );

const renderAnalysisError = (error: SessionAnalysisError): string =>
  renderToString(() =>
    createComponent(SessionAnalysis, {
      error,
      harnessKey: 'codex',
      loading: false,
      onRetry: () => undefined,
      response: null,
      target: sessionTarget,
    }),
  );

const renderLoadingAnalysis = (): string =>
  renderToString(() =>
    createComponent(SessionAnalysis, {
      harnessKey: 'codex',
      loading: true,
      response: null,
      target: sessionTarget,
    }),
  );

const itemMarkup = (html: string, kind: string): string => {
  const start = html.indexOf(`data-session-analysis-item="${kind}"`);
  if (start < 0) {
    throw new Error(`Missing rendered session analysis item: ${kind}`);
  }
  return html.slice(Math.max(0, start - 200), start + 500);
};

const liveStatusMarkup = (html: string): string => {
  const start = html.indexOf('data-session-analysis-live-status');
  if (start < 0) {
    throw new Error('Missing rendered session analysis live status');
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

  test('renders incomplete timing as accessible bounds with a neutral note below the metrics', () => {
    const html = renderAnalysis(matches, {
      activeDurationMs: 60_000,
      durationStatus: 'partial',
      elapsedDurationMs: 180_000,
      idleDurationMs: 120_000,
    });
    const markup = itemMarkup(html, 'partial-duration');

    expect(markup).toContain('data-tone="neutral"');
    expect(markup).not.toContain('role="status"');
    expect(html).toContain('aria-hidden="true">≥ ');
    expect(html).toContain('aria-hidden="true">≤ ');
    expect(html).toContain('>At least </span>');
    expect(html).toContain('>At most </span>');
    expect(html).toContain(
      'Timing coverage is incomplete. Values marked ≥ or ≤ are bounds based on recorded local activity.',
    );
    expect(html).toContain(
      'title="Wall-clock span from the first local task start to the last observed local task event."',
    );
    expect(html).not.toContain('final local task completion');
    expect(html.indexOf('<dl')).toBeLessThan(html.indexOf('data-session-analysis-item="partial-duration"'));
    expect(html.indexOf('data-session-analysis-item="partial-duration"')).toBeLessThan(
      html.indexOf('id="session-model-phases"'),
    );
  });

  test('does not add timing bounds when coverage is recorded', () => {
    const html = renderAnalysis();

    expect(html).not.toContain('data-session-analysis-item="partial-duration"');
    expect(html).not.toContain('aria-hidden="true">≥ ');
    expect(html).not.toContain('aria-hidden="true">≤ ');
  });

  test('places partial turn attribution beside Prompts as neutral static metadata', () => {
    const html = renderAnalysis(matches, { turnsStatus: 'partial' });
    const markup = itemMarkup(html, 'partial-turns');

    expect(markup).toContain('data-tone="neutral"');
    expect(markup).not.toContain('role="status"');
    expect(html.indexOf('id="session-prompts"')).toBeLessThan(
      html.indexOf('data-session-analysis-item="partial-turns"'),
    );
    expect(html.indexOf('data-session-analysis-item="partial-turns"')).toBeLessThan(
      html.indexOf('data-session-analysis-item="privacy"'),
    );
    expect(html).toContain(
      'Some recorded assistant activity cannot be linked to a user prompt. It remains visible without an invented association.',
    );
  });

  test('omits partial turn attribution when attribution is recorded', () => {
    expect(renderAnalysis()).not.toContain('data-session-analysis-item="partial-turns"');
  });

  test('keeps prompt truncation beside Prompts as neutral static metadata', () => {
    const html = renderAnalysis(matches, { promptsTruncated: true });
    const markup = itemMarkup(html, 'prompt-truncation');

    expect(markup).toContain('data-tone="neutral"');
    expect(markup).not.toContain('role="status"');
    expect(html.indexOf('id="session-prompts"')).toBeLessThan(
      html.indexOf('data-session-analysis-item="prompt-truncation"'),
    );
    expect(html).toContain(
      'Some prompt text is truncated in this local view. Timeline and usage totals are unaffected.',
    );
  });

  test('renders exactly one warning item for divergence plus static local limitations', () => {
    const html = renderAnalysis(
      { checkedFields: ['tokens'], differingFields: ['tokens'], status: 'differs-from-report' },
      { durationStatus: 'partial', promptsTruncated: true, turnsStatus: 'partial' },
    );
    expect(html.match(/data-tone="warning"/g)).toHaveLength(1);
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

  test('labels an expired immutable revision explicitly and does not offer a doomed retry', () => {
    const html = renderUnavailableAnalysis('revision-expired');

    expect(html).toContain('Report revision expired');
    expect(html).not.toContain('>Retry<');
  });

  test.each([
    'not-found',
    'not-local',
    'report-provenance-unavailable',
    'report-row-not-found',
    'revision-expired',
    'unsupported',
  ] satisfies SessionDetailUnavailableReason[])('does not offer Retry for terminal unavailable reason %s', (reason) => {
    expect(renderUnavailableAnalysis(reason)).not.toContain('>Retry<');
  });

  test('offers Retry for a transient local-history read failure', () => {
    expect(renderUnavailableAnalysis('history-unavailable')).toContain('>Retry<');
  });

  test('does not offer Retry for a terminal detail-contract failure', () => {
    const html = renderAnalysisError({ kind: 'terminal', message: 'Revision mismatch' });

    expect(html).toContain('Revision mismatch');
    expect(html).not.toContain('>Retry<');
  });

  test('offers Retry for a transient transport failure', () => {
    const html = renderAnalysisError({ kind: 'transient', message: 'Connection reset' });

    expect(html).toContain('Connection reset');
    expect(html).toContain('>Retry<');
  });

  test.each([
    ['loading', renderLoadingAnalysis(), 'Loading session analysis'],
    ['unavailable', renderUnavailableAnalysis('revision-expired'), 'Report revision expired'],
    ['available', renderAnalysis(), 'Session analysis loaded'],
  ])('keeps a polite atomic live status for the %s state', (_state, html, announcement) => {
    const markup = liveStatusMarkup(html);

    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain(announcement);
  });
});
