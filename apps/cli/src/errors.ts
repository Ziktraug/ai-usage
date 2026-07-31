import { Data } from 'effect';
import type { CliUsageEngineError } from './usage-engine';

export class CliArgumentError extends Data.TaggedError('CliArgumentError')<{
  readonly message: string;
}> {}

export type AppError = CliArgumentError | CliUsageEngineError;

export const formatAppError = (error: AppError) => {
  if (error instanceof CliArgumentError) {
    return error.message;
  }
  return error.message;
};
