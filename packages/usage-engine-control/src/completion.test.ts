import { expect, test } from 'bun:test';
import { executeUsageEngineCommandToCompletion } from './completion';
import { parseUsageEngineCommandResult, parseUsageEngineEvent, USAGE_ENGINE_PROTOCOL_VERSION } from './contracts';
import { fixtureInstanceId, fixtureStatus } from './test-fixtures';
import { createInMemoryUsageEngineControlClient } from './testing';

test('subscribes before admission and returns the exact completion without a later status read', async () => {
  let adapter: ReturnType<typeof createInMemoryUsageEngineControlClient>;
  adapter = createInMemoryUsageEngineControlClient({
    execute: (command, commandId) => {
      adapter.publish(
        parseUsageEngineEvent({
          completion: {
            command: command.command,
            commandId,
            completedAt: '2026-07-30T10:00:01.000Z',
            output: { kind: 'none' },
            state: 'succeeded',
          },
          event: 'command-completed',
          eventId: 'completion:1',
          instanceId: fixtureInstanceId,
          sequence: 1,
        }),
      );
      return parseUsageEngineCommandResult({
        admission: 'accepted',
        commandId,
        instanceId: fixtureInstanceId,
        ok: true,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      });
    },
    status: fixtureStatus(),
  });

  const completion = await executeUsageEngineCommandToCompletion(
    adapter.client,
    { command: 'replace-project-aliases', projectAliases: [] },
    { commandId: 'exact-command', expectedStoreSchemaVersion: 1 },
  );

  expect(completion).toMatchObject({ commandId: 'exact-command', state: 'succeeded' });
  adapter.dispose();
});

test('best-effort cancels the exact admitted command when completion times out', async () => {
  const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });

  await expect(
    executeUsageEngineCommandToCompletion(
      adapter.client,
      { command: 'publish' },
      { commandId: 'timed-command', expectedStoreSchemaVersion: 1, timeoutMs: 10 },
    ),
  ).rejects.toMatchObject({ code: 'timeout' });
  expect(adapter.cancellations).toEqual(['timed-command']);
  adapter.dispose();
});

test('does not let cancellation failure mask the original caller abort', async () => {
  const adapter = createInMemoryUsageEngineControlClient({
    cancelCommand: () => {
      throw new Error('synthetic cancellation failure');
    },
    status: fixtureStatus(),
  });
  const controller = new AbortController();
  const completion = executeUsageEngineCommandToCompletion(
    adapter.client,
    { command: 'publish' },
    { commandId: 'aborted-command', expectedStoreSchemaVersion: 1, signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort();

  await expect(completion).rejects.toMatchObject({ code: 'aborted' });
  expect(adapter.cancellations).toEqual(['aborted-command']);
  adapter.dispose();
});

test('aborts a non-cooperative cancellation request at the best-effort deadline', async () => {
  const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });
  let cancellationSignal: AbortSignal | undefined;
  const control = {
    ...adapter.client,
    cancelCommand: (_commandId: string, options: { readonly signal?: AbortSignal } = {}) =>
      new Promise<never>((_resolve, reject) => {
        cancellationSignal = options.signal;
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }),
  };
  const startedAt = Date.now();

  await expect(
    executeUsageEngineCommandToCompletion(
      control,
      { command: 'publish' },
      { commandId: 'bounded-cancellation', expectedStoreSchemaVersion: 1, timeoutMs: 10 },
    ),
  ).rejects.toMatchObject({ code: 'timeout' });

  expect(cancellationSignal?.aborted).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(2500);
  adapter.dispose();
});
