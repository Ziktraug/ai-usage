import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCaptureContextSnapshot } from '@ai-usage/replication-protocol';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { importLocalRows, listUsageReplicationOutboxHistory } from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { backfillUsageReplicationPages } from './replication';

test('continues bounded usage recovery scans without repeating the Device fact on later pages', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-replication-pages-'));
  const dbPath = path.join(directory, 'usage.sqlite');
  try {
    const machine: UsageMachine = { id: 'replication-machine', label: 'Replication Machine' };
    const capturedAt = new Date('2026-08-30T18:00:00.000Z');
    const rows = [1, 2, 3].map((index) => ({
      ...normalizeUsageRow({
        calls: 1,
        cost: actualCost(null),
        date: new Date(capturedAt.getTime() + index * 1000),
        durationMs: 1000,
        endDate: new Date(capturedAt.getTime() + (index + 1) * 1000),
        harness: 'Codex',
        model: 'gpt-5',
        name: `Replicated session ${index}`,
        project: `/local/project/${index}`,
        provider: 'OpenAI',
        tokens: { cr: 0, cw: 0, in: 10, out: index },
      }),
      source: { harnessKey: 'codex' as const, sourceSessionId: `replication-session-${index}` },
    }));
    await Effect.runPromise(importLocalRows({ dbPath, importedAt: capturedAt, machine, rows }));
    const captureContext = parseCaptureContextSnapshot({
      deviceId: '71000000-0000-4000-8000-000000000001',
      id: '71000000-0000-4000-8000-000000000002',
      personId: '71000000-0000-4000-8000-000000000003',
      projectId: null,
      scmAccountId: null,
      scmInstallationId: null,
      source: 'personal-fallback',
      spaceId: '71000000-0000-4000-8000-000000000004',
    });

    const first = await backfillUsageReplicationPages({
      captureContext,
      dbPath,
      enqueuedAt: capturedAt,
      maximumPages: 2,
      pageSize: 1,
    });
    expect(first).toMatchObject({ enqueued: 3, pages: 2, scanned: 2, truncated: true, unchanged: 0 });
    expect(first.nextCursor).not.toBeNull();
    const second = await backfillUsageReplicationPages({
      afterRowKey: first.nextCursor,
      captureContext,
      dbPath,
      enqueuedAt: capturedAt,
      maximumPages: 2,
      pageSize: 1,
    });
    expect(second).toEqual({ enqueued: 1, nextCursor: null, pages: 1, scanned: 1, truncated: false, unchanged: 0 });

    const history = await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }));
    expect(history).toHaveLength(4);
    expect(history.filter(({ changeKind }) => changeKind === 'device-fact-upsert')).toHaveLength(1);
    expect(history.filter(({ changeKind }) => changeKind === 'usage-session-upsert')).toHaveLength(3);
    expect(JSON.stringify(history)).not.toContain('/local/project');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
