/**
 * An addressed proposal page is refused as `not-found` whether the proposal never existed, is not
 * accessible, or was already accepted or rejected; the service does not tell these apart.
 */
export const isMemoryProposalUnavailable = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'data' in error &&
  typeof error.data === 'object' &&
  error.data !== null &&
  'reason' in error.data &&
  error.data.reason === 'not-found';
