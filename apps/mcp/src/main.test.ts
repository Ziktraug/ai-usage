import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delegationMcpBounds, delegationMcpVocabulary, memoryMcpBounds } from '@ai-usage/mcp-adapter';
import { connectInMemoryMcpClient, type InMemoryMcpClient } from '@ai-usage/mcp-adapter/testing';
import type {
  DelegationQualification,
  DelegationReviewResult,
  FrozenDelegationScope,
} from '@ai-usage/report-core/delegation-contracts';
import {
  DELEGATION_ABSTENTION_REASONS,
  DELEGATION_ACTIONS,
  DELEGATION_BOUNDS,
  DELEGATION_IDEMPOTENCY_KEY_PATTERN,
  DELEGATION_RESERVED_ACTIONS,
  DELEGATION_RESERVED_SCOPE_KINDS,
  DELEGATION_REVISION_PATTERN,
  DELEGATION_SCOPE_KINDS,
  DELEGATION_TASK_CATEGORIES,
  DELEGATION_VERIFICATION_VERDICTS,
} from '@ai-usage/report-core/delegation-vocabulary';
import { claudeDesktopFixtureRegistry } from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type { ClaudeDesktopSessionObservation } from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import { DELEGATION_READ_BOUNDS } from '@ai-usage/report-data/delegation-read';
import {
  type ConnectDelegationEngineOptions,
  DelegationEngineConnectionError,
} from '@ai-usage/usage-engine-control/delegation-operations';
import {
  importClaudeDesktopSessions,
  initializeUsageStore,
  type NewDelegationJob,
  requestDelegationJob,
  transitionDelegationJob,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import {
  createLocalDelegationMcpPort,
  createLocalWorkContextMcpReadService,
  delegationConfigCwd,
  mcpInstallationRoot,
  runMemoryMcpProcess,
} from './main';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-context-mcp-'));
  temporaryRoots.push(root);
  return root;
};

const JOB_ID = '7d5a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const QUALIFICATION_ID = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
const NOW = '2026-10-25T10:00:00.000Z';
const CHECKOUT = '/fixture/home/work/project';
const MACHINE = 'machine-mcp-delegation';

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
  routes: [],
  schemaVersion: 1,
  scope,
  validUntil: '2026-10-25T10:10:00.000Z',
  versions: {
    catalogRevision: 'cat0123456789abc',
    policyRevision: 'pol0123456789abc',
    qualifier: 'delegation-qualifier/1',
    selectorContract: 'delegation-selection/1',
  },
};

/** Shaped for both the port input (mutable arrays) and the stored request (readonly). */
const request = {
  action: 'read-only-review' as const,
  checkout: { path: CHECKOUT },
  constraints: [] as string[],
  criteria: ['Every public function keeps its contract.'],
  objective: 'Review the lock refactor for correctness.',
  schemaVersion: 1 as const,
  scope: { commit: 'HEAD', kind: 'commit' as const },
  taskCategory: 'correctness' as const,
};

const storedJob: NewDelegationJob = {
  accountScope: 'personal',
  action: 'read-only-review',
  checkoutPath: CHECKOUT,
  context: 'personal',
  effort: 'high',
  executorHarness: 'claude-code',
  idempotencyKey: 'caller:session-1:review-7',
  jobId: JOB_ID,
  launchMarker: '2f6a0c4e-5d7b-4a9c-8e1f-2b3c4d5e6f70',
  machineId: MACHINE,
  modelRequested: 'claude-opus-4-1',
  poolId: `${MACHINE}/claude-code/personal`,
  qualification,
  qualificationId: QUALIFICATION_ID,
  request,
  requestDigest: 'd'.repeat(64),
  requestedAt: NOW,
  retryOf: null,
  routeId: 'route-a',
  scope,
  selection: {
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    routeId: 'route-a',
    selectorVersion: 'calling-model/fixture',
  },
  selectionDigest: 's'.repeat(64),
  state: 'requested',
  taskCategory: 'correctness',
};

const seedDelegationStore = async (dbPath: string): Promise<void> => {
  await mkdir(path.dirname(dbPath), { recursive: true });
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await Effect.runPromise(
    requestDelegationJob({ dbPath, job: storedJob, limits: { maxAttempts: 2, maxConcurrent: 1 } }),
  );
};

