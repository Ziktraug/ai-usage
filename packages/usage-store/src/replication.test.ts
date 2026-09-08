import { Database } from 'bun:sqlite';
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
  type UsageReplicationCandidatePage,
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

const usageRow = (
  outputTokens = 20,
  overrides: { readonly model?: string; readonly sourceSessionId?: string } = {},
): UsageRowWithOptionalSource => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-08-30T10:30:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-08-30T10:31:00.000Z'),
    harness: 'Codex',
    model: overrides.model ?? 'gpt-5',
    name: 'Replicated session',
    project: '/private/local/path/never-publish',
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 0, in: 10, out: outputTokens },
  }),
  source: { harnessKey: 'codex', sourceSessionId: overrides.sourceSessionId ?? 'replication-session' },
});

// Built at runtime so no editor or formatter can flatten the NUL byte into whitespace.
const nul = String.fromCharCode(0);

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
  deviceLabel: 'Enrolled workstation',
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
    expect(claim.batch.events[0]?.payload).toMatchObject({ label: 'Enrolled workstation' });
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

test('does not publish a hostname-derived Device label without an enrolled label', async () => {
  await withStorePath(async (dbPath) => {
    const row = usageRow();
    const hostnameMachine: UsageMachine = { id: machine.id, label: 'private-hostname.local' };
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: capturedAt,
        machine: hostnameMachine,
        replication: {
          assignments: [{ captureContext, rowKey: toSerializedMergeRow(row, hostnameMachine).rowKey }],
          deviceId,
        },
        rows: [row],
      }),
    );
    const claim = await Effect.runPromise(
      claimUsageReplicationBatch({ dbPath, now: new Date('2026-08-30T11:01:00.000Z') }),
    );
    if (!claim) {
      throw new Error('Expected privacy-preserving usage replication batch.');
    }
    expect(claim.batch.events.map(({ changeKind }) => changeKind)).toEqual(['usage-session-upsert']);
    expect(JSON.stringify(claim.batch)).not.toContain(hostnameMachine.label);
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

test('keeps one usage fact key across re-collection and tombstones that same key', async () => {
  await withStorePath(async (dbPath) => {
    const initial = usageRow(20);
    const grown = usageRow(40);
    const rowKey = toSerializedMergeRow(initial, machine).rowKey;
    expect(toSerializedMergeRow(grown, machine).rowKey).toBe(rowKey);
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: capturedAt,
        machine,
        replication: publicationFor(initial),
        rows: [initial],
      }),
    );
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: new Date('2026-08-30T11:05:00.000Z'),
        machine,
        replication: publicationFor(grown),
        rows: [grown],
      }),
    );
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(1);
    const upserts = (await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }))).filter(
      ({ changeKind }) => changeKind === 'usage-session-upsert',
    );
    expect(upserts).toHaveLength(2);
    expect(new Set(upserts.map(({ contentHash }) => contentHash)).size).toBe(2);
    expect(new Set(upserts.map(({ factKey }) => factKey)).size).toBe(1);
    const sessionFactKey = upserts[0]?.factKey;
    if (sessionFactKey === undefined) {
      throw new Error('Expected a usage session fact key.');
    }
    expect(sessionFactKey).not.toContain(rowKey);

    const store = new Database(dbPath);
    try {
      store
        .query("UPDATE usage_rows SET status = 'deleted', updated_at = ? WHERE row_key = ?")
        .run('2026-08-30T11:06:00.000Z', rowKey);
    } finally {
      store.close();
    }
    expect(
      await Effect.runPromise(
        backfillUsageReplicationOutbox({
          ...publicationFor(grown),
          dbPath,
          enqueuedAt: new Date('2026-08-30T11:07:00.000Z'),
          includeDeviceFact: false,
        }),
      ),
    ).toEqual({ enqueued: 1, unchanged: 0, unpublishable: 0 });
    expect((await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath })))[0]).toMatchObject({
      changeKind: 'usage-session-tombstone',
      factKey: sessionFactKey,
    });
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
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 2,
      unchanged: 0,
      unpublishable: 0,
    });
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 0,
      unchanged: 2,
      unpublishable: 0,
    });
    const history = await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }));
    expect(history).toHaveLength(2);
    expect(history.map(({ factKey }) => factKey)).not.toContain('/private/local/path/never-publish');
  });
});

