import { parseDelegationConfig } from '@ai-usage/report-core/delegation-policy';
import {
  DELEGATION_BOUNDS,
  DELEGATION_REVISION_PATTERN,
  DELEGATION_TASK_CATEGORIES,
  type DelegationCatalogedHarness,
  type DelegationContext,
  type DelegationExecutorHarness,
  type DelegationIdentityEvidence,
  type DelegationProvider,
  type DelegationRuleEffect,
  type DelegationTaskCategory,
} from '@ai-usage/report-core/delegation-vocabulary';
import { parseReviewTargetDeclarations } from '@ai-usage/report-core/work-attempts';
import {
  type ExecutorAuthorization,
  type ExecutorHarness,
  type ExecutorSubscription,
  parseExecutorDeclarations,
} from '@ai-usage/report-core/work-executors';
import type {
  DelegationConfig,
  DelegationConfigIssue,
  DelegationDefaultsView,
  DelegationModelEntryView,
  DelegationPreferencesView,
  DelegationRouteAnnotationView,
  DelegationRouteStatus,
  DelegationRuleView,
  DelegationSaveOutcome,
  DelegationSaveSettingsInput,
  DelegationSimulateInput,
  ExecutorDeclaration,
  ExecutorDeclarationView,
  ReviewTargetDeclaration,
  ReviewTargetDeclarationView,
} from './delegation-contract';

// ---------------------------------------------------------------------------------------------
// Sections (one page, three needs; the active one lives in the URL)
// ---------------------------------------------------------------------------------------------

export type DelegationSection = 'models' | 'routes' | 'rules';

export const DELEGATION_SECTIONS = [
  { label: 'Routes and accounts', value: 'routes' },
  { label: 'Rules', value: 'rules' },
  { label: 'Models', value: 'models' },
] as const satisfies readonly { readonly label: string; readonly value: DelegationSection }[];

export const delegationSectionFor = (value: string | null): DelegationSection =>
  value === 'rules' || value === 'models' ? value : 'routes';

export const delegationSectionHref = (section: DelegationSection): string =>
  section === 'routes' ? '/delegation' : `/delegation?section=${section}`;

// ---------------------------------------------------------------------------------------------
// Fixed texts the page states rather than implies
// ---------------------------------------------------------------------------------------------

export const DELEGATION_DESCRIPTION =
  'AI Usage decides which routes may run a delegated read-only review; your agent chooses among them. Configure routes, rules and models here.';
export const NO_SECRETS_TEXT =
  'This page never creates accounts and never handles provider secrets: sign in with each CLI yourself.';
export const RULE_PRIORITY_TEXT =
  'Fixed priority: context declared → forbid → restrict → require → preferences only order. Subscription-only is fixed in this version: API-billing routes are never admissible.';
export const SIMULATOR_TEXT =
  'The simulator runs the same qualification as a start, for the checkout and scope you enter; it starts nothing.';
export const ORDER_HINT_TEXT = 'deterministic tie-break, not a judgment';
export const OBSERVED_MODELS_TEXT = 'Observed in runs, not a ranking.';
export const MODEL_DECLARATION_TEXT = 'Operator declaration; never a measured performance.';
export const RULE_EFFECT_TEXT: Readonly<Record<DelegationRuleEffect, string>> = {
  forbid: 'Excludes the routes it selects wherever it applies.',
  require:
    'Raises the requirements of the routes it selects (reserve, concurrency, attempts, identity evidence); the strictest rule wins.',
  restrict: 'Only the routes it selects stay admissible; several restrictions intersect.',
};
export const IDENTITY_FIELDS_TEXT =
  'Three different identities: the GitHub account (the login declared in github.accounts for the owner), the Git author (the local git config user.email) and the AI provider account of the route.';

export const harnessDisplayName = (harness: DelegationCatalogedHarness): string => {
  switch (harness) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'Cursor';
  }
};

// ---------------------------------------------------------------------------------------------
// Route status presentation (declared is never worded as observed)
// ---------------------------------------------------------------------------------------------

export const contextText = (
  context: DelegationContext | null,
): { readonly admissible: boolean; readonly text: string } =>
  context === null ? { admissible: false, text: 'undeclared — not admissible' } : { admissible: true, text: context };

