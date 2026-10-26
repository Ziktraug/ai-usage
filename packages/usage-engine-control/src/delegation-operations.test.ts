import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DelegationRequest, DelegationSelection } from '@ai-usage/report-core/delegation-contracts';
import { collectionSourceDefinitions } from '@ai-usage/report-core/source-control';
import { UsageEngineControlError } from './client';
import { UsageEngineCommandCompletionError } from './completion';
import {
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommandCompletion,
  UsageEngineContractError,
} from './contracts';
import {
  connectDelegationEngine,
  createDelegationCommands,
  type DelegationCommandExecutor,
  type DelegationEngineCommand,
  DelegationEngineConnectionError,
  type DelegationOperationErrorCode,
  type DelegationQualificationEnvelope,
} from './delegation-operations';
import { usageEngineTargetIdFor } from './rendezvous';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const JOB_ID = '7d5a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const KEY = 'caller:session-1:review-7';

const request: DelegationRequest = {
  action: 'read-only-review',
  checkout: { path: '/fixture/checkout' },
  client: { name: 'fixture-client' },
  constraints: [],
  criteria: ['Every public function keeps its contract.'],
  objective: 'Review the lock refactor for correctness.',
  schemaVersion: 1,
  scope: { commit: 'HEAD', kind: 'commit' },
  taskCategory: 'correctness',
};

const selection: DelegationSelection = {
  kind: 'choice',
  qualificationId: QUALIFICATION_ID,
  routeId: 'route-a',
  selectorVersion: 'calling-model/fixture',
};

/** The envelope the control plane types; the whole object travels and an edge parses it. */
const qualification: DelegationQualificationEnvelope = {
  outcome: 'routes-available',
  qualificationId: QUALIFICATION_ID,
  schemaVersion: 1,
};

/** A completion as the control-plane parser would hand it over; the test owns only the output. */
const completionOf = (command: DelegationEngineCommand['command'], output: unknown): UsageEngineCommandCompletion =>
  ({
    command,
    commandId: 'command-fixture',
    completedAt: '2026-10-25T10:00:01.000Z',
    output,
    state: 'succeeded',
  }) as unknown as UsageEngineCommandCompletion;

const recordingExecutor = (
  answer: (command: DelegationEngineCommand) => UsageEngineCommandCompletion,
): { readonly commands: DelegationEngineCommand[]; readonly execute: DelegationCommandExecutor } => {
  const commands: DelegationEngineCommand[] = [];
  return {
    commands,
    execute: (command) => {
      commands.push(command);
      return Promise.resolve(answer(command));
    },
  };
};

