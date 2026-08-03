import { describe, expect, test } from 'bun:test';
import {
  collectionSourceDefinitions,
  parseSourceControlSnapshot,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import { parseUsageEngineStatus, USAGE_ENGINE_PROTOCOL_VERSION } from '@ai-usage/usage-engine-control';
import { createInMemoryUsageEngineControlClient } from '@ai-usage/usage-engine-control/testing';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import { createSourceControlEventStream } from '../../../server/source-control-api.server';

const INSTANCE_ID = 'p6-virtual-engine';
const encoder = new TextDecoder();

const snapshot = (generation: number): SourceControlView =>
  parseSourceControlSnapshot({
    generatedAt: new Date(generation).toISOString(),
    generation,
    instanceId: INSTANCE_ID,
    publication: {
      acknowledgedRequestGeneration: generation,
      dirty: false,
      dirtyGeneration: generation,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: generation,
      queued: false,
      requestedGeneration: generation,
      rtkCompletedGeneration: generation,
      rtkRequiredGeneration: generation,
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

const status = (generation: number) =>
  parseUsageEngineStatus({
    currentPublication: null,
    degradedReason: null,
    generatedAt: new Date(generation).toISOString(),
    generation,
    instanceId: INSTANCE_ID,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    readiness: 'ready',
    sourceControl: snapshot(generation),
    storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
  });

const request = (signal: AbortSignal): Request =>
  new Request('http://localhost:3000/api/source-control', {
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
    signal,
  });

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const result = await reader.read();
  if (result.done) {
    throw new Error('The synthetic source-control stream closed unexpectedly.');
  }
  return encoder.decode(result.value);
};

const drainInitialEvents = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> => [
  await readChunk(reader),
  await readChunk(reader),
  await readChunk(reader),
];

class VirtualRepeatingClock {
  elapsedMs = 0;
  private readonly operations: Array<{ active: boolean; intervalMs: number; nextMs: number; run: () => void }> = [];

  readonly schedule = (run: () => void, intervalMs: number): (() => void) => {
    const operation = { active: true, intervalMs, nextMs: this.elapsedMs + intervalMs, run };
    this.operations.push(operation);
    return () => {
      operation.active = false;
    };
  };

  advance(milliseconds: number): void {
    const target = this.elapsedMs + milliseconds;
    for (const operation of this.operations) {
      while (operation.active && operation.nextMs <= target) {
        operation.nextMs += operation.intervalMs;
        operation.run();
      }
    }
    this.elapsedMs = target;
  }

  get activeCount(): number {
    return this.operations.filter((operation) => operation.active).length;
  }
}

describe('source-control SSE virtual lifecycle', () => {
  test('holds beyond 30 seconds with virtual heartbeats and cancels every schedule on abort', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status(0) });
    const abort = new AbortController();
    const clock = new VirtualRepeatingClock();
    let cleanups = 0;
    const response = createSourceControlEventStream(request(abort.signal), {
      control: adapter.client,
      onCleanup: () => {
        cleanups += 1;
      },
      scheduleHealthCheck: clock.schedule,
      scheduleHeartbeat: clock.schedule,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('The synthetic source-control response has no body.');
    }

    expect(await drainInitialEvents(reader)).toEqual([
      'retry: 3000\n\n',
      expect.stringContaining('event: snapshot'),
      expect.stringContaining('event: control-state'),
    ]);
    clock.advance(35_001);
    expect(clock.elapsedMs).toBeGreaterThan(30_000);
    expect(await readChunk(reader)).toBe(': heartbeat\n\n');

    abort.abort();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(clock.activeCount).toBe(0);
    expect(cleanups).toBe(1);
    adapter.dispose();
  });

  test('coalesces queued snapshots to the newest generation under backpressure', async () => {
    const adapter = createInMemoryUsageEngineControlClient({ status: status(0) });
    const abort = new AbortController();
    const response = createSourceControlEventStream(request(abort.signal), {
      control: adapter.client,
      scheduleHealthCheck: () => () => undefined,
      scheduleHeartbeat: () => () => undefined,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('The synthetic source-control response has no body.');
    }
    await drainInitialEvents(reader);

    for (const generation of [1, 2, 3]) {
      adapter.publish({
        event: 'source-control',
        eventId: `source-control:${generation}`,
        instanceId: INSTANCE_ID,
        sequence: generation,
        snapshot: snapshot(generation),
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    const first = await readChunk(reader);
    const latest = await readChunk(reader);

    expect(first).toContain('"generation":1');
    expect(latest).toContain('"generation":3');
    expect(latest).not.toContain('"generation":2');
    abort.abort();
    adapter.dispose();
  });
});
