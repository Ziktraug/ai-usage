import type {
  UsageEngineCommand,
  UsageEngineCommandCompletion,
  UsageEngineCommandId,
} from '@ai-usage/usage-engine-control';
import { parseUsageEngineCommandCompletion } from '@ai-usage/usage-engine-control';
import type { UsageEngineCommandOutput } from './runtime-command-executor';
import { usageEngineCommandPolicies } from './runtime-command-policy';
import type { UsageEngineCommandErrorCode } from './runtime-errors';

interface CommandJob {
  readonly command: UsageEngineCommand;
  readonly commandId: UsageEngineCommandId;
}

export const successfulCommandCompletion = (
  job: CommandJob,
  result: UsageEngineCommandOutput,
  completedAt: string,
): UsageEngineCommandCompletion => {
  const expectedOutputKind = usageEngineCommandPolicies[job.command.command].outputKind;
  const output = result ?? { kind: 'none' as const };
  if (output.kind !== expectedOutputKind) {
    throw new Error(`A successful ${job.command.command} command must return ${expectedOutputKind} output.`);
  }
  return parseUsageEngineCommandCompletion({
    command: job.command.command,
    commandId: job.commandId,
    completedAt,
    output,
    state: 'succeeded',
  });
};

export const failedCommandCompletion = (
  job: CommandJob,
  code: 'aborted' | 'command-failed' | 'command-rejected' | 'engine-busy' | UsageEngineCommandErrorCode,
  completedAt: string,
  message: string,
): UsageEngineCommandCompletion => ({
  command: job.command.command,
  commandId: job.commandId,
  completedAt,
  error: { code, message },
  state: 'failed',
});
