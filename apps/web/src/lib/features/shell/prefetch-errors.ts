import { SessionQueryValidationError } from '@ai-usage/report-core/session-query';
import { ORPCError } from '@orpc/client';
import { isCancelledError } from '@tanstack/svelte-query';
import { SessionReadUnavailableError, SessionRevisionExpiredError } from '../../query/options/session-window';
import { FocusedReportRevisionExpiredError } from '../report/composition/report-destination';
import { ReportBootstrapUnavailableError, ReportReadUnavailableError } from '../report/core/report-errors';

const NETWORK_FAILURE_PATTERN =
  /^(Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i;

// Read-side availability/policy failures declared by the contract, plus transport failures.
// Validation, internal failures and unknown codes are defects even when optional reads may continue.
const EXPECTED_RPC_CODES = new Set([
  'Unavailable',
  'EngineUnavailable',
  'IncompatibleStore',
  'RevisionExpired',
  'Forbidden',
  'ForbiddenDemo',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'TIMEOUT',
  'NETWORK_ERROR',
  'CLIENT_CLOSED_REQUEST',
  'REQUEST_TIMEOUT',
]);

export const isExpectedPrefetchFailure = (cause: unknown): boolean =>
  (cause instanceof ORPCError && EXPECTED_RPC_CODES.has(cause.code)) ||
  isCancelledError(cause) ||
  (cause instanceof Error && cause.name === 'AbortError') ||
  (cause instanceof TypeError && NETWORK_FAILURE_PATTERN.test(cause.message)) ||
  cause instanceof ReportBootstrapUnavailableError ||
  cause instanceof ReportReadUnavailableError ||
  cause instanceof SessionReadUnavailableError ||
  cause instanceof SessionRevisionExpiredError ||
  cause instanceof FocusedReportRevisionExpiredError ||
  cause instanceof SessionQueryValidationError;

/** Expected request failures stay in Query; defects must remain observable without breaking routing. */
export const reportUnexpectedPrefetchFailure = (cause: unknown): void => {
  if (isExpectedPrefetchFailure(cause)) {
    return;
  }
  if (typeof window !== 'undefined' && typeof globalThis.reportError === 'function') {
    globalThis.reportError(cause);
  } else {
    console.error('Unexpected navigation prefetch failure', cause);
  }
};
