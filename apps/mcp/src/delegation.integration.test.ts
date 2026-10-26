import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryMcpServer, type MemoryMcpReadService } from '@ai-usage/mcp-adapter';
import { connectInMemoryMcpClient } from '@ai-usage/mcp-adapter/testing';
import type { DelegationQualification, FrozenDelegationScope } from '@ai-usage/report-core/delegation-contracts';
import { parseDelegationEvaluationInput } from '@ai-usage/report-core/delegation-job';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import {
  delegationRequestDigest,
  delegationSelectionDigest,
  parseDelegationRequest,
  parseDelegationSelection,
} from '@ai-usage/report-core/delegation-request';
import type {
  DelegationCommandExecutor,
  DelegationEngineCommand,
} from '@ai-usage/usage-engine-control/delegation-operations';
import {
  initializeUsageStore,
  recordDelegationEvaluation,
  requestDelegationJob,
  transitionDelegationJob,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { createLocalDelegationMcpPort } from './main';

/**
 * Two MCP clients with different declared names, two server processes, one usage store, one engine
 * (faked here by an executor that records jobs through the real store writers). The delegation path
 * must not depend on the client: a job client A started is found, with its result, by client B after
 * A disconnected; B retrying A's idempotency key gets the same job and nothing starts twice.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-mcp-integration';
const CHECKOUT = '/fixture/home/work/project';
const QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const KEY = 'client-a:session-1:review-7';
const NOW = '2026-10-25T10:00:00.000Z';
const END = '2026-10-25T10:10:00.000Z';

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
  appliedRules: [],
  assumptions: [],
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
      limits: [],
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
  ],
  schemaVersion: 1,
  scope,
  validUntil: '2026-10-25T10:10:00.000Z',
  versions: {
    catalogRevision: '0123456789abcdef',
    policyRevision: 'fedcba9876543210',
    qualifier: 'delegation-qualifier/1',
    selectorContract: 'delegation-selection/1',
  },
};

const request = {
  action: 'read-only-review',
  checkout: { path: CHECKOUT },
  constraints: [],
  criteria: ['Every public function keeps its contract.'],
  objective: 'Review the lock refactor for correctness.',
  schemaVersion: 1,
  scope: { commit: 'HEAD', kind: 'commit' },
  taskCategory: 'correctness',
} as const;

const selection = {
  kind: 'choice',
  qualificationId: QUALIFICATION_ID,
  routeId: 'route-a',
  selectorVersion: 'calling-model/fixture',
} as const;

const absentMemory: MemoryMcpReadService = {
  getMemoryItem: () => Promise.resolve({ error: { code: 'unavailable', operation: 'get-memory-item' }, kind: 'error' }),
  getProjectContext: () =>
    Promise.resolve({ error: { code: 'unavailable', operation: 'get-project-context' }, kind: 'error' }),
  searchMemory: () => Promise.resolve({ error: { code: 'unavailable', operation: 'search-memory' }, kind: 'error' }),
};

const completion = (command: DelegationEngineCommand['command'], output: unknown) =>
  ({ command, commandId: 'c1', completedAt: END, output, state: 'succeeded' }) as never;

/**
 * The engine, reduced to what the edges need from it: a fixed qualification, a start that reserves
 * the job through the real store transaction (so the idempotency key is judged by the store) and
 * finishes it at once with a review, and an evaluation recorded with the command's author.
 */
const fakeEngine = (dbPath: string) => {
  let launches = 0;
  const execute: DelegationCommandExecutor = async (command) => {
    switch (command.command) {
      case 'qualify-delegation':
        return completion(command.command, { kind: 'delegation-qualification', qualification });
      case 'start-delegation': {
        const parsedRequest = parseDelegationRequest(command.request);
        const parsedSelection = parseDelegationSelection(command.selection);
        if (
          parsedRequest.kind !== 'ok' ||
          parsedSelection.kind !== 'ok' ||
          parsedSelection.selection.kind !== 'choice'
        ) {
          throw new Error('fixture: the edge must have parsed the payloads');
        }
        const result = await Effect.runPromise(
          requestDelegationJob({
            dbPath,
            job: {
              accountScope: 'personal',
              action: 'read-only-review',
              checkoutPath: CHECKOUT,
              context: 'personal',
              effort: 'high',
              executorHarness: 'claude-code',
              idempotencyKey: command.idempotencyKey,
              launchMarker: crypto.randomUUID(),
              machineId: MACHINE,
              modelRequested: 'claude-opus-4-1',
              poolId: `${MACHINE}/claude-code/personal`,
              qualification,
              qualificationId: QUALIFICATION_ID,
              request: parsedRequest.request,
              requestDigest: await delegationRequestDigest(parsedRequest.request),
              requestedAt: NOW,
              retryOf: null,
              routeId: parsedSelection.selection.routeId,
              scope,
              selection: parsedSelection.selection,
              selectionDigest: await delegationSelectionDigest(parsedSelection.selection),
              state: 'requested',
              taskCategory: 'correctness',
            },
            limits: { maxAttempts: 2, maxConcurrent: 1 },
          }),
        );
        if (result.kind === 'inserted') {
          launches += 1;
          await Effect.runPromise(
            transitionDelegationJob({
              at: END,
              dbPath,
              jobId: result.job.jobId,
              patch: {
                endedAt: END,
                exitCode: 0,
                result: {
                  excerpt: null,
                  kind: 'review',
                  review: {
                    checks: ['read the patch'],
                    coverage: { notReviewed: [], reviewed: 'Everything.' },
                    findings: [],
                    limits: [],
                    summary: 'The lock refactor holds.',
                  },
                },
                startedAt: NOW,
                state: 'finished',
              },
            }),
          );
          return completion(command.command, {
            job: { jobId: result.job.jobId, reused: false, state: 'requested' },
            kind: 'delegation-start',
            refusal: null,
          });
        }
        if (result.kind === 'reused') {
          return completion(command.command, {
            job: { jobId: result.job.jobId, reused: true, state: result.job.state },
            kind: 'delegation-start',
            refusal: null,
          });
        }
        return completion(command.command, {
          job: null,
          kind: 'delegation-start',
          refusal: { message: `fixture: ${result.kind}`, reason: result.kind },
        });
      }
      case 'record-delegation-evaluation': {
        const parsed = parseDelegationEvaluationInput(command.evaluation, {
          author: command.author,
          authorLabel: command.authorLabel,
        });
        if (parsed.kind !== 'ok') {
          throw new Error('fixture: the edge must have parsed the evaluation');
        }
        const recorded = await Effect.runPromise(
          recordDelegationEvaluation({
            dbPath,
            evaluation: { ...parsed.evaluation, jobId: command.jobId, recordedAt: END },
          }),
        );
        return completion(command.command, {
          evaluationId: recorded.kind === 'recorded' ? recorded.evaluationId : null,
          kind: 'delegation-evaluation',
          refusal: recorded.kind === 'recorded' ? null : { message: recorded.kind, reason: 'not-ended' },
        });
      }
      default:
        throw new Error('fixture: command not supported');
    }
  };
  return { execute, launches: () => launches };
};

/** One server process per client, both composed over the same store and the same engine. */
const serverFor = (dbPath: string, engine: DelegationCommandExecutor, clientName: string) => {
  const port = createLocalDelegationMcpPort({
    configCwd: '/install/ai-usage',
    connect: () => Promise.resolve(engine),
    databasePath: dbPath,
    now: () => END,
    rendezvousPath: path.join(path.dirname(dbPath), 'rendezvous.json'),
  });
  const server = createMemoryMcpServer(absentMemory, { delegation: { port, recursionGuard: false } });
  return connectInMemoryMcpClient(server, { name: clientName });
};

test('the qualification fixture is one the report-core parser accepts, as the port requires of the engine', () => {
  expect(parseDelegationQualification(qualification)).not.toBeNull();
});

test('a job started by one client is found, with its result, by another client after the first disconnected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-delegation-integration-'));
  roots.push(root);
  const dbPath = path.join(root, 'store', 'usage.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const engine = fakeEngine(dbPath);

  // Client A: qualifies, starts with key K, disconnects.
  const a = await serverFor(dbPath, engine.execute, 'client-a');
  const qualified = await a.callTool('delegation.qualify', { request });
  expect(qualified.isError).not.toBe(true);
  expect(qualified.structuredContent).toMatchObject({ qualification: { qualificationId: QUALIFICATION_ID } });
  const started = await a.callTool('delegation.start', { idempotencyKey: KEY, request, selection });
  expect(started.isError).not.toBe(true);
  const startedJob = (started.structuredContent as { job: { jobId: string; reused: boolean } }).job;
  expect(startedJob.reused).toBe(false);
  const jobId = startedJob.jobId;
  await a.close();
  expect(engine.launches()).toBe(1);

  // Client B, another process with another declared name: the same job and its result, from the store.
  const b = await serverFor(dbPath, engine.execute, 'client-b');
  try {
    const status = await b.callTool('delegation.status', { jobId });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      contentRole: 'retrieved-data',
      job: {
        cancelRequestedAt: null,
        // The scope frozen at admission travels with the result, apart from the requested `HEAD`.
        frozenScope: { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), kind: 'commit' },
        jobId,
        request: { scope: { commit: 'HEAD', kind: 'commit' } },
        result: { kind: 'review', summary: 'The lock refactor holds.' },
        state: 'finished',
        status: { accepted: 'pending', executed: 'succeeded', verified: 'not-verified' },
      },
    });

    // B retries A's submission with A's key: the same job, no second launch.
    const retried = await b.callTool('delegation.start', { idempotencyKey: KEY, request, selection });
    expect(retried.isError).not.toBe(true);
    expect(retried.structuredContent).toEqual({
      job: { jobId, reused: true, state: 'finished' },
      refusal: null,
    });
    expect(engine.launches()).toBe(1);
    const list = await b.callTool('delegation.list', {});
    expect(list.structuredContent).toMatchObject({ omitted: 0, skipped: 0, truncated: false });
    expect((list.structuredContent as { jobs: unknown[] }).jobs).toHaveLength(1);
    expect((list.structuredContent as { jobs: unknown[] }).jobs[0]).toMatchObject({
      frozenScope: { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), kind: 'commit' },
      jobId,
      scope: { base: null, head: 'HEAD', kind: 'commit' },
    });

    // B verifies the result; the record carries B's declared name as a label and the forced author.
    const evaluated = await b.callTool('delegation.evaluate', {
      evaluation: { kind: 'verification', note: 'Checked against src/lock.ts.', verdict: 'confirmed' },
      jobId,
    });
    expect(evaluated.isError).not.toBe(true);
    const after = await b.callTool('delegation.status', { jobId });
    expect(after.structuredContent).toMatchObject({
      job: {
        evaluations: { acceptance: null, verifications: [{ author: 'calling-model', authorLabel: 'client-b' }] },
        status: { accepted: 'pending', executed: 'succeeded', verified: 'confirmed' },
      },
    });
  } finally {
    await b.close();
  }
});
