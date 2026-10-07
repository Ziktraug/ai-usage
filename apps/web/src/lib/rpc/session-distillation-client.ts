import {
  type DistillationEvidenceResult,
  type DistillationStatus,
  parseDistillationEvidenceResult,
  parseDistillationStatus,
  parseSessionAnalysis,
  parseSessionDistillationEvidenceRequest,
  parseSessionDistillationGetRequest,
  parseSessionDistillationStatusRequest,
  type SessionAnalysis,
  type SessionDistillationContractClient,
  type SessionDistillationEvidenceRequest,
  type SessionDistillationGetRequest,
  type SessionDistillationStatusRequest,
} from '@ai-usage/web-contract/session-distillation';

export interface SessionDistillationClient {
  readonly evidence: (
    input: SessionDistillationEvidenceRequest,
    signal?: AbortSignal,
  ) => Promise<DistillationEvidenceResult>;
  readonly get: (input: SessionDistillationGetRequest, signal?: AbortSignal) => Promise<SessionAnalysis>;
  readonly status: (input: SessionDistillationStatusRequest, signal?: AbortSignal) => Promise<DistillationStatus>;
}

export const createSessionDistillationClient = (
  transport: Pick<SessionDistillationContractClient, 'evidence' | 'get' | 'status'>,
): SessionDistillationClient => ({
  evidence: async (input, signal) => {
    const request = parseSessionDistillationEvidenceRequest(input);
    signal?.throwIfAborted();
    const response = parseDistillationEvidenceResult(await transport.evidence(request, signal ? { signal } : {}));
    signal?.throwIfAborted();
    if (response.status === 'available') {
      if (
        request.identity &&
        (!response.identity ||
          response.identity.analysisId !== request.analysisId ||
          response.identity.packetDigest !== request.identity.packetDigest ||
          response.identity.sourceDigest !== request.identity.sourceDigest)
      ) {
        throw new Error('Session evidence does not match the requested snapshot.');
      }
      const requested = new Set(request.eventIds);
      if (
        response.events.length !== requested.size ||
        new Set(response.events.map((event) => event.id)).size !== requested.size ||
        response.events.some((event) => !requested.has(event.id))
      ) {
        throw new Error('Session evidence does not match the requested events.');
      }
    }
    return response;
  },
  get: async (input, signal) => {
    const request = parseSessionDistillationGetRequest(input);
    signal?.throwIfAborted();
    const response = parseSessionAnalysis(await transport.get(request, signal ? { signal } : {}));
    signal?.throwIfAborted();
    if (response.id !== request.analysisId) {
      throw new Error('Session analysis does not match the requested revision.');
    }
    return response;
  },
  status: async (input, signal) => {
    const request = parseSessionDistillationStatusRequest(input);
    signal?.throwIfAborted();
    const response = parseDistillationStatus(await transport.status(request, signal ? { signal } : {}));
    signal?.throwIfAborted();
    return response;
  },
});
