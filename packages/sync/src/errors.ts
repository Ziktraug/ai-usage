import { Data } from 'effect';

export class SyncTransportError extends Data.TaggedError('SyncTransportError')<{
  readonly operation: string;
  readonly source: string;
  readonly message: string;
  readonly status?: number;
}> {}

export type SyncError = SyncTransportError;

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const transportError = (operation: string, source: string, cause: unknown, status?: number) =>
  new SyncTransportError({
    operation,
    source,
    message: `${operation} ${source}: ${causeMessage(cause)}`,
    ...(status === undefined ? {} : { status }),
  });
