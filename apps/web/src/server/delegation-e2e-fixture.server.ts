import type {
  DelegationEvaluation,
  DelegationJob,
  DelegationQualification,
  DelegationRequest,
  FrozenDelegationScope,
  ResolvedDelegationCheckout,
} from '@ai-usage/report-core/delegation-contracts';
import { type DelegationJobView, projectDelegationJobView } from '@ai-usage/report-core/delegation-job';
import {
  delegationCatalogRevision,
  delegationPolicyRevision,
  parseDelegationConfig,
} from '@ai-usage/report-core/delegation-policy';
import { qualifyDelegation } from '@ai-usage/report-core/delegation-qualification';
import { delegationRequestDigest } from '@ai-usage/report-core/delegation-request';
import { isLiveDelegationState } from '@ai-usage/report-core/delegation-vocabulary';
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import { parseReviewTargetDeclarations } from '@ai-usage/report-core/work-attempts';
import { type ExecutorObservation, parseExecutorDeclarations } from '@ai-usage/report-core/work-executors';
import {
  DELEGATION_WEB_BOUNDS,
  type DelegationJobsInput,
  type DelegationSaveSettingsInput,
  type DelegationSaveSettingsOutput,
  type DelegationSettingsView,
  type DelegationSimulateInput,
} from '@ai-usage/web-contract/delegation';
import type { DelegationOutcome } from '../lib/server/rpc/delegation';
import { assembleDelegationSettings, type DelegationDeclarationsRead, simulationRequest } from './delegation.server';

/**
 * The e2e composition of the `delegation` namespace: deterministic data held in memory for the
 * process, run through the production assembly, projection and qualification code. The web app
 * may not import the engine or the store writer, so the only link live mode has and this one
 * lacks is the engine round trip.
 *
 * What it answers:
 * - `settings`: two declared routes on one fixture machine, Claude Code `personal` (context
 *   personal) and Codex `work` (context professional), one `forbid` rule selecting Codex for the
 *   GitHub owner `acme`, one declared model per harness, one review target `/fixture/src`. Routes
 *   come from `assembleDelegationSettings` on fixture observations and quota.
 * - `jobs` / `job`: one finished job with a structured review and one automated check, one refused
 *   job (`no-admissible-route`) and one lost job whose reservation is still held; projected with
 *   `projectDelegationJobView` at the fixed fixture time.
 * - `saveSettings`: in memory. `expectedRevision` must equal the current revision, else a conflict
 *   carrying the current one; each section is parsed by the report-core parser the engine uses and
 *   any issue refuses the write as `InvalidInput` with the issues; a write replaces the sections and
 *   the revision becomes the real `delegationPolicyRevision` of the new content.
 * - `simulate`: the real `qualifyDelegation` on the fixture declarations, config, observations and
 *   quota, for the requested checkout. A path under `/fixture/src` is admitted (facts: owner
 *   `acme`, repository `acme/fixture-app`), so Claude is admissible and Codex is forbidden by the
 *   rule; any other path is refused `checkout-not-admitted` by the qualifier.
 * - `cancel` / `recordAcceptance`: not answered here; the server says they are not available in
 *   this runtime.
 * `resetE2EDelegationFixture()` restores the initial sections (tests).
 */

export const E2E_DELEGATION_NOW = '2026-10-25T10:00:00.000Z';
const MACHINE_ID = 'fixture-machine';
const CONFIG_PATH = '/fixture/.config/ai-usage/config.json';
const REVIEW_TARGET = '/fixture/src';
const GITHUB_ACCOUNTS = [{ ghUser: 'fixture-operator', owner: 'acme' }] as const;
const CLAUDE_ROUTE_ID = 'declared:["fixture-machine","claude-code","personal"]';

export const E2E_DELEGATION_JOB_IDS = {
  finished: '11111111-1111-4111-8111-111111111111',
  lost: '33333333-3333-4333-8333-333333333333',
  refused: '22222222-2222-4222-8222-222222222222',
} as const;

