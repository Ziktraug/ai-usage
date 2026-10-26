import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ClaudeReviewLaunch,
  ClaudeReviewLaunchOptions,
  ClaudeReviewLaunchSpec,
  ClaudeReviewOutcome,
} from '@ai-usage/local-collectors/claude-review-launcher';
import {
  DELEGATION_HARNESS_CONTROLS,
  type ReviewWorkerAdapter,
  type ReviewWorkerOutcome,
  type ReviewWorkerSpec,
} from '@ai-usage/local-collectors/review-worker';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import type { DelegationQualification, DelegationRoute } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ReviewAttempt, ReviewAttemptScope, ReviewHarnessGuarantee } from '@ai-usage/report-core/work-attempts';
import { parseClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import { EXECUTOR_BOUNDS, type ExecutorObservation } from '@ai-usage/report-core/work-executors';
import type { UsageEngineCommand } from '@ai-usage/usage-engine-control';
import {
  importClaudeDesktopSessions,
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  queryExecutorAccountChanges,
  queryExecutorObservationHistory,
  queryReviewAttempts,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService, type DelegationService } from './delegation';
import { createReviewAttemptService, type ReviewAttemptService, type ReviewLauncher } from './review-attempts';
import type { FindReviewProcesses } from './review-attempts-process';
import type { RoutingQualificationExecutorRun } from './runtime';

/**
 * The legacy Work command (`start-review-attempt`) inherits what the common delegation policy
 * learned from PR #73 defects F2 and F3, because it runs the same assessment (F1). Real temporary
 * stores, real temporary git checkouts with the remotes under test, a real temporary home config,
 * and fake launchers that only count their spawns: every refusal here is proven to happen before
 * any process would start, and every admission spawns exactly once.
 *
 * - F3: an account change persisted as a barrier (`executor_account_changes`), not read from the
 *   retained observation history that the store's own retention prunes (`importExecutorObservations`
 *   keeps `EXECUTOR_BOUNDS.maxRetainedPerExecutor` rows). A quota collected under the previous
 *   account is refused through the legacy command and through `start-delegation` alike.
 * - F2: GitHub remotes identified by exact host whatever the URL spelling (`ssh://…:22/`), an
 *   unidentified remote (ssh alias) keeps a `forbid githubOwner` rule as an assumption, and a known
 *   absence of GitHub remotes lets the launch through.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';
/** The account the stale quota was collected under. */
const ACCOUNT_A = '0123456789abcdef';
/** The account signed in afterwards and pinned in the declaration. */
const ACCOUNT_B = 'fedcba9876543210';
const CLAUDE_ROUTE = `declared:${JSON.stringify([machine.id, 'claude-code', 'personal'])}`;
const RUN: RoutingQualificationExecutorRun = { source: null, startedAt: NOW };
const SOURCE_SESSION_ID = 'cli-1';
const GITHUB_REMOTE = 'git@github.com:acme/widgets.git';
const FORBID_ACME_ON_PERSONAL = {
  effect: 'forbid',
  id: 'no-acme-on-personal',
  match: { githubOwner: 'acme' },
  routes: { contexts: ['personal'] },
};
const scanAbsent: FindReviewProcesses = async () => ({ kind: 'absent' });

const at = (second: number): string => `2026-10-25T09:59:${String(second).padStart(2, '0')}.000Z`;

const FAKE_GUARANTEE: ReviewHarnessGuarantee = {
  cliVersion: '2.1.306',
  effort: null,
  managedSettings: 'absent',
  model: null,
  safeMode: true,
  settingSources: [],
  tools: ['Read', 'Grep', 'Glob'],
};

const FINISHED: ClaudeReviewOutcome = {
  durationMs: 10,
  exitCode: 0,
  failureReason: null,
  kind: 'finished',
  nativeSessionId: 'native-legacy',
  numTurns: 1,
  resultExcerpt: 'Finding 1: none.',
  resultKind: 'review',
};

interface LegacyLaunch {
  readonly options: ClaudeReviewLaunchOptions;
  readonly settle: (outcome: ClaudeReviewOutcome) => void;
  readonly spec: ClaudeReviewLaunchSpec;
}

/** The legacy Claude launcher as a fake: records every spawn request, settles when told. */
const fakeLauncher = () => {
  const launches: LegacyLaunch[] = [];
  const launcher: ReviewLauncher = async (spec, _events, options) => {
    let settle: (outcome: ClaudeReviewOutcome) => void = () => undefined;
    const outcome = new Promise<ClaudeReviewOutcome>((resolve) => {
      settle = resolve;
    });
    launches.push({ options, settle: (value) => settle(value), spec });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const scope: ReviewAttemptScope = {
      base: 'first-parent',
      baseSha: options.scope?.revision?.baseSha ?? 'c'.repeat(40),
      fileCount: 1,
      files: [
        { additions: 1, coverage: 'complete', deletions: 0, path: 'a.txt', previousPath: null, status: 'modified' },
      ],
      headSha: options.scope?.revision?.headSha ?? 'b'.repeat(40),
      includedBytes: 90,
      includedLines: 7,
      kind: 'commit',
      parentCount: 1,
      patchBytes: 90,
      patchLines: 7,
      patchSha256: 'd'.repeat(64),
      repositoryPrefix: '',
      subject: 'fixture',
      truncated: false,
      workingTreeDirty: false,
    };
    return {
      args: [],
      guarantee: FAKE_GUARANTEE,
      outcome,
      pid: 900_000 + launches.length,
      prompt: 'PROMPT',
      scope,
      terminate: () => undefined,
    } satisfies ClaudeReviewLaunch;
  };
  return { launcher, launches };
};

/** The delegation worker adapter as a fake: counts spawn requests; none is expected here. */
const fakeAdapter = () => {
  const launches: ReviewWorkerSpec[] = [];
  const adapter: ReviewWorkerAdapter = {
    harness: 'claude-code',
    launch: (spec) => {
      launches.push(spec);
      const outcome = new Promise<ReviewWorkerOutcome>(() => undefined);
      return Promise.resolve({
        args: [],
        guarantee: {
          cliVersion: '9.9.9',
          controls: [...DELEGATION_HARNESS_CONTROLS['claude-code'].controls],
          effort: spec.effort,
          harness: 'claude-code',
          limits: [...DELEGATION_HARNESS_CONTROLS['claude-code'].limits],
          model: spec.model,
        },
        outcome,
        pid: 4000 + launches.length,
        terminate: () => undefined,
      });
    },
  };
  return { adapter, launches };
};

interface Fixture {
  readonly checkout: string;
  readonly dbPath: string;
  readonly home: string;
  readonly privateRoot: string;
  readonly storage: ReturnType<typeof createLocalHistoryStorage>;
}

interface FixtureOptions {
  /** The `delegation` home section; defaults to one personal Claude route and no rule. */
  readonly delegation?: Record<string, unknown>;
  /** `accountFingerprint` pinned on the Claude declaration; unpinned when absent. */
  readonly pin?: string;
  /** The checkout's remotes; defaults to one identified GitHub remote. */
  readonly remotes?: readonly (readonly [name: string, url: string])[];
  /** Import one fresh Claude observation and one fresh quota (the admitting facts); the F3 test imports its own. */
  readonly seedFacts?: boolean;
}

const claudeObservation = (observedAt: string, accountFingerprint?: string): ExecutorObservation => ({
  ...(accountFingerprint === undefined ? {} : { accountFingerprint }),
  authEvidence: 'claude auth status exit 0 loggedIn=true',
  authMethod: 'claude.ai',
  authState: 'logged-in',
  binaryPath: '/usr/local/bin/claude',
  harness: 'claude-code',
  machineId: machine.id,
  observedAt,
  outcome: 'observed',
  version: '2.1.306 (Claude Code)',
});

const importObservations = (dbPath: string, observations: readonly ExecutorObservation[]) =>
  Effect.runPromise(importExecutorObservations({ dbPath, observations }));

const importQuota = (dbPath: string, observedAt: string, remainingPercent: number) => {
  const observation: ProviderQuotaObservation = {
    accountScope: null,
    machineId: machine.id,
    machineLabel: machine.label,
    observedAt,
    plan: 'max',
    providerGeneratedAt: null,
    providerKey: 'claude',
    providerLabel: 'Claude',
    source: { confidence: 'authoritative', key: 'fixture-claude', mode: 'poll' },
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
  };
  return Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [{ observation, sourceEventKey: `fixture-claude-${observedAt}` }],
    }),
  );
};

