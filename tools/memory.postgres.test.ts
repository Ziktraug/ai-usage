import { describe, expect, test } from 'bun:test';
import { createAuthorizedResourceScope } from '@ai-usage/authorization/scope-internal';
import { createApplicationMemoryMcpReadService } from '@ai-usage/mcp-adapter';
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
import { runMemoryRepositoryConformance } from '@ai-usage/memory-service/conformance';
import { memoryFingerprint } from '@ai-usage/memory-service/domain';
import { createPersonId, createProjectId, createSpaceId, instantNow } from '@ai-usage/platform-core/identity';
import { createPlatformStore } from '@ai-usage/postgres-store/writer';
import { Pool } from 'pg';
import { startPostgresCluster } from './pg-harness';

const runPostgresTests = process.env.AI_USAGE_RUN_POSTGRES_TESTS === '1';

if (runPostgresTests) {
  describe('PostgreSQL Memory repository', () => {
    test('passes the adapter-independent Memory contract', async () => {
      await runMemoryRepositoryConformance(async () => {
        const cluster = await startPostgresCluster('memory-conformance');
        const store = await createPlatformStore({
          connectTimeoutMs: 5000,
          databaseUrl: cluster.url,
          migrationMode: 'apply',
          poolSize: 4,
          queryTimeoutMs: 5000,
          tlsMode: 'disable',
        });
        const spaceId = createSpaceId();
        const personId = createPersonId();
        const createdAt = instantNow(() => new Date('2026-08-29T09:00:00.000Z'));
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Memory conformance person',
            id: personId,
            personalSpaceId: spaceId,
            status: 'active',
          },
          space: {
            createdAt,
            displayName: 'Memory conformance space',
            id: spaceId,
            kind: 'personal',
          },
        });
        return {
          close: async () => {
            await store.close().catch(() => undefined);
            await cluster.stop();
          },
          createAuthorizationScope: (resourceIds: readonly string[]) =>
            createAuthorizedResourceScope({
              activeSpaceId: spaceId,
              permission: 'view_memory',
              resourceIds,
              resourceKind: 'memory',
            }),
          personId,
          projectId: null,
          repository: store.memory,
          spaceId,
        };
      });
    }, 30_000);

    test('applies the shared Authorizer scope before proposal, item, and export reads', async () => {
      const cluster = await startPostgresCluster('memory-application-authorization');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 4,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      try {
        const spaceId = createSpaceId();
        const personId = createPersonId();
        const createdAt = instantNow(() => new Date('2026-08-29T14:00:00.000Z'));
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Shared Memory application person',
            id: personId,
            personalSpaceId: spaceId,
            status: 'active',
          },
          space: {
            createdAt,
            displayName: 'Shared Memory application space',
            id: spaceId,
            kind: 'personal',
          },
        });
        const service = createMemoryApplicationService(
          store.authorization,
          store.memory,
          () => new Date('2026-08-29T14:01:00.000Z'),
        );
        const authorization = { activeSpaceId: spaceId, trustedDevice: true } as const;
        const principal = { kind: 'person' as const, personId };
        const content = { source: 'shared application authorization' } as const;
        const observation = await service.recordObservation({
          authorization,
          captureContextId: null,
          content,
          fingerprint: memoryFingerprint(content),
          principal,
          projectId: null,
          sensitivity: 'normal',
          sourceKind: 'user',
          sourceLocator: 'synthetic:shared-application',
        });
        if (observation.kind !== 'success') {
          throw new Error('Shared application observation failed.');
        }
        const proposal = await service.createProposal({
          authorization,
          guidance: ['Authorize the complete Memory scope before reads.'],
          observationIds: [observation.value.id],
          principal,
          projectId: null,
          proposedKind: 'constraint',
          sensitivity: 'normal',
          structuredContent: { boundary: 'authorization-first' },
          summary: 'Shared reads consume one materialized authorization scope.',
          title: 'Authorization-first shared Memory',
          trustCandidate: 'harvest-accepted',
        });
        if (proposal.kind !== 'success') {
          throw new Error('Shared application proposal failed.');
        }
        expect(await service.listPendingProposals({ authorization, pageSize: 10, principal, spaceId })).toMatchObject({
          kind: 'success',
          value: { items: [{ proposal: { id: proposal.value } }] },
        });
        const accepted = await service.acceptProposal({
          authorization,
          principal,
          proposalId: proposal.value,
          scope: 'space',
          spaceId,
        });
        if (accepted.kind !== 'success') {
          throw new Error('Shared application acceptance failed.');
        }
        expect(await service.listMemoryItems({ authorization, pageSize: 10, principal, spaceId })).toMatchObject({
          kind: 'success',
          value: { items: [{ item: { id: accepted.value.item.id } }] },
        });
        expect(
          await service.supersedeMemoryItem({
            authorization,
            itemId: accepted.value.item.id,
            principal,
            reason: 'exercise historical readability',
            spaceId,
          }),
        ).toMatchObject({ kind: 'success' });
        expect(
          await service.getMemoryItem({ authorization, itemId: accepted.value.item.id, principal, spaceId }),
        ).toMatchObject({ kind: 'success', value: { item: { status: 'superseded' } } });
        expect(await service.exportMemory({ authorization, format: 'jsonl', principal, spaceId })).toMatchObject({
          kind: 'success',
          value: { itemCount: 1, revisionCount: 1 },
        });
        expect(
          await service.purgeMemoryItem({
            authorization,
            itemId: accepted.value.item.id,
            principal,
            spaceId,
          }),
        ).toMatchObject({ kind: 'success' });
        expect(await service.exportMemory({ authorization, format: 'jsonl', principal, spaceId })).toMatchObject({
          kind: 'success',
          value: { itemCount: 0, revisionCount: 0 },
        });
      } finally {
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('runs the committed lexical evaluation corpus through PostgreSQL FTS and pg_trgm', async () => {
      const cluster = await startPostgresCluster('memory-search-evaluation');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 4,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      try {
        const spaceId = createSpaceId();
        const personId = createPersonId();
        const projectId = createProjectId();
        const createdAt = instantNow(() => new Date('2026-08-30T10:00:00.000Z'));
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Shared search evaluation person',
            id: personId,
            personalSpaceId: spaceId,
            status: 'active',
          },
          space: {
            createdAt,
            displayName: 'Shared search evaluation space',
            id: spaceId,
            kind: 'personal',
          },
        });
        await store.identity.createProject({
          displayName: 'Shared search evaluation',
          id: projectId,
          kind: 'local',
          owningSpaceId: spaceId,
          repositoryId: null,
          repositorySubpath: null,
          status: 'active',
        });
        await seedMemorySearchEvaluationCorpus({
          documents: activeMemorySearchEvaluationDocuments.filter(
            (document) => document.spaceId === memorySearchEvaluationIdentities.authorizedSpaceId,
          ),
          personId,
          projectId,
          repository: store.memory,
          spaceId,
        });
        const now = new Date('2026-08-30T10:10:00.000Z');
        const service = createMemoryApplicationService(store.authorization, store.memory, () => now);
        const authorization = { activeSpaceId: spaceId, trustedDevice: true } as const;
        const principal = { kind: 'person' as const, personId };
        const observations: MemorySearchEvaluationObservation[] = [];
        for (const evaluationCase of activeMemorySearchEvaluationCases) {
          const startedAt = performance.now();
          const result = await service.searchMemory({
            authorization,
            ...(evaluationCase.historyMode === undefined ? {} : { historyMode: evaluationCase.historyMode }),
            includeSpaceWide: evaluationCase.class === 'scope-precedence',
            limit: 10,
            ...(evaluationCase.matchingMode === undefined ? {} : { matchingMode: evaluationCase.matchingMode }),
            principal,
            ...(evaluationCase.projectId === undefined ? {} : { projectId }),
            query: evaluationCase.query,
            spaceId,
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
          const expectedId = evaluationCase.expectedIds[0];
          if (!expectedId) {
            throw new Error(`Evaluation case ${evaluationCase.id} has no expected ID.`);
          }
          if (evaluationCase.class === 'semantic-paraphrase' && !returnedIds.includes(expectedId)) {
            expect(returnedIds, `${evaluationCase.id}: lexical gate fixture`).toEqual([]);
            continue;
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
          adapter: 'postgresql-fts-pg-trgm',
          authorizationNoLeakPassed: true,
          cases: activeMemorySearchEvaluationCases,
          observations,
        });
        if (process.env.AI_USAGE_PRINT_MEMORY_SEARCH_METRICS === '1') {
          process.stdout.write(`MEMORY_SEARCH_METRICS ${JSON.stringify(report)}\n`);
        }
        expect(report.aggregate.falsePositiveRate).toBe(0);
        expect(report.aggregate.recallAt10).toBeGreaterThanOrEqual(0.888_889);
        expect(report.aggregate.latencyMs.maximum).toBeLessThan(2000);
        expect(report.vectorGate.shouldAddPgvector).toBe(false);
        const connectedMcpRead = createApplicationMemoryMcpReadService(service, {
          authorization,
          principal,
          spaceId,
        });
        expect(
          await connectedMcpRead.searchMemory(
            { limit: 10, matchingMode: 'literal', query: 'ADR-0033' },
            new AbortController().signal,
          ),
        ).toMatchObject({ kind: 'success', value: { items: [{ title: 'ADR-0033 authorize before ranking' }] } });
      } finally {
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);

    test('keeps a same-Space forbidden top match out of every observable result property', async () => {
      const cluster = await startPostgresCluster('memory-search-no-leak');
      const store = await createPlatformStore({
        connectTimeoutMs: 5000,
        databaseUrl: cluster.url,
        migrationMode: 'apply',
        poolSize: 4,
        queryTimeoutMs: 5000,
        tlsMode: 'disable',
      });
      let unsafePool: Pool | null = null;
      try {
        const personalSpaceId = createSpaceId();
        const organizationSpaceId = createSpaceId();
        const personId = createPersonId();
        const otherSpaceId = createSpaceId();
        const otherPersonId = createPersonId();
        const projectId = createProjectId();
        const createdAt = instantNow(() => new Date('2026-08-30T11:00:00.000Z'));
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Authorized search person',
            id: personId,
            personalSpaceId,
            status: 'active',
          },
          space: { createdAt, displayName: 'Authorized personal space', id: personalSpaceId, kind: 'personal' },
        });
        await store.identity.createPersonalIdentity({
          person: {
            displayName: 'Forbidden Memory owner',
            id: otherPersonId,
            personalSpaceId: otherSpaceId,
            status: 'active',
          },
          space: { createdAt, displayName: 'Other personal space', id: otherSpaceId, kind: 'personal' },
        });
        unsafePool = new Pool({ connectionString: cluster.url, max: 1 });
        await unsafePool.query(
          `INSERT INTO spaces (id, kind, display_name, created_at)
           VALUES ($1, 'organization', 'Authorization-negative organization', $2)`,
          [organizationSpaceId, createdAt],
        );
        await store.authorization.administration.createOrganizationWithAdmin({
          actorPersonId: personId,
          createdAt,
          spaceId: organizationSpaceId,
        });
        await store.identity.createProject({
          displayName: 'Authorization-negative project',
          id: projectId,
          kind: 'local',
          owningSpaceId: organizationSpaceId,
          repositoryId: null,
          repositorySubpath: null,
          status: 'active',
        });
        const authorizedDocument = activeMemorySearchEvaluationDocuments.find(
          (document) => document.title === 'React pnpm check command',
        );
        const forbiddenDocument = memorySearchEvaluationDocuments.find(
          (document) => document.spaceId === memorySearchEvaluationIdentities.forbiddenSpaceId,
        );
        if (!(authorizedDocument && forbiddenDocument)) {
          throw new Error('Memory search no-leak fixtures are incomplete.');
        }
        await seedMemorySearchEvaluationCorpus({
          documents: [authorizedDocument],
          personId,
          projectId,
          repository: store.memory,
          spaceId: organizationSpaceId,
        });
        const now = new Date('2026-08-30T11:10:00.000Z');
        const service = createMemoryApplicationService(store.authorization, store.memory, () => now);
        const searchInput = {
          authorization: { activeSpaceId: organizationSpaceId, trustedDevice: true } as const,
          limit: 1,
          principal: { kind: 'person' as const, personId },
          query: 'project-zephyr exact-secret-command',
          spaceId: organizationSpaceId,
        };
        const absent = await service.searchMemory(searchInput);
        expect(absent).toMatchObject({ kind: 'success' });

        await seedMemorySearchEvaluationCorpus({
          documents: [forbiddenDocument],
          personId: otherPersonId,
          projectId,
          repository: store.memory,
          spaceId: organizationSpaceId,
        });
        const present = await service.searchMemory(searchInput);
        expect(present).toEqual(absent);

        const client = await unsafePool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('ai_usage.active_space_id', $1, TRUE)", [organizationSpaceId]);
          const unsafe = await client.query<{ readonly memory_item_id: string }>(
            `SELECT memory_item_id
             FROM memory_search_chunks
             WHERE position(lower($1) IN normalized_document) > 0
             ORDER BY memory_item_id ASC
             LIMIT 1`,
            [searchInput.query],
          );
          expect(unsafe.rows[0]?.memory_item_id).toBe(forbiddenDocument.id);
          expect(absent.kind === 'success' ? absent.value.items.map((item) => item.id) : []).not.toContain(
            forbiddenDocument.id,
          );
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      } finally {
        await unsafePool?.end().catch(() => undefined);
        await store.close().catch(() => undefined);
        await cluster.stop();
      }
    }, 30_000);
  });
} else {
  // biome-ignore lint/suspicious/noSkippedTests: PostgreSQL integration requires the repository-owned PostgreSQL 17 binaries.
  describe.skip('PostgreSQL Memory repository', () => {
    test('requires AI_USAGE_RUN_POSTGRES_TESTS=1', () => undefined);
  });
}