const shiftMinutes = (instant: string, minutes: number): string =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();
const minutesBefore = (minutes: number): string => shiftMinutes(E2E_DELEGATION_NOW, -minutes);

interface RawSections {
  delegation: unknown;
  executors: readonly unknown[];
  reviewTargets: readonly unknown[];
}

const initialSections = (): RawSections => ({
  delegation: {
    defaults: { identityEvidence: 'declared', maxAttempts: 2, maxConcurrentPerPool: 1, reservePercent: 20 },
    models: [
      {
        alias: 'opus',
        declaredAt: '2026-10-20T08:00:00.000Z',
        discouragedFor: ['documentation'],
        harnesses: ['claude-code'],
        id: 'claude-opus',
        nativeId: 'claude-opus-4-1',
        note: 'Declared for correctness and security reviews.',
        provider: 'anthropic',
        recommendedFor: ['correctness', 'security'],
      },
      {
        declaredAt: '2026-10-20T08:00:00.000Z',
        discouragedFor: [],
        harnesses: ['codex'],
        id: 'gpt-5-codex',
        nativeId: 'gpt-5-codex',
        provider: 'openai',
        recommendedFor: ['tests'],
      },
    ],
    preferences: { harnesses: ['claude-code'], models: ['claude-opus-4-1'] },
    routes: [
      { accountScope: 'personal', context: 'personal', harness: 'claude-code', label: 'Claude · personal' },
      { accountScope: 'work', context: 'professional', harness: 'codex', label: 'Codex · work' },
    ],
    rules: [
      {
        description: 'Codex never reviews acme repositories.',
        effect: 'forbid',
        id: 'acme-no-codex',
        match: { githubOwner: 'acme' },
        routes: { harnesses: ['codex'] },
      },
    ],
  },
  executors: [
    {
      accountScope: 'personal',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: '2026-10-20T08:00:00.000Z',
      effort: 'high',
      harness: 'claude-code',
      model: 'claude-opus-4-1',
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }],
    },
    {
      accountScope: 'work',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: '2026-10-20T08:00:00.000Z',
      harness: 'codex',
      model: 'gpt-5-codex',
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }],
    },
  ],
  reviewTargets: [{ checkoutPath: REVIEW_TARGET, label: 'fixture sources' }],
});

let sections: RawSections = initialSections();

export const resetE2EDelegationFixture = (): void => {
  sections = initialSections();
};

/** The executor facts as observed a few minutes before `now`, so every decision rests on fresh facts. */
const observationsAt = (now: string): readonly ExecutorObservation[] => [
  {
    authEvidence: 'claude auth status exit 0 loggedIn=true',
    authMethod: 'claude.ai',
    authState: 'logged-in',
    binaryPath: '/fixture/bin/claude',
    harness: 'claude-code',
    machineId: MACHINE_ID,
    observedAt: shiftMinutes(now, -5),
    outcome: 'observed',
    version: '2.1.306 (Claude Code)',
  },
  {
    authEvidence: 'codex login status exit 0',
    authMethod: 'chatgpt',
    authState: 'logged-in',
    binaryPath: '/fixture/bin/codex',
    harness: 'codex',
    machineId: MACHINE_ID,
    observedAt: shiftMinutes(now, -6),
    outcome: 'observed',
    version: '0.165.0',
  },
];

const providersAt = (now: string): readonly ProviderStatus[] => [
  {
    generatedAt: shiftMinutes(now, -4),
    key: 'claude',
    label: 'Claude',
    machineId: MACHINE_ID,
    plan: 'max',
    source: 'live-api',
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: '5h',
        id: 'five_hour',
        label: '5h',
        limitSeconds: null,
        remainingPercent: 60,
        resetsAt: shiftMinutes(now, 120),
        scope: 'global',
        usedPercent: 40,
      },
    ],
  },
  {
    generatedAt: shiftMinutes(now, -4),
    key: 'codex',
    label: 'Codex',
    machineId: MACHINE_ID,
    plan: 'pro',
    source: 'live-api',
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: 'weekly',
        id: 'weekly',
        label: 'weekly',
        limitSeconds: null,
        remainingPercent: 75,
        resetsAt: shiftMinutes(now, 48 * 60),
        scope: 'global',
        usedPercent: 25,
      },
    ],
  },
];

