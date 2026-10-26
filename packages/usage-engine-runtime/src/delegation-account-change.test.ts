import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import type { DelegationQualification, DelegationRoute } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import type { DelegationExecutorHarness } from '@ai-usage/report-core/delegation-vocabulary';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { EXECUTOR_BOUNDS, type ExecutorObservation } from '@ai-usage/report-core/work-executors';
import type { UsageEngineDelegationQualificationOutput } from '@ai-usage/usage-engine-control';
import {
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService, type DelegationServiceOptions } from './delegation';
import type { FindReviewProcesses } from './review-attempts-process';
import type { RoutingQualificationExecutorRun } from './runtime';

/**
 * The quota invalidation after an account change must not depend on how many executor observations
 * the store retains (PR #73 defect F3). Observations enter through the real import, so pruning is the
 * store's real retention; quota enters through the real provider-quota store the engine reads; the
 * engine's own `qualify` command is what decides. No process is spawned and no provider is called.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';
/** The account the quota was collected under. */
const ACCOUNT_A = '0123456789abcdef';
/** The account the operator signed in to afterwards and pinned in the declaration. */
const ACCOUNT_B = 'fedcba9876543210';
/** A third account, never pinned. */
const ACCOUNT_C = '00ff00ff00ff00ff';
const CLAUDE_ROUTE = `declared:${JSON.stringify([machine.id, 'claude-code', 'personal'])}`;
const CODEX_ROUTE = `declared:${JSON.stringify([machine.id, 'codex', 'work'])}`;
const RUN: RoutingQualificationExecutorRun = { source: null, startedAt: NOW };
const scanAbsent: FindReviewProcesses = async () => ({ kind: 'absent' });

interface Fixture {
  readonly checkout: string;
  readonly dbPath: string;
  readonly home: string;
  readonly privateRoot: string;
  readonly storage: ReturnType<typeof createLocalHistoryStorage>;
}

const declarationFor = (
  harness: DelegationExecutorHarness,
  accountScope: string,
  accountFingerprint?: string,
): Record<string, unknown> => ({
  ...(accountFingerprint === undefined ? {} : { accountFingerprint }),
  accountScope,
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  harness,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
});

/** A Claude Code observation at `observedAt`; `null` fingerprint means the CLI reported no identity. */
const claudeObservation = (observedAt: string, accountFingerprint: string | null): ExecutorObservation => ({
  ...(accountFingerprint === null ? {} : { accountFingerprint }),
  authEvidence: 'claude auth status exit 0',
  authMethod: 'claude.ai',
  authState: 'logged-in',
  binaryPath: '/usr/local/bin/claude-code',
  harness: 'claude-code',
  machineId: machine.id,
  observedAt,
  outcome: 'observed',
  version: '2.1.306 (Claude Code)',
});

/** A Codex observation: the CLI exposes no account identity, so it never carries a fingerprint. */
const codexObservation = (observedAt: string): ExecutorObservation => ({
  authEvidence: 'codex login status exit 0',
  authMethod: null,
  authState: 'logged-in',
  binaryPath: '/usr/local/bin/codex',
  harness: 'codex',
  machineId: machine.id,
  observedAt,
  outcome: 'observed',
  version: 'codex-cli 0.164.0',
});

const quotaFor = (providerKey: 'claude' | 'codex', observedAt: string, remainingPercent: number) => ({
  observation: {
    accountScope: null,
    machineId: machine.id,
    machineLabel: machine.label,
    observedAt,
    plan: providerKey === 'claude' ? 'max' : 'plus',
    providerGeneratedAt: null,
    providerKey,
    providerLabel: providerKey === 'claude' ? 'Claude' : 'Codex',
    source: { confidence: 'authoritative', key: `fixture-${providerKey}`, mode: 'poll' },
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: '5h',
        id: 'five_hour',
        label: '5h',
        limitSeconds: 18_000,
        remainingPercent,
        resetsAt: '2026-10-25T13:00:00.000Z',
        scope: 'global',
        usedPercent: 100 - remainingPercent,
      },
    ],
  } satisfies ProviderQuotaObservation,
  sourceEventKey: `fixture-${providerKey}-${observedAt}`,
});

