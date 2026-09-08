import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { memoryFingerprint } from '@ai-usage/memory-service/domain';
import {
  createCaptureContextId,
  createDeviceId,
  createMemoryItemId,
  createMemoryRevisionId,
  createPersonId,
  createSpaceId,
  type MemoryItemId,
  type PersonId,
  parseInstant,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import type { ReplicationBatch } from '@ai-usage/replication-protocol';
import { openLocalIdentityKernel } from './identity';
import { backfillLocalMemoryReplication, configureLocalMemoryReplication } from './replication';

// 20 entries x ~4 000 ASCII chars: each entry is within the 4 096-char Memory bound, while the
// replication payload (about 80 KiB) exceeds the 64 KiB protocol payload bound.
const oversizedGuidance = Array.from({ length: 20 }, (_, index) => `guidance ${index % 10} `.repeat(368).trim());

const openServiceFixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-replication-service-'));
  const databasePath = path.join(directory, 'memory.sqlite');
  const kernel = await openLocalIdentityKernel({ databasePath });
  const identity = await kernel.getBootstrapIdentity();
  let now = new Date('2026-08-30T09:00:00.000Z');
  const authorizer = createSingleUserAuthorizer({
    listKnownResources: async () =>
      (await kernel.memory.listAuthorizationResourceIds(identity.space.id)).map((id) => ({
        id,
        kind: 'memory' as const,
        spaceId: identity.space.id,
      })),
    localPersonId: identity.person.id,
    personalSpaceId: identity.space.id,
  });
  const service = createMemoryApplicationService(authorizer, kernel.memory, () => now);
  const authorization = { activeSpaceId: identity.space.id, trustedDevice: true } as const;
  const principal = { kind: 'person' as const, personId: identity.person.id };
  const captureContext = {
    deviceId: createDeviceId(),
    id: createCaptureContextId(),
    personId: createPersonId(),
    projectId: null,
    scmAccountId: null,
    scmInstallationId: null,
    source: 'personal-fallback' as const,
    spaceId: createSpaceId(),
  };
  const advance = (iso: string) => {
    now = new Date(iso);
  };
  const accept = async (title: string, guidance: readonly string[]) => {
    const evidence = { source: `synthetic evidence for ${title}` } as const;
    const observation = await service.recordObservation({
      authorization,
      captureContextId: null,
      content: evidence,
      fingerprint: memoryFingerprint(evidence),
      principal,
      projectId: null,
      sensitivity: 'normal',
      sourceKind: 'user',
      sourceLocator: `synthetic:${title}`,
    });
    if (observation.kind !== 'success') {
      throw new Error(`Observation for ${title} was not recorded.`);
    }
    const proposal = await service.createProposal({
      authorization,
      guidance,
      observationIds: [observation.value.id],
      principal,
      projectId: null,
      proposedKind: 'decision',
      sensitivity: 'normal',
      structuredContent: { synthetic: true },
      summary: `${title} summary.`,
      title,
      trustCandidate: 'explicit',
    });
    if (proposal.kind !== 'success') {
      throw new Error(`Proposal for ${title} was not created.`);
    }
    return service.acceptProposal({
      authorization,
      principal,
      proposalId: proposal.value,
      scope: 'space',
      spaceId: identity.space.id,
    });
  };
  const configure = (configuredAt: string) =>
    kernel.configureReplication({
      captureContext,
      configuredAt: new Date(configuredAt),
      localProjectId: null,
      localSpaceId: identity.space.id,
    });
  const acknowledgeAll = () => {
    const claimed = kernel.replication.claimReady({ maximumEvents: 100, now: parseInstant(now.toISOString()) });
    if (!claimed) {
      throw new Error('Expected a claimable Memory batch.');
    }
    const batch: ReplicationBatch = claimed.batch;
    kernel.replication.acknowledge(batch, {
      acceptedThroughGeneration: batch.toGenerationInclusive,
      appliedAt: parseInstant(now.toISOString()),
      appliedBatchId: batch.batchId,
      appliedEventIds: batch.events.map(({ eventId }) => eventId),
      counts: { applied: batch.events.length, duplicate: 0, projected: batch.events.length, tombstoned: 0 },
      deviceId: batch.deviceId,
      protocolVersion: 1,
      streamId: batch.streamId,
      warnings: [],
    });
  };
  const auditRows = (action: string) => {
    const database = new Database(databasePath, { readonly: true, strict: true });
    try {
      return database
        .query(
          `SELECT actor_kind, result, subject_id, subject_type
           FROM memory_audit_events WHERE action = $action ORDER BY recorded_at`,
        )
        .all({ action });
    } finally {
      database.close(false);
    }
  };
  const close = async () => {
    await kernel.close();
    await rm(directory, { force: true, recursive: true });
  };
  return { accept, acknowledgeAll, advance, auditRows, authorization, close, configure, kernel, principal, service };
};

