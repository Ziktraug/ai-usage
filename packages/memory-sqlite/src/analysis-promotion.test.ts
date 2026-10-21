import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import { createAnalysisPromotionService } from '@ai-usage/memory-service/analysis-promotion';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { projectMemoryItemsBrowsePage } from '@ai-usage/memory-service/browse';
import {
  distillationEvidenceDigestInput,
  parseDistillationEvidencePacket,
} from '@ai-usage/platform-core/distillation-evidence';
import {
  createCaptureContextId,
  createDeviceId,
  createPersonId,
  createProjectId,
  createSpaceId,
} from '@ai-usage/platform-core/identity';
import type { SessionAnalysisContent } from '@ai-usage/platform-core/session-distillation';
import { openLocalIdentityKernel } from './identity';

// Historical local-only provenance remains protected after the producer is retired.
// This fixture is self-contained so that preservation tests do not depend on its old tools.
const sourceContent: SessionAnalysisContent = {
  schemaVersion: 1,
  summary: {
    text: 'A focused regression is required before treating the cache fix as validated.',
    basis: 'reported',
    evidence: [{ eventId: 'synthetic-user', quote: 'Verify the cache fix with a focused regression.' }],
  },
  episodes: [],
  abstention: 'The synthetic source supplies guidance but no observed verification result.',
};

const sourcePacket = (projectId: string) =>
  parseDistillationEvidencePacket({
    schemaVersion: 1,
    normalizationVersion: 1,
    redactionVersion: 1,
    packetDigest: '0'.repeat(64),
    source: {
      harnessKey: 'codex',
      machineId: 'synthetic-machine',
      projectId,
      nativeSessionId: 'synthetic-session',
      reportAnchor: { revision: 'promotion-fixture', rowId: 'synthetic-session' },
      version: {
        digest: createHash('sha256').update('synthetic-promotion-source').digest('hex'),
        bytes: 100,
        totalBytes: 100,
        modifiedAtMs: 1,
      },
    },
    events: [
      {
        id: 'synthetic-user',
        line: 1,
        kind: 'user',
        text: 'Verify the cache fix with a focused regression.',
        timestamp: null,
        nativeTurnId: 'synthetic-turn',
        roundId: 'prompt:synthetic-prompt',
        toolName: null,
        callId: null,
        truncated: false,
        redacted: false,
      },
    ],
    coverage: {
      scope: 'session-only',
      completion: 'completed',
      status: 'complete',
      lines: 1,
      includedEvents: 1,
      exclusions: [],
      childDiscovery: 'not-performed',
      childrenNotAnalyzed: null,
    },
  });

