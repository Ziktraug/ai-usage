import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MEMORY_REDACTION_RULE_SET_VERSION, memoryContentHash } from '@ai-usage/memory-service/domain';
import { openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import {
  createMemoryObservationId,
  createProjectId,
  instantNow,
  parseMemoryProposalId,
} from '@ai-usage/platform-core/identity';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { createUsageReportPayload } from '@ai-usage/report-core/report-data';
import { importLocalRows, publishServedReportRevision, updateUsageMachineLabel } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createRandomMemoryServiceToken, startLocalMemoryService } from '../memory-service-server';

/** Disposable accepted-Memory browser fixture; it never reads native harness history. */
export const createMemoryFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-memory-browser-'));
  const homeDirectory = path.join(root, 'home');
  const stateDirectory = path.join(root, 'state');
  const databasePath = path.join(root, 'usage.sqlite');
  const memoryDatabasePath = path.join(stateDirectory, 'memory.sqlite');
  await Promise.all([
    mkdir(homeDirectory, { recursive: true, mode: 0o700 }),
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const machine = { id: 'synthetic-memory-machine', label: 'Synthetic Memory machine' };
  await Effect.runPromise(importLocalRows({ dbPath: databasePath, machine, rows: [] }));
  // An empty import records no rows, so the served report would lack its local machine identity.
  await Effect.runPromise(updateUsageMachineLabel({ dbPath: databasePath, machine }));
  const payload = createUsageReportPayload(
    { rows: [], tableRows: [], omittedRows: 0 },
    { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
  );
  const { rows: _rows, tableRows: _tableRows, ...baseSupport } = payload;
  const support: FocusedReportSupport = {
    ...baseSupport,
    machineFreshness: {
      kind: 'available',
      machines: [{ ...machine, lastSeenAt: payload.generatedAt }],
      observedAt: payload.generatedAt,
      omittedMachines: 0,
      skippedRows: 0,
    },
  };
  await Effect.runPromise(
    publishServedReportRevision({
      dbPath: databasePath,
      revision: 'synthetic-memory-browser',
      ttlMs: 3_600_000,
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: payload.generatedAt,
        projectAliases: [],
        projectGroupConfigs: [],
        rows: [],
        sourceAuthorities: [],
        support,
      }),
    }),
  );
  let kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
  const identity = await kernel.getBootstrapIdentity();
  const projectId = createProjectId();
  await kernel.createProject({
    id: projectId,
    displayName: 'Synthetic Memory Project',
    kind: 'local',
    owningSpaceId: identity.space.id,
    repositoryId: null,
    repositorySubpath: null,
    status: 'active',
  });
  const actor = { kind: 'person' as const, personId: identity.person.id };
  const legacyLocator = '/memory?view=analyses&analysis=historical-account&element=summary';
  const evidence = { evidence: `Synthetic historical quotation retained for review. ${'retained-source-'.repeat(40)}` };
  const observationId = createMemoryObservationId();
  await kernel.memory.recordObservation({
    audit: {
      action: 'record-observation',
      actor,
      recordedAt: instantNow(),
      result: 'applied',
      spaceId: identity.space.id,
      subjectId: observationId,
      subjectType: 'memory-observation',
    },
    observation: {
      id: observationId,
      captureContextId: null,
      content: evidence,
      contentHash: memoryContentHash(evidence),
      createdByPrincipal: actor,
      fingerprint: 'a'.repeat(64),
      observedAt: instantNow(),
      owningSpaceId: identity.space.id,
      projectId,
      redactionRuleSetVersion: MEMORY_REDACTION_RULE_SET_VERSION,
      sensitivity: 'normal',
      sourceKind: 'session',
      sourceLocator: legacyLocator,
    },
  });
  const seedProposal = async (index: number, title: string, withEvidence = false) => {
    const proposalId = parseMemoryProposalId(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    await kernel.memory.createProposal({
      audit: {
        action: 'create-memory-proposal',
        actor,
        recordedAt: instantNow(),
        result: 'applied',
        spaceId: identity.space.id,
        subjectId: proposalId,
        subjectType: 'memory-proposal',
      },
      observationIds: withEvidence ? [observationId] : [],
      proposal: {
        id: proposalId,
        owningSpaceId: identity.space.id,
        projectId,
        title,
        summary: 'Verify direct reads with recorded test output before reusing the lesson.',
        guidance: ['Run the focused regression before claiming the fix.'],
        structuredContent: withEvidence ? { sourceLocator: legacyLocator, evidence: evidence.evidence } : {},
        proposedByPrincipal: actor,
        proposedKind: 'lesson',
        reviewedAt: null,
        reviewedByPersonId: null,
        reviewReason: null,
        sensitivity: 'normal',
        status: 'pending',
        trustCandidate: 'explicit',
      },
    });
    return proposalId;
  };
  const proposalId = await seedProposal(1, 'Review direct reads before reusing the lesson', true);
  const rejectedProposalId = await seedProposal(2, 'Reject an unsupported recommendation');
  const start = () => startLocalMemoryService({ kernel, stateDirectory, token: createRandomMemoryServiceToken() });
  let service = await start();
  return {
    homeDirectory,
    stateDirectory,
    databasePath,
    projectId,
    proposalId,
    rejectedProposalId,
    legacyLocator,
    restart: async () => {
      await service.dispose();
      await kernel.close();
      kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
      service = await start();
    },
    seedReviewQueue: async () => {
      const proposalIds: string[] = [];
      for (let index = 100; index < 205; index += 1) {
        proposalIds.push(await seedProposal(index, `Queued lesson ${String(index).padStart(3, '0')}`));
      }
      const targetProposalId = await seedProposal(999, 'Run the focused regression first');
      return { proposalIds, targetProposalId };
    },
    dispose: async () => {
      await service.dispose();
      await kernel.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

if (import.meta.main) {
  const fixture = await createMemoryFixture();
  process.stdout.write(
    `${JSON.stringify({
      kind: 'synthetic-memory-ready',
      homeDirectory: fixture.homeDirectory,
      stateDirectory: fixture.stateDirectory,
      databasePath: fixture.databasePath,
      projectId: fixture.projectId,
      proposalId: fixture.proposalId,
      rejectedProposalId: fixture.rejectedProposalId,
      legacyLocator: fixture.legacyLocator,
    })}\n`,
  );
  const fail = () => {
    process.stderr.write('Synthetic Memory fixture operation failed.\n');
    process.exitCode = 1;
  };
  process.on('SIGHUP', () => {
    fixture
      .restart()
      .then(() => process.stdout.write('synthetic-memory-restarted\n'))
      .catch(fail);
  });
  process.once('SIGUSR2', () => {
    fixture
      .seedReviewQueue()
      .then((queue) => process.stdout.write(`${JSON.stringify({ kind: 'synthetic-review-queue-ready', ...queue })}\n`))
      .catch(fail);
  });
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await fixture.dispose();
}
