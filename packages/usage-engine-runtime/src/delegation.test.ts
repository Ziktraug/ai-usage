import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeAccountProbe, CodexAuthProbe } from '@ai-usage/local-collectors/executor-observations';
import {
  DELEGATION_HARNESS_CONTROLS,
  type ReviewWorkerAdapter,
  type ReviewWorkerEvents,
  type ReviewWorkerOutcome,
  type ReviewWorkerSpec,
  type ReviewWorkerTerminationReason,
} from '@ai-usage/local-collectors/review-worker';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type { DelegationJob, DelegationQualification } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import { DELEGATION_OUTPUT_JSON_SCHEMA } from '@ai-usage/report-core/delegation-result';
import type { DelegationExecutorHarness } from '@ai-usage/report-core/delegation-vocabulary';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import type { UsageEngineCommand, UsageEngineDelegationQualificationOutput } from '@ai-usage/usage-engine-control';
import {
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  readDelegationJobs,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService, type DelegationServiceOptions } from './delegation';
import type { FindReviewProcesses } from './review-attempts-process';
import type { RoutingQualificationExecutorRun } from './runtime';

/**
 * The engine side of a delegation against a real disposable store, a real temporary git checkout
 * and fake harness adapters: no process is spawned, no collected session or Claude Desktop registry
 * exists, and every decision is read back from the rows the engine wrote.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';
const FINGERPRINT = '0123456789abcdef';
const OTHER_FINGERPRINT = 'fedcba9876543210';
const CLAUDE_ROUTE = `declared:${JSON.stringify([machine.id, 'claude-code', 'personal'])}`;
const CODEX_ROUTE = `declared:${JSON.stringify([machine.id, 'codex', 'work'])}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STRUCTURED_FINAL = JSON.stringify({
  checks: ['read a.txt'],
  coverage: { notReviewed: [], reviewed: 'a.txt' },
  findings: [
    {
      detail: 'The second line adds nothing.',
      evidence: [{ line: 2, path: 'a.txt' }],
      severity: 'note',
      title: 'Redundant line',
    },
  ],
  limits: ['no tests were run'],
  summary: 'One note.',
});
const RUN: RoutingQualificationExecutorRun = { source: null, startedAt: NOW };

const finished = (finalText: string | null, overrides: Partial<ReviewWorkerOutcome> = {}): ReviewWorkerOutcome => ({
  durationMs: 1234,
  exitCode: 0,
  failureReason: null,
  finalText,
  kind: 'finished',
  nativeSessionId: 'native-1',
  numTurns: 3,
  resolvedModel: null,
  resultKind: 'review',
  usage: { cachedInputTokens: null, inputTokens: 1000, outputTokens: 200, source: 'harness-reported' },
  ...overrides,
});
const stopped = (reason: ReviewWorkerTerminationReason): ReviewWorkerOutcome => ({
  durationMs: 50,
  exitCode: 143,
  failureReason: reason === 'cancel' ? 'cancelled by the engine' : 'terminated at engine shutdown',
  finalText: 'partial',
  kind: 'failed',
  nativeSessionId: 'native-1',
  numTurns: 1,
  resolvedModel: null,
  resultKind: reason === 'cancel' ? 'cancelled' : 'error',
  usage: null,
});

interface FakeLaunch {
  readonly events: ReviewWorkerEvents;
  readonly settle: (outcome: ReviewWorkerOutcome) => void;
  readonly spec: ReviewWorkerSpec;
  readonly terminated: ReviewWorkerTerminationReason[];
}

/** An adapter whose launches the test drives: events fire on demand, the outcome settles when told. */
const fakeAdapter = (harness: DelegationExecutorHarness, options: { readonly initOnLaunch?: boolean } = {}) => {
  const launches: FakeLaunch[] = [];
  const adapter: ReviewWorkerAdapter = {
    harness,
    launch: async (spec, events) => {
      let settle: (outcome: ReviewWorkerOutcome) => void = () => undefined;
      const outcome = new Promise<ReviewWorkerOutcome>((resolve) => {
        settle = resolve;
      });
      const entry: FakeLaunch = { events, settle: (value) => settle(value), spec, terminated: [] };
      launches.push(entry);
      if (options.initOnLaunch) {
        await events.onInit?.('native-early', 'claude-opus-4-1');
      }
      return {
        args: [],
        guarantee: {
          cliVersion: '9.9.9',
          controls: [...DELEGATION_HARNESS_CONTROLS[harness].controls],
          effort: spec.effort,
          harness,
          limits: [...DELEGATION_HARNESS_CONTROLS[harness].limits],
          model: spec.model,
        },
        outcome,
        pid: 4000 + launches.length,
        terminate: (reason) => {
          entry.terminated.push(reason);
          queueMicrotask(() => settle(stopped(reason)));
        },
      };
    },
  };
  return { adapter, launches };
};

interface Fixture {
  readonly checkout: string;
  readonly commits: readonly string[];
  readonly configPath: string;
  readonly dbPath: string;
  readonly home: string;
  readonly privateRoot: string;
  readonly root: string;
  readonly storage: ReturnType<typeof createLocalHistoryStorage>;
  readonly writeConfig: (config: Record<string, unknown>) => Promise<void>;
}

interface FixtureOptions {
  readonly claudeDeclaration?: Record<string, unknown> | null;
  readonly claudeObservation?: Partial<ExecutorObservation> | null;
  readonly codexDeclaration?: Record<string, unknown> | null;
  readonly delegation?: Record<string, unknown>;
  readonly extraConfig?: Record<string, unknown>;
}

const declarationFor = (harness: DelegationExecutorHarness, accountScope: string): Record<string, unknown> => ({
  accountScope,
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T08:00:00.000Z',
  harness,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
});

const observationFor = (
  harness: DelegationExecutorHarness,
  overrides: Partial<ExecutorObservation> = {},
): ExecutorObservation => ({
  authEvidence: `${harness} status exit 0`,
  authMethod: harness === 'claude-code' ? 'claude.ai' : null,
  authState: 'logged-in',
  binaryPath: `/usr/local/bin/${harness}`,
  harness,
  machineId: machine.id,
  observedAt: '2026-10-25T09:58:00.000Z',
  outcome: 'observed',
  version: harness === 'claude-code' ? '2.1.306 (Claude Code)' : 'codex-cli 0.164.0',
  ...overrides,
});

const quotaFor = (providerKey: 'claude' | 'codex'): ProviderQuotaObservation => ({
  accountScope: null,
  machineId: machine.id,
  machineLabel: machine.label,
  observedAt: '2026-10-25T09:57:00.000Z',
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
      remainingPercent: 70,
      resetsAt: '2026-10-25T13:00:00.000Z',
      scope: 'global',
      usedPercent: 30,
    },
  ],
});

const createFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-delegation-'));
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
  for (const [index, content] of ['one\n', 'one\ntwo\n', 'one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\n'].entries()) {
    await writeFile(path.join(checkout, 'a.txt'), content);
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', `commit ${index + 1}`);
    commits.push(await git('rev-parse', 'HEAD'));
  }
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  const configPath = path.join(home, '.config', 'ai-usage', 'config.json');
  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  };
  const executors = [
    ...(options.claudeDeclaration === null
      ? []
      : [{ ...declarationFor('claude-code', 'personal'), ...options.claudeDeclaration }]),
    ...(options.codexDeclaration === undefined || options.codexDeclaration === null
      ? []
      : [{ ...declarationFor('codex', 'work'), ...options.codexDeclaration }]),
  ];
  await writeConfig({
    delegation: {
      routes: [
        { accountScope: 'personal', context: 'personal', harness: 'claude-code' },
        { accountScope: 'work', context: 'professional', harness: 'codex' },
      ],
      ...options.delegation,
    },
    github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
    routing: { executors, reviewTargets: [{ checkoutPath: path.join(root, 'work'), label: 'fixture' }] },
    ...options.extraConfig,
  });
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: new Date(NOW) }));
  const observations: ExecutorObservation[] = [
    ...(options.claudeObservation === null ? [] : [observationFor('claude-code', options.claudeObservation ?? {})]),
    ...(options.codexDeclaration === undefined || options.codexDeclaration === null ? [] : [observationFor('codex')]),
  ];
  await Effect.runPromise(importExecutorObservations({ dbPath, observations }));
  await Effect.runPromise(
    importProviderQuotaBatch({
      checkpointUpdates: [],
      dbPath,
      items: [
        { observation: quotaFor('claude'), sourceEventKey: 'fixture-claude-1' },
        { observation: quotaFor('codex'), sourceEventKey: 'fixture-codex-1' },
      ],
    }),
  );
  return { checkout, commits, configPath, dbPath, home, privateRoot, root, storage, writeConfig };
};

const scanAbsent: FindReviewProcesses = async () => ({ kind: 'absent' });
const scanFound: FindReviewProcesses = async () => ({ kind: 'found', pids: [4242] });

interface ServiceOptions {
  readonly adapters?: readonly ReviewWorkerAdapter[];
  /** The launch-time Codex sign-in probe; defaults to a ChatGPT subscription sign-in. */
  readonly codexProbe?: CodexAuthProbe;
  readonly findProcesses?: FindReviewProcesses;
  readonly now?: () => Date;
  readonly probe?: ClaudeAccountProbe;
}

const SUBSCRIPTION_CODEX_PROBE: CodexAuthProbe = {
  authMethod: 'chatgpt',
  authState: 'logged-in',
  evidence: 'codex login status exit 0 authMethod=chatgpt (fixture)',
  outcome: 'observed',
};

const service = (fixture: Fixture, extra: ServiceOptions = {}) => {
  const lines: string[] = [];
  const options: DelegationServiceOptions = {
    adapterOptions: { env: { HOME: fixture.home, PATH: process.env.PATH } },
    ...(extra.adapters === undefined ? {} : { adapters: extra.adapters }),
    dbPath: fixture.dbPath,
    findProcesses: extra.findProcesses ?? scanAbsent,
    machine: () => machine,
    now: extra.now ?? (() => new Date(NOW)),
    privateRoot: fixture.privateRoot,
    probeClaudeAccount: () => Promise.resolve(extra.probe ?? { accountFingerprint: FINGERPRINT, evidence: 'fixture' }),
    probeCodexAuth: () => Promise.resolve(extra.codexProbe ?? SUBSCRIPTION_CODEX_PROBE),
    report: (line) => {
      lines.push(line);
    },
    runLimits: { heartbeatMs: 25 },
    storage: fixture.storage,
  };
  return { lines, ...createDelegationService(options) };
};

type StartCommand = Extract<UsageEngineCommand, { readonly command: 'start-delegation' }>;

const requestFor = (
  fixture: Fixture,
  commit = 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  action: 'read-only-review',
  checkout: { path: fixture.checkout },
  constraints: ['Do not run tests'],
  criteria: ['The change is explained'],
  objective: `Review commit ${commit + 1} of the fixture for correctness`,
  schemaVersion: 1,
  scope: { commit: fixture.commits[commit], kind: 'commit' },
  taskCategory: 'correctness',
  ...overrides,
});

const qualificationOf = (output: UsageEngineDelegationQualificationOutput): DelegationQualification => {
  const parsed = parseDelegationQualification(output.qualification);
  if (parsed === null) {
    throw new Error('the engine produced a qualification that does not parse');
  }
  return parsed;
};

const choose = (qualification: DelegationQualification, routeId = qualification.admissibleRouteIds[0] ?? 'none') => ({
  kind: 'choice',
  qualificationId: qualification.qualificationId,
  routeId,
  selectorVersion: 'calling-model/test',
});

const startCommand = (
  idempotencyKey: string,
  request: Record<string, unknown>,
  selection: Record<string, unknown>,
): StartCommand => ({ command: 'start-delegation', idempotencyKey, request, selection });

const jobs = async (dbPath: string): Promise<readonly DelegationJob[]> => {
  const read = await Effect.runPromise(readDelegationJobs({ dbPath, machineId: machine.id }));
  if (read.kind !== 'ok') {
    throw new Error(`jobs unreadable: ${read.kind}`);
  }
  return read.jobs;
};

const jobById = async (dbPath: string, jobId: string): Promise<DelegationJob> => {
  const found = (await jobs(dbPath)).find((job) => job.jobId === jobId);
  if (found === undefined) {
    throw new Error(`job ${jobId} is missing`);
  }
  return found;
};

const evaluationsOf = async (dbPath: string, jobId: string) => {
  const read = await Effect.runPromise(readDelegationJobs({ dbPath, jobId }));
  return read.kind === 'ok' ? read.evaluations : [];
};

const exists = async (file: string): Promise<boolean> =>
  stat(file)
    .then(() => true)
    .catch(() => false);

