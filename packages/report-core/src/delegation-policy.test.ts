import { describe, expect, test } from 'bun:test';
import type {
  DelegationAppliedRule,
  DelegationCheckoutFacts,
  DelegationRouteAnnotation,
  DelegationRule,
} from './delegation-contracts';
import {
  CONTEXT_UNDECLARED_EXCLUSION,
  DEFAULT_DELEGATION_CONFIG,
  DEFAULT_DELEGATION_DEFAULTS,
  DELEGATION_CONFIG_BOUNDS,
  delegationCatalogRevision,
  delegationPolicyRevision,
  evaluateDelegationRules,
  evaluateRoutePolicy,
  isDelegationConfigShape,
  parseDelegationConfig,
  routeMatchesSelector,
} from './delegation-policy';

const MACHINE = 'machine-a';
const REVISION_HEX = /^[0-9a-f]{16}$/u;
const parse = (value: unknown, defaultMachineId: string | null = MACHINE) =>
  parseDelegationConfig(value, { defaultMachineId });

const route = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  harness: 'claude-code',
  accountScope: 'personal',
  context: 'personal',
  ...overrides,
});
const rule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'no-work-on-personal',
  effect: 'forbid',
  match: { githubOwner: 'acme' },
  routes: { contexts: ['personal'] },
  ...overrides,
});
const model = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'opus',
  provider: 'anthropic',
  nativeId: 'claude-opus-4-1',
  harnesses: ['claude-code'],
  recommendedFor: ['correctness'],
  discouragedFor: ['documentation'],
  declaredAt: '2026-10-20T08:00:00Z',
  ...overrides,
});

