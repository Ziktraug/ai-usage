import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { createClientPerfTrace, payloadStats } from './client-perf';
import { demoReportPayload } from './report-data';

declare global {
  interface Window {
    __AI_USAGE_REPORT__?: UsageReportPayload;
  }
}

type ReportExportGlobal = typeof globalThis & {
  __AI_USAGE_REPORT_EXPORT_PAYLOAD__?: UsageReportPayload;
};

const readExportReportPayload = () =>
  typeof globalThis === 'undefined' ? undefined : (globalThis as ReportExportGlobal).__AI_USAGE_REPORT_EXPORT_PAYLOAD__;

const readInjectedReportPayload = () => (typeof window === 'undefined' ? undefined : window.__AI_USAGE_REPORT__);

const isDevRuntime = () => Boolean(import.meta.env?.DEV);

const collectReportPayload = async () => {
  const { getReportPayload } = await import('./server/report-payload');
  return (await getReportPayload()) as UsageReportPayload;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const fetchStoredReportPayload = async () => {
  const { getReportPayload } = await import('./server/report-payload');
  const payload = (await getReportPayload({ data: { force: false } })) as UsageReportPayload;
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

export const readReportPayload = () => readInjectedReportPayload() ?? demoReportPayload;

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
  const payload = (await getReportPayload({ data: { force: false } })) as UsageReportPayload;
  perfTrace?.mark('received', payloadStats(payload));
  if (typeof window !== 'undefined') {
    window.__AI_USAGE_REPORT__ = payload;
  }
  perfTrace?.end('storedGlobal');
  return payload;
};

export const loadReportPayload = async () => {
  const exportPayload = readExportReportPayload();
  if (exportPayload) {
    return exportPayload;
  }

  const injectedPayload = readInjectedReportPayload();
  if (injectedPayload) {
    return injectedPayload;
  }

  return await collectReportPayload();
};

export const resolveInitialReportPayload = (loaderPayload: UsageReportPayload) =>
  readInjectedReportPayload() ?? loaderPayload;

export const reportRefreshPayload = () =>
  typeof window === 'undefined' || !isDevRuntime()
    ? undefined
    : (options?: { force?: boolean }) => fetchReportPayload(options);
