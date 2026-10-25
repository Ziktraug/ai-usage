import { Database } from 'bun:sqlite';
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
  type ReviewWorkerEvents,
  type ReviewWorkerOutcome,
  type ReviewWorkerSpec,
} from '@ai-usage/local-collectors/review-worker';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import type { DelegationQualification } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ReviewAttempt, ReviewAttemptScope, ReviewHarnessGuarantee } from '@ai-usage/report-core/work-attempts';
import { parseClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import type { UsageEngineCommand } from '@ai-usage/usage-engine-control';
import {
  importClaudeDesktopSessions,
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  markDelegationJobsLost,
  markReviewAttemptsLost,
  queryReviewAttempts,
  readDelegationJobs,
  releaseDelegationJobReservation,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService, type DelegationService } from './delegation';
import { createReviewAttemptService, type ReviewAttemptService, type ReviewLauncher } from './review-attempts';
import type { FindReviewProcesses } from './review-attempts-process';
import type { RoutingQualificationExecutorRun } from './runtime';

/**
 * One policy before any real review launch, whatever the entry (PR #73 defect F1). The legacy Work
 * command (`start-review-attempt`, bound to a collected Session) and the delegation command
 * (`start-delegation`, session-independent) run against one disposable store, one temporary home
 * config, one temporary git checkout, a fake Claude launcher and a fake worker adapter that count
 * their spawns. Every proof reads the rows the engine wrote back; nothing is spawned for real.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';
const FINGERPRINT = '0123456789abcdef';
const CLAUDE_ROUTE = `declared:${JSON.stringify([machine.id, 'claude-code', 'personal'])}`;
const RUN: RoutingQualificationExecutorRun = { source: null, startedAt: NOW };
const SOURCE_SESSION_ID = 'cli-1';
const SHA = /^[0-9a-f]{40}$/u;

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

const STRUCTURED_FINAL = JSON.stringify({
  checks: ['read a.txt'],
  coverage: { notReviewed: [], reviewed: 'a.txt' },
  findings: [],
  limits: [],
  summary: 'Nothing to report.',
});

const workerFinished = (): ReviewWorkerOutcome => ({
  durationMs: 1234,
  exitCode: 0,
  failureReason: null,
  finalText: STRUCTURED_FINAL,
  kind: 'finished',
  nativeSessionId: 'native-worker',
  numTurns: 3,
  resolvedModel: null,
  resultKind: 'review',
  usage: null,
});

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

interface WorkerLaunch {
  readonly events: ReviewWorkerEvents;
  readonly settle: (outcome: ReviewWorkerOutcome) => void;
  readonly spec: ReviewWorkerSpec;
}

/** The delegation worker adapter as a fake: records every spawn request, settles when told. */
const fakeAdapter = () => {
  const launches: WorkerLaunch[] = [];
  const adapter: ReviewWorkerAdapter = {
    harness: 'claude-code',
    launch: (spec, events) => {
      let settle: (outcome: ReviewWorkerOutcome) => void = () => undefined;
      const outcome = new Promise<ReviewWorkerOutcome>((resolve) => {
        settle = resolve;
      });
      launches.push({ events, settle: (value) => settle(value), spec });
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
        terminate: () => {
          queueMicrotask(() =>
            settle({
              durationMs: 1,
              exitCode: 143,
              failureReason: 'terminated',
              finalText: null,
              kind: 'failed',
              nativeSessionId: null,
              numTurns: 0,
              resolvedModel: null,
              resultKind: 'error',
              usage: null,
            }),
          );
        },
      });
    },
  };
  return { adapter, launches };
};

interface Fixture {
  readonly checkout: string;
  readonly commits: readonly string[];
  readonly dbPath: string;
  readonly home: string;
  readonly privateRoot: string;
  readonly storage: ReturnType<typeof createLocalHistoryStorage>;
}

interface FixtureOptions {
  /** The `delegation` home section; defaults to one annotated Claude route and no rule. */
  readonly delegation?: Record<string, unknown>;
}

