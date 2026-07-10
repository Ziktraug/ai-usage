import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { createClientPerfTrace, payloadStats } from './client-perf';
import { demoReportPayload } from './report-data';
import { toWebReportPayload, type WebReportPayload } from './web-report-payload';

declare global {
  interface Window {
    __AI_USAGE_REPORT__?: WebReportPayload;
    __AI_USAGE_REPORT_STATIC__?: boolean;
  }
}

type ReportExportGlobal = typeof globalThis & {
  __AI_USAGE_REPORT_EXPORT_PAYLOAD__?: UsageReportPayload;
};

const readExportReportPayload = () =>
  typeof globalThis === 'undefined' ? undefined : (globalThis as ReportExportGlobal).__AI_USAGE_REPORT_EXPORT_PAYLOAD__;

const readInjectedReportPayload = () => (typeof window === 'undefined' ? undefined : window.__AI_USAGE_REPORT__);
const isStaticReportPayload = () =>
  typeof window === 'undefined' ? false : window.__AI_USAGE_REPORT_STATIC__ === true;

const isE2ERuntime = () => import.meta.env?.VITE_AI_USAGE_E2E === '1';
const demoWebReportPayload = toWebReportPayload(demoReportPayload);

const collectReportPayload = async () => {
  const { getReportPayload } = await import('./server/report-payload');
  return await getReportPayload();
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const fetchStoredReportPayload = async () => {
  const { getReportPayload } = await import('./server/report-payload');
  const payload = await getReportPayload({ data: { force: false } });
  if (typeof window !== 'undefined') {
    window.__AI_USAGE_REPORT__ = payload;
  }
  return payload;
};

const refreshReportPayloadInBackground = async () => {
  const { getReportPayloadRefreshState, startReportPayloadRefresh } = await import('./server/report-payload');
  const started = await startReportPayloadRefresh();
  while (true) {
    const state = await getReportPayloadRefreshState();
    if (state.runId < started.runId || state.status === 'running') {
      await sleep(300);
      continue;
    }
    if (state.status === 'failed') {
      throw new Error(state.error);
    }
    return fetchStoredReportPayload();
  }
};

export const readReportPayload = () => readInjectedReportPayload() ?? demoWebReportPayload;

export const isDemoReportPayload = () => !readInjectedReportPayload();

export const fetchReportPayload = async (_options?: { force?: boolean }) => {
  const perfTrace = createClientPerfTrace('aiUsage.web.client.fetchPayload', { force: _options?.force === true });
  if (_options?.force === true) {
    perfTrace?.mark('refreshStarted');
    const payload = await refreshReportPayloadInBackground();
    perfTrace?.mark('received', payloadStats(payload));
    perfTrace?.end('storedGlobal');
    return payload;
  }

  const { getReportPayload } = await import('./server/report-payload');
  perfTrace?.mark('serverFnLoaded');
  const payload = await getReportPayload({ data: { force: false } });
  perfTrace?.mark('received', payloadStats(payload));
  if (typeof window !== 'undefined') {
    window.__AI_USAGE_REPORT__ = payload;
  }
  perfTrace?.end('storedGlobal');
  return payload;
};

export const loadReportPayload = async (): Promise<WebReportPayload> => {
  if (isE2ERuntime()) {
    return demoWebReportPayload;
  }

  const exportPayload = readExportReportPayload();
  if (exportPayload) {
    return toWebReportPayload(exportPayload);
  }

  const injectedPayload = readInjectedReportPayload();
  if (injectedPayload) {
    return injectedPayload;
  }

  return await collectReportPayload();
};

export const resolveInitialReportPayload = (loaderPayload: WebReportPayload) =>
  readInjectedReportPayload() ?? loaderPayload;

export type MountReportRefreshAction = 'dev-fallback' | 'fetch-payload' | 'none';

export const mountReportRefreshAction = (input: {
  canRefresh: boolean;
  hasInitialPayload: boolean;
  isDemoPayload: boolean;
  isDevRuntime: boolean;
}): MountReportRefreshAction => {
  if (input.canRefresh && !input.hasInitialPayload) {
    return 'fetch-payload';
  }
  if (input.isDevRuntime && !input.hasInitialPayload && input.isDemoPayload) {
    return 'dev-fallback';
  }
  return 'none';
};

export const reportRefreshPayload = () =>
  typeof window === 'undefined' || isStaticReportPayload() || isE2ERuntime()
    ? undefined
    : (options?: { force?: boolean }) => fetchReportPayload(options);