const firstText = (content: unknown): string => {
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  return typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
    ? first.text
    : '';
};

describe('Memory MCP process composition', () => {
  test('builds the local stdio composition without opening a Memory or usage database', async () => {
    const root = await temporaryRoot();
    let connected = false;
    await runMemoryMcpProcess({
      connect: (server) => {
        connected = server !== null;
        return Promise.resolve();
      },
      cwd: '/workspace',
      environment: {
        AI_USAGE_DATABASE_PATH: path.join(root, 'store', 'usage-store.sqlite'),
        AI_USAGE_ENGINE_STATE_DIR: '/isolated/state',
        AI_USAGE_HOME: '/isolated/home',
      },
    });
    expect(connected).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  test('reads the Work context read-only and reports a missing store as a typed code, never creating it', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    const work = createLocalWorkContextMcpReadService(dbPath);
    const signal = new AbortController().signal;

    expect(await work.readWorkContext({ checkoutPath: '/fixture/checkout', kind: 'checkout' }, signal)).toEqual({
      code: 'store-missing',
      kind: 'error',
    });
    expect(await work.readWorkContext({ checkoutPath: 'relative/checkout', kind: 'checkout' }, signal)).toEqual({
      code: 'invalid-input',
      kind: 'error',
    });
    expect(await readdir(root)).toEqual([]);
  });

  test('answers store-not-upgraded on a store the engine has not reopened since the declaration history', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'usage-store.sqlite');
    const machineId = 'machine-mcp-work-context';
    const registry = claudeDesktopFixtureRegistry({
      cliSessionIdWithTranscript: 'cli-fixture-transcript',
      epoch: new Date(),
      repository: path.join(root, 'work', 'fixture'),
      variant: 'minimal',
    });
    const observations: ClaudeDesktopSessionObservation[] = [];
    for (const entry of registry.documents) {
      const result = parseClaudeDesktopSessionFile(entry.document, {
        accountDirectory: entry.account,
        fileModifiedAt: entry.modifiedAt.toISOString(),
        machineId,
        observedAt: entry.modifiedAt.toISOString(),
        organizationDirectory: entry.organization,
        relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
      });
      if (result.kind === 'observation') {
        observations.push(result.observation);
      }
    }
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(
      importClaudeDesktopSessions({
        collectedAt: new Date(),
        completeness: {
          filesParsed: observations.length,
          filesSeen: observations.length,
          rejected: 0,
          truncated: false,
          unsupported: 0,
        },
        dbPath,
        machineId,
        observations,
      }),
    );
    const db = new Database(dbPath);
    try {
      db.exec('DROP TABLE claude_desktop_turn_declarations');
    } finally {
      db.close();
    }
    const work = createLocalWorkContextMcpReadService(dbPath);
    expect(
      await work.readWorkContext(
        { checkoutPath: path.join(root, 'work', 'fixture'), kind: 'checkout' },
        new AbortController().signal,
      ),
    ).toEqual({ code: 'store-not-upgraded', kind: 'error' });
  });
});