const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-review-policy-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'work', 'checkout');
  const dbPath = path.join(root, 'state', 'usage.sqlite');
  const privateRoot = path.join(root, 'state', 'delegation');
  await mkdir(checkout, { recursive: true });
  const git = async (...args: string[]): Promise<string> => {
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
      stdout: 'pipe',
    });
    const stdout = await new Response(run.stdout).text();
    if ((await run.exited) !== 0) {
      throw new Error(`git ${args.join(' ')} failed in the fixture`);
    }
    return stdout.trim();
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const commits: string[] = [];
  for (const [index, content] of ['one\n', 'one\ntwo\n', 'one\ntwo\nthree\n'].entries()) {
    await writeFile(path.join(checkout, 'a.txt'), content);
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', `commit ${index + 1}`);
    commits.push(await git('rev-parse', 'HEAD'));
  }
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    `${JSON.stringify(
      {
        delegation: {
          routes: [{ accountScope: 'personal', context: 'professional', harness: 'claude-code' }],
          ...options.delegation,
        },
        github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
        routing: {
          executors: [
            {
              accountFingerprint: FINGERPRINT,
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
  const observation: ExecutorObservation = {
    accountFingerprint: FINGERPRINT,
    authEvidence: 'claude auth status exit 0 loggedIn=true',
    authMethod: 'claude.ai',
    authState: 'logged-in',
    binaryPath: '/usr/local/bin/claude',
    harness: 'claude-code',
    machineId: machine.id,
    observedAt: '2026-10-25T09:58:00.000Z',
    outcome: 'observed',
    version: '2.1.306 (Claude Code)',
  };
  await Effect.runPromise(importExecutorObservations({ dbPath, observations: [observation] }));
  const quota: ProviderQuotaObservation = {
    accountScope: null,
    machineId: machine.id,
    machineLabel: machine.label,
    observedAt: '2026-10-25T09:57:00.000Z',
    plan: 'max',
    providerGeneratedAt: null,
    providerKey: 'claude',
    providerLabel: 'Claude',
    source: { confidence: 'authoritative', key: 'fixture-quota', mode: 'poll' },
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: '5h',
        id: 'five_hour',
        label: '5h',
        limitSeconds: 18_000,
        remainingPercent: 70,
        resetsAt: '2026-10-25T13:00:00.000Z',
        scope: 'global',
        usedPercent: 30,
      },
    ],
  };
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [{ observation: quota, sourceEventKey: 'fixture-quota-1' }],
    }),
  );
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
  return { checkout, commits, dbPath, home, privateRoot, storage };
};

const scanAbsent: FindReviewProcesses = async () => ({ kind: 'absent' });
const scanFound: FindReviewProcesses = async () => ({ kind: 'found', pids: [4242] });

interface Engines {
  readonly adapter: ReturnType<typeof fakeAdapter>;
  readonly delegation: DelegationService;
  readonly launcher: ReturnType<typeof fakeLauncher>;
  readonly legacy: ReviewAttemptService;
  readonly lines: string[];
  /** Spawns requested through both entries together. */
  readonly spawns: () => number;
}

/** Both engine services over one store and one home, the way `live.ts` composes them. */
const engines = (fixture: Fixture, extra: { readonly findProcesses?: FindReviewProcesses } = {}): Engines => {
  const lines: string[] = [];
  const adapter = fakeAdapter();
  const launcher = fakeLauncher();
  const report = (line: string) => {
    lines.push(line);
  };
  const delegation = createDelegationService({
    adapterOptions: { env: { HOME: fixture.home, PATH: process.env.PATH } },
    adapters: [adapter.adapter],
    dbPath: fixture.dbPath,
    findProcesses: extra.findProcesses ?? scanAbsent,
    machine: () => machine,
    now: () => new Date(NOW),
    privateRoot: fixture.privateRoot,
    probeClaudeAccount: () => Promise.resolve({ accountFingerprint: FINGERPRINT, evidence: 'fixture' }),
    report,
    runLimits: { heartbeatMs: 25 },
    storage: fixture.storage,
  });
  const legacy = createReviewAttemptService({
    admission: delegation.admitReview,
    dbPath: fixture.dbPath,
    findProcesses: extra.findProcesses ?? scanAbsent,
    launcher: launcher.launcher,
    machine: () => machine,
    now: () => new Date(NOW),
    probeAccount: () => Promise.resolve({ accountFingerprint: FINGERPRINT, evidence: 'fixture' }),
    report,
    runLimits: { heartbeatMs: 25 },
    storage: fixture.storage,
  });
  return {
    adapter,
    delegation,
    launcher,
    legacy,
    lines,
    spawns: () => adapter.launches.length + launcher.launches.length,
  };
};

type LegacyCommand = Extract<UsageEngineCommand, { readonly command: 'start-review-attempt' }>;
const legacyCommand = (candidateId = CLAUDE_ROUTE): LegacyCommand => ({
  action: 'read-only-review',
  candidateId,
  command: 'start-review-attempt',
  target: { desktopSessionId: null, harness: 'claude', sourceSessionId: SOURCE_SESSION_ID },
});

type StartCommand = Extract<UsageEngineCommand, { readonly command: 'start-delegation' }>;

const requestFor = (fixture: Fixture, commit: number): Record<string, unknown> => ({
  action: 'read-only-review',
  checkout: { path: fixture.checkout },
  constraints: [],
  criteria: ['The change is explained'],
  objective: `Review commit ${commit + 1} of the fixture`,
  schemaVersion: 1,
  scope: { commit: fixture.commits[commit], kind: 'commit' },
  taskCategory: 'correctness',
});

const qualify = async (
  engine: DelegationService,
  fixture: Fixture,
  commit: number,
): Promise<DelegationQualification> => {
  const output = await engine.qualify(
    { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture, commit) },
    RUN,
  );
  const parsed = parseDelegationQualification(output.qualification);
  if (parsed === null) {
    throw new Error('the engine produced a qualification that does not parse');
  }
  return parsed;
};

const startCommand = (
  idempotencyKey: string,
  fixture: Fixture,
  commit: number,
  qualification: DelegationQualification,
  routeId = CLAUDE_ROUTE,
): StartCommand => ({
  command: 'start-delegation',
  idempotencyKey,
  request: requestFor(fixture, commit),
  selection: {
    kind: 'choice',
    qualificationId: qualification.qualificationId,
    routeId,
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

const jobState = async (dbPath: string, jobId: string): Promise<string> => {
  const read = await Effect.runPromise(readDelegationJobs({ dbPath, jobId }));
  if (read.kind !== 'ok' || read.jobs[0] === undefined) {
    throw new Error(`job ${jobId} is missing`);
  }
  return read.jobs[0].state;
};

/** The frozen SHAs the engine persisted at request time (writer-side columns, read raw). */
const frozenShasOf = (dbPath: string, attemptId: string): { base_sha: string | null; head_sha: string | null } => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT base_sha, head_sha FROM review_attempts WHERE attempt_id = ?').get(attemptId) as {
      base_sha: string | null;
      head_sha: string | null;
    };
  } finally {
    db.close();
  }
};

/** A review attempt row as a pre-upgrade engine could have left it: no frozen scope, no parseable declaration. */
const insertPreUpgradeAttempt = (
  dbPath: string,
  input: { readonly attemptId: string; readonly checkoutPath: string | null; readonly declarationJson: string | null },
): void => {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO review_attempts (attempt_id, machine_id, idempotency_key, action, target_harness, source_session_id,
        checkout_path, candidate_id, executor_harness, declaration_json, state, requested_at, updated_at, launch_session_id)
      VALUES (?, ?, ?, 'read-only-review', 'claude', 'cli-old', ?, ?, 'claude-code', ?, 'running', ?, ?, ?)
    `).run(
      input.attemptId,
      machine.id,
      `key-${input.attemptId}`,
      input.checkoutPath,
      CLAUDE_ROUTE,
      input.declarationJson,
      NOW,
      NOW,
      `6f1c1d4e-2b3a-4c5d-8e9f-${input.attemptId.padStart(12, '0').slice(-12)}`,
    );
  } finally {
    db.close();
  }
};

