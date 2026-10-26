import type { DelegationConfig, DelegationQualification } from '@ai-usage/report-core/delegation-contracts';
import type { ExecutorDeclaration } from '@ai-usage/report-core/work-executors';
import type { DelegationRouteStatus, DelegationSettingsView } from './delegation-contract';

/**
 * One settings view with every state the page must word carefully: a route without a declared
 * context, a pinned account the CLI contradicts, a Codex identity that is not observable, a stale
 * quota reading, a model observed under another resolved version. Shared by the render tests and
 * the browser fixtures; nothing here is read from a real store. The constants are inferred (with
 * `satisfies`) so they fit both the wire view and the report-core domain types.
 */

export const SYNTHETIC_NOW = '2026-10-25T10:00:00.000Z';
const MACHINE = 'synthetic-machine';
const CLAUDE_PIN = 'a1b2c3d4e5f60718';
const CLAUDE_OBSERVED = 'f0e1d2c3b4a59687';

export const SYNTHETIC_CLAUDE_DECLARATION = {
  accountFingerprint: CLAUDE_PIN,
  accountScope: 'personal',
  alternateModels: ['claude-sonnet-4-5'],
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-20T08:00:00.000Z',
  effort: 'high',
  harness: 'claude-code',
  machineId: MACHINE,
  model: 'claude-opus-4-1',
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'project', projectLabel: 'ai-usage' }],
} satisfies ExecutorDeclaration;

export const SYNTHETIC_CODEX_DECLARATION = {
  accountScope: 'work',
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T09:00:00.000Z',
  effort: 'medium',
  harness: 'codex',
  machineId: MACHINE,
  model: 'gpt-5-codex',
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
} satisfies ExecutorDeclaration;

const opusEntry = {
  alias: 'Opus 4.1',
  declaredAt: '2026-10-19T07:00:00.000Z',
  discouragedFor: ['documentation'],
  harnesses: ['claude-code'],
  id: 'claude-opus-4-1',
  nativeId: 'claude-opus-4-1',
  note: null,
  provider: 'anthropic',
  recommendedFor: ['correctness', 'security'],
  resolvedVersion: 'claude-opus-4-1-20250805',
} satisfies DelegationConfig['models'][number];

/** The `delegation` section as the parser returns it (a route annotation carries the resolved machine). */
export const SYNTHETIC_DELEGATION_CONFIG = {
  defaults: {
    identityEvidence: 'declared',
    maxAttempts: 2,
    maxConcurrentPerPool: 1,
    qualificationTtlSeconds: 600,
    reservePercent: 20,
  },
  models: [opusEntry],
  preferences: { harnesses: ['claude-code'], models: ['claude-opus-4-1'], nearResetMinutes: null },
  routes: [
    {
      accountScope: 'personal',
      context: 'personal',
      harness: 'claude-code',
      label: 'Personal Claude',
      machineId: MACHINE,
      reservePercent: 30,
    },
  ],
  rules: [
    {
      description: 'Work repositories only run on professional routes.',
      effect: 'restrict',
      id: 'work-repos-professional',
      match: { githubOwner: 'acme' },
      routes: { contexts: ['professional'] },
    },
    {
      effect: 'require',
      id: 'observed-identity-everywhere',
      match: {},
      require: { identityEvidence: 'observed' },
    },
  ],
} satisfies DelegationConfig;

const claudeRoute = (model: string, routeId: string): DelegationRouteStatus => ({
  accountScope: 'personal',
  availability: {
    authMethod: 'claude.ai',
    authState: 'logged-in',
    observedAt: '2026-10-25T09:58:00.000Z',
    provenance: 'observed-now',
    state: 'available',
    version: '2.1.0',
  },
  context: 'personal',
  effort: 'high',
  harness: 'claude-code',
  identity: {
    declared: CLAUDE_PIN,
    observed: CLAUDE_OBSERVED,
    observedAt: '2026-10-25T09:58:00.000Z',
    state: 'contradicted',
  },
  label: `Personal Claude · ${model}`,
  lastCheckedAt: '2026-10-25T09:58:00.000Z',
  missing: [],
  model,
  poolId: `${MACHINE}/claude-code/personal`,
  provider: 'anthropic',
  quota: {
    observedAt: '2026-10-25T09:55:00.000Z',
    provenance: 'observed-now',
    windows: [
      { label: '5h', remainingPercent: 60, resetsAt: '2026-10-25T13:00:00.000Z', scope: 'account' },
      { label: 'weekly', remainingPercent: 80, resetsAt: '2026-10-29T00:00:00.000Z', scope: 'account' },
    ],
  },
  routeId,
  subscription: 'verified',
});

