import type { UsageSnapshot } from '@ai-usage/core/snapshot';
import { createUsageSnapshot } from '@ai-usage/core/snapshot';
import type { SourcedRow } from '@ai-usage/core/types';
import type { SnapshotServerHandle, SnapshotServerInput } from '@ai-usage/sync/server';
import { describe, expect, test } from 'bun:test';
import { createSyncServeRuntime } from './sync-serve.server';

const machine = { id: 'local-1', label: 'Local Machine' };

const row = (): SourcedRow => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: 'session',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 10,
  tokOut: 5,
  tokCr: 0,
  tokCw: 0,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  source: { harnessKey: 'codex', sourceSessionId: 'session-1' },
});

const snapshot = (): UsageSnapshot =>
  createUsageSnapshot({
    machine,
    rows: [row()],
    generatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

const runtime = (
  overrides: Partial<{ startServer: (input: SnapshotServerInput) => Promise<SnapshotServerHandle> }> = {},
) => {
  const starts: SnapshotServerInput[] = [];
  let stopped = false;
  return {
    starts,
    stopped: () => stopped,
    service: createSyncServeRuntime({
      getMachine: async () => machine,
      collectSnapshot: async () => snapshot(),
      startServer:
        overrides.startServer ??
        (async (input) => {
          starts.push(input);
          input.onRequest?.({
            method: 'GET',
            path: '/health',
            remoteAddress: '127.0.0.1',
            status: 200,
            durationMs: 3,
          });
          return {
            port: input.port,
            urls: [`http://${input.host}:${input.port}/snapshot`],
            stop: async () => {
              stopped = true;
            },
          };
        }),
      now: () => new Date('2026-06-19T09:00:00.000Z'),
    }),
  };
};

describe('sync serve runtime', () => {
  test('requires a token before serving on 0.0.0.0', async () => {
    const { service, starts } = runtime();

    const result = await service.start({ host: '0.0.0.0', port: 3847, token: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.status).toBe('error');
    expect(result.data.lastError?.reason).toBe('missing-serve-token');
    expect(starts).toHaveLength(0);
    expect(JSON.stringify(result.data)).not.toContain('secret');
  });

  test('starts and stops a snapshot server without exposing the raw token', async () => {
    const { service, starts, stopped } = runtime();

    const started = await service.start({ host: '127.0.0.1', port: 3847, token: 'secret' });

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.data.status).toBe('running');
    expect(started.data.tokenConfigured).toBe(true);
    expect(started.data.machine).toEqual(machine);
    expect(started.data.urls).toEqual(['http://127.0.0.1:3847/snapshot']);
    expect(started.data.recentRequests[0]?.path).toBe('/health');
    expect(JSON.stringify(started.data)).not.toContain('secret');
    expect(starts[0]?.token).toBe('secret');

    const stoppedResult = await service.stop();

    expect(stoppedResult.ok).toBe(true);
    if (!stoppedResult.ok) throw new Error(stoppedResult.error.message);
    expect(stopped()).toBe(true);
    expect(stoppedResult.data.status).toBe('stopped');
    expect(stoppedResult.data.urls).toEqual([]);
    expect(stoppedResult.data.tokenConfigured).toBe(false);
  });
});
