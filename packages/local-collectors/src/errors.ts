import { Data } from 'effect';

export class LocalHistoryError extends Data.TaggedError('LocalHistoryError')<{
  readonly operation: string;
  readonly path?: string;
  readonly sql?: string;
  readonly cause: unknown;
}> {}

export interface LocalHistoryWarning {
  readonly harness?: string;
  readonly operation: string;
  readonly path?: string;
  readonly sql?: string;
  readonly message: string;
}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const formatLocalHistoryError = (error: LocalHistoryError) => {
  const target = error.path ? ` ${error.path}` : error.sql ? ` SQL ${JSON.stringify(error.sql)}` : '';
  return `${error.operation}${target}: ${causeMessage(error.cause)}`;
};

export const localHistoryWarningFromError = (
  error: LocalHistoryError,
  options: { harness?: string; message?: string } = {},
): LocalHistoryWarning => ({
  operation: error.operation,
  message: options.message ? `${options.message}: ${formatLocalHistoryError(error)}` : formatLocalHistoryError(error),
  ...(options.harness ? { harness: options.harness } : {}),
  ...(error.path ? { path: error.path } : {}),
  ...(error.sql ? { sql: error.sql } : {}),
});
