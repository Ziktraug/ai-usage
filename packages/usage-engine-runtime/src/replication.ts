import type { ReplicationWorkerOutboxPort } from '@ai-usage/replication-outbox/worker';
import type { CaptureContextSnapshot } from '@ai-usage/replication-protocol';
import {
  acknowledgeUsageReplicationBatch,
  backfillUsageReplicationOutbox,
  blockUsageReplicationBatch,
  claimUsageReplicationBatch,
  initializeUsageReplicationOutbox,
  queryUsageReplicationCandidates,
  queryUsageReplicationOutboxStatus,
  recoverUsageReplicationInFlight,
  retryUsageReplicationBatch,
  type UsageReplicationCandidatePage,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';

export interface BackfillUsageReplicationPagesInput {
  readonly afterRowKey?: string | null;
  readonly captureContext: CaptureContextSnapshot;
  readonly dbPath: string;
  readonly enqueuedAt?: Date;
  readonly maximumPages?: number;
  readonly pageSize?: number;
}

export interface BackfillUsageReplicationPagesResult {
  readonly enqueued: number;
  readonly nextCursor: string | null;
  readonly pages: number;
  readonly scanned: number;
  readonly truncated: boolean;
  readonly unchanged: number;
}

export const backfillUsageReplicationPages = async (
  input: BackfillUsageReplicationPagesInput,
): Promise<BackfillUsageReplicationPagesResult> => {
  const maximumPages = input.maximumPages ?? 20;
  const pageSize = input.pageSize ?? 500;
  if (
    !Number.isSafeInteger(maximumPages) ||
    maximumPages <= 0 ||
    maximumPages > 100 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > 1000
  ) {
    throw new Error('Usage replication backfill bounds are invalid.');
  }
  let cursor: string | null = input.afterRowKey ?? null;
  let enqueued = 0;
  let pages = 0;
  let scanned = 0;
  let unchanged = 0;
  do {
    const page: UsageReplicationCandidatePage = await Effect.runPromise(
      queryUsageReplicationCandidates({ afterRowKey: cursor, dbPath: input.dbPath, maximumItems: pageSize }),
    );
    if (page.rowKeys.length === 0) {
      return { enqueued, nextCursor: null, pages, scanned, truncated: false, unchanged };
    }
    const result = await Effect.runPromise(
      backfillUsageReplicationOutbox({
        assignments: page.rowKeys.map((rowKey: string) => ({ captureContext: input.captureContext, rowKey })),
        dbPath: input.dbPath,
        deviceId: input.captureContext.deviceId,
        includeDeviceFact: cursor === null,
        ...(input.enqueuedAt === undefined ? {} : { enqueuedAt: input.enqueuedAt }),
      }),
    );
    enqueued += result.enqueued;
    unchanged += result.unchanged;
    scanned += page.rowKeys.length;
    pages += 1;
    cursor = page.nextCursor;
    if (cursor === null) {
      return { enqueued, nextCursor: null, pages, scanned, truncated: false, unchanged };
    }
  } while (pages < maximumPages);
  return { enqueued, nextCursor: cursor, pages, scanned, truncated: true, unchanged };
};

export const createUsageReplicationOutboxPort = (dbPath: string): ReplicationWorkerOutboxPort => ({
  acknowledge: async (batch, ack) => {
    await Effect.runPromise(acknowledgeUsageReplicationBatch({ ack, batch, dbPath }));
  },
  block: async (input) => {
    await Effect.runPromise(
      blockUsageReplicationBatch({
        batch: input.batch,
        dbPath,
        errorCode: input.errorCode,
        now: new Date(input.now),
      }),
    );
  },
  claimReady: (input) =>
    Effect.runPromise(
      claimUsageReplicationBatch({
        dbPath,
        maximumEvents: input.maximumEvents,
        now: new Date(input.now),
      }),
    ),
  retry: (input) =>
    Effect.runPromise(
      retryUsageReplicationBatch({
        batch: input.batch,
        dbPath,
        errorCode: input.errorCode,
        now: new Date(input.now),
        ...(input.random === undefined ? {} : { random: input.random }),
        ...(input.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: input.retryAfterSeconds }),
      }),
    ),
  status: () => Effect.runPromise(queryUsageReplicationOutboxStatus({ dbPath })),
});

export const initializeUsageReplicationWorker = async (
  dbPath: string,
  deviceId: CaptureContextSnapshot['deviceId'],
  createdAt?: Date,
): Promise<void> => {
  await Effect.runPromise(
    initializeUsageReplicationOutbox({ dbPath, deviceId, ...(createdAt === undefined ? {} : { createdAt }) }),
  );
};

export const recoverUsageReplicationWorker = async (dbPath: string, recoveredAt?: Date): Promise<number> =>
  await Effect.runPromise(
    recoverUsageReplicationInFlight({ dbPath, ...(recoveredAt === undefined ? {} : { recoveredAt }) }),
  );