test('explicit promotion keeps normal knowledge local through replay, acceptance, enrollment, revision and purge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-promotion-'));
  const databasePath = path.join(root, 'memory.sqlite');
  let kernel = await openLocalIdentityKernel({ databasePath });
  try {
    const identity = await kernel.getBootstrapIdentity();
    const projectId = createProjectId();
    await kernel.createProject({
      id: projectId,
      displayName: 'Synthetic project',
      kind: 'local',
      owningSpaceId: identity.space.id,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    });
    const authorizer = createSingleUserAuthorizer({
      localPersonId: identity.person.id,
      personalSpaceId: identity.space.id,
      listKnownResources: async () =>
        (await kernel.memory.listAuthorizationResourceIds(identity.space.id)).map((id) => ({
          id,
          kind: 'memory' as const,
          spaceId: identity.space.id,
        })),
    });
    const context = {
      authorization: { activeSpaceId: identity.space.id, trustedDevice: true },
      principal: { kind: 'person' as const, personId: identity.person.id },
    };
    const packet = sourcePacket(projectId);
    const selection = { revision: 'promotion-fixture', rowId: 'synthetic-session' };
    packet.packetDigest = createHash('sha256').update(distillationEvidenceDigestInput(packet)).digest('hex');
    const job = await kernel.distillation.prepare({
      packet,
      grant: {
        projectId,
        machineId: packet.source.machineId,
        nativeSessionId: packet.source.nativeSessionId,
        projectSourceId: 'synthetic-promotion-source',
        checkoutPath: '/synthetic/project',
        selection,
      },
      producerSessionId: 'synthetic-promotion-worker',
      revisionKey: null,
    });
    const lease = await kernel.distillation.claim(projectId, job.id);
    const source = await kernel.distillation.submit({
      projectId,
      jobId: job.id,
      leaseId: lease.leaseId,
      packetDigest: packet.packetDigest,
      content: sourceContent,
    });
    let reads = 0;
    const promotion = () =>
      createAnalysisPromotionService({
        authorizer,
        repository: kernel.memory,
        readAnalysis: (selectedProjectId, analysisId) => {
          reads++;
          return kernel.distillation.get(selectedProjectId, analysisId);
        },
      });
    const request = {
      analysisId: source.id,
      projectId,
      elementKey: 'summary',
      title: 'Verify the cache fix',
      kind: 'lesson' as const,
      formulation: 'Run the focused regression before considering the cache fix validated.',
      sensitivity: 'normal' as const,
      localOnly: true as const,
    };
    const service = () => createMemoryApplicationService(authorizer, kernel.memory);
    const browse = () =>
      service().listMemoryItems({ ...context, spaceId: identity.space.id, projectId, pageSize: 20, status: 'active' });
    const first = await promotion()(request, context);
    const concurrent = await Promise.all([promotion()(request, context), promotion()(request, context)]);
    expect(concurrent).toEqual([first, first]);
    expect(await promotion()(request, context)).toEqual(first);
    expect(await browse()).toMatchObject({ kind: 'success', value: { items: [] } });
    const changed = await promotion()(
      { ...request, formulation: 'Preserve the regression test after verifying the fix.' },
      context,
    );
    expect(changed.proposalId).not.toBe(first.proposalId);
    expect(await service().listPendingProposals({ ...context, spaceId: identity.space.id, pageSize: 1 })).toMatchObject(
      { kind: 'success', value: { nextCursor: expect.any(String) } },
    );
    const acceptance = {
      ...context,
      proposalId: first.proposalId,
      scope: 'project' as const,
      spaceId: identity.space.id,
    };
    const accepted = await service().acceptProposal(acceptance);
    expect(accepted.kind).toBe('success');
    if (accepted.kind !== 'success') {
      throw new Error('Acceptance failed');
    }
    expect(accepted.value.item.sensitivity).toBe('normal');
    expect(await service().acceptProposal(acceptance)).toEqual(accepted);
    expect(
      await service().searchMemory({
        ...context,
        spaceId: identity.space.id,
        projectId: null,
        query: 'cache fix',
        limit: 10,
        matchingMode: 'hybrid',
        includeSpaceWide: false,
      }),
    ).toMatchObject({ kind: 'success', value: { items: [{ id: accepted.value.item.id }] } });
    expect(await browse()).toMatchObject({
      kind: 'success',
      value: { items: [{ item: { id: accepted.value.item.id } }] },
    });
    const captureContext = {
      deviceId: createDeviceId(),
      id: createCaptureContextId(),
      personId: createPersonId(),
      projectId: createProjectId(),
      scmAccountId: null,
      scmInstallationId: null,
      source: 'explicit' as const,
      spaceId: createSpaceId(),
    };
    expect(
      await kernel.configureReplication({ captureContext, localProjectId: projectId, localSpaceId: identity.space.id }),
    ).toMatchObject({ backfilled: 0 });
    const secondAcceptance = await service().acceptProposal({ ...acceptance, proposalId: changed.proposalId });
    expect(secondAcceptance.kind).toBe('success');
    const revised = await service().reviseMemoryItem({
      ...context,
      itemId: accepted.value.item.id,
      expectedCurrentRevisionId: accepted.value.revision.id,
      spaceId: identity.space.id,
      title: request.title,
      summary: 'Revised local guidance.',
      guidance: ['Keep a focused regression.'],
      structuredContent: { local: true },
      reason: 'Clarify',
    });
    expect(revised.kind).toBe('success');
    const revisedBrowse = await browse();
    expect(revisedBrowse.kind).toBe('success');
    if (revisedBrowse.kind === 'success') {
      expect(
        projectMemoryItemsBrowsePage(revisedBrowse.value).items.find((item) => item.id === accepted.value.item.id),
      ).toMatchObject({
        provenance: {
          sourceLocator: `Session account ${source.id}, element summary`,
          sourceKind: 'session',
          analysisRevision: source.revision,
        },
      });
    }
    const itemQuery = { ...context, itemId: accepted.value.item.id, spaceId: identity.space.id };
    const beforeReopen = await service().getMemoryItem(itemQuery);
    expect(beforeReopen.kind).toBe('success');
    const exportQuery = { ...context, format: 'jsonl' as const, spaceId: identity.space.id };
    const exportedBeforeReopen = await service().exportMemory(exportQuery);
    expect(exportedBeforeReopen).toMatchObject({ kind: 'success', value: { itemCount: 2 } });
    await kernel.close();
    kernel = await openLocalIdentityKernel({ databasePath });
    expect(await kernel.distillation.get(projectId, source.id)).toEqual(source);
    expect(await service().getMemoryItem(itemQuery)).toEqual(beforeReopen);
    expect(await browse()).toEqual(revisedBrowse);
    expect(await service().exportMemory(exportQuery)).toEqual(exportedBeforeReopen);
    expect(await promotion()(request, context)).toEqual(first);
    expect(
      await kernel.configureReplication({ captureContext, localProjectId: projectId, localSpaceId: identity.space.id }),
    ).toMatchObject({ backfilled: 0 });
    const count = () => {
      const db = new Database(databasePath, { readonly: true });
      try {
        return db.query('SELECT COUNT(*) AS count FROM replication_outbox_events').get();
      } finally {
        db.close();
      }
    };
    expect(count()).toEqual({ count: 0 });
    expect(
      await service().purgeMemoryItem({ ...context, itemId: accepted.value.item.id, spaceId: identity.space.id }),
    ).toMatchObject({ kind: 'success' });
    expect(count()).toEqual({ count: 0 });
    const beforeDenied = reads;
    await expect(
      promotion()(request, { ...context, principal: { kind: 'person', personId: createPersonId() } }),
    ).rejects.toThrow('forbidden');
    expect(reads).toBe(beforeDenied);
    await expect(promotion()({ ...request, projectId: createProjectId() }, context)).rejects.toThrow(
      'analysis-not-found',
    );
    await expect(promotion()({ ...request, elementKey: 'invented' }, context)).rejects.toThrow('element-not-found');
  } finally {
    await kernel.close();
    await rm(root, { recursive: true, force: true });
  }
});
