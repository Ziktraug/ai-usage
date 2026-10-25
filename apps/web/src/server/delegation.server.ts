import type { LocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import { readLocalRoutingDeclarations } from '@ai-usage/local-machine/routing-config';
import type {
  DelegationConfig,
  DelegationConfigIssue,
  DelegationJob,
  DelegationModelEntry,
  DelegationQualification,
  DelegationRequest,
  DelegationRouteAnnotation,
} from '@ai-usage/report-core/delegation-contracts';
import { type DelegationJobView, projectDelegationJobView } from '@ai-usage/report-core/delegation-job';
import {
  DELEGATION_QUALIFICATION_BOUNDS,
  parseDelegationQualification,
} from '@ai-usage/report-core/delegation-qualification';
import { DELEGATION_LIVE_STATES, type DelegationExecutorHarness } from '@ai-usage/report-core/delegation-vocabulary';
import { projectLatestProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import type { ReviewTargetDeclaration } from '@ai-usage/report-core/work-attempts';
import type { ExecutorDeclaration, ExecutorObservation } from '@ai-usage/report-core/work-executors';
import {
  type CandidateProvenance,
  qualifyReviewCandidates,
  quotaWindowAppliesToModel,
  type ReviewCandidate,
} from '@ai-usage/report-core/work-routing';
import {
  parseWebUsageEngineCommand,
  type UsageEngineCommandCompletion,
  type WebUsageEngineCommand,
} from '@ai-usage/usage-engine-control';
import {
  type DelegationJobRead,
  type DelegationJobsRead,
  type DelegationStoreReadFailure,
  queryLatestExecutorObservations,
  queryLatestProviderQuotaObservations,
  readDelegationJob,
  readDelegationJobs,
  usageStoreErrorReasonFrom,
} from '@ai-usage/usage-store/reader';
import {
  DELEGATION_WEB_BOUNDS,
  type DelegationCancelInput,
  type DelegationCancelOutput,
  type DelegationHarnessSupport,
  type DelegationJobInput,
  type DelegationJobsInput,
  type DelegationRecordAcceptanceInput,
  type DelegationRecordAcceptanceOutput,
  type DelegationRouteStatus,
  type DelegationSaveSettingsInput,
  type DelegationSaveSettingsOutput,
  type DelegationSettingsView,
  type DelegationSimulateInput,
  parseDelegationSettingsView,
} from '@ai-usage/web-contract/delegation';
import { Effect } from 'effect';
import type { DelegationFailure, DelegationOutcome } from '../lib/server/rpc/delegation';
import { delegationOk } from '../lib/server/rpc/delegation';
import type { RuntimeMode } from '../runtime-mode';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import { getServerRuntimeMode } from './runtime-mode.server';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

/**
 * The server side of the `delegation` namespace (ADR 0077). Reads go to the home config and the
 * query-only store (ADR 0009): the policy, the latest executor and quota observations, the jobs
 * with their evaluations. Writes are one engine command each, relayed with the engine's answer;
 * the Web process decides nothing, starts nothing and records nothing itself. The acceptance this
 * edge records is always the operator's: the author is fixed here, never read from the request.
 * Demo exposes nothing; the synthetic e2e runtime answers from `delegation-e2e-fixture.server.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------

/** The declarations the settings view rests on, as one read of the home config. */
export interface DelegationDeclarationsRead {
  readonly configPath: string;
  readonly delegation: { readonly config: DelegationConfig; readonly issues: readonly DelegationConfigIssue[] };
  readonly executors: {
    readonly declarations: readonly ExecutorDeclaration[];
    readonly issues: readonly { readonly path: string; readonly reason: string }[];
  };
  readonly githubAccounts: readonly { readonly ghUser: string; readonly owner: string }[];
  readonly machineId: string | null;
  readonly reviewTargets: {
    readonly issues: readonly { readonly path: string; readonly reason: string }[];
    readonly targets: readonly ReviewTargetDeclaration[];
  };
  readonly revisions: { readonly catalogRevision: string; readonly policyRevision: string };
}

/** One home-config read, regrouped by section; the GitHub accounts keep only the owner and login. */
export const declarationsFromRouting = (routing: LocalRoutingDeclarations): DelegationDeclarationsRead => ({
  configPath: routing.configPath,
  delegation: routing.delegation,
  executors: { declarations: routing.declarations, issues: routing.issues },
  githubAccounts: routing.githubAccounts.map((account) => ({ ghUser: account.ghUser, owner: account.owner })),
  machineId: routing.machineId,
  reviewTargets: { issues: routing.reviewTargetIssues, targets: routing.reviewTargets },
  revisions: routing.revisions,
});

export interface DelegationServerReaders {
  readonly now?: () => Date;
  readonly readDeclarations: () => Promise<DelegationDeclarationsRead>;
  readonly readJob: (jobId: string) => Promise<DelegationJobRead>;
  readonly readJobs: (input: { readonly limit: number; readonly liveOnly: boolean }) => Promise<DelegationJobsRead>;
  readonly readObservations: (machineId: string | null) => Promise<readonly ExecutorObservation[]>;
  readonly readQuota: (machineId: string | null) => Promise<readonly ProviderStatus[]>;
}

export const createDelegationServerReaders = (
  paths: ReturnType<typeof resolveUsageWebRuntimePaths> = resolveUsageWebRuntimePaths(),
): DelegationServerReaders => ({
  readDeclarations: async () => declarationsFromRouting(await readLocalRoutingDeclarations(paths.homeDirectory)),
  readJob: (jobId) => Effect.runPromise(readDelegationJob({ dbPath: paths.databasePath, jobId })),
  readJobs: ({ limit, liveOnly }) =>
    Effect.runPromise(
      readDelegationJobs({
        dbPath: paths.databasePath,
        limit,
        ...(liveOnly ? { states: DELEGATION_LIVE_STATES } : {}),
      }),
    ),
  readObservations: async (machineId) => {
    const outcome = await Effect.runPromise(
      Effect.result(
        queryLatestExecutorObservations({
          dbPath: paths.databasePath,
          ...(machineId === null ? {} : { machineId }),
        }),
      ),
    );
    if (outcome._tag === 'Success') {
      return outcome.success.observations;
    }
    // A machine that has never collected has no store yet: an empty answer, not a failure.
    if (usageStoreErrorReasonFrom(outcome.failure) === 'store-missing') {
      return [];
    }
    throw outcome.failure;
  },
  readQuota: async (machineId) => {
    const outcome = await Effect.runPromise(
      Effect.result(
        queryLatestProviderQuotaObservations({
          dbPath: paths.databasePath,
          ...(machineId === null ? {} : { machineId }),
        }),
      ),
    );
    if (outcome._tag === 'Success') {
      return outcome.success.observations.map(projectLatestProviderQuotaObservation);
    }
    if (usageStoreErrorReasonFrom(outcome.failure) === 'store-missing') {
      return [];
    }
    throw outcome.failure;
  },
});

// ---------------------------------------------------------------------------------------------
// Settings assembly (pure; the e2e fixture runs it on fixture inputs)
// ---------------------------------------------------------------------------------------------

/** Which harnesses this version launches and why the others are catalogued only; any MCP client calls. */
export const DELEGATION_HARNESS_SUPPORT: readonly DelegationHarnessSupport[] = [
  {
    caller: 'any MCP client',
    executor: 'supported',
    harness: 'claude-code',
    reason:
      'read-only enforced by harness controls: tools Read, Grep and Glob only, safe mode, plan mode, no settings sources, no MCP servers, no web',
  },
  {
    caller: 'any MCP client',
    executor: 'supported',
    harness: 'codex',
    reason: 'read-only enforced by harness controls: sandbox read-only, approvals never, no MCP servers, no web search',
  },
  {
    caller: 'any MCP client',
    executor: 'not-supported',
    harness: 'opencode',
    reason: 'no per-invocation read-only mode in this version',
  },
  {
    caller: 'any MCP client',
    executor: 'not-supported',
    harness: 'cursor',
    reason: 'no per-invocation read-only mode in this version',
  },
];

const DECLARED_CANDIDATE_PREFIX = 'declared:';

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const boundedText = (text: string): string =>
  text.length <= DELEGATION_QUALIFICATION_BOUNDS.maxText
    ? text
    : `${text.slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxText - 1)}…`;
const boundedList = (values: readonly string[]): string[] =>
  [...new Set(values)].slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxEntries).map(boundedText);

const freshness = (provenance: CandidateProvenance): DelegationRouteStatus['availability']['provenance'] =>
  provenance === 'observed-now' || provenance === 'stale' ? provenance : 'unknown';

const windowScope = (scope: ProviderStatus['windows'][number]['scope']): 'account' | 'model' | 'unknown' => {
  if (scope === 'model') {
    return 'model';
  }
  return scope === 'unknown' ? 'unknown' : 'account';
};

const latestObservationFor = (
  observations: readonly ExecutorObservation[],
  machineId: string | null,
  harness: DelegationExecutorHarness,
): ExecutorObservation | null =>
  observations
    .filter((observation) => observation.harness === harness && observation.machineId === machineId)
    .sort((left, right) => compareText(right.observedAt, left.observedAt))[0] ?? null;

const routeStatusOf = (
  candidate: ReviewCandidate,
  annotations: readonly DelegationRouteAnnotation[],
  observations: readonly ExecutorObservation[],
  defaultMachineId: string | null,
): DelegationRouteStatus | null => {
  if (!candidate.id.startsWith(DECLARED_CANDIDATE_PREFIX) || candidate.accountScope === null) {
    return null;
  }
  const accountScope = candidate.accountScope;
  const annotation = annotations.find(
    (entry) =>
      entry.harness === candidate.harness &&
      entry.accountScope === accountScope &&
      (entry.machineId ?? defaultMachineId) === candidate.machineId,
  );
  const observation = latestObservationFor(observations, candidate.machineId, candidate.harness);
  const quota = candidate.quota;
  return {
    accountScope,
    availability: {
      authMethod: observation?.authMethod ?? null,
      authState: observation?.authState ?? null,
      observedAt: observation?.observedAt ?? null,
      provenance: freshness(candidate.provenance.availability),
      state: candidate.availability,
      version: observation?.version ?? null,
    },
    context: annotation?.context ?? null,
    effort: candidate.effort,
    harness: candidate.harness,
    identity: {
      declared: candidate.identity?.declared ?? null,
      observed: candidate.identity?.observed ?? null,
      observedAt: candidate.identity?.observedAt ?? null,
      state: candidate.identity?.state ?? 'unobserved',
    },
    label: boundedText(
      annotation?.label ?? `${candidate.harness} · ${accountScope} · ${candidate.model ?? 'default model'}`,
    ),
    lastCheckedAt: observation?.observedAt ?? null,
    missing: boundedList(candidate.qualificationActions),
    model: candidate.model,
    poolId: candidate.resourceId ?? candidate.id,
    provider: candidate.harness === 'claude-code' ? 'anthropic' : 'openai',
    quota: {
      observedAt: quota?.generatedAt ?? null,
      provenance: freshness(candidate.provenance.quota),
      windows: (quota?.windows ?? [])
        .filter((window) => quotaWindowAppliesToModel(window, candidate.model))
        .slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxEntries)
        .map((window) => ({
          label: boundedText(window.label),
          remainingPercent: window.remainingPercent ?? (window.usedPercent === null ? null : 100 - window.usedPercent),
          resetsAt: window.resetsAt,
          scope: windowScope(window.scope),
        })),
    },
    routeId: candidate.id,
    subscription: candidate.subscription,
  };
};

