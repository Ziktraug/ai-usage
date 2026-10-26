import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DELEGATION_HARNESS_CONTROLS,
  type ReviewWorkerAdapter,
  type ReviewWorkerOutcome,
} from '@ai-usage/local-collectors/review-worker';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import type { DelegationQualification, DelegationScopeRequest } from '@ai-usage/report-core/delegation-contracts';
import { summarizeDelegationJobView } from '@ai-usage/report-core/delegation-job';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import type { ExecutorObservation } from '@ai-usage/report-core/work-executors';
import { listDelegationJobViews, readDelegationJobView } from '@ai-usage/report-data/delegation-read';
import type { UsageEngineDelegationQualificationOutput } from '@ai-usage/usage-engine-control';
import {
  importExecutorObservations,
  importProviderQuotaBatch,
  initializeUsageStore,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';
import { createDelegationService, type DelegationServiceOptions } from './delegation';
import type { RoutingQualificationExecutorRun } from './runtime';

/**
 * The frozen scope of a delegation job survives the repository moving on: a job submitted on `HEAD`
 * is frozen to the object ids of that instant, the engine persists them, and a second client reading
 * the record later, with no engine running, gets those ids back, never the ones `HEAD` names now.
 * Real disposable store, real temporary git checkout, an adapter that spawns nothing.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const NOW = '2026-10-25T10:00:00.000Z';
const FINGERPRINT = '0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RUN: RoutingQualificationExecutorRun = { source: null, startedAt: NOW };
const STRUCTURED_FINAL = JSON.stringify({
  checks: ['read a.txt'],
  coverage: { notReviewed: [], reviewed: 'a.txt' },
  findings: [],
  limits: [],
  summary: 'Nothing to report.',
});

const finished: ReviewWorkerOutcome = {
  durationMs: 10,
  exitCode: 0,
  failureReason: null,
  finalText: STRUCTURED_FINAL,
  kind: 'finished',
  nativeSessionId: 'native-1',
  numTurns: 1,
  resolvedModel: null,
  resultKind: 'review',
  usage: null,
};

/** An adapter that spawns nothing: every launch finishes at once with a structured review. */
const immediateAdapter = (): ReviewWorkerAdapter => ({
  harness: 'claude-code',
  launch: (spec) =>
    Promise.resolve({
      args: [],
      guarantee: {
        cliVersion: '9.9.9',
        controls: [...DELEGATION_HARNESS_CONTROLS['claude-code'].controls],
        effort: spec.effort,
        harness: 'claude-code',
        limits: [...DELEGATION_HARNESS_CONTROLS['claude-code'].limits],
        model: spec.model,
      },
      outcome: Promise.resolve(finished),
      pid: 4001,
      terminate: () => undefined,
    }),
});

interface Fixture {
  readonly checkout: string;
  /** Adds a commit on top of `HEAD` and returns its object id. */
  readonly commit: (content: string) => Promise<string>;
  readonly commits: readonly string[];
  readonly dbPath: string;
  readonly git: (...args: string[]) => Promise<string>;
  readonly home: string;
  readonly privateRoot: string;
  readonly storage: ReturnType<typeof createLocalHistoryStorage>;
}

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'engine-delegation-scope-'));
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
  const commit = async (content: string): Promise<string> => {
    await writeFile(path.join(checkout, 'a.txt'), content);
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', `commit ${content.split('\n').length}`);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Fixture');
  await git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  const commits: string[] = [];
  for (const content of ['one\n', 'one\ntwo\n', 'one\ntwo\nthree\n', 'one\ntwo\nthree\nfour\n']) {
    commits.push(await commit(content));
  }
  const storage = createLocalHistoryStorage(home);
  await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
  await mkdir(path.join(home, '.config', 'ai-usage'), { mode: 0o700, recursive: true });
  await writeFile(
    path.join(home, '.config', 'ai-usage', 'config.json'),
    `${JSON.stringify(
      {
        delegation: { routes: [{ accountScope: 'personal', context: 'personal', harness: 'claude-code' }] },
        github: { accounts: [{ ghUser: 'octocat', host: 'github.com', owner: 'acme' }] },
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
    authEvidence: 'claude-code status exit 0',
    authMethod: 'claude.ai',
    authState: 'logged-in',
    binaryPath: '/usr/local/bin/claude-code',
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
    source: { confidence: 'authoritative', key: 'fixture-claude', mode: 'poll' },
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
      items: [{ observation: quota, sourceEventKey: 'fixture-claude-1' }],
    }),
  );
  return { checkout, commit, commits, dbPath, git, home, privateRoot, storage };
};

const service = (fixture: Fixture) => {
  const options: DelegationServiceOptions = {
    adapterOptions: { env: { HOME: fixture.home, PATH: process.env.PATH } },
    adapters: [immediateAdapter()],
    dbPath: fixture.dbPath,
    findProcesses: () => Promise.resolve({ kind: 'absent' }),
    machine: () => machine,
    now: () => new Date(NOW),
    privateRoot: fixture.privateRoot,
    probeClaudeAccount: () => Promise.resolve({ accountFingerprint: FINGERPRINT, evidence: 'fixture' }),
    probeCodexAuth: () =>
      Promise.resolve({
        authMethod: 'chatgpt',
        authState: 'logged-in',
        evidence: 'codex login status exit 0 authMethod=chatgpt (fixture)',
        outcome: 'observed',
      }),
    report: () => undefined,
    runLimits: { heartbeatMs: 25 },
    storage: fixture.storage,
  };
  return createDelegationService(options);
};

const requestFor = (fixture: Fixture, scope: DelegationScopeRequest): Record<string, unknown> => ({
  action: 'read-only-review',
  checkout: { path: fixture.checkout },
  constraints: ['Do not run tests'],
  criteria: ['The change is explained'],
  objective: 'Review the latest change of the fixture for correctness',
  schemaVersion: 1,
  scope,
  taskCategory: 'correctness',
});

const qualificationOf = (output: UsageEngineDelegationQualificationOutput): DelegationQualification => {
  const parsed = parseDelegationQualification(output.qualification);
  if (parsed === null) {
    throw new Error('the engine produced a qualification that does not parse');
  }
  return parsed;
};

/** Qualifies, starts, lets the immediate worker finish and stops the engine; returns the job id. */
const runToCompletion = async (fixture: Fixture, scope: DelegationScopeRequest): Promise<string> => {
  const engine = service(fixture);
  const request = requestFor(fixture, scope);
  const qualification = qualificationOf(
    await engine.qualify({ command: 'qualify-delegation', purpose: 'delegation', request }, RUN),
  );
  const started = await engine.start({
    command: 'start-delegation',
    idempotencyKey: 'client-a:turn-1',
    request,
    selection: {
      kind: 'choice',
      qualificationId: qualification.qualificationId,
      routeId: qualification.admissibleRouteIds[0] ?? 'none',
      selectorVersion: 'calling-model/test',
    },
  });
  if (started.refusal !== null) {
    throw new Error(`the start was refused: ${started.refusal.reason}`);
  }
  const jobId = started.job?.jobId ?? '';
  if (!UUID.test(jobId)) {
    throw new Error('the start answered no job id');
  }
  await engine.settle();
  await engine.shutdown();
  if (engine.live().length > 0) {
    throw new Error('the engine still tracks a process after its shutdown');
  }
  return jobId;
};

describe('frozen scope of a delegation job, read after the repository moved on', () => {
  test('a HEAD review frozen at X is read back as X by a second client after HEAD advanced to Y, with no engine', async () => {
    const fixture = await createFixture();
    const x = fixture.commits[3] ?? '';
    const jobId = await runToCompletion(fixture, { commit: 'HEAD', kind: 'commit' });

    // The repository moves on: HEAD now names Y, not X.
    const y = await fixture.commit('one\ntwo\nthree\nfour\nfive\n');
    expect(y).not.toBe(x);
    expect(await fixture.git('rev-parse', 'HEAD')).toBe(y);

    // A second client, with the engine stopped, reads the persisted record through the query-only path.
    const read = await readDelegationJobView({ dbPath: fixture.dbPath, jobId, now: NOW });
    expect(read.kind).toBe('success');
    if (read.kind !== 'success') {
      return;
    }
    expect(read.value.state).toBe('finished');
    expect(read.value.request.scope).toEqual({ commit: 'HEAD', kind: 'commit' });
    expect(read.value.frozenScope).toEqual({
      base: 'first-parent',
      baseRef: null,
      baseSha: fixture.commits[2] ?? '',
      commitCount: 1,
      headRef: 'HEAD',
      headSha: x,
      kind: 'commit',
    });
    // The list and the compact entry carry the same historical scope, object ids whole.
    const listed = await listDelegationJobViews({ dbPath: fixture.dbPath, now: NOW });
    expect(listed.kind === 'success' ? listed.value.jobs.map((job) => job.frozenScope?.headSha) : []).toEqual([x]);
    expect(summarizeDelegationJobView(read.value)).toMatchObject({
      frozenScope: { baseSha: fixture.commits[2], headSha: x, kind: 'commit' },
      scope: { base: null, head: 'HEAD', kind: 'commit' },
    });
  });

  test('a base..head range given by refs is frozen to its object ids and read back after both refs moved', async () => {
    const fixture = await createFixture();
    const jobId = await runToCompletion(fixture, { base: 'HEAD~2', head: 'HEAD', kind: 'range' });

    // Two more commits: `HEAD~2` now names the old head, `HEAD` something newer still.
    await fixture.commit('one\ntwo\nthree\nfour\nfive\n');
    const newest = await fixture.commit('one\ntwo\nthree\nfour\nfive\nsix\n');
    expect(await fixture.git('rev-parse', 'HEAD~2')).toBe(fixture.commits[3] ?? '');
    expect(await fixture.git('rev-parse', 'HEAD')).toBe(newest);

    const read = await readDelegationJobView({ dbPath: fixture.dbPath, jobId, now: NOW });
    expect(read.kind).toBe('success');
    if (read.kind !== 'success') {
      return;
    }
    expect(read.value.request.scope).toEqual({ base: 'HEAD~2', head: 'HEAD', kind: 'range' });
    expect(read.value.frozenScope).toEqual({
      base: 'range-base',
      baseRef: 'HEAD~2',
      baseSha: fixture.commits[1] ?? '',
      commitCount: 2,
      headRef: 'HEAD',
      headSha: fixture.commits[3] ?? '',
      kind: 'range',
    });
    expect(summarizeDelegationJobView(read.value).frozenScope).toEqual(read.value.frozenScope);
  });
});
