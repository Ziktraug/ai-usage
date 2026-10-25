import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeReviewLaunch, ClaudeReviewOutcome } from '@ai-usage/local-collectors/claude-review-launcher';
import { claudeAccountFingerprint } from '@ai-usage/local-collectors/executor-observations';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
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
  markReviewAttemptsLost,
  queryReviewAttempts,
  requestReviewAttempt,
  transitionReviewAttempt,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService, type ReviewAdmissionPort } from './delegation';
import { createReviewAttemptService, type ReviewLauncher } from './review-attempts';
import type { FindReviewProcesses } from './review-attempts-process';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const LIVE_STATE = /^(?:starting|running)$/u;
const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = new Date('2026-10-22T10:00:00.000Z');
const CANDIDATE_ID = `declared:${JSON.stringify([machine.id, 'claude-code', 'personal'])}`;
const INIT_LINE = JSON.stringify({ session_id: 'native-engine-1', subtype: 'init', type: 'system' });
const RESULT_LINE = JSON.stringify({
  duration_ms: 2222,
  is_error: false,
  num_turns: 4,
  result: 'Finding 1: packages/a.ts:7 (low) the summary ignores an empty diff.',
  session_id: 'native-engine-1',
  subtype: 'success',
  type: 'result',
});
const emit = (...lines: string[]): string =>
  lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`).join('\n');
/** The options `claude --help` must name for the launcher to qualify the CLI. */
const FAKE_HELP = [
  '--allowedTools',
  '--disallowedTools',
  '--effort',
  '--model',
  '--output-format',
  '--permission-mode',
  '--print',
  '--safe-mode',
  '--session-id',
  '--setting-sources',
  '--strict-mcp-config',
  '--tools',
  '--verbose',
].join('\n');
const FAKE_SCOPE: ReviewAttemptScope = {
  base: 'first-parent',
  baseSha: 'c'.repeat(40),
  fileCount: 1,
  files: [{ additions: 1, coverage: 'complete', deletions: 0, path: 'a.txt', previousPath: null, status: 'modified' }],
  headSha: 'b'.repeat(40),
  includedBytes: 90,
  includedLines: 7,
  kind: 'commit',
  parentCount: 1,
  patchBytes: 90,
  patchLines: 7,
  patchSha256: 'd'.repeat(64),
  repositoryPrefix: '',
  subject: 'second',
  truncated: false,
  workingTreeDirty: false,
};
const FAKE_GUARANTEE: ReviewHarnessGuarantee = {
  cliVersion: '2.1.306',
  effort: null,
  model: 'opus',
  managedSettings: 'absent',
  safeMode: true,
  settingSources: [],
  tools: ['Read', 'Grep', 'Glob'],
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** An in-memory launch whose events and outcome the test drives; no process is started. */
const controlledLauncher = () => {
  let settle: (outcome: ClaudeReviewOutcome) => void = () => undefined;
  const calls: { events: Parameters<ReviewLauncher>[1]; launchSessionId: string }[] = [];
  const outcome = new Promise<ClaudeReviewOutcome>((resolve) => {
    settle = resolve;
  });
  const launcher: ReviewLauncher = async (spec, events) => {
    calls.push({ events, launchSessionId: spec.launchSessionId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      args: [],
      guarantee: FAKE_GUARANTEE,
      outcome,
      pid: 999_999,
      prompt: 'PROMPT',
      scope: FAKE_SCOPE,
      terminate: () => undefined,
    } satisfies ClaudeReviewLaunch;
  };
  return { calls, launcher, settle: (value: ClaudeReviewOutcome) => settle(value) };
};
const FINISHED: ClaudeReviewOutcome = {
  durationMs: 10,
  exitCode: 0,
  failureReason: null,
  kind: 'finished',
  nativeSessionId: 'native-late',
  numTurns: 1,
  resultExcerpt: 'Finding 1: late but real.',
  resultKind: 'review',
};
const scanFound: FindReviewProcesses = async () => ({ kind: 'found', pids: [4242] });

type StartCommand = Extract<UsageEngineCommand, { readonly command: 'start-review-attempt' }>;
const command = (overrides: Partial<StartCommand> = {}): StartCommand => ({
  action: 'read-only-review',
  candidateId: CANDIDATE_ID,
  command: 'start-review-attempt',
  target: { desktopSessionId: null, harness: 'claude', sourceSessionId: 'cli-1' },
  ...overrides,
});

interface Fixture {
  readonly checkout: string;
  readonly dbPath: string;
  readonly executable: (body: string) => Promise<string>;
  readonly home: string;
  readonly storage: ReturnType<typeof createLocalHistoryStorage>;
}

interface FixtureOptions {
  /** Fields merged into the one `routing.executors[]` entry (a model and its alternates, say). */
  readonly declaration?: Readonly<Record<string, unknown>>;
  /** The account fingerprint the stored executor observation reports (ADR 0057). */
  readonly observedFingerprint?: string;
  readonly quota?: boolean;
  /** Quota windows added to the all-models 5-hour one, under the given provider state. */
  readonly quotaWindows?: {
    readonly state: ProviderQuotaObservation['state'];
    readonly windows: ProviderQuotaObservation['windows'];
  };
  readonly reviewTargets?: readonly unknown[];
}

const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-review-attempts-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'work', 'checkout');
  const dbPath = path.join(root, 'state', 'usage.sqlite');
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(checkout, { recursive: true }), mkdir(bin, { recursive: true })]);
  // The checkout has two commits: the review's scope is the second, against its first parent.
  const git = async (...args: string[]) => {
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
  await writeFile(path.join(checkout, 'a.txt'), 'one\n');
  await git('add', 'a.txt');
  await git('commit', '-q', '-m', 'first');
  await writeFile(path.join(checkout, 'a.txt'), 'one\ntwo\n');
  await git('commit', '-q', '-am', 'second');
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    JSON.stringify({
      // The common review policy needs the route's context declared (ADR 0077); no rule applies.
      delegation: { routes: [{ accountScope: 'personal', context: 'personal', harness: 'claude-code' }] },
      routing: {
        executors: [
          {
            accountScope: 'personal',
            authorization: 'allowed',
            capabilities: ['read-only-review'],
            declaredAt: '2026-10-21T08:00:00.000Z',
            harness: 'claude-code',
            quality: 'review-capable',
            subscription: 'verified',
            targets: [{ kind: 'any-local-session' }],
            ...options.declaration,
          },
        ],
        reviewTargets: options.reviewTargets ?? [{ checkoutPath: path.join(root, 'work'), label: 'fixture' }],
      },
    }),
    { mode: 0o600 },
  );
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: NOW }));
  const observation: ExecutorObservation = {
    ...(options.observedFingerprint === undefined ? {} : { accountFingerprint: options.observedFingerprint }),
    authEvidence: 'claude auth status exit 0 loggedIn=true',
    authMethod: null,
    authState: 'logged-in',
    binaryPath: path.join(bin, 'claude'),
    harness: 'claude-code',
    machineId: machine.id,
    observedAt: '2026-10-22T09:58:00.000Z',
    outcome: 'observed',
    version: '2.1.306 (Claude Code)',
  };
  await Effect.runPromise(importExecutorObservations({ dbPath, observations: [observation] }));
  if (options.quota !== false) {
    const quota: ProviderQuotaObservation = {
      accountScope: null,
      machineId: machine.id,
      machineLabel: machine.label,
      observedAt: '2026-10-22T09:57:00.000Z',
      plan: 'max',
      providerGeneratedAt: null,
      providerKey: 'claude',
      providerLabel: 'Claude',
      source: { confidence: 'authoritative', key: 'fixture-quota', mode: 'poll' },
      state: options.quotaWindows?.state ?? 'ok',
      windows: [
        ...(options.quotaWindows?.windows ?? []),
        {
          blocked: false,
          group: '5h',
          id: 'five_hour',
          label: '5h',
          limitSeconds: 18_000,
          remainingPercent: 70,
          resetsAt: '2026-10-22T13:00:00.000Z',
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
  }
  const desktop = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account-a',
    archived: false,
    branch: null,
    cliSessionId: 'cli-1',
    completedTurns: 2,
    createdAt: '2026-10-21T08:00:00.000Z',
    cwd: checkout,
    declaredPullRequests: [],
    desktopSessionId: 'local_engine_one',
    effort: null,
    fileModifiedAt: '2026-10-22T09:00:00.000Z',
    filePath: '.config/Claude/claude-code-sessions/account-a/org-a/local_engine_one.json',
    format: 'claude-desktop-session-v1',
    lastActivityAt: '2026-10-22T09:00:00.000Z',
    lastTurnReport: null,
    machineId: machine.id,
    model: null,
    observedAt: '2026-10-22T09:05:00.000Z',
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
  const executable = async (body: string): Promise<string> => {
    const file = path.join(bin, 'claude');
    await writeFile(
      file,
      [
        `#!${process.execPath}`,
        'if (process.argv[2] === "--version") { process.stdout.write("2.1.306 (Claude Code)\\n"); process.exit(0); }',
        `if (process.argv[2] === "--help") { process.stdout.write(${JSON.stringify(`${FAKE_HELP}\n`)}); process.exit(0); }`,
        body,
        '',
      ].join('\n'),
    );
    await chmod(file, 0o700);
    return file;
  };
  return { checkout, dbPath, executable, home, storage };
};