const readDeclared = async (): Promise<DelegationDeclarationsRead> => {
  const delegation = parseDelegationConfig(sections.delegation, { defaultMachineId: MACHINE_ID });
  const executors = parseExecutorDeclarations(
    { executors: sections.executors },
    { defaultMachineId: MACHINE_ID, path: 'routing' },
  );
  const reviewTargets = parseReviewTargetDeclarations(sections.reviewTargets, { path: 'routing.reviewTargets' });
  const github = { accounts: GITHUB_ACCOUNTS.map((account) => ({ ...account, host: 'github.com' })) };
  const [policyRevision, catalogRevision] = await Promise.all([
    delegationPolicyRevision({
      delegation: sections.delegation,
      github,
      routing: { executors: sections.executors, reviewTargets: sections.reviewTargets },
    }),
    delegationCatalogRevision(delegation.config.models),
  ]);
  return {
    configPath: CONFIG_PATH,
    delegation,
    executors: { declarations: executors.declarations, issues: executors.issues },
    githubAccounts: GITHUB_ACCOUNTS,
    machineId: MACHINE_ID,
    reviewTargets: { issues: reviewTargets.issues, targets: reviewTargets.targets },
    revisions: { catalogRevision, policyRevision },
  };
};

/** A lowercase UUID derived from a digest, so a fixture qualification id is stable for its request. */
const uuidFromDigest = (digest: string): string =>
  `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;

const basename = (path: string): string =>
  path
    .split('/')
    .filter((segment) => segment.length > 0)
    .at(-1) ?? path;

const resolveCheckout = (path: string): ResolvedDelegationCheckout => ({
  admittedBy: path === REVIEW_TARGET || path.startsWith(`${REVIEW_TARGET}/`) ? REVIEW_TARGET : null,
  path,
  projectLabel: basename(path),
});

const freezeScope = (scope: DelegationRequest['scope']): FrozenDelegationScope =>
  scope.kind === 'commit'
    ? {
        base: 'first-parent',
        baseRef: null,
        baseSha: 'c'.repeat(40),
        commitCount: 1,
        headRef: scope.commit,
        headSha: 'b'.repeat(40),
        kind: 'commit',
      }
    : {
        base: 'range-base',
        baseRef: scope.base,
        baseSha: 'c'.repeat(40),
        commitCount: 3,
        headRef: scope.head,
        headSha: 'b'.repeat(40),
        kind: 'range',
      };

const qualify = async (
  request: DelegationRequest,
  purpose: DelegationQualification['purpose'],
  now: string,
): Promise<DelegationQualification> => {
  const declared = await readDeclared();
  const requestDigest = await delegationRequestDigest(request);
  return qualifyDelegation({
    checkout: resolveCheckout(request.checkout.path),
    checkoutFacts: {
      gitAuthorEmail: { provenance: 'observed', source: 'git config user.email', value: 'fixture@example.test' },
      githubAccount: { provenance: 'declared', source: 'github.accounts[owner=acme]', value: 'fixture-operator' },
      githubOwners: { provenance: 'observed', source: 'git remote -v', value: ['acme'] },
      repositories: { provenance: 'observed', source: 'git remote -v', value: ['acme/fixture-app'] },
    },
    config: declared.delegation.config,
    declarations: declared.executors.declarations,
    executorObservations: observationsAt(now),
    harnessControls: {
      'claude-code': {
        controls: ['tools Read Grep Glob', 'safe mode', 'plan mode', 'no settings sources', 'no MCP servers', 'no web'],
        limits: ['a managed policy file, if any, still applies', 'Claude Code writes its own session logs'],
      },
      codex: {
        controls: ['sandbox read-only', 'approvals never', 'no MCP servers', 'no web search'],
        limits: ['Codex writes its own session logs'],
      },
    },
    machineId: MACHINE_ID,
    now,
    providers: providersAt(now),
    purpose,
    qualificationId: uuidFromDigest(requestDigest),
    request,
    requestDigest,
    reservations: { attemptsInChain: 0, liveJobsByPool: new Map(), targetReservedBy: null },
    scope: freezeScope(request.scope),
    versions: declared.revisions,
  });
};

export const e2eDelegationSettings = async (): Promise<DelegationSettingsView> => {
  const [declared, jobs] = await Promise.all([readDeclared(), fixtureJobs()]);
  return assembleDelegationSettings({
    declared,
    jobs: jobs.map(({ job }) => job),
    now: E2E_DELEGATION_NOW,
    observations: observationsAt(E2E_DELEGATION_NOW),
    providers: providersAt(E2E_DELEGATION_NOW),
  });
};

/** Pinned to the fixture clock, not the wall clock: the same request always decides the same way. */
export const simulateE2EDelegation = (input: DelegationSimulateInput): Promise<DelegationQualification> =>
  qualify(simulationRequest(input), 'simulation', E2E_DELEGATION_NOW);

export const saveE2EDelegationSettings = async (
  input: DelegationSaveSettingsInput,
): Promise<DelegationOutcome<DelegationSaveSettingsOutput>> => {
  const current = await readDeclared();
  if (input.expectedRevision !== current.revisions.policyRevision) {
    return {
      kind: 'conflict',
      message: 'The configuration changed since it was read; re-read it and retry.',
      revision: current.revisions.policyRevision,
    };
  }
  const issues = [
    ...(input.delegation === undefined
      ? []
      : parseDelegationConfig(input.delegation, { defaultMachineId: MACHINE_ID }).issues),
    ...(input.executors === undefined
      ? []
      : parseExecutorDeclarations({ executors: input.executors }, { defaultMachineId: MACHINE_ID, path: 'routing' })
          .issues),
    ...(input.reviewTargets === undefined
      ? []
      : parseReviewTargetDeclarations(input.reviewTargets, { path: 'routing.reviewTargets' }).issues),
  ];
  if (issues.length > 0) {
    return {
      issues: issues
        .slice(0, DELEGATION_WEB_BOUNDS.maxIssues)
        .map((issue) => ({ path: issue.path, reason: issue.reason })),
      kind: 'invalid-input',
      message: 'The fixture refused the configuration; the issues name the entries by config path.',
      reason: 'invalid-configuration',
    };
  }
  sections = {
    delegation: input.delegation === undefined ? sections.delegation : input.delegation,
    executors: input.executors === undefined ? sections.executors : input.executors,
    reviewTargets: input.reviewTargets === undefined ? sections.reviewTargets : input.reviewTargets,
  };
  const next = await readDeclared();
  return { data: { issues: [], result: 'written', revision: next.revisions.policyRevision }, kind: 'ok' };
};

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

interface FixtureJob {
  readonly evaluations: readonly DelegationEvaluation[];
  readonly job: DelegationJob;
}

const finishedRequest: DelegationRequest = {
  action: 'read-only-review',
  checkout: { path: `${REVIEW_TARGET}/fixture-app` },
  client: { name: 'claude-code', sessionRef: 'fixture-session' },
  constraints: ['do not run tests'],
  criteria: ['the migration is reversible', 'every new column has a bound'],
  objective: 'Review the store migration for data loss.',
  schemaVersion: 1,
  scope: { commit: 'HEAD', kind: 'commit' },
  taskCategory: 'correctness',
};

const refusedRequest: DelegationRequest = {
  action: 'read-only-review',
  checkout: { path: `${REVIEW_TARGET}/other-app` },
  constraints: [],
  criteria: [],
  objective: 'Review the release notes.',
  schemaVersion: 1,
  scope: { base: 'main', head: 'release/1.2', kind: 'range' },
  taskCategory: 'documentation',
};

const lostRequest: DelegationRequest = {
  action: 'read-only-review',
  checkout: { path: `${REVIEW_TARGET}/fixture-app` },
  constraints: [],
  criteria: ['no secret reaches a log line'],
  objective: 'Security pass on the new logging.',
  schemaVersion: 1,
  scope: { commit: 'HEAD~1', kind: 'commit' },
  taskCategory: 'security',
};

const baseJob = (
  request: DelegationRequest,
  requestDigest: string,
  jobId: string,
  requestedAt: string,
): Omit<DelegationJob, 'state'> => ({
  accountScope: null,
  action: request.action,
  attemptNumber: 1,
  cancelRequestedAt: null,
  checkoutPath: request.checkout.path,
  context: null,
  effort: null,
  endedAt: null,
  executedScope: null,
  executorHarness: null,
  exitCode: null,
  failureReason: null,
  guarantee: null,
  harnessVersion: null,
  idempotencyKey: `fixture-${jobId.slice(0, 8)}`,
  jobId,
  launchMarker: null,
  machineId: MACHINE_ID,
  modelRequested: null,
  modelResolved: null,
  nativeSessionId: null,
  pid: null,
  poolId: null,
  qualification: null,
  qualificationId: null,
  refusalReason: null,
  releasedAt: null,
  releaseEvidence: null,
  request,
  requestDigest,
  requestedAt,
  result: null,
  retryOf: null,
  routeId: null,
  scope: null,
  selection: null,
  startedAt: null,
  taskCategory: request.taskCategory,
  traceVersion: 1,
  updatedAt: requestedAt,
  usage: null,
});

const launched = (
  job: Omit<DelegationJob, 'state'>,
  qualification: DelegationQualification,
  startedAt: string,
): Omit<DelegationJob, 'state'> => ({
  ...job,
  accountScope: 'personal',
  context: 'personal',
  effort: 'high',
  executorHarness: 'claude-code',
  harnessVersion: '2.1.306',
  launchMarker: `marker-${job.jobId.slice(0, 8)}`,
  modelRequested: 'claude-opus-4-1',
  pid: 4242,
  poolId: CLAUDE_ROUTE_ID,
  qualification,
  qualificationId: qualification.qualificationId,
  routeId: CLAUDE_ROUTE_ID,
  scope: freezeScope(job.request.scope),
  selection: {
    confidence: 0.7,
    kind: 'choice',
    qualificationId: qualification.qualificationId,
    rationale: ['declared recommended for the category', 'Codex is forbidden for this owner'],
    routeId: CLAUDE_ROUTE_ID,
    selectorVersion: 'calling-model/claude-code',
  },
  startedAt,
  updatedAt: startedAt,
});

let jobsPromise: Promise<readonly FixtureJob[]> | undefined;

const buildJobs = async (): Promise<readonly FixtureJob[]> => {
  const [finishedDigest, refusedDigest, lostDigest] = await Promise.all([
    delegationRequestDigest(finishedRequest),
    delegationRequestDigest(refusedRequest),
    delegationRequestDigest(lostRequest),
  ]);
  const finishedQualification = await qualify(finishedRequest, 'delegation', minutesBefore(40));
  const lostQualification = await qualify(lostRequest, 'delegation', minutesBefore(25));
  const finishedStart = minutesBefore(39);
  const finished: DelegationJob = {
    ...launched(
      baseJob(finishedRequest, finishedDigest, E2E_DELEGATION_JOB_IDS.finished, minutesBefore(40)),
      finishedQualification,
      finishedStart,
    ),
    endedAt: minutesBefore(35),
    executedScope: {
      fileCount: 3,
      files: [
        { coverage: 'complete', path: 'packages/usage-store/src/migration.ts' },
        { coverage: 'complete', path: 'packages/usage-store/src/migration.test.ts' },
        { coverage: 'omitted', path: 'docs/local-store-upgrade.md' },
      ],
      includedBytes: 6144,
      patchBytes: 9216,
      patchSha256: 'd'.repeat(64),
      truncated: true,
      workingTreeDirty: false,
    },
    exitCode: 0,
    guarantee: {
      cliVersion: '2.1.306',
      controls: ['tools Read Grep Glob', 'safe mode', 'plan mode', 'no settings sources', 'no MCP servers', 'no web'],
      effort: 'high',
      harness: 'claude-code',
      limits: ['a managed policy file, if any, still applies', 'Claude Code writes its own session logs'],
      model: 'claude-opus-4-1',
    },
    modelResolved: 'claude-opus-4-1-20260901',
    nativeSessionId: 'fixture-native-session-1',
    result: {
      excerpt: null,
      kind: 'review',
      review: {
        checks: ['read the migration and its test', 'compared the column bounds with the writer'],
        coverage: {
          notReviewed: ['docs/local-store-upgrade.md (omitted from the patch)'],
          reviewed: 'The migration module and its test, as given in the patch.',
        },
        findings: [
          {
            detail: 'The new column is written before its bound is enforced; a row above the bound is persisted.',
            evidence: [{ line: 48, path: 'packages/usage-store/src/migration.ts' }],
            severity: 'major',
            title: 'Bound enforced after the write',
          },
          {
            detail: 'The test names the reversible path but never runs the down migration.',
            evidence: [{ line: 112, path: 'packages/usage-store/src/migration.test.ts' }],
            severity: 'minor',
            title: 'Reversibility untested',
          },
        ],
        limits: ['the documentation file was not in the patch'],
        summary: 'One major and one minor finding; the migration is reversible in code but not proven by its test.',
      },
    },
    state: 'finished',
    updatedAt: minutesBefore(35),
    usage: { cachedInputTokens: 2000, inputTokens: 18_000, outputTokens: 1200, source: 'harness-reported' },
  };
  const refused: DelegationJob = {
    ...baseJob(refusedRequest, refusedDigest, E2E_DELEGATION_JOB_IDS.refused, minutesBefore(30)),
    endedAt: minutesBefore(30),
    failureReason:
      'No route is admissible for this request: Codex is forbidden by rule acme-no-codex and Claude Code has no declared model for documentation.',
    refusalReason: 'no-admissible-route',
    state: 'refused',
  };
  const lost: DelegationJob = {
    ...launched(
      baseJob(lostRequest, lostDigest, E2E_DELEGATION_JOB_IDS.lost, minutesBefore(25)),
      lostQualification,
      minutesBefore(24),
    ),
    failureReason: 'The engine restarted while the worker ran; no outcome was recorded.',
    nativeSessionId: 'fixture-native-session-2',
    state: 'lost',
    updatedAt: minutesBefore(20),
  };
  const check: DelegationEvaluation = {
    author: 'automated-check',
    authorLabel: 'engine',
    checks: ['final message parsed as the review contract'],
    evaluationId: '44444444-4444-4444-8444-444444444444',
    jobId: finished.jobId,
    kind: 'verification',
    note: null,
    recordedAt: minutesBefore(35),
    verdict: 'confirmed',
  };
  return [
    { evaluations: [check], job: finished },
    { evaluations: [], job: refused },
    { evaluations: [], job: lost },
  ];
};

const fixtureJobs = (): Promise<readonly FixtureJob[]> => {
  jobsPromise ??= buildJobs();
  return jobsPromise;
};

const toView = ({ evaluations, job }: FixtureJob): DelegationJobView =>
  projectDelegationJobView(job, evaluations, { now: E2E_DELEGATION_NOW });

export const e2eDelegationJobs = async (
  input: DelegationJobsInput,
): Promise<{ readonly jobs: readonly DelegationJobView[]; readonly skipped: number }> => {
  const jobs = (await fixtureJobs())
    .filter(({ job }) => !input.liveOnly || isLiveDelegationState(job.state))
    .slice(0, Math.min(input.limit ?? DELEGATION_WEB_BOUNDS.defaultListLimit, DELEGATION_WEB_BOUNDS.maxListLimit))
    .map(toView);
  return { jobs, skipped: 0 };
};

export const e2eDelegationJob = async (jobId: string): Promise<DelegationJobView | null> => {
  const match = (await fixtureJobs()).find(({ job }) => job.jobId === jobId);
  return match === undefined ? null : toView(match);
};