describe('parseDelegationConfig', () => {
  test('an absent section is the defaults; a wrong shape is reported and still yields the defaults', () => {
    expect(parse(undefined)).toEqual({ config: DEFAULT_DELEGATION_CONFIG, issues: [] });
    expect(DEFAULT_DELEGATION_DEFAULTS).toEqual({
      identityEvidence: 'declared',
      maxAttempts: 2,
      maxConcurrentPerPool: 1,
      qualificationTtlSeconds: 600,
      reservePercent: 20,
    });
    const wrong = parse(['not', 'an', 'object']);
    expect(wrong.config).toEqual(DEFAULT_DELEGATION_CONFIG);
    expect(wrong.issues.map((issue) => issue.path)).toEqual(['delegation']);
    expect(parse({ routes: {} }).issues.map((issue) => issue.path)).toEqual(['delegation']);
    expect(parse({ secret: 1 }).issues.map((issue) => issue.path)).toEqual(['delegation']);
  });

  test('isDelegationConfigShape gates the keys and the list/map kinds only', () => {
    expect(isDelegationConfigShape({})).toBe(true);
    expect(isDelegationConfigShape({ defaults: {}, routes: [], rules: [], preferences: {}, models: [] })).toBe(true);
    expect(isDelegationConfigShape({ routes: 'all' })).toBe(false);
    expect(isDelegationConfigShape({ defaults: [] })).toBe(false);
    expect(isDelegationConfigShape({ executors: [] })).toBe(false);
    expect(isDelegationConfigShape(null)).toBe(false);
  });

  test('defaults are read field by field; an invalid field keeps its default and is located', () => {
    const { config, issues } = parse({
      defaults: { reservePercent: 35, maxConcurrentPerPool: 9, maxAttempts: 3, identityEvidence: 'sworn', extra: 1 },
    });
    expect(config.defaults).toEqual({ ...DEFAULT_DELEGATION_DEFAULTS, maxAttempts: 3, reservePercent: 35 });
    expect(issues).toEqual([
      { path: 'delegation.defaults', reason: 'unknown field(s): extra' },
      { path: 'delegation.defaults.identityEvidence', reason: "must be 'declared', 'observed'" },
      { path: 'delegation.defaults.maxConcurrentPerPool', reason: 'must be an integer between 1 and 8' },
    ]);
    expect(parse({ defaults: { reservePercent: 91 } }).issues[0]?.path).toBe('delegation.defaults.reservePercent');
    expect(parse({ defaults: { qualificationTtlSeconds: 59 } }).issues[0]?.path).toBe(
      'delegation.defaults.qualificationTtlSeconds',
    );
  });

  test('routes: an invalid entry is located without its value, neighbours survive, duplicates keep the first', () => {
    const { config, issues } = parse({
      routes: [
        route(),
        route({ harness: 'cursor', accountScope: 'SECRET-VALUE' }),
        route({ accountScope: 'work', context: 'professional', label: 'Work', reservePercent: 40, maxConcurrent: 2 }),
        route({ context: 'professional' }),
        route({ accountScope: 'work', context: 'professional', machineId: 'machine-b' }),
      ],
    });
    expect(config.routes).toEqual([
      { accountScope: 'personal', context: 'personal', harness: 'claude-code', machineId: MACHINE },
      {
        accountScope: 'work',
        context: 'professional',
        harness: 'claude-code',
        label: 'Work',
        machineId: MACHINE,
        maxConcurrent: 2,
        reservePercent: 40,
      },
      { accountScope: 'work', context: 'professional', harness: 'claude-code', machineId: 'machine-b' },
    ]);
    expect(issues).toEqual([
      { path: 'delegation.routes[1].harness', reason: "must be 'claude-code', 'codex'" },
      {
        path: 'delegation.routes[3]',
        reason: 'duplicates routes[0] (same machineId, harness and accountScope); ignored',
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain('SECRET-VALUE');
    expect(parse({ routes: [route()] }, null).issues).toEqual([
      { path: 'delegation.routes[0].machineId', reason: 'is required because no local machine identity is known' },
    ]);
  });

  test('rules: strict keys, id pattern, match conditions, selectors and requirements', () => {
    const { config, issues } = parse({
      rules: [
        rule(),
        rule({ id: 'Bad Id' }),
        rule({
          id: 'restrict-work',
          effect: 'restrict',
          match: { repository: 'acme/platform' },
          routes: { contexts: ['professional'] },
        }),
        rule({
          id: 'need-observed',
          effect: 'require',
          match: {},
          routes: undefined,
          require: { identityEvidence: 'observed', reservePercent: 50 },
        }),
        rule({ id: 'no-require', effect: 'require', match: {} }),
        rule({ id: 'forbid-with-require', require: { maxAttempts: 1 } }),
        rule({ id: 'bad-match', match: { repository: 'acme', checkoutPath: 'relative' } }),
        rule({ id: 'bad-selector', routes: { providers: ['google'] } }),
        rule({ id: 'everywhere', match: undefined, routes: undefined }),
        rule(),
      ],
    });
    expect(config.rules.map((entry) => entry.id)).toEqual([
      'no-work-on-personal',
      'restrict-work',
      'need-observed',
      'everywhere',
    ]);
    expect(config.rules[2]).toEqual({
      effect: 'require',
      id: 'need-observed',
      match: {},
      require: { identityEvidence: 'observed', reservePercent: 50 },
    });
    expect(config.rules[3]).toEqual({ effect: 'forbid', id: 'everywhere', match: {} });
    expect(issues.map((issue) => issue.path)).toEqual([
      'delegation.rules[1].id',
      'delegation.rules[4].require',
      'delegation.rules[5].require',
      'delegation.rules[6].match.checkoutPath',
      'delegation.rules[6].match.repository',
      'delegation.rules[7].routes.providers[0]',
      'delegation.rules[9]',
    ]);
    expect(issues.at(-1)?.reason).toBe('duplicates rules[0] (same id); ignored');
  });

  test('preferences and models are bounded and dated; a category cannot be both recommended and discouraged', () => {
    const { config, issues } = parse({
      preferences: {
        models: ['claude-opus-4-1', 'claude-opus-4-1', 'gpt-5-codex'],
        harnesses: ['claude-code'],
        nearResetMinutes: 45,
      },
      models: [
        model(),
        model({ id: 'both', recommendedFor: ['tests'], discouragedFor: ['tests'] }),
        model({ id: 'undated', declaredAt: 'yesterday' }),
        model({
          id: 'gpt',
          provider: 'openai',
          nativeId: 'gpt-5-codex',
          harnesses: ['codex'],
          resolvedVersion: null,
          note: 'n',
        }),
      ],
    });
    expect(config.preferences).toEqual({
      harnesses: ['claude-code'],
      models: ['claude-opus-4-1', 'gpt-5-codex'],
      nearResetMinutes: 45,
    });
    expect(config.models.map((entry) => entry.id)).toEqual(['opus', 'gpt']);
    expect(config.models[0]).toEqual({
      alias: null,
      declaredAt: '2026-10-20T08:00:00.000Z',
      discouragedFor: ['documentation'],
      harnesses: ['claude-code'],
      id: 'opus',
      nativeId: 'claude-opus-4-1',
      note: null,
      provider: 'anthropic',
      recommendedFor: ['correctness'],
      resolvedVersion: null,
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'delegation.models[1].discouragedFor',
      'delegation.models[2].declaredAt',
    ]);
    expect(parse({ preferences: { nearResetMinutes: 0 } }).issues[0]?.path).toBe(
      'delegation.preferences.nearResetMinutes',
    );
    expect(parse({ preferences: { nearResetMinutes: null } }).config.preferences.nearResetMinutes).toBeNull();
  });

  test('list bounds are judged before the elements', () => {
    const oversize = Array.from({ length: DELEGATION_CONFIG_BOUNDS.maxRoutes + 1 }, () => route());
    const { config, issues } = parse({ routes: oversize });
    expect(config.routes).toHaveLength(1);
    expect(issues.at(-1)).toEqual({
      path: `delegation.routes[${DELEGATION_CONFIG_BOUNDS.maxRoutes}]`,
      reason: `exceeds the ${DELEGATION_CONFIG_BOUNDS.maxRoutes}-entry bound; ignored`,
    });
    const manyModels = Array.from({ length: DELEGATION_CONFIG_BOUNDS.maxListEntries + 1 }, () => ({ bad: true }));
    expect(parse({ preferences: { models: manyModels } }).issues).toEqual([
      {
        path: 'delegation.preferences.models',
        reason: `must list at most ${DELEGATION_CONFIG_BOUNDS.maxListEntries} entries`,
      },
    ]);
  });
});

describe('revisions', () => {
  test('policy and catalog revisions are 16 hex characters of canonical JSON with null for absent sections', async () => {
    const revision = await delegationPolicyRevision({
      routing: { executors: [] },
      delegation: { rules: [] },
      github: undefined,
    });
    expect(revision).toMatch(REVISION_HEX);
    expect(
      await delegationPolicyRevision({ routing: { executors: [] }, delegation: { rules: [] }, github: null }),
    ).toBe(revision);
    expect(
      await delegationPolicyRevision({ delegation: { rules: [] }, github: undefined, routing: { executors: [] } }),
    ).toBe(revision);
    expect(
      await delegationPolicyRevision({
        routing: { executors: [] },
        delegation: { rules: [{ id: 'x' }] },
        github: undefined,
      }),
    ).not.toBe(revision);
    const catalog = await delegationCatalogRevision([{ id: 'opus', nativeId: 'x' }]);
    expect(catalog).toMatch(REVISION_HEX);
    expect(await delegationCatalogRevision([{ nativeId: 'x', id: 'opus' }])).toBe(catalog);
    expect(await delegationCatalogRevision(undefined)).toBe(await delegationCatalogRevision(null));
  });
});

describe('evaluateDelegationRules', () => {
  const facts = (overrides: Partial<DelegationCheckoutFacts> = {}): DelegationCheckoutFacts => ({
    gitAuthorEmail: { provenance: 'observed', source: 'git config user.email', value: 'dev@example.test' },
    githubAccount: { provenance: 'declared', source: 'github.accounts[owner=acme]', value: 'dev-acme' },
    githubOwners: { provenance: 'observed', source: 'git remote -v', value: ['acme'] },
    repositories: { provenance: 'observed', source: 'git remote -v', value: ['acme/platform'] },
    ...overrides,
  });
  const forbid: DelegationRule = { effect: 'forbid', id: 'f', match: { githubOwner: 'ACME' } };
  const checkoutPath = '/home/operator/work/platform';

  test('a rule applies when every given condition holds, case-insensitively, and path prefixes respect segments', () => {
    const rules: DelegationRule[] = [
      forbid,
      { effect: 'restrict', id: 'r', match: { repository: 'Acme/Platform', checkoutPath: '/home/operator/work' } },
      { effect: 'require', id: 'q', match: { checkoutPath: '/home/operator/wor' }, require: { maxAttempts: 1 } },
      { effect: 'forbid', id: 'other', match: { githubAccount: 'someone-else' } },
      { effect: 'forbid', id: 'email', match: { gitAuthorEmail: 'DEV@example.test' } },
      { effect: 'forbid', id: 'all', match: {} },
    ];
    const { applied, assumptions } = evaluateDelegationRules({ checkoutPath, facts: facts(), rules });
    expect(applied).toEqual([
      { applies: 'yes', effect: 'forbid', id: 'f', reason: 'matches githubOwner ACME' },
      {
        applies: 'yes',
        effect: 'restrict',
        id: 'r',
        reason: 'matches checkoutPath under /home/operator/work, repository Acme/Platform',
      },
      { applies: 'yes', effect: 'forbid', id: 'email', reason: 'matches gitAuthorEmail DEV@example.test' },
      { applies: 'yes', effect: 'forbid', id: 'all', reason: 'applies everywhere (no match condition)' },
    ]);
    expect(assumptions).toEqual([]);
  });

  test('an unknown fact fails closed: the rule is assumed to apply and the assumption is reported', () => {
    const unknownFacts = facts({
      githubOwners: { provenance: 'unknown', source: 'git remote -v', value: null },
      githubAccount: { provenance: 'unknown', source: 'github.accounts[]', value: null },
    });
    const { applied, assumptions } = evaluateDelegationRules({
      checkoutPath,
      facts: unknownFacts,
      rules: [forbid, { effect: 'restrict', id: 'r', match: { githubAccount: 'x', repository: 'other/repo' } }],
    });
    // The restrict has a known false condition (repository), so it does not apply at all.
    expect(applied).toEqual([
      {
        applies: 'assumed',
        effect: 'forbid',
        id: 'f',
        reason: 'assumed to apply: githubOwner (git remote -v) unknown',
      },
    ]);
    expect(assumptions).toEqual([
      'Rule f (forbid) is assumed to apply because githubOwner (git remote -v) is unknown; a known fact that contradicts it would lift the rule.',
    ]);
  });

  test('a partly identified list fact: a match applies the rule; no match fails closed and says why', () => {
    const source = 'git remote -v (1 of 3 remote URLs not identified)';
    const partialFacts = facts({
      githubOwners: { provenance: 'partial', source, value: ['someone'] },
      repositories: { provenance: 'partial', source, value: ['someone/platform', 'acme/platform'] },
    });
    const { applied, assumptions } = evaluateDelegationRules({
      checkoutPath,
      facts: partialFacts,
      rules: [
        forbid,
        { effect: 'restrict', id: 'r', match: { repository: 'ACME/platform' } },
        { effect: 'forbid', id: 'elsewhere', match: { checkoutPath: '/elsewhere', githubOwner: 'nobody' } },
      ],
    });
    // `f` finds no `acme` among the identified owners, but an unidentified remote might be one: assumed.
    // `r` matches an identified repository: it applies outright. `elsewhere` has a known false path.
    expect(applied).toEqual([
      {
        applies: 'assumed',
        effect: 'forbid',
        id: 'f',
        reason: `assumed to apply: githubOwner (${source}) partly identified`,
      },
      { applies: 'yes', effect: 'restrict', id: 'r', reason: 'matches repository ACME/platform' },
    ]);
    expect(assumptions).toEqual([
      `Rule f (forbid) is assumed to apply because githubOwner (${source}) is only partly identified; a known fact that contradicts it would lift the rule.`,
    ]);
  });
});

describe('evaluateRoutePolicy', () => {
  const annotation: DelegationRouteAnnotation = {
    accountScope: 'personal',
    context: 'personal',
    harness: 'claude-code',
    machineId: MACHINE,
  };
  const policyRoute = {
    accountScope: 'personal',
    context: 'personal',
    harness: 'claude-code',
    provider: 'anthropic',
  } as const;
  const applied = (...rules: DelegationRule[]): DelegationAppliedRule[] =>
    rules.map((entry) => ({ applies: 'yes', effect: entry.effect, id: entry.id, reason: 'matches' }));
  const evaluate = (rules: DelegationRule[], overrides: Partial<Parameters<typeof evaluateRoutePolicy>[0]> = {}) =>
    evaluateRoutePolicy({
      annotation,
      applied: applied(...rules),
      defaults: DEFAULT_DELEGATION_DEFAULTS,
      route: policyRoute,
      rules,
      ...overrides,
    });

  test('(1) a route without a declared context is excluded before anything else', () => {
    const undeclared = evaluate([], { annotation: null, route: { ...policyRoute, context: null } });
    expect(undeclared.blockers).toEqual(['context-undeclared']);
    expect(undeclared.exclusions).toEqual([CONTEXT_UNDECLARED_EXCLUSION]);
    expect(evaluate([]).blockers).toEqual([]);
  });

  test('(2) an applying forbid that selects the route excludes it, whatever else prefers it', () => {
    const forbid: DelegationRule = {
      effect: 'forbid',
      id: 'no-personal',
      match: {},
      routes: { contexts: ['personal'] },
    };
    const result = evaluate([forbid]);
    expect(result.blockers).toEqual(['forbidden-by-rule']);
    expect(result.exclusions).toEqual(['Forbidden by rule no-personal']);
    const elsewhere: DelegationRule = { ...forbid, routes: { harnesses: ['codex'] } };
    expect(evaluate([elsewhere]).blockers).toEqual([]);
    const described: DelegationRule = { ...forbid, description: 'Client code stays on the work account' };
    expect(evaluate([described]).exclusions).toEqual([
      'Forbidden by rule no-personal (Client code stays on the work account)',
    ]);
  });

  test('(3) every applying restrict must select the route; disjoint restricts are incompatible for every route', () => {
    const toWork: DelegationRule = {
      effect: 'restrict',
      id: 'work-only',
      match: {},
      routes: { contexts: ['professional'] },
    };
    const outside = evaluate([toWork]);
    expect(outside.blockers).toEqual(['outside-restriction']);
    expect(outside.exclusions).toEqual(['Outside the restriction of rule work-only']);
    const toPersonal: DelegationRule = {
      effect: 'restrict',
      id: 'personal-only',
      match: {},
      routes: { contexts: ['personal'] },
    };
    expect(evaluate([toPersonal]).blockers).toEqual([]);
    const incompatible = evaluate([toWork, toPersonal]);
    expect(incompatible.blockers).toEqual(['incompatible-rules']);
    expect(incompatible.exclusions).toEqual([
      'Incompatible rules work-only, personal-only: no route satisfies both restrictions',
    ]);
    // Two restricts on different dimensions intersect; the route must satisfy both.
    const toClaude: DelegationRule = {
      effect: 'restrict',
      id: 'claude-only',
      match: {},
      routes: { harnesses: ['claude-code'] },
    };
    expect(evaluate([toPersonal, toClaude]).blockers).toEqual([]);
    expect(evaluate([toWork, toClaude]).blockers).toEqual(['outside-restriction']);
  });

  test('(4) requirements combine the strictest of defaults, annotation and selecting require rules', () => {
    const lax: DelegationRule = {
      effect: 'require',
      id: 'lax',
      match: {},
      require: { reservePercent: 10, maxConcurrent: 4, maxAttempts: 5, identityEvidence: 'declared' },
    };
    const strict: DelegationRule = {
      effect: 'require',
      id: 'strict',
      match: {},
      require: { reservePercent: 60, maxAttempts: 1, identityEvidence: 'observed' },
    };
    const forCodex: DelegationRule = {
      effect: 'require',
      id: 'codex',
      match: {},
      require: { reservePercent: 90 },
      routes: { harnesses: ['codex'] },
    };
    const result = evaluate([lax, strict, forCodex], {
      annotation: { ...annotation, maxConcurrent: 3, reservePercent: 30 },
    });
    expect(result.blockers).toEqual([]);
    expect(result.requirements).toEqual({
      identityEvidence: 'observed',
      maxAttempts: 1,
      maxConcurrent: 1,
      reservePercent: 60,
    });
    expect(evaluate([], { annotation: { ...annotation, maxConcurrent: 3, reservePercent: 30 } }).requirements).toEqual({
      identityEvidence: 'declared',
      maxAttempts: 2,
      maxConcurrent: 1,
      reservePercent: 30,
    });
    expect(
      evaluate([lax], { defaults: { ...DEFAULT_DELEGATION_DEFAULTS, maxConcurrentPerPool: 8 } }).requirements
        .maxConcurrent,
    ).toBe(4);
  });

  test('a forbid beats a restrict that would admit, and an assumed rule counts as applying', () => {
    const forbid: DelegationRule = { effect: 'forbid', id: 'f', match: { githubOwner: 'acme' } };
    const restrict: DelegationRule = { effect: 'restrict', id: 'r', match: {}, routes: { contexts: ['personal'] } };
    const result = evaluateRoutePolicy({
      annotation,
      applied: [
        { applies: 'assumed', effect: 'forbid', id: 'f', reason: 'assumed' },
        { applies: 'yes', effect: 'restrict', id: 'r', reason: 'matches' },
      ],
      defaults: DEFAULT_DELEGATION_DEFAULTS,
      route: policyRoute,
      rules: [forbid, restrict],
    });
    expect(result.blockers).toEqual(['forbidden-by-rule']);
  });

  test('routeMatchesSelector: absent selects all, an absent dimension accepts any value', () => {
    expect(routeMatchesSelector(undefined, policyRoute)).toBe(true);
    expect(routeMatchesSelector({}, policyRoute)).toBe(true);
    expect(routeMatchesSelector({ providers: ['anthropic'] }, policyRoute)).toBe(true);
    expect(routeMatchesSelector({ providers: ['openai'] }, policyRoute)).toBe(false);
    expect(routeMatchesSelector({ accountScopes: ['personal'] }, policyRoute)).toBe(true);
    expect(routeMatchesSelector({ accountScopes: ['personal'] }, { ...policyRoute, accountScope: null })).toBe(false);
    expect(routeMatchesSelector({ contexts: ['personal'] }, { ...policyRoute, context: null })).toBe(false);
  });
});