const importObservations = (dbPath: string, observations: readonly ExecutorObservation[]) =>
  Effect.runPromise(importExecutorObservations({ dbPath, observations }));

const importQuota = (dbPath: string, providerKey: 'claude' | 'codex', observedAt: string, remainingPercent: number) =>
  Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [quotaFor(providerKey, observedAt, remainingPercent)],
    }),
  );

/** A fixture whose Claude declaration pins `ACCOUNT_B` and whose Codex declaration pins nothing. */
const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-delegation-account-change-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'work', 'checkout');
  const dbPath = path.join(root, 'state', 'usage.sqlite');
  const privateRoot = path.join(root, 'state', 'delegation');
  await mkdir(checkout, { recursive: true });
  const git = async (...args: string[]): Promise<void> => {
    const run = Bun.spawn(['git', ...args], {
      cwd: checkout,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
      },
      stderr: 'ignore',
      stdout: 'ignore',
    });
    if ((await run.exited) !== 0) {
      throw new Error(`git ${args.join(' ')} failed in the fixture`);
    }
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  for (const [index, content] of ['one\n', 'one\ntwo\n'].entries()) {
    await writeFile(path.join(checkout, 'a.txt'), content);
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', `commit ${index + 1}`);
  }
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    `${JSON.stringify(
      {
        delegation: {
          routes: [
            { accountScope: 'personal', context: 'personal', harness: 'claude-code' },
            { accountScope: 'work', context: 'professional', harness: 'codex' },
          ],
        },
        github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
        routing: {
          executors: [declarationFor('claude-code', 'personal', ACCOUNT_B), declarationFor('codex', 'work')],
          reviewTargets: [{ checkoutPath: path.join(root, 'work'), label: 'fixture' }],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: new Date(NOW) }));
  return { checkout, dbPath, home, privateRoot, storage };
};

/** A fresh service instance: what an engine restart gives, on the same database file. */
const service = (fixture: Fixture) => {
  const options: DelegationServiceOptions = {
    adapterOptions: { env: { HOME: fixture.home, PATH: process.env.PATH } },
    dbPath: fixture.dbPath,
    findProcesses: scanAbsent,
    machine: () => machine,
    now: () => new Date(NOW),
    privateRoot: fixture.privateRoot,
    probeClaudeAccount: () => Promise.resolve({ accountFingerprint: ACCOUNT_B, evidence: 'fixture' }),
    probeCodexAuth: () =>
      Promise.resolve({
        authMethod: 'chatgpt',
        authState: 'logged-in',
        evidence: 'codex login status exit 0 authMethod=chatgpt (fixture)',
        outcome: 'observed',
      }),
    report: () => undefined,
    storage: fixture.storage,
  };
  return createDelegationService(options);
};

const qualificationOf = (output: UsageEngineDelegationQualificationOutput): DelegationQualification => {
  const parsed = parseDelegationQualification(output.qualification);
  if (parsed === null) {
    throw new Error('the engine produced a qualification that does not parse');
  }
  return parsed;
};

const qualify = async (engine: ReturnType<typeof service>, fixture: Fixture): Promise<DelegationQualification> =>
  qualificationOf(
    await engine.qualify(
      {
        command: 'qualify-delegation',
        purpose: 'delegation',
        request: {
          action: 'read-only-review',
          checkout: { path: fixture.checkout },
          constraints: ['Do not run tests'],
          criteria: ['The change is explained'],
          objective: 'Review the latest commit of the fixture for correctness',
          schemaVersion: 1,
          scope: { commit: 'HEAD', kind: 'commit' },
          taskCategory: 'correctness',
        },
      },
      RUN,
    ),
  );

const routeOf = (qualification: DelegationQualification, routeId: string): DelegationRoute => {
  const route = qualification.routes.find((entry) => entry.routeId === routeId);
  if (route === undefined) {
    throw new Error(`route ${routeId} missing from ${qualification.routes.map((entry) => entry.routeId).join(', ')}`);
  }
  return route;
};

const at = (second: number): string => `2026-10-25T09:59:${String(second).padStart(2, '0')}.000Z`;

/**
 * The defect's scenario: account A observed, quota collected under A, then account B signed in and
 * pinned. The first qualification refuses the stale quota; the refreshes that follow prune A out of
 * the retained history.
 */
const changeAccountAndPruneHistory = async (
  fixture: Fixture,
): Promise<{ readonly first: DelegationQualification; readonly retained: readonly ExecutorObservation[] }> => {
  await importObservations(fixture.dbPath, [claudeObservation('2026-10-25T09:58:00.000Z', ACCOUNT_A)]);
  await importQuota(fixture.dbPath, 'claude', at(0), 70);
  await importObservations(fixture.dbPath, [claudeObservation(at(1), ACCOUNT_B)]);
  const first = await qualify(service(fixture), fixture);
  if (!routeOf(first, CLAUDE_ROUTE).blockers.includes('quota-before-account-change')) {
    throw new Error('precondition: the first qualification must refuse the quota collected under account A');
  }
  // More refreshes of B than the store retains per executor: A leaves the history.
  const refreshes = EXECUTOR_BOUNDS.maxRetainedPerExecutor;
  await importObservations(
    fixture.dbPath,
    Array.from({ length: refreshes }, (_, index) => claudeObservation(at(2 + index), ACCOUNT_B)),
  );
  const history = await Effect.runPromise(
    queryExecutorObservationHistory({ dbPath: fixture.dbPath, harness: 'claude-code', machineId: machine.id }),
  );
  if (history.observations.some((entry) => entry.accountFingerprint !== ACCOUNT_B)) {
    throw new Error('precondition: account A must have been pruned from the retained history');
  }
  return { first, retained: history.observations };
};

const barriers = (dbPath: string) => Effect.runPromise(queryExecutorAccountChanges({ dbPath, machineId: machine.id }));

describe('delegation qualification after an account change (F3)', () => {
  test('a quota collected under the previous account stays refused after the change is pruned from the history', async () => {
    const fixture = await createFixture();
    const { first, retained } = await changeAccountAndPruneHistory(fixture);
    const before = routeOf(first, CLAUDE_ROUTE);
    expect(before.identity).toMatchObject({ declared: ACCOUNT_B, observed: ACCOUNT_B, state: 'confirmed' });
    expect(before.blockers).toContain('quota-before-account-change');
    expect(retained).toHaveLength(EXECUTOR_BOUNDS.maxRetainedPerExecutor);
    expect(retained.every((entry) => entry.accountFingerprint === ACCOUNT_B)).toBe(true);

    const pruned = await qualify(service(fixture), fixture);
    const route = routeOf(pruned, CLAUDE_ROUTE);
    // The identity is confirmed (the pin matches the current observation) and still the old quota is refused.
    expect(route.identity).toMatchObject({ declared: ACCOUNT_B, observed: ACCOUNT_B, state: 'confirmed' });
    expect(route.blockers).toContain('quota-before-account-change');
    expect(route.exclusions.join(' ')).toContain(`predates the account change observed ${at(1)}`);
    expect(pruned.admissibleRouteIds).not.toContain(CLAUDE_ROUTE);
    // The barrier the engine persisted with the imports, untouched by the pruning.
    const persisted = await barriers(fixture.dbPath);
    expect(persisted).toEqual({
      changes: [
        {
          accountFingerprint: ACCOUNT_B,
          changedAt: at(1),
          harness: 'claude-code',
          machineId: machine.id,
          observedAt: at(1 + EXECUTOR_BOUNDS.maxRetainedPerExecutor),
        },
      ],
      persisted: true,
      skipped: 0,
      truncated: false,
    });
  });

  test('the refusal survives an engine restart: a new service on the reopened database still refuses', async () => {
    const fixture = await createFixture();
    await changeAccountAndPruneHistory(fixture);

    // The engine reopens (and re-migrates, idempotently) the same file and builds a new service.
    await Effect.runPromise(initializeUsageStore({ dbPath: fixture.dbPath }));
    const restarted = await qualify(service(fixture), fixture);
    const route = routeOf(restarted, CLAUDE_ROUTE);
    expect(route.identity).toMatchObject({ state: 'confirmed' });
    expect(route.blockers).toContain('quota-before-account-change');
    expect(restarted.admissibleRouteIds).not.toContain(CLAUDE_ROUTE);
    expect((await barriers(fixture.dbPath)).changes.map((change) => [change.harness, change.changedAt])).toEqual([
      ['claude-code', at(1)],
    ]);
  });

  test('a quota observed after the change unblocks the route; the barrier is not a permanent block', async () => {
    const fixture = await createFixture();
    await changeAccountAndPruneHistory(fixture);

    await importQuota(fixture.dbPath, 'claude', at(30), 65);
    const recovered = await qualify(service(fixture), fixture);
    const route = routeOf(recovered, CLAUDE_ROUTE);
    expect(route.blockers).toEqual([]);
    expect(route.admissible).toBe(true);
    expect(route.quota.map((window) => window.observedAt)).toEqual([at(30)]);
    expect(recovered.admissibleRouteIds).toContain(CLAUDE_ROUTE);
  });

  test('an observation without a fingerprint is an unknown identity: never confirmed, never a cleared barrier', async () => {
    const fixture = await createFixture();
    await changeAccountAndPruneHistory(fixture);

    await importObservations(fixture.dbPath, [claudeObservation(at(20), null)]);
    const unknown = await qualify(service(fixture), fixture);
    const route = routeOf(unknown, CLAUDE_ROUTE);
    expect(route.identity).toMatchObject({ declared: ACCOUNT_B, observed: null, state: 'unobserved' });
    expect(route.identity?.state).not.toBe('confirmed');
    // The retained history no longer tells a change (its newest row carries no fingerprint); the barrier does.
    expect(route.blockers).toContain('quota-before-account-change');
    expect(unknown.admissibleRouteIds).not.toContain(CLAUDE_ROUTE);
    expect((await barriers(fixture.dbPath)).changes).toMatchObject([
      { accountFingerprint: ACCOUNT_B, changedAt: at(1), harness: 'claude-code' },
    ]);
  });

  test('an observation of another account than the pin contradicts the identity and moves the barrier', async () => {
    const fixture = await createFixture();
    await changeAccountAndPruneHistory(fixture);

    await importObservations(fixture.dbPath, [claudeObservation(at(30), ACCOUNT_C)]);
    const contradicted = await qualify(service(fixture), fixture);
    const route = routeOf(contradicted, CLAUDE_ROUTE);
    expect(route.identity).toMatchObject({ declared: ACCOUNT_B, observed: ACCOUNT_C, state: 'contradicted' });
    expect(route.blockers).toContain('identity-changed');
    expect(route.blockers).toContain('quota-before-account-change');
    expect(contradicted.admissibleRouteIds).not.toContain(CLAUDE_ROUTE);
    expect((await barriers(fixture.dbPath)).changes).toMatchObject([
      { accountFingerprint: ACCOUNT_C, changedAt: at(30), harness: 'claude-code', observedAt: at(30) },
    ]);
    // A quota collected after this second change does not make the route admissible either: the pin disagrees.
    await importQuota(fixture.dbPath, 'claude', at(40), 60);
    const stillContradicted = routeOf(await qualify(service(fixture), fixture), CLAUDE_ROUTE);
    expect(stillContradicted.blockers).toEqual(['identity-changed']);
  });

  test('a Codex route exposes no identity: not observable, no barrier, and its quota admits it as before', async () => {
    const fixture = await createFixture();
    await changeAccountAndPruneHistory(fixture);
    await importObservations(fixture.dbPath, [codexObservation(at(5))]);
    await importQuota(fixture.dbPath, 'codex', at(6), 80);

    const qualification = await qualify(service(fixture), fixture);
    const codex = routeOf(qualification, CODEX_ROUTE);
    expect(codex.identity).toEqual({ declared: null, observed: null, state: 'not-observable' });
    expect(codex.blockers).toEqual([]);
    expect(codex.admissible).toBe(true);
    expect(qualification.admissibleRouteIds).toEqual([CODEX_ROUTE]);
    // Codex observations carry no fingerprint, so no barrier row exists for it.
    expect((await barriers(fixture.dbPath)).changes.map((change) => change.harness)).toEqual(['claude-code']);
  });
});
