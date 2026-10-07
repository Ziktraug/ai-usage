import path from 'node:path';
import {
  prepareCodexDistillationWindow,
  reloadCodexDistillationEvidence,
} from '@ai-usage/local-machine/distillation-evidence';
import { redactDistillationText } from '@ai-usage/memory-service/distillation-redaction';
import type { DistillationSourceGrant } from '@ai-usage/memory-service/distillation-repository';
import type { LocalIdentityKernel } from '@ai-usage/memory-sqlite/identity';
import { isDistillationDiscoveryRequest } from '@ai-usage/platform-core/distillation-discovery';
import type {
  DistillationEvidenceEvent,
  DistillationEvidencePacket,
} from '@ai-usage/platform-core/distillation-evidence';
import { parseProjectId } from '@ai-usage/platform-core/identity';
import {
  type DistillationCandidate,
  DistillationError,
  type DistillationJobView,
  type DistillationSelection,
  distillationBounds,
  parseDistillationRequest,
} from '@ai-usage/platform-core/session-distillation';
import { queryServedRevisionData, queryUsageLocalMachine } from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import { createCompactDistillationContext } from './distillation-context';
import { executeDistillationDiscovery } from './distillation-discovery-runtime';

export interface DistillationRuntime {
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
}
export interface DistillationRuntimeOptions {
  connected: boolean;
  databasePath: string;
  homeDirectory: string;
  kernel: LocalIdentityKernel;
}