describe('engine delegation service (ADR 0077)', () => {
  test('a direct request on an admitted checkout qualifies and starts with no collected session or Desktop data', async () => {
    const fixture = await createFixture();
    const claude = fakeAdapter('claude-code');
    const engine = service(fixture, { adapters: [claude.adapter] });

    const qualified = await engine.qualify(
      { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) },
      RUN,
    );
    const qualification = qualificationOf(qualified);
    expect(qualification).toMatchObject({
      admissibleRouteIds: [CLAUDE_ROUTE],
      checkout: { admittedBy: path.join(fixture.root, 'work'), path: fixture.checkout, projectLabel: 'checkout' },
      outcome: 'routes-available',
      purpose: 'delegation',
      scope: { baseSha: fixture.commits[0], headSha: fixture.commits[1], kind: 'commit' },
    });
    expect(qualification.checkoutFacts).toMatchObject({
      gitAuthorEmail: { provenance: 'observed', value: 'fixture@example.invalid' },
      githubAccount: { provenance: 'declared', value: 'octocat' },
      repositories: { provenance: 'observed', value: ['acme/widgets'] },
    });
    const route = qualification.routes.find((entry) => entry.routeId === CLAUDE_ROUTE);
    expect(route).toMatchObject({
      admissible: true,
      context: 'personal',
      harness: 'claude-code',
      provider: 'anthropic',
    });

    const started = await engine.start(startCommand('caller:turn-1', requestFor(fixture), choose(qualification)));
    expect(started).toMatchObject({
      job: { reused: false, state: 'starting' },
      kind: 'delegation-start',
      refusal: null,
    });
    const jobId = started.job?.jobId ?? '';
    expect(jobId).toMatch(UUID);
    expect(engine.live()).toEqual([jobId]);
    expect(claude.launches).toHaveLength(1);
    const [launch] = claude.launches;
    expect(launch?.spec).toMatchObject({
      checkoutPath: fixture.checkout,
      effort: null,
      heartbeatMs: 25,
      model: null,
      outputSchema: null,
      privateDirectory: path.join(fixture.privateRoot, jobId),
    });
    expect(launch?.spec.launchMarker).toMatch(UUID);
    expect(launch?.spec.prompt).toContain('Objective:\nReview commit 2 of the fixture for correctness\n');
    expect(launch?.spec.prompt).toContain('+two');
    expect(launch?.spec.prompt).toContain(
      `commit ${fixture.commits[1]} against its first parent ${fixture.commits[0]}`,
    );
    expect(await exists(path.join(fixture.privateRoot, jobId))).toBe(true);
    expect(((await stat(fixture.privateRoot)).mode % 0o1000).toString(8)).toBe('700');

    let job = await jobById(fixture.dbPath, jobId);
    expect(job).toMatchObject({
      accountScope: 'personal',
      context: 'personal',
      executedScope: { fileCount: 1, files: [{ coverage: 'complete', path: 'a.txt' }], truncated: false },
      executorHarness: 'claude-code',
      guarantee: { cliVersion: '9.9.9', harness: 'claude-code' },
      harnessVersion: '9.9.9',
      idempotencyKey: 'caller:turn-1',
      launchMarker: launch?.spec.launchMarker,
      pid: 4001,
      qualificationId: qualification.qualificationId,
      routeId: CLAUDE_ROUTE,
      state: 'starting',
    });
    expect(job.qualification?.purpose).toBe('delegation');
    expect(job.qualification?.qualificationId).not.toBe(qualification.qualificationId);

    await launch?.events.onInit?.('native-engine-1', 'claude-opus-4-1');
    job = await jobById(fixture.dbPath, jobId);
    expect(job).toMatchObject({
      modelResolved: 'claude-opus-4-1',
      nativeSessionId: 'native-engine-1',
      state: 'running',
    });
    launch?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
    job = await jobById(fixture.dbPath, jobId);
    expect(job).toMatchObject({
      exitCode: 0,
      result: { excerpt: null, kind: 'review', review: { summary: 'One note.' } },
      state: 'finished',
      usage: { inputTokens: 1000, outputTokens: 200, source: 'harness-reported' },
    });
    expect(job.result?.review?.findings).toHaveLength(1);
    expect(engine.live()).toEqual([]);
    expect(await exists(path.join(fixture.privateRoot, jobId))).toBe(false);
    const evaluations = await evaluationsOf(fixture.dbPath, jobId);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({
      author: 'automated-check',
      kind: 'verification',
      verdict: 'confirmed',
    });
    expect(evaluations[0]?.note).toContain('structural check only');
    expect(engine.lines.some((line) => line.includes('delegation=finished'))).toBe(true);
    expect(engine.lines.some((line) => line.includes(fixture.checkout))).toBe(false);
  });

  test('the same key with the same content reuses the job after a timeout; another content is an idempotency conflict', async () => {
    const fixture = await createFixture();
    const claude = fakeAdapter('claude-code');
    const engine = service(fixture, { adapters: [claude.adapter] });
    const qualification = qualificationOf(
      await engine.qualify({ command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) }, RUN),
    );
    const command = startCommand('caller:turn-2', requestFor(fixture), choose(qualification));
    const first = await engine.start(command);
    // The caller's command timed out on its side; it retries with the same key and content.
    const retry = await engine.start(command);
    expect(retry).toMatchObject({
      job: { jobId: first.job?.jobId, reused: true, state: 'starting' },
      refusal: null,
    });
    expect(claude.launches).toHaveLength(1);

    const conflict = await engine.start(
      startCommand('caller:turn-2', requestFor(fixture, 1, { objective: 'Something else' }), choose(qualification)),
    );
    expect(conflict).toMatchObject({ job: null, refusal: { reason: 'idempotency-conflict' } });
    expect(conflict.refusal?.message).toContain(first.job?.jobId ?? 'missing');
    expect(await jobs(fixture.dbPath)).toHaveLength(1);
    claude.launches[0]?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
  });

  test('one target launches once under concurrent starts; a busy pool and an exhausted chain refuse as data', async () => {
    const fixture = await createFixture({ delegation: { defaults: { maxAttempts: 2 } } });
    const claude = fakeAdapter('claude-code');
    const engine = service(fixture, { adapters: [claude.adapter] });
    const qualify = async (commit: number, retryOf?: string) =>
      qualificationOf(
        await engine.qualify(
          {
            command: 'qualify-delegation',
            purpose: 'delegation',
            request: requestFor(fixture, commit, retryOf === undefined ? {} : { retryOf }),
          },
          RUN,
        ),
      );
    const qualification = await qualify(1);
    // Qualified now, while the pool is idle; its start below finds the pool busy.
    const second = await qualify(2);
    const [left, right] = await Promise.all([
      engine.start(startCommand('caller:left', requestFor(fixture), choose(qualification))),
      engine.start(startCommand('caller:right', requestFor(fixture), choose(qualification))),
    ]);
    const outcomes = [left, right].map((answer) => answer.refusal?.reason ?? answer.job?.state);
    expect(outcomes.sort()).toEqual(['starting', 'target-reserved']);
    expect(claude.launches).toHaveLength(1);
    const loser = [left, right].find((answer) => answer.refusal !== null);
    expect(loser?.job?.state).toBe('refused');
    expect(loser?.refusal?.message).toContain('already reserves this review');
    const winner = [left, right].find((answer) => answer.refusal === null);

    // Another target, same pool: qualified before the first job existed, refused now because the pool is busy.
    const busy = await engine.start(startCommand('caller:busy', requestFor(fixture, 2), choose(second)));
    expect(busy).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'pool-busy' } });
    expect(claude.launches).toHaveLength(1);

    // The first job finishes; a retry of it on another commit may run (chain: 1 attempt of 2).
    claude.launches[0]?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
    const firstJobId = winner?.job?.jobId ?? '';
    const retryQualification = await qualify(2, firstJobId);
    const thirdQualification = await qualify(3, firstJobId);
    const retry = await engine.start(
      startCommand('caller:retry', requestFor(fixture, 2, { retryOf: firstJobId }), choose(retryQualification)),
    );
    expect(retry).toMatchObject({ job: { state: 'starting' }, refusal: null });
    expect(await jobById(fixture.dbPath, retry.job?.jobId ?? '')).toMatchObject({
      attemptNumber: 2,
      retryOf: firstJobId,
    });
    claude.launches[1]?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
    // A third attempt in the chain (qualified while the chain still had room) is refused at start.
    const third = await engine.start(
      startCommand('caller:third', requestFor(fixture, 3, { retryOf: firstJobId }), choose(thirdQualification)),
    );
    expect(third).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'attempts-exhausted' } });
    expect(claude.launches).toHaveLength(2);
    // An unknown retryOf is refused without a row.
    const unknownRetry = await engine.start(
      startCommand(
        'caller:unknown-retry',
        requestFor(fixture, 3, { retryOf: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5' }),
        choose(thirdQualification),
      ),
    );
    expect(unknownRetry).toMatchObject({ job: null, refusal: { reason: 'invalid-request' } });
  });

  test('a launch is refused when the policy, the qualification, the route or the pinned account moved', async () => {
    const fixture = await createFixture({
      claudeDeclaration: { accountFingerprint: FINGERPRINT },
      claudeObservation: { accountFingerprint: FINGERPRINT },
    });
    const claude = fakeAdapter('claude-code');
    const clock = { now: new Date(NOW) };
    const engine = service(fixture, { adapters: [claude.adapter], now: () => clock.now });
    const qualify = async () =>
      qualificationOf(
        await engine.qualify(
          { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) },
          RUN,
        ),
      );
    const qualification = await qualify();
    expect(qualification.routes[0]?.identity).toMatchObject({ state: 'confirmed' });

    const forged = await engine.start(
      startCommand('caller:forged', requestFor(fixture), choose(qualification, `${CLAUDE_ROUTE}:model:9:forged`)),
    );
    expect(forged).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'route-not-admissible' } });

    const unknownQualification = await engine.start(
      startCommand('caller:unknown', requestFor(fixture), {
        ...choose(qualification),
        qualificationId: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5',
      }),
    );
    expect(unknownQualification).toMatchObject({
      job: { state: 'refused' },
      refusal: { reason: 'qualification-unknown' },
    });

    const simulation = qualificationOf(
      await engine.qualify({ command: 'qualify-delegation', purpose: 'simulation', request: requestFor(fixture) }, RUN),
    );
    const simulated = await engine.start(startCommand('caller:simulated', requestFor(fixture), choose(simulation)));
    expect(simulated).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'qualification-mismatch' } });

    // The policy moves between the qualification and the start: a review target is added.
    const before = JSON.parse(await readFile(fixture.configPath, 'utf8')) as Record<string, unknown>;
    const routing = before.routing as { executors: unknown[]; reviewTargets: unknown[] };
    await fixture.writeConfig({
      ...before,
      routing: { ...routing, reviewTargets: [...routing.reviewTargets, { checkoutPath: '/srv/other' }] },
    });
    const policyChanged = await engine.start(startCommand('caller:policy', requestFor(fixture), choose(qualification)));
    expect(policyChanged).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'policy-changed' } });

    // The pinned account changed at start: the fresh probe disagrees with the pin.
    const fresh = await qualify();
    const changed = service(fixture, {
      adapters: [claude.adapter],
      now: () => clock.now,
      probe: { accountFingerprint: OTHER_FINGERPRINT, evidence: 'claude auth status' },
    });
    const identity = await changed.start(startCommand('caller:identity', requestFor(fixture), choose(fresh)));
    expect(identity).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'identity-changed' } });
    expect(identity.refusal?.message).toContain(OTHER_FINGERPRINT);

    // The qualification expired.
    clock.now = new Date(Date.parse(fresh.validUntil) + 60_000);
    const expired = await engine.start(startCommand('caller:expired', requestFor(fixture), choose(fresh)));
    expect(expired).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'qualification-expired' } });

    expect(claude.launches).toHaveLength(0);
    const rows = await jobs(fixture.dbPath);
    expect(rows.map((row) => [row.idempotencyKey, row.state, row.refusalReason]).sort()).toEqual(
      [
        ['caller:expired', 'refused', 'qualification-expired'],
        ['caller:forged', 'refused', 'route-not-admissible'],
        ['caller:identity', 'refused', 'identity-changed'],
        ['caller:policy', 'refused', 'policy-changed'],
        ['caller:simulated', 'refused', 'qualification-mismatch'],
        ['caller:unknown', 'refused', 'qualification-unknown'],
      ].sort(),
    );
    // A retry of a recorded refusal answers the same, from the row.
    const again = await engine.start(
      startCommand('caller:forged', requestFor(fixture), choose(qualification, `${CLAUDE_ROUTE}:model:9:forged`)),
    );
    expect(again).toMatchObject({
      job: { reused: true, state: 'refused' },
      refusal: { reason: 'route-not-admissible' },
    });
  });

  test('a Codex route and a Claude route launch through the same path with their adapter spec', async () => {
    const fixture = await createFixture({ codexDeclaration: {} });
    const claude = fakeAdapter('claude-code');
    const codex = fakeAdapter('codex');
    const engine = service(fixture, { adapters: [claude.adapter, codex.adapter] });
    const qualification = qualificationOf(
      await engine.qualify({ command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) }, RUN),
    );
    expect([...qualification.admissibleRouteIds].sort()).toEqual([CLAUDE_ROUTE, CODEX_ROUTE].sort());
    const codexRoute = qualification.routes.find((route) => route.routeId === CODEX_ROUTE);
    expect(codexRoute).toMatchObject({
      context: 'professional',
      identity: { state: 'not-observable' },
      provider: 'openai',
    });

    const viaCodex = await engine.start(
      startCommand('caller:codex', requestFor(fixture), choose(qualification, CODEX_ROUTE)),
    );
    expect(viaCodex).toMatchObject({ job: { state: 'starting' }, refusal: null });
    const other = qualificationOf(
      await engine.qualify(
        { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture, 2) },
        RUN,
      ),
    );
    const viaClaude = await engine.start(
      startCommand('caller:claude', requestFor(fixture, 2), choose(other, CLAUDE_ROUTE)),
    );
    expect(viaClaude).toMatchObject({ job: { state: 'starting' }, refusal: null });

    expect(codex.launches[0]?.spec.outputSchema).toEqual(DELEGATION_OUTPUT_JSON_SCHEMA);
    expect(claude.launches[0]?.spec.outputSchema).toBeNull();
    expect(codex.launches[0]?.spec.prompt).toContain('+two');
    expect(claude.launches[0]?.spec.prompt).toContain('+three');
    const codexJob = await jobById(fixture.dbPath, viaCodex.job?.jobId ?? '');
    expect(codexJob).toMatchObject({
      accountScope: 'work',
      context: 'professional',
      executorHarness: 'codex',
      poolId: CODEX_ROUTE,
    });
    expect(codexJob.guarantee?.controls).toContain('Codex sandbox read-only');
    codex.launches[0]?.settle(finished(STRUCTURED_FINAL, { nativeSessionId: 'thread-1' }));
    claude.launches[0]?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
    expect((await jobById(fixture.dbPath, viaCodex.job?.jobId ?? '')).state).toBe('finished');
    expect((await jobById(fixture.dbPath, viaClaude.job?.jobId ?? '')).state).toBe('finished');
  });

  test('cancel ends a tracked worker as cancelled; a restart marks live rows lost and holds or releases them; shutdown stops', async () => {
    const fixture = await createFixture();
    const claude = fakeAdapter('claude-code');
    const engine = service(fixture, { adapters: [claude.adapter] });
    const qualify = async (commit: number) =>
      qualificationOf(
        await engine.qualify(
          { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture, commit) },
          RUN,
        ),
      );
    const first = await engine.start(startCommand('caller:cancel', requestFor(fixture), choose(await qualify(1))));
    const cancelId = first.job?.jobId ?? '';
    expect(await engine.cancel({ command: 'cancel-delegation', jobId: cancelId })).toEqual({
      jobId: cancelId,
      kind: 'delegation-cancel',
      result: 'cancelling',
      state: 'starting',
    });
    expect(claude.launches[0]?.terminated).toEqual(['cancel']);
    await engine.settle();
    const cancelled = await jobById(fixture.dbPath, cancelId);
    expect(cancelled).toMatchObject({ result: { excerpt: 'partial', kind: 'cancelled' }, state: 'cancelled' });
    expect(cancelled.cancelRequestedAt).not.toBeNull();
    expect(await engine.cancel({ command: 'cancel-delegation', jobId: cancelId })).toMatchObject({
      result: 'already-ended',
      state: 'cancelled',
    });
    expect(await engine.cancel({ command: 'cancel-delegation', jobId: 'no-such-job' })).toMatchObject({
      result: 'not-found',
      state: null,
    });
    // The engine's structural check says the contract could not be checked; nothing judges the review.
    const cancelChecks = await evaluationsOf(fixture.dbPath, cancelId);
    expect(cancelChecks).toMatchObject([{ author: 'automated-check', kind: 'verification', verdict: 'inconclusive' }]);
    expect(cancelChecks[0]?.note).toContain('cancelled');

    // The target is free again after the cancel: a new start is not a relaunch, it is a new job.
    const second = await engine.start(startCommand('caller:lost', requestFor(fixture), choose(await qualify(1))));
    const lostId = second.job?.jobId ?? '';
    expect(claude.launches).toHaveLength(2);

    // A restart with the process gone: the row is lost, then released by the absence.
    const restartedAbsent = service(fixture, { adapters: [claude.adapter], findProcesses: scanAbsent });
    expect(await restartedAbsent.recoverLost()).toEqual([lostId]);
    expect(await jobById(fixture.dbPath, lostId)).toMatchObject({
      releaseEvidence: 'process-absent',
      state: 'lost',
    });
    expect(await exists(path.join(fixture.privateRoot, lostId))).toBe(false);

    // A restart with the process still listed: the row is lost and held; the target stays reserved.
    const secondTarget = await qualify(2);
    const third = await restartedAbsent.start(
      startCommand('caller:held', requestFor(fixture, 2), choose(secondTarget)),
    );
    const heldId = third.job?.jobId ?? '';
    const restartedFound = service(fixture, { adapters: [claude.adapter], findProcesses: scanFound });
    expect(await restartedFound.recoverLost()).toEqual([heldId]);
    const held = await jobById(fixture.dbPath, heldId);
    expect(held).toMatchObject({ releasedAt: null, state: 'lost' });
    expect(held.failureReason).toContain('still runs');
    // A fresh qualification of the held target refuses it; a start from the earlier one is refused the same way.
    expect((await qualify(2)).refusal).toMatchObject({ reason: 'target-reserved' });
    const reserved = await restartedFound.start(
      startCommand('caller:again', requestFor(fixture, 2), choose(secondTarget)),
    );
    expect(reserved).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'target-reserved' } });
    expect(await restartedFound.cancel({ command: 'cancel-delegation', jobId: heldId })).toMatchObject({
      result: 'not-cancellable-lost',
      state: 'lost',
    });
    // Once a listing shows the marker gone, a cancel from an engine that never tracked the job
    // releases the reservation as evidence and signals nothing.
    const observer = service(fixture, { adapters: [claude.adapter], findProcesses: scanAbsent });
    expect(await observer.cancel({ command: 'cancel-delegation', jobId: heldId })).toMatchObject({
      result: 'already-ended',
      state: 'lost',
    });
    expect(await jobById(fixture.dbPath, heldId)).toMatchObject({ releaseEvidence: 'process-absent', state: 'lost' });
    // The first engine still holds the pipe to the lost workers: their late end is recorded on the lost rows.
    claude.launches[1]?.settle(finished(STRUCTURED_FINAL));
    claude.launches[2]?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
    await restartedAbsent.settle();
    expect(await jobById(fixture.dbPath, lostId)).toMatchObject({
      releaseEvidence: 'process-absent',
      result: { kind: 'review' },
      state: 'lost',
    });

    // Shutdown terminates a tracked worker and records the stop; nothing is relaunched.
    const fourth = await restartedFound.start(
      startCommand('caller:shutdown', requestFor(fixture, 3), choose(await qualify(3))),
    );
    const shutdownId = fourth.job?.jobId ?? '';
    await restartedFound.shutdown();
    expect(claude.launches[3]?.terminated).toEqual(['shutdown']);
    const stoppedJob = await jobById(fixture.dbPath, shutdownId);
    expect(stoppedJob).toMatchObject({ result: { kind: 'error' }, state: 'failed' });
    expect(stoppedJob.failureReason).toContain('stopped at engine shutdown');
    expect(
      await restartedFound.start(startCommand('caller:late', requestFor(fixture, 3), choose(await qualify(3)))),
    ).toMatchObject({
      job: null,
      refusal: { reason: 'engine-stopping' },
    });
    expect(claude.launches).toHaveLength(4);
    expect((await jobs(fixture.dbPath)).filter((job) => job.state === 'starting' || job.state === 'running')).toEqual(
      [],
    );
  });

  test('structured output finishes as a review with an automated check; garbled output is unstructured, never a fake success', async () => {
    // Three jobs run in one pool at once, so the pool limit admits three.
    const fixture = await createFixture({ delegation: { defaults: { maxConcurrentPerPool: 3 } } });
    const claude = fakeAdapter('claude-code', { initOnLaunch: true });
    const engine = service(fixture, { adapters: [claude.adapter] });
    const qualify = async (commit: number) =>
      qualificationOf(
        await engine.qualify(
          { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture, commit) },
          RUN,
        ),
      );
    // The harness reported its init before the launch returned: the row is already running.
    const structured = await engine.start(
      startCommand('caller:structured', requestFor(fixture), choose(await qualify(1))),
    );
    expect(structured.job?.state).toBe('running');
    const garbled = await engine.start(
      startCommand('caller:garbled', requestFor(fixture, 2), choose(await qualify(2))),
    );
    const timedOut = await engine.start(
      startCommand('caller:timeout', requestFor(fixture, 3), choose(await qualify(3))),
    );
    claude.launches[0]?.settle(
      finished(`Here is my review.\n\n\`\`\`json\n${STRUCTURED_FINAL}\n\`\`\``, { nativeSessionId: 'native-early' }),
    );
    claude.launches[1]?.settle(finished('I looked at the diff and it seems fine to me.'));
    claude.launches[2]?.settle({
      ...finished(null),
      exitCode: 143,
      failureReason: 'timed out after 600 s; the process was terminated',
      kind: 'failed',
      resultKind: 'timeout',
    });
    await engine.settle();

    const reviewed = await jobById(fixture.dbPath, structured.job?.jobId ?? '');
    expect(reviewed).toMatchObject({
      modelResolved: 'claude-opus-4-1',
      nativeSessionId: 'native-early',
      result: { kind: 'review', review: { summary: 'One note.' } },
      state: 'finished',
    });
    expect(await evaluationsOf(fixture.dbPath, reviewed.jobId)).toMatchObject([
      { author: 'automated-check', kind: 'verification', verdict: 'confirmed' },
    ]);

    const unstructured = await jobById(fixture.dbPath, garbled.job?.jobId ?? '');
    expect(unstructured).toMatchObject({
      result: { excerpt: 'I looked at the diff and it seems fine to me.', kind: 'unstructured', review: null },
      state: 'finished',
    });
    expect(unstructured.failureReason).toContain('not a JSON object');
    expect(await evaluationsOf(fixture.dbPath, unstructured.jobId)).toMatchObject([
      { author: 'automated-check', kind: 'verification', verdict: 'refuted' },
    ]);

    const failed = await jobById(fixture.dbPath, timedOut.job?.jobId ?? '');
    expect(failed).toMatchObject({ exitCode: 143, result: { kind: 'timeout' }, state: 'failed' });
    const failedChecks = await evaluationsOf(fixture.dbPath, failed.jobId);
    expect(failedChecks).toMatchObject([{ author: 'automated-check', kind: 'verification', verdict: 'inconclusive' }]);
    expect(failedChecks[0]?.note).toContain('timed out');
  });

  test('an API-billed route is never launched and an unavailable route never switches provider', async () => {
    const fixture = await createFixture({
      claudeObservation: { authState: 'logged-out' },
      codexDeclaration: { subscription: 'api' },
    });
    const claude = fakeAdapter('claude-code');
    const codex = fakeAdapter('codex');
    const engine = service(fixture, { adapters: [claude.adapter, codex.adapter] });
    const qualification = qualificationOf(
      await engine.qualify({ command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) }, RUN),
    );
    expect(qualification.outcome).toBe('no-admissible-route');
    expect(qualification.admissibleRouteIds).toEqual([]);
    const codexRoute = qualification.routes.find((route) => route.routeId === CODEX_ROUTE);
    expect(codexRoute?.admissible).toBe(false);
    expect(codexRoute?.blockers).toContain('subscription');
    const claudeRoute = qualification.routes.find((route) => route.routeId === CLAUDE_ROUTE);
    expect(claudeRoute?.admissible).toBe(false);
    expect(claudeRoute?.blockers).toContain('availability');

    for (const [key, routeId] of [
      ['caller:api', CODEX_ROUTE],
      ['caller:unavailable', CLAUDE_ROUTE],
    ] as const) {
      const answer = await engine.start(startCommand(key, requestFor(fixture), choose(qualification, routeId)));
      expect(answer).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'route-not-admissible' } });
      expect(answer.refusal?.message).toContain('not offered');
    }
    const abstained = await engine.start(
      startCommand('caller:abstain', requestFor(fixture), {
        kind: 'abstain',
        note: 'No admissible route; keeping the task.',
        qualificationId: qualification.qualificationId,
        reason: 'no-suitable-route',
        selectorVersion: 'calling-model/test',
      }),
    );
    expect(abstained).toMatchObject({ job: { reused: false, state: 'abstained' }, refusal: null });
    expect(claude.launches).toHaveLength(0);
    expect(codex.launches).toHaveLength(0);
    expect((await jobs(fixture.dbPath)).map((job) => job.state).sort()).toEqual(['abstained', 'refused', 'refused']);
  });

  test('a Codex start re-reads the launch profile sign-in: an API key refuses the route, a sign-out refuses the executor', async () => {
    const fixture = await createFixture({ codexDeclaration: {} });
    const claude = fakeAdapter('claude-code');
    const codex = fakeAdapter('codex');
    const qualifier = service(fixture, { adapters: [claude.adapter, codex.adapter] });
    const qualification = qualificationOf(
      await qualifier.qualify(
        { command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) },
        RUN,
      ),
    );
    expect(qualification.admissibleRouteIds).toContain(CODEX_ROUTE);

    // The stored observation admitted the route; the profile the worker would run with bills an API key now.
    const apiKey = service(fixture, {
      adapters: [claude.adapter, codex.adapter],
      codexProbe: {
        authMethod: 'api-key',
        authState: 'logged-in',
        evidence: 'codex login status exit 0 authMethod=api-key',
        outcome: 'observed',
      },
    });
    const billed = await apiKey.start(
      startCommand('caller:codex-api-key', requestFor(fixture), choose(qualification, CODEX_ROUTE)),
    );
    expect(billed).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'route-not-admissible' } });
    expect(billed.refusal?.message).toContain('API key');
    expect(billed.refusal?.message).toContain('subscription');

    const signedOut = service(fixture, {
      adapters: [claude.adapter, codex.adapter],
      codexProbe: {
        authMethod: null,
        authState: 'logged-out',
        evidence: 'codex login status exit 1',
        outcome: 'observed',
      },
    });
    const out = await signedOut.start(
      startCommand('caller:codex-signed-out', requestFor(fixture), choose(qualification, CODEX_ROUTE)),
    );
    expect(out).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'executor-unavailable' } });
    expect(out.refusal?.message).toContain('codex login status exit 1');

    const unconfirmed = service(fixture, {
      adapters: [claude.adapter, codex.adapter],
      codexProbe: {
        authMethod: null,
        authState: 'unknown',
        evidence: 'codex login status timed-out',
        outcome: 'timeout',
      },
    });
    const timedOut = await unconfirmed.start(
      startCommand('caller:codex-unconfirmed', requestFor(fixture), choose(qualification, CODEX_ROUTE)),
    );
    expect(timedOut).toMatchObject({ job: { state: 'refused' }, refusal: { reason: 'executor-unavailable' } });

    // Nothing was launched; every refusal is a row, so a retry with the same key answers the same.
    expect(codex.launches).toHaveLength(0);
    expect(claude.launches).toHaveLength(0);
    const rows = await jobs(fixture.dbPath);
    expect(rows.map((row) => [row.idempotencyKey, row.state, row.refusalReason]).sort()).toEqual(
      [
        ['caller:codex-api-key', 'refused', 'route-not-admissible'],
        ['caller:codex-signed-out', 'refused', 'executor-unavailable'],
        ['caller:codex-unconfirmed', 'refused', 'executor-unavailable'],
      ].sort(),
    );
    const again = await apiKey.start(
      startCommand('caller:codex-api-key', requestFor(fixture), choose(qualification, CODEX_ROUTE)),
    );
    expect(again).toMatchObject({
      job: { reused: true, state: 'refused' },
      refusal: { reason: 'route-not-admissible' },
    });

    // A subscription sign-in launches, with the Claude pin untouched by the Codex probe.
    const subscription = await qualifier.start(
      startCommand('caller:codex-subscription', requestFor(fixture), choose(qualification, CODEX_ROUTE)),
    );
    expect(subscription).toMatchObject({ job: { state: 'starting' }, refusal: null });
    expect(codex.launches).toHaveLength(1);
    codex.launches[0]?.settle(finished(STRUCTURED_FINAL));
    await qualifier.settle();
  });

  test('an invalid or unsupported request is a typed refusal with no row and no stored qualification', async () => {
    const fixture = await createFixture();
    const claude = fakeAdapter('claude-code');
    const engine = service(fixture, { adapters: [claude.adapter] });
    const invalid = qualificationOf(
      await engine.qualify(
        {
          command: 'qualify-delegation',
          purpose: 'delegation',
          request: { action: 'read-only-review', schemaVersion: 1 },
        },
        RUN,
      ),
    );
    expect(invalid).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid-request' } });
    expect(invalid.refusal?.message).toContain('taskCategory');
    const unsupported = qualificationOf(
      await engine.qualify(
        {
          command: 'qualify-delegation',
          purpose: 'delegation',
          request: requestFor(fixture, 1, { action: 'code-change' }),
        },
        RUN,
      ),
    );
    expect(unsupported).toMatchObject({ outcome: 'refused', refusal: { reason: 'action-unsupported' } });
    const workingTree = qualificationOf(
      await engine.qualify(
        {
          command: 'qualify-delegation',
          purpose: 'delegation',
          request: requestFor(fixture, 1, { scope: { kind: 'working-tree' } }),
        },
        RUN,
      ),
    );
    expect(workingTree).toMatchObject({ outcome: 'refused', refusal: { reason: 'scope-unsupported' } });
    const outside = qualificationOf(
      await engine.qualify(
        {
          command: 'qualify-delegation',
          purpose: 'delegation',
          request: requestFor(fixture, 1, { checkout: { path: path.join(fixture.root, 'elsewhere') } }),
        },
        RUN,
      ),
    );
    expect(outside).toMatchObject({ outcome: 'refused', refusal: { reason: 'checkout-unavailable' } });

    const choice = {
      kind: 'choice',
      qualificationId: invalid.qualificationId,
      routeId: CLAUDE_ROUTE,
      selectorVersion: 'v',
    };
    expect(
      await engine.start(startCommand('caller:invalid', { action: 'read-only-review', schemaVersion: 1 }, choice)),
    ).toMatchObject({ job: null, refusal: { reason: 'invalid-request' } });
    expect(
      await engine.start(startCommand('caller:unsupported', requestFor(fixture, 1, { action: 'publish' }), choice)),
    ).toMatchObject({ job: null, refusal: { reason: 'action-unsupported' } });
    expect(await engine.start(startCommand('caller:selection', requestFor(fixture), { kind: 'maybe' }))).toMatchObject({
      job: null,
      refusal: { reason: 'invalid-request' },
    });
    expect(await jobs(fixture.dbPath)).toEqual([]);
    expect(claude.launches).toHaveLength(0);
    // Only the valid request with an unresolvable checkout was qualified from facts and recorded.
    const qualified = engine.lines.filter((line) => line.includes('delegation=qualified'));
    expect(qualified).toHaveLength(1);
    expect(qualified[0]).toContain('outcome=refused');
    expect(qualified[0]).toContain('inserted=true');
  });

  test('update-delegation-config writes only under the expected revision and keeps every other key', async () => {
    const fixture = await createFixture({
      extraConfig: {
        experimental: { flag: true },
        projectGroups: [{ id: 'g1', name: 'Group', sources: [{ project: 'checkout' }] }],
        sourcePolicies: { 'rtk.savings': { enabled: false } },
      },
    });
    const engine = service(fixture);
    const before = await readFile(fixture.configPath, 'utf8');
    const { revisions } = await readLocalRoutingDeclarations(fixture.home);

    const stale = await engine.updateConfig({
      command: 'update-delegation-config',
      delegation: { defaults: { reservePercent: 40 } },
      expectedRevision: '0000000000000000',
    });
    expect(stale).toEqual({
      issues: [],
      kind: 'delegation-config',
      result: 'revision-conflict',
      revision: revisions.policyRevision,
    });
    expect(await readFile(fixture.configPath, 'utf8')).toBe(before);

    const invalid = await engine.updateConfig({
      command: 'update-delegation-config',
      delegation: { rules: [{ effect: 'forbid', id: 'Bad Id', match: {} }] },
      executors: [{ harness: 'claude-code', authorization: 'maybe' }],
      expectedRevision: revisions.policyRevision,
    });
    expect(invalid).toMatchObject({ kind: 'delegation-config', result: 'invalid', revision: revisions.policyRevision });
    const issuePaths = invalid.issues.map((issue) => issue.path);
    expect(issuePaths).toContain('delegation.rules[0].id');
    expect(issuePaths).toContain('routing.executors[0].authorization');
    expect(issuePaths.every((entry) => entry.startsWith('delegation.') || entry.startsWith('routing.'))).toBe(true);
    expect(await readFile(fixture.configPath, 'utf8')).toBe(before);

    const delegation = {
      defaults: { reservePercent: 40 },
      routes: [{ accountScope: 'personal', context: 'professional', harness: 'claude-code' }],
      rules: [
        { effect: 'require', id: 'strict', match: { githubOwner: 'acme' }, require: { identityEvidence: 'observed' } },
      ],
    };
    const written = await engine.updateConfig({
      command: 'update-delegation-config',
      delegation,
      expectedRevision: revisions.policyRevision,
    });
    expect(written).toMatchObject({ issues: [], kind: 'delegation-config', result: 'written' });
    expect(written.revision).not.toBe(revisions.policyRevision);
    const after = JSON.parse(await readFile(fixture.configPath, 'utf8')) as Record<string, unknown>;
    expect(after.delegation).toEqual(delegation);
    expect(after.experimental).toEqual({ flag: true });
    expect(after.projectGroups).toEqual([{ id: 'g1', name: 'Group', sources: [{ project: 'checkout' }] }]);
    expect(after.sourcePolicies).toEqual({ 'rtk.savings': { enabled: false } });
    expect(after.github).toEqual({ accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] });
    expect((after.routing as { reviewTargets: unknown[] }).reviewTargets).toEqual([
      { checkoutPath: path.join(fixture.root, 'work'), label: 'fixture' },
    ]);
    const reread = await readLocalRoutingDeclarations(fixture.home);
    expect(reread.revisions.policyRevision).toBe(written.revision);
    expect(reread.delegation.config.defaults.reservePercent).toBe(40);

    // A later write of another section keeps the delegation section and advances the revision again.
    const targets = await engine.updateConfig({
      command: 'update-delegation-config',
      expectedRevision: written.revision,
      reviewTargets: [
        { checkoutPath: path.join(fixture.root, 'work') },
        { checkoutPath: '/srv/other', label: 'other' },
      ],
    });
    expect(targets.result).toBe('written');
    const final = JSON.parse(await readFile(fixture.configPath, 'utf8')) as Record<string, unknown>;
    expect(final.delegation).toEqual(delegation);
    expect((final.routing as { executors: unknown[] }).executors).toHaveLength(1);
    expect((final.routing as { reviewTargets: unknown[] }).reviewTargets).toHaveLength(2);
  });

  test('evaluations keep the operator, the calling model and the engine apart', async () => {
    const fixture = await createFixture();
    const claude = fakeAdapter('claude-code');
    const engine = service(fixture, { adapters: [claude.adapter] });
    const qualification = qualificationOf(
      await engine.qualify({ command: 'qualify-delegation', purpose: 'delegation', request: requestFor(fixture) }, RUN),
    );
    const started = await engine.start(startCommand('caller:evaluate', requestFor(fixture), choose(qualification)));
    const jobId = started.job?.jobId ?? '';
    const evaluate = (author: 'calling-model' | 'operator', evaluation: Record<string, unknown>, target = jobId) =>
      engine.recordEvaluation({
        author,
        authorLabel: author === 'operator' ? 'web' : 'claude-code',
        command: 'record-delegation-evaluation',
        evaluation,
        jobId: target,
      });

    expect(await evaluate('calling-model', { kind: 'acceptance', verdict: 'accepted' })).toMatchObject({
      evaluationId: null,
      refusal: { reason: 'invalid' },
    });
    expect(await evaluate('operator', { kind: 'acceptance', verdict: 'accepted' })).toMatchObject({
      evaluationId: null,
      refusal: { reason: 'not-ended' },
    });
    expect(await evaluate('calling-model', { kind: 'verification', verdict: 'confirmed' })).toMatchObject({
      evaluationId: null,
      refusal: { reason: 'not-ended' },
    });
    expect(
      await evaluate('calling-model', { author: 'operator', kind: 'verification', verdict: 'confirmed' }),
    ).toMatchObject({
      refusal: { reason: 'invalid' },
    });
    expect(await evaluate('operator', { kind: 'acceptance', verdict: 'accepted' }, 'no-such-job')).toMatchObject({
      refusal: { reason: 'not-found' },
    });

    claude.launches[0]?.settle(finished(STRUCTURED_FINAL));
    await engine.settle();
    const verified = await evaluate('calling-model', {
      checks: ['re-read a.txt'],
      kind: 'verification',
      note: 'The note is accurate.',
      verdict: 'confirmed',
    });
    expect(verified).toMatchObject({ kind: 'delegation-evaluation', refusal: null });
    expect(verified.evaluationId).toMatch(UUID);
    const accepted = await evaluate('operator', { kind: 'acceptance', verdict: 'accepted' });
    expect(accepted.refusal).toBeNull();
    const evaluations = await evaluationsOf(fixture.dbPath, jobId);
    expect(evaluations.map((entry) => [entry.author, entry.kind, entry.verdict, entry.authorLabel]).sort()).toEqual(
      [
        ['automated-check', 'verification', 'confirmed', 'engine output-contract check'],
        ['calling-model', 'verification', 'confirmed', 'claude-code'],
        ['operator', 'acceptance', 'accepted', 'web'],
      ].sort(),
    );

    // The store keeps ten verifications of the calling model per job; the eleventh is refused as invalid, with the limit named.
    for (let index = 1; index < 10; index++) {
      expect((await evaluate('calling-model', { kind: 'verification', verdict: 'confirmed' })).refusal).toBeNull();
    }
    const eleventh = await evaluate('calling-model', { kind: 'verification', verdict: 'refuted' });
    expect(eleventh).toMatchObject({ evaluationId: null, refusal: { reason: 'invalid' } });
    expect(eleventh.refusal?.message).toContain('10');
    expect(eleventh.refusal?.message).toContain('verification');
    expect(
      (await evaluationsOf(fixture.dbPath, jobId)).filter((entry) => entry.author === 'calling-model'),
    ).toHaveLength(10);
  });
});