type ObservedModelRow = DelegationSettingsView['observedModels'][number];

interface DelegationModelRow {
  readonly entry: DelegationModelEntry;
  readonly observed: { readonly jobs: number; readonly lastSeenAt: string; readonly modelResolved: string } | null;
}

/** Rows with a resolved model first, in text order; `null` (the harness said nothing) last. */
const nullsLast = (left: string | null, right: string | null): number => Number(left === null) - Number(right === null);

const laterInstant = (left: string, right: string): string => (compareText(left, right) >= 0 ? left : right);

/** Models jobs requested and what the harness reported, counted per (harness, requested, resolved); deterministic order, never a ranking. */
const observedModelsOf = (jobs: readonly DelegationJob[]): ObservedModelRow[] => {
  const rows = new Map<string, ObservedModelRow>();
  for (const job of jobs) {
    if (job.executorHarness === null || job.modelRequested === null) {
      continue;
    }
    const key = JSON.stringify([job.executorHarness, job.modelRequested, job.modelResolved]);
    const existing = rows.get(key);
    rows.set(
      key,
      existing === undefined
        ? {
            harness: job.executorHarness,
            jobs: 1,
            lastSeenAt: job.requestedAt,
            modelRequested: job.modelRequested,
            modelResolved: job.modelResolved,
          }
        : { ...existing, jobs: existing.jobs + 1, lastSeenAt: laterInstant(existing.lastSeenAt, job.requestedAt) },
    );
  }
  return [...rows.values()]
    .sort(
      (left, right) =>
        compareText(left.harness, right.harness) ||
        compareText(left.modelRequested, right.modelRequested) ||
        nullsLast(left.modelResolved, right.modelResolved) ||
        compareText(left.modelResolved ?? '', right.modelResolved ?? ''),
    )
    .slice(0, DELEGATION_WEB_BOUNDS.maxListLimit);
};

