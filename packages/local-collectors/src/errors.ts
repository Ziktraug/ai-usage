import { Data } from 'effect';

export class LocalHistoryError extends Data.TaggedError('LocalHistoryError')<{
  readonly operation: string;
  readonly path?: string;
  readonly sql?: string;
  readonly cause: unknown;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const formatLocalHistoryError = (error: LocalHistoryError) => {
  const target = error.path ? ` ${error.path}` : error.sql ? ` SQL ${JSON.stringify(error.sql)}` : '';
  return `${error.operation}${target}: ${causeMessage(error.cause)}`;
};
