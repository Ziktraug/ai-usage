import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { DelegationJobsOutput, DelegationJobViewWire } from '@ai-usage/web-contract/delegation';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { DelegationClientResult } from '../../rpc/delegation-client';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work delegations fixture did not expose a Svelte component.');
  }
  return value.default as Component;
};
const rendererFrom = (value: unknown): SvelteServerModule => {
  if (!(typeof value === 'object' && value !== null && 'render' in value && typeof value.render === 'function')) {
    throw new Error('Svelte server renderer is unavailable.');
  }
  return value as SvelteServerModule;
};

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: {
    alias: { '$app/env': fileURLToPath(new URL('../sync/sync-ssr-environment.fixture.ts', import.meta.url)) },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());
const [fixtureModule, rendererModule] = await Promise.all([
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-delegations.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

const REFERENCE = '2026-10-25T10:00:00.000Z';
const FINISHED_ID = '11111111-1111-4111-8111-111111111111';
const REFUSED_ID = '22222222-2222-4222-8222-222222222222';
const LOST_ID = '33333333-3333-4333-8333-333333333333';
const LIVE_ID = '44444444-4444-4444-8444-444444444444';
const QUALIFICATION_ID = '7d3a9b2c-1e4f-4a5b-8c6d-9e0f1a2b3c4d';
const ROUTE_ID = 'declared:["m","claude-code","personal"]';

const job = (overrides: Partial<DelegationJobViewWire>): DelegationJobViewWire => ({
  attemptNumber: 1,
  cancelRequestedAt: null,
  endedAt: '2026-10-25T09:25:00.000Z',
  evaluations: {
    acceptance: null,
    acceptances: [],
    automatedChecks: [
      {
        author: 'automated-check',
        authorLabel: 'engine',
        checks: ['final message parsed as the review contract'],
        evaluationId: 'check-1',
        kind: 'verification',
        note: null,
        recordedAt: '2026-10-25T09:25:01.000Z',
        verdict: 'confirmed',
      },
    ],
    verifications: [],
  },
  executedScope: {
    fileCount: 2,
    files: [
      { coverage: 'complete', path: 'src/a.ts' },
      { coverage: 'omitted', path: 'src/b.ts' },
    ],
    includedBytes: 2048,
    patchBytes: 5120,
    patchSha256: 'd'.repeat(64),
    truncated: true,
    workingTreeDirty: false,
  },
  failure: null,
  frozenScope: {
    base: 'first-parent',
    baseRef: null,
    baseSha: 'c'.repeat(40),
    commitCount: 1,
    headRef: 'HEAD',
    headSha: 'b'.repeat(40),
    kind: 'commit',
  },
  guarantee: {
    cliVersion: '2.1.306',
    controls: ['tools Read Grep Glob', 'safe mode', 'no MCP servers'],
    effort: 'high',
    harness: 'claude-code',
    limits: ['managed policy hooks still run'],
    model: 'claude-opus-4-1',
  },
  heartbeatAgeSeconds: null,
  jobId: FINISHED_ID,
  live: false,
  machineId: 'm',
  notes: ['A finished execution is not a verification.', 'A verification is not an acceptance.'],
  qualification: {
    admissibleRoutes: 1,
    catalogRevision: '0123456789abcdef',
    excludedRoutes: [{ blockers: ['forbidden-by-rule'], routeId: 'declared:["m","codex","work"]' }],
    omittedExcludedRoutes: 0,
    policyRevision: 'fedcba9876543210',
    qualificationId: QUALIFICATION_ID,
    qualifiedAt: '2026-10-25T09:20:00.000Z',
  },
  refusal: null,
  request: {
    action: 'read-only-review',
    checkoutPath: '/home/operator/src/ai-usage',
    constraints: [],
    criteria: ['the migration is reversible'],
    objective: 'Review the store migration for data loss.',
    scope: { commit: 'HEAD', kind: 'commit' },
    taskCategory: 'correctness',
  },
  requestedAt: '2026-10-25T09:20:00.000Z',
  reservation: { evidence: null, held: false, releasedAt: null },
  result: {
    checks: ['read the migration and its test'],
    coverage: { notReviewed: ['src/b.ts (omitted from the patch)'], reviewed: 'src/a.ts as given in the patch.' },
    excerpt: null,
    findings: [
      {
        detail: 'The bound is enforced after the write.',
        evidence: [{ line: 48, path: 'src/a.ts' }],
        severity: 'major',
        title: 'Bound enforced after the write',
      },
    ],
    kind: 'review',
    limits: ['the patch was truncated'],
    summary: 'One major finding; the rest holds.',
  },
  retryOf: null,
  route: {
    accountScope: 'personal',
    context: 'personal',
    effort: 'high',
    harness: 'claude-code',
    harnessVersion: '2.1.306',
    modelRequested: 'claude-opus-4-1',
    modelResolved: 'unknown',
    poolId: ROUTE_ID,
    routeId: ROUTE_ID,
  },
  selection: {
    confidence: 0.7,
    kind: 'choice',
    qualificationId: QUALIFICATION_ID,
    rationale: ['recommended for correctness'],
    routeId: ROUTE_ID,
    selectorVersion: 'calling-model/claude-code',
  },
  startedAt: '2026-10-25T09:20:02.000Z',
  state: 'finished',
  status: { accepted: 'pending', executed: 'succeeded', verified: 'not-verified' },
  truncation: {
    automatedChecks: 0,
    characters: 0,
    constraints: 0,
    criteria: 0,
    evaluationChecks: 0,
    evaluations: 0,
    evidence: 0,
    findings: 0,
    guaranteeControls: 0,
    guaranteeLimits: 0,
    notReviewed: 0,
    rationale: 0,
    resultChecks: 0,
    resultLimits: 0,
    scopeFiles: 0,
  },
  updatedAt: '2026-10-25T09:25:01.000Z',
  usage: { cachedInputTokens: 2000, inputTokens: 18_000, outputTokens: 1200, source: 'harness-reported' },
  ...overrides,
});

const refused = job({
  endedAt: '2026-10-25T09:30:00.000Z',
  evaluations: { acceptance: null, acceptances: [], automatedChecks: [], verifications: [] },
  executedScope: null,
  frozenScope: null,
  guarantee: null,
  jobId: REFUSED_ID,
  qualification: null,
  refusal: { message: 'No route is admissible for this request.', reason: 'no-admissible-route' },
  result: null,
  route: null,
  selection: null,
  startedAt: null,
  state: 'refused',
  status: { accepted: 'pending', executed: 'not-run', verified: 'not-verified' },
  usage: null,
});
const lost = job({
  endedAt: null,
  evaluations: { acceptance: null, acceptances: [], automatedChecks: [], verifications: [] },
  failure: 'The engine restarted while the worker ran.',
  jobId: LOST_ID,
  reservation: { evidence: null, held: true, releasedAt: null },
  result: null,
  state: 'lost',
  status: { accepted: 'pending', executed: 'unknown', verified: 'not-verified' },
  usage: null,
});
const live = job({
  endedAt: null,
  evaluations: { acceptance: null, acceptances: [], automatedChecks: [], verifications: [] },
  heartbeatAgeSeconds: 4,
  jobId: LIVE_ID,
  live: true,
  reservation: { evidence: null, held: true, releasedAt: null },
  result: null,
  state: 'running',
  status: { accepted: 'pending', executed: 'running', verified: 'not-verified' },
  usage: null,
});

const listed = (
  jobs: DelegationJobViewWire[],
  skipped = 0,
  omitted = 0,
): DelegationClientResult<DelegationJobsOutput> => ({
  data: { jobs, omitted, skipped },
  ok: true,
});

const HYDRATION_MARKER_PATTERN = /<!--[^>]*-->/g;
const html = (props: Record<string, unknown>): string =>
  render(fixture, { props: { delegations: props } })
    .body.replaceAll(HYDRATION_MARKER_PATTERN, '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll('&lt;', '<');

describe('Work delegations Svelte rendering', () => {
  test('renders finished, refused, lost and live jobs with their state, route, scope, times and problem', () => {
    const body = html({ jobs: listed([job({}), refused, lost, live], 1), mode: 'live', reference: REFERENCE });
    expect(body).toContain('<h2 class="');
    expect(body).toContain('>Delegations</h2>');
    expect(body).toContain('finished · delegation 11111111 · correctness');
    expect(body).toContain(
      'Claude Code · personal (personal) · model requested claude-opus-4-1, resolved: unknown · effort high.',
    );
    expect(body).toContain('Checkout /home/operator/src/ai-usage · commit HEAD · attempt 1.');
    // The requested revision stays as given; the scope frozen at admission is shown with whole object ids.
    expect(body).toContain(
      `Frozen scope: commit ${'b'.repeat(40)} (HEAD) against its first parent ${'c'.repeat(40)}; 1 commit.`,
    );
    expect(body).toContain('Frozen scope: none recorded; nothing was resolved for this job.');
    expect(body.match(/data-work-delegation-frozen-scope/gu)).toHaveLength(4);
    expect(body).toContain('Objective: Review the store migration for data loss.');
    expect(body).toContain('Requested 40 min ago (');
    expect(body).toContain('· started 39 min ago (');
    expect(body).toContain('· ended 35 min ago (');
    expect(body).toContain('refused · delegation 22222222');
    expect(body).toContain('No route: nothing was launched.');
    expect(body).toContain('Refused (no-admissible-route): No route is admissible for this request.');
    expect(body).toContain('contact lost; verify in the harness · delegation 33333333');
    expect(body).toContain('Failure: The engine restarted while the worker ran.');
    expect(body).toContain('Its reservation is held until release evidence is recorded');
    expect(body).toContain('running · delegation 44444444');
    expect(body).toContain('· last heartbeat 4 s ago');
    expect(body).toContain('1 stored job(s) refused on re-validation are not shown.');
    expect(body).not.toContain('Retry');
    expect(body).not.toContain('Relaunch');
  });

  test('renders executed, verified and accepted as three separate facts on every job', () => {
    const body = html({ jobs: listed([job({}), refused, lost, live]), mode: 'live', reference: REFERENCE });
    expect(body.match(/data-work-delegation-fact="executed"/gu)).toHaveLength(4);
    expect(body.match(/data-work-delegation-fact="verified"/gu)).toHaveLength(4);
    expect(body.match(/data-work-delegation-fact="accepted"/gu)).toHaveLength(4);
    expect(body).toContain('Executed: succeeded.');
    expect(body).toContain('Verified: not verified (0 by the calling model, 1 automated check).');
    expect(body).toContain('Accepted: pending — not recorded by you.');
    expect(body).toContain('Executed: not run.');
    expect(body).toContain('Executed: unknown (contact lost).');
    expect(body).toContain('Executed: running.');
  });

  test('discloses the decision, result, guarantee and usage with their provenance labels', () => {
    const body = html({ jobs: listed([job({})]), mode: 'live', reference: REFERENCE });
    expect(body).toContain('<details');
    expect(body).toContain('Decision, result, guarantee and usage');
    expect(body).toContain(
      `Qualification ${QUALIFICATION_ID} · policy revision fedcba9876543210 · catalog revision 0123456789abcdef · 1 admissible route · qualified 40 min ago`,
    );
    expect(body).toContain('declared:["m","codex","work"]: forbidden-by-rule');
    expect(body).toContain(
      `Choice: route ${ROUTE_ID} (stated by the selector, not measured); rationale: recommended for correctness; confidence 0.7 (self-reported)`,
    );
    expect(body).toContain('Result kind: review.');
    expect(body).toContain('One major finding; the rest holds.');
    expect(body).toContain(
      'major: Bound enforced after the write — The bound is enforced after the write. (src/a.ts:48)',
    );
    expect(body).toContain(
      'Reviewed: src/a.ts as given in the patch. Not reviewed: src/b.ts (omitted from the patch).',
    );
    expect(body).toContain('Limits the worker stated: the patch was truncated.');
    expect(body).toContain(
      'Scope given to the worker: 2 file(s), patch 5 KB (2 KB given, truncated); sha256 dddddddddddd.',
    );
    expect(body).toContain(
      'Ran under Claude Code 2.1.306, model claude-opus-4-1, effort high. Controls: tools Read Grep Glob; safe mode; no MCP servers. Limits: managed policy hooks still run.',
    );
    expect(body).toContain(
      'Usage as reported by the harness: input 18,000 · cached input 2,000 · output 1,200 tokens.',
    );
    expect(body).toContain('Automated check: confirmed — by an automated check (engine), 34 min ago');
    expect(body).toContain('A finished execution is not a verification.');
  });

  test('offers acceptance controls on ended jobs only and a cancel on live jobs only', () => {
    const body = html({ jobs: listed([job({}), refused, lost, live]), mode: 'live', reference: REFERENCE });
    expect(body.match(/data-work-delegation-acceptance="/gu)).toHaveLength(2);
    expect(body).toContain(`data-work-delegation-acceptance="${FINISHED_ID}"`);
    expect(body).toContain(`data-work-delegation-acceptance="${REFUSED_ID}"`);
    expect(body.match(/data-work-delegation-verdict="accepted"/gu)).toHaveLength(2);
    expect(body.match(/data-work-delegation-verdict="rejected"/gu)).toHaveLength(2);
    expect(body.match(/data-work-delegation-verdict="taken-over"/gu)).toHaveLength(2);
    expect(body).toContain(`for="work-delegation-note-${FINISHED_ID}"`);
    expect(body).toContain(`id="work-delegation-note-${FINISHED_ID}"`);
    expect(body.match(/data-work-delegation-cancel="/gu)).toHaveLength(1);
    expect(body).toContain(`data-work-delegation-cancel="${LIVE_ID}"`);
    expect(body).toContain('Cancel delegation');
    expect(body).toContain("recorded as the operator's");
  });

  test('counts the older jobs the server left out of a size-bounded list', () => {
    const body = html({ jobs: listed([job({})], 0, 7), mode: 'live', reference: REFERENCE });
    expect(body).toContain('7 older job(s) not shown; the list stays under its size bound.');
    expect(body).toContain('data-work-delegations-omitted');
    expect(html({ jobs: listed([job({})]), mode: 'live', reference: REFERENCE })).not.toContain('older job(s)');
  });

  test('states the demo, empty, unavailable and error cases', () => {
    expect(html({ mode: 'demo' })).toContain('Delegation is not available in the demo.');
    expect(html({ jobs: listed([]), mode: 'live' })).toContain(
      'No delegation yet. A delegation is started by an MCP client or the CLI (docs/delegation.md).',
    );
    expect(html({ jobs: null, mode: 'live' })).toContain('Delegations are unavailable.');
    expect(
      html({ jobs: { error: { message: 'Store is busy.', tag: 'IncompatibleStore' }, ok: false }, mode: 'live' }),
    ).toContain('Delegations unavailable (IncompatibleStore: Store is busy.)');
  });
});
