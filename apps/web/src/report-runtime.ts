import type { FocusedSupportResult } from '@ai-usage/report-core/focused-report-query';
import { getBrowserRuntimeMode } from './browser-runtime-mode';
import {
  createServedFocusedReportSource,
  type FocusedReportBootstrapDescriptor,
  fetchFocusedReportBootstrapDescriptor,
} from './focused-report-client';
import { type MachineFreshnessSnapshot, machineFreshnessSnapshotFromFocused } from './manual-transfer-model';
import { demoReportPayload } from './report-data';
import type { RuntimeMode } from './runtime-mode';
import { toWebReportPayload, type WebReportPayload } from './web-report-payload';

const demoWebReportPayload = toWebReportPayload(demoReportPayload);

const syntheticMachineFreshness: MachineFreshnessSnapshot = {
  kind: 'available',
  machines: [{ id: 'fixture-machine', label: 'Fixture Machine', lastSeenAt: demoWebReportPayload.generatedAt }],
  observedAt: Date.parse('2026-07-12T12:00:00.000Z'),
  omittedMachines: 0,
  skippedRows: 0,
};

export const machineFreshnessSnapshotFromBootstrap = (bootstrap: FocusedSupportResult): MachineFreshnessSnapshot =>
  machineFreshnessSnapshotFromFocused(bootstrap.machineFreshness);

export type ReportLoaderData =
  | { kind: 'payload'; machineFreshness: MachineFreshnessSnapshot; mode: 'demo' | 'e2e'; payload: WebReportPayload }
  | {
      bootstrapDescriptor: FocusedReportBootstrapDescriptor;
      kind: 'served';
      machineFreshness: MachineFreshnessSnapshot;
      mode: 'live';
    };

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

  const bootstrapDescriptor = await fetchFocusedReportBootstrapDescriptor(createServedFocusedReportSource());
  return {
    bootstrapDescriptor,
    kind: 'served',
    machineFreshness: machineFreshnessSnapshotFromBootstrap(bootstrapDescriptor.bootstrap),
    mode,
  };
};
