import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeReviewOutcome } from '@ai-usage/local-collectors/claude-review-launcher';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ReviewAttempt } from '@ai-usage/report-core/work-attempts';
import { parseClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import type { UsageEngineCommand } from '@ai-usage/usage-engine-control';
import {
  importClaudeDesktopSessions,
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  queryReviewAttempts,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createReviewAttemptService, type ReviewLauncher } from './review-attempts';

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
  readonly quota?: boolean;
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
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    JSON.stringify({
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
      state: 'ok',
      windows: [
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
    await writeFile(file, `#!${process.execPath}\n${body}\n`);
    await chmod(file, 0o700);
    return file;
  };
  return { checkout, dbPath, executable, home, storage };
};

const attempts = async (dbPath: string): Promise<readonly ReviewAttempt[]> =>
  (await Effect.runPromise(queryReviewAttempts({ dbPath }))).attempts;

/** Every row of a test shares the pinned `requestedAt`, so rows are found by id, never by list order. */
const attemptById = async (dbPath: string, attemptId: string): Promise<ReviewAttempt> => {
  const found = (await attempts(dbPath)).find((attempt) => attempt.attemptId === attemptId);
  if (!found) {
    throw new Error(`attempt ${attemptId} is missing`);
  }
  return found;
};

const service = (fixture: Fixture, executable: string, extra: { readonly timeoutMs?: number } = {}) => {
  const lines: string[] = [];
  const created = createReviewAttemptService({
    dbPath: fixture.dbPath,
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
      return { args: [], outcome, pid: process.pid, prompt: 'PROMPT', terminate: () => undefined };
    };
    const engine = createReviewAttemptService({
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

  test('fails the attempt when the executable is missing and marks live attempts lost on restart and shutdown', async () => {
    const fixture = await createFixture();
    const missing = await service(fixture, path.join(fixture.home, 'no-such-claude')).start(command());
    expect(missing.attempt.state).toBe('failed');
    let attempt = await attemptById(fixture.dbPath, missing.attempt.attemptId);
    expect(attempt.failureReason).toContain('executor-unavailable');
    expect(attempt).toMatchObject({ pid: null, resultKind: 'error', state: 'failed' });

    const executable = await fixture.executable(`${emit(INIT_LINE)}\nsetTimeout(() => process.exit(0), 60_000);`);
    const engine = service(fixture, executable);
    const started = await engine.start(command());
    await new Promise((resolve) => setTimeout(resolve, 150));
    attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt).toMatchObject({ nativeSessionId: 'native-engine-1', state: 'running' });

    // A restarted engine holds no pipe to the process: the row is lost, never relaunched.
    const restarted = service(fixture, executable);
    expect(await restarted.recoverLost()).toEqual([started.attempt.attemptId]);
    attempt = await attemptById(fixture.dbPath, started.attempt.attemptId);
    expect(attempt.state).toBe('lost');
    expect(attempt.failureReason).toContain('engine restarted while running');
    expect(attempt.failureReason).toContain('still alive');
    await engine.shutdown();
    expect(engine.live()).toEqual([]);

    // Shutdown with a live run: the process is terminated and the row is lost with the shutdown reason.
    const second = service(fixture, executable);
    const live = await second.start(command());
    expect(live.attempt.state).toBe('starting');
    await second.shutdown();
    const rows = await attempts(fixture.dbPath);
    const lost = rows.find((row) => row.attemptId === live.attempt.attemptId);
    expect(lost).toMatchObject({
      failureReason: 'engine stopped while the attempt was running; verify in the harness',
      state: 'lost',
    });
    await expect(second.start(command())).rejects.toThrow('stopping');
  });
});
