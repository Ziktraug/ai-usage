import { describe, expect, test } from 'bun:test';
import { fixtureGeneratedAt, fixtureInstanceId, fixtureStatus } from './test-fixtures';
import { createInMemoryUsageEngineControlClient } from './testing';

describe('in-memory usage engine control client', () => {
  test('clones commands through the strict parser and publishes deterministic events', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });
    const command = { command: 'run-source', sourceId: 'codex.sessions' } as const;
    const result = await adapter.client.execute(command, { commandId: 'command-1' as never });
    expect(result).toMatchObject({ commandId: 'command-1', ok: true });
    expect(adapter.commands).toEqual([command]);

    const changes = adapter.client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.event).toBe('status');
    adapter.publish({
      event: 'report-published',
      eventId: 'event-1',
      instanceId: fixtureInstanceId,
      publication: {
        instanceId: fixtureInstanceId,
        publishedAt: fixtureGeneratedAt,
        revision: 'revision-1',
        sourceControlGeneration: 1,
      },
      sequence: 1,
    });
    expect((await changes.next()).value?.event).toBe('report-published');
    adapter.dispose();
    expect((await changes.next()).done).toBe(true);
  });

  test('honors abort without retaining transport secrets', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });
    const abort = new AbortController();
    abort.abort();
    await expect(adapter.client.getStatus({ signal: abort.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(JSON.stringify(adapter)).not.toContain('token');
    adapter.dispose();
  });

  test('rejects a pending change read on abort and removes the subscriber', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });
    const abort = new AbortController();
    const changes = adapter.client.changes({ signal: abort.signal })[Symbol.asyncIterator]();
    expect((await changes.next()).value?.event).toBe('status');
    const pending = changes.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted', retry: 'never' });

    adapter.publish({
      event: 'report-published',
      eventId: 'event-after-abort',
      instanceId: fixtureInstanceId,
      publication: {
        instanceId: fixtureInstanceId,
        publishedAt: fixtureGeneratedAt,
        revision: 'revision-after-abort',
        sourceControlGeneration: 1,
      },
      sequence: 1,
    });
    adapter.dispose();

    const betweenPulls = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });
    const betweenAbort = new AbortController();
    const betweenChanges = betweenPulls.client.changes({ signal: betweenAbort.signal })[Symbol.asyncIterator]();
    expect((await betweenChanges.next()).value?.event).toBe('status');
    betweenAbort.abort();
    await expect(betweenChanges.next()).rejects.toMatchObject({ code: 'aborted', retry: 'never' });
    expect(await betweenChanges.next()).toEqual({ done: true, value: undefined });
    betweenPulls.dispose();
  });

  test('normalizes failed result and event messages like the HTTP client', async () => {
    const adapter = createInMemoryUsageEngineControlClient({
      execute: (_command, commandId) => ({
        commandId: commandId as never,
        error: { code: 'command-rejected', message: '/fixture/private/secret.json api_key=fake' },
        instanceId: fixtureInstanceId as never,
        ok: false,
        protocolVersion: 1 as never,
      }),
      status: fixtureStatus(),
    });
    expect(
      await adapter.client.execute({ command: 'publish' }, { commandId: 'command-redacted' as never }),
    ).toMatchObject({
      error: { code: 'command-rejected', message: 'Usage engine command was rejected.' },
    });

    const changes = adapter.client.changes()[Symbol.asyncIterator]();
    expect((await changes.next()).value?.event).toBe('status');
    adapter.publish({
      completion: {
        command: 'publish',
        commandId: 'command-redacted',
        completedAt: fixtureGeneratedAt,
        error: { code: 'command-rejected', message: '/fixture/private/secret.json api_key=fake' },
        state: 'failed',
      },
      event: 'command-completed',
      eventId: 'event-redacted',
      instanceId: fixtureInstanceId,
      sequence: 1,
    });
    expect((await changes.next()).value).toMatchObject({
      completion: {
        error: { code: 'command-rejected', message: 'Usage engine command was rejected.' },
      },
    });
    adapter.dispose();
  });

  test('enforces command and event identity parity with the HTTP client', async () => {
    const wrongCommand = createInMemoryUsageEngineControlClient({
      execute: (_command, _commandId) => ({
        admission: 'accepted',
        commandId: 'different-command' as never,
        instanceId: fixtureInstanceId as never,
        ok: true,
        protocolVersion: 1 as never,
      }),
      status: fixtureStatus(),
    });
    await expect(
      wrongCommand.client.execute({ command: 'publish' }, { commandId: 'command-1' as never }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    wrongCommand.dispose();

    const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });
    expect(() =>
      adapter.publish({
        event: 'report-published',
        eventId: 'event-other-instance',
        instanceId: '22222222-2222-4222-8222-222222222222',
        publication: {
          instanceId: '22222222-2222-4222-8222-222222222222',
          publishedAt: fixtureGeneratedAt,
          revision: 'revision-other',
          sourceControlGeneration: 1,
        },
        sequence: 1,
      }),
    ).toThrow('instance');
    expect(() => adapter.setStatus(fixtureStatus('22222222-2222-4222-8222-222222222222'))).toThrow('instance');
    adapter.dispose();
  });

  test('maps injected executor version and transport failures to stable control errors', async () => {
    const mismatch = createInMemoryUsageEngineControlClient({
      execute: (_command, commandId) =>
        ({
          admission: 'accepted',
          commandId,
          instanceId: fixtureInstanceId,
          ok: true,
          protocolVersion: 2,
        }) as never,
      status: fixtureStatus(),
    });
    await expect(
      mismatch.client.execute({ command: 'publish' }, { commandId: 'command-mismatch' as never }),
    ).rejects.toMatchObject({
      code: 'protocol-mismatch',
      message: 'Usage engine protocol version mismatch.',
      retry: 'never',
    });
    mismatch.dispose();

    const throwing = createInMemoryUsageEngineControlClient({
      execute: () => {
        throw new Error('/fixture/private/secret.json api_key=fake');
      },
      status: fixtureStatus(),
    });
    await expect(
      throwing.client.execute({ command: 'publish' }, { commandId: 'command-throw' as never }),
    ).rejects.toMatchObject({
      code: 'transport-failed',
      message: 'Usage engine transport failed.',
      retry: 'same-command-id',
    });
    throwing.dispose();
  });

  test('bounds queued incrementals while preserving the authoritative first status', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ maxQueuedEvents: 2, status: fixtureStatus() });
    const changes = adapter.client.changes()[Symbol.asyncIterator]();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      adapter.publish({
        event: 'report-published',
        eventId: `event-${sequence}`,
        instanceId: fixtureInstanceId,
        publication: {
          instanceId: fixtureInstanceId,
          publishedAt: fixtureGeneratedAt,
          revision: `revision-${sequence}`,
          sourceControlGeneration: sequence,
        },
        sequence,
      });
    }

    expect((await changes.next()).value?.event).toBe('status');
    expect((await changes.next()).value?.eventId).toBe('event-3');
    adapter.dispose();
  });
});