const codexRoute: DelegationRouteStatus = {
  accountScope: 'work',
  availability: {
    authMethod: 'chatgpt',
    authState: 'logged-in',
    observedAt: '2026-10-24T20:00:00.000Z',
    provenance: 'stale',
    state: 'available',
    version: '0.52.0',
  },
  context: null,
  effort: 'medium',
  harness: 'codex',
  identity: { declared: null, observed: null, observedAt: null, state: 'not-observable' },
  label: 'codex/work · gpt-5-codex',
  lastCheckedAt: '2026-10-24T20:00:00.000Z',
  missing: [
    'Declare a context for codex/work in delegation.routes[] (professional or personal).',
    'Refresh the Codex quota observation; the last reading is from 2026-10-24T20:00:00.000Z.',
  ],
  model: 'gpt-5-codex',
  poolId: `${MACHINE}/codex/work`,
  provider: 'openai',
  quota: {
    observedAt: '2026-10-24T20:00:00.000Z',
    provenance: 'stale',
    windows: [
      { label: '5h', remainingPercent: 35, resetsAt: '2026-10-25T00:30:00.000Z', scope: 'account' },
      { label: 'weekly', remainingPercent: 70, resetsAt: null, scope: 'account' },
    ],
  },
  routeId: `${MACHINE}/codex/work/gpt-5-codex`,
  subscription: 'verified',
};

export const SYNTHETIC_DELEGATION_SETTINGS: DelegationSettingsView = {
  catalogRevision: 'catalog0000000001',
  configPath: '/home/operator/.config/ai-usage/config.json',
  delegation: { config: SYNTHETIC_DELEGATION_CONFIG, issues: [] },
  executors: { declarations: [SYNTHETIC_CLAUDE_DECLARATION, SYNTHETIC_CODEX_DECLARATION], issues: [] },
  githubAccounts: [{ ghUser: 'operator-acme', owner: 'acme' }],
  harnesses: [
    {
      caller: 'Any MCP client can be a caller.',
      executor: 'supported',
      harness: 'claude-code',
      reason: 'Launches `claude` with Read, Grep and Glob tools, plan mode and no MCP servers.',
    },
    {
      caller: 'Any MCP client can be a caller.',
      executor: 'supported',
      harness: 'codex',
      reason: 'Launches `codex exec --sandbox read-only` with approvals off and no MCP servers.',
    },
    {
      caller: 'Any MCP client can be a caller.',
      executor: 'not-supported',
      harness: 'opencode',
      reason: 'executor not supported in this version — no per-invocation read-only mode',
    },
    {
      caller: 'Any MCP client can be a caller.',
      executor: 'not-supported',
      harness: 'cursor',
      reason: 'executor not supported in this version — no per-invocation read-only mode',
    },
  ],
  machineId: MACHINE,
  models: [
    {
      entry: opusEntry,
      observed: { jobs: 3, lastSeenAt: '2026-10-24T18:00:00.000Z', modelResolved: 'claude-opus-4-1-20250805' },
    },
  ],
  observedModels: [
    {
      harness: 'claude-code',
      jobs: 3,
      lastSeenAt: '2026-10-24T18:00:00.000Z',
      modelRequested: 'claude-opus-4-1',
      modelResolved: 'claude-opus-4-1-20250805',
    },
    {
      harness: 'codex',
      jobs: 1,
      lastSeenAt: '2026-10-23T11:00:00.000Z',
      modelRequested: 'gpt-5-codex',
      modelResolved: null,
    },
  ],
  revision: 'policy00000000a1',
  reviewTargets: { issues: [], targets: [{ checkoutPath: '/home/operator/src/ai-usage', label: 'ai-usage' }] },
  routes: [
    claudeRoute('claude-opus-4-1', `${MACHINE}/claude-code/personal/claude-opus-4-1`),
    claudeRoute('claude-sonnet-4-5', `${MACHINE}/claude-code/personal/claude-sonnet-4-5`),
    codexRoute,
  ],
};

