import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DelegationQualification, FrozenDelegationScope } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import {
  type DelegationCommandExecutor,
  type DelegationEngineCommand,
  DelegationEngineConnectionError,
} from '@ai-usage/usage-engine-control/delegation-operations';
import {
  initializeUsageStore,
  type NewDelegationJob,
  requestDelegationJob,
  transitionDelegationJob,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import {
  type CliDelegationDependencies,
  CliDelegationError,
  DELEGATION_REQUEST_MAX_BYTES,
  readDelegationRequestSource,
  runDelegationCliCommand,
} from './delegation';
import { withCliSandbox } from './test-support/run-cli';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const JOB_ID = '7d5a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const NOW = '2026-10-25T10:00:00.000Z';
const END = '2026-10-25T10:10:00.000Z';
const CHECKOUT = '/fixture/home/work/project';
const MACHINE = 'machine-cli-delegation';
const TEST_TIMEOUT_MS = 30_000;

const requestDocument = {
  action: 'read-only-review',
  checkout: { path: CHECKOUT },
  constraints: ['Do not review generated files.'],
  criteria: ['Every public function keeps its contract.'],
  objective: 'Review the lock refactor for correctness.',
  schemaVersion: 1,
  scope: { commit: 'HEAD', kind: 'commit' },
  taskCategory: 'correctness',
} as const;

const scope: FrozenDelegationScope = {
  base: 'first-parent',
  baseRef: null,
  baseSha: 'b'.repeat(40),
  commitCount: 1,
  headRef: 'HEAD',
  headSha: 'a'.repeat(40),
  kind: 'commit',
};

const qualification: DelegationQualification = {
  admissibleRouteIds: ['route-a'],
  appliedRules: [{ applies: 'assumed', effect: 'restrict', id: 'work-only', reason: 'repository unknown' }],
  assumptions: ['The repository owner is unknown; rule work-only is assumed to apply.'],
  checkout: { admittedBy: '/fixture/home/work', path: CHECKOUT, projectLabel: 'project' },
  checkoutFacts: null,
  omittedRoutes: 0,
  outcome: 'routes-available',
  purpose: 'delegation',
  qualificationId: QUALIFICATION_ID,
  qualifiedAt: NOW,
  refusal: null,
  request: { action: 'read-only-review', digest: 'd'.repeat(64), taskCategory: 'correctness' },
  routes: [
    {
      accountScope: 'personal',
      admissible: true,
      advantages: ['Declared recommended for correctness.'],
      blockers: [],
      context: 'personal',
      effort: 'high',
      exclusions: [],
      harness: 'claude-code',
      identity: null,
      label: 'Claude personal',
      limits: ['Identity is declared only.'],
      liveJobsInPool: 0,
      missing: [],
      model: 'claude-opus-4-1',
      orderHint: 0,
      poolId: `${MACHINE}/claude-code/personal`,
      provider: 'anthropic',
      quota: [],
      requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
      routeId: 'route-a',
    },
    {
      accountScope: 'work',
      admissible: false,
      advantages: [],
      blockers: ['reserve'],
      context: 'professional',
      effort: null,
      exclusions: ['The 5-hour window has 12% left, under the 20% reserve.'],
      harness: 'codex',
      identity: null,
      label: 'Codex work',
      limits: [],
      liveJobsInPool: 0,
      missing: [],
      model: 'gpt-5-codex',
      orderHint: null,
      poolId: `${MACHINE}/codex/work`,
      provider: 'openai',
      quota: [],
      requirements: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
      routeId: 'route-b',
    },
  ],
  schemaVersion: 1,
  scope,
  validUntil: END,
  versions: {
    catalogRevision: '0123456789abcdef',
    policyRevision: 'fedcba9876543210',
    qualifier: 'delegation-qualifier/1',
    selectorContract: 'delegation-selection/1',
  },
};

const storedJob: NewDelegationJob = {
  accountScope: 'personal',
  action: 'read-only-review',
  checkoutPath: CHECKOUT,
  context: 'personal',
  effort: 'high',
  executorHarness: 'claude-code',
  idempotencyKey: 'cli:review-7',
  jobId: JOB_ID,
  launchMarker: '2f6a0c4e-5d7b-4a9c-8e1f-2b3c4d5e6f70',
  machineId: MACHINE,
  modelRequested: 'claude-opus-4-1',
  poolId: `${MACHINE}/claude-code/personal`,
  qualification,
  qualificationId: QUALIFICATION_ID,
  request: requestDocument,
  requestDigest: 'd'.repeat(64),
  requestedAt: NOW,
  retryOf: null,
  routeId: 'route-a',
  scope,
  selection: {
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    routeId: 'route-a',
    selectorVersion: 'operator/ai-usage-cli',
  },
  selectionDigest: 's'.repeat(64),
  state: 'requested',
  taskCategory: 'correctness',
};

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'cli-delegation-'));
  roots.push(root);
  return root;
};