const endAttemptRaw = (dbPath: string, attemptId: string): void => {
  const db = new Database(dbPath);
  try {
    db.query("UPDATE review_attempts SET state = 'finished', ended_at = ?, updated_at = ? WHERE attempt_id = ?").run(
      NOW,
      NOW,
      attemptId,
    );
  } finally {
    db.close();
  }
};

describe('one review policy before any launch (legacy Work command and delegation)', () => {
  test('an applying forbid rule refuses the legacy command and the delegation before any spawn', async () => {
    // Personal account signed in and pin-confirmed, fresh quota, professional checkout admitted:
    // everything the structural launch policy wants. The delegation rule forbids reviews of acme repositories.
    const fixture = await createFixture({
      delegation: {
        rules: [{ effect: 'forbid', id: 'no-acme', match: { githubOwner: 'acme' } }],
        routes: [{ accountScope: 'personal', context: 'professional', harness: 'claude-code' }],
      },
    });
    const engine = engines(fixture);

    const legacy = await engine.legacy.start(legacyCommand());
    expect(legacy).toMatchObject({
      attempt: { reused: false, state: 'refused' },
      kind: 'review-attempt',
      refusal: { reason: 'policy-refused' },
    });
    expect(legacy.refusal?.message).toContain('Forbidden by rule no-acme');
    expect(engine.launcher.launches).toHaveLength(0);
    const row = await attemptById(fixture.dbPath, legacy.attempt.attemptId);
    expect(row).toMatchObject({ candidateId: CLAUDE_ROUTE, state: 'refused' });
    expect(row.failureReason).toContain('policy-refused');

    const qualification = await qualify(engine.delegation, fixture, 1);
    expect(qualification.admissibleRouteIds).toEqual([]);
    expect(qualification.routes.find((route) => route.routeId === CLAUDE_ROUTE)?.blockers).toEqual([
      'forbidden-by-rule',
    ]);
    const delegated = await engine.delegation.start(startCommand('caller:forbidden', fixture, 1, qualification));
    expect(delegated).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'route-not-admissible' } });
    expect(engine.spawns()).toBe(0);
  });

  test('a forced legacy candidate of the forbidden route does not bypass the rule', async () => {
    // The rule selects exactly this route; the command names it as the forced candidate.
    const fixture = await createFixture({
      delegation: {
        rules: [
          {
            effect: 'forbid',
            id: 'no-personal-acme',
            match: { repository: 'acme/widgets' },
            routes: { accountScopes: ['personal'], harnesses: ['claude-code'] },
          },
        ],
        routes: [{ accountScope: 'personal', context: 'professional', harness: 'claude-code' }],
      },
    });
    const engine = engines(fixture);
    const forced = await engine.legacy.start(legacyCommand(CLAUDE_ROUTE));
    expect(forced.refusal).toMatchObject({ reason: 'policy-refused' });
    expect(forced.refusal?.message).toContain(CLAUDE_ROUTE);
    expect(forced.refusal?.message).toContain('no-personal-acme');
    expect(engine.spawns()).toBe(0);

    // Without a declared context the route is not admissible either, and the refusal says how to declare it.
    const undeclared = await createFixture({ delegation: { routes: [] } });
    const second = engines(undeclared);
    const refused = await second.legacy.start(legacyCommand());
    expect(refused.refusal).toMatchObject({ reason: 'policy-refused' });
    expect(refused.refusal?.message).toContain('Declare the context (professional or personal) of this route');
    expect(second.spawns()).toBe(0);
  });

  test('an active legacy attempt fills the shared pool: a delegation on the same pool is refused pool-busy', async () => {
    const fixture = await createFixture();
    const engine = engines(fixture);
    // Another target (an earlier commit) on the same pool, qualified while the pool is idle.
    const qualification = await qualify(engine.delegation, fixture, 1);
    expect(qualification.admissibleRouteIds).toEqual([CLAUDE_ROUTE]);
    const started = await engine.legacy.start(legacyCommand());
    expect(started).toMatchObject({ attempt: { reused: false, state: 'starting' }, refusal: null });
    expect(engine.launcher.launches).toHaveLength(1);

    // The advisory answer counts the legacy attempt; the start's own re-qualification refuses as data.
    const fresh = await qualify(engine.delegation, fixture, 1);
    const route = fresh.routes.find((entry) => entry.routeId === CLAUDE_ROUTE);
    expect(route).toMatchObject({ admissible: false, blockers: ['pool-busy'], liveJobsInPool: 1 });
    const busy = await engine.delegation.start(startCommand('caller:busy', fixture, 1, qualification));
    expect(busy).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'pool-busy' } });
    expect(busy.refusal?.message).toContain(`review attempt ${started.attempt.attemptId}`);
    expect(engine.spawns()).toBe(1);

    // The legacy review ends; the pool is free again.
    engine.launcher.launches[0]?.settle(FINISHED);
    await engine.legacy.settle();
    const again = await qualify(engine.delegation, fixture, 1);
    expect(again.admissibleRouteIds).toEqual([CLAUDE_ROUTE]);
    const launched = await engine.delegation.start(startCommand('caller:free', fixture, 1, again));
    expect(launched).toMatchObject({ job: { state: 'starting' }, refusal: null });
    expect(engine.spawns()).toBe(2);
    engine.adapter.launches[0]?.settle(workerFinished());
    await engine.delegation.settle();
  });

  test('an active delegation fills the shared pool: the legacy command on the same pool is refused pool-busy', async () => {
    const fixture = await createFixture();
    const engine = engines(fixture);
    const qualification = await qualify(engine.delegation, fixture, 1);
    const delegated = await engine.delegation.start(startCommand('caller:first', fixture, 1, qualification));
    expect(delegated).toMatchObject({ job: { state: 'starting' }, refusal: null });

    const refused = await engine.legacy.start(legacyCommand());
    expect(refused).toMatchObject({ attempt: { reused: false, state: 'refused' }, refusal: { reason: 'pool-busy' } });
    expect(refused.refusal?.message).toContain(`delegation job ${delegated.job?.jobId}`);
    expect(refused.refusal?.message).toContain('the limit is 1');
    expect(engine.launcher.launches).toHaveLength(0);
    expect(engine.spawns()).toBe(1);
    const row = await attemptById(fixture.dbPath, refused.attempt.attemptId);
    expect(row.failureReason).toContain('pool-busy');

    engine.adapter.launches[0]?.settle(workerFinished());
    await engine.delegation.settle();
    const launched = await engine.legacy.start(legacyCommand());
    expect(launched).toMatchObject({ attempt: { state: 'starting' }, refusal: null });
    engine.launcher.launches[0]?.settle(FINISHED);
    await engine.legacy.settle();
  });

  test('two concurrent requests through the two entries spawn exactly one worker under a shared limit of 1', async () => {
    const fixture = await createFixture();
    const engine = engines(fixture);
    // Same target as the legacy command (HEAD) so the loser is refused on the target or the pool.
    const qualification = await qualify(engine.delegation, fixture, 2);
    const [legacy, delegated] = await Promise.all([
      engine.legacy.start(legacyCommand()),
      engine.delegation.start(startCommand('caller:race', fixture, 2, qualification)),
    ]);
    expect(engine.spawns()).toBe(1);
    const outcomes = [
      legacy.refusal?.reason ?? legacy.attempt.state,
      delegated.refusal?.reason ?? delegated.job?.state,
    ];
    expect(outcomes.filter((outcome) => outcome === 'starting')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'pool-busy' || outcome === 'target-reserved')).toHaveLength(1);
    engine.launcher.launches[0]?.settle(FINISHED);
    engine.adapter.launches[0]?.settle(workerFinished());
    await Promise.all([engine.legacy.settle(), engine.delegation.settle()]);
  });

  test('a lost, unreleased reservation of either family keeps counting until its evidence releases it', async () => {
    const fixture = await createFixture();
    const owner = engines(fixture, { findProcesses: scanFound });
    // Qualified while the pool is idle; the starts below re-qualify and refuse as data.
    const qualification = await qualify(owner.delegation, fixture, 1);
    const started = await owner.legacy.start(legacyCommand());
    expect(started.attempt.state).toBe('starting');
    // Contact is lost (as by a restart) while a process still carries the marker.
    await Effect.runPromise(
      markReviewAttemptsLost({ at: NOW, dbPath: fixture.dbPath, machineId: machine.id, reason: () => 'lost' }),
    );
    const restarted = engines(fixture, { findProcesses: scanFound });
    const fresh = await qualify(restarted.delegation, fixture, 1);
    expect(fresh.routes.find((route) => route.routeId === CLAUDE_ROUTE)?.blockers).toEqual(['pool-busy']);
    const held = await restarted.delegation.start(startCommand('caller:held', fixture, 1, qualification));
    expect(held).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'pool-busy' } });
    expect(held.refusal?.message).toContain('lost');
    expect(restarted.spawns()).toBe(0);

    // The operator's release: the engine looks first, sees no process, records the evidence.
    const releasing = engines(fixture, { findProcesses: scanAbsent });
    const released = await releasing.legacy.releaseReservation({
      attemptId: started.attempt.attemptId,
      command: 'release-review-reservation',
    });
    expect(released).toMatchObject({ evidence: 'process-absent', result: 'released' });
    const free = await qualify(releasing.delegation, fixture, 1);
    const launched = await releasing.delegation.start(startCommand('caller:free', fixture, 1, free));
    expect(launched).toMatchObject({ job: { state: 'starting' }, refusal: null });
    expect(releasing.adapter.launches).toHaveLength(1);
    const jobId = launched.job?.jobId ?? '';

    // The other direction: a lost delegation job holds the pool against the legacy command.
    await Effect.runPromise(
      markDelegationJobsLost({ at: NOW, dbPath: fixture.dbPath, machineId: machine.id, reason: 'lost' }),
    );
    expect(await jobState(fixture.dbPath, jobId)).toBe('lost');
    const blocked = await releasing.legacy.start(legacyCommand());
    expect(blocked).toMatchObject({ attempt: { state: 'refused' }, refusal: { reason: 'pool-busy' } });
    expect(blocked.refusal?.message).toContain(`delegation job ${jobId} (lost)`);
    await Effect.runPromise(
      releaseDelegationJobReservation({ at: NOW, dbPath: fixture.dbPath, evidence: 'process-absent', jobId }),
    );
    const relaunched = await releasing.legacy.start(legacyCommand());
    expect(relaunched).toMatchObject({ attempt: { state: 'starting' }, refusal: null });
    expect(releasing.launcher.launches).toHaveLength(1);
    owner.launcher.launches[0]?.settle(FINISHED);
    releasing.launcher.launches[0]?.settle(FINISHED);
    releasing.adapter.launches[0]?.settle(workerFinished());
    await Promise.all([owner.legacy.settle(), releasing.legacy.settle(), releasing.delegation.settle()]);
  });

  test('a reserving pre-upgrade legacy row is handled as unknown scope or unknown pool, never ignored', async () => {
    const fixture = await createFixture();
    const engine = engines(fixture);
    // Qualified while nothing reserves anything; each start below re-qualifies against the old row.
    const idle = await qualify(engine.delegation, fixture, 1);
    expect(idle.admissibleRouteIds).toEqual([CLAUDE_ROUTE]);

    // No frozen revision and no recorded scope: the row reserves its whole checkout.
    insertPreUpgradeAttempt(fixture.dbPath, {
      attemptId: 'old-same-checkout',
      checkoutPath: fixture.checkout,
      declarationJson: null,
    });
    const sameCheckout = await qualify(engine.delegation, fixture, 1);
    expect(sameCheckout.refusal).toMatchObject({ reason: 'target-reserved' });
    expect(sameCheckout.refusal?.message).toContain('review attempt old-same-checkout');
    expect(sameCheckout.refusal?.message).toContain('whole checkout');
    const reserved = await engine.delegation.start(startCommand('caller:old-target', fixture, 1, idle));
    expect(reserved).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'target-reserved' } });
    expect(reserved.refusal?.message).toContain('whole checkout');
    endAttemptRaw(fixture.dbPath, 'old-same-checkout');

    // Another checkout, a declaration that does not parse: the pool is unknown and counts against
    // every pool of the harness on this machine.
    insertPreUpgradeAttempt(fixture.dbPath, {
      attemptId: 'old-unknown-pool',
      checkoutPath: '/elsewhere/checkout',
      declarationJson: 'not json',
    });
    const unknownPool = await qualify(engine.delegation, fixture, 1);
    const route = unknownPool.routes.find((entry) => entry.routeId === CLAUDE_ROUTE);
    expect(route).toMatchObject({ admissible: false, blockers: ['pool-busy'], liveJobsInPool: 1 });
    const busy = await engine.delegation.start(startCommand('caller:old-pool', fixture, 1, idle));
    expect(busy).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'pool-busy' } });
    expect(busy.refusal?.message).toContain('review attempt old-unknown-pool');
    expect(busy.refusal?.message).toContain('pool unknown');
    endAttemptRaw(fixture.dbPath, 'old-unknown-pool');

    // No checkout path at all: the row reserves every target of the machine, and says so.
    insertPreUpgradeAttempt(fixture.dbPath, {
      attemptId: 'old-no-checkout',
      checkoutPath: null,
      declarationJson: null,
    });
    const noCheckout = await qualify(engine.delegation, fixture, 1);
    expect(noCheckout.refusal).toMatchObject({ reason: 'target-reserved' });
    expect(noCheckout.refusal?.message).toContain('every target of this machine');
    const legacyToo = await engine.legacy.start(legacyCommand());
    expect(legacyToo).toMatchObject({ attempt: { state: 'refused' }, refusal: { reason: 'target-reserved' } });
    expect(legacyToo.refusal?.message).toContain('every target of this machine');
    expect(engine.spawns()).toBe(0);
    endAttemptRaw(fixture.dbPath, 'old-no-checkout');

    const free = await qualify(engine.delegation, fixture, 1);
    expect(free.admissibleRouteIds).toEqual([CLAUDE_ROUTE]);
  });

  test('an authorized legacy review still launches, on the frozen revision it reserved', async () => {
    const fixture = await createFixture();
    const engine = engines(fixture);
    const started = await engine.legacy.start(legacyCommand());
    expect(started).toMatchObject({ attempt: { reused: false, state: 'starting' }, refusal: null });
    const [launch] = engine.launcher.launches;
    const head = fixture.commits[2] ?? '';
    const parent = fixture.commits[1] ?? '';
    expect(launch?.spec.checkoutPath).toBe(fixture.checkout);
    expect(launch?.options.scope?.revision).toEqual({ baseSha: parent, headSha: head, kind: 'commit' });
    // Persisted at request time, before the spawn.
    expect(frozenShasOf(fixture.dbPath, started.attempt.attemptId)).toEqual({ base_sha: parent, head_sha: head });
    expect(head).toMatch(SHA);

    // The same target while live: reused, nothing spawned twice (the existing per-identity rule).
    const twin = await engine.legacy.start(legacyCommand());
    expect(twin.attempt).toMatchObject({ attemptId: started.attempt.attemptId, reused: true });
    expect(engine.spawns()).toBe(1);

    launch?.settle(FINISHED);
    await engine.legacy.settle();
    const row = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(row).toMatchObject({
      state: 'finished',
      target: { checkoutOrigin: 'desktop-cwd', checkoutPath: fixture.checkout },
    });
    expect(row.scope).toMatchObject({ baseSha: parent, headSha: head, kind: 'commit' });
    expect(row.declaration?.accountScope).toBe('personal');
  });
});