const attempts = async (dbPath: string): Promise<readonly ReviewAttempt[]> =>
  (await Effect.runPromise(queryReviewAttempts({ dbPath }))).attempts;

/**
 * The common review policy every launch passes (PR #73 F1): the delegation service's admission over
 * the same store and home, as `live.ts` wires it. Its adapters and probes are never reached here.
 */
const admissionFor = (fixture: Fixture): ReviewAdmissionPort =>
  createDelegationService({
    adapterOptions: { env: { HOME: fixture.home, PATH: process.env.PATH } },
    dbPath: fixture.dbPath,
    machine: () => machine,
    now: () => NOW,
    privateRoot: path.join(fixture.home, 'delegation'),
    storage: fixture.storage,
  }).admitReview;

/** Every row of a test shares the pinned `requestedAt`, so rows are found by id, never by list order. */
const attemptById = async (dbPath: string, attemptId: string): Promise<ReviewAttempt> => {
  const found = (await attempts(dbPath)).find((attempt) => attempt.attemptId === attemptId);
  if (!found) {
    throw new Error(`attempt ${attemptId} is missing`);
  }
  return found;
};

const service = (
  fixture: Fixture,
  executable: string,
  extra: { readonly findProcesses?: FindReviewProcesses; readonly timeoutMs?: number } = {},
) => {
  const lines: string[] = [];
  const created = createReviewAttemptService({
    admission: admissionFor(fixture),
    dbPath: fixture.dbPath,
    ...(extra.findProcesses === undefined ? {} : { findProcesses: extra.findProcesses }),
    launchOptions: { env: { HOME: fixture.home, PATH: process.env.PATH }, executable },
    machine: () => machine,
    now: () => NOW,
    report: (line) => {
      lines.push(line);
    },
    runLimits: { heartbeatMs: 25, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) },
    storage: fixture.storage,
  });
  return { lines, ...created };
};

