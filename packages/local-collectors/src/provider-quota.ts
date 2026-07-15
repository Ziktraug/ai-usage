import type { ProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import type { Effect } from 'effect';

export interface ProviderQuotaCollectRequest {
  accountScope?: string | null;
  cursors?: Record<string, unknown>;
  from?: Date;
  machineId: string;
  machineLabel?: string | null;
  observedAt?: Date;
  signal?: AbortSignal;
}

export interface ProviderQuotaBatchCheckpoint {
  key: string;
  value: unknown;
}

export interface ProviderQuotaSourceEvent {
  key: string;
  observationIndex: number;
}

export interface ProviderQuotaBatch {
  checkpoints: ProviderQuotaBatchCheckpoint[];
  hasMore: boolean;
  observations: ProviderQuotaObservation[];
  sourceEvents: ProviderQuotaSourceEvent[];
}

export interface ProviderQuotaBatchSource<Error = unknown> {
  collect(request: ProviderQuotaCollectRequest): Effect.Effect<ProviderQuotaBatch, Error>;
}
