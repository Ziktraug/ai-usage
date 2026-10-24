import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { applyWorkThreadCommand } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import type { UsageEngineWorkThreadPort } from './runtime';

export interface WorkThreadServiceOptions {
  readonly dbPath: string;
  /** The engine resolves its machine during startup, before accepting commands. */
  readonly machine: () => UsageMachine;
  readonly now?: () => Date;
  readonly runWithWriter: <Value>(operation: () => Promise<Value>, signal?: AbortSignal) => Promise<Value>;
}

export type WorkThreadService = UsageEngineWorkThreadPort;

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
  };
};
