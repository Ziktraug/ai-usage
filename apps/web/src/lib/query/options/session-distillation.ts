import type {
  SessionAnalysis,
  SessionDistillationEvidenceRequest,
  SessionDistillationGetRequest,
  SessionDistillationStatusRequest,
} from '@ai-usage/web-contract/session-distillation';
import { queryOptions, skipToken } from '@tanstack/svelte-query';
import type { SessionDistillationClient } from '../../rpc/session-distillation-client';
import { finiteSwrKey, immutableRevisionKey } from '../keys';
import { webQueryPolicies } from '../policies';

export interface SessionDistillationQueryExecution {
  readonly active: boolean;
  readonly browser: boolean;
}

export const sessionDistillationStatusKey = (input: SessionDistillationStatusRequest | undefined) =>
  finiteSwrKey('session-analysis-status', input?.selection.revision ?? '', input?.selection.rowId ?? '');

export const sessionDistillationGetKey = (input: SessionDistillationGetRequest | undefined) =>
  immutableRevisionKey(
    'session-analysis',
    input?.analysisId ?? '',
    JSON.stringify(
      input && 'projectId' in input
        ? ['project', input.projectId]
        : [input?.selection.revision ?? '', input?.selection.rowId ?? ''],
    ),
    'analysis',
  );

export const sessionDistillationEvidenceKey = (input: SessionDistillationEvidenceRequest | undefined) =>
  finiteSwrKey(
    'session-analysis-evidence',
    input?.analysisId ?? '',
    input && 'projectId' in input ? 'project' : (input?.selection.revision ?? ''),
    input && 'projectId' in input ? input.projectId : (input?.selection.rowId ?? ''),
    JSON.stringify(input?.eventIds ?? []),
  );

export const sessionDistillationStatusOptions = (
  client: SessionDistillationClient,
  input: SessionDistillationStatusRequest | undefined,
  execution: SessionDistillationQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: execution.browser && execution.active && input !== undefined,
    queryFn: input ? ({ signal }) => client.status(input, signal) : skipToken,
    queryKey: sessionDistillationStatusKey(input),
  });

export const sessionDistillationGetOptions = (
  client: SessionDistillationClient,
  input: SessionDistillationGetRequest | undefined,
  execution: SessionDistillationQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    enabled: execution.browser && execution.active && input !== undefined,
    // An explicit analysis revision survives a usage publication for this same row.
    placeholderData: (previousData: SessionAnalysis | undefined, previousQuery) => {
      const identity = previousQuery?.queryKey[4];
      if (typeof identity !== 'string' || previousData?.id !== input?.analysisId) {
        return;
      }
      const previousSelection: unknown = JSON.parse(identity);
      const scopeIdentity = input && 'projectId' in input ? input.projectId : input?.selection.rowId;
      return Array.isArray(previousSelection) && previousSelection[1] === scopeIdentity ? previousData : undefined;
    },
    queryFn: input ? ({ signal }) => client.get(input, signal) : skipToken,
    queryKey: sessionDistillationGetKey(input),
  });

/** Source availability is mutable even though the expected analysis revision is immutable. */
export const sessionDistillationEvidenceOptions = (
  client: SessionDistillationClient,
  input: SessionDistillationEvidenceRequest | undefined,
  execution: SessionDistillationQueryExecution,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled: execution.browser && execution.active && input !== undefined,
    queryFn: input ? ({ signal }) => client.evidence(input, signal) : skipToken,
    queryKey: sessionDistillationEvidenceKey(input),
  });
