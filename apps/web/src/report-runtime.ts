import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import { getBrowserRuntimeMode } from './browser-runtime-mode';
import { createServedFocusedReportSource, fetchFocusedReportBootstrap } from './focused-report-client';
import type { MachineFreshnessSnapshot } from './manual-transfer-model';
import { demoReportPayload } from './report-data';
import type { RuntimeMode } from './runtime-mode';
import { toWebReportPayload, type WebReportPayload } from './web-report-payload';

const demoWebReportPayload = toWebReportPayload(demoReportPayload);

const syntheticMachineFreshness: MachineFreshnessSnapshot = {
  machines: [{ id: 'fixture-machine', label: 'Fixture Machine', lastSeenAt: demoWebReportPayload.generatedAt }],
  observedAt: Date.parse('2026-07-12T12:00:00.000Z'),
};

const loadMachineFreshness = async (): Promise<MachineFreshnessSnapshot> => {
  const { getSyncFleet } = await import('./server/sync');
  const result = await getSyncFleet();
  return {
    machines: result.ok
      ? result.data.machines.map((machine) => ({
          id: machine.id,
          label: machine.label,
          lastSeenAt: machine.lastSeenAt,
        }))
      : [],
    observedAt: Date.now(),
  };
};

export type ReportLoaderData =
  | { kind: 'payload'; machineFreshness: MachineFreshnessSnapshot; mode: 'demo' | 'e2e'; payload: WebReportPayload }
  | { bootstrap: FocusedSupportResult; kind: 'served'; machineFreshness: MachineFreshnessSnapshot; mode: 'live' };

export const loadReportRouteData = async (mode: RuntimeMode = getBrowserRuntimeMode()): Promise<ReportLoaderData> => {
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
    return { kind: 'payload', machineFreshness: syntheticMachineFreshness, mode, payload: demoWebReportPayload };
  }

  const [bootstrap, machineFreshness] = await Promise.all([
    fetchFocusedReportBootstrap(createServedFocusedReportSource()),
    loadMachineFreshness(),
  ]);
  return {
    bootstrap,
    kind: 'served',
    machineFreshness,
    mode,
  };
};