const modelsOf = (config: DelegationConfig, jobs: readonly DelegationJob[]): readonly DelegationModelRow[] =>
  config.models.map((entry) => {
    const matching = jobs
      .filter(
        (job) =>
          job.modelResolved !== null &&
          job.executorHarness !== null &&
          entry.harnesses.includes(job.executorHarness) &&
          (job.modelRequested === entry.nativeId || (entry.alias !== null && job.modelRequested === entry.alias)),
      )
      .sort((left, right) => compareText(right.requestedAt, left.requestedAt));
    const latest = matching[0];
    return {
      entry,
      observed:
        latest === undefined || latest.modelResolved === null
          ? null
          : { jobs: matching.length, lastSeenAt: latest.requestedAt, modelResolved: latest.modelResolved },
    };
  });

export interface DelegationSettingsInputs {
  readonly declared: DelegationDeclarationsRead;
  readonly jobs: readonly DelegationJob[];
  readonly now: string;
  readonly observations: readonly ExecutorObservation[];
  readonly providers: readonly ProviderStatus[];
}

/**
 * The settings view from its inputs: routes are the declared candidates `qualifyReviewCandidates`
 * sees without a target (so authorization stays unbound and nothing is a decision for a task),
 * annotated with the `delegation.routes[]` context and label.
 */
