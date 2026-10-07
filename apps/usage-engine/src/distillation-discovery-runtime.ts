import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import {
  type DistillationDiscoveryResult,
  parseDistillationDiscoveryRequest,
} from '@ai-usage/platform-core/distillation-discovery';
import {
  type DistillationCandidate,
  DistillationError,
  type DistillationRequest,
  type DistillationSelection,
  distillationObject,
  distillationText,
  parseDistillationRequest,
} from '@ai-usage/platform-core/session-distillation';
import {
  queryCurrentServedReportRevision,
  queryDistillationSessionMetadata,
  queryUsageLocalMachine,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const executeDistillationDiscovery = async (
  input: unknown,
  options: {
    databasePath: string;
    kernel: LocalIdentityKernel;
    execute: (request: DistillationRequest, signal?: AbortSignal) => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<unknown> => {
  const request = parseDistillationDiscoveryRequest(input);
  const repository = options.kernel.distillation;
  if (request.kind === 'history') {
    return repository.history(request.projectId, request.analysisId, request.limit, request.cursor);
  }
  if (request.kind === 'projects') {
    return repository.projects(request.limit, request.cursor);
  }
  if (request.kind === 'browse') {
    return repository.browse(request);
  }
  if (request.kind === 'jobs') {
    return repository.jobs(request.projectId, request.limit, request.cursor);
  }
  const current = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath: options.databasePath }), {
    signal,
  });
  if (request.kind === 'prepare-selection') {
    let selection: Record<string, unknown>;
    try {
      selection = distillationObject(JSON.parse(Buffer.from(request.selectionToken, 'base64url').toString('utf8')));
    } catch {
      throw new DistillationError('invalid-selection-token');
    }
    if (selection.version !== 1) {
      throw new DistillationError('selection-version-mismatch');
    }
    if (selection.revision !== current.revision) {
      throw new DistillationError('selection-stale');
    }
    const projectId = distillationText(selection.projectId, 128);
    const projects = await repository.projects(2, null, { kind: 'project', value: projectId });
    if (projects.items.length !== 1 || hash(projects.items[0]) !== selection.mappingDigest) {
      throw new DistillationError('selection-stale');
    }
    const prepared = parseDistillationRequest({
      kind: 'prepare',
      projectId,
      selections: selection.selections,
      providerProcessingAuthorized: true,
      producerSessionId: request.producerSessionId,
      revisionKey: request.revisionKey,
    });
    if (prepared.kind !== 'prepare') {
      throw new DistillationError('invalid-selection');
    }
    if (
      prepared.selections.some((item) => item.revision !== current.revision) ||
      hash({
        projectId,
        revision: current.revision,
        selections: prepared.selections,
        mappingDigest: selection.mappingDigest,
      }) !== selection.selectionDigest
    ) {
      throw new DistillationError('selection-stale');
    }
    if (request.chosenRowIds) {
      if (request.chosenRowIds.some((rowId) => !prepared.selections.some((item) => item.rowId === rowId))) {
        throw new DistillationError('selection-scope-mismatch');
      }
      prepared.selections = prepared.selections.filter((item) => request.chosenRowIds?.includes(item.rowId));
    }
    // Validate every identity before opening even the first source. Never silently
    // replace an old selection, nor prepare a subset after an eligibility change.
    const preview = distillationObject(
      await options.execute({ kind: 'select', projectId, selections: prepared.selections }, signal),
    );
    if (
      !Array.isArray(preview.candidates) ||
      preview.candidates.some((candidate) => distillationObject(candidate).eligible !== true)
    ) {
      throw new DistillationError('selection-stale');
    }
    return options.execute(prepared, signal);
  }
  if (request.selector.kind === 'checkout' && !path.isAbsolute(request.selector.value)) {
    throw new DistillationError('invalid-checkout-path');
  }
  const selector =
    request.selector.kind === 'checkout'
      ? { ...request.selector, value: path.normalize(request.selector.value) }
      : request.selector;
  const projects = await repository.projects(2, null, selector);
  if (projects.items.length === 0) {
    throw new DistillationError('project-unresolved');
  }
  if (projects.items.length !== 1 || projects.nextCursor !== null) {
    throw new DistillationError('project-ambiguous');
  }
  const project = projects.items[0]!;
  const machine = await Effect.runPromise(queryUsageLocalMachine({ dbPath: options.databasePath }), { signal });
  const rows = await Effect.runPromise(
    queryDistillationSessionMetadata({
      dbPath: options.databasePath,
      revision: current.revision,
      machineId: machine.id,
      projectSourceIds: project.checkouts.map((checkout) => checkout.projectSourceId),
      since: request.since,
      until: request.until,
      limit: request.limit,
    }),
    { signal },
  );
  const selections: DistillationSelection[] = rows.map((row) => ({ revision: current.revision, rowId: row.rowId }));
  const preview =
    selections.length === 0
      ? { candidates: [] }
      : distillationObject(await options.execute({ kind: 'select', projectId: project.projectId, selections }, signal));
  const candidates: DistillationDiscoveryResult['candidates'] = [];
  for (const [index, candidate] of (preview.candidates as DistillationCandidate[]).entries()) {
    signal.throwIfAborted();
    const status = await repository.status(candidate);
    candidates.push({
      ...candidate,
      label: rows[index]!.label,
      sessionDate: rows[index]!.sessionDate,
      status: { ...status, revisions: [], revisionsOmitted: status.revisionsOmitted + status.revisions.length },
    });
  }
  const eligible = candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.selection);
  const identity = {
    projectId: project.projectId,
    revision: current.revision,
    selections: eligible,
    mappingDigest: hash(project),
  };
  const selectionDigest = hash(identity);
  const selectionToken = Buffer.from(JSON.stringify({ version: 1, ...identity, selectionDigest })).toString(
    'base64url',
  );
  return {
    version: 1,
    projectId: project.projectId,
    projectName: project.displayName,
    revision: current.revision,
    createdAt: new Date().toISOString(),
    selectionDigest,
    selectionToken,
    prepareCommand: `bun run cli analyses prepare --selection '${selectionToken}' --authorize-provider-processing`,
    candidates,
    selections: eligible,
  } satisfies DistillationDiscoveryResult;
};