const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-review-policy-integration-'));
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
  for (const [name, url] of options.remotes ?? [['origin', GITHUB_REMOTE]]) {
    await git('remote', 'add', name, url);
  }
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
          routes: [{ accountScope: 'personal', context: 'personal', harness: 'claude-code' }],
          ...options.delegation,
        },
        github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
        routing: {
          executors: [
            {
              ...(options.pin === undefined ? {} : { accountFingerprint: options.pin }),
              accountScope: 'personal',
              authorization: 'allowed',
              capabilities: ['read-only-review'],
              declaredAt: '2026-10-21T08:00:00.000Z',
              harness: 'claude-code',
              quality: 'review-capable',
              subscription: 'verified',
              targets: [{ kind: 'any-local-session' }],
            },
          ],
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
  if (options.seedFacts !== false) {
    await importObservations(dbPath, [claudeObservation('2026-10-25T09:58:00.000Z', options.pin)]);
    await importQuota(dbPath, '2026-10-25T09:57:00.000Z', 70);
  }
  // The collected Claude Desktop session the legacy command targets; its cwd is the checkout.
  const desktop = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account-a',
    archived: false,
    branch: null,
    cliSessionId: SOURCE_SESSION_ID,
    completedTurns: 2,
    createdAt: '2026-10-21T08:00:00.000Z',
    cwd: checkout,
    declaredPullRequests: [],
    desktopSessionId: 'local_engine_one',
    effort: null,
    fileModifiedAt: '2026-10-25T09:00:00.000Z',
    filePath: '.config/Claude/claude-code-sessions/account-a/org-a/local_engine_one.json',
    format: 'claude-desktop-session-v1',
    lastActivityAt: '2026-10-25T09:00:00.000Z',
    lastTurnReport: null,
    machineId: machine.id,
    model: null,
    observedAt: '2026-10-25T09:05:00.000Z',
    openSuggestions: [],
    organizationDirectory: 'org-a',
    originCwd: null,
    priorCliSessionIds: [],
    resolvedSuggestions: {},
    sideSessionNotes: [],
    sourceBranch: null,
    spawnedFrom: null,
    title: 'Fixture: investigate the launcher',
    titleSource: 'auto',
    turnSummary: null,
    unsupportedReason: null,
    worktreePath: null,
    wrapUpDescription: null,
    writtenBranches: [],
  });
  if (desktop === null) {
    throw new Error('desktop fixture must parse');
  }
  await Effect.runPromise(
    importClaudeDesktopSessions({
      completeness: { filesParsed: 1, filesSeen: 1, rejected: 0, truncated: false, unsupported: 0 },
      dbPath,
      machineId: machine.id,
      observations: [desktop],
    }),
  );
  return { checkout, dbPath, home, privateRoot, storage };
};

