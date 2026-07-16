import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import { createServedFocusedReportSource, fetchFocusedReportBootstrap } from './focused-report-client';
import { demoReportPayload } from './report-data';
import { toWebReportPayload, type WebReportPayload } from './web-report-payload';

const isE2ERuntime = () => import.meta.env?.VITE_AI_USAGE_E2E === '1';
const demoWebReportPayload = toWebReportPayload(demoReportPayload);

export type ReportLoaderData =
  | { kind: 'payload'; payload: WebReportPayload }
  | { bootstrap: FocusedSupportResult; kind: 'served' };

export const loadReportPayload = async (): Promise<ReportLoaderData> => {
  if (isE2ERuntime()) {
    const currentLoads = Number(Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads') ?? 0);
    Reflect.set(globalThis, '__aiUsageE2EReportOwnerLoads', currentLoads + 1);
    return { kind: 'payload', payload: demoWebReportPayload };
  }

  return { bootstrap: await fetchFocusedReportBootstrap(createServedFocusedReportSource()), kind: 'served' };
};
