import type { ProviderQuotaHistoryPoint, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { createQuery } from '@tanstack/solid-query';
import { createMemo, createSignal, lazy, onMount, Show, Suspense } from 'solid-js';
import { createServedProviderQuotaSource, type ProviderQuotaSource } from './provider-quota-client';
import type { ProviderQuotaHistoryRange } from './provider-quota-history-model';
import { createProviderStatusClock } from './provider-status-clock';
import { buildProviderStatusViews, providerHistoryAvailable } from './provider-status-model';
import { ProviderStatusPanel } from './provider-status-panel';
import type { RuntimeMode } from './runtime-mode';
import type { DashboardRow } from './shared';
import { loadProviderQuotaHistory, webQueryKeys } from './web-query-options';
import type { WebReportPayloadWithoutRows } from './web-report-payload';

const ProviderQuotaHistoryPanel = lazy(async () => {
  const module = await import('./provider-quota-history-panel');
  return { default: module.ProviderQuotaHistoryPanel };
});

const fixtureQuotaPoint = (input: {
  at: string;
  resetAt: string;
  usedPercent: number;
  window: '5h' | 'weekly';
}): ProviderQuotaHistoryPoint => ({
  accountScope: 'fixture-account',
  blocked: false,
  firstObservedAt: input.at,
  group: input.window,
  lastObservedAt: input.at,
  limitSeconds: input.window === '5h' ? 18_000 : 604_800,
  machineId: 'fixture-machine',
  machineLabel: 'Fixture Machine',
  providerKey: 'codex',
  providerLabel: 'Codex',
  resetAt: input.resetAt,
  source: { confidence: 'authoritative', key: 'codex-app-server', mode: 'poll' },
  usedPercent: input.usedPercent,
  windowId: `codex:${input.window}`,
  windowLabel: input.window === '5h' ? '5h' : 'Weekly',
});

const e2eQuotaHistoryFixture: ProviderQuotaHistoryResult = {
  coverage: [],
  generatedAt: '2026-07-15T10:40:00.000Z',
  latest: [],
  points: [
    fixtureQuotaPoint({
      at: '2026-07-15T09:00:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 22,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:05:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 28,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:30:00.000Z',
      resetAt: '2026-07-15T12:00:00.000Z',
      usedPercent: 35,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:35:00.000Z',
      resetAt: '2026-07-15T17:00:00.000Z',
      usedPercent: 4,
      window: '5h',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:00:00.000Z',
      resetAt: '2026-07-21T00:00:00.000Z',
      usedPercent: 61,
      window: 'weekly',
    }),
    fixtureQuotaPoint({
      at: '2026-07-15T09:35:00.000Z',
      resetAt: '2026-07-21T00:00:00.000Z',
      usedPercent: 63,
      window: 'weekly',
    }),
  ],
  skipped: 0,
  truncated: false,
};

type ProviderStatusReport = Pick<WebReportPayloadWithoutRows, 'datasets' | 'facets' | 'generatedAt'>;

export interface DashboardProviderStatusProps {
  quotaHistoryFixture?: ProviderQuotaHistoryResult;
  quotaSource?: ProviderQuotaSource;
  report: ProviderStatusReport;
  rows: DashboardRow[];
  runtimeMode: RuntimeMode;
  served: boolean;
}

interface ProviderQuotaHistoryDialogProps {
  fixture?: ProviderQuotaHistoryResult;
  onClose: () => void;
  source?: ProviderQuotaSource;
}

const ProviderQuotaHistoryDialog = (props: ProviderQuotaHistoryDialogProps) => {
  const [range, setRange] = createSignal<ProviderQuotaHistoryRange>('24h');
  const query = createQuery(() => ({
    enabled: props.source !== undefined,
    queryFn: async () => {
      if (!props.source) {
        throw new Error('Quota history is unavailable.');
      }
      return await loadProviderQuotaHistory(props.source, range());
    },
    queryKey: webQueryKeys.providerQuotaHistory(range()),
  }));
  const result = (): ProviderQuotaHistoryResult | null => props.fixture ?? query.data ?? null;
  const error = (): string | null => (query.error instanceof Error ? query.error.message : null);

  return (
    <Suspense fallback={null}>
      <ProviderQuotaHistoryPanel
        error={error()}
        loading={query.isFetching}
        onClose={props.onClose}
        onRangeChange={setRange}
        range={range()}
        result={result()}
      />
    </Suspense>
  );
};

export const DashboardProviderStatus = (props: DashboardProviderStatusProps) => {
  if (props.runtimeMode === 'demo') {
    return null;
  }

  const quotaFixture = props.quotaHistoryFixture ?? (props.runtimeMode === 'e2e' ? e2eQuotaHistoryFixture : undefined);
  const quotaSource =
    quotaFixture === undefined
      ? (props.quotaSource ?? (props.served ? createServedProviderQuotaSource() : undefined))
      : undefined;
  const providerStatusClock = createProviderStatusClock({ initialNow: props.report.generatedAt });
  onMount(providerStatusClock.start);

  const providerStatusViews = createMemo(() =>
    buildProviderStatusViews(props.report, props.rows, providerStatusClock.now()),
  );
  const [quotaHistoryOpen, setQuotaHistoryOpen] = createSignal(false);
  const historyAvailable = (): boolean =>
    providerHistoryAvailable(quotaFixture?.points.length, quotaSource !== undefined);

  return (
    <>
      <ProviderStatusPanel
        historyAvailable={historyAvailable()}
        onViewHistory={() => setQuotaHistoryOpen(true)}
        providers={providerStatusViews()}
      />
      <Show when={quotaHistoryOpen()}>
        <ProviderQuotaHistoryDialog
          {...(quotaFixture === undefined ? {} : { fixture: quotaFixture })}
          onClose={() => setQuotaHistoryOpen(false)}
          {...(quotaSource === undefined ? {} : { source: quotaSource })}
        />
      </Show>
    </>
  );
};
