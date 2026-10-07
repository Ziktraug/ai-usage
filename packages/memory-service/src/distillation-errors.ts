import type { MemoryServiceErrorCode } from './contracts';

/** Closed public categories: never forward native reader errors or provider diagnostics. */
export const distillationServiceError = (code: string): { code: MemoryServiceErrorCode; status: number } => {
  if (['worker-busy', 'preparation-busy'].includes(code)) {
    return { code: 'worker-busy', status: 409 };
  }
  if (['stale-worker', 'lease-expired'].includes(code)) {
    return { code: 'lease-expired', status: 409 };
  }
  if (['source-changed', 'source-modified', 'snapshot-changed'].includes(code)) {
    return { code: 'source-modified', status: 409 };
  }
  if (
    [
      'schema-version-mismatch',
      'extractor-version-mismatch',
      'analysis-version-mismatch',
      'version-incompatible',
      'selection-version-mismatch',
      'snapshot-version-mismatch',
    ].includes(code)
  ) {
    return { code: 'version-incompatible', status: 409 };
  }
  if (
    [
      'analysis-scope-mismatch',
      'selection-scope-mismatch',
      'source-grant-mismatch',
      'not-local',
      'forbidden',
      'authorization-denied',
    ].includes(code)
  ) {
    return { code: 'forbidden', status: 403 };
  }
  if (code === 'authorization-unavailable') {
    return { code, status: 503 };
  }
  if (['selection-stale', 'cursor-scope-mismatch', 'cursor-stale', 'report-row-unavailable'].includes(code)) {
    return { code: 'selection-stale', status: 409 };
  }
  if (['project-unresolved', 'project-ambiguous', 'mapping-required'].includes(code)) {
    return { code: 'mapping-required', status: 409 };
  }
  if (code === 'unsupported-connected') {
    return { code: 'unsupported-mode', status: 409 };
  }
  if (['cancelled', 'job-cancelled'].includes(code)) {
    return { code: 'cancelled', status: 409 };
  }
  if (['analysis-not-found', 'job-not-found', 'element-not-found', 'not-found'].includes(code)) {
    return { code: 'not-found', status: 404 };
  }
  if (['storage-failed', 'storage-unavailable', 'unavailable'].includes(code)) {
    return { code: 'storage-unavailable', status: 503 };
  }
  if (
    [
      'submission-conflict',
      'already-published',
      'job-not-queued',
      'job-not-retryable',
      'conflict',
      'stale',
      'attempt-limit',
      'packet-digest-mismatch',
    ].includes(code)
  ) {
    return { code: 'conflict', status: 409 };
  }
  if (code === 'request-too-large') {
    return { code, status: 413 };
  }
  return { code: 'invalid-request', status: 400 };
};
