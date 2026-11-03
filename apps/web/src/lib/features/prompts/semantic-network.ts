import { SEMANTIC_MODEL } from './semantic-model';

const runtimePrefix = '/npm/@huggingface/transformers@3.8.1/dist/';
const modelPrefix = `/${SEMANTIC_MODEL.id}/resolve/${SEMANTIC_MODEL.revision}/`;

/** Only public, pinned assets may be fetched, before any prompt reaches the worker. */
export const modelAssetRequest = (input: RequestInfo | URL, init?: RequestInit): { url: string; init: RequestInit } => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const model = url.hostname === 'huggingface.co' && url.pathname.startsWith(modelPrefix);
  const runtime = url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith(runtimePrefix);
  if (
    request.method !== 'GET' ||
    request.body !== null ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !(model || runtime)
  ) {
    throw new Error('Only pinned public model assets may be downloaded');
  }
  return {
    url: url.href,
    init: { credentials: 'omit', method: 'GET', referrerPolicy: 'no-referrer', signal: request.signal },
  };
};