export const assembleDelegationSettings = (inputs: DelegationSettingsInputs): DelegationSettingsView => {
  const { declared } = inputs;
  const candidates = qualifyReviewCandidates({
    declarations: declared.executors.declarations,
    executorObservations: inputs.observations,
    now: inputs.now,
    providers: inputs.providers,
    target: null,
  });
  const routes = candidates
    .map((candidate) =>
      routeStatusOf(candidate, declared.delegation.config.routes, inputs.observations, declared.machineId),
    )
    .filter((route): route is DelegationRouteStatus => route !== null)
    .slice(0, DELEGATION_QUALIFICATION_BOUNDS.maxRoutes);
  return parseDelegationSettingsView({
    catalogRevision: declared.revisions.catalogRevision,
    configPath: declared.configPath,
    delegation: {
      config: declared.delegation.config,
      issues: declared.delegation.issues.slice(0, DELEGATION_WEB_BOUNDS.maxIssues),
    },
    executors: {
      declarations: declared.executors.declarations,
      issues: declared.executors.issues.slice(0, DELEGATION_WEB_BOUNDS.maxIssues),
    },
    githubAccounts: declared.githubAccounts.map((account) => ({ ghUser: account.ghUser, owner: account.owner })),
    harnesses: DELEGATION_HARNESS_SUPPORT,
    machineId: declared.machineId,
    models: modelsOf(declared.delegation.config, inputs.jobs),
    observedModels: observedModelsOf(inputs.jobs),
    reviewTargets: {
      issues: declared.reviewTargets.issues.slice(0, DELEGATION_WEB_BOUNDS.maxIssues),
      targets: declared.reviewTargets.targets,
    },
    revision: declared.revisions.policyRevision,
    routes,
  });
};

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

