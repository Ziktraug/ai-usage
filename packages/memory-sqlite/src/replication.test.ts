import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCaptureContextId,
  createDeviceId,
  createMemoryItemId,
  createMemoryRevisionId,
  createPersonId,
  createSpaceId,
  type MemoryItemId,
  type PersonId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import { openLocalIdentityKernel } from './identity';
import { backfillLocalMemoryReplication, configureLocalMemoryReplication } from './replication';

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
      ).toEqual({ backfilled: 1, nextCursor: null, unchanged: 0 });
      expect(
        configureLocalMemoryReplication(database, { ...input, configuredAt: new Date('2026-08-30T10:00:00.000Z') }),
      ).toEqual({ backfilled: 0, nextCursor: null, unchanged: 1 });
      expect(
        backfillLocalMemoryReplication(database, { ...input, enqueuedAt: new Date('2026-08-30T11:00:00.000Z') }),
      ).toEqual({ backfilled: 0, nextCursor: null, unchanged: 1 });
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
});