export const SYNTHETIC_DELEGATION_QUALIFICATION: DelegationQualification = {
  admissibleRouteIds: [`${MACHINE}/claude-code/personal/claude-opus-4-1`],
  appliedRules: [
    {
      applies: 'assumed',
      effect: 'restrict',
      id: 'work-repos-professional',
      reason: 'assumed to apply: githubOwner unknown',
    },
    {
      applies: 'yes',
      effect: 'require',
      id: 'observed-identity-everywhere',
      reason: 'applies everywhere (no match condition)',
    },
  ],
  assumptions: [
    'The checkout has no github.com remote, so the GitHub owner is unknown; rule work-repos-professional is assumed to apply.',
  ],
  checkout: {
    admittedBy: '/home/operator/src/ai-usage',
    path: '/home/operator/src/ai-usage',
    projectLabel: 'ai-usage',
  },
  checkoutFacts: {
    gitAuthorEmail: { provenance: 'observed', source: 'git config user.email', value: 'operator@example.com' },
    githubAccount: { provenance: 'unknown', source: 'github.accounts[]', value: null },
    githubOwners: { provenance: 'observed', source: 'git remote -v', value: [] },
    repositories: { provenance: 'observed', source: 'git remote -v', value: [] },
  },
  omittedRoutes: 0,
  outcome: 'routes-available',
  purpose: 'simulation',
  qualificationId: '0199f179-4837-7000-8000-00000000c0de',
  qualifiedAt: SYNTHETIC_NOW,
  refusal: null,
  request: { action: 'read-only-review', digest: 'd1gest00', taskCategory: 'correctness' },
  routes: [
    {
      accountScope: 'personal',
      admissible: true,
      advantages: [
        'Declared as recommended for correctness (operator declaration).',
        'Reserve satisfied: 60% of 5h remains.',
      ],
      blockers: [],
      context: 'personal',
      effort: 'high',
      exclusions: [],
      harness: 'claude-code',
      identity: { declared: CLAUDE_PIN, observed: CLAUDE_OBSERVED, state: 'contradicted' },
      label: 'Personal Claude · claude-opus-4-1',
      limits: ['Identity evidence is declared only: the observed account differs from the pin.'],
      liveJobsInPool: 0,
      missing: [],
      model: 'claude-opus-4-1',
      orderHint: 0,
      poolId: `${MACHINE}/claude-code/personal`,
      provider: 'anthropic',
      quota: [
        {
          label: '5h',
          observedAt: '2026-10-25T09:55:00.000Z',
          remainingPercent: 60,
          resetsAt: '2026-10-25T13:00:00.000Z',
          scope: 'account',
        },
      ],
      requirements: { identityEvidence: 'observed', maxAttempts: 2, maxConcurrent: 1, reservePercent: 30 },
      routeId: `${MACHINE}/claude-code/personal/claude-opus-4-1`,
    },
    {
      accountScope: 'work',
      admissible: false,
      advantages: [],
      blockers: ['context-undeclared', 'identity-evidence', 'quota'],
      context: null,
      effort: 'medium',
      exclusions: [
        'No context is declared for codex/work in delegation.routes[]; a route without a context is never admissible.',
        'Rule observed-identity-everywhere requires an observed identity; Codex reports none.',
        'The quota reading is stale (observed 2026-10-24T20:00:00.000Z).',
      ],
      harness: 'codex',
      identity: null,
      label: 'codex/work · gpt-5-codex',
      limits: [],
      liveJobsInPool: 0,
      missing: ['Refresh the Codex quota observation.'],
      model: 'gpt-5-codex',
      orderHint: null,
      poolId: `${MACHINE}/codex/work`,
      provider: 'openai',
      quota: [
        {
          label: '5h',
          observedAt: '2026-10-24T20:00:00.000Z',
          remainingPercent: 35,
          resetsAt: '2026-10-25T00:30:00.000Z',
          scope: 'account',
        },
      ],
      requirements: { identityEvidence: 'observed', maxAttempts: 2, maxConcurrent: 1, reservePercent: 20 },
      routeId: `${MACHINE}/codex/work/gpt-5-codex`,
    },
  ],
  schemaVersion: 1,
  scope: {
    base: 'range-base',
    baseRef: 'main',
    baseSha: '1111111111111111111111111111111111111111',
    commitCount: 3,
    headRef: 'HEAD',
    headSha: '2222222222222222222222222222222222222222',
    kind: 'range',
  },
  validUntil: '2026-10-25T10:10:00.000Z',
  versions: {
    catalogRevision: 'catalog0000000001',
    policyRevision: 'policy00000000a1',
    qualifier: 'delegation-qualifier/1',
    selectorContract: 'delegation-selection/1',
  },
};
