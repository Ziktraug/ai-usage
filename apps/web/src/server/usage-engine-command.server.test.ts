import { expect, test } from 'bun:test';
import { collectionSourceDefinitions, parseSourceControlSnapshot } from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineCommandResult,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
} from '@ai-usage/usage-engine-control';
import { createUsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import { parseUsageEngineRendezvous } from '@ai-usage/usage-engine-control/node';
import { createInMemoryUsageEngineControlClient } from '@ai-usage/usage-engine-control/testing';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import {
  executeUsageEngineCommandToCompletion,
  UsageEngineCommandCompletionError,
} from './usage-engine-command.server';

const INSTANCE_ID = 'command-helper-engine';

const fixtureStatus = () => {
  const sourceControl = parseSourceControlSnapshot({
    generatedAt: '2026-07-30T10:00:00.000Z',
    generation: 1,
    instanceId: INSTANCE_ID,
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      lastPublishedAt: '2026-07-30T10:00:00.000Z',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      revision: 'revision-a',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map((definition) => ({
      availability: 'detected',
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: 'success',
      lifecycle: 'scheduled',
      policy: 'enabled',
      reason: { code: 'none' },
      warnings: [],
    })),
  });
  return parseUsageEngineStatus({
    currentPublication: { publishedAt: '2026-07-30T10:00:00.000Z', revision: 'revision-a' },
    degradedReason: null,
    generatedAt: '2026-07-30T10:00:00.000Z',
    generation: 1,
    instanceId: INSTANCE_ID,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    readiness: 'ready',
    sourceControl,
    storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
  });
};

test('subscribes before admission and correlates the exact synchronous completion', async () => {
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
          instanceId: INSTANCE_ID,
          sequence: 1,
        }),
      );
      return parseUsageEngineCommandResult({
        admission: 'accepted',
        commandId,
        instanceId: INSTANCE_ID,
        ok: true,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      });
    },
    status: fixtureStatus(),
  });

  const completion = await executeUsageEngineCommandToCompletion(
    adapter.client,
    { command: 'replace-project-aliases', projectAliases: [] },
    { commandId: 'exact-command' },
  );

  expect(completion).toMatchObject({
    command: 'replace-project-aliases',
    commandId: 'exact-command',
    state: 'succeeded',
  });
  adapter.dispose();
});

test('opens the real HTTP client event stream before admitting an immediate completion', async () => {
  const requests: string[] = [];
  let subscribed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => undefined,
    start: (controller) => {
      streamController = controller;
    },
  });
  const frame = (event: ReturnType<typeof parseUsageEngineEvent>): Uint8Array =>
    encoder.encode(`id: ${event.eventId}\nevent: usage-engine\ndata: ${JSON.stringify(event)}\n\n`);
  const status = fixtureStatus();
  const client = createUsageEngineControlClient({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (pathname === '/v1/status') {
        return Response.json(status);
      }
      if (pathname === '/v1/events') {
        subscribed = true;
        streamController?.enqueue(
          frame(
            parseUsageEngineEvent({
              event: 'status',
              eventId: 'status:1',
              instanceId: INSTANCE_ID,
              sequence: 0,
              status,
            }),
          ),
        );
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (pathname !== '/v1/commands') {
        throw new Error(`Unexpected control path: ${pathname}`);
      }
      if (!subscribed) {
        throw new Error('Command was admitted before the SSE subscription.');
      }
      const requestBody = (await request.json()) as {
        readonly command: { readonly command: string };
        readonly commandId: string;
      };
      streamController?.enqueue(
        frame(
          parseUsageEngineEvent({
            completion: {
              command: requestBody.command.command,
              commandId: requestBody.commandId,
              completedAt: '2026-07-30T10:00:01.000Z',
              output: { kind: 'none' },
              state: 'succeeded',
            },
            event: 'command-completed',
            eventId: 'completion:1',
            instanceId: INSTANCE_ID,
            sequence: 1,
          }),
        ),
      );
      return Response.json({
        admission: 'accepted',
        commandId: requestBody.commandId,
        instanceId: INSTANCE_ID,
        ok: true,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      });
    },
    resolveRendezvous: () =>
      Promise.resolve(
        parseUsageEngineRendezvous({
          instanceId: INSTANCE_ID,
          port: 41_321,
          protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          targetId: 'a'.repeat(64),
          token: 'fixture-token-with-at-least-thirty-two-bytes',
        }),
      ),
  });

  const completion = await executeUsageEngineCommandToCompletion(
    client,
    { command: 'replace-project-aliases', projectAliases: [] },
    { commandId: 'http-exact-command' },
  );

  expect(completion).toMatchObject({ commandId: 'http-exact-command', state: 'succeeded' });
  expect(requests).toEqual(['/v1/status', '/v1/events', '/v1/commands']);
});

test('returns a typed timeout and closes a completion stream that never terminates', async () => {
  const adapter = createInMemoryUsageEngineControlClient({ status: fixtureStatus() });

  try {
    await executeUsageEngineCommandToCompletion(
      adapter.client,
      { command: 'publish' },
      { commandId: 'timed-command', timeoutMs: 10 },
    );
    throw new Error('Expected command completion to time out.');
  } catch (error) {
    expect(error).toBeInstanceOf(UsageEngineCommandCompletionError);
    expect((error as UsageEngineCommandCompletionError).code).toBe('timeout');
  } finally {
    adapter.dispose();
  }
});
