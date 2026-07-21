import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import { getBrowserRuntimeMode } from './browser-runtime-mode';
import { createServedFocusedReportSource, fetchFocusedReportBootstrap } from './focused-report-client';
import { demoReportPayload } from './report-data';
import type { RuntimeMode } from './runtime-mode';
import { toWebReportPayload, type WebReportPayload } from './web-report-payload';

const demoWebReportPayload = toWebReportPayload(demoReportPayload);

export type ReportLoaderData =
  | { kind: 'payload'; mode: 'demo' | 'e2e'; payload: WebReportPayload }
  | { bootstrap: FocusedSupportResult; kind: 'served'; mode: 'live' };

export const loadReportPayload = async (mode: RuntimeMode = getBrowserRuntimeMode()): Promise<ReportLoaderData> => {
  if (mode === 'demo' || mode === 'e2e') {
    if (mode === 'e2e') {
      const currentLoads = Number(Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads') ?? 0);
      Reflect.set(globalThis, '__aiUsageE2EReportOwnerLoads', currentLoads + 1);
      const remainingFailures = Number(Reflect.get(globalThis, '__aiUsageE2EReportLoadFailures') ?? 0);
      if (remainingFailures > 0) {
        Reflect.set(globalThis, '__aiUsageE2EReportLoadFailures', remainingFailures - 1);
        throw new Error('Synthetic report load failed for retry coverage.');
      }
    }
    return { kind: 'payload', mode, payload: demoWebReportPayload };
  }

  return {
    bootstrap: await fetchFocusedReportBootstrap(createServedFocusedReportSource()),
    kind: 'served',
    mode,
  };
};