export interface DelegationServerOptions {
  readonly mode?: RuntimeMode;
  readonly now?: () => Date;
  readonly readers?: DelegationServerReaders;
  readonly signal?: AbortSignal;
}

const DEMO_TEXT = 'Delegation is not available in the demo.';
const RUNTIME_TEXT = 'Delegation commands are not available in this runtime.';
/** A store older than this version: the query-only reader cannot upgrade it, the engine does at its start. */
export const STORE_NOT_UPGRADED_MESSAGE =
  'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.';
const INCOMPATIBLE_STORE_MESSAGE = 'The usage store is not compatible with this version of the application.';

const demoFailure = (): DelegationFailure => ({ kind: 'forbidden-demo', message: DEMO_TEXT });
const runtimeFailure = (): DelegationFailure => ({
  kind: 'unavailable',
  message: RUNTIME_TEXT,
  reason: 'not-available-in-runtime',
});

/** A classified store read failure (not `store-missing`, which each read treats as its own empty answer). */
const storeReadFailure = (read: DelegationStoreReadFailure, what: string): DelegationFailure => {
  switch (read.kind) {
    case 'store-not-upgraded':
      return { kind: 'incompatible-store', message: STORE_NOT_UPGRADED_MESSAGE };
    case 'incompatible-store':
      return { kind: 'incompatible-store', message: INCOMPATIBLE_STORE_MESSAGE };
    default:
      return {
        kind: 'unavailable',
        message: `${what} could not be read from the usage store.`,
        reason: 'usage-store-unavailable',
      };
  }
};

const nowOf = (options: DelegationServerOptions): string =>
  (options.now ?? options.readers?.now ?? (() => new Date()))().toISOString();

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export const getDelegationSettingsForServer = async (
  options: DelegationServerOptions = {},
): Promise<DelegationOutcome<DelegationSettingsView>> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return demoFailure();
  }
  if (mode === 'e2e') {
    const fixture = await import('./delegation-e2e-fixture.server');
    return delegationOk(await fixture.e2eDelegationSettings());
  }
  const readers = options.readers ?? createDelegationServerReaders();
  const declared = await readers.readDeclarations();
  options.signal?.throwIfAborted();
  const [observations, providers, jobsRead] = await Promise.all([
    readers.readObservations(declared.machineId),
    readers.readQuota(declared.machineId),
    readers.readJobs({ limit: DELEGATION_WEB_BOUNDS.maxListLimit, liveOnly: false }),
  ]);
  options.signal?.throwIfAborted();
  if (jobsRead.kind !== 'ok' && jobsRead.kind !== 'store-missing') {
    return storeReadFailure(jobsRead, 'Delegation jobs');
  }
  return delegationOk(
    assembleDelegationSettings({
      declared,
      jobs: jobsRead.kind === 'ok' ? jobsRead.jobs : [],
      now: nowOf(options),
      observations,
      providers,
    }),
  );
};

const viewEncoder = new TextEncoder();

/**
 * The views one answer carries: the newest first, cut at the tail once the serialized list would
 * pass `DELEGATION_WEB_BOUNDS.maxJobsListBytes` (fifty views of up to 64 KiB would not fit). The
 * jobs left out are counted in `omitted`, never silently dropped.
 */
const boundedJobViews = (
  views: readonly DelegationJobView[],
): { readonly jobs: readonly DelegationJobView[]; readonly omitted: number } => {
  const jobs: DelegationJobView[] = [];
  // The brackets, then each view with its separator.
  let bytes = 2;
  for (const view of views) {
    const size = viewEncoder.encode(JSON.stringify(view)).byteLength + 1;
    if (bytes + size > DELEGATION_WEB_BOUNDS.maxJobsListBytes) {
      break;
    }
    jobs.push(view);
    bytes += size;
  }
  return { jobs, omitted: views.length - jobs.length };
};

