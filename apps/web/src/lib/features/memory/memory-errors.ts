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

export const memoryAnalysisError = (error: unknown, fallback: string): string => {
  if (typeof error !== 'object' || error === null) {
    return fallback;
  }
  if ('code' in error && error.code === 'ForbiddenDemo') {
    return 'Local session analyses are unavailable in demo mode. Open your local workspace to read saved accounts.';
  }
  if ('code' in error && error.code === 'Forbidden') {
    return 'Access to this Project or saved analysis is denied.';
  }
  const data = 'data' in error ? error.data : null;
  const reason = typeof data === 'object' && data !== null && 'reason' in data ? data.reason : null;
  if (reason === 'unsupported-mode') {
    return 'Local session analyses are unavailable in connected mode. Open your local workspace to read saved accounts.';
  }
  if (reason === 'service-unavailable') {
    return 'The local Memory service is stopped or unreachable. Start the usage engine, then retry.';
  }
  if (reason === 'mapping-required') {
    return 'This Project needs an acknowledged local Checkout mapping. Resolve it in Projects, then preview sessions again.';
  }
  if (reason === 'selection-stale') {
    return 'This library cursor or session selection is stale. Refresh the library or preview sessions again.';
  }
  if (reason === 'version-incompatible') {
    return 'This analysis format is incompatible. Update the local usage engine and web app together before retrying.';
  }
  if (reason === 'storage-unavailable') {
    return 'Local Memory storage could not be read. Check the usage engine storage status, then retry.';
  }
  if (reason === 'not-found') {
    return 'This saved analysis is no longer available. It may have been removed or withdrawn.';
  }
  if (reason === 'source-modified') {
    return 'The source changed after this selection. Preview sessions again to choose its current snapshot.';
  }
  return fallback;
};
