import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthorizedResourceScope } from '@ai-usage/authorization/scope-internal';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import {
  activeMemorySearchEvaluationCases,
  activeMemorySearchEvaluationDocuments,
  memorySearchEvaluationDocuments,
  memorySearchEvaluationIdentities,
} from '@ai-usage/memory-search/evaluation';
import { seedMemorySearchEvaluationCorpus } from '@ai-usage/memory-search/evaluation-harness';
import {
  type MemorySearchEvaluationObservation,
  summarizeMemorySearchEvaluation,
} from '@ai-usage/memory-search/evaluation-metrics';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { normalizeMemorySearchParameters } from '@ai-usage/memory-service/search';
import { createProjectId } from '@ai-usage/platform-core/identity';
import { openLocalIdentityKernel } from './identity';
import { rebuildSqliteMemorySearchProjection } from './memory';

const evaluationNow = new Date('2026-08-30T10:10:00.000Z');

const openEvaluationFixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-search-'));
  const databasePath = path.join(directory, 'memory.sqlite');
  const kernel = await openLocalIdentityKernel({ databasePath });
  const identity = await kernel.getBootstrapIdentity();
  const projectId = createProjectId();
  await kernel.createProject({
    displayName: 'Memory search evaluation',
    id: projectId,
    kind: 'local',
    owningSpaceId: identity.space.id,
    repositoryId: null,
    repositorySubpath: null,
    status: 'active',
  });
  const authorizedDocuments = activeMemorySearchEvaluationDocuments.filter(
    (document) => document.spaceId === memorySearchEvaluationIdentities.authorizedSpaceId,
  );
  const items = await seedMemorySearchEvaluationCorpus({
    documents: authorizedDocuments,
    personId: identity.person.id,
    projectId,
    repository: kernel.memory,
    spaceId: identity.space.id,
  });
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
  const service = createMemoryApplicationService(authorizer, kernel.memory, () => evaluationNow);
  return {
    authorization: { activeSpaceId: identity.space.id, trustedDevice: true } as const,
    close: async () => {
      await kernel.close();
      await rm(directory, { force: true, recursive: true });
    },
    databasePath,
    identity,
    items,
    kernel,
    principal: { kind: 'person' as const, personId: identity.person.id },
    projectId,
    service,
  };
};