export const listDelegationJobsForServer = async (
  input: DelegationJobsInput,
  options: DelegationServerOptions = {},
): Promise<
  DelegationOutcome<{ readonly jobs: readonly DelegationJobView[]; readonly omitted: number; readonly skipped: number }>
> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return demoFailure();
  }
  if (mode === 'e2e') {
    const fixture = await import('./delegation-e2e-fixture.server');
    return delegationOk({ ...(await fixture.e2eDelegationJobs(input)), omitted: 0 });
  }
  const readers = options.readers ?? createDelegationServerReaders();
  const read = await readers.readJobs({
    limit: Math.min(input.limit ?? DELEGATION_WEB_BOUNDS.defaultListLimit, DELEGATION_WEB_BOUNDS.maxListLimit),
    liveOnly: input.liveOnly ?? false,
  });
  options.signal?.throwIfAborted();
  if (read.kind === 'store-missing') {
    return delegationOk({ jobs: [], omitted: 0, skipped: 0 });
  }
  if (read.kind !== 'ok') {
    return storeReadFailure(read, 'Delegation jobs');
  }
  const now = nowOf(options);
  const { jobs, omitted } = boundedJobViews(
    read.jobs.map((job) => projectDelegationJobView(job, read.evaluations, { now })),
  );
  return delegationOk({ jobs, omitted, skipped: read.skipped });
};

export const getDelegationJobForServer = async (
  input: DelegationJobInput,
  options: DelegationServerOptions = {},
): Promise<DelegationOutcome<DelegationJobView>> => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return demoFailure();
  }
  const notFound: DelegationFailure = { kind: 'not-found', message: 'No delegation job has this id.' };
  if (mode === 'e2e') {
    const fixture = await import('./delegation-e2e-fixture.server');
    const job = await fixture.e2eDelegationJob(input.jobId);
    return job === null ? notFound : delegationOk(job);
  }
  const readers = options.readers ?? createDelegationServerReaders();
  const read = await readers.readJob(input.jobId);
  options.signal?.throwIfAborted();
  if (read.kind === 'store-missing' || read.kind === 'not-found') {
    return notFound;
  }
  if (read.kind !== 'ok') {
    return storeReadFailure(read, 'The delegation job');
  }
  return delegationOk(projectDelegationJobView(read.job, read.evaluations, { now: nowOf(options) }));
};

// ---------------------------------------------------------------------------------------------
// Engine commands (one each; the engine decides, this edge relays)
// ---------------------------------------------------------------------------------------------

type DelegationEngineCommand = Extract<
  WebUsageEngineCommand,
  {
    readonly command:
      | 'cancel-delegation'
      | 'qualify-delegation'
      | 'record-delegation-evaluation'
      | 'update-delegation-config';
  }
>;

