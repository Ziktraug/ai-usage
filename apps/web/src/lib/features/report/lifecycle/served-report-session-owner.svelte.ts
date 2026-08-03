import type {
  ServedReportRefreshOutcome,
  ServedReportSession,
  ServedRevisionDescriptor,
} from '../../../../served-report-session';

export interface ServedReportOwnerSnapshot<Descriptor extends ServedRevisionDescriptor> {
  readonly descriptor?: Descriptor;
  readonly pending: boolean;
  readonly refreshError: string | null;
}

export interface ServedReportSessionOwner<Destination, Descriptor extends ServedRevisionDescriptor> {
  abort(): void;
  refresh(destination: Destination): Promise<ServedReportRefreshOutcome<Descriptor>>;
  readonly snapshot: ServedReportOwnerSnapshot<Descriptor>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Failed to load report destination';

/**
 * Reactive presentation owner for the framework-neutral ServedReportSession.
 * Revision retry, supersession, identity and atomic commit remain exclusively
 * owned by the injected session.
 */
export const createServedReportSessionOwner = <
  Destination,
  Descriptor extends ServedRevisionDescriptor = ServedRevisionDescriptor,
>(
  session: ServedReportSession<Destination, Descriptor>,
): ServedReportSessionOwner<Destination, Descriptor> => {
  let snapshot = $state<ServedReportOwnerSnapshot<Descriptor>>({ pending: false, refreshError: null });

  const refresh = async (destination: Destination): Promise<ServedReportRefreshOutcome<Descriptor>> => {
    snapshot = { ...snapshot, pending: true, refreshError: null };
    const outcome = await session.refresh(destination);
    if (outcome.status === 'superseded') {
      return outcome;
    }
    if (outcome.status === 'failed-preserving-previous') {
      snapshot = { ...snapshot, pending: false, refreshError: errorMessage(outcome.error) };
      return outcome;
    }
    snapshot = { descriptor: outcome.descriptor, pending: false, refreshError: null };
    return outcome;
  };

  return {
    abort: () => {
      session.abort();
      snapshot = { ...snapshot, pending: false };
    },
    refresh,
    get snapshot() {
      return snapshot;
    },
  };
};
