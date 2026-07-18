export interface ServedRevisionDescriptor {
  captureFingerprint: string;
  revision: string;
}

export interface ServedReportSessionAdapter<
  Destination,
  Prepared,
  Descriptor extends ServedRevisionDescriptor = ServedRevisionDescriptor,
> {
  acquire(): Promise<Descriptor>;
  commit(prepared: Prepared, descriptor: Descriptor, destination: Destination): void;
  destinationFingerprint(destination: Destination): string;
  isRevisionExpired(error: unknown): boolean;
  load(destination: Destination, descriptor: Descriptor): Promise<Prepared>;
}

export type ServedReportRefreshOutcome<Descriptor extends ServedRevisionDescriptor = ServedRevisionDescriptor> =
  | { descriptor: Descriptor; status: 'committed' }
  | { descriptor: Descriptor; status: 'no-change' }
  | { status: 'superseded' }
  | { error: unknown; status: 'failed-preserving-previous' };

export interface ServedReportSession<
  Destination,
  Descriptor extends ServedRevisionDescriptor = ServedRevisionDescriptor,
> {
  abort(): void;
  refresh(destination: Destination): Promise<ServedReportRefreshOutcome<Descriptor>>;
}

/** Owns exact-revision acquisition, one expiry retry, supersession, and atomic destination commit. */
export const createServedReportSession = <
  Destination,
  Prepared,
  Descriptor extends ServedRevisionDescriptor = ServedRevisionDescriptor,
>(
  adapter: ServedReportSessionAdapter<Destination, Prepared, Descriptor>,
): ServedReportSession<Destination, Descriptor> => {
  let requestId = 0;
  let committed: { captureFingerprint: string; destinationFingerprint: string; revision: string } | undefined;

  const abort = (): void => {
    requestId += 1;
  };

  const refresh = async (destination: Destination): Promise<ServedReportRefreshOutcome<Descriptor>> => {
    const currentRequestId = ++requestId;
    const destinationFingerprint = adapter.destinationFingerprint(destination);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = await adapter.acquire();
        if (currentRequestId !== requestId) {
          return { status: 'superseded' };
        }
        if (
          committed?.revision === descriptor.revision &&
          committed.captureFingerprint === descriptor.captureFingerprint &&
          committed.destinationFingerprint === destinationFingerprint
        ) {
          return { descriptor, status: 'no-change' };
        }
        const prepared = await adapter.load(destination, descriptor);
        if (currentRequestId !== requestId) {
          return { status: 'superseded' };
        }
        adapter.commit(prepared, descriptor, destination);
        committed = { ...descriptor, destinationFingerprint };
        return { descriptor, status: 'committed' };
      } catch (error) {
        if (currentRequestId !== requestId) {
          return { status: 'superseded' };
        }
        if (attempt === 0 && adapter.isRevisionExpired(error)) {
          continue;
        }
        return { error, status: 'failed-preserving-previous' };
      }
    }
    return { error: new Error('Revision retry budget exhausted'), status: 'failed-preserving-previous' };
  };

  return { abort, refresh };
};
