import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLocalGitRepository } from '@ai-usage/local-machine/local-git';
import { type LocalIdentityKernel, openLocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import {
  createCheckoutId,
  createProjectId,
  createRepositoryAliasId,
  createRepositoryId,
  instantNow,
} from '@ai-usage/platform-core/identity';
import type { CheckoutResolutionAction } from '@ai-usage/project-registry/review';
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

/**
 * What the projection publishes for a linked worktree: the parent repository's
 * project source id and name, while `source.sourcePath` stays the worktree.
 */
const worktreeRow = (name: string, sourcePath: string, canonicalSourcePath: string): SerializedRow => ({
  ...sessionRow(name, sourcePath),
  project: path.basename(canonicalSourcePath),
  projectSourceId: `${machine.id}|${canonicalSourcePath}`,
});

const createEventRuntime = () => {
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
  return { emit, returned: () => returned, runtime };
};

const observedSummary = (diagnostic: CheckoutObservationDiagnostic) => {
  if (diagnostic.code !== 'observed') {
    throw new Error(`Expected an observed diagnostic, received ${diagnostic.code}`);
  }
  return diagnostic.summary;
};

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
  /** A linked git worktree: `.git` is a file pointing into the repository's `.git/worktrees`. */
  const worktree = async (localPath: string, repositoryPath: string): Promise<string> => {
    await mkdir(localPath, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(localPath, '.git'),
      `gitdir: ${path.join(repositoryPath, '.git', 'worktrees', path.basename(localPath))}\n`,
      { mode: 0o600 },
    );
    return localPath;
  };
  const kernel = await openLocalIdentityKernel({ databasePath: memoryDatabasePath });
  const observe = async () => observedSummary(await observeLocalCheckouts({ databasePath, kernel }));
  return { checkout, checkoutsRoot, databasePath, kernel, observe, publish, root, worktree };
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
    const { emit, returned, runtime } = createEventRuntime();

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
    expect(returned()).toBe(1);
    await kernel.close();
    expect(diagnostics).toHaveLength(3);
  });

  test('keeps queued runs alive when the diagnostic sink rejects an in-flight run', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const alpha = await fixture.checkout('alpha', 'git@github.com:Example/Alpha.git');
    await fixture.publish([sessionRow('alpha-1', alpha)]);
    const diagnostics: CheckoutObservationDiagnostic[] = [];
    const rejected: string[] = [];
    const { returned, runtime } = createEventRuntime();

    const observation = startLocalCheckoutObservation({
      databasePath: fixture.databasePath,
      kernel,
      reportDiagnostic: (diagnostic) => {
        // The first run's sink throws for the observation and again for the
        // failure report, so the run itself rejects.
        if (rejected.length < 2) {
          rejected.push(diagnostic.code);
          throw new Error('diagnostic sink failed');
        }
        diagnostics.push(diagnostic);
      },
      runtime,
    });
    // Queued behind the rejecting start-up run: it must still execute.
    await observation.runNow();
    expect(rejected).toEqual(['observed', 'failed']);
    expect(diagnostics).toHaveLength(1);
    expect(observedSummary(diagnostics[0]!)).toMatchObject({ created: 0, observed: 1, resolved: 0 });

    await observation.runNow();
    expect(diagnostics).toHaveLength(2);

    await observation.dispose();
    expect(returned()).toBe(1);
    await kernel.close();
  });

  test('observes the canonical repository of a nested worktree and binds the worktree to its Repository Project', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const spaceId = (await kernel.getBootstrapIdentity()).space.id;
    const repo = await fixture.checkout('repo', 'git@github.com:Example/Repo.git');
    const worktree = await fixture.worktree(path.join(repo, '.claude', 'worktrees', 'feature'), repo);
    // Only the worktree has sessions; the projection publishes them under the
    // parent repository's id, and no row names the parent itself.
    const revision = await fixture.publish([
      worktreeRow('feature-1', worktree, repo),
      worktreeRow('feature-2', worktree, repo),
    ]);

    const first = await fixture.observe();
    expect(first).toEqual({
      ambiguous: 0,
      created: 2,
      invalid: 0,
      mapped: 2,
      missing: 0,
      observed: 2,
      resolved: 2,
      revision,
    });
    const canonicalMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${repo}`);
    const worktreeMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${worktree}`);
    expect(canonicalMapping).not.toBeNull();
    expect(worktreeMapping?.projectId).toBe(canonicalMapping!.projectId);
    expect(worktreeMapping?.checkoutId).not.toBe(canonicalMapping!.checkoutId);
    expect(await kernel.listResolutionReviews(spaceId)).toEqual([]);
    expect(await kernel.listRepositoryCandidates(spaceId)).toHaveLength(1);

    const projects = await kernel.distillation.projects(50, null);
    expect(projects.items.map((item) => item.displayName)).toEqual(['Example/Repo']);
    expect(projects.items[0]!.checkouts.map((entry) => [entry.path, entry.projectSourceId]).sort()).toEqual([
      [repo, `${machine.id}|${repo}`],
      [worktree, `${machine.id}|${worktree}`],
    ]);
    for (const value of [worktree, path.join(worktree, 'packages', 'nested')]) {
      const selected = await kernel.distillation.projects(2, null, { kind: 'checkout', value });
      expect(selected.items.map((item) => item.projectId)).toEqual([canonicalMapping!.projectId]);
      expect(selected.items[0]!.checkouts.map((entry) => entry.projectSourceId)).toContain(`${machine.id}|${repo}`);
    }

    const second = await fixture.observe();
    expect(second).toEqual({ ...first, created: 0, mapped: 0, resolved: 0 });
    await kernel.close();
  });

  test('binds an out-of-tree linked worktree without a readable remote to its canonical Repository Project', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const spaceId = (await kernel.getBootstrapIdentity()).space.id;
    const repo = await fixture.checkout('repo', 'git@github.com:Example/Repo.git');
    const linked = await fixture.worktree(path.join(fixture.checkoutsRoot, 'repo-feature'), repo);
    // The engine's bounded reader only accepts a `.git` directory: a linked
    // worktree outside the repository reads as having no repository at all.
    expect(readLocalGitRepository(linked)).toBeNull();
    await fixture.publish([sessionRow('repo-1', repo), worktreeRow('feature-1', linked, repo)]);

    expect(await fixture.observe()).toMatchObject({ ambiguous: 0, created: 2, mapped: 2, observed: 2, resolved: 2 });
    const projects = await kernel.distillation.projects(50, null);
    expect(projects.items.map((item) => item.displayName)).toEqual(['Example/Repo']);
    expect(projects.items[0]!.checkouts.map((entry) => entry.path).sort()).toEqual([repo, linked].sort());
    const linkedMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${linked}`);
    expect(linkedMapping).not.toBeNull();
    expect(projects.items[0]!.projectId).toBe(linkedMapping!.projectId);
    expect(await kernel.listRepositoryCandidates(spaceId)).toHaveLength(1);
    await kernel.close();
  });

  test('relinks a worktree that an earlier run bound to its own local Project and never touches a remote-bearing Checkout', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const bootstrap = await kernel.getBootstrapIdentity();
    const spaceId = bootstrap.space.id;
    const repo = await fixture.checkout('repo', 'git@github.com:Example/Repo.git');
    const linked = await fixture.worktree(path.join(fixture.checkoutsRoot, 'repo-feature'), repo);
    // Before the projection published canonical ids the worktree's rows carried
    // its own path, so the earlier runtime made it a remote-less local Project.
    await fixture.publish([sessionRow('repo-1', repo), sessionRow('feature-1', linked)]);
    expect(await fixture.observe()).toMatchObject({ created: 2, mapped: 2, resolved: 2 });
    expect((await kernel.distillation.projects(50, null)).items.map((item) => item.displayName)).toEqual([
      'Example/Repo',
      'repo-feature',
    ]);
    const repoMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${repo}`);
    const staleMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${linked}`);
    expect(staleMapping).not.toBeNull();
    expect(staleMapping!.projectId).not.toBe(repoMapping!.projectId);

    // A Checkout bound to a local Project while carrying its own remote (an
    // operator's review decision) is never relinked, whatever its published id.
    const reviewed = await fixture.checkout('reviewed', 'https://github.com/Example/Reviewed');
    const reviewedProjectId = createProjectId();
    await kernel.createProject({
      displayName: 'Reviewed decision',
      id: reviewedProjectId,
      kind: 'local',
      owningSpaceId: spaceId,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    });
    const reviewedCheckoutId = createCheckoutId();
    await kernel.upsertCheckout(spaceId, {
      deviceId: bootstrap.device.id,
      id: reviewedCheckoutId,
      lastObservedAt: instantNow(),
      localPath: reviewed,
      observedRemote: 'https://github.com/Example/Reviewed',
      projectId: reviewedProjectId,
      repositoryId: null,
      status: 'available',
    });

    const revision = await fixture.publish([
      sessionRow('repo-1', repo),
      worktreeRow('feature-1', linked, repo),
      worktreeRow('reviewed-1', reviewed, repo),
    ]);
    const repaired = await fixture.observe();
    expect(repaired).toEqual({
      ambiguous: 0,
      created: 0,
      invalid: 0,
      mapped: 2,
      missing: 0,
      observed: 3,
      resolved: 1,
      revision,
    });
    expect((await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${linked}`))?.projectId).toBe(
      repoMapping!.projectId,
    );
    expect(await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${reviewed}`)).toMatchObject({
      checkoutId: reviewedCheckoutId,
      projectId: reviewedProjectId,
    });
    const projects = await kernel.distillation.projects(50, null);
    expect(projects.items.map((item) => item.displayName)).toEqual(['Example/Repo', 'Reviewed decision']);
    expect(projects.items[0]!.checkouts.map((entry) => entry.path).sort()).toEqual([repo, linked].sort());
    expect(await kernel.listRepositoryCandidates(spaceId)).toHaveLength(1);

    expect(await fixture.observe()).toEqual({ ...repaired, mapped: 0, resolved: 0 });
    await kernel.close();
  });

  test('resolves a worktree on its own when its canonical Checkout has no Repository', async () => {
    const fixture = await createFixture();
    const spaceId = (await fixture.kernel.getBootstrapIdentity()).space.id;
    const plain = await fixture.checkout('plain', null);
    const nested = await fixture.worktree(path.join(plain, '.claude', 'worktrees', 'feature'), plain);
    await fixture.publish([sessionRow('plain-1', plain), worktreeRow('feature-1', nested, plain)]);
    const actions: CheckoutResolutionAction['kind'][] = [];
    const kernel: LocalIdentityKernel = {
      ...fixture.kernel,
      applyResolutionAction: (action) => {
        actions.push(action.kind);
        return fixture.kernel.applyResolutionAction(action);
      },
    };

    const summary = observedSummary(await observeLocalCheckouts({ databasePath: fixture.databasePath, kernel }));
    expect(summary).toMatchObject({ ambiguous: 0, created: 2, invalid: 0, mapped: 2, observed: 2, resolved: 2 });
    expect(actions).toEqual(['create-project', 'create-project']);
    const projects = await kernel.distillation.projects(50, null);
    expect(projects.items.map((item) => item.displayName)).toEqual(['feature', 'plain']);
    const nestedMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${nested}`);
    const plainMapping = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${plain}`);
    expect(nestedMapping?.projectId).not.toBe(plainMapping?.projectId);
    const selected = await kernel.distillation.projects(2, null, { kind: 'checkout', value: nested });
    expect(selected.items.map((item) => item.displayName)).toEqual(['feature']);
    await fixture.kernel.close();
  });

  test('collapses a trailing-separator source path into one Checkout and acknowledges every published id', async () => {
    const fixture = await createFixture();
    const { kernel } = fixture;
    const spaceId = (await kernel.getBootstrapIdentity()).space.id;
    const plain = await fixture.checkout('plain', null);
    const revision = await fixture.publish([sessionRow('plain-1', plain), sessionRow('plain-2', `${plain}/`)]);

    expect(await fixture.observe()).toEqual({
      ambiguous: 0,
      created: 1,
      invalid: 0,
      mapped: 2,
      missing: 0,
      observed: 1,
      resolved: 1,
      revision,
    });
    const exact = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${plain}`);
    const trailing = await kernel.findProjectSourceMapping(spaceId, `${machine.id}|${plain}/`);
    expect(exact).not.toBeNull();
    expect(trailing).toMatchObject({ checkoutId: exact!.checkoutId, projectId: exact!.projectId });
    const selected = await kernel.distillation.projects(2, null, {
      kind: 'checkout',
      value: path.join(plain, 'src'),
    });
    expect(selected.items.map((item) => item.displayName)).toEqual(['plain']);
    expect(selected.items[0]!.checkouts.map((entry) => entry.path)).toEqual([plain, plain]);
    await kernel.close();
  });
});
