import {
  parseWebUsageEngineCommand,
  type UsageEngineCommandCompletion,
  type WebUsageEngineCommand,
} from '@ai-usage/usage-engine-control';
import { parseReplicationStatus, type ReplicationStatus } from '@ai-usage/web-contract/replication';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';

type ReplicationStatusCommand = Extract<WebUsageEngineCommand, { readonly command: 'replication-status' }>;

type ExecuteReplicationStatusCommand = (
  command: ReplicationStatusCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<UsageEngineCommandCompletion>;

const executeReplicationStatusCommand: ExecuteReplicationStatusCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

export const getReplicationStatusForServer = async (
  signal: AbortSignal | undefined,
  execute: ExecuteReplicationStatusCommand = executeReplicationStatusCommand,
): Promise<ReplicationStatus> => {
  const command = parseWebUsageEngineCommand({ command: 'replication-status' });
  if (command.command !== 'replication-status') {
    throw new Error('Expected a replication status command.');
  }
  const completion = await execute(command, signal === undefined ? undefined : { signal });
  if (completion.state !== 'succeeded' || completion.command !== 'replication-status') {
    throw new Error('The usage engine returned an inconsistent replication status completion.');
  }
  return parseReplicationStatus(completion.output);
};
