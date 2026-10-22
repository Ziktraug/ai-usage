import { Data } from 'effect';
import type { CliUsageEngineError } from './usage-engine';

export class CliArgumentError extends Data.TaggedError('CliArgumentError')<{
  readonly message: string;
}> {}

/** A typed, path-free Work context read failure (`store-missing`, `store-not-upgraded`, …). */
export class CliWorkContextError extends Data.TaggedError('CliWorkContextError')<{
  readonly code: string;
  readonly message: string;
}> {}

export type AppError = CliArgumentError | CliUsageEngineError | CliWorkContextError;

export const formatAppError = (error: AppError) => {
  if (error instanceof CliArgumentError) {
    return error.message;
  }
  return error.message;
};
