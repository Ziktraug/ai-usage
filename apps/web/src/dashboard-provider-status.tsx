import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import { createQuery } from '@tanstack/solid-query';
import { createMemo, createSignal, lazy, onMount, Show, Suspense } from 'solid-js';
import { isServer } from 'solid-js/web';
import { quotaHistoryKey } from './lib/query/identities/quota';
import { webQueryPolicies } from './lib/query/policies';
import { createServedProviderQuotaSource, type ProviderQuotaSource } from './provider-quota-client';
import { createE2EProviderQuotaHistoryFixture } from './provider-quota-e2e-fixture';
import { type ProviderQuotaHistoryRange, providerQuotaHistoryRequest } from './provider-quota-history-model';
import { createProviderStatusClock } from './provider-status-clock';
import { buildProviderStatusViews, providerHistoryAvailable } from './provider-status-model';
import { ProviderStatusPanel } from './provider-status-panel';
import type { RuntimeMode } from './runtime-mode';
import type { DashboardRow } from './shared';
import type { WebReportPayloadWithoutRows } from './web-report-payload';

const ProviderQuotaHistoryPanel = lazy(async () => {
  const module = await import('./provider-quota-history-panel');
  return { default: module.ProviderQuotaHistoryPanel };
});

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
  const request = createMemo(() => providerQuotaHistoryRequest(range(), new Date(), { providerKey: 'codex' }));
  const query = createQuery(() => ({
    ...webQueryPolicies.finiteSwr,
    enabled: !isServer && props.source !== undefined,
    queryFn: async ({ signal }) => {
      if (!props.source) {
        throw new Error('Quota history is unavailable.');
      }
      return await props.source.history(request(), signal);
    },
    queryKey: quotaHistoryKey(request(), { range: range() }),
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

  const quotaFixture =
    props.quotaHistoryFixture ?? (props.runtimeMode === 'e2e' ? createE2EProviderQuotaHistoryFixture() : undefined);
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