describe('delegation composition', () => {
  test('derives the config root from AI_USAGE_ROOT_DIR, else the installation, never the caller cwd', () => {
    expect(delegationConfigCwd({ AI_USAGE_ROOT_DIR: '/engine/root' }, '/install')).toBe('/engine/root');
    expect(delegationConfigCwd({}, '/install/ai-usage')).toBe('/install/ai-usage');
    expect(() => delegationConfigCwd({}, 'relative/install')).toThrow('absolute');
    const root = mcpInstallationRoot();
    expect(path.isAbsolute(root)).toBe(true);
    expect(path.relative(root, path.resolve(import.meta.dir, '..', '..', '..'))).toBe('');
  });

  test('registers the delegation tools with no Memory rendezvous: start answers engine-unavailable while status reads the store', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'store', 'usage.sqlite');
    await seedDelegationStore(dbPath);
    const connections: ConnectDelegationEngineOptions[] = [];
    let client: InMemoryMcpClient | undefined;
    await runMemoryMcpProcess({
      connect: async (server) => {
        client = await connectInMemoryMcpClient(server, { name: 'mcp-main-test' });
      },
      connectDelegationEngine: (options) => {
        connections.push(options);
        return Promise.reject(new DelegationEngineConnectionError('engine-unavailable', 'no engine (fixture)'));
      },
      cwd: '/workspace',
      environment: {
        AI_USAGE_DATABASE_PATH: dbPath,
        AI_USAGE_ENGINE_STATE_DIR: path.join(root, 'state'),
        AI_USAGE_HOME: path.join(root, 'home'),
      },
      installationRoot: '/install/ai-usage',
    });
    if (client === undefined) {
      throw new Error('The composition did not connect its server.');
    }
    try {
      const names = (await client.listTools()).map(({ name }) => name);
      expect(names).toContain('delegation.qualify');
      expect(names).toContain('delegation.start');
      expect(names).toContain('delegation.status');
      expect(names).toContain('work.context');
      expect(client.instructions()).toContain('Delegation (AI Usage)');

      // The store answers without any engine and without Memory.
      const status = await client.callTool('delegation.status', { jobId: JOB_ID });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        contentRole: 'retrieved-data',
        job: { jobId: JOB_ID, state: 'requested', status: { executed: 'not-run' } },
      });
      const list = await client.callTool('delegation.list', {});
      expect(list.structuredContent).toMatchObject({ jobs: [{ jobId: JOB_ID }], skipped: 0, truncated: false });

      // The engine is down: a start says so, and the connection was asked for the installation root, not the cwd.
      const start = await client.callTool('delegation.start', {
        idempotencyKey: 'caller:session-2:review-1',
        request,
        selection: {
          kind: 'choice',
          qualificationId: QUALIFICATION_ID,
          routeId: 'route-a',
          selectorVersion: 'calling-model/fixture',
        },
      });
      expect(start.isError).toBe(true);
      expect(firstText(start.content)).toBe('Delegation start failed (engine-unavailable).');
      expect(connections).toEqual([
        {
          configCwd: '/install/ai-usage',
          expectedStoreSchemaVersion: 4,
          runtimePaths: { databasePath: dbPath, rendezvousPath: path.join(root, 'state', 'rendezvous.json') },
          signal: expect.any(AbortSignal),
        },
      ]);
      expect(await readdir(root)).toEqual(['store']);
    } finally {
      await client.close();
    }
  });

  test('the local port reads the store read-only and forwards the forced author to the engine commands', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'store', 'usage.sqlite');
    await seedDelegationStore(dbPath);
    const storeBytes = Bun.hash(await Bun.file(dbPath).arrayBuffer());
    const commands: unknown[] = [];
    const port = createLocalDelegationMcpPort({
      configCwd: '/install/ai-usage',
      connect: () =>
        Promise.resolve((command) => {
          commands.push(command);
          return Promise.resolve({
            command: command.command,
            commandId: 'c1',
            completedAt: NOW,
            output: { evaluationId: 'e1', kind: 'delegation-evaluation', refusal: null },
            state: 'succeeded',
          } as never);
        }),
      databasePath: dbPath,
      now: () => NOW,
      rendezvousPath: path.join(root, 'state', 'rendezvous.json'),
    });
    const signal = new AbortController().signal;
    const status = await port.status(JOB_ID, signal);
    expect(status).toMatchObject({ kind: 'success', value: { jobId: JOB_ID, state: 'requested' } });
    expect(await port.status('9f7c3d4e-5a61-4c7d-ae8f-9a0b1c2d3e4f', signal)).toEqual({
      code: 'not-found',
      kind: 'error',
    });
    expect(await port.list({ limit: 1, liveOnly: true }, signal)).toMatchObject({
      kind: 'success',
      value: { jobs: [{ jobId: JOB_ID }] },
    });
    expect(
      await port.evaluate(
        {
          author: 'calling-model',
          authorLabel: 'client-a',
          evaluation: { kind: 'verification', verdict: 'confirmed' },
          jobId: JOB_ID,
        },
        signal,
      ),
    ).toEqual({ kind: 'success', value: { evaluationId: 'e1', refusal: null } });
    expect(commands).toEqual([
      {
        author: 'calling-model',
        authorLabel: 'client-a',
        command: 'record-delegation-evaluation',
        evaluation: { kind: 'verification', verdict: 'confirmed' },
        jobId: JOB_ID,
      },
    ]);
    expect(Bun.hash(await Bun.file(dbPath).arrayBuffer())).toBe(storeBytes);
    expect(Bun.file(`${dbPath}-wal`).size).toBe(0);
  });

  test('delegation.list answers twenty jobs carrying maximal reviews as compact summaries under the response bound', async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, 'store', 'usage.sqlite');
    await mkdir(path.dirname(dbPath), { recursive: true });
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const END = '2026-10-25T10:20:00.000Z';
    // Every result bound at once: a single job view already needs trimming to fit 64 KiB.
    const heavyReview: DelegationReviewResult = {
      checks: Array.from({ length: 20 }, (_, index) => `${index} ${'c'.repeat(297)}`),
      coverage: { notReviewed: Array.from({ length: 50 }, (_, index) => `skipped/${index}.ts`), reviewed: 'x' },
      findings: Array.from({ length: 50 }, (_, index) => ({
        detail: `${index} ${'d'.repeat(1990)}`,
        evidence: Array.from({ length: 8 }, (_entry, line) => ({ line: line + 1, path: `src/${'p'.repeat(400)}` })),
        severity: 'minor' as const,
        title: `Finding ${index}`,
      })),
      limits: Array.from({ length: 20 }, (_, index) => `${index} ${'l'.repeat(297)}`),
      summary: 's'.repeat(4000),
    };
    const jobIds: string[] = [];
    for (let index = 0; index < 20; index++) {
      const suffix = String(index).padStart(12, '0');
      const jobId = `0f2c2b0e-6b1a-4c3e-9f1d-${suffix}`;
      const inserted = await Effect.runPromise(
        requestDelegationJob({
          dbPath,
          job: {
            ...storedJob,
            idempotencyKey: `caller:session-1:heavy-${index}`,
            jobId,
            launchMarker: `2f6a0c4e-5d7b-4a9c-8e1f-${suffix}`,
            requestedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
          },
          limits: { maxAttempts: 2, maxConcurrent: 1 },
        }),
      );
      if (inserted.kind !== 'inserted') {
        throw new Error(`job ${index} was not inserted: ${inserted.kind}`);
      }
      await Effect.runPromise(
        transitionDelegationJob({
          at: END,
          dbPath,
          jobId,
          patch: {
            endedAt: END,
            exitCode: 0,
            result: { excerpt: null, kind: 'review', review: heavyReview },
            startedAt: NOW,
            state: 'finished',
          },
        }),
      );
      jobIds.push(jobId);
    }

    const port = createLocalDelegationMcpPort({
      configCwd: '/install/ai-usage',
      databasePath: dbPath,
      now: () => END,
      rendezvousPath: path.join(root, 'state', 'rendezvous.json'),
    });
    const signal = new AbortController().signal;
    const listed = await port.list({ limit: 20, liveOnly: false }, signal);
    if (listed.kind !== 'success') {
      throw new Error(`list failed: ${listed.code}`);
    }
    expect(listed.value.jobs).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(listed.value), 'utf8')).toBeLessThan(memoryMcpBounds.maxOutputBytes);
    // Newest first, as compact summaries: the whole result's finding count and a 300-character digest.
    expect(listed.value.jobs[0]).toEqual({
      checkoutPath: CHECKOUT,
      endedAt: END,
      failure: null,
      findingCount: 50,
      jobId: jobIds[19],
      live: false,
      refusalReason: null,
      requestedAt: new Date(Date.parse(NOW) + 19_000).toISOString(),
      resultKind: 'review',
      route: {
        context: 'personal',
        harness: 'claude-code',
        modelRequested: 'claude-opus-4-1',
        modelResolved: 'unknown',
      },
      scope: { base: null, head: 'HEAD', kind: 'commit' },
      state: 'finished',
      status: { accepted: 'pending', executed: 'succeeded', verified: 'not-verified' },
      summary: 's'.repeat(300),
    });

    // Through the server: the tool answers under its bound, and the full view stays on status.
    let client: InMemoryMcpClient | undefined;
    await runMemoryMcpProcess({
      connect: async (server) => {
        client = await connectInMemoryMcpClient(server, { name: 'mcp-main-list-test' });
      },
      connectDelegationEngine: () =>
        Promise.reject(new DelegationEngineConnectionError('engine-unavailable', 'no engine (fixture)')),
      cwd: '/workspace',
      environment: {
        AI_USAGE_DATABASE_PATH: dbPath,
        AI_USAGE_ENGINE_STATE_DIR: path.join(root, 'state'),
        AI_USAGE_HOME: path.join(root, 'home'),
      },
      installationRoot: '/install/ai-usage',
    });
    if (client === undefined) {
      throw new Error('The composition did not connect its server.');
    }
    try {
      const list = await client.callTool('delegation.list', { limit: 20 });
      expect(list.isError).not.toBe(true);
      const content = list.structuredContent as { jobs: { jobId: string }[]; skipped: number; truncated: boolean };
      expect(content.jobs).toHaveLength(20);
      expect(content.jobs.map(({ jobId }) => jobId)).toEqual([...jobIds].reverse());
      expect(content).toMatchObject({ skipped: 0, truncated: false });
      const status = await client.callTool('delegation.status', { jobId: jobIds[0] ?? '' });
      expect(status.isError).not.toBe(true);
      const job = (
        status.structuredContent as { job: { result: { findings: unknown[] }; truncation: { findings: number } } }
      ).job;
      expect(job.result.findings.length + job.truncation.findings).toBe(50);
      expect(job.result.findings.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  test('a missing store is a typed failure for status and list, and start without an engine is engine-unavailable', async () => {
    const root = await temporaryRoot();
    const port = createLocalDelegationMcpPort({
      configCwd: '/install/ai-usage',
      databasePath: path.join(root, 'store', 'usage.sqlite'),
      rendezvousPath: path.join(root, 'state', 'rendezvous.json'),
    });
    const signal = new AbortController().signal;
    expect(await port.status(JOB_ID, signal)).toEqual({ code: 'store-missing', kind: 'error' });
    expect(await port.list({ limit: 5, liveOnly: false }, signal)).toEqual({ code: 'store-missing', kind: 'error' });
    expect(await port.cancel(JOB_ID, signal)).toEqual({ code: 'engine-unavailable', kind: 'error' });
    expect(await readdir(root)).toEqual([]);
  });

  test('the port parses every payload with report-core before the engine: issue paths, never values; refusals as data', async () => {
    const root = await temporaryRoot();
    let connections = 0;
    const port = createLocalDelegationMcpPort({
      configCwd: '/install/ai-usage',
      connect: () => {
        connections += 1;
        return Promise.reject(new DelegationEngineConnectionError('engine-unavailable', 'fixture'));
      },
      databasePath: path.join(root, 'store', 'usage.sqlite'),
      rendezvousPath: path.join(root, 'state', 'rendezvous.json'),
    });
    const signal = new AbortController().signal;
    const invalid = await port.qualify(
      { ...request, checkout: { path: 'relative/secret-dir' }, scope: { commit: '-rf', kind: 'commit' } },
      signal,
    );
    expect(invalid).toMatchObject({ code: 'invalid-input', kind: 'error' });
    const issues = invalid.kind === 'error' ? (invalid.issues ?? []) : [];
    expect(issues.some((issue) => issue.startsWith('request.checkout.path ('))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('request.scope.commit ('))).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain('secret-dir');
    expect(JSON.stringify(invalid)).not.toContain('-rf');

    expect(await port.qualify({ ...request, action: 'code-change' }, signal)).toEqual({
      kind: 'success',
      value: {
        qualification: null,
        refusal: { message: expect.stringContaining('read-only-review'), reason: 'action-unsupported' },
      },
    });
    const blankRoute = await port.start(
      {
        idempotencyKey: 'caller:session-1:review-7',
        request,
        selection: { kind: 'choice', qualificationId: QUALIFICATION_ID, routeId: '   ', selectorVersion: 'v' },
      },
      signal,
    );
    expect(blankRoute).toMatchObject({ code: 'invalid-input', issues: [expect.stringContaining('selection.routeId')] });
    expect(
      await port.evaluate(
        {
          author: 'calling-model',
          authorLabel: null,
          evaluation: { kind: 'verification', note: 'n'.repeat(2001), verdict: 'confirmed' },
          jobId: JOB_ID,
        },
        signal,
      ),
    ).toMatchObject({ code: 'invalid-input', issues: [expect.stringContaining('note')] });
    expect(connections).toBe(0);
  });

  test('the adapter mirrors of the delegation vocabulary and bounds match report-core', () => {
    expect([...delegationMcpVocabulary.abstentionReasons]).toEqual([...DELEGATION_ABSTENTION_REASONS]);
    expect([...delegationMcpVocabulary.actions]).toEqual([...DELEGATION_ACTIONS]);
    expect([...delegationMcpVocabulary.reservedActions]).toEqual([...DELEGATION_RESERVED_ACTIONS]);
    expect([...delegationMcpVocabulary.reservedScopeKinds]).toEqual([...DELEGATION_RESERVED_SCOPE_KINDS]);
    expect([...delegationMcpVocabulary.scopeKinds]).toEqual([...DELEGATION_SCOPE_KINDS]);
    expect([...delegationMcpVocabulary.taskCategories]).toEqual([...DELEGATION_TASK_CATEGORIES]);
    expect([...delegationMcpVocabulary.verificationVerdicts]).toEqual([...DELEGATION_VERIFICATION_VERDICTS]);
    const { evaluation, idempotencyKey, request: requestBounds, selection } = delegationMcpBounds;
    expect(requestBounds).toMatchObject({
      maxCheckoutPathCharacters: DELEGATION_BOUNDS.maxCheckoutPathCharacters,
      maxClientCorrelationCharacters: DELEGATION_BOUNDS.maxClientCorrelationCharacters,
      maxClientNameCharacters: DELEGATION_BOUNDS.maxClientNameCharacters,
      maxClientSessionRefCharacters: DELEGATION_BOUNDS.maxClientSessionRefCharacters,
      maxConstraintCharacters: DELEGATION_BOUNDS.maxConstraintCharacters,
      maxConstraints: DELEGATION_BOUNDS.maxConstraints,
      maxCriteria: DELEGATION_BOUNDS.maxCriteria,
      maxCriterionCharacters: DELEGATION_BOUNDS.maxCriterionCharacters,
      maxObjectiveCharacters: DELEGATION_BOUNDS.maxObjectiveCharacters,
      maxRevisionCharacters: DELEGATION_BOUNDS.maxRevisionCharacters,
    });
    expect(requestBounds.revisionPattern.source).toBe(DELEGATION_REVISION_PATTERN.source);
    expect(selection).toMatchObject({
      maxRationale: DELEGATION_BOUNDS.maxSelectionRationale,
      maxRationaleCharacters: DELEGATION_BOUNDS.maxSelectionRationaleCharacters,
      maxSelectorVersionCharacters: DELEGATION_BOUNDS.maxSelectorVersionCharacters,
    });
    expect(evaluation).toEqual({
      maxCheckCharacters: DELEGATION_BOUNDS.maxEvaluationCheckCharacters,
      maxChecks: DELEGATION_BOUNDS.maxEvaluationChecks,
      maxNoteCharacters: DELEGATION_BOUNDS.maxEvaluationNoteCharacters,
    });
    expect(idempotencyKey.maxCharacters).toBe(DELEGATION_BOUNDS.maxIdempotencyKeyCharacters);
    expect(idempotencyKey.minCharacters).toBe(DELEGATION_BOUNDS.minIdempotencyKeyCharacters);
    expect(idempotencyKey.pattern.source).toBe(DELEGATION_IDEMPOTENCY_KEY_PATTERN.source);
    expect(delegationMcpBounds.maxListLimit).toBe(DELEGATION_READ_BOUNDS.maxListLimit);
    expect(delegationMcpBounds.defaultListLimit).toBe(DELEGATION_READ_BOUNDS.defaultListLimit);
  });
});
