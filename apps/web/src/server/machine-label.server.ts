import { parseWebUsageEngineCommand, type WebUsageEngineCommand } from '@ai-usage/usage-engine-control';
import { parseSyncMachineLabelResult, type SyncMachineLabelResult } from '@ai-usage/web-contract/sync';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';

type SetMachineLabelCommand = Extract<WebUsageEngineCommand, { readonly command: 'set-machine-label' }>;

type ExecuteMachineLabelCommand = (
  command: SetMachineLabelCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<unknown>;

const executeMachineLabelCommand: ExecuteMachineLabelCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

// The engine owns machine identity, so the renamed machine is read back from the command completion
// rather than echoed from the request: a rename that the engine did not apply must not look applied.
const machineFromCompletion = (completion: unknown): SyncMachineLabelResult => {
  if (
    typeof completion !== 'object' ||
    completion === null ||
    !('state' in completion) ||
    completion.state !== 'succeeded' ||
    !('command' in completion) ||
    completion.command !== 'set-machine-label' ||
    !('output' in completion)
  ) {
    throw new Error('The usage engine did not complete the machine rename.');
  }
  const { output } = completion;
  if (typeof output !== 'object' || output === null || !('machine' in output)) {
    throw new Error('The usage engine machine rename output is invalid.');
  }
  return parseSyncMachineLabelResult({ machine: output.machine });
};

export const setMachineLabelForServer = async (
  input: { readonly label: string },
  execute: ExecuteMachineLabelCommand = executeMachineLabelCommand,
  options?: ExecuteUsageEngineCommandOptions,
): Promise<SyncMachineLabelResult> => {
  const label = input.label.trim();
  const command = parseWebUsageEngineCommand({ command: 'set-machine-label', label });
  if (command.command !== 'set-machine-label') {
    throw new Error('Expected a machine label command.');
  }
  return machineFromCompletion(await execute(command, options));
};

export const setMachineLabelFromRequestForServer = async (
  request: Request,
  input: { readonly label: string },
  execute?: ExecuteMachineLabelCommand,
): Promise<SyncMachineLabelResult> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await setMachineLabelForServer(input, execute, { signal: request.signal });
};
