import { describe, expect, test } from 'bun:test';
import type { DelegationConfigIssue } from './delegation-contract';
import {
  availabilityText,
  buildDelegationConfig,
  buildExecutors,
  buildReviewTargets,
  buildSaveInput,
  buildSimulateInput,
  conflictText,
  contextText,
  defaultsDraftFrom,
  delegationSectionFor,
  delegationSectionHref,
  type ExecutorDraft,
  executorDraftFrom,
  executorIdentity,
  factProvenanceText,
  identityText,
  issuesFor,
  issuesUnder,
  type ModelEntryDraft,
  modelEntryDraftFrom,
  modelEntryIdentity,
  newExecutorDraft,
  newModelEntryDraft,
  newRuleDraft,
  newSimulatorDraft,
  preferencesDraftFrom,
  quotaWindowText,
  type ReviewTargetDraft,
  type RuleDraft,
  reappliedText,
  repositoriesFactText,
  reviewTargetIdentity,
  routeAnnotationDraftFor,
  routeAnnotationDrafts,
  ruleDraftFrom,
  ruleIdentity,
} from './delegation-model';
import { SYNTHETIC_DELEGATION_CONFIG, SYNTHETIC_DELEGATION_SETTINGS, SYNTHETIC_NOW } from './delegation-synthetic';

const NOW = '2026-10-25T12:00:00.000Z';
const settings = SYNTHETIC_DELEGATION_SETTINGS;
const [claudeDeclaration, codexDeclaration] = settings.executors.declarations;
if (!(claudeDeclaration && codexDeclaration)) {
  throw new Error('The synthetic settings must declare two executors.');
}

describe('Delegation page sections', () => {
  test('defaults to routes and reads the section from the URL', () => {
    expect(delegationSectionFor(null)).toBe('routes');
    expect(delegationSectionFor('rules')).toBe('rules');
    expect(delegationSectionFor('models')).toBe('models');
    expect(delegationSectionFor('bogus')).toBe('routes');
    expect(delegationSectionHref('routes')).toBe('/delegation');
    expect(delegationSectionHref('rules')).toBe('/delegation?section=rules');
  });
});

describe('Delegation route presentation', () => {
  test('names an undeclared context as not admissible', () => {
    expect(contextText(null)).toEqual({ admissible: false, text: 'undeclared — not admissible' });
    expect(contextText('professional')).toEqual({ admissible: true, text: 'professional' });
  });

  test('keeps a declared fingerprint apart from an observed one', () => {
    const contradicted = identityText({
      declared: 'aaaaaaaaaaaaaaaa',
      observed: 'bbbbbbbbbbbbbbbb',
      observedAt: NOW,
      state: 'contradicted',
    });
    expect(contradicted).toContain('declared aaaaaaaaaaaaaaaa');
    expect(contradicted).toContain('observed bbbbbbbbbbbbbbbb');
    expect(contradicted).toContain('contradicted');
    const unobserved = identityText({
      declared: 'aaaaaaaaaaaaaaaa',
      observed: null,
      observedAt: null,
      state: 'unobserved',
    });
    expect(unobserved).toContain('declared aaaaaaaaaaaaaaaa');
    expect(unobserved).toContain('nothing observed');
    expect(unobserved).not.toContain('observed aaaaaaaaaaaaaaaa');
    expect(identityText({ declared: null, observed: null, observedAt: null, state: 'not-observable' })).toContain(
      'not observable',
    );
  });

  test('labels the provenance of a checkout list fact; a partial list never reads as an absence', () => {
    expect(factProvenanceText('observed')).toBe('observed');
    expect(factProvenanceText('partial')).toBe('partly identified');
    expect(factProvenanceText('unknown')).toBe('unknown');
    expect(factProvenanceText('declared')).toBe('declared');
    expect(repositoriesFactText({ provenance: 'observed', source: 'git remote -v', value: [] })).toBe(
      'none · observed (git remote -v)',
    );
    expect(
      repositoriesFactText({
        provenance: 'partial',
        source: 'git remote -v (2 of 4 remote URLs not identified)',
        value: ['acme/widgets'],
      }),
    ).toBe('acme/widgets · partly identified (git remote -v (2 of 4 remote URLs not identified))');
    expect(
      repositoriesFactText({
        provenance: 'partial',
        source: 'git remote -v (2 of 2 remote URLs not identified)',
        value: [],
      }),
    ).toBe('none identified · partly identified (git remote -v (2 of 2 remote URLs not identified))');
    expect(repositoriesFactText({ provenance: 'unknown', source: 'git remote -v (unavailable)', value: null })).toBe(
      'not read · unknown (git remote -v (unavailable))',
    );
  });

  test('labels stale quota windows and unavailable executors', () => {
    expect(
      quotaWindowText(
        { label: '5h', remainingPercent: 42.5, resetsAt: '2026-10-25T14:00:00.000Z', scope: 'account' },
        'stale',
      ),
    ).toBe('5h (account) · 43% remaining · resets 2026-10-25T14:00:00.000Z · stale');
    expect(
      quotaWindowText({ label: 'weekly', remainingPercent: null, resetsAt: null, scope: 'unknown' }, 'observed-now'),
    ).toBe('weekly · remaining unknown · no reset observed');
    expect(
      availabilityText({
        authMethod: 'claude.ai',
        authState: 'logged-in',
        observedAt: NOW,
        provenance: 'observed-now',
        state: 'available',
        version: '2.1.0',
      }),
    ).toBe('installed 2.1.0 · signed in (claude.ai) · observed now');
    expect(
      availabilityText({
        authMethod: null,
        authState: null,
        observedAt: null,
        provenance: 'unknown',
        state: 'unknown',
        version: null,
      }),
    ).toBe('not observed yet');
  });
});

