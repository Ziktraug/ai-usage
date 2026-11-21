export interface ManualOperationError {
  message: string;
  reason?: string;
  tag: string;
}

export type ManualOperationResult<T> = { data: T; ok: true } | { error: ManualOperationError; ok: false };
