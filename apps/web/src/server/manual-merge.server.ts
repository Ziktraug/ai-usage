import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import {
  createUsageFileMergeService,
  type ManualMergeConfirmInput,
  type ManualMergeDocumentInput,
  type ManualMergeImportInput,
  type UsageFileMergeService,
} from '@ai-usage/usage-merge';
import { usageStorePath } from '@ai-usage/usage-store';
import { Cause, Effect, Option, Runtime } from 'effect';
import type { ManualOperationResult } from '../manual-transfer-contract';
import { invalidateReportPayloadForMutation } from './report-payload.server';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unwrapEffectFailure = (error: unknown) => {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }
  return Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId])) ?? error;
};

const errorResult = (error: unknown): ManualOperationResult<never> => {
  const unwrapped = unwrapEffectFailure(error);
  const record = isRecord(unwrapped) ? unwrapped : {};
  return {
    ok: false,
    error: {
      tag: typeof record._tag === 'string' ? record._tag : 'Error',
      message: unwrapped instanceof Error ? unwrapped.message : String(unwrapped),
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    },
  };
};

let servicePromise: Promise<UsageFileMergeService> | undefined;

const createService = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const localMachine = yield* ensureMachineConfig;
  return createUsageFileMergeService({
    localMachine,
    dbPath: usageStorePath(storage.home),
  });
});

const resolveService = async () => {
  try {
    return await Effect.runPromise(createService.pipe(Effect.provide(LocalHistoryStorageLive)));
  } catch (error) {
    servicePromise = undefined;
    throw error;
  }
};

const getService = () => {
  servicePromise ??= resolveService();
  return servicePromise;
};

const runService = async <A>(
  operation: (service: UsageFileMergeService) => Effect.Effect<A, unknown>,
): Promise<ManualOperationResult<A>> => {
  try {
    const service = await getService();
    return { ok: true, data: await Effect.runPromise(operation(service)) };
  } catch (error) {
    return errorResult(error);
  }
};

export const exportManualMergeBundleForServer = () => runService((service) => service.exportManualMergeBundle());

export const importManualMergeBundleForServer = async (input: ManualMergeImportInput) => {
  const result = await runService((service) => service.importManualMergeBundle(input));
  if (result.ok) {
    await invalidateReportPayloadForMutation({ scheduleRefresh: true });
  }
  return result;
};

export const previewManualMergeBundleForServer = (input: ManualMergeDocumentInput) =>
  runService((service) => service.previewManualMergeBundle(input));

export const confirmManualMergeBundleForServer = async (input: ManualMergeConfirmInput) => {
  const result = await runService((service) => service.confirmManualMergeBundle(input));
  if (result.ok) {
    await invalidateReportPayloadForMutation({ scheduleRefresh: true });
  }
  return result;
};
