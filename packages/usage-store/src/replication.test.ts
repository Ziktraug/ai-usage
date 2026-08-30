import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CaptureContextId,
  DeviceId,
  Instant,
  PersonId,
  ProjectId,
  SpaceId,
} from '@ai-usage/platform-core/identity';
import type { ReplicationAck } from '@ai-usage/replication-protocol';
import { toSerializedMergeRow } from '@ai-usage/report-core/merge-bundle';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  acknowledgeUsageReplicationBatch,
  backfillUsageReplicationOutbox,
  claimUsageReplicationBatch,
  importLocalRows,
  listUsageReplicationOutboxHistory,
  queryReportRows,
  queryUsageReplicationCandidates,
  queryUsageReplicationOutboxStatus,
} from './index';

const deviceId = '40000000-0000-4000-8000-000000000001' as DeviceId;
const projectId = '40000000-0000-4000-8000-000000000002' as ProjectId;
const machine: UsageMachine = { id: 'machine-local', label: 'Local workstation' };
const capturedAt = new Date('2026-08-30T11:00:00.000Z');
const captureContext = {
  deviceId,
  id: '40000000-0000-4000-8000-000000000003' as CaptureContextId,
  personId: '40000000-0000-4000-8000-000000000004' as PersonId,
  projectId,
  scmAccountId: null,
  scmInstallationId: null,
  source: 'explicit' as const,
  spaceId: '40000000-0000-4000-8000-000000000005' as SpaceId,
};

const usageRow = (outputTokens = 20): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-08-30T10:30:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-08-30T10:31:00.000Z'),
    harness: 'Codex',
    model: 'gpt-5',
    name: 'Replicated session',
    project: '/private/local/path/never-publish',
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 0, in: 10, out: outputTokens },
  }),
  source: { harnessKey: 'codex', sourceSessionId: 'replication-session' },
});

const withStorePath = async (run: (dbPath: string) => Promise<void>): Promise<void> => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ai-usage-replication-'));
  try {
    await run(path.join(directory, 'usage.sqlite'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const publicationFor = (row: UsageRowWithOptionalSource) => ({
  assignments: [{ captureContext, rowKey: toSerializedMergeRow(row, machine).rowKey }],
  deviceId,
});

test('writes normalized usage and its outbox events atomically without local paths', async () => {
  await withStorePath(async (dbPath) => {
    const row = usageRow();
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: capturedAt,
        machine,
        replication: publicationFor(row),
        rows: [row],
      }),
    );
    expect(await Effect.runPromise(queryUsageReplicationOutboxStatus({ dbPath }))).toMatchObject({
      acknowledged: 0,
      blocked: 0,
      pending: 2,
      streamId: 'usage-v1',
    });
    const claim = await Effect.runPromise(
      claimUsageReplicationBatch({ dbPath, now: new Date('2026-08-30T11:01:00.000Z') }),
    );
    if (!claim) {
      throw new Error('Expected usage replication batch.');
    }
    expect(claim.batch.events.map(({ changeKind }) => changeKind)).toEqual([
      'device-fact-upsert',
      'usage-session-upsert',
    ]);
    expect(JSON.stringify(claim.batch)).not.toContain('/private/local/path');
    expect(claim.batch.captureContexts[0]?.projectId).toBe(projectId);

    const ack: ReplicationAck = {
      acceptedThroughGeneration: claim.batch.toGenerationInclusive,
      appliedAt: '2026-08-30T11:02:00.000Z' as Instant,
      appliedBatchId: claim.batch.batchId,
      appliedEventIds: claim.batch.events.map(({ eventId }) => eventId),
      counts: { applied: 2, duplicate: 0, projected: 2, tombstoned: 0 },
      deviceId,
      protocolVersion: 1,
      streamId: claim.batch.streamId,
      warnings: [],
    };
    await Effect.runPromise(acknowledgeUsageReplicationBatch({ ack, batch: claim.batch, dbPath }));
    expect(await Effect.runPromise(queryUsageReplicationOutboxStatus({ dbPath }))).toMatchObject({
      acknowledged: 2,
      acknowledgedThroughGeneration: 2,
      pending: 0,
    });

    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: new Date('2026-08-30T11:03:00.000Z'),
        machine,
        replication: publicationFor(row),
        rows: [row],
      }),
    );
    expect(await Effect.runPromise(queryUsageReplicationOutboxStatus({ dbPath }))).toMatchObject({
      acknowledged: 2,
      pending: 0,
    });
  });
});

test('rolls the source mutation back when its explicit Capture Context is invalid', async () => {
  await withStorePath(async (dbPath) => {
    const row = usageRow();
    const invalidPublication = {
      assignments: [
        {
          captureContext: {
            ...captureContext,
            deviceId: '40000000-0000-4000-8000-000000000099' as DeviceId,
          },
          rowKey: toSerializedMergeRow(row, machine).rowKey,
        },
      ],
      deviceId,
    };
    await expect(
      Effect.runPromise(
        importLocalRows({
          dbPath,
          importedAt: capturedAt,
          machine,
          replication: invalidPublication,
          rows: [row],
        }),
      ),
    ).rejects.toThrow();
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toEqual([]);
  });
});

test('deterministically backfills a previously published local fact once', async () => {
  await withStorePath(async (dbPath) => {
    const row = usageRow();
    await Effect.runPromise(importLocalRows({ dbPath, importedAt: capturedAt, machine, rows: [row] }));
    const candidates = await Effect.runPromise(queryUsageReplicationCandidates({ dbPath, maximumItems: 1 }));
    expect(candidates).toEqual({ nextCursor: null, rowKeys: [toSerializedMergeRow(row, machine).rowKey] });
    const candidate = candidates.rowKeys[0];
    if (candidate === undefined) {
      throw new Error('Expected one Usage replication candidate.');
    }
    expect(
      await Effect.runPromise(queryUsageReplicationCandidates({ afterRowKey: candidate, dbPath, maximumItems: 1 })),
    ).toEqual({ nextCursor: null, rowKeys: [] });
    const input = {
      ...publicationFor(row),
      dbPath,
      enqueuedAt: new Date('2026-08-30T11:04:00.000Z'),
    };
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({ enqueued: 2, unchanged: 0 });
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({ enqueued: 0, unchanged: 2 });
    const history = await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }));
    expect(history).toHaveLength(2);
    expect(history.map(({ factKey }) => factKey)).not.toContain('/private/local/path/never-publish');
  });
});