export type ExecuteDelegationCommand = (
  command: DelegationEngineCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<UsageEngineCommandCompletion>;

const executeDelegationCommand: ExecuteDelegationCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

type CommandOptions = Omit<DelegationServerOptions, 'readers'>;

const completeOrFail = async (
  execute: ExecuteDelegationCommand,
  command: DelegationEngineCommand,
  options: CommandOptions,
  couldNot: string,
): Promise<DelegationFailure | UsageEngineCommandCompletion> => {
  try {
    return await execute(command, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    return { kind: 'engine-unavailable', message: `${couldNot}; it may be stopped or busy.` };
  }
};

const didNotComplete = (what: string): DelegationFailure => ({
  kind: 'unavailable',
  message: `The engine did not complete ${what}.`,
  reason: 'engine-did-not-complete',
});

const modeGate = (options: CommandOptions): DelegationFailure | RuntimeMode => {
  const mode = options.mode ?? getServerRuntimeMode();
  options.signal?.throwIfAborted();
  if (mode === 'demo') {
    return demoFailure();
  }
  return mode;
};

export const saveDelegationSettingsForServer = async (
  input: DelegationSaveSettingsInput,
  execute: ExecuteDelegationCommand = executeDelegationCommand,
  options: CommandOptions = {},
): Promise<DelegationOutcome<DelegationSaveSettingsOutput>> => {
  const mode = modeGate(options);
  if (typeof mode !== 'string') {
    return mode;
  }
  if (mode === 'e2e') {
    const fixture = await import('./delegation-e2e-fixture.server');
    return await fixture.saveE2EDelegationSettings(input);
  }
  const command = parseWebUsageEngineCommand({
    command: 'update-delegation-config',
    expectedRevision: input.expectedRevision,
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
    ...(input.executors === undefined ? {} : { executors: input.executors }),
    ...(input.reviewTargets === undefined ? {} : { reviewTargets: input.reviewTargets }),
  });
  if (command.command !== 'update-delegation-config') {
    throw new Error('Expected a delegation configuration command.');
  }
  const completion = await completeOrFail(execute, command, options, 'The engine could not write the configuration');
  if ('kind' in completion) {
    return completion;
  }
  if (completion.state !== 'succeeded' || completion.command !== 'update-delegation-config') {
    return didNotComplete('the configuration write');
  }
  const { issues, result, revision } = completion.output;
  switch (result) {
    case 'written':
      return delegationOk({ issues: [], result: 'written', revision });
    case 'revision-conflict':
      return {
        kind: 'conflict',
        message: 'The configuration changed since it was read; re-read it and retry.',
        revision,
      };
    default:
      return {
        issues: issues.map((issue) => ({ path: issue.path, reason: issue.reason })),
        kind: 'invalid-input',
        message: 'The engine refused the configuration; the issues name the entries by config path.',
        reason: 'invalid-configuration',
      };
  }
};

const SIMULATION_OBJECTIVE = 'Policy simulation';

/** The request a simulation sends: read-only review, empty criteria and constraints, no client metadata. */
export const simulationRequest = (input: DelegationSimulateInput): DelegationRequest => ({
  action: 'read-only-review',
  checkout: { path: input.checkoutPath },
  constraints: [],
  criteria: [],
  objective: input.objective ?? SIMULATION_OBJECTIVE,
  schemaVersion: 1,
  scope: input.scope,
  taskCategory: input.taskCategory,
});

export const simulateDelegationForServer = async (
  input: DelegationSimulateInput,
  execute: ExecuteDelegationCommand = executeDelegationCommand,
  options: CommandOptions = {},
): Promise<DelegationOutcome<DelegationQualification>> => {
  const mode = modeGate(options);
  if (typeof mode !== 'string') {
    return mode;
  }
  if (mode === 'e2e') {
    const fixture = await import('./delegation-e2e-fixture.server');
    return delegationOk(await fixture.simulateE2EDelegation(input));
  }
  const command = parseWebUsageEngineCommand({
    command: 'qualify-delegation',
    purpose: 'simulation',
    request: { ...simulationRequest(input) },
  });
  if (command.command !== 'qualify-delegation') {
    throw new Error('Expected a delegation qualification command.');
  }
  const completion = await completeOrFail(execute, command, options, 'The engine could not qualify the delegation');
  if ('kind' in completion) {
    return completion;
  }
  if (completion.state !== 'succeeded' || completion.command !== 'qualify-delegation') {
    return didNotComplete('the delegation qualification');
  }
  const qualification = parseDelegationQualification(completion.output.qualification);
  if (qualification === null) {
    return {
      kind: 'unavailable',
      message: 'The engine answered a qualification this version cannot read.',
      reason: 'qualification-unreadable',
    };
  }
  return delegationOk(qualification);
};

export const cancelDelegationForServer = async (
  input: DelegationCancelInput,
  execute: ExecuteDelegationCommand = executeDelegationCommand,
  options: CommandOptions = {},
): Promise<DelegationOutcome<DelegationCancelOutput>> => {
  const mode = modeGate(options);
  if (typeof mode !== 'string') {
    return mode;
  }
  if (mode === 'e2e') {
    return runtimeFailure();
  }
  const command = parseWebUsageEngineCommand({ command: 'cancel-delegation', jobId: input.jobId });
  if (command.command !== 'cancel-delegation') {
    throw new Error('Expected a delegation cancel command.');
  }
  const completion = await completeOrFail(execute, command, options, 'The engine could not record the cancellation');
  if ('kind' in completion) {
    return completion;
  }
  if (completion.state !== 'succeeded' || completion.command !== 'cancel-delegation') {
    return didNotComplete('the cancellation');
  }
  const { jobId, result, state } = completion.output;
  return delegationOk({ jobId, result, state });
};

/** The author of a Web acceptance is the operator, by construction; the label names the edge. */
export const WEB_EVALUATION_AUTHOR = 'operator' as const;
export const WEB_EVALUATION_AUTHOR_LABEL = 'web' as const;

export const recordDelegationAcceptanceForServer = async (
  input: DelegationRecordAcceptanceInput,
  execute: ExecuteDelegationCommand = executeDelegationCommand,
  options: CommandOptions = {},
): Promise<DelegationOutcome<DelegationRecordAcceptanceOutput>> => {
  const mode = modeGate(options);
  if (typeof mode !== 'string') {
    return mode;
  }
  if (mode === 'e2e') {
    return runtimeFailure();
  }
  const command = parseWebUsageEngineCommand({
    author: WEB_EVALUATION_AUTHOR,
    authorLabel: WEB_EVALUATION_AUTHOR_LABEL,
    command: 'record-delegation-evaluation',
    evaluation: {
      kind: 'acceptance',
      verdict: input.verdict,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    jobId: input.jobId,
  });
  if (command.command !== 'record-delegation-evaluation') {
    throw new Error('Expected a delegation evaluation command.');
  }
  const completion = await completeOrFail(execute, command, options, 'The engine could not record the acceptance');
  if ('kind' in completion) {
    return completion;
  }
  if (completion.state !== 'succeeded' || completion.command !== 'record-delegation-evaluation') {
    return didNotComplete('the acceptance');
  }
  const { evaluationId, refusal } = completion.output;
  if (refusal !== null) {
    switch (refusal.reason) {
      case 'not-ended':
        return { kind: 'conflict', message: refusal.message };
      case 'not-found':
        return { kind: 'not-found', message: refusal.message };
      default:
        return { issues: [], kind: 'invalid-input', message: refusal.message, reason: 'invalid-evaluation' };
    }
  }
  if (evaluationId === null) {
    return didNotComplete('the acceptance');
  }
  return delegationOk({ evaluationId });
};

// ---------------------------------------------------------------------------------------------
// Request-bound entry points (mutations validate the trusted local request first)
// ---------------------------------------------------------------------------------------------

const requestOptions = (request: Request, mode: RuntimeMode | undefined): CommandOptions => ({
  ...(mode === undefined ? {} : { mode }),
  signal: request.signal,
});

const trusted = (request: Request): void => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
};

export const saveDelegationSettingsFromRequestForServer = async (
  request: Request,
  input: DelegationSaveSettingsInput,
  execute?: ExecuteDelegationCommand,
  mode?: RuntimeMode,
): Promise<DelegationOutcome<DelegationSaveSettingsOutput>> => {
  trusted(request);
  return await saveDelegationSettingsForServer(input, execute, requestOptions(request, mode));
};

export const simulateDelegationFromRequestForServer = async (
  request: Request,
  input: DelegationSimulateInput,
  execute?: ExecuteDelegationCommand,
  mode?: RuntimeMode,
): Promise<DelegationOutcome<DelegationQualification>> => {
  trusted(request);
  return await simulateDelegationForServer(input, execute, requestOptions(request, mode));
};

export const cancelDelegationFromRequestForServer = async (
  request: Request,
  input: DelegationCancelInput,
  execute?: ExecuteDelegationCommand,
  mode?: RuntimeMode,
): Promise<DelegationOutcome<DelegationCancelOutput>> => {
  trusted(request);
  return await cancelDelegationForServer(input, execute, requestOptions(request, mode));
};

export const recordDelegationAcceptanceFromRequestForServer = async (
  request: Request,
  input: DelegationRecordAcceptanceInput,
  execute?: ExecuteDelegationCommand,
  mode?: RuntimeMode,
): Promise<DelegationOutcome<DelegationRecordAcceptanceOutput>> => {
  trusted(request);
  return await recordDelegationAcceptanceForServer(input, execute, requestOptions(request, mode));
};