const completion = (command: DelegationEngineCommand['command'], output: unknown) =>
  ({ command, commandId: 'c1', completedAt: END, output, state: 'succeeded' }) as never;

/** A fake daemon: records the commands it receives and answers from fixtures. */
const fakeEngine = () => {
  const commands: DelegationEngineCommand[] = [];
  const execute: DelegationCommandExecutor = (command) => {
    commands.push(command);
    switch (command.command) {
      case 'qualify-delegation':
        return Promise.resolve(completion(command.command, { kind: 'delegation-qualification', qualification }));
      case 'start-delegation':
        return Promise.resolve(
          completion(command.command, {
            job: { jobId: JOB_ID, reused: false, state: 'requested' },
            kind: 'delegation-start',
            refusal: null,
          }),
        );
      case 'cancel-delegation':
        return Promise.resolve(
          completion(command.command, {
            jobId: command.jobId,
            kind: 'delegation-cancel',
            result: 'cancelling',
            state: 'running',
          }),
        );
      default:
        return Promise.reject(new Error('fixture: the CLI records no evaluation'));
    }
  };
  return { commands, execute };
};

const dependencies = (
  root: string,
  overrides: Partial<CliDelegationDependencies> = {},
): CliDelegationDependencies & { readonly connects: number } => {
  const state = { connects: 0 };
  const engine = fakeEngine();
  return {
    connect: () => {
      state.connects += 1;
      return Promise.resolve(engine.execute);
    },
    dbPath: path.join(root, 'store', 'usage.sqlite'),
    environment: {},
    now: () => END,
    operatorCwd: root,
    readStdin: () => Promise.reject(new Error('fixture: stdin not provided')),
    signal: new AbortController().signal,
    ...overrides,
    get connects() {
      return state.connects;
    },
  };
};

const writeRequest = async (
  root: string,
  name = 'review.json',
  document: unknown = requestDocument,
): Promise<string> => {
  await writeFile(path.join(root, name), JSON.stringify(document));
  return name;
};

test('the qualification fixture is one the report-core parser accepts, as the CLI requires of the engine', () => {
  expect(parseDelegationQualification(qualification)).not.toBeNull();
});

describe('readDelegationRequestSource', () => {
  test('reads a bounded JSON file relative to the operator cwd, or standard input for -', async () => {
    const root = await temporaryRoot();
    const file = await writeRequest(root);
    const fromFile = await readDelegationRequestSource(file, dependencies(root));
    expect(fromFile).toEqual(requestDocument);
    const fromStdin = await readDelegationRequestSource('-', {
      operatorCwd: root,
      readStdin: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(requestDocument))),
    });
    expect(fromStdin).toEqual(requestDocument);
  });

  test('refuses a file over 64 KiB, a non-JSON file, an invalid request (paths, never values) and a reserved action', async () => {
    const root = await temporaryRoot();
    const deps = dependencies(root);
    await writeFile(path.join(root, 'large.json'), `{"objective":"${'x'.repeat(DELEGATION_REQUEST_MAX_BYTES)}"}`);
    await expect(readDelegationRequestSource('large.json', deps)).rejects.toMatchObject({
      code: 'request-too-large',
      message: 'The delegation request exceeds 64 KiB.',
    });
    await writeFile(path.join(root, 'broken.json'), '{"objective":');
    await expect(readDelegationRequestSource('broken.json', deps)).rejects.toMatchObject({
      code: 'request-unreadable',
    });
    await expect(readDelegationRequestSource('absent.json', deps)).rejects.toMatchObject({
      code: 'request-unreadable',
    });

    const invalid = await writeRequest(root, 'invalid.json', {
      ...requestDocument,
      checkout: { path: 'relative/secret-dir' },
      objective: '',
    });
    let caught: unknown;
    try {
      await readDelegationRequestSource(invalid, deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliDelegationError);
    const message = (caught as CliDelegationError).message;
    expect((caught as CliDelegationError).code).toBe('invalid-request');
    expect(message).toContain('checkout.path:');
    expect(message).toContain('objective:');
    expect(message).not.toContain('secret-dir');

    const reserved = await writeRequest(root, 'reserved.json', { ...requestDocument, action: 'commit' });
    await expect(readDelegationRequestSource(reserved, deps)).rejects.toMatchObject({
      code: 'unsupported-request',
      message: expect.stringContaining('action-unsupported'),
    });
  });
});

