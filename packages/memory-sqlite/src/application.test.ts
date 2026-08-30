import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { memoryFingerprint } from '@ai-usage/memory-service/domain';
import {
  createCaptureContextId,
  createDeviceId,
  createPersonId,
  createProjectId,
  createSpaceId,
  parseInstant,
} from '@ai-usage/platform-core/identity';
import { openLocalIdentityKernel } from './identity';

const legacyMarkdown = (input: {
  readonly id: string;
  readonly kind: 'decision' | 'handoff' | 'preference';
  readonly scope: 'global' | 'repo';
  readonly status: 'active' | 'rejected' | 'superseded';
  readonly supersedes?: string;
  readonly trust: 'explicit' | 'harvest-accepted';
}): string => `---
title: "Imported ${input.kind}"
type: ${input.kind}
scope: ${input.scope}
status: ${input.status}
created: 2026-08-29
updated: 2026-08-29
trust: ${input.trust}
source: "synthetic"
provenance:
  - "synthetic:test"
tags: [synthetic]
distillation_hash: ${input.id}
---

# Imported ${input.kind}

## Summary

Imported ${input.kind} summary.

## Guidance for future agents

- Preserve imported ${input.kind} semantics.

## Evidence / provenance

- synthetic:test

## Supersedes

${input.supersedes ? `- ${input.supersedes}` : 'None.'}

## Superseded by

None.
`;

