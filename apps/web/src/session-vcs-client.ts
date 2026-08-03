import {
  parseSessionVcsResolveRequest,
  parseSessionVcsResolveResponse,
  type SessionVcsResolveRequest,
  type SessionVcsResolveResponse,
} from '@ai-usage/report-core/session-vcs';
import { createSessionClientAdapter } from './lib/rpc/session-client';
import { resolveSolidWebRpcClient } from './lib/rpc/solid-client';

export interface SessionVcsResolutionSource {
  resolve(request: SessionVcsResolveRequest): Promise<unknown>;
}

const servedSource: SessionVcsResolutionSource = {
  resolve: async (request) => {
    const rpc = await resolveSolidWebRpcClient();
    return await createSessionClientAdapter(rpc.session).vcs(request);
  },
};

const pendingResolutions = new Map<string, Promise<SessionVcsResolveResponse>>();

export const loadSessionVcsResolution = (
  input: SessionVcsResolveRequest,
  source: SessionVcsResolutionSource = servedSource,
): Promise<SessionVcsResolveResponse> => {
  const request = parseSessionVcsResolveRequest(input);
  const key = `${request.revision}\0${request.rowId}`;
  const pending = pendingResolutions.get(key);
  if (pending) {
    return pending;
  }
  const resolve = async (): Promise<SessionVcsResolveResponse> => {
    try {
      return parseSessionVcsResolveResponse(await source.resolve(request));
    } finally {
      pendingResolutions.delete(key);
    }
  };
  const resolution = resolve();
  pendingResolutions.set(key, resolution);
  return resolution;
};