describe('runDelegationCliCommand', () => {
  test('qualify sends the request to the daemon and renders routes, exclusions, rules and assumptions', async () => {
    const root = await temporaryRoot();
    const file = await writeRequest(root);
    const deps = dependencies(root);
    const text = await runDelegationCliCommand(
      { _tag: 'DelegationQualify', args: { json: false, request: file, simulation: false } },
      deps,
    );
    expect(text).toContain(`Qualification ${QUALIFICATION_ID} (delegation) · routes-available`);
    expect(text).toContain('Admissible routes (1)');
    expect(text).toContain('route-a  claude-code/claude-opus-4-1 high · personal');
    expect(text).toContain('tie-break 0');
    expect(text).toContain('+ Declared recommended for correctness.');
    expect(text).toContain('Excluded routes (1)');
    expect(text).toContain('excluded (reserve): The 5-hour window has 12% left, under the 20% reserve.');
    expect(text).toContain('work-only (restrict, assumed)');
    expect(text).toContain('Assumptions:');

    const json = await runDelegationCliCommand(
      { _tag: 'DelegationQualify', args: { json: true, request: file, simulation: true } },
      deps,
    );
    expect(JSON.parse(json)).toEqual(qualification);
    expect(deps.connects).toBe(2);
  });

  test('start sends the key, the request and the selection built from the flags; abstention carries its reason', async () => {
    const root = await temporaryRoot();
    const file = await writeRequest(root);
    const engine = fakeEngine();
    const deps = dependencies(root, { connect: () => Promise.resolve(engine.execute) });
    const text = await runDelegationCliCommand(
      {
        _tag: 'DelegationStart',
        args: {
          json: false,
          key: 'cli:review-7',
          qualification: QUALIFICATION_ID,
          request: file,
          selection: { confidence: 0.8, kind: 'route', routeId: 'route-a', selectorVersion: 'operator/ai-usage-cli' },
        },
      },
      deps,
    );
    expect(text).toBe(`Job ${JOB_ID} · requested\nFollow it with: ai-usage delegation status ${JOB_ID}`);
    const json = await runDelegationCliCommand(
      {
        _tag: 'DelegationStart',
        args: {
          json: true,
          key: 'cli:review-8',
          qualification: QUALIFICATION_ID,
          request: file,
          selection: { kind: 'abstain', reason: 'task-unsuitable' },
        },
      },
      deps,
    );
    expect(JSON.parse(json)).toEqual({ job: { jobId: JOB_ID, reused: false, state: 'requested' }, refusal: null });
    expect(engine.commands).toEqual([
      {
        command: 'start-delegation',
        idempotencyKey: 'cli:review-7',
        request: requestDocument,
        selection: {
          confidence: 0.8,
          kind: 'choice',
          qualificationId: QUALIFICATION_ID,
          routeId: 'route-a',
          selectorVersion: 'operator/ai-usage-cli',
        },
      },
      {
        command: 'start-delegation',
        idempotencyKey: 'cli:review-8',
        request: requestDocument,
        selection: {
          kind: 'abstain',
          qualificationId: QUALIFICATION_ID,
          reason: 'task-unsuitable',
          selectorVersion: 'operator/ai-usage-cli',
        },
      },
    ]);
  });

  test('status and list read the store only, naming executed, verified and accepted separately', async () => {
    const root = await temporaryRoot();
    const deps = dependencies(root);
    await mkdir(path.dirname(deps.dbPath), { recursive: true });
    await Effect.runPromise(initializeUsageStore({ dbPath: deps.dbPath }));
    await Effect.runPromise(
      requestDelegationJob({ dbPath: deps.dbPath, job: storedJob, limits: { maxAttempts: 2, maxConcurrent: 1 } }),
    );
    await Effect.runPromise(
      transitionDelegationJob({
        at: END,
        dbPath: deps.dbPath,
        jobId: JOB_ID,
        patch: {
          endedAt: END,
          exitCode: 0,
          result: {
            excerpt: null,
            kind: 'review',
            review: {
              checks: [],
              coverage: { notReviewed: [], reviewed: 'Everything.' },
              findings: [{ detail: 'Lock released twice.', evidence: [], severity: 'major', title: 'Double release' }],
              limits: [],
              summary: 'One major finding.',
            },
          },
          startedAt: NOW,
          state: 'finished',
        },
      }),
    );
    const status = await runDelegationCliCommand(
      { _tag: 'DelegationStatus', args: { jobId: JOB_ID, json: false } },
      deps,
    );
    expect(status).toContain(`Job ${JOB_ID} · finished`);
    expect(status).toContain('Route: route-a (claude-code claude-opus-4-1 → unknown, personal)');
    expect(status).toContain('Executed: succeeded\nVerified: not-verified\nAccepted: pending');
    expect(status).toContain('Result: review — One major finding. (1 finding)');
    expect(status).toContain('A finished execution is not a verification');
    // The requested revision stays as given; the scope frozen when the job was admitted is shown whole.
    expect(status).toContain(`Request: read-only-review · correctness · ${CHECKOUT} · commit HEAD`);
    expect(status).toContain(
      `Scope frozen: commit ${'a'.repeat(40)} (HEAD) against its first parent ${'b'.repeat(40)} · 1 commit`,
    );
    const list = await runDelegationCliCommand(
      { _tag: 'DelegationList', args: { json: false, limit: null, live: false } },
      deps,
    );
    expect(list).toContain('Delegation jobs (1)');
    expect(list).toContain(`${JOB_ID}  finished`);
    expect(list).toContain('executed=succeeded verified=not-verified accepted=pending');
    const live = await runDelegationCliCommand(
      { _tag: 'DelegationList', args: { json: true, limit: 5, live: true } },
      deps,
    );
    expect(JSON.parse(live)).toMatchObject({ jobs: [], skipped: 0, truncated: false });
    const json = await runDelegationCliCommand({ _tag: 'DelegationStatus', args: { jobId: JOB_ID, json: true } }, deps);
    expect(JSON.parse(json)).toMatchObject({
      frozenScope: scope,
      jobId: JOB_ID,
      request: { scope: { commit: 'HEAD', kind: 'commit' } },
      status: { accepted: 'pending', executed: 'succeeded' },
    });
    const listJson = await runDelegationCliCommand(
      { _tag: 'DelegationList', args: { json: true, limit: null, live: false } },
      deps,
    );
    expect(JSON.parse(listJson)).toMatchObject({ jobs: [{ frozenScope: scope, jobId: JOB_ID }] });
    expect(deps.connects).toBe(0);
    await expect(
      runDelegationCliCommand(
        { _tag: 'DelegationStatus', args: { jobId: '9f7c3d4e-5a61-4c7d-ae8f-9a0b1c2d3e4f', json: false } },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'not-found', message: 'No delegation job has this id.' });
  });

  test('cancel goes to the daemon and renders the result', async () => {
    const root = await temporaryRoot();
    const deps = dependencies(root);
    expect(
      await runDelegationCliCommand({ _tag: 'DelegationCancel', args: { jobId: JOB_ID, json: false } }, deps),
    ).toBe(`Cancel ${JOB_ID}: cancelling (state running)`);
  });

  test('inside a delegated worker, qualify and start answer recursive-delegation before reading the request or finding an engine', async () => {
    const root = await temporaryRoot();
    const deps = dependencies(root, { environment: { AI_USAGE_DELEGATION_DEPTH: '1' } });
    const expected = {
      code: 'recursive-delegation',
      message:
        'This process runs as a delegated worker (AI_USAGE_DELEGATION_DEPTH is set); a worker never delegates. Keep the task.',
    };
    // The request file does not exist and stdin rejects: neither is reached.
    await expect(
      runDelegationCliCommand(
        { _tag: 'DelegationQualify', args: { json: false, request: 'missing.json', simulation: false } },
        deps,
      ),
    ).rejects.toMatchObject(expected);
    await expect(
      runDelegationCliCommand(
        {
          _tag: 'DelegationStart',
          args: {
            json: true,
            key: 'cli:review-7',
            qualification: QUALIFICATION_ID,
            request: '-',
            selection: { kind: 'abstain', reason: 'keep-with-caller' },
          },
        },
        deps,
      ),
    ).rejects.toMatchObject(expected);
    expect(deps.connects).toBe(0);
    // Reads are not delegation: list still answers from the store (here, that there is none).
    await expect(
      runDelegationCliCommand({ _tag: 'DelegationList', args: { json: false, limit: null, live: false } }, deps),
    ).rejects.toMatchObject({ code: 'store-missing' });
    // An environment without the variable is not a worker, whatever else it holds.
    const plain = dependencies(root, {
      connect: () => Promise.reject(new DelegationEngineConnectionError('engine-unavailable', 'fixture')),
      environment: { HOME: root },
    });
    await expect(
      runDelegationCliCommand(
        { _tag: 'DelegationQualify', args: { json: false, request: await writeRequest(root), simulation: false } },
        plain,
      ),
    ).rejects.toMatchObject({ code: 'engine-unavailable' });
  });

  test('without a running daemon, qualify, start and cancel fail and tell the operator to start the engine', async () => {
    const root = await temporaryRoot();
    const file = await writeRequest(root);
    const deps = dependencies(root, {
      connect: () => Promise.reject(new DelegationEngineConnectionError('engine-unavailable', 'fixture')),
    });
    const expected = {
      code: 'engine-unavailable',
      message:
        'No usage engine is running for this store. Delegation commands never start one: start the engine (bun run start) and retry.',
    };
    await expect(
      runDelegationCliCommand(
        { _tag: 'DelegationQualify', args: { json: false, request: file, simulation: false } },
        deps,
      ),
    ).rejects.toMatchObject(expected);
    await expect(
      runDelegationCliCommand(
        {
          _tag: 'DelegationStart',
          args: {
            json: false,
            key: 'cli:review-7',
            qualification: QUALIFICATION_ID,
            request: file,
            selection: { kind: 'abstain', reason: 'keep-with-caller' },
          },
        },
        deps,
      ),
    ).rejects.toMatchObject(expected);
    await expect(
      runDelegationCliCommand({ _tag: 'DelegationCancel', args: { jobId: JOB_ID, json: true } }, deps),
    ).rejects.toMatchObject(expected);
    // A missing store is a failure of the read, never an empty list, and no engine is asked.
    await expect(
      runDelegationCliCommand({ _tag: 'DelegationList', args: { json: false, limit: null, live: false } }, deps),
    ).rejects.toMatchObject({ code: 'store-missing' });
    expect(await readdir(root)).toEqual(['review.json']);
  });
});

test(
  'the executable never starts a foreground engine for a delegation command and creates no store',
  async () => {
    await withCliSandbox(async ({ environment, root, runCli }) => {
      await writeFile(path.join(root, 'review.json'), JSON.stringify(requestDocument));
      const qualify = await runCli(['delegation', 'qualify', '--request', 'review.json']);
      expect(qualify).toMatchObject({
        exitCode: 1,
        stderr:
          'Error: No usage engine is running for this store. Delegation commands never start one: start the engine (bun run start) and retry.\n',
        stdout: '',
      });
      const status = await runCli(['delegation', 'status', JOB_ID, '--json']);
      expect(status).toMatchObject({
        exitCode: 1,
        stderr: 'Error: No usage store exists yet; the usage engine creates it on its first run.\n',
        stdout: '',
      });
      expect(await Bun.file(environment.AI_USAGE_DATABASE_PATH ?? '').exists()).toBe(false);
      expect(await Bun.file(path.join(root, 'state', 'rendezvous.json')).exists()).toBe(false);
      const state = await readdir(path.join(root, 'state')).catch(() => [] as string[]);
      expect(state.filter((name) => name.endsWith('.engine.lock'))).toEqual([]);
    });
  },
  TEST_TIMEOUT_MS,
);
