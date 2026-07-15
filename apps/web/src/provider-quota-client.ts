import type { ProviderQuotaHistoryRequest, ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
import type { ProviderQuotaRefreshResult } from '@ai-usage/report-data/provider-quota';

export interface ProviderQuotaSource {
  history(request: ProviderQuotaHistoryRequest, signal?: AbortSignal): Promise<ProviderQuotaHistoryResult>;
  refresh(signal?: AbortSignal): Promise<ProviderQuotaRefreshResult>;
}

export const createServedProviderQuotaSource = (): ProviderQuotaSource => ({
  history: async (request) => {
    const { getProviderQuotaHistory } = await import('./server/provider-quota');
    return await getProviderQuotaHistory({ data: request });
  },
  refresh: async () => {
    const { refreshProviderQuotas } = await import('./server/provider-quota');
    return await refreshProviderQuotas({ data: {} });
  },
});

export interface ProviderQuotaPoller {
  start(): void;
  stop(): void;
}

export const createProviderQuotaPoller = (options: {
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  intervalMs?: number;
  onError(error: unknown): void;
  onResult(result: ProviderQuotaHistoryResult, refresh: ProviderQuotaRefreshResult): void;
  request(): ProviderQuotaHistoryRequest;
  source: ProviderQuotaSource;
  timers?: Pick<typeof globalThis, 'clearInterval' | 'setInterval'>;
}): ProviderQuotaPoller => {
  const timers = options.timers ?? globalThis;
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  let controller: AbortController | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = true;
  let inFlight = false;

  const run = async (): Promise<void> => {
    if (stopped || inFlight || options.document.visibilityState === 'hidden') {
      return;
    }
    inFlight = true;
    controller = new AbortController();
    try {
      const refresh = await options.source.refresh(controller.signal);
      const result = await options.source.history(options.request(), controller.signal);
      if (!stopped) {
        options.onResult(result, refresh);
      }
    } catch (error) {
      if (!(stopped || controller.signal.aborted)) {
        options.onError(error);
      }
    } finally {
      inFlight = false;
      controller = null;
    }
  };

  const schedule = (): void => {
    if (interval !== null || stopped || options.document.visibilityState === 'hidden') {
      return;
    }
    interval = timers.setInterval(() => {
      run().catch(options.onError);
    }, intervalMs);
  };

  const unschedule = (): void => {
    if (interval !== null) {
      timers.clearInterval(interval);
      interval = null;
    }
  };

  const visibilityChanged = (): void => {
    if (options.document.visibilityState === 'hidden') {
      unschedule();
      controller?.abort();
      return;
    }
    run().catch(options.onError);
    schedule();
  };

  return {
    start: () => {
      if (!stopped) {
        return;
      }
      stopped = false;
      options.document.addEventListener('visibilitychange', visibilityChanged);
      run().catch(options.onError);
      schedule();
    },
    stop: () => {
      stopped = true;
      unschedule();
      controller?.abort();
      options.document.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
};