describe('local Memory application service', () => {
  test('reviews proposals, redacts before persistence, and writes only eligible outbox events', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-application-'));
    const databasePath = path.join(directory, 'memory.sqlite');
    const kernel = await openLocalIdentityKernel({ databasePath });
    try {
      const identity = await kernel.getBootstrapIdentity();
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
      const service = createMemoryApplicationService(
        authorizer,
        kernel.memory,
        () => new Date('2026-08-29T12:00:00.000Z'),
      );
      const authorization = { activeSpaceId: identity.space.id, trustedDevice: true } as const;
      const principal = { kind: 'person' as const, personId: identity.person.id };
      const evidence = { source: 'synthetic application test' } as const;

      const observation = await service.recordObservation({
        authorization,
        captureContextId: null,
        content: evidence,
        fingerprint: memoryFingerprint(evidence),
        principal,
        projectId: null,
        sensitivity: 'normal',
        sourceKind: 'user',
        sourceLocator: 'synthetic:application',
      });
      expect(observation.kind).toBe('success');
      if (observation.kind !== 'success') {
        throw new Error('Synthetic observation was not recorded.');
      }

      const proposal = await service.createProposal({
        authorization,
        guidance: ['Keep accepted Memory behind application services.'],
        observationIds: [observation.value.id],
        principal,
        projectId: null,
        proposedKind: 'constraint',
        sensitivity: 'normal',
        structuredContent: { compatibility: 'nixos-agent-memory' },
        summary: 'The database is authoritative.',
        title: 'DB-native Memory authority',
        trustCandidate: 'harvest-accepted',
      });
      expect(proposal.kind).toBe('success');
      if (proposal.kind !== 'success') {
        throw new Error('Synthetic proposal was not created.');
      }
      expect(
        await service.listMemoryItems({ authorization, pageSize: 10, principal, spaceId: identity.space.id }),
      ).toMatchObject({ kind: 'success', value: { items: [] } });

      const accepted = await service.acceptProposal({
        authorization,
        principal,
        proposalId: proposal.value,
        scope: 'space',
        spaceId: identity.space.id,
      });
      expect(accepted.kind).toBe('success');
      if (accepted.kind !== 'success') {
        throw new Error('Synthetic proposal was not accepted.');
      }
      expect(accepted.value.item.trust).toBe('harvest-accepted');
      expect(
        await kernel.configureReplication({
          captureContext: {
            deviceId: createDeviceId(),
            id: createCaptureContextId(),
            personId: createPersonId(),
            projectId: null,
            scmAccountId: null,
            scmInstallationId: null,
            source: 'personal-fallback',
            spaceId: createSpaceId(),
          },
          configuredAt: new Date('2026-08-29T12:00:00.000Z'),
          localProjectId: null,
          localSpaceId: identity.space.id,
        }),
      ).toEqual({ backfilled: 1, nextCursor: null, unchanged: 0 });
      const contextProjectId = createProjectId();
      expect(
        await service.getProjectContext({
          authorization,
          limit: 10,
          principal,
          projectId: contextProjectId,
          spaceId: identity.space.id,
        }),
      ).toMatchObject({
        kind: 'success',
        value: {
          items: [{ item: { id: accepted.value.item.id, kind: 'constraint', scope: 'space' } }],
          projectId: contextProjectId,
          truncated: false,
        },
      });
      expect(
        await service.getProjectContext({
          authorization,
          limit: 33,
          principal,
          projectId: contextProjectId,
          spaceId: identity.space.id,
        }),
      ).toMatchObject({ error: { code: 'invalid-input', operation: 'get-project-context' }, kind: 'error' });

      const revised = await service.reviseMemoryItem({
        authorization,
        expectedCurrentRevisionId: accepted.value.item.currentRevisionId,
        guidance: ['Never persist password=memory-application-secret.'],
        itemId: accepted.value.item.id,
        principal,
        reason: 'exercise pre-persistence redaction',
        spaceId: identity.space.id,
        structuredContent: { token: 'memory-application-token' },
        summary: 'Redaction must happen before persistence.',
        title: 'Redacted Memory revision',
      });
      expect(revised).toMatchObject({ kind: 'success', value: { item: { sensitivity: 'sensitive' } } });

      const denied = await service.recordObservation({
        authorization,
        captureContextId: null,
        content: { mustNotPersist: true },
        fingerprint: 'f'.repeat(64),
        principal: { kind: 'person', personId: createPersonId() },
        projectId: null,
        sensitivity: 'normal',
        sourceKind: 'agent',
        sourceLocator: null,
      });
      expect(denied).toEqual({
        error: { code: 'authorization-denied', operation: 'record-observation' },
        kind: 'error',
      });
    } finally {
      await kernel.close();
    }

    const database = new Database(databasePath, { readonly: true, strict: true });
    try {
      const counts = database
        .query(
          `SELECT
             (SELECT count(*) FROM memory_observations) AS observations,
             (SELECT count(*) FROM memory_items) AS items,
             (SELECT count(*) FROM memory_revisions) AS revisions,
             (SELECT count(*) FROM replication_outbox_events) AS outbox,
             (SELECT count(*) FROM memory_audit_events) AS audits`,
        )
        .get() as {
        readonly audits: number;
        readonly items: number;
        readonly observations: number;
        readonly outbox: number;
        readonly revisions: number;
      };
      expect(counts).toEqual({ audits: 7, items: 1, observations: 1, outbox: 2, revisions: 2 });
      const persisted = JSON.stringify(
        database
          .query(
            `SELECT item.sensitivity, revision.guidance_json, revision.structured_content_json
             FROM memory_items item
             INNER JOIN memory_revisions revision ON revision.id = item.current_revision_id`,
          )
          .get(),
      );
      expect(persisted).toContain('[REDACTED]');
      expect(persisted).not.toContain('memory-application-secret');
      expect(persisted).not.toContain('memory-application-token');
      expect(
        JSON.stringify(database.query("SELECT sql FROM sqlite_schema WHERE name = 'memory_audit_events'").get()),
      ).not.toContain('content');
    } finally {
      database.close(false);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('previews, confirms, deduplicates, stale-checks, and exports legacy Memory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-migration-'));
    const databasePath = path.join(directory, 'memory.sqlite');
    const legacyPath = path.join(directory, 'legacy-memory.md');
    const legacyContent = [
      legacyMarkdown({ id: 'legacy-decision', kind: 'decision', scope: 'global', status: 'active', trust: 'explicit' }),
      legacyMarkdown({
        id: 'legacy-handoff',
        kind: 'handoff',
        scope: 'repo',
        status: 'superseded',
        supersedes: 'legacy-decision',
        trust: 'harvest-accepted',
      }),
      legacyMarkdown({
        id: 'legacy-rejected',
        kind: 'preference',
        scope: 'global',
        status: 'rejected',
        trust: 'explicit',
      }),
    ];
    await writeFile(legacyPath, legacyContent.join('\n'), { mode: 0o600 });
    const originalSource = await readFile(legacyPath, 'utf8');
    const kernel = await openLocalIdentityKernel({ databasePath });
    try {
      const identity = await kernel.getBootstrapIdentity();
      const projectId = createProjectId();
      await kernel.createProject({
        displayName: 'Migration destination',
        id: projectId,
        kind: 'local',
        owningSpaceId: identity.space.id,
        repositoryId: null,
        repositorySubpath: null,
        status: 'active',
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
      const service = createMemoryApplicationService(
        authorizer,
        kernel.memory,
        () => new Date('2026-08-29T13:00:00.000Z'),
      );
      const authorization = { activeSpaceId: identity.space.id, trustedDevice: true } as const;
      const principal = { kind: 'person' as const, personId: identity.person.id };
      const source = {
        documents: legacyContent.map((content, index) => ({
          content,
          sourceLocator: `${legacyPath}#${index + 1}`,
        })),
        sourceKind: 'legacy-markdown' as const,
        sourceLocator: legacyPath,
      };

      const preview = await service.previewMemoryImport({
        authorization,
        destinationProjectId: projectId,
        destinationSpaceId: identity.space.id,
        principal,
        source,
      });
      expect(preview).toMatchObject({
        kind: 'success',
        value: {
          alreadyConfirmed: false,
          effects: {
            acceptedItems: 2,
            observations: 3,
            rejectedProposals: 1,
            relations: 1,
            supersededItems: 1,
          },
          issues: [],
          status: 'previewed',
        },
      });
      if (preview.kind !== 'success') {
        throw new Error('Synthetic import preview failed.');
      }
      const confirmed = await service.confirmMemoryImport({
        authorization,
        destinationProjectId: projectId,
        destinationSpaceId: identity.space.id,
        importId: preview.value.importId,
        previewProof: preview.value.previewProof,
        principal,
        source,
      });
      expect(confirmed).toMatchObject({
        kind: 'success',
        value: { effects: { acceptedItems: 2, observations: 3, rejectedProposals: 1, relations: 1 } },
      });
      expect(
        await service.confirmMemoryImport({
          authorization,
          destinationProjectId: projectId,
          destinationSpaceId: identity.space.id,
          importId: preview.value.importId,
          previewProof: preview.value.previewProof,
          principal,
          source,
        }),
      ).toMatchObject({ kind: 'success', value: { effects: { duplicateRecords: 3, observations: 0 } } });
      expect(
        await service.previewMemoryImport({
          authorization,
          destinationProjectId: projectId,
          destinationSpaceId: identity.space.id,
          principal,
          source,
        }),
      ).toMatchObject({ kind: 'success', value: { alreadyConfirmed: true, status: 'confirmed' } });

      const items = await service.listMemoryItems({
        authorization,
        pageSize: 10,
        principal,
        spaceId: identity.space.id,
      });
      expect(items).toMatchObject({ kind: 'success', value: { items: [{}, {}], nextCursor: null } });
      if (items.kind !== 'success') {
        throw new Error('Imported items could not be listed.');
      }
      expect(items.value.items.map(({ item }) => item.kind).sort()).toEqual(['decision', 'handoff']);
      expect(items.value.items.find(({ item }) => item.kind === 'handoff')?.item).toMatchObject({
        status: 'superseded',
        trust: 'harvest-accepted',
      });

      const inboxContent = `${JSON.stringify({
        body: 'password=synthetic-import-secret',
        repo: '/synthetic/repo',
        scope: 'session',
        sensitivity: 'private',
        source: 'recent-work-context',
        timestamp: '2026-08-29T13:01:00.000Z',
        title: 'Pending session evidence',
        type: 'session-harvest',
        version: '0.1.0',
      })}\n`;
      const inboxSource = {
        documents: [{ content: inboxContent, sourceLocator: 'inbox/events.jsonl' }],
        sourceKind: 'legacy-jsonl' as const,
        sourceLocator: 'inbox/events.jsonl',
      };
      const stalePreview = await service.previewMemoryImport({
        authorization,
        destinationProjectId: projectId,
        destinationSpaceId: identity.space.id,
        principal,
        source: inboxSource,
      });
      if (stalePreview.kind !== 'success') {
        throw new Error('Synthetic stale preview failed.');
      }
      const interveningContent = { evidence: 'destination changed after preview' } as const;
      expect(
        await service.recordObservation({
          authorization,
          captureContextId: null,
          content: interveningContent,
          fingerprint: memoryFingerprint(interveningContent),
          principal,
          projectId: null,
          sensitivity: 'normal',
          sourceKind: 'user',
          sourceLocator: 'synthetic:stale-proof',
        }),
      ).toMatchObject({ kind: 'success' });
      expect(
        await service.confirmMemoryImport({
          authorization,
          destinationProjectId: projectId,
          destinationSpaceId: identity.space.id,
          importId: stalePreview.value.importId,
          previewProof: stalePreview.value.previewProof,
          principal,
          source: inboxSource,
        }),
      ).toEqual({ error: { code: 'stale', operation: 'confirm-memory-import' }, kind: 'error' });

      const refreshed = await service.previewMemoryImport({
        authorization,
        destinationProjectId: projectId,
        destinationSpaceId: identity.space.id,
        principal,
        source: inboxSource,
      });
      if (refreshed.kind !== 'success') {
        throw new Error('Synthetic refreshed preview failed.');
      }
      expect(
        await service.confirmMemoryImport({
          authorization,
          destinationProjectId: projectId,
          destinationSpaceId: identity.space.id,
          importId: refreshed.value.importId,
          previewProof: refreshed.value.previewProof,
          principal,
          source: inboxSource,
        }),
      ).toMatchObject({ kind: 'success', value: { effects: { pendingProposals: 1 } } });
      expect(
        await service.listPendingProposals({
          authorization,
          pageSize: 10,
          principal,
          spaceId: identity.space.id,
        }),
      ).toMatchObject({ kind: 'success', value: { items: [{ proposal: { proposedKind: 'handoff' } }] } });

      for (const format of ['jsonl', 'markdown'] as const) {
        const first = await service.exportMemory({
          authorization,
          format,
          principal,
          spaceId: identity.space.id,
        });
        const second = await service.exportMemory({
          authorization,
          format,
          principal,
          spaceId: identity.space.id,
        });
        expect(second).toEqual(first);
        expect(JSON.stringify(first)).not.toContain('synthetic-import-secret');
        expect(JSON.stringify(first)).not.toContain(legacyPath);
      }
      expect(await readFile(legacyPath, 'utf8')).toBe(originalSource);
    } finally {
      await kernel.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('privacy-purges content, evidence, and local replication derivatives', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-privacy-purge-'));
    const databasePath = path.join(directory, 'memory.sqlite');
    const kernel = await openLocalIdentityKernel({ databasePath });
    try {
      const identity = await kernel.getBootstrapIdentity();
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
      const service = createMemoryApplicationService(
        authorizer,
        kernel.memory,
        () => new Date('2026-08-29T15:00:00.000Z'),
      );
      const authorization = { activeSpaceId: identity.space.id, trustedDevice: true } as const;
      const principal = { kind: 'person' as const, personId: identity.person.id };
      const content = { evidence: 'privacy purge fixture' } as const;
      const observation = await service.recordObservation({
        authorization,
        captureContextId: null,
        content,
        fingerprint: memoryFingerprint(content),
        principal,
        projectId: null,
        sensitivity: 'normal',
        sourceKind: 'user',
        sourceLocator: 'synthetic:privacy-purge',
      });
      if (observation.kind !== 'success') {
        throw new Error('Privacy purge observation failed.');
      }
      const proposal = await service.createProposal({
        authorization,
        guidance: ['Purge every content derivative.'],
        observationIds: [observation.value.id],
        principal,
        projectId: null,
        proposedKind: 'constraint',
        sensitivity: 'normal',
        structuredContent: { privacy: true },
        summary: 'Privacy deletion removes content and projections.',
        title: 'Privacy deletion',
        trustCandidate: 'explicit',
      });
      if (proposal.kind !== 'success') {
        throw new Error('Privacy purge proposal failed.');
      }
      const accepted = await service.acceptProposal({
        authorization,
        principal,
        proposalId: proposal.value,
        scope: 'space',
        spaceId: identity.space.id,
      });
      if (accepted.kind !== 'success') {
        throw new Error('Privacy purge acceptance failed.');
      }
      expect(
        await service.purgeMemoryItem({
          authorization,
          itemId: accepted.value.item.id,
          principal,
          spaceId: identity.space.id,
        }),
      ).toEqual({ kind: 'success', value: undefined });
      expect(
        await service.exportMemory({
          authorization,
          format: 'jsonl',
          principal,
          spaceId: identity.space.id,
        }),
      ).toMatchObject({ kind: 'success', value: { itemCount: 0, revisionCount: 0 } });
    } finally {
      await kernel.close();
    }

    const database = new Database(databasePath, { readonly: true, strict: true });
    try {
      const counts = database
        .query(
          `SELECT
             (SELECT count(*) FROM memory_observations) AS observations,
             (SELECT count(*) FROM memory_proposals) AS proposals,
             (SELECT count(*) FROM memory_items) AS items,
             (SELECT count(*) FROM memory_revisions) AS revisions,
             (SELECT count(*) FROM memory_relations) AS relations,
             (SELECT count(*) FROM replication_outbox_events) AS outbox,
             (SELECT count(*) FROM memory_audit_events WHERE action = 'purge-memory-item') AS tombstones`,
        )
        .get();
      expect(counts).toEqual({
        items: 0,
        observations: 0,
        outbox: 0,
        proposals: 0,
        relations: 0,
        revisions: 0,
        tombstones: 1,
      });
    } finally {
      database.close(false);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('publishes an explicit privacy tombstone without rewriting acknowledged history', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-connected-purge-'));
    const databasePath = path.join(directory, 'memory.sqlite');
    const kernel = await openLocalIdentityKernel({ databasePath });
    try {
      const identity = await kernel.getBootstrapIdentity();
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
      await kernel.configureReplication({
        captureContext,
        configuredAt: new Date('2026-08-29T16:00:00.000Z'),
        localProjectId: null,
        localSpaceId: identity.space.id,
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
      const service = createMemoryApplicationService(
        authorizer,
        kernel.memory,
        () => new Date('2026-08-29T16:00:00.000Z'),
      );
      const authorization = { activeSpaceId: identity.space.id, trustedDevice: true } as const;
      const principal = { kind: 'person' as const, personId: identity.person.id };
      const content = { evidence: 'connected purge fixture' } as const;
      const observation = await service.recordObservation({
        authorization,
        captureContextId: null,
        content,
        fingerprint: memoryFingerprint(content),
        principal,
        projectId: null,
        sensitivity: 'normal',
        sourceKind: 'user',
        sourceLocator: 'synthetic:connected-purge',
      });
      if (observation.kind !== 'success') {
        throw new Error('Connected purge observation failed.');
      }
      const proposal = await service.createProposal({
        authorization,
        guidance: ['Publish deletion explicitly.'],
        observationIds: [observation.value.id],
        principal,
        projectId: null,
        proposedKind: 'constraint',
        sensitivity: 'normal',
        structuredContent: { connected: true },
        summary: 'Privacy deletion becomes a tombstone.',
        title: 'Connected privacy deletion',
        trustCandidate: 'explicit',
      });
      if (proposal.kind !== 'success') {
        throw new Error('Connected purge proposal failed.');
      }
      const accepted = await service.acceptProposal({
        authorization,
        principal,
        proposalId: proposal.value,
        scope: 'space',
        spaceId: identity.space.id,
      });
      if (accepted.kind !== 'success') {
        throw new Error('Connected purge acceptance failed.');
      }
      const claimed = kernel.replication.claimReady({
        maximumEvents: 100,
        now: parseInstant('2026-08-29T16:00:01.000Z'),
      });
      if (!claimed) {
        throw new Error('Connected purge publication was not claimable.');
      }
      kernel.replication.acknowledge(claimed.batch, {
        acceptedThroughGeneration: claimed.batch.toGenerationInclusive,
        appliedAt: parseInstant('2026-08-29T16:00:02.000Z'),
        appliedBatchId: claimed.batch.batchId,
        appliedEventIds: claimed.batch.events.map(({ eventId }) => eventId),
        counts: { applied: 1, duplicate: 0, projected: 1, tombstoned: 0 },
        deviceId: captureContext.deviceId,
        protocolVersion: 1,
        streamId: claimed.batch.streamId,
        warnings: [],
      });

      expect(
        await service.purgeMemoryItem({
          authorization,
          itemId: accepted.value.item.id,
          principal,
          spaceId: identity.space.id,
        }),
      ).toEqual({ kind: 'success', value: undefined });
      expect(await kernel.memory.getItem(identity.space.id, accepted.value.item.id)).toBeNull();
      expect(kernel.replication.listHistory()).toEqual([
        expect.objectContaining({
          changeKind: 'memory-fact-tombstone',
          factKey: `memory-item:${accepted.value.item.id}`,
          generation: 2,
          state: 'pending',
        }),
        expect.objectContaining({
          changeKind: 'memory-item-revision-upsert',
          factKey: `memory-item:${accepted.value.item.id}`,
          generation: 1,
          state: 'acknowledged',
        }),
      ]);
    } finally {
      await kernel.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