describe('Executor declaration drafts', () => {
  test('keeps declaredAt on an untouched entry and stamps now on a changed or new one', () => {
    const untouched = executorDraftFrom(claudeDeclaration);
    const changed = { ...executorDraftFrom(codexDeclaration), effort: 'high' };
    const added = { ...newExecutorDraft('new-1'), accountScope: 'team', harness: 'codex' as const };
    const built = buildExecutors([untouched, changed, added], { machineId: settings.machineId, now: NOW });

    expect(built.issues).toEqual([]);
    expect(built.value?.map((declaration) => declaration.declaredAt)).toEqual([claudeDeclaration.declaredAt, NOW, NOW]);
    expect(built.value?.[1]?.effort).toBe('high');
    expect(built.value?.[2]).toMatchObject({
      accountScope: 'team',
      capabilities: ['read-only-review'],
      harness: 'codex',
      machineId: settings.machineId,
      quality: 'review-capable',
      targets: [{ kind: 'any-local-session' }],
    });
  });

  test('reports the parser issue path for an invalid fingerprint or alternate models without a model', () => {
    const draft = { ...executorDraftFrom(claudeDeclaration), accountFingerprint: 'not-hex' };
    const noModel = { ...executorDraftFrom(codexDeclaration), alternateModels: 'o3, o4-mini', model: '' };
    const built = buildExecutors([draft, noModel], { machineId: settings.machineId, now: NOW });

    expect(built.value).toBeNull();
    expect(built.issues.map((issue) => issue.path)).toEqual([
      'routing.executors[0].accountFingerprint',
      'routing.executors[1].alternateModels',
    ]);
  });

  test('round-trips alternate models, project targets and the pinned account', () => {
    const draft = executorDraftFrom(claudeDeclaration);
    expect(draft.alternateModels).toBe('claude-sonnet-4-5');
    expect(draft.projectLabels).toBe('ai-usage');
    expect(draft.targetsAnyLocalSession).toBe(false);
    const built = buildExecutors([draft], { machineId: settings.machineId, now: NOW });
    expect(built.value?.[0]).toEqual(claudeDeclaration);
  });
});

describe('Review target drafts', () => {
  test('normalizes labels and refuses relative paths', () => {
    const built = buildReviewTargets([
      { checkoutPath: '/home/operator/src/ai-usage/', label: ' ai-usage ' },
      { checkoutPath: 'relative/path', label: '' },
    ]);
    expect(built.value).toBeNull();
    expect(built.issues.map((issue) => issue.path)).toEqual(['routing.reviewTargets[1].checkoutPath']);
    const valid = buildReviewTargets([{ checkoutPath: '/home/operator/src/ai-usage/', label: ' ai-usage ' }]);
    expect(valid.value).toEqual([{ checkoutPath: '/home/operator/src/ai-usage', label: 'ai-usage' }]);
  });
});