describe('createDelegationCommands', () => {
  test('sends the four commands with the caller payloads and reads each answer by its output kind', async () => {
    const executor = recordingExecutor((command) => {
      switch (command.command) {
        case 'qualify-delegation':
          return completionOf(command.command, { kind: 'delegation-qualification', qualification });
        case 'start-delegation':
          return completionOf(command.command, {
            job: { jobId: JOB_ID, reused: false, state: 'requested' },
            kind: 'delegation-start',
            refusal: null,
          });
        case 'cancel-delegation':
          return completionOf(command.command, {
            jobId: JOB_ID,
            kind: 'delegation-cancel',
            result: 'cancelling',
            state: 'running',
          });
        default:
          return completionOf(command.command, {
            evaluationId: 'e1',
            kind: 'delegation-evaluation',
            refusal: null,
          });
      }
    });
    const commands = createDelegationCommands({ execute: executor.execute });

    expect(await commands.qualify(request, 'delegation')).toEqual({ kind: 'success', value: qualification });
    expect(await commands.start({ idempotencyKey: KEY, request, selection })).toEqual({
      kind: 'success',
      value: { job: { jobId: JOB_ID, reused: false, state: 'requested' }, refusal: null },
    });
    expect(await commands.cancel(JOB_ID)).toEqual({
      kind: 'success',
      value: { jobId: JOB_ID, result: 'cancelling', state: 'running' },
    });
    expect(
      await commands.evaluate({
        author: 'calling-model',
        authorLabel: 'fixture-client',
        evaluation: { kind: 'verification', verdict: 'confirmed' },
        jobId: JOB_ID,
      }),
    ).toEqual({ kind: 'success', value: { evaluationId: 'e1', refusal: null } });

    expect(executor.commands).toEqual([
      { command: 'qualify-delegation', purpose: 'delegation', request: { ...request } },
      { command: 'start-delegation', idempotencyKey: KEY, request: { ...request }, selection: { ...selection } },
      { command: 'cancel-delegation', jobId: JOB_ID },
      {
        author: 'calling-model',
        authorLabel: 'fixture-client',
        command: 'record-delegation-evaluation',
        evaluation: { kind: 'verification', verdict: 'confirmed' },
        jobId: JOB_ID,
      },
    ]);
  });

  test('passes a refusal through as data, never as an error', async () => {
    const commands = createDelegationCommands({
      execute: (command) =>
        Promise.resolve(
          completionOf(command.command, {
            job: null,
            kind: 'delegation-start',
            refusal: { message: 'The qualification expired.', reason: 'qualification-expired' },
          }),
        ),
    });
    expect(await commands.start({ idempotencyKey: KEY, request, selection })).toEqual({
      kind: 'success',
      value: { job: null, refusal: { message: 'The qualification expired.', reason: 'qualification-expired' } },
    });
    const evaluation = createDelegationCommands({
      execute: (command) =>
        Promise.resolve(
          completionOf(command.command, {
            evaluationId: null,
            kind: 'delegation-evaluation',
            refusal: { message: 'The job has not ended.', reason: 'not-ended' },
          }),
        ),
    });
    expect(
      await evaluation.evaluate({
        author: 'operator',
        authorLabel: null,
        evaluation: { kind: 'acceptance', verdict: 'accepted' },
        jobId: JOB_ID,
      }),
    ).toEqual({
      kind: 'success',
      value: { evaluationId: null, refusal: { message: 'The job has not ended.', reason: 'not-ended' } },
    });
  });

  test('maps engine, connection and contract failures to the closed code set without their messages', async () => {
    const failing = (error: unknown) => createDelegationCommands({ execute: () => Promise.reject(error) });
    const cases: readonly (readonly [unknown, DelegationOperationErrorCode])[] = [
      [
        new UsageEngineControlError('transport-failed', 'command', '/private/state/rendezvous.json refused'),
        'engine-unavailable',
      ],
      [new UsageEngineCommandCompletionError('engine-unavailable', 'not ready'), 'engine-unavailable'],
      [new UsageEngineCommandCompletionError('engine-busy', 'busy'), 'engine-busy'],
      [new UsageEngineCommandCompletionError('aborted', 'cancelled'), 'cancelled'],
      [new UsageEngineCommandCompletionError('command-rejected', 'rejected'), 'invalid-input'],
      [new UsageEngineControlError('request-too-large', 'command', 'too large'), 'invalid-input'],
      [new UsageEngineCommandCompletionError('command-failed', 'failed'), 'unavailable'],
      [new UsageEngineCommandCompletionError('timeout', 'timed out'), 'unavailable'],
      [new UsageEngineCommandCompletionError('protocol-mismatch', 'mismatch'), 'unavailable'],
      [
        new UsageEngineContractError('invalid-contract', 'Usage engine delegation request must be an object.'),
        'invalid-input',
      ],
      [new DelegationEngineConnectionError('engine-unavailable', 'no engine'), 'engine-unavailable'],
      [new DelegationEngineConnectionError('unavailable', 'bad rendezvous'), 'unavailable'],
      [new Error('/private/home/.config/ai-usage/engine/rendezvous.json: EACCES'), 'unavailable'],
    ];
    for (const [error, code] of cases) {
      const result = await failing(error).cancel(JOB_ID);
      expect(result).toEqual({ code, kind: 'error' });
      expect(JSON.stringify(result)).not.toContain('/private');
    }
  });

  test('answers cancelled for an aborted signal before and after the executor runs', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const commands = createDelegationCommands({
      execute: () => {
        calls += 1;
        return Promise.reject(new Error('must not run'));
      },
    });
    expect(await commands.qualify(request, 'simulation', controller.signal)).toEqual({
      code: 'cancelled',
      kind: 'error',
    });
    expect(calls).toBe(0);

    const late = new AbortController();
    const lateCommands = createDelegationCommands({
      execute: () => {
        late.abort();
        return Promise.reject(new Error('stream closed'));
      },
    });
    expect(await lateCommands.cancel(JOB_ID, late.signal)).toEqual({ code: 'cancelled', kind: 'error' });
  });

  test('refuses a completion of another command, or a failed one, as unavailable', async () => {
    const failed = createDelegationCommands({
      execute: () =>
        Promise.resolve({
          command: 'cancel-delegation',
          commandId: 'command-fixture',
          completedAt: '2026-10-25T10:00:01.000Z',
          error: { code: 'command-failed', message: 'failed' },
          state: 'failed',
        } as unknown as UsageEngineCommandCompletion),
    });
    expect(await failed.cancel(JOB_ID)).toEqual({ code: 'unavailable', kind: 'error' });
    const otherCommand = createDelegationCommands({
      execute: () =>
        Promise.resolve(
          completionOf('cancel-delegation', {
            jobId: JOB_ID,
            kind: 'delegation-cancel',
            result: 'cancelling',
            state: null,
          }),
        ),
    });
    expect(await otherCommand.qualify(request, 'delegation')).toEqual({ code: 'unavailable', kind: 'error' });
  });
});

