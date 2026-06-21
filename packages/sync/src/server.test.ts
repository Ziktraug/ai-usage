import { describe, expect, test } from 'bun:test';
import { createUsageSnapshot } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { createSnapshotHttpHandler, type SnapshotRequestEvent, startNodeSnapshotServer } from './server';

const machine = { id: 'machine-1', label: 'Machine 1' };

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

const snapshot = () =>
  createUsageSnapshot({
    machine,
    rows: [row()],
    generatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

describe('snapshot server protocol', () => {
  test('serves endpoint health', async () => {
    const handler = createSnapshotHttpHandler({
      machine,
      token: null,
      collectSnapshot: async () => snapshot(),
    });

    const response = await handler(new Request('http://localhost/health'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, machine });
  });

  test('serves snapshots with bearer auth', async () => {
    const events: SnapshotRequestEvent[] = [];
    const handler = createSnapshotHttpHandler({
      machine,
      token: 'secret',
      collectSnapshot: async () => snapshot(),
      onRequest: (event) => events.push(event),
    });

    const denied = await handler(new Request('http://localhost/snapshot'));
    const allowed = await handler(
      new Request('http://localhost/snapshot', { headers: { authorization: 'Bearer secret' } }),
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).rows).toHaveLength(1);
    expect(events.map((event) => event.status)).toEqual([401, 200]);
  });

  test('reports snapshot collection failures', async () => {
    const handler = createSnapshotHttpHandler({
      machine,
      token: null,
      collectSnapshot: () => {
        throw new Error('collection failed');
      },
    });

    const response = await handler(new Request('http://localhost/snapshot'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'collection failed' });
  });

  test('returns 404 for unknown paths', async () => {
    const handler = createSnapshotHttpHandler({
      machine,
      token: null,
      collectSnapshot: async () => snapshot(),
    });

    const response = await handler(new Request('http://localhost/nope'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found');
  });

  test('starts a Node snapshot server adapter and reports the client address', async () => {
    const events: SnapshotRequestEvent[] = [];
    const server = await Effect.runPromise(
      startNodeSnapshotServer({
        host: '127.0.0.1',
        port: 0,
        machine,
        token: null,
        collectSnapshot: async () => snapshot(),
        onRequest: (event) => events.push(event),
      }),
    );

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, machine });
      expect(events[0]?.remoteAddress).not.toBe('unknown');
      expect(events[0]?.remoteAddress.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test('refuses to bind beyond localhost without a token', async () => {
    const exit = await Effect.runPromiseExit(
      startNodeSnapshotServer({
        host: '0.0.0.0',
        port: 0,
        machine,
        token: null,
        collectSnapshot: async () => snapshot(),
      }),
    );

    expect(exit._tag).toBe('Failure');
  });
});
