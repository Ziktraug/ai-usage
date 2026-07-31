interface AbortedBodyRead {
  readonly aborted: true;
}

export type AbortableBodyReadResult =
  | AbortedBodyRead
  | Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

const abortedBodyRead: AbortedBodyRead = { aborted: true };

const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  reader.cancel().catch(() => undefined);
};

export const readAbortableRequestBodyChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<AbortableBodyReadResult> => {
  if (signal.aborted) {
    cancelReader(reader);
    return abortedBodyRead;
  }

  let resolveAbort: ((result: AbortedBodyRead) => void) | undefined;
  const aborted = new Promise<AbortedBodyRead>((resolve) => {
    resolveAbort = resolve;
  });
  const abort = (): void => {
    resolveAbort?.(abortedBodyRead);
    cancelReader(reader);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};
