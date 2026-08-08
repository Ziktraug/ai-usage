const INTENTIONAL_REQUEST_ABORT = 'net::ERR_ABORTED';
const SVELTEKIT_ROUTE_DATA_SUFFIX = '/__data.json';

export type BrowserRequestAbortResourceType = 'fetch' | 'xhr';

export interface BrowserRequestAbortExpectation {
  readonly pathname: string;
  readonly resourceType: BrowserRequestAbortResourceType;
}

export interface BrowserRequestAbortObservation {
  readonly errorText: string;
  readonly pathname: string;
  readonly resourceType: string;
}

export const isCancelledSvelteKitRouteDataRequest = ({
  errorText,
  pathname,
  resourceType,
}: BrowserRequestAbortObservation): boolean =>
  errorText === INTENTIONAL_REQUEST_ABORT &&
  (resourceType === 'fetch' || resourceType === 'xhr') &&
  pathname.endsWith(SVELTEKIT_ROUTE_DATA_SUFFIX);

const expectationKey = ({
  pathname,
  resourceType,
}: {
  readonly pathname: string;
  readonly resourceType: string;
}): string => `${resourceType}:${pathname}`;

export const createBrowserRequestAbortAllowance = () => {
  const activeExpectations = new Set<string>();

  return {
    allowOnce: (expectation: BrowserRequestAbortExpectation): (() => void) => {
      const key = expectationKey(expectation);
      if (activeExpectations.has(key)) {
        throw new Error(`A browser request abort allowance is already active for ${key}`);
      }
      activeExpectations.add(key);
      return () => {
        activeExpectations.delete(key);
      };
    },
    consume: (observation: BrowserRequestAbortObservation): boolean => {
      if (observation.errorText !== INTENTIONAL_REQUEST_ABORT) {
        return false;
      }
      return activeExpectations.delete(expectationKey(observation));
    },
  };
};
