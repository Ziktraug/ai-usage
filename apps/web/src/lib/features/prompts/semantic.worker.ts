import { SEMANTIC_MODEL, type SemanticWorkerRequest, type SemanticWorkerResponse } from './semantic-model';
import { modelAssetRequest } from './semantic-network';

const respond = (response: SemanticWorkerResponse): void => self.postMessage(response);
let busy = false;
let extractor: Awaited<ReturnType<typeof prepare>> | null = null;
let downloadsAllowed = true;
const assetFetch = self.fetch.bind(self);
const fetchModelAsset = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!downloadsAllowed) {
    return Promise.reject(new Error('Network is disabled during prompt analysis'));
  }
  const request = modelAssetRequest(input, init);
  return assetFetch(request.url, request.init);
};
// The app also types server Bun globals; a browser worker has no Bun-specific
// fetch.preconnect property. Replace the browser capability, not its server type.
Object.defineProperty(self, 'fetch', { value: fetchModelAsset });

const prepare = async () => {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const wasm = env.backends.onnx.wasm;
  if (!wasm) {
    throw new Error('The local WASM backend is unavailable');
  }
  wasm.numThreads = 1;
  wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';
  const model = await pipeline('feature-extraction', SEMANTIC_MODEL.id, {
    device: 'wasm',
    dtype: 'q8',
    revision: SEMANTIC_MODEL.revision,
  });
  model.tokenizer.model_max_length = 128;
  return model;
};

self.onmessage = async (event: MessageEvent<SemanticWorkerRequest>) => {
  if (busy) {
    respond({ kind: 'error', message: 'An analysis is already running.' });
    return;
  }
  busy = true;
  try {
    if (event.data.kind === 'prepare') {
      extractor ??= await prepare();
      downloadsAllowed = false;
      respond({ kind: 'ready' });
    } else if (event.data.kind === 'analyze') {
      if (!extractor) {
        throw new Error('Prepare the local model before sending prompts.');
      }
      const texts = event.data.texts;
      if (
        !Array.isArray(texts) ||
        texts.length > SEMANTIC_MODEL.maxFormulations ||
        texts.some((text) => typeof text !== 'string' || text.length > SEMANTIC_MODEL.maxCharacters)
      ) {
        throw new Error('The analysis exceeds its declared text budget.');
      }
      const vectors: number[][] = [];
      for (const text of texts) {
        const output = await extractor(text, { normalize: true, pooling: 'mean' });
        vectors.push(Array.from(output.data, Number));
        respond({ done: vectors.length, kind: 'progress', total: texts.length });
      }
      respond({ kind: 'result', vectors });
    } else {
      throw new Error('Unknown local analysis request.');
    }
  } catch {
    // A provider URL or a runtime exception may contain local text. Expose a
    // bounded operational explanation, not the raw exception or prompt bodies.
    respond({
      kind: 'error',
      message:
        'Local model preparation or analysis failed. Check browser network/storage and retry. No cloud inference fallback was used.',
    });
  } finally {
    busy = false;
  }
};
