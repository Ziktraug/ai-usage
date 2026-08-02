import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
import type { UsageEngineErrorCode } from '@ai-usage/usage-engine-control';

export class UsageEngineFatalConsistencyError extends AggregateError {
  override readonly name = 'UsageEngineFatalConsistencyError';
}

export type UsageEngineCommandErrorCode = Extract<
  UsageEngineErrorCode,
  | 'command-rejected'
  | 'merge-invalid-input'
  | 'merge-invalid-json'
  | 'merge-self-merge'
  | 'merge-store-failed'
  | 'preview-stale'
>;

export class UsageEngineCommandError extends Error {
  readonly code: UsageEngineCommandErrorCode;
  override readonly name = 'UsageEngineCommandError';

  constructor(code: UsageEngineCommandErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export type UsageEngineSoftSourceErrorReason = 'disabled' | 'failed' | 'not-admitted' | 'not-detected' | 'timed-out';

export class UsageEngineSoftSourceError extends Error {
  override readonly name = 'UsageEngineSoftSourceError';
  readonly reason: UsageEngineSoftSourceErrorReason;
  readonly snapshot: SourceControlView;
  readonly sourceId: CollectionSourceId;

  constructor(input: {
    readonly reason: UsageEngineSoftSourceErrorReason;
    readonly snapshot: SourceControlView;
    readonly sourceId: CollectionSourceId;
  }) {
    super(`Usage source ${input.sourceId} completed with ${input.reason}.`);
    this.reason = input.reason;
    this.snapshot = input.snapshot;
    this.sourceId = input.sourceId;
  }
}
