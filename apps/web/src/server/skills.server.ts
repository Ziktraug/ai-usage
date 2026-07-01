import { LocalHistoryStorage, LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { readMergedAiUsageConfigFrom } from '@ai-usage/local-collectors/machine-config';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { loadSkillManagementSnapshot } from '@ai-usage/skills';
import { Cause, Effect, Option, Runtime } from 'effect';

export type SkillsServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const unwrapEffectFailure = (error: unknown) => {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }
  return Option.getOrUndefined(Cause.failureOption(error[Runtime.FiberFailureCauseId])) ?? error;
};

const errorResult = (error: unknown): SkillsServerResult<never> => {
  const unwrapped = unwrapEffectFailure(error);
  const record = typeof unwrapped === 'object' && unwrapped !== null ? (unwrapped as Record<string, unknown>) : {};
  return {
    ok: false,
    error: {
      message: unwrapped instanceof Error ? unwrapped.message : String(unwrapped),
      tag: typeof record._tag === 'string' ? record._tag : 'Error',
    },
  };
};

export const readSkillManagementSnapshotForServer = async (): Promise<SkillsServerResult<SkillManagementSnapshot>> => {
  try {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* LocalHistoryStorage;
        const config = yield* readMergedAiUsageConfigFrom();
        const configDocument = { ...config };
        return yield* Effect.promise(() =>
          loadSkillManagementSnapshot({
            config: configDocument,
            homePath: storage.home,
          }),
        );
      }).pipe(Effect.provide(LocalHistoryStorageLive)),
    );
    return { ok: true, data: toJson(snapshot) };
  } catch (error) {
    return errorResult(error);
  }
};