const seedSupersededItem = (database: Database, spaceId: SpaceId, personId: PersonId): MemoryItemId => {
  const itemId = createMemoryItemId();
  const revisionId = createMemoryRevisionId();
  const seed = database.transaction(() => {
    database
      .query(
        `INSERT INTO memory_items
           (id, space_id, project_id, scope, kind, status, trust, sensitivity, current_revision_id)
         VALUES ($id, $spaceId, NULL, 'space', 'decision', 'superseded', 'explicit', 'normal', $revisionId)`,
      )
      .run({ id: itemId, revisionId, spaceId });
    database
      .query(
        `INSERT INTO memory_revisions
           (id, memory_item_id, space_id, revision_number, title, summary, guidance_json,
            structured_content_json, created_by_kind, created_by_id, created_at, reason)
         VALUES ($id, $itemId, $spaceId, 1, 'Superseded decision', 'Replaced by a later decision.',
                 '["Prefer the newer decision."]', '{"superseded":true}', 'person', $personId,
                 '2026-08-29T12:00:00.000Z', NULL)`,
      )
      .run({ id: revisionId, itemId, personId, spaceId });
  });
  seed.immediate();
  return itemId;
};

describe('local Memory replication backfill', () => {
  test('enqueues a supersession tombstone once, regardless of when replication is configured again', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-replication-'));
    const databasePath = path.join(directory, 'memory.sqlite');
    const kernel = await openLocalIdentityKernel({ databasePath });
    const identity = await kernel.getBootstrapIdentity();
    await kernel.close();
    const database = new Database(databasePath, { strict: true });
    database.exec('PRAGMA foreign_keys = ON');
    try {
      const itemId = seedSupersededItem(database, identity.space.id, identity.person.id);
      const input = {
        captureContext: {
          deviceId: createDeviceId(),
          id: createCaptureContextId(),
          personId: createPersonId(),
          projectId: null,
          scmAccountId: null,
          scmInstallationId: null,
          source: 'personal-fallback' as const,
          spaceId: createSpaceId(),
        },
        localProjectId: null,
        localSpaceId: identity.space.id,
      };
      expect(
        configureLocalMemoryReplication(database, { ...input, configuredAt: new Date('2026-08-30T09:00:00.000Z') }),
      ).toEqual({ backfilled: 1, nextCursor: null, oversized: 0, unchanged: 0 });
      expect(
        configureLocalMemoryReplication(database, { ...input, configuredAt: new Date('2026-08-30T10:00:00.000Z') }),
      ).toEqual({ backfilled: 0, nextCursor: null, oversized: 0, unchanged: 1 });
      expect(
        backfillLocalMemoryReplication(database, { ...input, enqueuedAt: new Date('2026-08-30T11:00:00.000Z') }),
      ).toEqual({ backfilled: 0, nextCursor: null, oversized: 0, unchanged: 1 });
      expect(
        database
          .query('SELECT change_kind, fact_key, generation, state FROM replication_outbox_events ORDER BY generation')
          .all(),
      ).toEqual([
        { change_kind: 'memory-fact-tombstone', fact_key: `memory-item:${itemId}`, generation: 1, state: 'pending' },
      ]);
      expect(database.query('SELECT next_generation FROM replication_outbox_state WHERE singleton = 1').get()).toEqual({
        next_generation: 2,
      });
    } finally {
      database.close(false);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('counts a fact the live path already published as unchanged when replication is configured again', async () => {
    const fixture = await openServiceFixture();
    try {
      expect(await fixture.configure('2026-08-30T09:00:00.000Z')).toEqual({
        backfilled: 0,
        nextCursor: null,
        oversized: 0,
        unchanged: 0,
      });
      fixture.advance('2026-08-30T09:10:00.000Z');
      const accepted = await fixture.accept('Live accepted decision', ['Publish through the live path.']);
      expect(accepted.kind).toBe('success');
      expect(fixture.kernel.replication.status()).toMatchObject({ pending: 1 });
      fixture.acknowledgeAll();
      expect(fixture.kernel.replication.status()).toMatchObject({ acknowledged: 1, pending: 0 });

      expect(await fixture.configure('2026-08-30T10:00:00.000Z')).toEqual({
        backfilled: 0,
        nextCursor: null,
        oversized: 0,
        unchanged: 1,
      });
      expect(fixture.kernel.replication.listHistory()).toHaveLength(1);
      expect(fixture.kernel.replication.status()).toMatchObject({ acknowledged: 1, pending: 0 });
    } finally {
      await fixture.close();
    }
  });

  test('publishes a revision once whether the live path or the backfill sees it first', async () => {
    const fixture = await openServiceFixture();
    try {
      const accepted = await fixture.accept('Revised decision', ['Initial guidance.']);
      if (accepted.kind !== 'success') {
        throw new Error('Synthetic acceptance failed.');
      }
      expect(await fixture.configure('2026-08-30T09:30:00.000Z')).toEqual({
        backfilled: 1,
        nextCursor: null,
        oversized: 0,
        unchanged: 0,
      });
      fixture.advance('2026-08-30T09:40:00.000Z');
      const revised = await fixture.service.reviseMemoryItem({
        authorization: fixture.authorization,
        expectedCurrentRevisionId: accepted.value.revision.id,
        guidance: ['Revised guidance.'],
        itemId: accepted.value.item.id,
        principal: fixture.principal,
        reason: 'Clarify the guidance.',
        spaceId: accepted.value.item.owningSpaceId,
        structuredContent: { revised: true, synthetic: true },
        summary: 'Revised summary.',
        title: 'Revised decision',
      });
      expect(revised.kind).toBe('success');
      const afterRevision = fixture.kernel.replication.listHistory();
      expect(afterRevision).toHaveLength(2);
      expect(new Set(afterRevision.map(({ contentHash }) => contentHash)).size).toBe(2);
      expect(new Set(afterRevision.map(({ factKey }) => factKey)).size).toBe(1);

      expect(await fixture.configure('2026-08-30T10:00:00.000Z')).toEqual({
        backfilled: 0,
        nextCursor: null,
        oversized: 0,
        unchanged: 1,
      });
      expect(fixture.kernel.replication.listHistory()).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  test('accepts an oversized normal item locally, records the skipped publication, and keeps publishing others', async () => {
    const fixture = await openServiceFixture();
    try {
      await fixture.configure('2026-08-30T09:00:00.000Z');
      fixture.advance('2026-08-30T09:10:00.000Z');
      const oversized = await fixture.accept('Oversized decision', oversizedGuidance);
      expect(oversized.kind).toBe('success');
      if (oversized.kind !== 'success') {
        throw new Error('Oversized acceptance failed.');
      }
      expect(fixture.kernel.replication.status()).toMatchObject({ pending: 0 });
      expect(fixture.auditRows('replication-skipped-oversized')).toEqual([
        {
          actor_kind: 'person',
          result: 'rejected',
          subject_id: oversized.value.item.id,
          subject_type: 'memory-item',
        },
      ]);

      fixture.advance('2026-08-30T09:20:00.000Z');
      const regular = await fixture.accept('Regular decision', ['Publish normally.']);
      if (regular.kind !== 'success') {
        throw new Error('Regular acceptance failed.');
      }
      expect(fixture.kernel.replication.status()).toMatchObject({ pending: 1 });
      expect(fixture.kernel.replication.listHistory()[0]).toMatchObject({
        changeKind: 'memory-item-revision-upsert',
        factKey: `memory-item:${regular.value.item.id}`,
      });
    } finally {
      await fixture.close();
    }
  });

  test('configures replication over a stored oversized item without blocking the stream', async () => {
    const fixture = await openServiceFixture();
    try {
      const oversized = await fixture.accept('Stored oversized decision', oversizedGuidance);
      expect(oversized.kind).toBe('success');
      expect(await fixture.configure('2026-08-30T09:30:00.000Z')).toEqual({
        backfilled: 0,
        nextCursor: null,
        oversized: 1,
        unchanged: 0,
      });
      expect(fixture.kernel.replication.status()).toMatchObject({ pending: 0, streamId: 'memory-v1' });
      expect(fixture.auditRows('replication-skipped-oversized')).toEqual([]);
      expect(await fixture.configure('2026-08-30T10:00:00.000Z')).toEqual({
        backfilled: 0,
        nextCursor: null,
        oversized: 1,
        unchanged: 0,
      });
    } finally {
      await fixture.close();
    }
  });
});
