export interface BoundedResponseBodyOptions {
  readonly bodyUnavailableMessage: string;
  readonly byteLimitMessage: string;
  readonly declaredBytes: number | null;
  readonly lengthMismatchMessage: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}

const scheduleReaderCancellation = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    reader.cancel().catch(() => undefined);
  } catch {
    // The stream may already be errored by the same cancellation.
  }
};

const readChunk = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> => {
  signal?.throwIfAborted();
  if (!signal) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
};

export const readBoundedResponseBytes = async (
  response: Response,
  options: BoundedResponseBodyOptions,
): Promise<Uint8Array> => {
  const { declaredBytes, maximumBytes, signal } = options;
  signal?.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(options.bodyUnavailableMessage);
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    try {
      while (true) {
        const chunk = await readChunk(reader, signal);
        signal?.throwIfAborted();
        if (chunk.done) {
          if (declaredBytes !== null && byteLength !== declaredBytes) {
            throw new Error(options.lengthMismatchMessage);
          }
          complete = true;
          break;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > maximumBytes || (declaredBytes !== null && byteLength > declaredBytes)) {
          throw new Error(options.byteLimitMessage);
        }
        chunks.push(chunk.value);
      }
    } finally {
      if (!complete) {
        scheduleReaderCancellation(reader);
      }
      reader.releaseLock();
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }

  signal?.throwIfAborted();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