interface Engines {
  readonly adapter: ReturnType<typeof fakeAdapter>;
  readonly delegation: DelegationService;
  readonly launcher: ReturnType<typeof fakeLauncher>;
  readonly legacy: ReviewAttemptService;
  /** Spawns requested through both entries together. */
  readonly spawns: () => number;
}

/** Both engine services over one store and one home, the way `live.ts` composes them. */
const engines = (fixture: Fixture, pin: string = ACCOUNT_B): Engines => {
  const adapter = fakeAdapter();
  const launcher = fakeLauncher();
  const probe = () => Promise.resolve({ accountFingerprint: pin, evidence: 'fixture' });
  const delegation = createDelegationService({
    adapterOptions: { env: { HOME: fixture.home, PATH: process.env.PATH } },
    adapters: [adapter.adapter],
    dbPath: fixture.dbPath,
    findProcesses: scanAbsent,
    machine: () => machine,
    now: () => new Date(NOW),
    privateRoot: fixture.privateRoot,
    probeClaudeAccount: probe,
    report: () => undefined,
    runLimits: { heartbeatMs: 25 },
    storage: fixture.storage,
  });
  const legacy = createReviewAttemptService({
    admission: delegation.admitReview,
    dbPath: fixture.dbPath,
    findProcesses: scanAbsent,
    launcher: launcher.launcher,
    machine: () => machine,
    now: () => new Date(NOW),
    probeAccount: probe,
    report: () => undefined,
    runLimits: { heartbeatMs: 25 },
    storage: fixture.storage,
  });
  return { adapter, delegation, launcher, legacy, spawns: () => adapter.launches.length + launcher.launches.length };
};

