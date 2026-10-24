import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { applyWorkThreadCommand, seedWorkThreads, type WorkThreadSeed } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import type { UsageEngineWorkThreadPort } from './runtime';

export interface WorkThreadServiceOptions {
  readonly dbPath: string;
  /** The engine resolves its machine during startup, before accepting commands. */
  readonly machine: () => UsageMachine;
  readonly now?: () => Date;
  readonly runWithWriter: <Value>(operation: () => Promise<Value>, signal?: AbortSignal) => Promise<Value>;
}

export interface WorkThreadService extends UsageEngineWorkThreadPort {
  readonly seedWorkThreads: (
    seeds: readonly WorkThreadSeed[],
    signal?: AbortSignal,
  ) => Promise<{ readonly created: number; readonly existing: number }>;
}

/** Short durable writes share the engine gate; domain refusals remain successful command answers. */
export const createWorkThreadService = (options: WorkThreadServiceOptions): WorkThreadService => {
  const now = options.now ?? (() => new Date());
  return {
    execute: async (command, signal) =>
      await options.runWithWriter(
        async () => ({
          kind: 'work-thread',
          result: await Effect.runPromise(
            applyWorkThreadCommand({
              command,
              dbPath: options.dbPath,
              machineId: options.machine().id,
              now: now().toISOString(),
            }),
          ),
        }),
        signal,
      ),
    seedWorkThreads: async (seeds, signal) =>
      await options.runWithWriter(
        async () =>
          await Effect.runPromise(
            seedWorkThreads({
              dbPath: options.dbPath,
              machineId: options.machine().id,
              now: now().toISOString(),
              seeds,
            }),
          ),
        signal,
      ),
  };
};
