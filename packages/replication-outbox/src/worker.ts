import type { Instant } from '@ai-usage/platform-core/identity';
import { instantNow } from '@ai-usage/platform-core/identity';
import type { ReplicationAck, ReplicationBatch, ReplicationProblem } from '@ai-usage/replication-protocol';
import type {
  ClaimedReplicationBatch,
  ClaimReplicationBatchInput,
  FailReplicationBatchInput,
  ReplicationOutboxStatus,
} from '.';

export interface ReplicationWorkerOutboxPort {
  readonly acknowledge: (batch: ReplicationBatch, ack: ReplicationAck) => Promise<void>;
  readonly block: (input: Omit<FailReplicationBatchInput, 'random' | 'retryAfterSeconds'>) => Promise<void>;
  readonly claimReady: (input: ClaimReplicationBatchInput) => Promise<ClaimedReplicationBatch | null>;
  readonly retry: (input: FailReplicationBatchInput) => Promise<Instant>;
  readonly status: () => Promise<ReplicationOutboxStatus>;
}

export type ReplicationTransportResult =
  | { readonly ack: ReplicationAck; readonly kind: 'ack' }
  | { readonly kind: 'problem'; readonly problem: ReplicationProblem };

export interface ReplicationTransport {
  readonly publish: (batch: ReplicationBatch, signal?: AbortSignal) => Promise<ReplicationTransportResult>;
}

export interface RunReplicationWorkerCycleInput {
  readonly clock?: () => Date;
  readonly maximumEvents?: number;
  readonly outbox: ReplicationWorkerOutboxPort;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly transport: ReplicationTransport;
}

export type ReplicationWorkerCycleResult =
  | { readonly kind: 'acknowledged'; readonly publishedEvents: number; readonly status: ReplicationOutboxStatus }
  | { readonly kind: 'blocked'; readonly reason: string; readonly status: ReplicationOutboxStatus }
  | { readonly kind: 'idle'; readonly status: ReplicationOutboxStatus }
  | {
      readonly kind: 'retry-scheduled';
      readonly reason: string;
      readonly retryAt: Instant;
      readonly status: ReplicationOutboxStatus;
    };

const retryableProblems = new Set<ReplicationProblem['code']>(['rate-limited', 'server-unavailable']);

const safeStatus = (outbox: ReplicationWorkerOutboxPort): Promise<ReplicationOutboxStatus> => outbox.status();

export const runReplicationWorkerCycle = async (
  input: RunReplicationWorkerCycleInput,
): Promise<ReplicationWorkerCycleResult> => {
  const now = instantNow(input.clock);
  if (input.signal?.aborted) {
    return { kind: 'idle', status: await safeStatus(input.outbox) };
  }
  const claim = await input.outbox.claimReady({ maximumEvents: input.maximumEvents ?? 100, now });
  if (!claim) {
    return { kind: 'idle', status: await safeStatus(input.outbox) };
  }
  let result: ReplicationTransportResult;
  try {
    result = await input.transport.publish(claim.batch, input.signal);
  } catch {
    const retryAt = await input.outbox.retry({
      batch: claim.batch,
      errorCode: input.signal?.aborted ? 'cancelled' : 'unreachable',
      now,
      ...(input.random === undefined ? {} : { random: input.random }),
    });
    return {
      kind: 'retry-scheduled',
      reason: input.signal?.aborted ? 'cancelled' : 'unreachable',
      retryAt,
      status: await safeStatus(input.outbox),
    };
  }
  if (result.kind === 'ack') {
    await input.outbox.acknowledge(claim.batch, result.ack);
    return {
      kind: 'acknowledged',
      publishedEvents: claim.eventIds.length,
      status: await safeStatus(input.outbox),
    };
  }
  if (retryableProblems.has(result.problem.code)) {
    const retryAt = await input.outbox.retry({
      batch: claim.batch,
      errorCode: result.problem.code,
      now,
      ...(input.random === undefined ? {} : { random: input.random }),
      ...(result.problem.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.problem.retryAfterSeconds }),
    });
    return {
      kind: 'retry-scheduled',
      reason: result.problem.code,
      retryAt,
      status: await safeStatus(input.outbox),
    };
  }
  await input.outbox.block({ batch: claim.batch, errorCode: result.problem.code, now });
  return {
    kind: 'blocked',
    reason: result.problem.code,
    status: await safeStatus(input.outbox),
  };
};