describe('Draft entry identities', () => {
  const [restrictRule] = settings.delegation.config.rules;
  const [opus] = settings.models;
  if (!(restrictRule && opus)) {
    throw new Error('The synthetic settings must declare a rule and a model.');
  }

  test('an entry the operator added is keyed as the settings will key it once its identifying fields are set', () => {
    const blankModel = newModelEntryDraft('new-model-1');
    const namedModel: ModelEntryDraft = { ...blankModel, id: ' o3 ' };
    expect(modelEntryIdentity(blankModel)).toBe('new-model-1');
    expect(modelEntryIdentity(namedModel)).toBe('model/o3');
    const blankRule = newRuleDraft('new-rule-1');
    const namedRule: RuleDraft = { ...blankRule, id: 'no-weekends' };
    expect(ruleIdentity(blankRule)).toBe('new-rule-1');
    expect(ruleIdentity(namedRule)).toBe('rule/no-weekends');
    const blankExecutor: ExecutorDraft = { ...newExecutorDraft('new-executor-1'), machineId: settings.machineId ?? '' };
    const scopedExecutor: ExecutorDraft = { ...blankExecutor, accountScope: 'team', harness: 'codex' };
    // An empty machine resolves to this machine, as the parser resolves it.
    const unmachinedExecutor: ExecutorDraft = { ...blankExecutor, accountScope: 'team', machineId: '' };
    expect(executorIdentity(blankExecutor, settings.machineId)).toBe('new-executor-1');
    expect(executorIdentity(scopedExecutor, settings.machineId)).toBe(`${settings.machineId}/codex/team`);
    expect(executorIdentity(unmachinedExecutor, settings.machineId)).toBe(`${settings.machineId}/claude-code/team`);
    const target = (checkoutPath: string): ReviewTargetDraft & { readonly key: string } => ({
      checkoutPath,
      key: 'new-target-1',
      label: '',
    });
    expect(reviewTargetIdentity(target(''))).toBe('new-target-1');
    expect(reviewTargetIdentity(target('relative/path'))).toBe('new-target-1');
    expect(reviewTargetIdentity(target('/home/operator/src/ai-usage/'))).toBe('/home/operator/src/ai-usage');
  });

  test('an entry read from the settings is identified by the key they gave it', () => {
    const model = modelEntryDraftFrom(opus.entry);
    expect(modelEntryIdentity(model)).toBe(model.key);
    const rule = ruleDraftFrom(restrictRule);
    expect(ruleIdentity(rule)).toBe(rule.key);
    const executor = executorDraftFrom(claudeDeclaration);
    expect(executorIdentity(executor, settings.machineId)).toBe(executor.key);
  });
});

