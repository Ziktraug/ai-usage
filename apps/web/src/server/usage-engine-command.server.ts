import type { UsageEngineCommand, UsageEngineCommandCompletion } from '@ai-usage/usage-engine-control';
import type { UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { executeUsageEngineCommandToCompletion as executeSharedUsageEngineCommandToCompletion } from '@ai-usage/usage-engine-control/completion';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';

export { UsageEngineCommandCompletionError } from '@ai-usage/usage-engine-control/completion';

export interface ExecuteUsageEngineCommandOptions {
  readonly commandId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export const executeUsageEngineCommandToCompletion = async (
  control: UsageEngineControlClient,
  command: UsageEngineCommand,
  options: ExecuteUsageEngineCommandOptions = {},
): Promise<UsageEngineCommandCompletion> =>
  await executeSharedUsageEngineCommandToCompletion(control, command, {
    expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
    ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