test('keeps a usage row the protocol refuses local and counted, without stalling the other rows', async () => {
  await withStorePath(async (dbPath) => {
    const ordinary = usageRow();
    const refused = usageRow(20, { model: `gpt-5${nul}`, sourceSessionId: 'refused-session' });
    const rows = [ordinary, refused];
    const assignments = rows.map((row) => ({ captureContext, rowKey: toSerializedMergeRow(row, machine).rowKey }));
    await Effect.runPromise(importLocalRows({ dbPath, importedAt: capturedAt, machine, rows }));
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(2);

    const input = {
      assignments,
      dbPath,
      deviceId,
      enqueuedAt: new Date('2026-08-30T11:04:00.000Z'),
      includeDeviceFact: false,
    };
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 1,
      unchanged: 0,
      unpublishable: 1,
    });
    const ordinaryFactKey = (await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }))).map(
      ({ changeKind, factKey }) => ({ changeKind, factKey }),
    );
    expect(ordinaryFactKey).toEqual([{ changeKind: 'usage-session-upsert', factKey: expect.any(String) }]);
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 0,
      unchanged: 1,
      unpublishable: 1,
    });

    // The incremental publication (import with a replication publication) skips the same row and
    // still commits the import of every row.
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: new Date('2026-08-30T11:05:00.000Z'),
        machine,
        replication: { assignments, deviceId },
        rows: [usageRow(40), usageRow(40, { model: `gpt-5${nul}`, sourceSessionId: 'refused-session' })],
      }),
    );
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(2);
    const afterImport = await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }));
    expect(afterImport).toHaveLength(2);
    expect(new Set(afterImport.map(({ factKey }) => factKey)).size).toBe(1);

    // A tombstone carries no free text, so the refused row's deletion still publishes.
    const store = new Database(dbPath);
    try {
      store
        .query("UPDATE usage_rows SET status = 'deleted', updated_at = ? WHERE row_key = ?")
        .run('2026-08-30T11:06:00.000Z', toSerializedMergeRow(refused, machine).rowKey);
    } finally {
      store.close();
    }
    expect(
      await Effect.runPromise(
        backfillUsageReplicationOutbox({ ...input, enqueuedAt: new Date('2026-08-30T11:07:00.000Z') }),
      ),
    ).toEqual({ enqueued: 1, unchanged: 1, unpublishable: 0 });
    expect((await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath })))[0]).toMatchObject({
      changeKind: 'usage-session-tombstone',
    });
  });
});

test('keeps a usage row whose session id the protocol refuses local and counted, even once deleted', async () => {
  await withStorePath(async (dbPath) => {
    const ordinary = usageRow();
    // The session id is embedded verbatim in the row key, so even the fact key cannot be hashed.
    const refused = usageRow(20, { sourceSessionId: `refused${nul}session` });
    const rows = [ordinary, refused];
    const assignments = rows.map((row) => ({ captureContext, rowKey: toSerializedMergeRow(row, machine).rowKey }));
    await Effect.runPromise(importLocalRows({ dbPath, importedAt: capturedAt, machine, rows }));
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(2);

    const input = {
      assignments,
      dbPath,
      deviceId,
      enqueuedAt: new Date('2026-08-30T11:04:00.000Z'),
      includeDeviceFact: false,
    };
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 1,
      unchanged: 0,
      unpublishable: 1,
    });
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 0,
      unchanged: 1,
      unpublishable: 1,
    });
    await Effect.runPromise(
      importLocalRows({
        dbPath,
        importedAt: new Date('2026-08-30T11:05:00.000Z'),
        machine,
        replication: { assignments, deviceId },
        rows: [usageRow(40), usageRow(40, { sourceSessionId: `refused${nul}session` })],
      }),
    );
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(2);
    expect(await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }))).toHaveLength(2);

    // A fact whose key never hashed was never published, so its deletion has nothing to tombstone:
    // the row stays counted rather than invented under another identity.
    const store = new Database(dbPath);
    try {
      store
        .query("UPDATE usage_rows SET status = 'deleted', updated_at = ? WHERE row_key = ?")
        .run('2026-08-30T11:06:00.000Z', toSerializedMergeRow(refused, machine).rowKey);
    } finally {
      store.close();
    }
    expect(
      await Effect.runPromise(
        backfillUsageReplicationOutbox({ ...input, enqueuedAt: new Date('2026-08-30T11:07:00.000Z') }),
      ),
    ).toEqual({ enqueued: 0, unchanged: 1, unpublishable: 1 });
    expect(await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }))).toHaveLength(2);
  });
});