describe('Delegation config drafts', () => {
  const baseInput = () => ({
    defaults: defaultsDraftFrom(settings.delegation.config.defaults),
    models: settings.models.map((model) => modelEntryDraftFrom(model.entry)),
    preferences: preferencesDraftFrom(settings.delegation.config.preferences),
    routes: routeAnnotationDrafts(settings.executors.declarations, settings.delegation.config.routes),
    rules: settings.delegation.config.rules.map(ruleDraftFrom),
  });
  /** An annotation of a route no executor declaration resolves (a preconfigured or removed account). */
  const teamAnnotation = {
    accountScope: 'team',
    context: 'professional' as const,
    harness: 'codex' as const,
    label: 'Team Codex',
    machineId: 'other-machine',
    maxConcurrent: 2,
    reservePercent: 35,
  };
  const withTeam = [...SYNTHETIC_DELEGATION_CONFIG.routes, teamAnnotation];

  test('round-trips the loaded configuration without changing a model declaration date', () => {
    const built = buildDelegationConfig(baseInput(), { machineId: settings.machineId, now: NOW });
    expect(built.issues).toEqual([]);
    expect(built.value).toEqual(SYNTHETIC_DELEGATION_CONFIG);
  });

  test('keeps an annotation no declaration resolves, with its context, reserve and limits, until it is removed', () => {
    const drafts = routeAnnotationDrafts(settings.executors.declarations, withTeam);
    expect(drafts.map((draft) => [draft.accountScope, draft.declared])).toEqual([
      ['personal', true],
      ['work', true],
      ['team', false],
    ]);
    expect(drafts[2]).toMatchObject({
      context: 'professional',
      label: 'Team Codex',
      machineId: 'other-machine',
      maxConcurrent: '2',
      reservePercent: '35',
    });

    // What the Models and Rules forms restate when they save the whole section.
    const kept = buildDelegationConfig({ ...baseInput(), routes: drafts }, { machineId: settings.machineId, now: NOW });
    expect(kept.issues).toEqual([]);
    expect(kept.value?.routes).toEqual(withTeam);

    // The per-declaration view alone is what dropped it.
    const declaredOnly = settings.executors.declarations.map((declaration) =>
      routeAnnotationDraftFor(declaration, withTeam),
    );
    const dropped = buildDelegationConfig(
      { ...baseInput(), routes: declaredOnly },
      { machineId: settings.machineId, now: NOW },
    );
    expect(dropped.value?.routes).toEqual(SYNTHETIC_DELEGATION_CONFIG.routes);

    // An explicit removal is the only way out.
    const removed = buildDelegationConfig(
      { ...baseInput(), routes: drafts.filter((draft) => draft.declared) },
      { machineId: settings.machineId, now: NOW },
    );
    expect(removed.value?.routes).toEqual(SYNTHETIC_DELEGATION_CONFIG.routes);
  });

  test('an annotation without a machine resolves to the declaration of any machine and is not duplicated', () => {
    const unpinned = { accountScope: 'work', context: 'personal' as const, harness: 'codex' as const };
    const drafts = routeAnnotationDrafts(settings.executors.declarations, [unpinned]);
    expect(drafts.map((draft) => [draft.accountScope, draft.declared, draft.context])).toEqual([
      ['personal', true, ''],
      ['work', true, 'personal'],
    ]);
  });

  test('mirrors the parser for rule ids, bounds and requirements', () => {
    const input = baseInput();
    const badId = { ...newRuleDraft('r-1'), effect: 'forbid' as const, id: 'Bad Id' };
    const badReserve = {
      ...newRuleDraft('r-2'),
      effect: 'require' as const,
      id: 'reserve-too-high',
      require: { identityEvidence: '' as const, maxAttempts: '', maxConcurrent: '', reservePercent: '95' },
    };
    const emptyRequire = { ...newRuleDraft('r-3'), effect: 'require' as const, id: 'empty-require' };
    const requireOnForbid = {
      ...newRuleDraft('r-4'),
      effect: 'forbid' as const,
      id: 'forbid-with-require',
      require: { identityEvidence: 'observed' as const, maxAttempts: '', maxConcurrent: '', reservePercent: '' },
    };
    const badRepository = {
      ...newRuleDraft('r-5'),
      effect: 'restrict' as const,
      id: 'bad-repository',
      match: { checkoutPath: '', gitAuthorEmail: '', githubAccount: '', githubOwner: '', repository: 'no-slash' },
    };
    const built = buildDelegationConfig(
      { ...input, rules: [...input.rules, badId, badReserve, emptyRequire, requireOnForbid, badRepository] },
      { machineId: settings.machineId, now: NOW },
    );
    const offset = input.rules.length;
    expect(built.value).toBeNull();
    expect(built.issues).toEqual([
      { path: `delegation.rules[${offset}].id`, reason: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' },
      { path: `delegation.rules[${offset + 1}].require.reservePercent`, reason: 'must be a number between 0 and 90' },
      { path: `delegation.rules[${offset + 2}].require`, reason: "is required for a 'require' rule" },
      { path: `delegation.rules[${offset + 3}].require`, reason: "is only read on a 'require' rule" },
      { path: `delegation.rules[${offset + 4}].match.repository`, reason: "must be 'owner/name'" },
    ]);
  });

  test('mirrors the parser for defaults, preferences and route annotations', () => {
    const input = baseInput();
    const defaults = { ...input.defaults, maxConcurrentPerPool: '9', qualificationTtlSeconds: 'soon' };
    const preferences = { ...input.preferences, nearResetMinutes: '-5' };
    const routes = input.routes.map((route, index) =>
      index === 0 ? { ...route, context: '' as const, label: 'labelled but undeclared' } : route,
    );
    const built = buildDelegationConfig(
      { ...input, defaults, preferences, routes },
      { machineId: settings.machineId, now: NOW },
    );
    expect(built.value).toBeNull();
    expect(built.issues.map((issue) => issue.path)).toEqual([
      'delegation.defaults.maxConcurrentPerPool',
      'delegation.defaults.qualificationTtlSeconds',
      'delegation.routes[0].context',
      'delegation.preferences.nearResetMinutes',
    ]);
  });

  test('drops a route annotation whose context stays undeclared and nothing else is set', () => {
    const input = baseInput();
    const routes = input.routes.map((route, index) =>
      index === 0 ? { ...route, context: '' as const, label: '', maxConcurrent: '', reservePercent: '' } : route,
    );
    const built = buildDelegationConfig({ ...input, routes }, { machineId: settings.machineId, now: NOW });
    expect(built.issues).toEqual([]);
    expect(built.value?.routes).toHaveLength(settings.delegation.config.routes.length - 1);
  });

  test('stamps declaredAt only on changed or new model entries', () => {
    const input = baseInput();
    const [first, ...rest] = input.models;
    if (!first) {
      throw new Error('The synthetic settings must declare a model.');
    }
    const edited = { ...first, note: 'Re-declared with a note' };
    const added = {
      ...newModelEntryDraft('m-new'),
      harnesses: ['codex' as const],
      id: 'gpt-5-codex',
      nativeId: 'gpt-5-codex',
      provider: 'openai' as const,
    };
    const built = buildDelegationConfig(
      { ...input, models: [edited, ...rest, added] },
      { machineId: settings.machineId, now: NOW },
    );
    expect(built.issues).toEqual([]);
    const dates = built.value?.models.map((model) => model.declaredAt);
    expect(dates?.[0]).toBe(NOW);
    expect(dates?.slice(1, -1)).toEqual(rest.map((model) => model.original?.declaredAt ?? 'missing original'));
    expect(dates?.at(-1)).toBe(NOW);
    expect(built.value?.models.at(-1)?.resolvedVersion).toBeNull();
  });

  test('reports a category declared both recommended and discouraged', () => {
    const input = baseInput();
    const [first, ...rest] = input.models;
    if (!first) {
      throw new Error('The synthetic settings must declare a model.');
    }
    const conflicting = {
      ...first,
      discouragedFor: [...first.recommendedFor],
      recommendedFor: [...first.recommendedFor],
    };
    const built = buildDelegationConfig(
      { ...input, models: [conflicting, ...rest] },
      { machineId: settings.machineId, now: NOW },
    );
    expect(built.issues.map((issue) => issue.path)).toEqual(['delegation.models[0].discouragedFor']);
  });
});

describe('Save input', () => {
  test('sends only the sections given, with the settings revision', () => {
    const executors = settings.executors.declarations;
    expect(buildSaveInput({ executors }, 'rev-1')).toEqual({ executors, expectedRevision: 'rev-1' });
    expect(buildSaveInput({ delegation: SYNTHETIC_DELEGATION_CONFIG }, 'rev-2')).toEqual({
      delegation: SYNTHETIC_DELEGATION_CONFIG,
      expectedRevision: 'rev-2',
    });
    expect(Object.keys(buildSaveInput({ reviewTargets: [] }, 'rev-3')).sort()).toEqual([
      'expectedRevision',
      'reviewTargets',
    ]);
  });

  test('words a conflict with the revision now on disk and the two ways forward', () => {
    expect(conflictText('abcd1234abcd1234')).toBe(
      'The configuration changed elsewhere (revision abcd1234abcd1234). Your edits are kept below and cannot be saved over it: discard them or re-apply them to the latest.',
    );
    expect(conflictText(null)).toBe(
      'The configuration changed elsewhere. Your edits are kept below and cannot be saved over it: discard them or re-apply them to the latest.',
    );
  });

  test('words a re-apply, naming how many fields kept the latest value', () => {
    expect(reappliedText({ conflicts: [], revision: 'rev-2' })).toBe(
      'Your edits were re-applied to revision rev-2. Review them and save.',
    );
    expect(
      reappliedText({ conflicts: [{ mine: '"a"', path: 'model/x › alias', theirs: '"b"' }], revision: 'rev-2' }),
    ).toBe(
      'Your edits were re-applied to revision rev-2, except 1 field also changed elsewhere, which keeps the latest value until you enter yours again:',
    );
    expect(
      reappliedText({
        conflicts: [
          { mine: '"a"', path: 'model/x › alias', theirs: '"b"' },
          { mine: 'removed', path: 'model/y', theirs: 'changed' },
        ],
        revision: 'rev-3',
      }),
    ).toBe(
      'Your edits were re-applied to revision rev-3, except 2 fields also changed elsewhere, which keep the latest value until you enter yours again:',
    );
  });

  test('locates issues by exact path and under an entry prefix', () => {
    const issues: DelegationConfigIssue[] = [
      { path: 'delegation.rules[1].id', reason: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' },
      { path: 'delegation.rules[1].match.repository', reason: "must be 'owner/name'" },
      { path: 'delegation.rules[10].id', reason: 'other entry' },
      { path: 'routing.executors[0].model', reason: 'bad model' },
    ];
    expect(issuesFor(issues, 'delegation.rules[1].id')).toEqual(['must match ^[a-z0-9][a-z0-9-]{0,63}$']);
    expect(issuesUnder(issues, 'delegation.rules[1]')).toEqual([
      { path: 'id', reason: 'must match ^[a-z0-9][a-z0-9-]{0,63}$' },
      { path: 'match.repository', reason: "must be 'owner/name'" },
    ]);
    expect(issuesUnder(issues, 'delegation.rules')).toHaveLength(3);
  });
});

describe('Simulator input', () => {
  test('requires an absolute checkout path and well-formed revisions', () => {
    const commit = buildSimulateInput({
      ...newSimulatorDraft(),
      checkoutPath: '/home/operator/src/ai-usage',
      commit: 'HEAD',
    });
    expect(commit.issues).toEqual([]);
    expect(commit.value).toEqual({
      checkoutPath: '/home/operator/src/ai-usage',
      scope: { commit: 'HEAD', kind: 'commit' },
      taskCategory: 'general-review',
    });
    const range = buildSimulateInput({
      ...newSimulatorDraft(),
      base: 'main',
      checkoutPath: '/home/operator/src/ai-usage',
      head: '',
      objective: ' Check the retry loop ',
      scopeKind: 'range',
      taskCategory: 'correctness',
    });
    expect(range.value).toBeNull();
    expect(range.issues.map((issue) => issue.path)).toEqual(['head']);
    const relative = buildSimulateInput({ ...newSimulatorDraft(), checkoutPath: 'src', commit: '-rf' });
    expect(relative.issues.map((issue) => issue.path)).toEqual(['checkoutPath', 'commit']);
    const withObjective = buildSimulateInput({
      ...newSimulatorDraft(),
      base: 'main',
      checkoutPath: '/home/operator/src/ai-usage',
      head: 'HEAD',
      objective: ' Check the retry loop ',
      scopeKind: 'range',
    });
    expect(withObjective.value).toEqual({
      checkoutPath: '/home/operator/src/ai-usage',
      objective: 'Check the retry loop',
      scope: { base: 'main', head: 'HEAD', kind: 'range' },
      taskCategory: 'general-review',
    });
  });
});

describe('Synthetic settings', () => {
  test('carry the states the render tests assert', () => {
    expect(SYNTHETIC_NOW).toBe('2026-10-25T10:00:00.000Z');
    expect(settings.routes.some((route) => route.context === null)).toBe(true);
    expect(settings.routes.some((route) => route.quota.provenance === 'stale')).toBe(true);
    expect(settings.routes.some((route) => route.identity.declared !== null && route.identity.observed !== null)).toBe(
      true,
    );
  });
});
