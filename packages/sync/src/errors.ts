import { Data } from 'effect';

export class SyncTransportError extends Data.TaggedError('SyncTransportError')<{
  readonly operation: string;
  readonly source: string;
  readonly message: string;
  readonly status?: number;
}> {}

export type SyncWorkflowErrorReason =
  | 'invalid-token-env'
  | 'invalid-url'
  | 'missing-token'
  | 'no-remotes'
  | 'self-sync'
  | 'unknown-remote';

export class SyncWorkflowError extends Data.TaggedError('SyncWorkflowError')<{
  readonly operation: string;
  readonly message: string;
  readonly reason?: SyncWorkflowErrorReason;
  readonly remoteName?: string;
}> {}

export class SyncServerError extends Data.TaggedError('SyncServerError')<{
  readonly operation: string;
  readonly message: string;
}> {}

export type SyncError = SyncTransportError | SyncWorkflowError | SyncServerError;

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const transportError = (operation: string, source: string, cause: unknown, status?: number) =>
  new SyncTransportError({
    operation,
    source,
    message: `${operation} ${source}: ${causeMessage(cause)}`,
    ...(status === undefined ? {} : { status }),
  });
