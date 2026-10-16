import { stat } from 'node:fs/promises';
import path from 'node:path';
import { readLocalGitRepository } from '@ai-usage/local-machine/local-git';
import type { CheckoutObservationResult, LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import {
  type CheckoutId,
  createProjectId,
  createRepositoryAliasId,
  createRepositoryId,
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
import { projectSourceId } from '@ai-usage/report-core/project-group';
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
 * Repositories, and acknowledges the Project-source mapping that session
 * distillation discovery requires.
 *
 * Policy (ADR 0044): a Checkout whose `origin` remote resolves or creates one
 * Repository binds to that Repository's Project without review; a Checkout
 * without a remote becomes a local Project named after its directory; only an
 * ambiguous remote waits in the `/projects` resolution review. A path that is
 * missing on disk is recorded as `missing` and never resolved until it is seen
 * again. Reviewed decisions are never reopened unless the remote changes.
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

/** Only the checkout that distillation discovery can use: this Device, an absolute path, first source per path. */
const localSourcesByPath = (
  sources: readonly ServedLocalProjectSource[],
  machineId: string,
): ReadonlyMap<string, ServedLocalProjectSource> => {
  const byPath = new Map<string, ServedLocalProjectSource>();
  for (const source of sources) {
    if (source.machineId !== machineId || !path.isAbsolute(source.sourcePath) || source.sourcePath.includes('\0')) {
      continue;
    }
    const localPath = path.normalize(source.sourcePath);
    if (!byPath.has(localPath)) {
      byPath.set(localPath, source);
    }
  }
  return byPath;
};

const needsResolution = (observed: CheckoutObservationResult): boolean =>
  observed.checkout.projectId === null &&
  observed.checkout.status === 'available' &&
  observed.resolutionReviewedAt === null &&
  (observed.outcome !== 'unchanged' || observed.resolutionStatus === 'unassigned');

interface ResolutionContext {
  readonly candidates: () => Promise<readonly RepositoryResolutionCandidate[]>;
  readonly invalidate: () => void;
  readonly kernel: LocalIdentityKernel;
  readonly now: Instant;
  readonly spaceId: SpaceId;
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

type ResolutionOutcome = { kind: 'bound'; projectId: ProjectId } | { kind: 'ambiguous' } | { kind: 'invalid' };

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
      return { kind: 'bound', projectId: result.projectId };
    }
    case 'candidate': {
      const repositoryId = await createCandidateRepository(context, resolution);
      return { kind: 'bound', projectId: await bindRepositoryProject(context, checkout.id, repositoryId) };
    }
    case 'resolved':
      return { kind: 'bound', projectId: await bindRepositoryProject(context, checkout.id, resolution.repositoryId) };
    default:
      return resolution satisfies never;
  }
};

export const observeLocalCheckouts = async (
  options: ObserveLocalCheckoutsOptions,
  signal?: AbortSignal,
): Promise<CheckoutObservationDiagnostic> => {
  const readStatus = options.readStatus ?? directoryStatus;
  const readRepository = options.readRepository ?? readLocalGitRepository;
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
  const context: ResolutionContext = {
    candidates: () => {
      candidates ??= options.kernel.listRepositoryCandidates(spaceId);
      return candidates;
    },
    invalidate: () => {
      candidates = undefined;
    },
    kernel: options.kernel,
    now,
    spaceId,
  };
  const summary = {
    ambiguous: 0,
    created: 0,
    invalid: 0,
    mapped: 0,
    missing: 0,
    observed: 0,
    resolved: 0,
    revision: published.revision,
  };
  for (const [localPath, source] of localSourcesByPath(published.sources, machine.id)) {
    signal?.throwIfAborted();
    const status = await readStatus(localPath);
    const repository = status === 'available' ? readRepository(localPath) : null;
    const observedRemote = repository === null ? null : `https://${repository.host}/${repository.ownerPath}`;
    const observed = await options.kernel.observeCheckout(spaceId, {
      deviceId: bootstrap.device.id,
      lastObservedAt: now,
      localPath,
      observedRemote,
      status,
    });
    summary.observed += 1;
    if (observed.outcome === 'created') {
      summary.created += 1;
    }
    if (status === 'missing') {
      summary.missing += 1;
    }
    let projectId = observed.checkout.projectId;
    if (needsResolution(observed)) {
      const outcome = await resolveCheckout(context, observed, observedRemote, source);
      if (outcome.kind === 'bound') {
        projectId = outcome.projectId;
        summary.resolved += 1;
      } else if (outcome.kind === 'ambiguous') {
        summary.ambiguous += 1;
      } else {
        summary.invalid += 1;
      }
    }
    if (projectId === null) {
      continue;
    }
    const sourceId = projectSourceId({ machineId: machine.id, project: source.project, sourcePath: localPath });
    const mapping = await options.kernel.findProjectSourceMapping(spaceId, sourceId);
    if (mapping === null || mapping.projectId !== projectId || mapping.checkoutId !== observed.checkout.id) {
      await options.kernel.acknowledgeProjectSourceMapping(
        { acknowledgedAt: now, checkoutId: observed.checkout.id, projectId, projectSourceId: sourceId },
        spaceId,
      );
      summary.mapped += 1;
    }
  }
  return { code: 'observed', summary };
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
    queued ??= running.then(() => {
      queued = undefined;
      return runNow();
    });
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