const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'delegation-operations-'));
  roots.push(root);
  return root;
};

const connectOptions = (root: string, configCwd = path.join(root, 'config')) => ({
  configCwd,
  expectedStoreSchemaVersion: 4,
  runtimePaths: {
    databasePath: path.join(root, 'store', 'usage.sqlite'),
    rendezvousPath: path.join(root, 'state', 'rendezvous.json'),
  },
});

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'fixture-token-with-at-least-thirty-two-bytes';

const writeRendezvous = async (root: string, targetId: string, port = 41_052): Promise<void> => {
  await mkdir(path.join(root, 'state'), { mode: 0o700, recursive: true });
  await writeFile(
    path.join(root, 'state', 'rendezvous.json'),
    `${JSON.stringify({ instanceId: INSTANCE_ID, port, protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION, targetId, token: TOKEN })}\n`,
    { mode: 0o600 },
  );
};

const readyStatus = {
  currentPublication: { publishedAt: '2026-07-30T10:00:00.000Z', revision: 'revision-a' },
  degradedReason: null,
  generatedAt: '2026-07-30T10:00:01.000Z',
  generation: 0,
  instanceId: INSTANCE_ID,
  protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  readiness: 'ready',
  sourceControl: {
    generatedAt: '2026-07-30T10:00:01.000Z',
    generation: 0,
    instanceId: INSTANCE_ID,
    publication: {
      acknowledgedRequestGeneration: 0,
      dirty: false,
      dirtyGeneration: 0,
      lastOutcome: 'success',
      lastPublishedAt: '2026-07-30T10:00:00.000Z',
      pendingDemand: false,
      publishedGeneration: 0,
      queued: false,
      requestedGeneration: 0,
      revision: 'revision-a',
      rtkCompletedGeneration: 0,
      rtkRequiredGeneration: 0,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map((definition) => ({
      availability: 'not-detected',
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: 'not-run',
      lifecycle: 'dormant',
      policy: definition.defaultEnabled ? 'enabled' : 'disabled',
      reason: { code: definition.defaultEnabled ? 'input-missing' : 'policy-disabled' },
      warnings: [],
    })),
  },
  storeSchemaVersion: 4,
};

describe('connectDelegationEngine', () => {
  test('answers engine-unavailable when no engine has published a rendezvous, creating nothing', async () => {
    const root = await fixtureRoot();
    await expect(connectDelegationEngine(connectOptions(root))).rejects.toMatchObject({
      code: 'engine-unavailable',
      name: 'DelegationEngineConnectionError',
    });
    expect(await Bun.file(path.join(root, 'state', 'rendezvous.json')).exists()).toBe(false);
    expect(await Bun.file(path.join(root, 'store', 'usage.sqlite')).exists()).toBe(false);
  });

  test('treats a rendezvous of another store or config root as no engine for this target', async () => {
    const root = await fixtureRoot();
    const options = connectOptions(root);
    await writeRendezvous(
      root,
      usageEngineTargetIdFor({
        configCwd: path.join(root, 'other-config'),
        databasePath: options.runtimePaths.databasePath,
      }),
    );
    await expect(connectDelegationEngine(options)).rejects.toMatchObject({ code: 'engine-unavailable' });
    await writeRendezvous(
      root,
      usageEngineTargetIdFor({
        configCwd: options.configCwd,
        databasePath: `${options.runtimePaths.databasePath}.other`,
      }),
    );
    await expect(connectDelegationEngine(options)).rejects.toMatchObject({ code: 'engine-unavailable' });
  });

  test('answers unavailable for an unreadable rendezvous without quoting it', async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, 'state'), { mode: 0o700, recursive: true });
    await writeFile(path.join(root, 'state', 'rendezvous.json'), '{"token":"secret-token-value"', { mode: 0o600 });
    let caught: unknown;
    try {
      await connectDelegationEngine(connectOptions(root));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DelegationEngineConnectionError);
    expect((caught as DelegationEngineConnectionError).code).toBe('unavailable');
    expect((caught as Error).message).not.toContain('secret-token-value');
    expect((caught as Error).message).not.toContain(root);
  });

  test('answers engine-unavailable for a rendezvous whose engine is gone, before any command', async () => {
    const root = await fixtureRoot();
    const options = connectOptions(root);
    await writeRendezvous(
      root,
      usageEngineTargetIdFor({ configCwd: options.configCwd, databasePath: options.runtimePaths.databasePath }),
    );
    // Port 41052 has no listener: the status probe fails on transport, not after the completion timeout.
    const started = Date.now();
    await expect(connectDelegationEngine(options)).rejects.toMatchObject({ code: 'engine-unavailable' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('returns an executor for a live engine of the matching target, authenticating with its token', async () => {
    const root = await fixtureRoot();
    const options = connectOptions(root);
    const requests: { readonly authorization: string | null; readonly path: string }[] = [];
    const server = Bun.serve({
      fetch: (incoming) => {
        const url = new URL(incoming.url);
        requests.push({ authorization: incoming.headers.get('authorization'), path: url.pathname });
        if (url.pathname === '/v1/status' && incoming.method === 'GET') {
          return new Response(JSON.stringify(readyStatus), {
            headers: {
              'content-type': 'application/json',
              'x-ai-usage-protocol-version': String(USAGE_ENGINE_PROTOCOL_VERSION),
            },
          });
        }
        return new Response('not found', { status: 404 });
      },
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      await writeRendezvous(
        root,
        usageEngineTargetIdFor({ configCwd: options.configCwd, databasePath: options.runtimePaths.databasePath }),
        server.port,
      );
      const execute = await connectDelegationEngine(options);
      expect(typeof execute).toBe('function');
      expect(requests).toEqual([{ authorization: `Bearer ${TOKEN}`, path: '/v1/status' }]);
    } finally {
      await server.stop(true);
    }
  });
});
