import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSingleUserAuthorizer } from '@ai-usage/authorization/single-user';
import { createMemoryApplicationService } from '@ai-usage/memory-service/application';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { memoryFingerprint } from '@ai-usage/memory-service/domain';
import {
  createMemoryServiceToken,
  loadMemoryServiceRendezvous,
  memoryServiceRendezvousPath,
} from '@ai-usage/memory-service/node';
import { openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import { createCheckoutId, createProjectId, instantNow } from '@ai-usage/platform-core/identity';
import { createLocalMemoryServiceHandler, startLocalMemoryService } from './memory-service-server';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-service-'));
  roots.push(stateDirectory);
  const kernel = await openLocalIdentityKernel({ databasePath: path.join(stateDirectory, 'memory.sqlite') });
  return { kernel, stateDirectory };
};

describe('local Memory service', () => {
  test('publishes a separate authenticated rendezvous and applies a bounded review action', async () => {
    const { kernel, stateDirectory } = await fixture();
    const bootstrap = await kernel.getBootstrapIdentity();
    const checkoutId = createCheckoutId();
    await kernel.upsertCheckout(bootstrap.space.id, {
      deviceId: bootstrap.device.id,
      id: checkoutId,
      lastObservedAt: instantNow(() => new Date('2026-08-29T12:00:00.000Z')),
      localPath: '/private/not-published',
      observedRemote: null,
      projectId: null,
      repositoryId: null,
      status: 'available',
    });
    await kernel.recordRepositoryResolution(bootstrap.space.id, checkoutId, {
      kind: 'unassigned',
      reason: 'no-remote',
      spaceId: bootstrap.space.id,
    });
    const token = createMemoryServiceToken('0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
    const service = await startLocalMemoryService({ kernel, stateDirectory, token });
    const rendezvousPath = memoryServiceRendezvousPath(stateDirectory);
    const client = createMemoryServiceClient({
      resolveRendezvous: async () => await loadMemoryServiceRendezvous(rendezvousPath),
    });

    const snapshot = await client.listResolutionReviews();
    expect(snapshot.spaceId).toBe(bootstrap.space.id);
    expect(snapshot.reviews).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('/private/not-published');
    expect(
      await client.applyResolutionAction({
        checkoutId,
        kind: 'leave-unassigned',
        spaceId: bootstrap.space.id,
      }),
    ).toEqual({ kind: 'left-unassigned' });
    expect((await client.listResolutionReviews()).reviews).toEqual([]);

    await service.dispose();
    await expect(loadMemoryServiceRendezvous(rendezvousPath)).rejects.toThrow();
    await kernel.close();
  });

  test('rejects non-loopback and unauthenticated handler calls before storage access', async () => {
    const { kernel } = await fixture();
    const token = createMemoryServiceToken('0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
    const handler = await createLocalMemoryServiceHandler({ kernel, token });
    const request = new Request('http://127.0.0.1/v1/repository-resolutions', {
      headers: { 'x-ai-usage-memory-protocol-version': '1' },
    });

    expect((await handler.handle(request, '127.0.0.1')).status).toBe(401);
    expect((await handler.handle(request, '192.0.2.1')).status).toBe(403);
    await kernel.close();
  });

  test('reviews one pending Memory proposal through the authenticated local protocol', async () => {
    const { kernel, stateDirectory } = await fixture();
    const bootstrap = await kernel.getBootstrapIdentity();
    const principal = { kind: 'person' as const, personId: bootstrap.person.id };
    const authorization = { activeSpaceId: bootstrap.space.id, trustedDevice: true } as const;
    const application = createMemoryApplicationService(
      createSingleUserAuthorizer({
        listKnownResources: async () =>
          (await kernel.memory.listAuthorizationResourceIds(bootstrap.space.id)).map((id) => ({
            id,
            kind: 'memory' as const,
            spaceId: bootstrap.space.id,
          })),
        localPersonId: bootstrap.person.id,
        personalSpaceId: bootstrap.space.id,
      }),
      kernel.memory,
      () => new Date('2026-08-29T12:00:00.000Z'),
    );
    const content = { source: 'synthetic local protocol' } as const;
    const observation = await application.recordObservation({
      authorization,
      captureContextId: null,
      content,
      fingerprint: memoryFingerprint(content),
      principal,
      projectId: null,
      sensitivity: 'normal',
      sourceKind: 'session',
      sourceLocator: 'synthetic:protocol',
    });
    if (observation.kind !== 'success') {
      throw new Error('Protocol fixture observation failed.');
    }
    const proposal = await application.createProposal({
      authorization,
      guidance: ['Review before accepting.'],
      observationIds: [observation.value.id],
      principal,
      projectId: null,
      proposedKind: 'constraint',
      sensitivity: 'normal',
      structuredContent: content,
      summary: 'The proposal remains pending.',
      title: 'Local protocol review',
      trustCandidate: 'harvest-accepted',
    });
    if (proposal.kind !== 'success') {
      throw new Error('Protocol fixture proposal failed.');
    }

    const token = createMemoryServiceToken('0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
    const service = await startLocalMemoryService({ kernel, stateDirectory, token });
    const client = createMemoryServiceClient({
      resolveRendezvous: async () => await loadMemoryServiceRendezvous(memoryServiceRendezvousPath(stateDirectory)),
    });
    const snapshot = await client.listProposalReviews();
    expect(snapshot.proposals).toHaveLength(1);
    expect(snapshot.proposals[0]).toMatchObject({
      proposalId: proposal.value,
      trustCandidate: 'harvest-accepted',
    });
    expect(snapshot.proposals[0]?.observationSources[0]).toMatchObject({
      sourceKind: 'session',
      sourceLocator: 'synthetic:protocol',
    });
    const accepted = await client.applyProposalReviewAction({
      kind: 'accept',
      proposalId: proposal.value,
      scope: 'space',
      spaceId: bootstrap.space.id,
    });
    expect(accepted.kind).toBe('accepted');
    expect((await client.listProposalReviews()).proposals).toEqual([]);
    if (accepted.kind !== 'accepted') {
      throw new Error('Protocol fixture proposal was not accepted.');
    }
    expect(await client.getMemoryItem({ itemId: accepted.itemId })).toMatchObject({
      item: { id: accepted.itemId, status: 'active', trust: 'harvest-accepted' },
      revision: { id: accepted.revisionId, title: 'Local protocol review' },
    });
    const revised = await application.reviseMemoryItem({
      authorization,
      expectedCurrentRevisionId: accepted.revisionId,
      guidance: ['Read an exact revision when its ID is supplied.'],
      itemId: accepted.itemId,
      principal,
      reason: 'exercise exact revision addressing',
      spaceId: bootstrap.space.id,
      structuredContent: { source: 'synthetic revised local protocol' },
      summary: 'The current revision changed after acceptance.',
      title: 'Revised local protocol Memory',
    });
    if (revised.kind !== 'success') {
      throw new Error('Protocol fixture revision failed.');
    }
    expect(await client.getMemoryItem({ itemId: accepted.itemId })).toMatchObject({
      item: { currentRevisionId: revised.value.revision.id },
      revision: { id: revised.value.revision.id, title: 'Revised local protocol Memory' },
    });
    expect(await client.getMemoryItem({ itemId: accepted.itemId, revisionId: accepted.revisionId })).toMatchObject({
      item: { currentRevisionId: revised.value.revision.id },
      revision: { id: accepted.revisionId, title: 'Local protocol review' },
    });
    expect(await client.searchMemory({ limit: 10, query: 'local protocol review' })).toMatchObject({
      items: [{ id: accepted.itemId, resourceKind: 'memory', status: 'active', trust: 'harvest-accepted' }],
    });
    const contextProjectId = createProjectId();
    expect(await client.getProjectContext({ limit: 10, projectId: contextProjectId })).toMatchObject({
      items: [{ item: { id: accepted.itemId, scope: 'space' } }],
      projectId: contextProjectId,
      truncated: false,
    });

    await service.dispose();
    await kernel.close();
  });
});