describe('SQLite FTS5 Memory search', () => {
  test('runs the committed evaluation cases through the application authorization boundary', async () => {
    const fixture = await openEvaluationFixture();
    try {
      const observations: MemorySearchEvaluationObservation[] = [];
      for (const evaluationCase of activeMemorySearchEvaluationCases) {
        const startedAt = performance.now();
        const result = await fixture.service.searchMemory({
          authorization: fixture.authorization,
          ...(evaluationCase.historyMode === undefined ? {} : { historyMode: evaluationCase.historyMode }),
          includeSpaceWide: evaluationCase.class === 'scope-precedence',
          limit: 10,
          ...(evaluationCase.matchingMode === undefined ? {} : { matchingMode: evaluationCase.matchingMode }),
          principal: fixture.principal,
          ...(evaluationCase.projectId === undefined ? {} : { projectId: fixture.projectId }),
          query: evaluationCase.query,
          spaceId: fixture.identity.space.id,
          ...(evaluationCase.statuses === undefined ? {} : { statuses: evaluationCase.statuses }),
        });
        expect(result.kind, evaluationCase.id).toBe('success');
        if (result.kind !== 'success') {
          continue;
        }
        const returnedIds = result.value.items.map((item) => item.id);
        observations.push({
          caseId: evaluationCase.id,
          durationMs: performance.now() - startedAt,
          responseBytes: Buffer.byteLength(JSON.stringify(result.value), 'utf8'),
          returnedIds,
        });
        for (const forbiddenId of evaluationCase.forbiddenIds) {
          expect(returnedIds, `${evaluationCase.id}: forbidden`).not.toContain(forbiddenId);
        }
        if (evaluationCase.noAnswer) {
          expect(returnedIds, `${evaluationCase.id}: no answer`).toEqual([]);
          continue;
        }
        if (evaluationCase.class === 'semantic-paraphrase') {
          expect(returnedIds, `${evaluationCase.id}: lexical gate fixture`).toEqual([]);
          continue;
        }
        const expectedId = evaluationCase.expectedIds[0];
        if (!expectedId) {
          throw new Error(`Evaluation case ${evaluationCase.id} has no expected ID.`);
        }
        expect(returnedIds, `${evaluationCase.id}: expected`).toContain(expectedId);
        const expected = result.value.items.find((item) => item.id === expectedId);
        if (evaluationCase.requiredStatus) {
          expect(expected?.status, `${evaluationCase.id}: status`).toBe(evaluationCase.requiredStatus);
        }
        if (evaluationCase.requiredTrust) {
          expect(expected?.trust, `${evaluationCase.id}: trust`).toBe(evaluationCase.requiredTrust);
        }
        expect(expected?.matchedBecause.length, `${evaluationCase.id}: explanation`).toBeGreaterThan(0);
        expect(expected?.provenance, `${evaluationCase.id}: provenance`).toHaveLength(1);
      }
      const report = summarizeMemorySearchEvaluation({
        adapter: 'sqlite-fts5',
        authorizationNoLeakPassed: true,
        cases: activeMemorySearchEvaluationCases,
        observations,
      });
      if (process.env.AI_USAGE_PRINT_MEMORY_SEARCH_METRICS === '1') {
        process.stdout.write(`MEMORY_SEARCH_METRICS ${JSON.stringify(report)}\n`);
      }
      expect(report.aggregate).toMatchObject({ falsePositiveRate: 0, recallAt10: 0.888_889 });
      expect(report.aggregate.latencyMs.maximum).toBeLessThan(2000);
      expect(report.vectorGate).toMatchObject({
        failures: ['semantic-fact-publication'],
        shouldAddPgvector: false,
      });
    } finally {
      await fixture.close();
    }
  });

  test('binds cursors to the exact authorized order and invalidates changed authorized content', async () => {
    const fixture = await openEvaluationFixture();
    try {
      const first = await fixture.service.searchMemory({
        authorization: fixture.authorization,
        limit: 1,
        principal: fixture.principal,
        query: 'accepted search memory guidance command',
        spaceId: fixture.identity.space.id,
      });
      expect(first).toMatchObject({ kind: 'success', value: { items: [{}] } });
      if (first.kind !== 'success' || first.value.nextCursor === null) {
        throw new Error('Synthetic search did not produce a cursor.');
      }
      const second = await fixture.service.searchMemory({
        authorization: fixture.authorization,
        cursor: first.value.nextCursor,
        limit: 1,
        principal: fixture.principal,
        query: 'accepted search memory guidance command',
        spaceId: fixture.identity.space.id,
      });
      expect(second).toMatchObject({ kind: 'success', value: { items: [{}] } });

      const changedItem = first.value.items[0];
      if (!changedItem) {
        throw new Error('Synthetic first search item is missing.');
      }
      expect(
        await fixture.service.supersedeMemoryItem({
          authorization: fixture.authorization,
          itemId: changedItem.id,
          principal: fixture.principal,
          reason: 'exercise cursor invalidation',
          spaceId: fixture.identity.space.id,
        }),
      ).toMatchObject({ kind: 'success' });
      expect(
        await fixture.service.searchMemory({
          authorization: fixture.authorization,
          cursor: first.value.nextCursor,
          limit: 1,
          principal: fixture.principal,
          query: 'accepted search memory guidance command',
          spaceId: fixture.identity.space.id,
        }),
      ).toMatchObject({ error: { code: 'stale' }, kind: 'error' });
    } finally {
      await fixture.close();
    }
  });

  test('makes an unauthorized high-rank item observationally irrelevant', async () => {
    const fixture = await openEvaluationFixture();
    try {
      const allowedIds = fixture.items.map((item) => item.id);
      const scope = () =>
        createAuthorizedResourceScope({
          activeSpaceId: fixture.identity.space.id,
          permission: 'view_memory',
          resourceIds: allowedIds,
          resourceKind: 'memory',
        });
      const normalized = normalizeMemorySearchParameters({
        limit: 1,
        query: 'project-zephyr exact-secret-command search',
        spaceId: fixture.identity.space.id,
      });
      const search = () =>
        fixture.kernel.memory.searchItems({
          ...normalized,
          authorizationScope: scope(),
          deadlineEpochMs: evaluationNow.getTime() + 2000,
          nowEpochMs: evaluationNow.getTime(),
        });
      const absent = await search();
      const forbiddenDocument = memorySearchEvaluationDocuments.find(
        (document) => document.spaceId === memorySearchEvaluationIdentities.forbiddenSpaceId,
      );
      if (!forbiddenDocument) {
        throw new Error('Forbidden evaluation document is missing.');
      }
      await seedMemorySearchEvaluationCorpus({
        documents: [forbiddenDocument],
        personId: fixture.identity.person.id,
        projectId: fixture.projectId,
        repository: fixture.kernel.memory,
        spaceId: fixture.identity.space.id,
      });
      const present = await search();
      expect(present).toEqual(absent);
    } finally {
      await fixture.close();
    }
  });

  test('rebuilds the derived FTS5 projection idempotently', async () => {
    const fixture = await openEvaluationFixture();
    const { databasePath, identity } = fixture;
    await fixture.kernel.close();
    const database = new Database(databasePath, { strict: true });
    try {
      const snapshot = () =>
        database
          .query(
            `SELECT chunk_id, content_hash, memory_item_id, revision_id
             FROM memory_search_chunks ORDER BY chunk_id ASC`,
          )
          .all();
      database
        .query('UPDATE memory_search_projection_state SET source_state_version = -1 WHERE space_id = $spaceId')
        .run({ spaceId: identity.space.id });
      rebuildSqliteMemorySearchProjection(database, identity.space.id);
      const first = snapshot();
      database
        .query('UPDATE memory_search_projection_state SET source_state_version = -1 WHERE space_id = $spaceId')
        .run({ spaceId: identity.space.id });
      rebuildSqliteMemorySearchProjection(database, identity.space.id);
      expect(snapshot()).toEqual(first);
      expect(first.length).toBeGreaterThanOrEqual(fixture.items.length);
    } finally {
      database.close(false);
      await rm(path.dirname(databasePath), { force: true, recursive: true });
    }
  });
});
