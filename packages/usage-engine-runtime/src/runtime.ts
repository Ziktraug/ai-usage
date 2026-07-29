import type {
  UsageEngineCommand,
  UsageEngineCommandResult,
  UsageEngineEvent,
  UsageEngineStatus,
} from '@ai-usage/usage-engine-control';

export interface UsageEngineRuntime {
  readonly changes: () => AsyncIterable<UsageEngineEvent>;
  readonly dispose: () => Promise<void>;
  readonly execute: (command: UsageEngineCommand) => Promise<UsageEngineCommandResult>;
  readonly start: () => Promise<void>;
  readonly status: () => Promise<UsageEngineStatus>;
}

export type UsageEngineRuntimeFactory = () => Promise<UsageEngineRuntime>;

export const defineUsageEngineRuntimeFactory = (factory: UsageEngineRuntimeFactory): UsageEngineRuntimeFactory =>
  factory;