export const identityText = (identity: DelegationRouteStatus['identity']): string => {
  const declared = identity.declared === null ? 'no account pinned (declaration)' : `declared ${identity.declared}`;
  const observed = identity.observed === null ? 'nothing observed yet' : `observed ${identity.observed}`;
  switch (identity.state) {
    case 'confirmed':
      return `${declared} · ${observed} · confirmed: the signed-in account is the pinned one`;
    case 'contradicted':
      return `${declared} · ${observed} · contradicted: the signed-in account is not the pinned one`;
    case 'unpinned':
      return `${declared} · ${observed} · unpinned: pin the observed account to bind this route to it`;
    case 'unobserved':
      return `${declared} · ${observed} · unobserved`;
    case 'not-observable':
      return 'not observable: this harness reports no account without its credential file; the binding rests on the declaration';
    default:
      return `${declared} · ${observed} · ${identity.state}`;
  }
};

export const provenanceText = (
  provenance: DelegationRouteStatus['availability']['provenance'],
  observedAt: string | null,
): string => {
  if (provenance === 'observed-now') {
    return 'observed now';
  }
  if (provenance === 'stale') {
    return observedAt === null ? 'stale' : `stale (last checked ${observedAt})`;
  }
  return 'not observed';
};

export const availabilityText = (availability: DelegationRouteStatus['availability']): string => {
  if (availability.provenance === 'unknown' && availability.observedAt === null && availability.version === null) {
    return 'not observed yet';
  }
  let installed: string;
  if (availability.version !== null) {
    installed = `installed ${availability.version}`;
  } else if (availability.state === 'unavailable') {
    installed = 'not installed or not runnable';
  } else {
    installed = 'installed (version unknown)';
  }
  let signIn: string;
  if (availability.authState === 'logged-in') {
    signIn = `signed in${availability.authMethod ? ` (${availability.authMethod})` : ''}`;
  } else if (availability.authState === 'logged-out') {
    signIn = 'signed out';
  } else {
    signIn = 'sign-in state unknown';
  }
  return `${installed} · ${signIn} · ${provenanceText(availability.provenance, availability.observedAt)}`;
};

export const quotaWindowText = (
  window: DelegationRouteStatus['quota']['windows'][number],
  provenance: DelegationRouteStatus['quota']['provenance'],
): string => {
  const scope = window.scope === 'unknown' ? '' : ` (${window.scope})`;
  const remaining =
    window.remainingPercent === null ? 'remaining unknown' : `${Math.round(window.remainingPercent)}% remaining`;
  const reset = window.resetsAt === null ? 'no reset observed' : `resets ${window.resetsAt}`;
  return `${window.label}${scope} · ${remaining} · ${reset}${provenance === 'stale' ? ' · stale' : ''}`;
};

export const subscriptionText = (subscription: DelegationRouteStatus['subscription']): string => {
  switch (subscription) {
    case 'verified':
      return 'subscription (declared verified)';
    case 'api':
      return 'API key observed — never admissible';
    default:
      return 'unverified';
  }
};

// ---------------------------------------------------------------------------------------------
// Drafts: form-shaped text, built into config entries by the same parsers the engine runs
// ---------------------------------------------------------------------------------------------

export interface BuiltSection<Value> {
  readonly issues: readonly DelegationConfigIssue[];
  /** `null` whenever an issue exists: a section is written whole or not at all. */
  readonly value: Value | null;
}

const text = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const LIST_SEPARATOR = /[\n,]/u;
const LEADING_DOT = /^\./u;