describe('engine review attempts', () => {
  test('a harness that reports init before the launch returns never steps the attempt back to starting', async () => {
    const fixture = await createFixture();
    let settle: (outcome: ClaudeReviewOutcome) => void = () => undefined;
    const outcome = new Promise<ClaudeReviewOutcome>((resolve) => {
      settle = resolve;
    });
    // The init line is read, and `running` written, before the launcher hands the launch back.
    const launcher: ReviewLauncher = async (_spec, events) => {
      await events.onInit?.('native-early');
      return {
        args: [],
        guarantee: FAKE_GUARANTEE,
        outcome,
        pid: process.pid,
        prompt: 'PROMPT',
        scope: FAKE_SCOPE,
        terminate: () => undefined,
      };
    };
    const engine = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      launcher,
      machine: () => machine,
      now: () => NOW,
      storage: fixture.storage,
    });
    const started = await engine.start(command());
    expect(started.attempt).toMatchObject({ reused: false, state: 'running' });
    let attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ nativeSessionId: 'native-early', pid: process.pid, state: 'running' });
    settle({
      durationMs: 10,
      exitCode: 0,
      failureReason: null,
      kind: 'finished',
      nativeSessionId: 'native-early',
      numTurns: 1,
      resultExcerpt: 'Finding 1: none.',
      resultKind: 'review',
    });
    await engine.settle();
    attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ resultExcerpt: 'Finding 1: none.', state: 'finished' });
  });

  test('decides, records, launches the fake harness and finishes with an excerpt; a second command reuses', async () => {
    const fixture = await createFixture();
    const executable = await fixture.executable(
      [
        'if (!process.argv.includes("--permission-mode") || process.argv.includes("--dangerously-skip-permissions")) process.exit(5);',
        `if (process.cwd() !== ${JSON.stringify(fixture.checkout)}) process.exit(6);`,
        emit(INIT_LINE),
        'await new Promise((resolve) => setTimeout(resolve, 120));',
        emit(RESULT_LINE),
      ].join('\n'),
    );
    const engine = service(fixture, executable);
    const first = await engine.start(command());
    expect(first).toMatchObject({
      attempt: { reused: false, state: 'starting' },
      kind: 'review-attempt',
      refusal: null,
    });
    const attemptId = first.attempt.attemptId;
    expect(engine.live()).toEqual([attemptId]);

    const second = await engine.start(command());
    expect(second.attempt).toEqual({ attemptId, reused: true, state: expect.stringMatching(LIVE_STATE) });
    expect(engine.live()).toEqual([attemptId]);

    await engine.settle();
    const [attempt] = await attempts(fixture.dbPath);
    expect(attempt).toMatchObject({
      acceptance: 'pending',
      attemptId,
      candidateId: CANDIDATE_ID,
      durationMs: 2222,
      executorHarness: 'claude-code',
      exitCode: 0,
      nativeSessionId: 'native-engine-1',
      numTurns: 4,
      resultExcerpt: 'Finding 1: packages/a.ts:7 (low) the summary ignores an empty diff.',
      resultKind: 'review',
      state: 'finished',
      validations: [],
    });
    expect(attempt?.target).toEqual({
      checkoutOrigin: 'desktop-cwd',
      checkoutPath: fixture.checkout,
      desktopSessionId: 'local_engine_one',
      harness: 'claude',
      projectLabel: null,
      sessionTitle: 'Fixture: investigate the launcher',
      sourceSessionId: 'cli-1',
    });
    expect(attempt?.declaration?.accountScope).toBe('personal');
    expect(attempt?.pid).toBeGreaterThan(0);
    expect(await attempts(fixture.dbPath)).toHaveLength(1);
    expect(engine.lines.some((line) => line.includes('review-attempt=finished'))).toBe(true);

    // The identity is free again once the attempt ended: a new request starts a new attempt.
    const third = await engine.start(command());
    expect(third.attempt.reused).toBe(false);
    expect(third.attempt.attemptId).not.toBe(attemptId);
    await engine.settle();
  });

  test('records an error result, an exit without result and a timeout as failed attempts', async () => {
    const fixture = await createFixture();
    const engine = service(
      fixture,
      await fixture.executable(
        emit(
          INIT_LINE,
          JSON.stringify({ is_error: true, result: 'Max turns', subtype: 'error_max_turns', type: 'result' }),
        ),
      ),
      {
        timeoutMs: 400,
      },
    );
    const errored = await engine.start(command());
    await engine.settle();
    let attempt = await attemptById(fixture.dbPath, errored.attempt.attemptId);
    expect(attempt).toMatchObject({ resultExcerpt: 'Max turns', resultKind: 'error', state: 'failed' });
    expect(attempt.failureReason).toContain('error result');

    await fixture.executable(`${emit(INIT_LINE)}\nprocess.exit(1);`);
    const exited = await engine.start(command());
    await engine.settle();
    attempt = await attemptById(fixture.dbPath, exited.attempt.attemptId);
    expect(attempt).toMatchObject({
      exitCode: 1,
      failureReason: 'exit 1 without a result message',
      resultKind: 'error',
      state: 'failed',
    });

    await fixture.executable(`${emit(INIT_LINE)}\nsetTimeout(() => process.exit(0), 60_000);`);
    const started = await engine.start(command());
    expect(started.attempt.state).toBe('starting');
    await engine.settle();
    attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ nativeSessionId: 'native-engine-1', resultKind: 'timeout', state: 'failed' });
    expect(attempt.failureReason).toContain('timed out');
    expect(await attempts(fixture.dbPath)).toHaveLength(3);
  });

  test('refuses a target outside routing.reviewTargets and a conditional recommendation, recording each refusal', async () => {
    const outside = await createFixture({ reviewTargets: [{ checkoutPath: '/elsewhere' }] });
    const executable = await outside.executable(emit(INIT_LINE, RESULT_LINE));
    const refusedOutside = await service(outside, executable).start(command());
    expect(refusedOutside).toMatchObject({
      attempt: { reused: false, state: 'refused' },
      refusal: { message: `add routing.reviewTargets for ${outside.checkout}`, reason: 'target-not-allowed' },
    });
    const [refusedRow] = await attempts(outside.dbPath);
    expect(refusedRow).toMatchObject({ declaration: null, state: 'refused' });
    expect(refusedRow?.failureReason).toContain('target-not-allowed');

    const noQuota = await createFixture({ quota: false });
    const conditional = await service(noQuota, await noQuota.executable(emit(INIT_LINE, RESULT_LINE))).start(command());
    expect(conditional).toMatchObject({
      attempt: { state: 'refused' },
      refusal: { reason: 'recommendation-not-real' },
    });
    expect(conditional.refusal?.message).toContain('conditional');

    const codex = await service(noQuota, executable).start(
      command({ candidateId: `declared:${JSON.stringify([machine.id, 'codex', 'personal'])}` }),
    );
    expect(codex.refusal?.reason).toBe('no-declaration');
    expect((await attempts(noQuota.dbPath)).every((attempt) => attempt.state === 'refused')).toBe(true);
  });

  test('records the commit it reviewed and the guarantee it ran under; a checkout that is no git work tree is refused before any spawn', async () => {
    const fixture = await createFixture();
    const engine = service(fixture, await fixture.executable(emit(INIT_LINE, RESULT_LINE)));
    const started = await engine.start(command());
    await engine.settle();
    const attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: fixture.checkout }).stdout.toString().trim();
    expect(attempt.scope).toMatchObject({ base: 'first-parent', headSha: head, kind: 'commit', subject: 'second' });
    expect(attempt.guarantee).toMatchObject({
      effort: null,
      model: null,
      safeMode: true,
      settingSources: [],
      tools: ['Read', 'Grep', 'Glob'],
    });
    expect(attempt.launchSessionId).toMatch(UUID_PATTERN);

    // The common policy resolves the checkout canonically before anything is recorded or spawned:
    // a directory that is no git work tree is a refusal, not a failed attempt (PR #73 F1).
    await rm(path.join(fixture.checkout, '.git'), { force: true, recursive: true });
    const unscoped = await engine.start(command());
    expect(unscoped).toMatchObject({
      attempt: { reused: false, state: 'refused' },
      refusal: { reason: 'target-not-allowed' },
    });
    expect(unscoped.refusal?.message).toContain('not inside a git work tree');
    const refused = await attemptById(fixture.dbPath, unscoped.attempt.attemptId);
    expect(refused).toMatchObject({ pid: null, scope: null, state: 'refused' });
    expect(refused.failureReason).toContain('target-not-allowed');
  });

  test('an alternate-model candidate launches with its own model, and the guarantee records it (ADR 0057)', async () => {
    // The case of the day: the Fable window is exhausted, the all-models window is not, Opus is
    // declared after Fable on the same account. Opus is the real candidate; the launch must pass
    // `--model Opus`, never the declaration's primary model.
    const fixture = await createFixture({
      declaration: { alternateModels: ['Opus'], model: 'Fable' },
      quotaWindows: {
        state: 'partial',
        windows: [
          {
            blocked: true,
            group: 'weekly',
            id: 'model:Fable',
            label: 'Fable · Weekly',
            limitSeconds: null,
            remainingPercent: 0,
            resetsAt: '2026-10-24T05:00:00.000Z',
            scope: 'model',
            usedPercent: 100,
          },
        ],
      },
    });
    const opus = `${CANDIDATE_ID}:model:1:Opus`;
    const executable = await fixture.executable(
      [
        'const model = process.argv[process.argv.indexOf("--model") + 1];',
        'if (model !== "Opus") process.exit(7);',
        emit(INIT_LINE, RESULT_LINE),
      ].join('\n'),
    );
    const engine = service(fixture, executable);

    const primary = await engine.start(command());
    expect(primary.refusal?.reason).toBe('recommendation-not-real');

    const started = await engine.start(command({ candidateId: opus }));
    expect(started.refusal).toBeNull();
    await engine.settle();
    const attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ candidateId: opus, exitCode: 0, state: 'finished' });
    expect(attempt.guarantee?.model).toBe('Opus');
    // The snapshot keeps the declaration as written; the guarantee names the model that ran.
    expect(attempt.declaration).toMatchObject({ alternateModels: ['Opus'], model: 'Fable' });
  });

  test('a pinned route re-reads the signed-in account at start and refuses when it changed (ADR 0057)', async () => {
    const accountA = { email: 'a@example.invalid', orgId: 'org-a' };
    const accountB = { email: 'b@example.invalid', orgId: 'org-b' };
    const pin = claudeAccountFingerprint(accountA);
    if (pin === null) {
      throw new Error('fixture fingerprint must exist');
    }
    const signedIn = (account: typeof accountA) =>
      `if (process.argv[2] === "auth") { process.stdout.write(${JSON.stringify(JSON.stringify({ ...account, authMethod: 'claude.ai', loggedIn: true }))}); process.exit(0); }`;
    // Qualified as confirmed from the stored observation; the CLI has since signed in to B.
    const fixture = await createFixture({ declaration: { accountFingerprint: pin }, observedFingerprint: pin });
    const switched = service(
      fixture,
      await fixture.executable([signedIn(accountB), emit(INIT_LINE, RESULT_LINE)].join('\n')),
    );
    const refused = await switched.start(command());
    expect(refused.refusal?.reason).toBe('identity-changed');
    expect(refused.refusal?.message).toContain(pin);
    expect(refused.refusal?.message).toContain(claudeAccountFingerprint(accountB) ?? 'missing');
    expect(switched.live()).toEqual([]);

    // The same account at start: the review launches.
    const same = service(
      fixture,
      await fixture.executable([signedIn(accountA), emit(INIT_LINE, RESULT_LINE)].join('\n')),
    );
    const started = await same.start(command());
    expect(started.refusal).toBeNull();
    await same.settle();
    expect((await attemptById(fixture.dbPath, started.attempt.attemptId)).state).toBe('finished');
  });

  test('a double click and a second client on the same target launch one review', async () => {
    const fixture = await createFixture();
    const controlled = controlledLauncher();
    const engine = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      launcher: controlled.launcher,
      machine: () => machine,
      now: () => NOW,
      storage: fixture.storage,
    });
    const [first, second] = await Promise.all([engine.start(command()), engine.start(command())]);
    const fromAnotherClient = await engine.start(command({ target: { ...command().target, desktopSessionId: null } }));
    expect(controlled.calls).toHaveLength(1);
    expect([first.attempt.reused, second.attempt.reused].sort()).toEqual([false, true]);
    expect(first.attempt.attemptId).toBe(second.attempt.attemptId);
    expect(fromAnotherClient.attempt).toMatchObject({ attemptId: first.attempt.attemptId, reused: true });
    expect(await attempts(fixture.dbPath)).toHaveLength(1);
    controlled.settle(FINISHED);
    await engine.settle();
  });

  test('a restart with the review still running keeps the target reserved and never touches that process', async () => {
    const fixture = await createFixture();
    const missing = await service(fixture, path.join(fixture.home, 'no-such-claude')).start(command());
    expect(missing.attempt.state).toBe('failed');
    expect((await attemptById(fixture.dbPath, missing.attempt.attemptId)).failureReason).toContain(
      'executor-unavailable',
    );

    const executable = await fixture.executable(`${emit(INIT_LINE)}\nsetTimeout(() => process.exit(0), 60_000);`);
    const engine = service(fixture, executable);
    const started = await engine.start(command());
    await new Promise((resolve) => setTimeout(resolve, 200));
    let attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ nativeSessionId: 'native-engine-1', state: 'running' });
    const pid = attempt.pid ?? 0;

    // A restarted engine holds no pipe to the process; the real process table still shows it.
    const restarted = service(fixture, executable);
    expect(await restarted.recoverLost()).toEqual([started.attempt.attemptId]);
    attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ releasedAt: null, state: 'lost' });
    expect(attempt.failureReason).toContain('engine restarted while running');
    expect(attempt.failureReason).toContain(`still runs (pid ${pid})`);
    const refused = await restarted.start(command());
    expect(refused).toMatchObject({
      attempt: { reused: false, state: 'refused' },
      refusal: { reason: 'attempt-unresolved' },
    });
    expect(refused.refusal?.message).toContain(`--session-id ${attempt.launchSessionId}`);
    expect(refused.refusal?.message).toContain('neither adopts nor stops');
    expect(restarted.live()).toEqual([]);
    expect(() => process.kill(pid, 0)).not.toThrow();

    // The engine that started it stops it at its own shutdown and records the end it saw.
    await engine.shutdown();
    attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ releaseEvidence: 'outcome-recorded-late', state: 'lost' });
    const relaunched = await restarted.start(command());
    expect(relaunched.attempt).toMatchObject({ reused: false, state: 'starting' });
    await restarted.shutdown();
    // Shutdown with a live run of its own: the process is stopped, its exit seen, the row ended.
    const stopped = await attemptById(fixture.dbPath, relaunched.attempt.attemptId);
    expect(stopped).toMatchObject({
      failureReason:
        'stopped at engine shutdown: the engine terminated its process and saw it exit (terminated by the engine)',
      resultKind: 'error',
      state: 'failed',
    });
    await expect(restarted.start(command())).rejects.toThrow('stopping');
    // Several real launches (CLI qualification, git scope, a process to stop): more than the default budget.
  }, 30_000);

  test('a lost attempt whose launch marker no process carries is released, and the review launches', async () => {
    const fixture = await createFixture();
    const controlled = controlledLauncher();
    const engine = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      launcher: controlled.launcher,
      machine: () => machine,
      now: () => NOW,
      storage: fixture.storage,
    });
    const first = await engine.start(command());
    // Contact is recorded lost (as by a restart) while the real process table shows no such marker.
    await Effect.runPromise(
      markReviewAttemptsLost({
        at: NOW.toISOString(),
        dbPath: fixture.dbPath,
        machineId: machine.id,
        reason: () => 'lost',
      }),
    );
    // The engine that launched it still tracks it, so it alone would never call it gone.
    expect((await engine.start(command())).refusal?.reason).toBe('attempt-unresolved');
    const next = controlledLauncher();
    const restarted = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      launcher: next.launcher,
      machine: () => machine,
      now: () => NOW,
      storage: fixture.storage,
    });
    const second = await restarted.start(command());
    expect(second.attempt).toMatchObject({ reused: false, state: 'starting' });
    expect(await attemptById(fixture.dbPath, first.attempt.attemptId)).toMatchObject({
      releaseEvidence: 'process-absent',
      state: 'lost',
    });
    controlled.settle(FINISHED);
    next.settle(FINISHED);
    await Promise.all([engine.settle(), restarted.settle()]);
  });

  test('a late heartbeat after the loss changes nothing; a late result is recorded and releases the target', async () => {
    const fixture = await createFixture();
    const controlled = controlledLauncher();
    const owner = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      findProcesses: scanFound,
      launcher: controlled.launcher,
      machine: () => machine,
      now: () => NOW,
      storage: fixture.storage,
    });
    const started = await owner.start(command());
    const restarted = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      findProcesses: scanFound,
      launcher: controlledLauncher().launcher,
      machine: () => machine,
      now: () => new Date('2026-10-22T10:05:00.000Z'),
      storage: fixture.storage,
    });
    await restarted.recoverLost();
    const lost = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(lost).toMatchObject({ releasedAt: null, state: 'lost' });

    await controlled.calls[0]?.events.onHeartbeat?.();
    await controlled.calls[0]?.events.onInit?.('native-late');
    expect(await attemptById(fixture.dbPath, started.attempt.attemptId)).toEqual(lost);
    expect((await restarted.start(command())).refusal?.reason).toBe('attempt-unresolved');

    controlled.settle(FINISHED);
    await owner.settle();
    expect(await attemptById(fixture.dbPath, started.attempt.attemptId)).toMatchObject({
      releaseEvidence: 'outcome-recorded-late',
      resultExcerpt: 'Finding 1: late but real.',
      resultKind: 'review',
      state: 'lost',
    });
    expect((await restarted.start(command())).attempt).toMatchObject({ reused: false, state: 'starting' });
  });

  test('without a readable process table the reservation stays held, and the refusal says why', async () => {
    const fixture = await createFixture();
    await Effect.runPromise(
      requestReviewAttempt({
        attempt: {
          attemptId: 'attempt-elsewhere',
          candidateId: CANDIDATE_ID,
          declaration: null,
          executorHarness: 'claude-code',
          idempotencyKey: 'f'.repeat(64),
          launchSessionId: '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
          machineId: machine.id,
          requestedAt: NOW.toISOString(),
          state: 'requested',
          target: {
            checkoutOrigin: 'desktop-cwd',
            checkoutPath: '/elsewhere',
            desktopSessionId: null,
            harness: 'claude',
            projectLabel: null,
            sessionTitle: null,
            sourceSessionId: 'cli-1',
          },
        },
        dbPath: fixture.dbPath,
      }),
    );
    await Effect.runPromise(
      transitionReviewAttempt({
        at: NOW.toISOString(),
        attemptId: 'attempt-elsewhere',
        dbPath: fixture.dbPath,
        patch: { state: 'running' },
      }),
    );
    const engine = createReviewAttemptService({
      admission: admissionFor(fixture),
      dbPath: fixture.dbPath,
      findProcesses: async () => ({ kind: 'unavailable', reason: 'no readable process table on darwin' }),
      launcher: controlledLauncher().launcher,
      machine: () => machine,
      now: () => NOW,
      storage: fixture.storage,
    });
    await engine.recoverLost();
    const held = await attemptById(fixture.dbPath, 'attempt-elsewhere');
    expect(held.failureReason).toContain('the process table is not readable (no readable process table on darwin)');
    // Another identity on the same target: still refused, since a process may run on it.
    const refused = await engine.start(command());
    expect(refused.refusal?.reason).toBe('attempt-unresolved');
    expect(refused.refusal?.message).toContain('cannot tell whether its harness process still runs');
  });

  test('a row recorded before launch markers is released only by the operator declaration, then a review launches', async () => {
    const fixture = await createFixture();
    // The first version's live row, without a launch marker, as an unclean stop left it.
    await Effect.runPromise(
      requestReviewAttempt({
        attempt: {
          attemptId: 'attempt-legacy',
          candidateId: CANDIDATE_ID,
          declaration: null,
          executorHarness: 'claude-code',
          idempotencyKey: 'e'.repeat(64),
          machineId: machine.id,
          requestedAt: NOW.toISOString(),
          state: 'requested',
          target: {
            checkoutOrigin: 'desktop-cwd',
            checkoutPath: '/elsewhere',
            desktopSessionId: null,
            harness: 'claude',
            projectLabel: null,
            sessionTitle: null,
            sourceSessionId: 'cli-1',
          },
        },
        dbPath: fixture.dbPath,
      }),
    );
    const engine = service(fixture, await fixture.executable(emit(INIT_LINE, RESULT_LINE)), {
      findProcesses: async () => ({ kind: 'absent' }),
    });
    await engine.recoverLost();
    const refused = await engine.start(command());
    expect(refused.refusal?.reason).toBe('attempt-unresolved');
    expect(refused.refusal?.message).toContain('recorded before launch markers existed');
    expect(refused.refusal?.message).toContain('“Declare the review ended”');

    const released = await engine.releaseReservation({
      attemptId: 'attempt-legacy',
      command: 'release-review-reservation',
    });
    expect(released).toEqual({
      attemptId: 'attempt-legacy',
      evidence: 'operator-declared-ended',
      kind: 'review-reservation-release',
      pids: [],
      releasedAt: NOW.toISOString(),
      result: 'released',
    });
    expect(await attemptById(fixture.dbPath, 'attempt-legacy')).toMatchObject({
      releaseEvidence: 'operator-declared-ended',
      releasedAt: NOW.toISOString(),
      state: 'lost',
    });
    // Nothing left to release; the target accepts a review again.
    expect(
      (await engine.releaseReservation({ attemptId: 'attempt-legacy', command: 'release-review-reservation' })).result,
    ).toBe('not-held');
    const started = await engine.start(command());
    expect(started.refusal).toBeNull();
    await engine.settle();
  });

  test('a declared release never overrides a process that still carries the marker', async () => {
    const fixture = await createFixture();
    const marker = '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
    await Effect.runPromise(
      requestReviewAttempt({
        attempt: {
          attemptId: 'attempt-running-elsewhere',
          candidateId: CANDIDATE_ID,
          declaration: null,
          executorHarness: 'claude-code',
          idempotencyKey: 'd'.repeat(64),
          launchSessionId: marker,
          machineId: machine.id,
          requestedAt: NOW.toISOString(),
          state: 'requested',
          target: {
            checkoutOrigin: 'desktop-cwd',
            checkoutPath: '/elsewhere',
            desktopSessionId: null,
            harness: 'claude',
            projectLabel: null,
            sessionTitle: null,
            sourceSessionId: 'cli-1',
          },
        },
        dbPath: fixture.dbPath,
      }),
    );
    const engine = service(fixture, await fixture.executable(emit(INIT_LINE, RESULT_LINE)), {
      findProcesses: scanFound,
    });
    await engine.recoverLost();
    const answer = await engine.releaseReservation({
      attemptId: 'attempt-running-elsewhere',
      command: 'release-review-reservation',
    });
    expect(answer).toMatchObject({ evidence: null, pids: [4242], releasedAt: null, result: 'process-found' });
    expect((await attemptById(fixture.dbPath, 'attempt-running-elsewhere')).releasedAt).toBeNull();
  });
});
