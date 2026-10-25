import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DelegationCancelAnswer,
  DelegationQualification,
  DelegationRequest,
  DelegationRoute,
  DelegationSelection,
  DelegationStartAnswer,
} from '@ai-usage/report-core/delegation-contracts';
import { type DelegationJobView, projectDelegationJobView } from '@ai-usage/report-core/delegation-job';
import { parseDelegationQualification } from '@ai-usage/report-core/delegation-qualification';
import { parseDelegationRequest } from '@ai-usage/report-core/delegation-request';
import { DELEGATION_DEPTH_ENVIRONMENT_KEY, DELEGATION_LIVE_STATES } from '@ai-usage/report-core/delegation-vocabulary';
import {
  connectDelegationEngine,
  createDelegationCommands,
  type DelegationCommandExecutor,
  type DelegationOperationErrorCode,
  type DelegationOperationResult,
} from '@ai-usage/usage-engine-control/delegation-operations';
import {
  type DelegationStoreReadFailure,
  readDelegationJob,
  readDelegationJobs,
  USAGE_STORE_SCHEMA_VERSION,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import type { CliCommand, DelegationSelectionArgs } from './cli';
import type { CliRuntime } from './runtime';

/**
 * `ai-usage delegation …` (ADR 0077). Qualify, start and cancel are engine commands and go only to a
 * running daemon: the CLI's foreground one-shot engine would terminate the workers it launched when
 * it quiesced, so no fallback exists here and a missing engine is said plainly. Status and list read
 * the store through the query-only reader facade and never contact an engine (the CLI may import
 * the usage-store reader and report-core, not the report-data delegation read the MCP server uses;
 * both project the same `DelegationJobView`). The CLI records no evaluation in this version: a
 * verification is the calling model's (MCP), an acceptance the operator's (Web). Inside a delegated
 * worker (`AI_USAGE_DELEGATION_DEPTH` set) qualify and start answer `recursive-delegation` before
 * any request is read or any engine contacted, as the MCP edge does: a worker never delegates.
 */

/** A request file is one bounded JSON document; the bound matches the control plane's command bound. */
export const DELEGATION_REQUEST_MAX_BYTES = 64 * 1024;

/** The selector the CLI records when the operator names a route or abstains by hand. */
export const CLI_DELEGATION_SELECTOR_VERSION = 'operator/ai-usage-cli';

/** Jobs one `delegation list` answer carries at most. */
export const DELEGATION_LIST_MAX_LIMIT = 50;

export type DelegationCliCommand = Extract<CliCommand, { readonly _tag: `Delegation${string}` }>;

export const isDelegationCliCommand = (command: CliCommand): command is DelegationCliCommand =>
  command._tag.startsWith('Delegation');

export type CliDelegationErrorCode =
  | DelegationOperationErrorCode
  | 'incompatible-store'
  | 'invalid-request'
  | 'not-found'
  | 'recursive-delegation'
  | 'request-too-large'
  | 'request-unreadable'
  | 'store-missing'
  | 'store-not-upgraded'
  | 'unsupported-request';

/** A typed, path-free failure of a delegation command; the message is what the operator reads. */
export class CliDelegationError extends Error {
  readonly code: CliDelegationErrorCode;
  override readonly name = 'CliDelegationError';

  constructor(code: CliDelegationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface CliDelegationDependencies {
  /** Finds the running daemon engine; it never starts one. */
  readonly connect: (signal: AbortSignal) => Promise<DelegationCommandExecutor>;
  readonly dbPath: string;
  /** The process environment: `AI_USAGE_DELEGATION_DEPTH` in it marks this process as a delegated worker. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: () => string;
  /** Request file paths resolve against the operator's working directory. */
  readonly operatorCwd: string;
  readonly readStdin: () => Promise<Uint8Array>;
  readonly signal: AbortSignal;
}

export interface DelegationJobList {
  readonly jobs: readonly DelegationJobView[];
  /** Persisted rows that no longer pass validation; counted, never silently omitted. */
  readonly skipped: number;
  readonly truncated: boolean;
}

const ENGINE_MESSAGES: Readonly<Record<DelegationOperationErrorCode, string>> = {
  cancelled: 'The delegation command was cancelled.',
  'engine-busy': 'The usage engine is busy; retry shortly.',
  'engine-unavailable':
    'No usage engine is running for this store. Delegation commands never start one: start the engine (bun run start) and retry.',
  'invalid-input': 'The usage engine refused the delegation command as invalid.',
  unavailable: 'The usage engine could not answer the delegation command.',
};

const readBoundedStream = async (stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new CliDelegationError('request-too-large', `The delegation request exceeds ${maximumBytes / 1024} KiB.`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Standard input, bounded like a request file. */
export const readStdinBounded = (): Promise<Uint8Array> =>
  readBoundedStream(Bun.stdin.stream(), DELEGATION_REQUEST_MAX_BYTES);

export const liveCliDelegationDependencies = (runtime: CliRuntime): CliDelegationDependencies => ({
  connect: (signal) =>
    connectDelegationEngine({
      configCwd: runtime.paths.configCwd,
      expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
      runtimePaths: {
        databasePath: runtime.paths.databasePath,
        rendezvousPath: path.join(runtime.paths.stateDirectory, 'rendezvous.json'),
      },
      signal,
    }),
  dbPath: runtime.paths.databasePath,
  environment: process.env,
  now: () => new Date().toISOString(),
  operatorCwd: runtime.paths.operatorCwd,
  readStdin: readStdinBounded,
  signal: runtime.signal,
});

/**
 * A delegated worker never delegates: with the depth variable set, qualify and start are refused
 * before the request is read or an engine is looked for, exactly as the MCP edge refuses them.
 */
const refuseRecursiveDelegation = (dependencies: Pick<CliDelegationDependencies, 'environment'>): void => {
  if (DELEGATION_DEPTH_ENVIRONMENT_KEY in dependencies.environment) {
    throw new CliDelegationError(
      'recursive-delegation',
      `This process runs as a delegated worker (${DELEGATION_DEPTH_ENVIRONMENT_KEY} is set); a worker never delegates. Keep the task.`,
    );
  }
};

/**
 * The request document from a file or standard input (`-`): bounded before it is decoded, parsed
 * strictly, with the parser's issue paths (never values) in the error.
 */
export const readDelegationRequestSource = async (
  source: string,
  dependencies: Pick<CliDelegationDependencies, 'operatorCwd' | 'readStdin'>,
): Promise<DelegationRequest> => {
  let bytes: Uint8Array;
  if (source === '-') {
    bytes = await dependencies.readStdin();
  } else {
    try {
      bytes = new Uint8Array(await readFile(path.resolve(dependencies.operatorCwd, source)));
    } catch (error) {
      throw new CliDelegationError('request-unreadable', `The delegation request file could not be read: ${source}`, {
        cause: error,
      });
    }
    if (bytes.byteLength > DELEGATION_REQUEST_MAX_BYTES) {
      throw new CliDelegationError(
        'request-too-large',
        `The delegation request exceeds ${DELEGATION_REQUEST_MAX_BYTES / 1024} KiB.`,
      );
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new CliDelegationError('request-unreadable', 'The delegation request is not a UTF-8 JSON document.', {
      cause: error,
    });
  }
  const parsed = parseDelegationRequest(value);
  if (parsed.kind === 'ok') {
    return parsed.request;
  }
  if (parsed.kind === 'unsupported') {
    throw new CliDelegationError('unsupported-request', `${parsed.reason}: ${parsed.message}`);
  }
  const issues = parsed.issues.map(({ path: where, reason }) => `${where === '' ? 'request' : where}: ${reason}`);
  throw new CliDelegationError('invalid-request', `The delegation request is invalid:\n  ${issues.join('\n  ')}`);
};

const selectionOf = (qualificationId: string, args: DelegationSelectionArgs): DelegationSelection =>
  args.kind === 'route'
    ? {
        ...(args.confidence === null ? {} : { confidence: args.confidence }),
        kind: 'choice',
        qualificationId,
        routeId: args.routeId,
        selectorVersion: args.selectorVersion,
      }
    : { kind: 'abstain', qualificationId, reason: args.reason, selectorVersion: CLI_DELEGATION_SELECTOR_VERSION };

const unwrapEngine = <Value>(result: DelegationOperationResult<Value>): Value => {
  if (result.kind === 'error') {
    throw new CliDelegationError(result.code, ENGINE_MESSAGES[result.code]);
  }
  return result.value;
};

const engineCommands = (dependencies: CliDelegationDependencies) =>
  createDelegationCommands({
    execute: async (command, signal) => {
      const execute = await dependencies.connect(signal ?? dependencies.signal);
      return await execute(command, signal);
    },
  });

// ---------------------------------------------------------------------------------------------
// Store reads (query-only; no engine)
// ---------------------------------------------------------------------------------------------

/** A store read failure as the operator reads it: typed, fixed wording, no path. */
const storeReadError = (read: DelegationStoreReadFailure): CliDelegationError => {
  switch (read.kind) {
    case 'store-missing':
      return new CliDelegationError(
        'store-missing',
        'No usage store exists yet; the usage engine creates it on its first run.',
      );
    case 'store-not-upgraded':
      return new CliDelegationError(
        'store-not-upgraded',
        'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.',
      );
    case 'incompatible-store':
      return new CliDelegationError(
        'incompatible-store',
        'The usage store is not compatible with this version of ai-usage.',
      );
    default:
      return new CliDelegationError('unavailable', 'The delegation jobs could not be read from the usage store.');
  }
};

const runStoreRead = async <Read>(
  dependencies: CliDelegationDependencies,
  effect: Effect.Effect<Read>,
): Promise<Read> => {
  if (dependencies.signal.aborted) {
    throw new CliDelegationError('cancelled', ENGINE_MESSAGES.cancelled);
  }
  try {
    return await Effect.runPromise(effect, { signal: dependencies.signal });
  } catch (error) {
    if (dependencies.signal.aborted) {
      throw new CliDelegationError('cancelled', ENGINE_MESSAGES.cancelled, { cause: error });
    }
    throw error;
  }
};

const readJobView = async (dependencies: CliDelegationDependencies, jobId: string): Promise<DelegationJobView> => {
  const read = await runStoreRead(dependencies, readDelegationJob({ dbPath: dependencies.dbPath, jobId }));
  if (read.kind === 'not-found') {
    throw new CliDelegationError('not-found', 'No delegation job has this id.');
  }
  if (read.kind !== 'ok') {
    throw storeReadError(read);
  }
  return projectDelegationJobView(read.job, read.evaluations, { now: dependencies.now() });
};

const listJobViews = async (
  dependencies: CliDelegationDependencies,
  options: { readonly limit: number | null; readonly live: boolean },
): Promise<DelegationJobList> => {
  const read = await runStoreRead(
    dependencies,
    readDelegationJobs({
      dbPath: dependencies.dbPath,
      limit: options.limit ?? 20,
      ...(options.live ? { states: DELEGATION_LIVE_STATES } : {}),
    }),
  );
  if (read.kind !== 'ok') {
    throw storeReadError(read);
  }
  const now = dependencies.now();
  return {
    jobs: read.jobs.map((job) => projectDelegationJobView(job, read.evaluations, { now })),
    skipped: read.skipped,
    truncated: read.truncated,
  };
};

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const orDash = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '—' : String(value);

const short = (sha: string): string => sha.slice(0, 12);

const routeLine = (route: DelegationRoute): string[] => {
  const model = `${route.harness}/${route.model ?? 'model unknown'}${route.effort === null ? '' : ` ${route.effort}`}`;
  const context = route.context ?? 'context undeclared';
  const head = `  - ${route.routeId}  ${model} · ${context} · pool ${route.poolId}${
    route.orderHint === null ? '' : ` · tie-break ${route.orderHint}`
  }`;
  return [
    head,
    ...route.advantages.map((advantage) => `      + ${advantage}`),
    ...route.limits.map((limit) => `      - ${limit}`),
    ...(route.admissible
      ? []
      : [`      excluded (${route.blockers.join(', ')}): ${[...route.exclusions, ...route.missing].join('; ')}`]),
  ];
};

export const renderDelegationQualification = (qualification: DelegationQualification, json: boolean): string => {
  if (json) {
    return JSON.stringify(qualification, null, 2);
  }
  const admissible = qualification.routes.filter((route) => route.admissible);
  const excluded = qualification.routes.filter((route) => !route.admissible);
  const { checkout, scope, versions } = qualification;
  return [
    `Qualification ${qualification.qualificationId} (${qualification.purpose}) · ${qualification.outcome}`,
    `Valid until ${qualification.validUntil} · policy ${versions.policyRevision} · catalog ${versions.catalogRevision}`,
    checkout === null
      ? 'Checkout: not resolved'
      : `Checkout: ${checkout.path} (admitted by ${checkout.admittedBy ?? 'no review target'})`,
    scope === null
      ? 'Scope: not frozen'
      : `Scope: ${scope.kind} ${short(scope.baseSha)}..${short(scope.headSha)} (${scope.commitCount} commit${scope.commitCount === 1 ? '' : 's'})`,
    ...(qualification.refusal === null
      ? []
      : [`Refusal: ${qualification.refusal.reason} — ${qualification.refusal.message}`]),
    `Admissible routes (${admissible.length}) — choose by judgment of the task; the tie-break is not a judgment:`,
    ...(admissible.length === 0 ? ['  none'] : admissible.flatMap(routeLine)),
    `Excluded routes (${excluded.length}${qualification.omittedRoutes > 0 ? `, ${qualification.omittedRoutes} more not shown` : ''}):`,
    ...(excluded.length === 0 ? ['  none'] : excluded.flatMap(routeLine)),
    ...(qualification.appliedRules.length === 0
      ? []
      : [
          'Rules applied:',
          ...qualification.appliedRules.map(
            (rule) => `  - ${rule.id} (${rule.effect}${rule.applies === 'assumed' ? ', assumed' : ''}): ${rule.reason}`,
          ),
        ]),
    ...(qualification.assumptions.length === 0
      ? []
      : ['Assumptions:', ...qualification.assumptions.map((assumption) => `  - ${assumption}`)]),
  ].join('\n');
};

export const renderDelegationStart = (answer: DelegationStartAnswer, json: boolean): string => {
  if (json) {
    return JSON.stringify(answer, null, 2);
  }
  if (answer.job === null) {
    return answer.refusal === null
      ? 'Refused without a reason.'
      : `Refused: ${answer.refusal.reason} — ${answer.refusal.message}`;
  }
  return `Job ${answer.job.jobId} · ${answer.job.state}${
    answer.job.reused ? ' (reused: an earlier submission carried this key)' : ''
  }\nFollow it with: ai-usage delegation status ${answer.job.jobId}`;
};

const routeSummary = (view: DelegationJobView): string => {
  if (view.route === null) {
    return view.state === 'abstained' ? 'none (abstained)' : 'none';
  }
  const { route } = view;
  return `${route.routeId} (${route.harness ?? 'harness unknown'} ${route.modelRequested ?? 'model unknown'} → ${route.modelResolved}${
    route.context === null ? '' : `, ${route.context}`
  })`;
};

const resultSummary = (view: DelegationJobView): string => {
  if (view.result === null) {
    return 'none yet';
  }
  const { result } = view;
  const findings = `${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}`;
  if (result.summary !== null) {
    return `${result.kind} — ${result.summary} (${findings})`;
  }
  return result.excerpt === null ? result.kind : `${result.kind} — ${result.excerpt}`;
};

/** One job as the operator reads it: state and route first, then the three facts, each on its own line. */
export const renderDelegationJob = (view: DelegationJobView, json: boolean): string => {
  if (json) {
    return JSON.stringify(view, null, 2);
  }
  return [
    `Job ${view.jobId} · ${view.state}${view.live ? ` (heartbeat ${orDash(view.heartbeatAgeSeconds)} s ago)` : ''}`,
    `Requested ${view.requestedAt} · started ${orDash(view.startedAt)} · ended ${orDash(view.endedAt)}`,
    `Request: ${view.request.action} · ${view.request.taskCategory} · ${view.request.checkoutPath} · ${
      view.request.scope.kind === 'commit'
        ? `commit ${view.request.scope.commit}`
        : `range ${view.request.scope.base}..${view.request.scope.head}`
    }`,
    `Route: ${routeSummary(view)}`,
    `Executed: ${view.status.executed}`,
    `Verified: ${view.status.verified}`,
    `Accepted: ${view.status.accepted}`,
    `Result: ${resultSummary(view)}`,
    ...(view.refusal === null ? [] : [`Refusal: ${view.refusal.reason} — ${view.refusal.message}`]),
    ...(view.failure === null ? [] : [`Failure: ${view.failure}`]),
    ...(view.cancelRequestedAt === null ? [] : [`Cancel requested ${view.cancelRequestedAt}`]),
    ...view.notes.map((note) => `  · ${note}`),
  ].join('\n');
};

export const renderDelegationList = (list: DelegationJobList, json: boolean): string => {
  if (json) {
    return JSON.stringify(list, null, 2);
  }
  const rows = list.jobs.map(
    (view) =>
      `${view.jobId}  ${view.state.padEnd(9)}  ${view.requestedAt}  ${routeSummary(view)}  executed=${view.status.executed} verified=${view.status.verified} accepted=${view.status.accepted}`,
  );
  return [
    `Delegation jobs (${list.jobs.length}${list.truncated ? ', more not shown' : ''}${
      list.skipped > 0 ? `, ${list.skipped} stored row${list.skipped === 1 ? '' : 's'} not readable` : ''
    })`,
    ...(rows.length === 0 ? ['  none'] : rows),
  ].join('\n');
};

export const renderDelegationCancel = (answer: DelegationCancelAnswer, json: boolean): string =>
  json
    ? JSON.stringify(answer, null, 2)
    : `Cancel ${answer.jobId}: ${answer.result}${answer.state === null ? '' : ` (state ${answer.state})`}`;

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** Runs one `delegation` subcommand and returns what to print on stdout. */
export const runDelegationCliCommand = async (
  command: DelegationCliCommand,
  dependencies: CliDelegationDependencies,
): Promise<string> => {
  switch (command._tag) {
    case 'DelegationQualify': {
      refuseRecursiveDelegation(dependencies);
      const request = await readDelegationRequestSource(command.args.request, dependencies);
      const envelope = unwrapEngine(
        await engineCommands(dependencies).qualify(
          request,
          command.args.simulation ? 'simulation' : 'delegation',
          dependencies.signal,
        ),
      );
      // The control plane typed the envelope; the full qualification is trusted only once parsed.
      const qualification = parseDelegationQualification(envelope);
      if (qualification === null) {
        throw new CliDelegationError(
          'unavailable',
          'The usage engine answered a qualification this version cannot read.',
        );
      }
      return renderDelegationQualification(qualification, command.args.json);
    }
    case 'DelegationStart': {
      refuseRecursiveDelegation(dependencies);
      const request = await readDelegationRequestSource(command.args.request, dependencies);
      const answer = unwrapEngine(
        await engineCommands(dependencies).start(
          {
            idempotencyKey: command.args.key,
            request,
            selection: selectionOf(command.args.qualification, command.args.selection),
          },
          dependencies.signal,
        ),
      );
      return renderDelegationStart(answer, command.args.json);
    }
    case 'DelegationStatus':
      // A stored read: the store opens read-only, no engine starts, none is contacted.
      return renderDelegationJob(await readJobView(dependencies, command.args.jobId), command.args.json);
    case 'DelegationList':
      return renderDelegationList(
        await listJobViews(dependencies, { limit: command.args.limit, live: command.args.live }),
        command.args.json,
      );
    default: {
      const answer = unwrapEngine(await engineCommands(dependencies).cancel(command.args.jobId, dependencies.signal));
      return renderDelegationCancel(answer, command.args.json);
    }
  }
};