type LegacyCommand = Extract<UsageEngineCommand, { readonly command: 'start-review-attempt' }>;
const legacyCommand = (): LegacyCommand => ({
  action: 'read-only-review',
  candidateId: CLAUDE_ROUTE,
  command: 'start-review-attempt',
  target: { desktopSessionId: null, harness: 'claude', sourceSessionId: SOURCE_SESSION_ID },
});

type StartCommand = Extract<UsageEngineCommand, { readonly command: 'start-delegation' }>;

/** The request the legacy command amounts to: the checkout's HEAD against its first parent. */
const requestFor = (fixture: Fixture): Record<string, unknown> => ({
  action: 'read-only-review',
  checkout: { path: fixture.checkout },
  constraints: [],
  criteria: ['The change is explained'],
  objective: 'Review the latest commit of the fixture',
  schemaVersion: 1,
  scope: { commit: 'HEAD', kind: 'commit' },
  taskCategory: 'correctness',
});

const qualify = async (engine: DelegationService, fixture: Fixture): Promise<DelegationQualification> => {
  const output = await engine.qualify(
    { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) },
    RUN,
  );
  const parsed = parseDelegationQualification(output.qualification);
  if (parsed === null) {
    throw new Error('the engine produced a qualification that does not parse');
  }
  return parsed;
};

const routeOf = (qualification: DelegationQualification, routeId: string): DelegationRoute => {
  const route = qualification.routes.find((entry) => entry.routeId === routeId);
  if (route === undefined) {
    throw new Error(`route ${routeId} missing from ${qualification.routes.map((entry) => entry.routeId).join(', ')}`);
  }
  return route;
};

const startCommand = (
  idempotencyKey: string,
  fixture: Fixture,
  qualification: DelegationQualification,
): StartCommand => ({
  command: 'start-delegation',
  idempotencyKey,
  request: requestFor(fixture),
  selection: {
    kind: 'choice',
    qualificationId: qualification.qualificationId,
    routeId: CLAUDE_ROUTE,
    selectorVersion: 'calling-model/test',
  },
});

const attemptById = async (dbPath: string, attemptId: string): Promise<ReviewAttempt> => {
  const found = (await Effect.runPromise(queryReviewAttempts({ dbPath }))).attempts.find(
    (attempt) => attempt.attemptId === attemptId,
  );
  if (found === undefined) {
    throw new Error(`attempt ${attemptId} is missing`);
  }
  return found;
};

/** The legacy command's answer, the spawns requested by then, and the row it recorded; the tests assert. */
const launchLegacy = async (engine: Engines, fixture: Fixture) => {
  const answer = await engine.legacy.start(legacyCommand());
  const row = await attemptById(fixture.dbPath, answer.attempt.attemptId);
  return { answer, row, spawns: engine.spawns() };
};

/** A launch the common policy refused before any spawn, as `launchLegacy` returns it. */
const POLICY_REFUSED = {
  answer: {
    attempt: { reused: false, state: 'refused' },
    kind: 'review-attempt',
    refusal: { reason: 'policy-refused' },
  },
  row: { candidateId: CLAUDE_ROUTE, declaration: null, pid: null, state: 'refused' },
  spawns: 0,
};
const POLICY_REFUSED_PREFIX = `The delegation policy does not admit route ${CLAUDE_ROUTE}`;

