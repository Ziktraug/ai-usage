import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readLocalGitRepository } from '@ai-usage/local-machine/local-git';
import type { CheckoutObservationResult, LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import {
  type Checkout,
  type CheckoutId,
  createProjectId,
  createRepositoryAliasId,
  createRepositoryId,
  type DeviceId,
  type Instant,
  instantNow,
  type ProjectId,
  type RepositoryId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  type RepositoryResolution,
  type RepositoryResolutionCandidate,
  resolveObservedRepository,
} from '@ai-usage/project-registry/resolution';
import { projectSourceId, projectSourcePathFromId } from '@ai-usage/report-core/project-group';
import type { SessionVcsRepository } from '@ai-usage/report-core/session-vcs';
import type { UsageEngineRuntime } from '@ai-usage/usage-engine-runtime';
import {
  type CurrentServedLocalProjectSources,
  queryCurrentServedLocalProjectSources,
  queryUsageLocalMachine,
  type ServedLocalProjectSource,
  type UsageStoreError,
  usageStoreErrorReasonFrom,
} from '@ai-usage/usage-store/reader';
import { Effect, Either } from 'effect';

/** Surfaces the typed store failure itself rather than Effect's fiber wrapper. */
const runStoreQuery = <Value>(
  query: Effect.Effect<Value, UsageStoreError>,
  signal: AbortSignal | undefined,
): Promise<Either.Either<Value, UsageStoreError>> => Effect.runPromise(Effect.either(query), { signal });

/**
 * Local Checkout observation: the producer that turns the usage store's local
 * Project sources (this machine, one absolute path each) into Device-local
 * Checkouts in the Memory store, resolves each new Checkout against known
 * Repositories, and acknowledges each published Project source against its
 * stable Project and Checkout identities.
 *
 * The projection publishes a linked worktree under its parent repository's
 * project source id while keeping the physical path, so each run observes the
 * canonical paths first (the parent even when no session ran there) and then
 * the worktrees, which follow their canonical Checkout's Repository Project.
 *
 * Policy (ADR 0044): a Checkout whose `origin` remote resolves or creates one
 * Repository binds to that Repository's Project without review; a Checkout
 * without a remote becomes a local Project named after its directory; only an
 * ambiguous remote waits in the `/projects` resolution review. A path that is
 * missing on disk is recorded as `missing` and never resolved until it is seen
 * again. An unbound, unreviewed Checkout is resolved again when its observed
 * remote changes; a bound or reviewed one keeps its decision, except that a
 * remote-less worktree bound to its own local Project is relinked to its
 * canonical Checkout's Repository Project (the repair for stores written
 * before canonical observation existed).
 */

export interface CheckoutObservationSummary {
  readonly ambiguous: number;
  readonly created: number;
  readonly invalid: number;
  readonly mapped: number;
  readonly missing: number;
  readonly observed: number;
  readonly resolved: number;
  readonly revision: string;
}

export type CheckoutObservationDiagnostic =
  | { readonly code: 'observed'; readonly summary: CheckoutObservationSummary }
  | { readonly code: 'no-publication' }
  | { readonly code: 'failed'; readonly reason: string };

export interface ObserveLocalCheckoutsOptions {
  readonly clock?: () => Date;
  readonly databasePath: string;
  readonly kernel: LocalIdentityKernel;
  /** Defaults to the usage engine's bounded `.git/config` reader. */
  readonly readRepository?: (localPath: string) => SessionVcsRepository | null;
  /** Defaults to a directory `stat`; anything else is `missing`. */
  readonly readStatus?: (localPath: string) => Promise<'available' | 'missing'>;
}

const maximumDisplayNameLength = 256;

const directoryStatus = async (localPath: string): Promise<'available' | 'missing'> => {
  try {
    return (await stat(localPath)).isDirectory() ? 'available' : 'missing';
  } catch {
    return 'missing';
  }
};

const localProjectDisplayName = (localPath: string, source: ServedLocalProjectSource): string => {
  const basename = path.basename(localPath).trim();
  const name = basename.length > 0 ? basename : source.project.trim();
  return (name.length > 0 ? name : 'Local project').slice(0, maximumDisplayNameLength);
};

const repositoryDisplayName = (candidate: RepositoryResolutionCandidate): string => {
  const { canonicalName, canonicalOwner } = candidate.repository;
  return (canonicalOwner === null ? canonicalName : `${canonicalOwner}/${canonicalName}`).slice(
    0,
    maximumDisplayNameLength,
  );
};

/** A path the engine can open as a Checkout: absolute and NUL-free. */
const usableLocalPath = (value: string): boolean => path.isAbsolute(value) && !value.includes('\0');

interface CanonicalCheckoutPlan {
  /** Published ids, verbatim, that decode to this path and retain their exact identity mapping. */
  readonly mappingIds: Set<string>;
  readonly source: ServedLocalProjectSource;
}

interface WorktreeCheckoutPlan {
  readonly canonicalPath: string;
  readonly source: ServedLocalProjectSource;
}

interface CheckoutObservationPlan {
  readonly canonical: ReadonlyMap<string, CanonicalCheckoutPlan>;
  readonly worktrees: ReadonlyMap<string, WorktreeCheckoutPlan>;
}

/** The published id and the canonical path it decodes to, when the projection published a usable one. */
const publishedCanonicalSource = (
  source: ServedLocalProjectSource,
  machineId: string,
): { readonly canonicalPath: string; readonly mappingId: string } | null => {
  if (source.projectSourceId === null) {
    return null;
  }
  const publishedPath = projectSourcePathFromId(source.projectSourceId, machineId);
  if (publishedPath === null || !usableLocalPath(publishedPath)) {
    return null;
  }
  return { canonicalPath: path.resolve(publishedPath), mappingId: source.projectSourceId };
};

/**
 * Groups this Device's published sources by canonical path, in stable source
 * order. A worktree is any physical path whose published id decodes to a
 * different path; a source without a usable published id is its own canonical
 * path under today's `machineId|path` id. `path.resolve` collapses trailing
 * separators so `/a/b/` and `/a/b` share one Checkout.
 */
const planCheckouts = (sources: readonly ServedLocalProjectSource[], machineId: string): CheckoutObservationPlan => {
  const canonical = new Map<string, CanonicalCheckoutPlan>();
  const worktrees = new Map<string, WorktreeCheckoutPlan>();
  for (const source of sources) {
    if (source.machineId !== machineId || !usableLocalPath(source.sourcePath)) {
      continue;
    }
    const localPath = path.resolve(source.sourcePath);
    const published = publishedCanonicalSource(source, machineId);
    const canonicalPath = published?.canonicalPath ?? localPath;
    const mappingId =
      published?.mappingId ?? projectSourceId({ machineId, project: source.project, sourcePath: localPath });
    const entry = canonical.get(canonicalPath);
    if (entry === undefined) {
      canonical.set(canonicalPath, { mappingIds: new Set([mappingId]), source });
    } else {
      entry.mappingIds.add(mappingId);
    }
    if (localPath !== canonicalPath && !worktrees.has(localPath)) {
      worktrees.set(localPath, { canonicalPath, source });
    }
  }
  return { canonical, worktrees };
};

const needsResolution = (observed: CheckoutObservationResult): boolean =>
  observed.checkout.projectId === null &&
  observed.checkout.status === 'available' &&
  observed.resolutionReviewedAt === null &&
  (observed.outcome !== 'unchanged' || observed.resolutionStatus === 'unassigned');

/** What a Checkout is bound to after this run touched it. */
interface CheckoutBinding {
  readonly projectId: ProjectId;
  readonly repositoryId: RepositoryId | null;
}

interface RepositoryBinding extends CheckoutBinding {
  readonly repositoryId: RepositoryId;
}

const checkoutBinding = (checkout: Checkout): CheckoutBinding | null =>
  checkout.projectId === null ? null : { projectId: checkout.projectId, repositoryId: checkout.repositoryId };

/** A worktree only follows a canonical Checkout that is bound to a Repository Project through its own Repository. */
const repositoryBinding = (binding: CheckoutBinding | null | undefined): RepositoryBinding | null =>
  binding === undefined || binding === null || binding.repositoryId === null
    ? null
    : { projectId: binding.projectId, repositoryId: binding.repositoryId };

/**
 * The repair for stores written before canonical observation: a worktree the
 * earlier runtime auto-bound to its own remote-less local Project moves to its
 * canonical Checkout's Repository Project. A Checkout with an observed remote
 * or a Repository is never touched. Operator review only ever happens for a
 * remote-bearing ambiguous Checkout, so this rule cannot undo a decision while
 * that remote is still observed; bindings carry no provenance, so a reviewed
 * Checkout whose remote later reads as absent is indistinguishable from an
 * automatic one. The superseded local Project is left in place, unmapped.
 */
const needsRepair = (checkout: Checkout, canonical: RepositoryBinding): boolean =>
  checkout.projectId !== null &&
  checkout.projectId !== canonical.projectId &&
  checkout.status === 'available' &&
  checkout.repositoryId === null &&
  checkout.observedRemote === null;

type MutableCheckoutObservationSummary = {
  -readonly [Key in keyof CheckoutObservationSummary]: CheckoutObservationSummary[Key];
};

interface ResolutionContext {
  readonly candidates: () => Promise<readonly RepositoryResolutionCandidate[]>;
  readonly invalidate: () => void;
  readonly kernel: LocalIdentityKernel;
  readonly now: Instant;
  readonly spaceId: SpaceId;
}

interface RunContext extends ResolutionContext {
  readonly deviceId: DeviceId;
  readonly readRepository: (localPath: string) => SessionVcsRepository | null;
  readonly readStatus: (localPath: string) => Promise<'available' | 'missing'>;
  readonly summary: MutableCheckoutObservationSummary;
}

const bindRepositoryProject = async (
  context: ResolutionContext,
  checkoutId: CheckoutId,
  repositoryId: RepositoryId,
): Promise<ProjectId> => {
  const candidate = (await context.candidates()).find((entry) => entry.repository.id === repositoryId);
  if (candidate === undefined) {
    throw new Error('Resolved repository is not a known candidate');
  }
  let project = await context.kernel.findProjectByRepository(context.spaceId, repositoryId, null);
  if (project === null) {
    const projectId = createProjectId();
    await context.kernel.createProject({
      displayName: repositoryDisplayName(candidate),
      id: projectId,
      kind: 'repository',
      owningSpaceId: context.spaceId,
      repositoryId,
      repositorySubpath: null,
      status: 'active',
    });
    project = await context.kernel.findProjectByRepository(context.spaceId, repositoryId, null);
    if (project === null) {
      throw new Error('Created repository Project could not be read back');
    }
  }
  await context.kernel.applyResolutionAction({
    checkoutId,
    kind: 'link',
    projectId: project.id,
    repositoryId,
    spaceId: context.spaceId,
  });
  return project.id;
};

const createCandidateRepository = async (
  context: ResolutionContext,
  resolution: Extract<RepositoryResolution, { kind: 'candidate' }>,
): Promise<RepositoryId> => {
  const repositoryId = createRepositoryId();
  await context.kernel.createRepositoryWithAlias(
    {
      canonicalHost: resolution.canonicalHost,
      canonicalName: resolution.canonicalName,
      canonicalOwner: resolution.canonicalOwner,
      id: repositoryId,
      owningSpaceId: context.spaceId,
      provider: resolution.provider,
      providerRepositoryId: null,
      status: 'active',
    },
    {
      firstObservedAt: context.now,
      id: createRepositoryAliasId(),
      lastObservedAt: context.now,
      normalizedRemote: resolution.normalizedRemote,
      owningSpaceId: context.spaceId,
      repositoryId,
      source: 'local-git',
    },
  );
  context.invalidate();
  return repositoryId;
};

type ResolutionOutcome = ({ kind: 'bound' } & CheckoutBinding) | { kind: 'ambiguous' } | { kind: 'invalid' };

const resolveCheckout = async (
  context: ResolutionContext,
  observed: CheckoutObservationResult,
  /** The remote as read from the working tree; the stored one is already an alias key. */
  observedRemote: string | null,
  source: ServedLocalProjectSource,
): Promise<ResolutionOutcome> => {
  const { checkout } = observed;
  const resolution = resolveObservedRepository(
    {
      deviceId: checkout.deviceId,
      localPath: checkout.localPath,
      observedRemote,
      repositorySubpath: null,
      spaceId: context.spaceId,
      verifiedProviderRepository: null,
    },
    await context.candidates(),
  );
  switch (resolution.kind) {
    case 'invalid':
      return { kind: 'invalid' };
    case 'ambiguous':
      await context.kernel.recordRepositoryResolution(context.spaceId, checkout.id, resolution);
      return { kind: 'ambiguous' };
    case 'unassigned': {
      const result = await context.kernel.applyResolutionAction({
        checkoutId: checkout.id,
        displayName: localProjectDisplayName(checkout.localPath, source),
        kind: 'create-project',
        spaceId: context.spaceId,
      });
      if (result.kind !== 'project-created') {
        throw new Error('Local Project creation returned an unexpected result');
      }
      return { kind: 'bound', projectId: result.projectId, repositoryId: null };
    }
    case 'candidate': {
      const repositoryId = await createCandidateRepository(context, resolution);
      return {
        kind: 'bound',
        projectId: await bindRepositoryProject(context, checkout.id, repositoryId),
        repositoryId,
      };
    }
    case 'resolved':
      return {
        kind: 'bound',
        projectId: await bindRepositoryProject(context, checkout.id, resolution.repositoryId),
        repositoryId: resolution.repositoryId,
      };
    default:
      return resolution satisfies never;
  }
};

interface ObservedCheckout {
  readonly observed: CheckoutObservationResult;
  /** The remote as read from the working tree; the stored one is already an alias key. */
  readonly observedRemote: string | null;
}

const observeCheckoutPath = async (run: RunContext, localPath: string): Promise<ObservedCheckout> => {
  const status = await run.readStatus(localPath);
  const repository = status === 'available' ? run.readRepository(localPath) : null;
  const observedRemote = repository === null ? null : `https://${repository.host}/${repository.ownerPath}`;
  const observed = await run.kernel.observeCheckout(run.spaceId, {
    deviceId: run.deviceId,
    lastObservedAt: run.now,
    localPath,
    observedRemote,
    status,
  });
  run.summary.observed += 1;
  if (observed.outcome === 'created') {
    run.summary.created += 1;
  }
  if (status === 'missing') {
    run.summary.missing += 1;
  }
  return { observed, observedRemote };
};

/** Resolves a Checkout on its own remote; null when it stays unbound (ambiguous or invalid). */
const resolveOwnCheckout = async (
  run: RunContext,
  { observed, observedRemote }: ObservedCheckout,
  source: ServedLocalProjectSource,
): Promise<CheckoutBinding | null> => {
  const outcome = await resolveCheckout(run, observed, observedRemote, source);
  switch (outcome.kind) {
    case 'bound':
      run.summary.resolved += 1;
      return outcome;
    case 'ambiguous':
      run.summary.ambiguous += 1;
      return null;
    case 'invalid':
      run.summary.invalid += 1;
      return null;
    default:
      return outcome satisfies never;
  }
};

const linkCheckout = async (
  run: RunContext,
  checkoutId: CheckoutId,
  binding: RepositoryBinding,
): Promise<CheckoutBinding> => {
  await run.kernel.applyResolutionAction({
    checkoutId,
    kind: 'link',
    projectId: binding.projectId,
    repositoryId: binding.repositoryId,
    spaceId: run.spaceId,
  });
  run.summary.resolved += 1;
  return binding;
};

const acknowledgeMapping = async (
  run: RunContext,
  sourceId: string,
  binding: CheckoutBinding,
  checkoutId: CheckoutId,
): Promise<void> => {
  const mapping = await run.kernel.findProjectSourceMapping(run.spaceId, sourceId);
  if (mapping === null || mapping.projectId !== binding.projectId || mapping.checkoutId !== checkoutId) {
    await run.kernel.acknowledgeProjectSourceMapping(
      { acknowledgedAt: run.now, checkoutId, projectId: binding.projectId, projectSourceId: sourceId },
      run.spaceId,
    );
    run.summary.mapped += 1;
  }
};

export const observeLocalCheckouts = async (
  options: ObserveLocalCheckoutsOptions,
  signal?: AbortSignal,
): Promise<CheckoutObservationDiagnostic> => {
  const sources = await runStoreQuery(queryCurrentServedLocalProjectSources({ dbPath: options.databasePath }), signal);
  if (Either.isLeft(sources)) {
    if (sources.left.reason === 'revision-unavailable') {
      return { code: 'no-publication' };
    }
    throw sources.left;
  }
  const published: CurrentServedLocalProjectSources = sources.right;
  const [machineResult, bootstrap] = await Promise.all([
    runStoreQuery(queryUsageLocalMachine({ dbPath: options.databasePath }), signal),
    options.kernel.getBootstrapIdentity(),
  ]);
  if (Either.isLeft(machineResult)) {
    throw machineResult.left;
  }
  const machine = machineResult.right;
  const spaceId = bootstrap.space.id;
  const now = instantNow(options.clock);
  let candidates: Promise<readonly RepositoryResolutionCandidate[]> | undefined;
  const run: RunContext = {
    candidates: () => {
      candidates ??= options.kernel.listRepositoryCandidates(spaceId);
      return candidates;
    },
    deviceId: bootstrap.device.id,
    invalidate: () => {
      candidates = undefined;
    },
    kernel: options.kernel,
    now,
    readRepository: options.readRepository ?? readLocalGitRepository,
    readStatus: options.readStatus ?? directoryStatus,
    spaceId,
    summary: {
      ambiguous: 0,
      created: 0,
      invalid: 0,
      mapped: 0,
      missing: 0,
      observed: 0,
      resolved: 0,
      revision: published.revision,
    },
  };
  const plan = planCheckouts(published.sources, machine.id);
  const canonicalBindings = new Map<string, CheckoutBinding | null>();
  for (const [localPath, canonical] of plan.canonical) {
    signal?.throwIfAborted();
    const observation = await observeCheckoutPath(run, localPath);
    const { observed } = observation;
    const binding = needsResolution(observed)
      ? await resolveOwnCheckout(run, observation, canonical.source)
      : checkoutBinding(observed.checkout);
    canonicalBindings.set(localPath, binding);
    if (binding === null) {
      continue;
    }
    for (const mappingId of canonical.mappingIds) {
      await acknowledgeMapping(run, mappingId, binding, observed.checkout.id);
    }
  }
  for (const [localPath, worktree] of plan.worktrees) {
    if (plan.canonical.has(localPath)) {
      continue;
    }
    signal?.throwIfAborted();
    const observation = await observeCheckoutPath(run, localPath);
    const { observed } = observation;
    const canonical = repositoryBinding(canonicalBindings.get(worktree.canonicalPath));
    let binding = checkoutBinding(observed.checkout);
    if (needsResolution(observed)) {
      binding =
        canonical === null
          ? await resolveOwnCheckout(run, observation, worktree.source)
          : await linkCheckout(run, observed.checkout.id, canonical);
    } else if (canonical !== null && needsRepair(observed.checkout, canonical)) {
      binding = await linkCheckout(run, observed.checkout.id, canonical);
    }
    if (binding === null) {
      continue;
    }
    // No published row carries the worktree's own id (the projection publishes
    // the canonical one); this mapping exists so a `--checkout` selector inside
    // the worktree resolves to this Checkout and therefore to the Project.
    await acknowledgeMapping(
      run,
      projectSourceId({ machineId: machine.id, project: worktree.source.project, sourcePath: localPath }),
      binding,
      observed.checkout.id,
    );
  }
  return { code: 'observed', summary: run.summary };
};

export interface LocalCheckoutObservationRuntime {
  readonly dispose: () => Promise<void>;
  /** Resolves after a run that started no earlier than this call has completed; runs never overlap. */
  readonly runNow: () => Promise<void>;
}

export interface StartLocalCheckoutObservationOptions extends ObserveLocalCheckoutsOptions {
  readonly reportDiagnostic?: (diagnostic: CheckoutObservationDiagnostic) => void;
  readonly runtime: Pick<UsageEngineRuntime, 'changes'>;
}

const failureReason = (error: unknown): string => {
  const storeReason = usageStoreErrorReasonFrom(error);
  if (storeReason !== undefined) {
    return `usage-store:${storeReason}`;
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return `memory-store:${error.code}`;
  }
  return 'unknown';
};

/**
 * Observes once at start and again after every `report-published` event. The
 * subscription and the runs belong to the engine process; diagnostics carry a
 * closed vocabulary and never a path, remote, or error message.
 */
export const startLocalCheckoutObservation = (
  options: StartLocalCheckoutObservationOptions,
): LocalCheckoutObservationRuntime => {
  const controller = new AbortController();
  const report = options.reportDiagnostic ?? (() => undefined);
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;

  const execute = async (): Promise<void> => {
    if (controller.signal.aborted) {
      return;
    }
    try {
      report(await observeLocalCheckouts(options, controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) {
        report({ code: 'failed', reason: failureReason(error) });
      }
    }
  };

  const runNow = (): Promise<void> => {
    if (running === undefined) {
      const run = execute().finally(() => {
        if (running === run) {
          running = undefined;
        }
      });
      running = run;
      return run;
    }
    // The continuation runs whether the in-flight run settled or rejected (a
    // throwing diagnostic sink); otherwise `queued` would stay a rejected
    // promise and every later call would reuse it without running anything.
    const next = (): Promise<void> => {
      queued = undefined;
      return runNow();
    };
    queued ??= running.then(next, next);
    return queued;
  };

  const iterator = options.runtime.changes()[Symbol.asyncIterator]();
  const subscription = (async () => {
    while (!controller.signal.aborted) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      if (next.value.event === 'report-published') {
        runNow().catch(() => undefined);
      }
    }
  })();
  subscription.catch(() => undefined);
  runNow().catch(() => undefined);

  return {
    dispose: async () => {
      controller.abort();
      await iterator.return?.();
      await subscription.catch(() => undefined);
      await running?.catch(() => undefined);
      await queued?.catch(() => undefined);
    },
    runNow,
  };
};
