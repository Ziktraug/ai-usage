import { formatLocalHistoryError, type LocalHistoryError } from '@ai-usage/local-collectors/errors';
import { Data } from 'effect';

export class CliArgumentError extends Data.TaggedError('CliArgumentError')<{
  readonly message: string;
}> {}

export type AppError = LocalHistoryError | CliArgumentError;

export const formatAppError = (error: AppError) => {
  if (error._tag === 'CliArgumentError') {
    return error.message;
  }
  return formatLocalHistoryError(error);
};
