import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { parseSessionAnalysis } from '@ai-usage/platform-core/session-distillation';
import { openLocalIdentityKernel } from './identity';

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
    const fixtureAnalysis = parseSessionAnalysis(
      JSON.parse(
        await readFile(
          path.resolve(
            import.meta.dir,
            '../../../tools/fixtures/distillation/generated/integration/multi-attempt.persisted-analysis.json.txt',
          ),
          'utf8',
        ),
      ),
    );
    const packet = parseDistillationEvidencePacket(
      JSON.parse(
        await readFile(
          path.resolve(
            import.meta.dir,
            '../../../tools/fixtures/distillation/generated/initial/multi-attempt.review-packet.json.txt',
          ),
          'utf8',
        ),
      ),
    );
    packet.source.projectId = projectId;
    const selection = { revision: 'promotion-fixture', rowId: 'multi-attempt' };
    packet.source.reportAnchor = selection;
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
      content: fixtureAnalysis.content,
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
        provenance: { sourceLocator: first.sourceLocator, sourceKind: 'session', analysisRevision: source.revision },
      });
    }
    await kernel.close();
    kernel = await openLocalIdentityKernel({ databasePath });
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
