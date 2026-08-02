import type {
  UsageEngineCommand,
  UsageEngineCommandCompletion,
  UsageEngineCommandId,
  UsageEngineCommandName,
} from '@ai-usage/usage-engine-control';
import type { UsageEngineCommandOutput } from './runtime-command-executor';
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
  if (job.command.command === 'preview-merge') {
    if (result?.kind !== 'merge-preview') {
      throw new Error('A successful merge preview must return its bounded preview output.');
    }
    return { command: 'preview-merge', commandId: job.commandId, completedAt, output: result, state: 'succeeded' };
  }
  if (job.command.command === 'import-cursor') {
    if (result?.kind !== 'cursor-import') {
      throw new Error('A successful Cursor import must return its bounded import output.');
    }
    return { command: 'import-cursor', commandId: job.commandId, completedAt, output: result, state: 'succeeded' };
  }
  if (job.command.command === 'collect-fresh-report' || job.command.command === 'collect-fresh-quota') {
    if (result?.kind !== 'collection') {
      throw new Error('A successful fresh collection must return its bounded collection output.');
    }
    return { command: job.command.command, commandId: job.commandId, completedAt, output: result, state: 'succeeded' };
  }
  if (job.command.command === 'set-machine-label') {
    if (result?.kind !== 'machine') {
      throw new Error('A successful machine label mutation must return its bounded machine output.');
    }
    return { command: 'set-machine-label', commandId: job.commandId, completedAt, output: result, state: 'succeeded' };
  }
  if (job.command.command === 'publish') {
    if (result?.kind !== 'publication') {
      throw new Error('A successful publication command must return its bounded publication output.');
    }
    return { command: 'publish', commandId: job.commandId, completedAt, output: result, state: 'succeeded' };
  }
  return {
    command: job.command.command as Exclude<
      UsageEngineCommandName,
      | 'collect-fresh-quota'
      | 'collect-fresh-report'
      | 'import-cursor'
      | 'preview-merge'
      | 'publish'
      | 'set-machine-label'
    >,
    commandId: job.commandId,
    completedAt,
    output: { kind: 'none' },
    state: 'succeeded',
  };
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
