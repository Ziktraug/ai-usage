import type { SessionDetailRequest } from '@ai-usage/report-core/session-detail-request';
import { parseSessionEvidenceResponse, type SessionEvidenceResponse } from '@ai-usage/report-core/session-evidence';
import { queryOptions } from '@tanstack/svelte-query';
import { webQueryPolicies } from '../policies';

export const sessionEvidenceQueryOptions = (
  client: {
    evidence: (request: SessionDetailRequest, options?: { signal?: AbortSignal }) => Promise<SessionEvidenceResponse>;
  },
  request: SessionDetailRequest,
  enabled: boolean,
) =>
  queryOptions({
    ...webQueryPolicies.finiteSwr,
    enabled,
    queryKey: ['web', 'session-evidence', request.revision, request.rowId],
    queryFn: async ({ signal }) => {
      const response = parseSessionEvidenceResponse(await client.evidence(request, { signal }));
      if (response.status === 'available' && response.revision !== request.revision) {
        throw new Error('Recorded result revision does not match its request');
      }
      return response;
    },
  });