const list = (value: string): string[] =>
  value
    .split(LIST_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/** `''` stays absent (the parser applies its default); anything else is judged by the parser. */
const numberOrAbsent = (value: string): number | undefined => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : Number(trimmed);
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const sameExceptDeclaredAt = (left: { readonly declaredAt: string }, right: { readonly declaredAt: string }): boolean =>
  stableJson({ ...left, declaredAt: null }) === stableJson({ ...right, declaredAt: null });

// --- Executor declarations ---------------------------------------------------------------------

export interface ExecutorDraft {
  accountFingerprint: string;
  accountScope: string;
  /** Comma- or newline-separated further models of the same account, in preference order. */
  alternateModels: string;
  authorization: ExecutorAuthorization;
  effort: string;
  harness: ExecutorHarness;
  readonly key: string;
  /** Empty means this machine. */
  machineId: string;
  model: string;
  readonly original: ExecutorDeclarationView | null;
  /** Comma- or newline-separated project labels the route may review. */
  projectLabels: string;
  subscription: ExecutorSubscription;
  targetsAnyLocalSession: boolean;
}

export const executorDraftFrom = (declaration: ExecutorDeclarationView): ExecutorDraft => ({
  accountFingerprint: declaration.accountFingerprint ?? '',
  accountScope: declaration.accountScope,
  alternateModels: (declaration.alternateModels ?? []).join(', '),
  authorization: declaration.authorization,
  effort: declaration.effort ?? '',
  harness: declaration.harness,
  key: `${declaration.machineId}/${declaration.harness}/${declaration.accountScope}`,
  machineId: declaration.machineId,
  model: declaration.model ?? '',
  original: declaration,
  projectLabels: declaration.targets
    .flatMap((target) => (target.kind === 'project' ? [target.projectLabel] : []))
    .join(', '),
  subscription: declaration.subscription,
  targetsAnyLocalSession: declaration.targets.some((target) => target.kind === 'any-local-session'),
});

export const newExecutorDraft = (key: string): ExecutorDraft => ({
  accountFingerprint: '',
  accountScope: '',
  alternateModels: '',
  authorization: 'allowed',
  effort: '',
  harness: 'claude-code',
  key,
  machineId: '',
  model: '',
  original: null,
  projectLabels: '',
  subscription: 'verified',
  targetsAnyLocalSession: true,
});

const rawExecutor = (draft: ExecutorDraft, now: string): Record<string, unknown> => {
  const fingerprint = text(draft.accountFingerprint);
  const alternates = list(draft.alternateModels);
  const machineId = text(draft.machineId);
  return {
    ...(fingerprint === null ? {} : { accountFingerprint: fingerprint }),
    accountScope: draft.accountScope.trim(),
    ...(alternates.length === 0 ? {} : { alternateModels: alternates }),
    authorization: draft.authorization,
    capabilities: ['read-only-review'],
    declaredAt: draft.original?.declaredAt ?? now,
    effort: text(draft.effort),
    harness: draft.harness,
    ...(machineId === null ? {} : { machineId }),
    model: text(draft.model),
    quality: 'review-capable',
    subscription: draft.subscription,
    targets: [
      ...(draft.targetsAnyLocalSession ? [{ kind: 'any-local-session' }] : []),
      ...list(draft.projectLabels).map((projectLabel) => ({ kind: 'project', projectLabel })),
    ],
  };
};

export interface BuildContext {
  readonly machineId: string | null;
  /** The instant stamped as `declaredAt` on every new or changed entry. */
  readonly now: string;
}

/**
 * `routing.executors[]` from the drafts, validated by the engine's own parser. `declaredAt` moves
 * to `now` only on entries whose declaration changed or that are new: a declaration is a dated
 * statement, and re-saving an untouched one restates nothing.
 */
export const buildExecutors = (
  drafts: readonly ExecutorDraft[],
  context: BuildContext,
): BuiltSection<readonly ExecutorDeclaration[]> => {
  const parsed = parseExecutorDeclarations(
    { executors: drafts.map((draft) => rawExecutor(draft, context.now)) },
    { defaultMachineId: context.machineId },
  );
  if (parsed.issues.length > 0 || parsed.declarations.length !== drafts.length) {
    return { issues: parsed.issues, value: null };
  }
  return {
    issues: [],
    value: parsed.declarations.map((declaration, index) => {
      const original = drafts[index]?.original ?? null;
      return original !== null && sameExceptDeclaredAt(original, declaration)
        ? { ...declaration, declaredAt: original.declaredAt }
        : { ...declaration, declaredAt: context.now };
    }),
  };
};

// --- Review targets -----------------------------------------------------------------------------

export interface ReviewTargetDraft {
  checkoutPath: string;
  label: string;
}

export const reviewTargetDraftFrom = (target: ReviewTargetDeclarationView): ReviewTargetDraft => ({
  checkoutPath: target.checkoutPath,
  label: target.label ?? '',
});

export const buildReviewTargets = (
  drafts: readonly ReviewTargetDraft[],
): BuiltSection<readonly ReviewTargetDeclaration[]> => {
  const parsed = parseReviewTargetDeclarations(
    drafts.map((draft) => ({ checkoutPath: draft.checkoutPath.trim(), label: text(draft.label) })),
  );
  if (parsed.issues.length > 0 || parsed.targets.length !== drafts.length) {
    return { issues: parsed.issues, value: null };
  }
  return { issues: [], value: parsed.targets };
};

// --- Route annotations (context per declared executor) ----------------------------------------

export interface RouteAnnotationDraft {
  readonly accountScope: string;
  context: '' | DelegationContext;
  readonly harness: DelegationExecutorHarness;
  readonly key: string;
  label: string;
  /** Empty means this machine; set when the annotation names one. */
  readonly machineId: string;
  maxConcurrent: string;
  reservePercent: string;
}

const annotationFor = (
  declaration: ExecutorDeclarationView,
  annotations: readonly DelegationRouteAnnotationView[],
): DelegationRouteAnnotationView | undefined =>
  annotations.find(
    (annotation) =>
      annotation.harness === declaration.harness &&
      annotation.accountScope === declaration.accountScope &&
      (annotation.machineId === undefined || annotation.machineId === declaration.machineId),
  );

export const routeAnnotationDraftFor = (
  declaration: ExecutorDeclarationView,
  annotations: readonly DelegationRouteAnnotationView[],
): RouteAnnotationDraft => {
  const annotation = annotationFor(declaration, annotations);
  return {
    accountScope: declaration.accountScope,
    context: annotation?.context ?? '',
    harness: declaration.harness,
    key: `${declaration.machineId}/${declaration.harness}/${declaration.accountScope}`,
    label: annotation?.label ?? '',
    machineId: annotation?.machineId ?? '',
    maxConcurrent: annotation?.maxConcurrent === undefined ? '' : String(annotation.maxConcurrent),
    reservePercent: annotation?.reservePercent === undefined ? '' : String(annotation.reservePercent),
  };
};

/** A draft with nothing set declares nothing and produces no entry; one with anything set must name a context. */
const annotationIsSet = (draft: RouteAnnotationDraft): boolean =>
  draft.context !== '' ||
  draft.label.trim().length > 0 ||
  draft.maxConcurrent.trim().length > 0 ||
  draft.reservePercent.trim().length > 0;

export const includedRouteAnnotationDrafts = (drafts: readonly RouteAnnotationDraft[]): RouteAnnotationDraft[] =>
  drafts.filter(annotationIsSet);

/** The config path of a draft's entry, for placing a parser issue beside its form; `null` when it produces none. */
export const routeAnnotationPathFor = (drafts: readonly RouteAnnotationDraft[], key: string): string | null => {
  const index = includedRouteAnnotationDrafts(drafts).findIndex((draft) => draft.key === key);
  return index === -1 ? null : `delegation.routes[${index}]`;
};

const rawAnnotation = (draft: RouteAnnotationDraft): Record<string, unknown> => {
  const label = text(draft.label);
  const machineId = text(draft.machineId);
  const maxConcurrent = numberOrAbsent(draft.maxConcurrent);
  const reservePercent = numberOrAbsent(draft.reservePercent);
  return {
    accountScope: draft.accountScope,
    ...(draft.context === '' ? {} : { context: draft.context }),
    harness: draft.harness,
    ...(label === null ? {} : { label }),
    ...(machineId === null ? {} : { machineId }),
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(reservePercent === undefined ? {} : { reservePercent }),
  };
};

// --- Rules -----------------------------------------------------------------------------------

export interface RuleDraft {
  description: string;
  effect: DelegationRuleEffect;
  id: string;
  readonly key: string;
  match: {
    checkoutPath: string;
    gitAuthorEmail: string;
    githubAccount: string;
    githubOwner: string;
    repository: string;
  };
  require: {
    identityEvidence: '' | DelegationIdentityEvidence;
    maxAttempts: string;
    maxConcurrent: string;
    reservePercent: string;
  };
  routes: {
    /** Comma- or newline-separated account scopes. */
    accountScopes: string;
    contexts: DelegationContext[];
    harnesses: DelegationExecutorHarness[];
    providers: DelegationProvider[];
  };
}

export const newRuleDraft = (key: string): RuleDraft => ({
  description: '',
  effect: 'forbid',
  id: '',
  key,
  match: { checkoutPath: '', gitAuthorEmail: '', githubAccount: '', githubOwner: '', repository: '' },
  require: { identityEvidence: '', maxAttempts: '', maxConcurrent: '', reservePercent: '' },
  routes: { accountScopes: '', contexts: [], harnesses: [], providers: [] },
});

export const ruleDraftFrom = (rule: DelegationRuleView): RuleDraft => ({
  description: rule.description ?? '',
  effect: rule.effect,
  id: rule.id,
  key: `rule/${rule.id}`,
  match: {
    checkoutPath: rule.match.checkoutPath ?? '',
    gitAuthorEmail: rule.match.gitAuthorEmail ?? '',
    githubAccount: rule.match.githubAccount ?? '',
    githubOwner: rule.match.githubOwner ?? '',
    repository: rule.match.repository ?? '',
  },
  require: {
    identityEvidence: rule.require?.identityEvidence ?? '',
    maxAttempts: rule.require?.maxAttempts === undefined ? '' : String(rule.require.maxAttempts),
    maxConcurrent: rule.require?.maxConcurrent === undefined ? '' : String(rule.require.maxConcurrent),
    reservePercent: rule.require?.reservePercent === undefined ? '' : String(rule.require.reservePercent),
  },
  routes: {
    accountScopes: (rule.routes?.accountScopes ?? []).join(', '),
    contexts: [...(rule.routes?.contexts ?? [])],
    harnesses: [...(rule.routes?.harnesses ?? [])],
    providers: [...(rule.routes?.providers ?? [])],
  },
});

const rawRule = (draft: RuleDraft): Record<string, unknown> => {
  const description = text(draft.description);
  const match: Record<string, string> = {};
  for (const key of ['checkoutPath', 'repository', 'githubOwner', 'githubAccount', 'gitAuthorEmail'] as const) {
    const value = text(draft.match[key]);
    if (value !== null) {
      match[key] = value;
    }
  }
  const accountScopes = list(draft.routes.accountScopes);
  const routes: Record<string, unknown> = {
    ...(accountScopes.length === 0 ? {} : { accountScopes }),
    ...(draft.routes.contexts.length === 0 ? {} : { contexts: draft.routes.contexts }),
    ...(draft.routes.harnesses.length === 0 ? {} : { harnesses: draft.routes.harnesses }),
    ...(draft.routes.providers.length === 0 ? {} : { providers: draft.routes.providers }),
  };
  const maxAttempts = numberOrAbsent(draft.require.maxAttempts);
  const maxConcurrent = numberOrAbsent(draft.require.maxConcurrent);
  const reservePercent = numberOrAbsent(draft.require.reservePercent);
  const require: Record<string, unknown> = {
    ...(draft.require.identityEvidence === '' ? {} : { identityEvidence: draft.require.identityEvidence }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(reservePercent === undefined ? {} : { reservePercent }),
  };
  return {
    ...(description === null ? {} : { description }),
    effect: draft.effect,
    id: draft.id.trim(),
    match,
    ...(Object.keys(require).length === 0 ? {} : { require }),
    ...(Object.keys(routes).length === 0 ? {} : { routes }),
  };
};

// --- Defaults and preferences -----------------------------------------------------------------

export interface DefaultsDraft {
  identityEvidence: DelegationIdentityEvidence;
  maxAttempts: string;
  maxConcurrentPerPool: string;
  qualificationTtlSeconds: string;
  reservePercent: string;
}

export const defaultsDraftFrom = (defaults: DelegationDefaultsView): DefaultsDraft => ({
  identityEvidence: defaults.identityEvidence,
  maxAttempts: String(defaults.maxAttempts),
  maxConcurrentPerPool: String(defaults.maxConcurrentPerPool),
  qualificationTtlSeconds: String(defaults.qualificationTtlSeconds),
  reservePercent: String(defaults.reservePercent),
});

export interface PreferencesDraft {
  harnesses: DelegationExecutorHarness[];
  /** Comma- or newline-separated native model ids, in preference order. */
  models: string;
  /** Empty means off. */
  nearResetMinutes: string;
}

export const preferencesDraftFrom = (preferences: DelegationPreferencesView): PreferencesDraft => ({
  harnesses: [...preferences.harnesses],
  models: preferences.models.join(', '),
  nearResetMinutes: preferences.nearResetMinutes === null ? '' : String(preferences.nearResetMinutes),
});

const rawDefaults = (draft: DefaultsDraft): Record<string, unknown> => {
  const maxAttempts = numberOrAbsent(draft.maxAttempts);
  const maxConcurrentPerPool = numberOrAbsent(draft.maxConcurrentPerPool);
  const qualificationTtlSeconds = numberOrAbsent(draft.qualificationTtlSeconds);
  const reservePercent = numberOrAbsent(draft.reservePercent);
  return {
    identityEvidence: draft.identityEvidence,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(maxConcurrentPerPool === undefined ? {} : { maxConcurrentPerPool }),
    ...(qualificationTtlSeconds === undefined ? {} : { qualificationTtlSeconds }),
    ...(reservePercent === undefined ? {} : { reservePercent }),
  };
};

const rawPreferences = (draft: PreferencesDraft): Record<string, unknown> => ({
  harnesses: draft.harnesses,
  models: list(draft.models),
  nearResetMinutes: numberOrAbsent(draft.nearResetMinutes) ?? null,
});

// --- Model catalog -----------------------------------------------------------------------------

export interface ModelEntryDraft {
  alias: string;
  discouragedFor: DelegationTaskCategory[];
  harnesses: DelegationExecutorHarness[];
  id: string;
  readonly key: string;
  nativeId: string;
  note: string;
  readonly original: DelegationModelEntryView | null;
  provider: DelegationProvider;
  recommendedFor: DelegationTaskCategory[];
  /** Empty means unknown, never guessed. */
  resolvedVersion: string;
}

export const modelEntryDraftFrom = (entry: DelegationModelEntryView): ModelEntryDraft => ({
  alias: entry.alias ?? '',
  discouragedFor: [...entry.discouragedFor],
  harnesses: [...entry.harnesses],
  id: entry.id,
  key: `model/${entry.id}`,
  nativeId: entry.nativeId,
  note: entry.note ?? '',
  original: entry,
  provider: entry.provider,
  recommendedFor: [...entry.recommendedFor],
  resolvedVersion: entry.resolvedVersion ?? '',
});

export const newModelEntryDraft = (key: string): ModelEntryDraft => ({
  alias: '',
  discouragedFor: [],
  harnesses: ['claude-code'],
  id: '',
  key,
  nativeId: '',
  note: '',
  original: null,
  provider: 'anthropic',
  recommendedFor: [],
  resolvedVersion: '',
});

const rawModel = (draft: ModelEntryDraft, now: string): Record<string, unknown> => ({
  alias: text(draft.alias),
  declaredAt: draft.original?.declaredAt ?? now,
  discouragedFor: draft.discouragedFor,
  harnesses: draft.harnesses,
  id: draft.id.trim(),
  nativeId: draft.nativeId.trim(),
  note: text(draft.note),
  provider: draft.provider,
  recommendedFor: draft.recommendedFor,
  resolvedVersion: text(draft.resolvedVersion),
});

// --- The delegation section as one value -------------------------------------------------------

export interface DelegationConfigDrafts {
  readonly defaults: DefaultsDraft;
  readonly models: readonly ModelEntryDraft[];
  readonly preferences: PreferencesDraft;
  readonly routes: readonly RouteAnnotationDraft[];
  readonly rules: readonly RuleDraft[];
}

/**
 * The whole `delegation` section from its drafts, validated by `parseDelegationConfig` so the
 * bounds, id pattern and reasons are the engine's. Model entries keep their `declaredAt` unless
 * their declaration changed.
 */
export const buildDelegationConfig = (
  drafts: DelegationConfigDrafts,
  context: BuildContext,
): BuiltSection<DelegationConfig> => {
  const parsed = parseDelegationConfig(
    {
      defaults: rawDefaults(drafts.defaults),
      models: drafts.models.map((draft) => rawModel(draft, context.now)),
      preferences: rawPreferences(drafts.preferences),
      routes: includedRouteAnnotationDrafts(drafts.routes).map(rawAnnotation),
      rules: drafts.rules.map(rawRule),
    },
    { defaultMachineId: context.machineId },
  );
  if (parsed.issues.length > 0 || parsed.config.models.length !== drafts.models.length) {
    return { issues: parsed.issues, value: null };
  }
  return {
    issues: [],
    value: {
      ...parsed.config,
      models: parsed.config.models.map((entry, index) => {
        const original = drafts.models[index]?.original ?? null;
        return original !== null && sameExceptDeclaredAt(original, entry)
          ? { ...entry, declaredAt: original.declaredAt }
          : { ...entry, declaredAt: context.now };
      }),
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Save input and outcomes
// ---------------------------------------------------------------------------------------------

export interface SaveSections {
  readonly delegation?: DelegationConfig;
  readonly executors?: readonly ExecutorDeclaration[];
  readonly reviewTargets?: readonly ReviewTargetDeclaration[];
}

/** Only the sections given travel; an untouched section is never re-sent. */
export const buildSaveInput = (sections: SaveSections, revision: string): DelegationSaveSettingsInput => ({
  expectedRevision: revision,
  ...(sections.delegation === undefined ? {} : { delegation: sections.delegation }),
  ...(sections.executors === undefined ? {} : { executors: sections.executors }),
  ...(sections.reviewTargets === undefined ? {} : { reviewTargets: sections.reviewTargets }),
});

/** The issues a form shows: its own parser's first, else the server's `InvalidInput` issues, else none. */
export const issuesToShow = (
  local: readonly DelegationConfigIssue[],
  outcome: DelegationSaveOutcome | null,
): readonly DelegationConfigIssue[] => {
  if (local.length > 0) {
    return local;
  }
  return outcome?.kind === 'invalid' ? outcome.issues : [];
};

export const conflictText = (revision: string | null): string =>
  revision === null
    ? 'The configuration changed elsewhere. Reload to see it; your edits are kept below.'
    : `The configuration changed elsewhere (revision ${revision}). Reload to see it; your edits are kept below.`;

export const issuesFor = (issues: readonly DelegationConfigIssue[], path: string): string[] =>
  issues.filter((issue) => issue.path === path).map((issue) => issue.reason);

const isUnder = (path: string, prefix: string): boolean => {
  if (!path.startsWith(prefix)) {
    return false;
  }
  const next = path.charAt(prefix.length);
  return next === '' || next === '.' || next === '[';
};

/** The issues of one entry, with paths relative to it (`delegation.rules[1]` → `match.repository`). */
export const issuesUnder = (issues: readonly DelegationConfigIssue[], prefix: string): DelegationConfigIssue[] =>
  issues
    .filter((issue) => isUnder(issue.path, prefix))
    .map((issue) => ({ path: issue.path.slice(prefix.length).replace(LEADING_DOT, ''), reason: issue.reason }));

/** Every reason at a field or below it (`…alternateModels` also collects `…alternateModels[1]`). */
export const issueReasonsUnder = (issues: readonly DelegationConfigIssue[], path: string): string[] =>
  issuesUnder(issues, path).map((issue) => issue.reason);

/** The issues of an entry that name no field of it, shown at the entry itself. */
export const entryLevelIssues = (issues: readonly DelegationConfigIssue[], prefix: string): string[] =>
  issuesFor(issues, prefix);

// --- Preference order of harnesses, as one select ---------------------------------------------

export const HARNESS_ORDER_OPTIONS = [
  { label: 'No harness preference', value: '' },
  { label: 'Claude Code, then Codex', value: 'claude-code,codex' },
  { label: 'Codex, then Claude Code', value: 'codex,claude-code' },
  { label: 'Claude Code only ordered first', value: 'claude-code' },
  { label: 'Codex only ordered first', value: 'codex' },
] as const;

export type HarnessOrderValue = (typeof HARNESS_ORDER_OPTIONS)[number]['value'];

export const harnessOrderValue = (harnesses: readonly DelegationExecutorHarness[]): HarnessOrderValue => {
  const joined = harnesses.join(',');
  return HARNESS_ORDER_OPTIONS.some((option) => option.value === joined) ? (joined as HarnessOrderValue) : '';
};

export const harnessesFromOrder = (value: string): DelegationExecutorHarness[] =>
  value.split(',').filter((entry): entry is DelegationExecutorHarness => entry === 'claude-code' || entry === 'codex');

/** The observed fingerprint the page offers to pin for one declared account, when a route reports one. */
export const observedFingerprintFor = (
  routes: readonly DelegationRouteStatus[],
  declaration: { readonly accountScope: string; readonly harness: string },
): string | null =>
  routes.find(
    (route) =>
      route.harness === declaration.harness &&
      route.accountScope === declaration.accountScope &&
      route.identity.observed !== null,
  )?.identity.observed ?? null;

// ---------------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------------

export interface SimulatorDraft {
  base: string;
  checkoutPath: string;
  commit: string;
  head: string;
  objective: string;
  scopeKind: 'commit' | 'range';
  taskCategory: DelegationTaskCategory;
}

export const newSimulatorDraft = (): SimulatorDraft => ({
  base: '',
  checkoutPath: '',
  commit: 'HEAD',
  head: '',
  objective: '',
  scopeKind: 'commit',
  taskCategory: 'general-review',
});

export const SIMULATOR_TASK_CATEGORIES = DELEGATION_TASK_CATEGORIES;

const revisionIssue = (value: string, path: string): DelegationConfigIssue | null => {
  const trimmed = value.trim();
  if (trimmed.length > 0 && DELEGATION_REVISION_PATTERN.test(trimmed) && !trimmed.startsWith('-')) {
    return null;
  }
  return { path, reason: 'must be a Git revision (branch, tag or SHA) that does not start with -' };
};

export const buildSimulateInput = (draft: SimulatorDraft): BuiltSection<DelegationSimulateInput> => {
  const issues: DelegationConfigIssue[] = [];
  const checkoutPath = draft.checkoutPath.trim();
  if (!(checkoutPath.startsWith('/') && checkoutPath.length <= DELEGATION_BOUNDS.maxCheckoutPathCharacters)) {
    issues.push({ path: 'checkoutPath', reason: 'must be an absolute path of a local checkout' });
  }
  let scope: DelegationSimulateInput['scope'] | null = null;
  if (draft.scopeKind === 'commit') {
    const issue = revisionIssue(draft.commit, 'commit');
    if (issue) {
      issues.push(issue);
    } else {
      scope = { commit: draft.commit.trim(), kind: 'commit' };
    }
  } else {
    const baseIssue = revisionIssue(draft.base, 'base');
    const headIssue = revisionIssue(draft.head, 'head');
    for (const issue of [baseIssue, headIssue]) {
      if (issue) {
        issues.push(issue);
      }
    }
    if (!(baseIssue || headIssue)) {
      scope = { base: draft.base.trim(), head: draft.head.trim(), kind: 'range' };
    }
  }
  const objective = text(draft.objective);
  if (objective !== null && objective.length > DELEGATION_BOUNDS.maxObjectiveCharacters) {
    issues.push({
      path: 'objective',
      reason: `must be at most ${DELEGATION_BOUNDS.maxObjectiveCharacters} characters`,
    });
  }
  if (issues.length > 0 || scope === null) {
    return { issues, value: null };
  }
  return {
    issues: [],
    value: {
      checkoutPath,
      ...(objective === null ? {} : { objective }),
      scope,
      taskCategory: draft.taskCategory,
    },
  };
};
