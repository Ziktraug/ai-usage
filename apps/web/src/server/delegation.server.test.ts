import { beforeEach, describe, expect, test } from 'bun:test';
import type { LocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type { DelegationJob } from '@ai-usage/report-core/delegation-contracts';
import { DEFAULT_DELEGATION_CONFIG } from '@ai-usage/report-core/delegation-policy';
import type { UsageEngineCommandCompletion, UsageEngineCommandId } from '@ai-usage/usage-engine-control';
import { DELEGATION_WEB_BOUNDS } from '@ai-usage/web-contract/delegation';
import {
  cancelDelegationForServer,
  type DelegationDeclarationsRead,
  type DelegationServerReaders,
  declarationsFromRouting,
  type ExecuteDelegationCommand,
  getDelegationJobForServer,
  getDelegationSettingsForServer,
  listDelegationJobsForServer,
  recordDelegationAcceptanceForServer,
  STORE_NOT_UPGRADED_MESSAGE,
  saveDelegationSettingsForServer,
  simulateDelegationForServer,
} from './delegation.server';
import { E2E_DELEGATION_JOB_IDS, resetE2EDelegationFixture } from './delegation-e2e-fixture.server';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const JOB_ID = '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f';
const MACHINE = 'machine-a';
const CLAUDE_ROUTE = 'declared:["machine-a","claude-code","personal"]';

const declared: DelegationDeclarationsRead = {
  configPath: '/home/operator/.config/ai-usage/config.json',
  delegation: {
    config: {
      ...DEFAULT_DELEGATION_CONFIG,
      models: [
        {
          alias: 'opus',
          declaredAt: '2026-10-20T08:00:00.000Z',
          discouragedFor: [],
          harnesses: ['claude-code'],
          id: 'claude-opus',
          nativeId: 'claude-opus-4-1',
          note: null,
          provider: 'anthropic',
          recommendedFor: ['correctness'],
          resolvedVersion: null,
        },
      ],
      routes: [{ accountScope: 'personal', context: 'personal', harness: 'claude-code', label: 'Claude personal' }],
    },
    issues: [{ path: 'delegation.rules[0]', reason: 'must be an object' }],
  },
  executors: {
    declarations: [
      {
        accountScope: 'personal',
        authorization: 'allowed',
        capabilities: ['read-only-review'],
        declaredAt: '2026-10-20T08:00:00.000Z',
        effort: 'high',
        harness: 'claude-code',
        machineId: MACHINE,
        model: 'claude-opus-4-1',
        quality: 'review-capable',
        subscription: 'verified',
        targets: [{ kind: 'any-local-session' }],
      },
    ],
    issues: [],
  },
  githubAccounts: [{ ghUser: 'operator', owner: 'acme' }],
  machineId: MACHINE,
  reviewTargets: { issues: [], targets: [{ checkoutPath: '/home/operator/src', label: null }] },
  revisions: { catalogRevision: 'c'.repeat(16), policyRevision: 'p'.repeat(16) },
};

const job: DelegationJob = {
  accountScope: 'personal',
  action: 'read-only-review',
  attemptNumber: 1,
  cancelRequestedAt: null,
  checkoutPath: '/home/operator/src/ai-usage',
  context: 'personal',
  effort: 'high',
  endedAt: '2026-10-25T09:05:00.000Z',
  executedScope: null,
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  guarantee: null,
  harnessVersion: '2.1.306',
  idempotencyKey: 'k'.repeat(16),
  jobId: JOB_ID,
  launchMarker: null,
  machineId: MACHINE,
  modelRequested: 'claude-opus-4-1',
  modelResolved: 'claude-opus-4-1-20260901',
  nativeSessionId: null,
  pid: null,
  poolId: CLAUDE_ROUTE,
  qualification: null,
  qualificationId: null,
  refusalReason: null,
  releasedAt: null,
  releaseEvidence: null,
  request: {
    action: 'read-only-review',
    checkout: { path: '/home/operator/src/ai-usage' },
    constraints: [],
    criteria: [],
    objective: 'Review it.',
    schemaVersion: 1,
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestDigest: 'a'.repeat(64),
  requestedAt: '2026-10-25T09:00:00.000Z',
  result: { excerpt: 'Looks fine.', kind: 'unstructured', review: null },
  retryOf: null,
  routeId: CLAUDE_ROUTE,
  scope: null,
  selection: null,
  startedAt: '2026-10-25T09:00:02.000Z',
  state: 'finished',
  taskCategory: 'correctness',
  traceVersion: 1,
  updatedAt: '2026-10-25T09:05:00.000Z',
  usage: null,
};

const readers = (overrides: Partial<DelegationServerReaders> = {}): DelegationServerReaders => ({
  now: () => NOW,
  readDeclarations: () => Promise.resolve(declared),
  readJob: () => Promise.resolve({ evaluations: [], job, kind: 'ok', skipped: 0 }),
  readJobs: () => Promise.resolve({ evaluations: [], jobs: [job], kind: 'ok', skipped: 1, truncated: false }),
  readObservations: () =>
    Promise.resolve([
      {
        authEvidence: 'claude auth status exit 0 loggedIn=true',
        authMethod: 'claude.ai',
        authState: 'logged-in',
        binaryPath: '/usr/bin/claude',
        harness: 'claude-code',
        machineId: MACHINE,
        observedAt: '2026-10-25T09:58:00.000Z',
        outcome: 'observed',
        version: '2.1.306',
      },
    ]),
  readQuota: () => Promise.resolve([]),
  ...overrides,
});

const completion = (command: UsageEngineCommandCompletion['command'], output: unknown): UsageEngineCommandCompletion =>
  ({
    command,
    commandId: 'c'.repeat(36) as UsageEngineCommandId,
    completedAt: NOW.toISOString(),
    output,
    state: 'succeeded',
  }) as UsageEngineCommandCompletion;

const recording = (answer: UsageEngineCommandCompletion) => {
  const commands: unknown[] = [];
  const execute: ExecuteDelegationCommand = (command) => {
    commands.push(command);
    return Promise.resolve(answer);
  };
  return { commands, execute };
};

describe('delegation server: modes', () => {
  beforeEach(() => resetE2EDelegationFixture());

  test('demo exposes nothing', async () => {
    const demo = { mode: 'demo' } as const;
    const never: ExecuteDelegationCommand = () => Promise.reject(new Error('must not run'));
    for (const outcome of await Promise.all([
      getDelegationSettingsForServer(demo),
      listDelegationJobsForServer({}, demo),
      getDelegationJobForServer({ jobId: JOB_ID }, demo),
      saveDelegationSettingsForServer({ delegation: {}, expectedRevision: 'x' }, never, demo),
      simulateDelegationForServer(
        { checkoutPath: '/x', scope: { commit: 'HEAD', kind: 'commit' }, taskCategory: 'tests' },
        never,
        demo,
      ),
      cancelDelegationForServer({ jobId: JOB_ID }, never, demo),
      recordDelegationAcceptanceForServer({ jobId: JOB_ID, verdict: 'accepted' }, never, demo),
    ])) {
      expect(outcome).toEqual({ kind: 'forbidden-demo', message: 'Delegation is not available in the demo.' });
    }
  });

  test('e2e answers the fixture for reads, save and simulation, and refuses commands', async () => {
    const e2e = { mode: 'e2e' } as const;
    const settings = await getDelegationSettingsForServer(e2e);
    if (settings.kind !== 'ok') {
      throw new Error(`settings: ${settings.kind}`);
    }
    expect(settings.data.routes.map((route) => [route.harness, route.label, route.context])).toEqual([
      ['claude-code', 'Claude · personal', 'personal'],
      ['codex', 'Codex · work', 'professional'],
    ]);
    expect(settings.data.harnesses.map((entry) => [entry.harness, entry.executor])).toEqual([
      ['claude-code', 'supported'],
      ['codex', 'supported'],
      ['opencode', 'not-supported'],
      ['cursor', 'not-supported'],
    ]);
    expect(settings.data.observedModels).toEqual([
      {
        harness: 'claude-code',
        jobs: 1,
        lastSeenAt: '2026-10-25T09:20:00.000Z',
        modelRequested: 'claude-opus-4-1',
        modelResolved: 'claude-opus-4-1-20260901',
      },
      {
        harness: 'claude-code',
        jobs: 1,
        lastSeenAt: '2026-10-25T09:35:00.000Z',
        modelRequested: 'claude-opus-4-1',
        modelResolved: null,
      },
    ]);

    const jobs = await listDelegationJobsForServer({}, e2e);
    if (jobs.kind !== 'ok') {
      throw new Error(`jobs: ${jobs.kind}`);
    }
    expect(jobs.data.jobs.map((view) => [view.state, view.status.executed, view.status.verified])).toEqual([
      ['finished', 'succeeded', 'not-verified'],
      ['refused', 'not-run', 'not-verified'],
      ['lost', 'unknown', 'not-verified'],
    ]);
    const finished = jobs.data.jobs[0];
    expect(finished?.result?.findings).toHaveLength(2);
    expect(finished?.evaluations.automatedChecks).toHaveLength(1);
    expect(finished?.qualification?.excludedRoutes.map((route) => route.blockers)).toEqual([['forbidden-by-rule']]);
    expect(jobs.data.jobs[2]?.reservation.held).toBe(true);
    const live = await listDelegationJobsForServer({ liveOnly: true }, e2e);
    expect(live).toEqual({ data: { jobs: [], omitted: 0, skipped: 0 }, kind: 'ok' });

    const one = await getDelegationJobForServer({ jobId: E2E_DELEGATION_JOB_IDS.refused }, e2e);
    expect(one.kind === 'ok' && one.data.refusal?.reason).toBe('no-admissible-route');
    expect(await getDelegationJobForServer({ jobId: JOB_ID }, e2e)).toEqual({
      kind: 'not-found',
      message: 'No delegation job has this id.',
    });

    const never: ExecuteDelegationCommand = () => Promise.reject(new Error('must not run'));
    const simulation = await simulateDelegationForServer(
      {
        checkoutPath: '/fixture/src/fixture-app',
        scope: { commit: 'HEAD', kind: 'commit' },
        taskCategory: 'security',
      },
      never,
      e2e,
    );
    if (simulation.kind !== 'ok') {
      throw new Error(`simulation: ${simulation.kind}`);
    }
    expect(simulation.data.purpose).toBe('simulation');
    expect(simulation.data.outcome).toBe('routes-available');
    expect(simulation.data.routes.map((route) => [route.harness, route.admissible, route.blockers])).toEqual([
      ['claude-code', true, []],
      ['codex', false, ['forbidden-by-rule']],
    ]);

    const conflict = await saveDelegationSettingsForServer({ delegation: {}, expectedRevision: 'stale' }, never, e2e);
    expect(conflict).toMatchObject({ kind: 'conflict', revision: settings.data.revision });
    const invalid = await saveDelegationSettingsForServer(
      {
        delegation: { rules: [{ effect: 'forbid', id: 'Not A Slug', match: {} }] },
        expectedRevision: settings.data.revision,
      },
      never,
      e2e,
    );
    expect(invalid).toMatchObject({ kind: 'invalid-input', reason: 'invalid-configuration' });
    expect(invalid.kind === 'invalid-input' && invalid.issues.length).toBeGreaterThan(0);
    const written = await saveDelegationSettingsForServer(
      { delegation: { defaults: { reservePercent: 30 } }, expectedRevision: settings.data.revision },
      never,
      e2e,
    );
    expect(written).toMatchObject({ data: { issues: [], result: 'written' }, kind: 'ok' });
    expect(written.kind === 'ok' && written.data.revision).not.toBe(settings.data.revision);
    const after = await getDelegationSettingsForServer(e2e);
    expect(after.kind === 'ok' && after.data.delegation.config.defaults.reservePercent).toBe(30);
    expect(after.kind === 'ok' && after.data.revision).toBe(written.kind === 'ok' ? written.data.revision : '');

    expect(await cancelDelegationForServer({ jobId: JOB_ID }, never, e2e)).toMatchObject({
      kind: 'unavailable',
      reason: 'not-available-in-runtime',
    });
    expect(await recordDelegationAcceptanceForServer({ jobId: JOB_ID, verdict: 'accepted' }, never, e2e)).toMatchObject(
      { kind: 'unavailable', reason: 'not-available-in-runtime' },
    );
  });
});

describe('delegation server: live reads', () => {
  test('assembles the settings from the declarations, observations, quota and jobs', async () => {
    const outcome = await getDelegationSettingsForServer({ mode: 'live', readers: readers() });
    if (outcome.kind !== 'ok') {
      throw new Error(`settings: ${outcome.kind}`);
    }
    const view = outcome.data;
    expect(view.configPath).toBe('/home/operator/.config/ai-usage/config.json');
    expect(view.revision).toBe('p'.repeat(16));
    expect(view.catalogRevision).toBe('c'.repeat(16));
    expect(view.delegation.issues).toEqual([{ path: 'delegation.rules[0]', reason: 'must be an object' }]);
    expect(view.githubAccounts).toEqual([{ ghUser: 'operator', owner: 'acme' }]);
    expect(view.routes).toHaveLength(1);
    expect(view.routes[0]).toMatchObject({
      accountScope: 'personal',
      availability: { authMethod: 'claude.ai', authState: 'logged-in', provenance: 'observed-now', state: 'available' },
      context: 'personal',
      harness: 'claude-code',
      label: 'Claude personal',
      lastCheckedAt: '2026-10-25T09:58:00.000Z',
      model: 'claude-opus-4-1',
      poolId: CLAUDE_ROUTE,
      provider: 'anthropic',
      quota: { observedAt: null, provenance: 'unknown', windows: [] },
      routeId: CLAUDE_ROUTE,
      subscription: 'verified',
    });
    expect(view.routes[0]?.missing.join(' ')).toContain('quota');
    expect(view.models).toHaveLength(1);
    expect(view.models[0]?.entry.nativeId).toBe('claude-opus-4-1');
    expect(view.models[0]?.observed).toEqual({
      jobs: 1,
      lastSeenAt: '2026-10-25T09:00:00.000Z',
      modelResolved: 'claude-opus-4-1-20260901',
    });
    expect(view.observedModels).toEqual([
      {
        harness: 'claude-code',
        jobs: 1,
        lastSeenAt: '2026-10-25T09:00:00.000Z',
        modelRequested: 'claude-opus-4-1',
        modelResolved: 'claude-opus-4-1-20260901',
      },
    ]);
  });

  test('projects the jobs and classifies store failures', async () => {
    const listed = await listDelegationJobsForServer({ limit: 5 }, { mode: 'live', readers: readers() });
    if (listed.kind !== 'ok') {
      throw new Error(`jobs: ${listed.kind}`);
    }
    expect(listed.data.skipped).toBe(1);
    expect(listed.data.omitted).toBe(0);
    expect(listed.data.jobs[0]).toMatchObject({
      jobId: JOB_ID,
      route: { modelRequested: 'claude-opus-4-1', modelResolved: 'claude-opus-4-1-20260901' },
      status: { accepted: 'pending', executed: 'succeeded', verified: 'not-verified' },
    });

    // Twenty jobs at the view bound do not fit one answer: the newest are kept, the trailing ones are counted.
    const heavy: DelegationJob[] = Array.from({ length: 20 }, (_, index) => ({
      ...job,
      jobId: `0f2c2b0e-6b1a-4c3e-9f1d-${String(index).padStart(12, '0')}`,
      result: {
        excerpt: null,
        kind: 'review',
        review: {
          checks: [],
          coverage: { notReviewed: [], reviewed: 'x' },
          findings: Array.from({ length: 50 }, (_entry, finding) => ({
            detail: `${finding} ${'d'.repeat(1990)}`,
            evidence: Array.from({ length: 8 }, (_line, line) => ({ line: line + 1, path: `src/${'p'.repeat(400)}` })),
            severity: 'minor' as const,
            title: `Finding ${finding}`,
          })),
          limits: [],
          summary: 'Heavy.',
        },
      },
    }));
    const bounded = await listDelegationJobsForServer(
      { limit: 20 },
      {
        mode: 'live',
        readers: readers({
          readJobs: () => Promise.resolve({ evaluations: [], jobs: heavy, kind: 'ok', skipped: 0, truncated: false }),
        }),
      },
    );
    if (bounded.kind !== 'ok') {
      throw new Error(`jobs: ${bounded.kind}`);
    }
    expect(bounded.data.omitted).toBeGreaterThan(0);
    expect(bounded.data.jobs.length + bounded.data.omitted).toBe(20);
    expect(bounded.data.jobs.map(({ jobId }) => jobId)).toEqual(
      heavy.slice(0, bounded.data.jobs.length).map(({ jobId }) => jobId),
    );
    expect(new TextEncoder().encode(JSON.stringify(bounded.data.jobs)).byteLength).toBeLessThanOrEqual(
      DELEGATION_WEB_BOUNDS.maxJobsListBytes,
    );
    const limits: unknown[] = [];
    await listDelegationJobsForServer(
      { limit: 500 as never, liveOnly: true },
      {
        mode: 'live',
        readers: readers({
          readJobs: (input) => {
            limits.push(input);
            return Promise.resolve({ kind: 'store-missing' });
          },
        }),
      },
    );
    expect(limits).toEqual([{ limit: 50, liveOnly: true }]);
    expect(
      await listDelegationJobsForServer(
        {},
        { mode: 'live', readers: readers({ readJobs: () => Promise.resolve({ kind: 'store-missing' }) }) },
      ),
    ).toEqual({ data: { jobs: [], omitted: 0, skipped: 0 }, kind: 'ok' });
    expect(
      await listDelegationJobsForServer(
        {},
        {
          mode: 'live',
          readers: readers({ readJobs: () => Promise.resolve({ kind: 'store-not-upgraded', message: '/private/x' }) }),
        },
      ),
    ).toEqual({ kind: 'incompatible-store', message: STORE_NOT_UPGRADED_MESSAGE });
    expect(
      await getDelegationJobForServer(
        { jobId: JOB_ID },
        { mode: 'live', readers: readers({ readJob: () => Promise.resolve({ kind: 'not-found', skipped: 0 }) }) },
      ),
    ).toEqual({ kind: 'not-found', message: 'No delegation job has this id.' });
    const busy = await getDelegationJobForServer(
      { jobId: JOB_ID },
      {
        mode: 'live',
        readers: readers({
          readJob: () => Promise.resolve({ kind: 'unavailable', message: 'busy at /private/x', reason: 'busy' }),
        }),
      },
    );
    expect(busy).toMatchObject({ kind: 'unavailable', reason: 'usage-store-unavailable' });
    expect(JSON.stringify(busy)).not.toContain('/private/x');
  });

  test('regroups one routing read by section and keeps only the owner and login of a GitHub account', () => {
    const routing: LocalRoutingDeclarations = {
      configPath: '/home/operator/.config/ai-usage/config.json',
      declarations: [],
      delegation: declared.delegation,
      githubAccounts: [{ ghUser: 'operator', host: 'github.com', owner: 'acme' }],
      issues: [],
      machineId: MACHINE,
      reviewTargetIssues: [],
      reviewTargets: [],
      revisions: declared.revisions,
    };
    expect(declarationsFromRouting(routing)).toEqual({
      ...declared,
      executors: { declarations: [], issues: [] },
      reviewTargets: { issues: [], targets: [] },
    });
  });
});

describe('delegation server: engine commands', () => {
  test('saveSettings forwards the sections and maps written, conflict and invalid answers', async () => {
    const input = { delegation: { defaults: { reservePercent: 30 } }, expectedRevision: 'p'.repeat(16) };
    const written = recording(
      completion('update-delegation-config', {
        issues: [],
        kind: 'delegation-config',
        result: 'written',
        revision: 'q'.repeat(16),
      }),
    );
    expect(await saveDelegationSettingsForServer(input, written.execute, { mode: 'live' })).toEqual({
      data: { issues: [], result: 'written', revision: 'q'.repeat(16) },
      kind: 'ok',
    });
    expect(written.commands).toEqual([
      {
        command: 'update-delegation-config',
        delegation: { defaults: { reservePercent: 30 } },
        expectedRevision: 'p'.repeat(16),
      },
    ]);
    const conflict = recording(
      completion('update-delegation-config', {
        issues: [],
        kind: 'delegation-config',
        result: 'revision-conflict',
        revision: 'r'.repeat(16),
      }),
    );
    expect(await saveDelegationSettingsForServer(input, conflict.execute, { mode: 'live' })).toMatchObject({
      kind: 'conflict',
      revision: 'r'.repeat(16),
    });
    const invalid = recording(
      completion('update-delegation-config', {
        issues: [{ path: 'delegation.defaults.reservePercent', reason: 'must be between 0 and 90' }],
        kind: 'delegation-config',
        result: 'invalid',
        revision: 'p'.repeat(16),
      }),
    );
    expect(await saveDelegationSettingsForServer(input, invalid.execute, { mode: 'live' })).toMatchObject({
      issues: [{ path: 'delegation.defaults.reservePercent', reason: 'must be between 0 and 90' }],
      kind: 'invalid-input',
      reason: 'invalid-configuration',
    });
  });

  test('simulate sends a schema 1 read-only-review request with purpose simulation and reads the qualification back', async () => {
    const answered = recording(
      completion('qualify-delegation', {
        kind: 'delegation-qualification',
        qualification: { outcome: 'refused', qualificationId: JOB_ID, schemaVersion: 1 },
      }),
    );
    const outcome = await simulateDelegationForServer(
      {
        checkoutPath: '/home/operator/src/ai-usage',
        scope: { base: 'main', head: 'HEAD', kind: 'range' },
        taskCategory: 'tests',
      },
      answered.execute,
      { mode: 'live' },
    );
    expect(answered.commands).toEqual([
      {
        command: 'qualify-delegation',
        purpose: 'simulation',
        request: {
          action: 'read-only-review',
          checkout: { path: '/home/operator/src/ai-usage' },
          constraints: [],
          criteria: [],
          objective: 'Policy simulation',
          schemaVersion: 1,
          scope: { base: 'main', head: 'HEAD', kind: 'range' },
          taskCategory: 'tests',
        },
      },
    ]);
    // The control plane only checks the envelope; a qualification the report-core parser refuses is reported, never shown.
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'qualification-unreadable' });
  });

  test('cancel relays the engine answer; a stopped engine is EngineUnavailable, a wrong completion Unavailable', async () => {
    const cancelled = recording(
      completion('cancel-delegation', {
        jobId: JOB_ID,
        kind: 'delegation-cancel',
        result: 'already-ended',
        state: 'finished',
      }),
    );
    expect(await cancelDelegationForServer({ jobId: JOB_ID }, cancelled.execute, { mode: 'live' })).toEqual({
      data: { jobId: JOB_ID, result: 'already-ended', state: 'finished' },
      kind: 'ok',
    });
    expect(cancelled.commands).toEqual([{ command: 'cancel-delegation', jobId: JOB_ID }]);
    const down: ExecuteDelegationCommand = () => Promise.reject(new Error('connect ECONNREFUSED /private/engine.sock'));
    const stopped = await cancelDelegationForServer({ jobId: JOB_ID }, down, { mode: 'live' });
    expect(stopped).toMatchObject({ kind: 'engine-unavailable' });
    expect(JSON.stringify(stopped)).not.toContain('/private');
    const other = recording(completion('publish', { kind: 'publication' }));
    expect(await cancelDelegationForServer({ jobId: JOB_ID }, other.execute, { mode: 'live' })).toMatchObject({
      kind: 'unavailable',
      reason: 'engine-did-not-complete',
    });
  });

  test('recordAcceptance always records as the operator from the web edge and maps refusals', async () => {
    const recorded = recording(
      completion('record-delegation-evaluation', {
        evaluationId: 'eval-1',
        kind: 'delegation-evaluation',
        refusal: null,
      }),
    );
    expect(
      await recordDelegationAcceptanceForServer(
        { jobId: JOB_ID, note: 'Confirmed by reading the diff.', verdict: 'accepted' },
        recorded.execute,
        { mode: 'live' },
      ),
    ).toEqual({ data: { evaluationId: 'eval-1' }, kind: 'ok' });
    expect(recorded.commands).toEqual([
      {
        author: 'operator',
        authorLabel: 'web',
        command: 'record-delegation-evaluation',
        evaluation: { kind: 'acceptance', note: 'Confirmed by reading the diff.', verdict: 'accepted' },
        jobId: JOB_ID,
      },
    ]);
    const notEnded = recording(
      completion('record-delegation-evaluation', {
        evaluationId: null,
        kind: 'delegation-evaluation',
        refusal: { message: 'The job is still running.', reason: 'not-ended' },
      }),
    );
    expect(
      await recordDelegationAcceptanceForServer({ jobId: JOB_ID, verdict: 'rejected' }, notEnded.execute, {
        mode: 'live',
      }),
    ).toEqual({ kind: 'conflict', message: 'The job is still running.' });
    const missing = recording(
      completion('record-delegation-evaluation', {
        evaluationId: null,
        kind: 'delegation-evaluation',
        refusal: { message: 'No job has this id.', reason: 'not-found' },
      }),
    );
    expect(
      await recordDelegationAcceptanceForServer({ jobId: JOB_ID, verdict: 'taken-over' }, missing.execute, {
        mode: 'live',
      }),
    ).toEqual({ kind: 'not-found', message: 'No job has this id.' });
  });
});
