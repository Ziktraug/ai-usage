import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsageSnapshot } from '@ai-usage/report-core/snapshot';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { fetchRemoteSnapshot, readSnapshotEndpointHealth, readSnapshotFile } from './transport';

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
    machine: { id: 'machine-1', label: 'Machine 1' },
    rows: [row()],
    generatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('snapshot transport', () => {
  test('reads a snapshot file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-usage-sync-transport-'));
    try {
      const filePath = path.join(dir, 'snapshot.json');
      writeFileSync(filePath, JSON.stringify(snapshot()), 'utf8');

      const parsed = await Effect.runPromise(readSnapshotFile(filePath));

      expect(parsed.machine.label).toBe('Machine 1');
      expect(parsed.rows).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fetches a remote snapshot with bearer auth', async () => {
    const seen: { authorization: string | null } = { authorization: null };
    globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      seen.authorization = init?.headers && 'authorization' in init.headers ? init.headers.authorization : null;
      return new Response(JSON.stringify(snapshot()), { status: 200 });
    }) as unknown as typeof fetch;

    const parsed = await Effect.runPromise(fetchRemoteSnapshot('http://remote/snapshot', 'secret'));

    expect(seen.authorization).toBe('Bearer secret');
    expect(parsed.machine.id).toBe('machine-1');
  });

  test('surfaces HTTP failures', async () => {
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;

    const error = await Effect.runPromise(Effect.flip(fetchRemoteSnapshot('http://remote/snapshot', 'bad')));

    expect(error.message).toBe('fetch http://remote/snapshot: HTTP 401 unauthorized');
    expect(error.status).toBe(401);
  });

  test('reads endpoint health', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, machine: { id: 'machine-1', label: 'Machine 1' } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const health = await Effect.runPromise(readSnapshotEndpointHealth('http://remote/health', null));

    expect(health.machine.label).toBe('Machine 1');
  });
});
