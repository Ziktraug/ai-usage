import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryServiceClient } from '@ai-usage/memory-service/client';
import { loadMemoryServiceRendezvous, memoryServiceRendezvousPath } from '@ai-usage/memory-service/node';
import { openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import { createCheckoutId, createProjectId, instantNow } from '@ai-usage/platform-core/identity';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { createUsageReportPayload, deserializeUsageRow, type SerializedRow } from '@ai-usage/report-core/report-data';
import { sessionRowIdentity } from '@ai-usage/report-core/session-query';
import { importLocalRows, publishServedReportRevision, updateUsageMachineLabel } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createDistillationRuntime } from '../distillation-runtime';
import { createRandomMemoryServiceToken, startLocalMemoryService } from '../memory-service-server';

/** Disposable writer composition for deterministic integration tests and a manual synthetic skill smoke. */
export const createDistillationFixture = async (caseId = 'multi-attempt') => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-distillation-workflow-'));
  const homeDirectory = path.join(root, 'home');
  const stateDirectory = path.join(root, 'state');
  const databasePath = path.join(root, 'usage.sqlite');
  const memoryDatabasePath = path.join(stateDirectory, 'memory.sqlite');
  const fixtureRoot = path.resolve(import.meta.dir, '../../../../tools/fixtures/distillation');
  const corpus: { cases: { id: string; file: string; sessionId: string }[] } = JSON.parse(
    await readFile(path.join(fixtureRoot, 'corpus.json'), 'utf8'),
  );
  const source = corpus.cases.find((entry) => entry.id === caseId);
  if (!source) {
    await rm(root, { recursive: true, force: true });
    throw new Error('Unknown synthetic case');
  }
  const nativeDirectory = path.join(homeDirectory, '.codex/sessions/2026/10/04');
  await Promise.all([
    mkdir(nativeDirectory, { recursive: true, mode: 0o700 }),
    mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const sourceFile = path.join(nativeDirectory, `rollout-2026-10-04T12-00-00-${source.sessionId}.jsonl`);
  await writeFile(sourceFile, await readFile(path.join(fixtureRoot, source.file)), { mode: 0o600 });
  const machine = { id: 'synthetic-machine', label: 'Synthetic distillation machine' };
  const projectSourceId = `${machine.id}|/synthetic/ai-usage`;
  const stamp = new Date().toISOString();
  const row: SerializedRow = {
    activeDate: stamp,
    date: stamp,
    endDate: stamp,
    harness: 'Codex',
    provider: 'OpenAI',
    model: 'synthetic-model',
    name: `Synthetic ${caseId}`,
    sessionLabel: `Synthetic ${caseId}`,
    project: 'ai-usage',
    projectSourceId,
    source: {
      harnessKey: 'codex',
      machineId: machine.id,
      machineLabel: machine.label,
      sourceSessionId: source.sessionId,
      sourcePath: '/synthetic/ai-usage',
    },
    calls: 1,
    turns: 1,
    tools: 1,
    durationMs: null,
    linesAdded: null,
    linesDeleted: null,
    lineDelta: null,
    costActual: 0,
    costApprox: 0,
    costQuota: 0,
    costKnown: false,
    tokIn: 1,
    tokOut: 0,
    tokCr: 0,
    tokCw: 0,
    freshTokens: 1,
    tokenTotal: 1,
  };
  await Effect.runPromise(importLocalRows({ dbPath: databasePath, machine, rows: [deserializeUsageRow(row)] }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath: databasePath, machine }));
  const payload = createUsageReportPayload(
    { rows: [deserializeUsageRow(row)], tableRows: [deserializeUsageRow(row)], omittedRows: 0 },
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
  const revision = `distillation-fixture-${Date.now()}`;
  const publish = async (
    nextRevision: string,
    sourceAuthority: 'local-observed' | 'portable-opaque' = 'local-observed',
  ) =>
    await Effect.runPromise(
      publishServedReportRevision({
        dbPath: databasePath,
        revision: nextRevision,
        ttlMs: 3_600_000,
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: stamp,
          projectAliases: [],
          projectGroupConfigs: [],
          rows: [row],
          sourceAuthorities: [sourceAuthority],
          support,
        }),
      }),
    );
  await publish(revision);
  let kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
  const bootstrap = await kernel.getBootstrapIdentity();
  const projectId = createProjectId();
  const checkoutId = createCheckoutId();
  await kernel.createProject({
    kind: 'local',
    id: projectId,
    owningSpaceId: bootstrap.space.id,
    displayName: 'Synthetic ai-usage',
    repositoryId: null,
    repositorySubpath: null,
    status: 'active',
  });
  await kernel.upsertCheckout(bootstrap.space.id, {
    id: checkoutId,
    deviceId: bootstrap.device.id,
    projectId,
    repositoryId: null,
    localPath: '/synthetic/ai-usage',
    lastObservedAt: instantNow(),
    observedRemote: null,
    status: 'available',
  });
  await kernel.acknowledgeProjectSourceMapping(
    { projectId, projectSourceId, checkoutId, acknowledgedAt: instantNow() },
    bootstrap.space.id,
  );
  const start = () =>
    startLocalMemoryService({
      kernel,
      stateDirectory,
      token: createRandomMemoryServiceToken(),
      distillation: createDistillationRuntime({ kernel, databasePath, homeDirectory, connected: false }),
    });
  let service = await start();
  const client = createMemoryServiceClient({
    resolveRendezvous: () => loadMemoryServiceRendezvous(memoryServiceRendezvousPath(stateDirectory)),
  });
  let closed = false;
  return {
    root,
    homeDirectory,
    stateDirectory,
    databasePath,
    memoryDatabasePath,
    sourceFile,
    projectId,
    projectSourceId,
    nativeSessionId: source.sessionId,
    selection: { revision, rowId: sessionRowIdentity(row) },
    client,
    publish,
    kernel: () => kernel,
    restart: async () => {
      await service.dispose();
      await kernel.close();
      kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
      service = await start();
    },
    dispose: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await service.dispose();
      await kernel.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

if (import.meta.main) {
  const fixture = await createDistillationFixture(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify({ kind: 'synthetic-distillation-ready', homeDirectory: fixture.homeDirectory, stateDirectory: fixture.stateDirectory, databasePath: fixture.databasePath, projectId: fixture.projectId, selection: fixture.selection })}\n`,
  );
  process.on('SIGHUP', () => {
    fixture
      .restart()
      .then(() => process.stdout.write('synthetic-distillation-restarted\n'))
      .catch(() => {
        process.stderr.write('Synthetic restart failed.\n');
        process.exitCode = 1;
      });
  });
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await fixture.dispose();
}
