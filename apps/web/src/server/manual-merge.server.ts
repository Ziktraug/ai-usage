import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import {
  createUsageFileMergeService,
  type ManualMergeImportInput,
  type UsageFileMergeService,
} from '@ai-usage/usage-merge';
import { usageStorePath } from '@ai-usage/usage-store';
import { Cause, Effect, Option, Runtime } from 'effect';
import { runReportPayloadCollection } from './report-payload.server';

export type ManualMergeServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        tag: string;
        message: string;
        reason?: string;
      };
    };

const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const unwrapEffectFailure = (error: unknown) => {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }
  return Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId])) ?? error;
};

const errorResult = (error: unknown): ManualMergeServerResult<never> => {
  const unwrapped = unwrapEffectFailure(error);
  const record = typeof unwrapped === 'object' && unwrapped !== null ? (unwrapped as Record<string, unknown>) : {};
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

const getService = () => {
  servicePromise ??= Effect.runPromise(createService.pipe(Effect.provide(LocalHistoryStorageLive))).catch((error) => {
    servicePromise = undefined;
    throw error;
  });
  return servicePromise;
};

const runService = async <A>(
  operation: (service: UsageFileMergeService) => Effect.Effect<A, unknown>,
): Promise<ManualMergeServerResult<A>> => {
  try {
    const service = await getService();
    return { ok: true, data: toJson(await Effect.runPromise(operation(service))) };
  } catch (error) {
    return errorResult(error);
  }
};

export const exportManualMergeBundleForServer = async () => {
  try {
    await runReportPayloadCollection();
  } catch (error) {
    return errorResult(error);
  }
  return runService((service) => service.exportManualMergeBundle());
};

export const importManualMergeBundleForServer = (input: ManualMergeImportInput) =>
  runService((service) => service.importManualMergeBundle(input));