/** A launch the common policy admitted: exactly one spawn, the row stepped out of `requested`. */
const ADMITTED = {
  answer: { attempt: { reused: false, state: 'starting' }, kind: 'review-attempt', refusal: null },
  spawns: 1,
};

/** Ends the one launch the fake launcher recorded and waits for the engine to record its end. */
const settleLaunch = async (engine: Engines): Promise<void> => {
  engine.launcher.launches[0]?.settle(FINISHED);
  await engine.legacy.settle();
};

describe('the legacy review launch inherits the persisted account-change barrier (F3)', () => {
  test('a quota collected under the previous account refuses the legacy command and the delegation before any spawn, until a new quota', async () => {
    // Pinned to account B. Account A observed, the quota collected under A, then B observed one
    // second later; the refreshes that follow prune A out of the retained history, so only the
    // persisted barrier still tells the change.
    const fixture = await createFixture({ pin: ACCOUNT_B, seedFacts: false });
    await importObservations(fixture.dbPath, [claudeObservation('2026-10-25T09:58:00.000Z', ACCOUNT_A)]);
    await importQuota(fixture.dbPath, at(0), 70);
    await importObservations(fixture.dbPath, [claudeObservation(at(1), ACCOUNT_B)]);
    const refreshes = EXECUTOR_BOUNDS.maxRetainedPerExecutor;
    await importObservations(
      fixture.dbPath,
      Array.from({ length: refreshes }, (_, index) => claudeObservation(at(2 + index), ACCOUNT_B)),
    );
    const history = await Effect.runPromise(
      queryExecutorObservationHistory({ dbPath: fixture.dbPath, harness: 'claude-code', machineId: machine.id }),
    );
    expect(history.observations).toHaveLength(refreshes);
    expect(history.observations.every((entry) => entry.accountFingerprint === ACCOUNT_B)).toBe(true);
    expect(
      (await Effect.runPromise(queryExecutorAccountChanges({ dbPath: fixture.dbPath, machineId: machine.id }))).changes,
    ).toMatchObject([{ accountFingerprint: ACCOUNT_B, changedAt: at(1), harness: 'claude-code' }]);

    // The signed-in account matches the pin now; the structural launch policy has nothing against
    // the route. The common policy refuses it on the barrier, before the launcher is reached.
    const engine = engines(fixture, ACCOUNT_B);
    const refused = await launchLegacy(engine, fixture);
    expect(refused).toMatchObject(POLICY_REFUSED);
    expect(refused.answer.refusal?.message).toContain(POLICY_REFUSED_PREFIX);
    expect(refused.answer.refusal?.message).toContain(`predates the account change observed ${at(1)}`);
    expect(refused.answer.refusal?.message).toContain('a new quota observation is required');
    expect(refused.row.failureReason).toContain('policy-refused');

    // The delegation entry says the same of the same facts.
    const qualification = await qualify(engine.delegation, fixture);
    const route = routeOf(qualification, CLAUDE_ROUTE);
    expect(route.identity).toMatchObject({ declared: ACCOUNT_B, observed: ACCOUNT_B, state: 'confirmed' });
    expect(route.blockers).toEqual(['quota-before-account-change']);
    expect(route.exclusions.join(' ')).toContain(`predates the account change observed ${at(1)}`);
    expect(qualification.admissibleRouteIds).toEqual([]);
    const delegated = await engine.delegation.start(startCommand('caller:stale-quota', fixture, qualification));
    expect(delegated).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'route-not-admissible' } });
    expect(engine.spawns()).toBe(0);

    // A quota observed after the change lifts the barrier: the legacy launch is admitted and spawns once.
    await importQuota(fixture.dbPath, at(30), 65);
    const admitted = await launchLegacy(engine, fixture);
    expect(admitted).toMatchObject(ADMITTED);
    expect(engine.launcher.launches).toHaveLength(1);
    await settleLaunch(engine);
    const row = await attemptById(fixture.dbPath, admitted.answer.attempt.attemptId);
    expect(row).toMatchObject({ state: 'finished', target: { checkoutPath: fixture.checkout } });
    expect(row.declaration?.accountFingerprint).toBe(ACCOUNT_B);
  });
});

