import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import {
  createServedFocusedReportSource,
  fetchFocusedReportBootstrap,
  refreshFocusedReportBootstrap,
} from './focused-report-client';
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

export const isStaticReportRuntime = () => isStaticReportPayload() || readExportReportPayload() !== undefined;

const isE2ERuntime = () => import.meta.env?.VITE_AI_USAGE_E2E === '1';
const demoWebReportPayload = toWebReportPayload(demoReportPayload);

export const readReportPayload = () => readInjectedReportPayload() ?? demoWebReportPayload;

export const isDemoReportPayload = () => !readInjectedReportPayload();

export type ReportLoaderData =
  | { kind: 'payload'; payload: WebReportPayload }
  | { bootstrap: FocusedSupportResult; kind: 'served' };

export const loadReportPayload = async (): Promise<ReportLoaderData> => {
  if (isE2ERuntime()) {
    return { kind: 'payload', payload: demoWebReportPayload };
  }

  const exportPayload = readExportReportPayload();
  if (exportPayload) {
    return { kind: 'payload', payload: toWebReportPayload(exportPayload) };
  }

  const injectedPayload = readInjectedReportPayload();
  if (injectedPayload) {
    return { kind: 'payload', payload: injectedPayload };
  }

  return { bootstrap: await fetchFocusedReportBootstrap(createServedFocusedReportSource()), kind: 'served' };
};

export const resolveInitialReportPayload = (loaderData: ReportLoaderData): ReportLoaderData => {
  const injectedPayload = readInjectedReportPayload();
  return injectedPayload ? { kind: 'payload', payload: injectedPayload } : loaderData;
};

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
  typeof window === 'undefined' || isStaticReportRuntime() || isE2ERuntime()
    ? undefined
    : () => refreshFocusedReportBootstrap(createServedFocusedReportSource());
