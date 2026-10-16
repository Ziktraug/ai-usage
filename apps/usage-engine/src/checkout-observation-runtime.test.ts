import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import { createRepositoryAliasId, createRepositoryId, instantNow } from '@ai-usage/platform-core/identity';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { createUsageReportPayload, deserializeUsageRow, type SerializedRow } from '@ai-usage/report-core/report-data';
import type { UsageEngineEvent } from '@ai-usage/usage-engine-control';
import { importLocalRows, publishServedReportRevision, updateUsageMachineLabel } from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import {
  type CheckoutObservationDiagnostic,
  observeLocalCheckouts,
  startLocalCheckoutObservation,
} from './checkout-observation-runtime';

const roots: string[] = [];
const machine = { id: 'observed-machine', label: 'Observed machine' };
const stamp = '2026-10-07T10:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const sessionRow = (
  name: string,
  sourcePath: string,
  harnessKey: 'claude' | 'codex' = 'codex',
  rowMachine: { readonly id: string; readonly label: string } = machine,
): SerializedRow => ({
  activeDate: stamp,
  date: stamp,
  endDate: stamp,
  harness: harnessKey === 'codex' ? 'Codex' : 'Claude Code',
  provider: harnessKey === 'codex' ? 'OpenAI' : 'Anthropic',
  model: 'synthetic-model',
  name,
  sessionLabel: name,
  project: path.basename(sourcePath),
  projectSourceId: `${rowMachine.id}|${sourcePath}`,
  source: {
    harnessKey,
    machineId: rowMachine.id,
    machineLabel: rowMachine.label,
    sourceSessionId: `${name}-session`,
    sourcePath,
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
});

const createFixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-checkout-observation-'));
  roots.push(root);
  const databasePath = path.join(root, 'usage.sqlite');
  const memoryDatabasePath = path.join(root, 'state', 'memory.sqlite');
  const checkoutsRoot = path.join(root, 'checkouts');
  await mkdir(checkoutsRoot, { recursive: true, mode: 0o700 });
  let imported = false;
  let revisionCounter = 0;
  const publish = async (rows: readonly SerializedRow[]): Promise<string> => {
    const usageRows = rows.map((row) => deserializeUsageRow(row));
    if (!imported) {
      await Effect.runPromise(importLocalRows({ dbPath: databasePath, machine, rows: usageRows }));
      await Effect.runPromise(updateUsageMachineLabel({ dbPath: databasePath, machine }));
      imported = true;
    }
    const payload = createUsageReportPayload(
      { rows: usageRows, tableRows: usageRows, omittedRows: 0 },
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
    revisionCounter += 1;
    const revision = `checkout-observation-${revisionCounter}`;
    await Effect.runPromise(
      publishServedReportRevision({
        dbPath: databasePath,
        revision,
        ttlMs: 3_600_000,
        assemble: () => ({
          configFingerprint: 'c'.repeat(64),
          generatedAt: stamp,
          projectAliases: [],
          projectGroupConfigs: [],
          rows: [...rows],
          sourceAuthorities: rows.map(() => 'local-observed' as const),
          support,
        }),
      }),
    );
    return revision;
  };
  const checkout = async (name: string, remote: string | null): Promise<string> => {
    const localPath = path.join(checkoutsRoot, name);
    await mkdir(localPath, { recursive: true, mode: 0o700 });
    if (remote !== null) {
      await mkdir(path.join(localPath, '.git'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(localPath, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`, {
        mode: 0o600,
      });
    }
    return localPath;
  };
  const kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
  return { checkout, checkoutsRoot, databasePath, kernel, publish, root };
};

const observedSummary = (diagnostic: CheckoutObservationDiagnostic) => {
  if (diagnostic.code !== 'observed') {
    throw new Error(`Expected an observed diagnostic, received ${diagnostic.code}`);
  }
  return diagnostic.summary;
};

describe('local Checkout observation', () => {
  test('reports no publication before the usage store has served a revision', async () => {
    const fixture = await createFixture();
    await Effect.runPromise(importLocalRows({ dbPath: fixture.databasePath, machine, rows: [] }));
    await Effect.runPromise(updateUsageMachineLabel({ dbPath: fixture.databasePath, machine }));
    expect(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel: fixture.kernel })).toEqual({
      code: 'no-publication',
    });
    await fixture.kernel.close();
  });

  test('binds observed Checkouts to Repository or local Projects, maps their sources, and stays idempotent', async () => {
    const fixture = await createFixture();
    const alpha = await fixture.checkout('alpha', 'git@github.com:Example/Alpha.git');
    const alphaWorktree = await fixture.checkout('alpha-worktree', 'https://github.com/Example/Alpha');
    const plain = await fixture.checkout('plain', null);
    const ghost = path.join(fixture.checkoutsRoot, 'ghost');
    const rows = [
      sessionRow('alpha-1', alpha),
      sessionRow('alpha-2', alpha),
      sessionRow('worktree-1', alphaWorktree),
      sessionRow('plain-1', plain, 'claude'),
      sessionRow('ghost-1', ghost),
      sessionRow('elsewhere', '/elsewhere', 'codex', { id: 'other-machine', label: 'Other machine' }),
      // A session run from the parent directory of every checkout: its local
      // Project must never make a nested checkout ambiguous.
      sessionRow('root-1', fixture.checkoutsRoot),
    ];
    const revision = await fixture.publish(rows);
    const { kernel } = fixture;
    const bootstrap = await kernel.getBootstrapIdentity();

    const first = observedSummary(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel }));
    expect(first).toEqual({
      ambiguous: 0,
      created: 5,
      invalid: 0,
      mapped: 4,
      missing: 1,
      observed: 5,
      resolved: 4,
      revision,
    });
    expect(await kernel.listResolutionReviews(bootstrap.space.id)).toEqual([]);

    const projects = await kernel.distillation.projects(50, null);
    expect(projects.nextCursor).toBeNull();
    expect(projects.items.map((item) => item.displayName).sort()).toEqual(['Example/Alpha', 'checkouts', 'plain']);
    const alphaProject = projects.items.find((item) => item.displayName === 'Example/Alpha')!;
    expect(alphaProject.checkouts.map((entry) => entry.path).sort()).toEqual([alpha, alphaWorktree].sort());
    expect(alphaProject.checkouts.map((entry) => entry.projectSourceId).sort()).toEqual(
      [`${machine.id}|${alpha}`, `${machine.id}|${alphaWorktree}`].sort(),
    );
    const byCheckout = await kernel.distillation.projects(2, null, {
      kind: 'checkout',
      value: path.join(alphaWorktree, 'packages', 'nested'),
    });
    expect(byCheckout.items.map((item) => item.projectId)).toEqual([alphaProject.projectId]);
    const repositories = await kernel.listRepositoryCandidates(bootstrap.space.id);
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.aliases.map((alias) => alias.normalizedRemote)).toEqual(['github.com/example/alpha']);
    expect(await kernel.findProjectSourceMapping(bootstrap.space.id, `${machine.id}|${ghost}`)).toBeNull();
    expect(await kernel.findProjectSourceMapping(bootstrap.space.id, 'other-machine|/elsewhere')).toBeNull();

    const second = observedSummary(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel }));
    expect(second).toEqual({ ...first, created: 0, mapped: 0, resolved: 0 });
    expect((await kernel.distillation.projects(50, null)).items).toHaveLength(3);
    expect(await kernel.listRepositoryCandidates(bootstrap.space.id)).toHaveLength(1);

    await mkdir(ghost, { recursive: true, mode: 0o700 });
    const third = observedSummary(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel }));
    expect(third).toEqual({ ...first, created: 0, mapped: 1, missing: 0, resolved: 1 });
    expect((await kernel.distillation.projects(50, null)).items.map((item) => item.displayName).sort()).toEqual([
      'Example/Alpha',
      'checkouts',
      'ghost',
      'plain',
    ]);
    await kernel.close();
  });

  test('reuses a known Repository, keeps a bound Project when its remote appears later, and never reopens a review', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const bootstrap = await kernel.getBootstrapIdentity();
    const spaceId = bootstrap.space.id;
    const knownRepositoryId = createRepositoryId();
    await kernel.createRepositoryWithAlias(
      {
        canonicalHost: 'github.com',
        canonicalName: 'Known',
        canonicalOwner: 'Example',
        id: knownRepositoryId,
        owningSpaceId: spaceId,
        provider: 'github',
        providerRepositoryId: null,
        status: 'active',
      },
      {
        firstObservedAt: instantNow(),
        id: createRepositoryAliasId(),
        lastObservedAt: instantNow(),
        normalizedRemote: 'github.com/example/known',
        owningSpaceId: spaceId,
        repositoryId: knownRepositoryId,
        source: 'manual',
      },
    );
    const known = await fixture.checkout('known', 'git@github.com:Example/Known.git');
    const late = await fixture.checkout('late', null);
    await fixture.publish([sessionRow('known-1', known), sessionRow('late-1', late)]);

    const first = observedSummary(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel }));
    expect(first).toMatchObject({ ambiguous: 0, created: 2, invalid: 0, mapped: 2, observed: 2, resolved: 2 });
    expect(await kernel.listRepositoryCandidates(spaceId)).toHaveLength(1);
    const knownProject = await kernel.findProjectByRepository(spaceId, knownRepositoryId, null);
    expect(knownProject?.displayName).toBe('Example/Known');
    const lateMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${late}`);
    expect(lateMapping).not.toBeNull();

    // The operator later adds a remote to the plain directory: the Checkout keeps
    // its local Project and mapping; no Repository or Project is created for it.
    await mkdir(path.join(late, '.git'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(late, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/Example/Late\n', {
      mode: 0o600,
    });
    const second = observedSummary(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel }));
    expect(second).toMatchObject({ created: 0, mapped: 0, observed: 2, resolved: 0 });
    expect(await kernel.listRepositoryCandidates(spaceId)).toHaveLength(1);
    expect(await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${late}`)).toEqual(lateMapping);
    expect(await kernel.listResolutionReviews(spaceId)).toEqual([]);
    expect((await kernel.distillation.projects(50, null)).items.map((item) => item.displayName).sort()).toEqual([
      'Example/Known',
      'late',
    ]);
    await kernel.close();
  });

  test('observes at start and after each report publication until disposed', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const alpha = await fixture.checkout('alpha', 'git@github.com:Example/Alpha.git');
    await fixture.publish([sessionRow('alpha-1', alpha)]);
    const diagnostics: CheckoutObservationDiagnostic[] = [];
    const waiters: (() => void)[] = [];
    const nextDiagnostic = () => new Promise<void>((resolve) => waiters.push(resolve));
    const pending: ((result: IteratorResult<UsageEngineEvent>) => void)[] = [];
    let returned = 0;
    const runtime = {
      changes: (): AsyncIterable<UsageEngineEvent> => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<UsageEngineEvent>>((resolve) => pending.push(resolve)),
          return: () => {
            returned += 1;
            for (const resolve of pending.splice(0)) {
              resolve({ done: true, value: undefined });
            }
            return Promise.resolve({ done: true as const, value: undefined });
          },
        }),
      }),
    };
    const emit = (event: UsageEngineEvent['event']) => {
      pending.shift()?.({ done: false, value: { event } as UsageEngineEvent });
    };

    const observation = startLocalCheckoutObservation({
      databasePath: fixture.databasePath,
      kernel,
      reportDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
        for (const resolve of waiters.splice(0)) {
          resolve();
        }
      },
      runtime,
    });
    await nextDiagnostic();
    expect(diagnostics).toHaveLength(1);
    expect(observedSummary(diagnostics[0]!)).toMatchObject({ created: 1, observed: 1, resolved: 1 });

    emit('status');
    const beta = await fixture.checkout('beta', null);
    const revision = await fixture.publish([sessionRow('alpha-1', alpha), sessionRow('beta-1', beta)]);
    emit('report-published');
    await nextDiagnostic();
    expect(diagnostics).toHaveLength(2);
    expect(observedSummary(diagnostics[1]!)).toMatchObject({ created: 1, observed: 2, resolved: 1, revision });

    await observation.runNow();
    expect(diagnostics).toHaveLength(3);
    expect(observedSummary(diagnostics[2]!)).toMatchObject({ created: 0, observed: 2, resolved: 0 });

    await observation.dispose();
    expect(returned).toBe(1);
    await kernel.close();
    expect(diagnostics).toHaveLength(3);
  });
});