describe('the legacy review launch inherits the GitHub remote identification (F2)', () => {
  const delegation = {
    routes: [{ accountScope: 'personal', context: 'personal', harness: 'claude-code' }],
    rules: [FORBID_ACME_ON_PERSONAL],
  };

  test('an SSH URL with the explicit port 22 is the GitHub owner the rule names: refused before any spawn', async () => {
    const fixture = await createFixture({
      delegation,
      remotes: [['origin', 'ssh://git@github.com:22/acme/widgets.git']],
    });
    const engine = engines(fixture);
    const refused = await launchLegacy(engine, fixture);
    expect(refused).toMatchObject(POLICY_REFUSED);
    expect(refused.answer.refusal?.message).toContain(POLICY_REFUSED_PREFIX);
    expect(refused.answer.refusal?.message).toContain('Forbidden by rule no-acme-on-personal');
    expect(refused.row.failureReason).toContain('policy-refused');
    // The facts the policy read: the owner identified outright, the rule applied, not assumed.
    const qualification = await qualify(engine.delegation, fixture);
    expect(qualification.checkoutFacts?.githubOwners).toEqual({
      provenance: 'observed',
      source: 'git remote -v',
      value: ['acme'],
    });
    expect(qualification.appliedRules).toEqual([
      { applies: 'yes', effect: 'forbid', id: 'no-acme-on-personal', reason: 'matches githubOwner acme' },
    ]);
    expect(engine.spawns()).toBe(0);
  });

  test('an ssh host alias the engine cannot identify keeps the rule as an assumption: still refused', async () => {
    const fixture = await createFixture({ delegation, remotes: [['origin', 'git@github-pro:acme/widgets.git']] });
    const engine = engines(fixture);
    const refused = await launchLegacy(engine, fixture);
    expect(refused).toMatchObject(POLICY_REFUSED);
    expect(refused.answer.refusal?.message).toContain(POLICY_REFUSED_PREFIX);
    expect(refused.answer.refusal?.message).toContain('Forbidden by rule no-acme-on-personal');
    expect(refused.row.failureReason).toContain('policy-refused');
    const qualification = await qualify(engine.delegation, fixture);
    expect(qualification.checkoutFacts?.githubOwners).toMatchObject({ provenance: 'partial', value: [] });
    expect(qualification.appliedRules).toMatchObject([
      { applies: 'assumed', effect: 'forbid', id: 'no-acme-on-personal' },
    ]);
    expect(
      qualification.assumptions.some(
        (entry) => entry.startsWith('Rule no-acme-on-personal') && entry.includes('only partly identified'),
      ),
    ).toBe(true);
    expect(engine.spawns()).toBe(0);
  });

  test('a known absence of GitHub remotes does not apply the rule: the legacy launch is admitted and spawns once', async () => {
    const fixture = await createFixture({
      delegation,
      remotes: [['origin', 'https://gitlab.example.com/acme/widgets.git']],
    });
    const engine = engines(fixture);
    const qualification = await qualify(engine.delegation, fixture);
    expect(qualification.checkoutFacts?.githubOwners).toEqual({
      provenance: 'observed',
      source: 'git remote -v',
      value: [],
    });
    expect(qualification.appliedRules).toEqual([]);
    expect(qualification.admissibleRouteIds).toEqual([CLAUDE_ROUTE]);
    const admitted = await launchLegacy(engine, fixture);
    expect(admitted).toMatchObject(ADMITTED);
    expect(engine.launcher.launches).toHaveLength(1);
    expect(engine.launcher.launches[0]?.spec.checkoutPath).toBe(fixture.checkout);
    await settleLaunch(engine);
    const row = await attemptById(fixture.dbPath, admitted.answer.attempt.attemptId);
    expect(row).toMatchObject({
      state: 'finished',
      target: { checkoutOrigin: 'desktop-cwd', checkoutPath: fixture.checkout },
    });
  });
});