test('publishes a row whose long session id pushes the local row key past the wire fact-key bound', async () => {
  await withStorePath(async (dbPath) => {
    // 500 ASCII characters fit the wire payload's session-id bound, while the composite local row
    // key exceeds 512 characters; the row key never travels, it is hashed into the fact key.
    const longSessionId = 'session-'.padEnd(500, 'x');
    const ordinary = usageRow();
    const long = usageRow(20, { sourceSessionId: longSessionId });
    const rows = [ordinary, long];
    const longRowKey = toSerializedMergeRow(long, machine).rowKey;
    expect(longRowKey.length).toBeGreaterThan(512);
    const assignments = rows.map((row) => ({ captureContext, rowKey: toSerializedMergeRow(row, machine).rowKey }));
    await Effect.runPromise(importLocalRows({ dbPath, importedAt: capturedAt, machine, rows }));
    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(2);

    const input = {
      assignments,
      dbPath,
      deviceId,
      enqueuedAt: new Date('2026-08-30T11:04:00.000Z'),
      includeDeviceFact: false,
    };
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 2,
      unchanged: 0,
      unpublishable: 0,
    });
    expect(await Effect.runPromise(backfillUsageReplicationOutbox(input))).toEqual({
      enqueued: 0,
      unchanged: 2,
      unpublishable: 0,
    });
    const history = await Effect.runPromise(listUsageReplicationOutboxHistory({ dbPath }));
    expect(history.map(({ changeKind }) => changeKind)).toEqual(['usage-session-upsert', 'usage-session-upsert']);
    expect(JSON.stringify(history)).not.toContain(longSessionId);

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: UsageReplicationCandidatePage = await Effect.runPromise(
        queryUsageReplicationCandidates({ afterRowKey: cursor, dbPath, maximumItems: 1 }),
      );
      walked.push(...page.rowKeys);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(walked.toSorted()).toEqual(assignments.map(({ rowKey }) => rowKey).toSorted());
    expect(walked).toContain(longRowKey);
  });
});

// Keys whose length differs between SQLite (characters, stopping at an embedded NUL) and
// JavaScript (UTF-16 units): each one sorts at position 500, the boundary of a 500-row page.
const boundarySessionIds = [
  ['3 000 astral characters', `session-0500${'😀'.repeat(3000)}`],
  ['a NUL followed by a long suffix', `session-0500${nul}${'x'.repeat(4200)}`],
] as const;

for (const [subject, boundarySessionId] of boundarySessionIds) {
  test(`walks candidate pages across a boundary key of ${subject} and counts it once per pass`, async () => {
    await withStorePath(async (dbPath) => {
      const sessionIds = [
        ...Array.from({ length: 499 }, (_, index) => `session-${String(index + 1).padStart(4, '0')}`),
        boundarySessionId,
        'session-0501',
      ];
      const rows = sessionIds.map((sourceSessionId) => usageRow(20, { sourceSessionId }));
      const boundaryRowKey = toSerializedMergeRow(usageRow(20, { sourceSessionId: boundarySessionId }), machine).rowKey;
      await Effect.runPromise(importLocalRows({ dbPath, importedAt: capturedAt, machine, rows }));
      expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(501);

      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const page: UsageReplicationCandidatePage = await Effect.runPromise(
          queryUsageReplicationCandidates({ afterRowKey: cursor, dbPath, maximumItems: 500 }),
        );
        pages.push([...page.rowKeys]);
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(pages.map((page) => page.length)).toEqual([500, 1]);
      expect(pages[0]?.at(-1)).toBe(boundaryRowKey);

      const backfillPages = async (enqueuedAt: Date) => {
        const totals = { enqueued: 0, unchanged: 0, unpublishable: 0 };
        for (const rowKeys of pages) {
          const result = await Effect.runPromise(
            backfillUsageReplicationOutbox({
              assignments: rowKeys.map((rowKey) => ({ captureContext, rowKey })),
              dbPath,
              deviceId,
              enqueuedAt,
              includeDeviceFact: false,
            }),
          );
          totals.enqueued += result.enqueued;
          totals.unchanged += result.unchanged;
          totals.unpublishable += result.unpublishable;
        }
        return totals;
      };
      expect(await backfillPages(new Date('2026-08-30T11:04:00.000Z'))).toEqual({
        enqueued: 500,
        unchanged: 0,
        unpublishable: 1,
      });
      expect(await backfillPages(new Date('2026-08-30T11:05:00.000Z'))).toEqual({
        enqueued: 0,
        unchanged: 500,
        unpublishable: 1,
      });
      expect(await Effect.runPromise(queryUsageReplicationOutboxStatus({ dbPath }))).toMatchObject({
        blocked: 0,
        pending: 500,
      });
    });
  });
}
