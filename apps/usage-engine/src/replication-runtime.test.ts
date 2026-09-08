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
import { parseReplicationEventId, type ReplicationBatch } from '@ai-usage/replication-protocol';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { importLocalRows } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
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

const acknowledgingClient = (published: Array<{ readonly kinds: string[]; readonly streamId: string }>) => {
  const client: HttpReplicationClient = {
    publish: (batch: ReplicationBatch) => {
      published.push({ kinds: batch.events.map(({ changeKind }) => changeKind), streamId: batch.streamId });
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
        kind: 'ack' as const,
      });
    },
    resolveDevice: () => Promise.resolve(resolvedDevice),
  };
  return client;
};

const localUsageRow = (model: string, sourceSessionId: string) => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: actualCost(null),
    date: new Date('2026-08-30T16:30:00.000Z'),
    durationMs: 1000,
    endDate: new Date('2026-08-30T16:31:00.000Z'),
    harness: 'Codex',
    model,
    name: `Session ${sourceSessionId}`,
    project: '/local/project/never-publish',
    provider: 'OpenAI',
    tokens: { cr: 0, cw: 0, in: 10, out: 20 },
  }),
  source: { harnessKey: 'codex' as const, sourceSessionId },
});

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

  // Built at runtime so no editor or formatter can flatten the NUL byte into whitespace.
  const nul = String.fromCharCode(0);

  const refusedRows = [
    ['a usage row the protocol refuses', localUsageRow(`gpt-5${nul}`, 'refused-session')],
    ['a usage row with a refused session id', localUsageRow('gpt-5', `refused${nul}session`)],
  ] as const;
  for (const [subject, refusedRow] of refusedRows) {
    test(`publishes ordinary usage and Memory facts while ${subject} stays local`, async () => {
      await withKernel(async ({ kernel, usageDatabasePath }) => {
        await Effect.runPromise(
          importLocalRows({
            dbPath: usageDatabasePath,
            importedAt: new Date(occurredAt),
            machine: { id: 'machine-runtime', label: 'Runtime workstation' },
            rows: [localUsageRow('gpt-5', 'ordinary-session'), refusedRow],
          }),
        );
        const published: Array<{ readonly kinds: string[]; readonly streamId: string }> = [];
        const runtime = startDeviceReplicationRuntime({
          acquireClient: () => Promise.resolve(acknowledgingClient(published)),
          clock: () => new Date(occurredAt),
          kernel,
          usageDatabasePath,
        });
        await runtime.runNow();
        expect(runtime.status().lastDiagnostic?.code).not.toBe('setup-failed');
        expect(published).toEqual([{ kinds: ['device-fact-upsert', 'usage-session-upsert'], streamId: 'usage-v1' }]);
        expect(runtime.status().usage).toMatchObject({ acknowledged: 2, blocked: 0, pending: 0 });

        kernel.replication.enqueue({
          captureContext: defaultReplicationCaptureContext(resolvedDevice),
          changeKind: 'memory-fact-tombstone',
          enqueuedAt: occurredAt,
          eventId: parseReplicationEventId('70000000-0000-4000-8000-000000000007'),
          factKey: 'memory-item:70000000-0000-4000-8000-000000000008',
          payload: {
            itemId: parseMemoryItemId('70000000-0000-4000-8000-000000000008'),
            kind: 'memory-fact-tombstone',
            reasonCode: 'privacy-purged',
            tombstonedAt: occurredAt,
          },
        });
        await runtime.runNow();
        expect(published.map(({ streamId }) => streamId)).toEqual(['usage-v1', 'memory-v1']);
        expect(runtime.status().lastDiagnostic?.code).not.toBe('setup-failed');
        expect(kernel.replication.status()).toMatchObject({ acknowledged: 1, pending: 0 });
        await runtime.dispose();
      });
    });
  }

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
