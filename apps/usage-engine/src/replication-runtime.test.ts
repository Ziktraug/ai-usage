import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import {
  parseDeviceCredentialId,
  parseDeviceId,
  parseInstant,
  parseMemoryItemId,
  parsePersonId,
  parseSpaceId,
} from '@ai-usage/platform-core/identity';
import type { HttpReplicationClient } from '@ai-usage/replication-client';
import { parseReplicationEventId } from '@ai-usage/replication-protocol';
import {
  defaultReplicationCaptureContext,
  deviceReplicationStatusOutput,
  localOnlyReplicationStatus,
  startDeviceReplicationRuntime,
} from './replication-runtime';

const sharedDeviceId = parseDeviceId('70000000-0000-4000-8000-000000000001');
const sharedPersonId = parsePersonId('70000000-0000-4000-8000-000000000002');
const sharedSpaceId = parseSpaceId('70000000-0000-4000-8000-000000000003');
const occurredAt = parseInstant('2026-08-30T17:00:00.000Z');

const resolvedDevice = {
  kind: 'resolved' as const,
  value: {
    credential: {
      createdAt: occurredAt,
      deviceId: sharedDeviceId,
      id: parseDeviceCredentialId('70000000-0000-4000-8000-000000000004'),
      keyVersion: 1,
      lastUsedAt: occurredAt,
      revokedAt: null,
      rotatedAt: null,
    },
    device: {
      id: sharedDeviceId,
      label: 'Connected workstation',
      lastSeenAt: occurredAt,
      ownerPersonId: sharedPersonId,
      owningSpaceId: sharedSpaceId,
      status: 'active' as const,
    },
  },
};

const withKernel = async (
  run: (input: {
    readonly directory: string;
    readonly kernel: Awaited<ReturnType<typeof openLocalIdentityKernel>>;
    readonly usageDatabasePath: string;
  }) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-replication-runtime-'));
  const kernel = await openLocalIdentityKernel({ databasePath: path.join(directory, 'memory.sqlite') });
  try {
    await run({ directory, kernel, usageDatabasePath: path.join(directory, 'usage.sqlite') });
  } finally {
    await kernel.close();
    await rm(directory, { force: true, recursive: true });
  }
};

describe('usage-engine Device replication runtime', () => {
  test('maps disabled and connected runtime state into the closed control contract', () => {
    expect(localOnlyReplicationStatus()).toEqual({
      kind: 'replication-status',
      lastDiagnostic: null,
      memory: null,
      mode: 'local-only',
      runtimeState: 'disabled',
      usage: null,
    });
    expect(
      deviceReplicationStatusOutput({
        lastDiagnostic: { code: 'credential-missing' },
        memory: null,
        state: 'waiting',
        usage: null,
      }),
    ).toEqual({
      kind: 'replication-status',
      lastDiagnostic: { code: 'credential-missing', problemCode: null, streamId: null },
      memory: null,
      mode: 'connected',
      runtimeState: 'waiting',
      usage: null,
    });
  });

  test('keeps the local authorities usable when the platform is unreachable', async () => {
    await withKernel(async ({ kernel, usageDatabasePath }) => {
      const diagnostics: string[] = [];
      const client: HttpReplicationClient = {
        publish: () => Promise.reject(new Error('unused')),
        resolveDevice: () => Promise.reject(new Error('platform unavailable')),
      };
      const runtime = startDeviceReplicationRuntime({
        acquireClient: () => Promise.resolve(client),
        kernel,
        reportDiagnostic: ({ code }) => diagnostics.push(code),
        usageDatabasePath,
      });

      await runtime.runNow();
      expect((await kernel.getBootstrapIdentity()).space.kind).toBe('personal');
      expect(runtime.status()).toMatchObject({
        lastDiagnostic: { code: 'device-unreachable' },
        state: 'waiting',
      });
      expect(diagnostics).toEqual(['device-unreachable']);
      await runtime.dispose();
    });
  });

  test('publishes a ready local stream through the outbound client and applies its durable ACK', async () => {
    await withKernel(async ({ kernel, usageDatabasePath }) => {
      const publishedStreams: string[] = [];
      const client: HttpReplicationClient = {
        publish: (batch) => {
          publishedStreams.push(batch.streamId);
          return Promise.resolve({
            ack: {
              acceptedThroughGeneration: batch.toGenerationInclusive,
              appliedAt: occurredAt,
              appliedBatchId: batch.batchId,
              appliedEventIds: batch.events.map(({ eventId }) => eventId),
              counts: {
                applied: batch.events.length,
                duplicate: 0,
                projected: batch.events.length,
                tombstoned: batch.events.filter(({ changeKind }) => changeKind.endsWith('tombstone')).length,
              },
              deviceId: batch.deviceId,
              protocolVersion: 1,
              streamId: batch.streamId,
              warnings: [],
            },
            kind: 'ack',
          });
        },
        resolveDevice: () => Promise.resolve(resolvedDevice),
      };
      const runtime = startDeviceReplicationRuntime({
        acquireClient: () => Promise.resolve(client),
        clock: () => new Date(occurredAt),
        kernel,
        usageDatabasePath,
      });
      await runtime.runNow();

      const captureContext = defaultReplicationCaptureContext(resolvedDevice);
      const configuredEvent = kernel.replication.enqueue({
        captureContext,
        changeKind: 'memory-fact-tombstone',
        enqueuedAt: occurredAt,
        eventId: parseReplicationEventId('70000000-0000-4000-8000-000000000005'),
        factKey: 'memory-item:70000000-0000-4000-8000-000000000006',
        payload: {
          itemId: parseMemoryItemId('70000000-0000-4000-8000-000000000006'),
          kind: 'memory-fact-tombstone',
          reasonCode: 'privacy-purged',
          tombstonedAt: occurredAt,
        },
      });
      expect(configuredEvent.captureContext).toEqual(captureContext);

      await runtime.runNow();
      expect(publishedStreams).toEqual(['memory-v1']);
      expect(kernel.replication.status()).toMatchObject({ acknowledged: 1, pending: 0 });
      await runtime.dispose();
    });
  });

  test('aborts an active outbound identity request before the local kernel closes', async () => {
    await withKernel(async ({ kernel, usageDatabasePath }) => {
      let startedResolve: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      let observedAbort = false;
      const client: HttpReplicationClient = {
        publish: () => Promise.reject(new Error('unused')),
        resolveDevice: (signal) =>
          new Promise((_, reject) => {
            startedResolve?.();
            signal?.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      };
      const runtime = startDeviceReplicationRuntime({
        acquireClient: () => Promise.resolve(client),
        kernel,
        usageDatabasePath,
      });
      await started;
      await runtime.dispose();

      expect(observedAbort).toBeTrue();
      expect(runtime.status().state).toBe('disposed');
    });
  });
});
