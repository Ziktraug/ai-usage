import { describe, expect, test } from 'bun:test';
import { parseUsageEngineCommandCompletion } from '@ai-usage/usage-engine-control';
import { getReplicationStatusForServer } from './replication-status.server';

const statusOutput = {
  kind: 'replication-status',
  lastDiagnostic: null,
  memory: null,
  mode: 'local-only',
  runtimeState: 'disabled',
  usage: null,
} as const;

const completion = () =>
  parseUsageEngineCommandCompletion({
    command: 'replication-status',
    commandId: 'replication-status-test',
    completedAt: '2026-08-30T08:00:00.000Z',
    output: statusOutput,
    state: 'succeeded',
  });

describe('replication status server boundary', () => {
  test('executes the closed status command and forwards cancellation', async () => {
    const controller = new AbortController();
    let observedCommand: unknown;
    let observedSignal: AbortSignal | undefined;

    await expect(
      getReplicationStatusForServer(controller.signal, (command, options) => {
        observedCommand = command;
        observedSignal = options?.signal;
        return Promise.resolve(completion());
      }),
    ).resolves.toEqual(statusOutput);
    expect(observedCommand).toEqual({ command: 'replication-status' });
    expect(observedSignal).toBe(controller.signal);
  });

  test('rejects an inconsistent command completion', async () => {
    const wrongCompletion = parseUsageEngineCommandCompletion({
      command: 'detect-all',
      commandId: 'replication-status-test',
      completedAt: '2026-08-30T08:00:00.000Z',
      output: { kind: 'none' },
      state: 'succeeded',
    });
    await expect(getReplicationStatusForServer(undefined, () => Promise.resolve(wrongCompletion))).rejects.toThrow(
      'inconsistent replication status completion',
    );
  });
});
