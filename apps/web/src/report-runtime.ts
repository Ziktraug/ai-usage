import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
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
  typeof globalThis === 'undefined'
    ? undefined
    : (globalThis as ReportExportGlobal).__AI_USAGE_REPORT_EXPORT_PAYLOAD__;

const readInjectedReportPayload = () => (typeof window === 'undefined' ? undefined : window.__AI_USAGE_REPORT__);

const isDevRuntime = () => Boolean(import.meta.env?.DEV);

const collectReportPayload = async () => {
  const { getReportPayload } = await import('./server/report-payload');
  return (await getReportPayload()) as UsageReportPayload;
};

export const readReportPayload = () => readInjectedReportPayload() ?? demoReportPayload;

export const isDemoReportPayload = () => !readInjectedReportPayload();

export const fetchReportPayload = async (_options?: { force?: boolean }) => {
  const payload = await collectReportPayload();
  if (typeof window !== 'undefined') window.__AI_USAGE_REPORT__ = payload;
  return payload;
};

export const loadReportPayload = async () => {
  const exportPayload = readExportReportPayload();
  if (exportPayload) return exportPayload;

  const injectedPayload = readInjectedReportPayload();
  if (injectedPayload) return injectedPayload;

  return collectReportPayload();
};

export const resolveInitialReportPayload = (loaderPayload: UsageReportPayload) =>
  readInjectedReportPayload() ?? loaderPayload;

export const reportRefreshPayload = () =>
  typeof window === 'undefined' || !isDevRuntime() ? undefined : () => fetchReportPayload();