export const createDistillationRuntime = (options: DistillationRuntimeOptions): DistillationRuntime => {
  const { kernel } = options;
  let preparing = false;
  const resolve = async (selection: DistillationSelection, signal?: AbortSignal): Promise<DistillationSourceGrant> => {
    const call = (kind: 'session-detail-anchor' | 'session-lookup') =>
      Effect.runPromise(
        queryServedRevisionData({
          dbPath: options.databasePath,
          kind,
          request: selection,
          revision: selection.revision,
        }),
        { signal },
      );
    const [anchorResult, lookup, machine, bootstrap] = await Promise.all([
      call('session-detail-anchor'),
      call('session-lookup'),
      Effect.runPromise(queryUsageLocalMachine({ dbPath: options.databasePath }), { signal }),
      kernel.getBootstrapIdentity(),
    ]);
    if (!('anchor' in anchorResult && anchorResult.anchor && 'row' in lookup && lookup.row)) {
      throw new DistillationError('report-row-unavailable');
    }
    const anchor = anchorResult.anchor;
    const row = lookup.row;
    if (anchor.sourceAuthority !== 'local-observed' || anchor.machineId !== machine.id) {
      throw new DistillationError('not-local');
    }
    if (anchor.harnessKey !== 'codex' || !anchor.sourceSessionId) {
      throw new DistillationError('unsupported-harness');
    }
    const checkoutPath = row.source?.sourcePath;
    if (!(row.projectSourceId && checkoutPath && path.isAbsolute(checkoutPath))) {
      throw new DistillationError('project-unresolved');
    }
    const mapping = await kernel.findProjectSourceMapping(bootstrap.space.id, row.projectSourceId);
    if (!mapping) {
      throw new DistillationError('project-unresolved');
    }
    signal?.throwIfAborted();
    return {
      projectId: mapping.projectId,
      machineId: machine.id,
      nativeSessionId: anchor.sourceSessionId,
      checkoutPath,
      projectSourceId: row.projectSourceId,
      selection,
    };
  };
  const reauthorizeGrant = async (grant: DistillationSourceGrant, signal?: AbortSignal): Promise<void> => {
    const bootstrap = await kernel.getBootstrapIdentity();
    const [mapping, machine] = await Promise.all([
      kernel.findProjectSourceMapping(bootstrap.space.id, grant.projectSourceId),
      Effect.runPromise(queryUsageLocalMachine({ dbPath: options.databasePath }), { signal }),
    ]);
    if (mapping?.projectId !== grant.projectId || machine.id !== grant.machineId) {
      throw new DistillationError('not-local');
    }
  };
  const candidate = async (
    selection: DistillationSelection,
    projectId: string,
    signal: AbortSignal,
  ): Promise<{ view: DistillationCandidate; grant: DistillationSourceGrant | null }> => {
    try {
      const grant = await resolve(selection, signal);
      let reason: string | null = null;
      if (grant.projectId !== projectId) {
        reason = 'project-mismatch';
      } else if (await kernel.distillation.isProducerSession(grant.machineId, grant.nativeSessionId)) {
        reason = 'distillation-session-excluded';
      }
      return {
        view: {
          selection,
          projectId,
          machineId: grant.machineId,
          nativeSessionId: grant.nativeSessionId,
          eligible: reason === null,
          reason,
        },
        grant: reason === null ? grant : null,
      };
    } catch (error) {
      signal.throwIfAborted();
      return {
        view: {
          selection,
          projectId,
          machineId: '',
          nativeSessionId: '',
          eligible: false,
          reason: error instanceof DistillationError ? error.code : 'selection-unavailable',
        },
        grant: null,
      };
    }
  };
  const runtime: DistillationRuntime = {
    execute: async (input, callerSignal) => {
      if (options.connected) {
        throw new DistillationError('unsupported-connected');
      }
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(distillationBounds.operationMs)])
        : AbortSignal.timeout(distillationBounds.operationMs);
      signal.throwIfAborted();
      if (isDistillationDiscoveryRequest(input)) {
        return executeDistillationDiscovery(input, { ...options, execute: runtime.execute }, signal);
      }
      const request = parseDistillationRequest(input);
      if ('projectId' in request) {
        parseProjectId(request.projectId);
      }
      if (request.kind === 'select' || request.kind === 'prepare') {
        if (preparing) {
          throw new DistillationError('preparation-busy');
        }
        preparing = true;
        try {
          const candidates: DistillationCandidate[] = [];
          const jobs: DistillationJobView[] = [];
          for (const selection of request.selections) {
            const resolved = await candidate(selection, request.projectId, signal);
            candidates.push(resolved.view);
            if (request.kind === 'prepare' && resolved.grant) {
              if (request.producerSessionId === resolved.grant.nativeSessionId) {
                throw new DistillationError('distillation-session-excluded');
              }
              const grant = resolved.grant;
              const result = await prepareCodexDistillationWindow(
                {
                  localMachineId: grant.machineId,
                  selection: {
                    checkoutPath: grant.checkoutPath,
                    machineId: grant.machineId,
                    projectId: grant.projectId,
                    reportAnchor: grant.selection,
                    sourceAuthority: 'local-observed',
                    sourceSessionId: grant.nativeSessionId,
                  },
                },
                { homePath: options.homeDirectory, redactText: redactDistillationText, redactionVersion: 1, signal },
              );
              if (result.status !== 'available') {
                resolved.view.eligible = false;
                resolved.view.reason = result.reason;
                continue;
              }
              signal.throwIfAborted();
              jobs.push(
                await kernel.distillation.prepare({
                  packet: result.packet,
                  grant,
                  producerSessionId: request.producerSessionId,
                  revisionKey: request.revisionKey,
                }),
              );
            }
          }
          return { candidates, jobs };
        } finally {
          preparing = false;
        }
      }
      if (request.kind === 'status') {
        return kernel.distillation.status(await resolve(request.selection, signal));
      }
      if (request.kind === 'claim') {
        return kernel.distillation.claim(request.projectId, request.jobId);
      }
      if (request.kind === 'segment') {
        return kernel.distillation.segment(
          request.projectId,
          request.jobId,
          request.snapshotDigest,
          request.segmentIndex,
        );
      }
      if (request.kind === 'submit') {
        return kernel.distillation.submit(request);
      }
      if (request.kind === 'advance') {
        const { packet, grant } = await kernel.distillation.getJobPacket(request.projectId, request.jobId);
        await reauthorizeGrant(grant, signal);
        if (!packet.window) {
          throw new DistillationError('progressive-job-required');
        }
        if (request.segmentIndex !== undefined && request.segmentIndex < packet.window.index) {
          return kernel.distillation.advance({ ...request, nextPacket: null });
        }
        let nextPacket: DistillationEvidencePacket | null = null;
        if (packet.window.nextLine !== null) {
          const next = await prepareCodexDistillationWindow(
            {
              localMachineId: grant.machineId,
              selection: {
                checkoutPath: grant.checkoutPath,
                machineId: grant.machineId,
                projectId: grant.projectId,
                reportAnchor: grant.selection,
                sourceAuthority: 'local-observed',
                sourceSessionId: grant.nativeSessionId,
              },
            },
            { homePath: options.homeDirectory, redactText: redactDistillationText, redactionVersion: 1, signal },
            {
              version: packet.source.version,
              index: packet.window.index + 1,
              startLine: packet.window.nextLine,
            },
          );
          if (next.status !== 'available') {
            throw new DistillationError(next.reason);
          }
          nextPacket = next.packet;
        }
        return kernel.distillation.advance({ ...request, nextPacket });
      }
      if (request.kind === 'retry') {
        return kernel.distillation.retry(request.projectId, request.jobId);
      }
      if (request.kind === 'cancel') {
        return kernel.distillation.cancel(request.projectId, request.jobId);
      }
      if (request.kind === 'cleanup') {
        return kernel.distillation.cleanup(request.projectId, request.before);
      }
      if (request.kind === 'removal-preview') {
        return kernel.distillation.removalPreview(request.projectId, request.analysisId);
      }
      if (request.kind === 'remove') {
        return kernel.distillation.remove(request.projectId, request.analysisId, request.mode);
      }
      if (request.kind === 'search') {
        return kernel.distillation.search(request.projectId, request.query, request.limit, request.mode);
      }
      if (request.kind === 'context') {
        const search = await kernel.distillation.search(
          request.projectId,
          request.query,
          distillationBounds.searchResults,
          request.mode,
        );
        return createCompactDistillationContext({
          search,
          query: request.query,
          maxBytes: request.maxBytes,
          get: (id) => kernel.distillation.get(request.projectId, id),
          signal,
        });
      }
      if (request.kind !== 'get' && request.kind !== 'evidence') {
        throw new DistillationError('unsupported-operation');
      }
      const selectedGrant = 'selection' in request ? await resolve(request.selection, signal) : null;
      const projectId = selectedGrant?.projectId ?? ('projectId' in request ? request.projectId : '');
      const analysis = await kernel.distillation.get(projectId, request.analysisId);
      if (
        selectedGrant &&
        (selectedGrant.machineId !== analysis.machineId || selectedGrant.nativeSessionId !== analysis.nativeSessionId)
      ) {
        throw new DistillationError('analysis-scope-mismatch');
      }
      if (request.kind === 'get') {
        return analysis;
      }
      const identity = {
        analysisId: analysis.id,
        packetDigest: analysis.packetDigest,
        sourceDigest: analysis.source.version.digest,
        eventIds: request.eventIds,
      };
      if (
        request.identity &&
        (request.identity.packetDigest !== identity.packetDigest ||
          request.identity.sourceDigest !== identity.sourceDigest)
      ) {
        throw new DistillationError('snapshot-version-mismatch');
      }
      const grant = await kernel.distillation.getGrant(projectId, request.analysisId);
      try {
        await reauthorizeGrant(grant, signal);
      } catch (error) {
        if (error instanceof DistillationError && error.code === 'not-local') {
          return { status: 'denied', events: [], identity };
        }
        throw error;
      }
      const packets =
        analysis.extractorVersion === 'session-distillation-progressive-v1'
          ? await kernel.distillation.getEvidencePackets(projectId, request.analysisId, request.eventIds)
          : [{ packet: analysis, eventIds: request.eventIds }];
      const events: DistillationEvidenceEvent[] = [];
      for (const { packet, eventIds } of packets) {
        const evidence = await reloadCodexDistillationEvidence(
          {
            localMachineId: grant.machineId,
            selection: {
              checkoutPath: grant.checkoutPath,
              machineId: grant.machineId,
              projectId: grant.projectId,
              reportAnchor: grant.selection,
              sourceAuthority: 'local-observed',
              sourceSessionId: grant.nativeSessionId,
            },
          },
          packet,
          {
            packetDigest: packet.packetDigest,
            sourceDigest: analysis.source.version.digest,
            eventIds,
          },
          { homePath: options.homeDirectory, redactText: redactDistillationText, redactionVersion: 1, signal },
        );
        if (evidence.status !== 'available') {
          let status = 'unavailable';
          if (evidence.reason === 'source-changed') {
            status = 'changed';
          }
          if (evidence.reason === 'unauthorized') {
            status = 'denied';
          }
          return {
            status,
            events: [],
            identity,
          };
        }
        for (const event of evidence.events) {
          if (!events.some((existing) => existing.id === event.id)) {
            events.push(event);
          }
        }
      }
      return { status: 'available', events, identity };
    },
  };
  return runtime;
};
