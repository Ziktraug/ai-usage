import type { UsageMachine, UsageSnapshot } from '@ai-usage/core/snapshot';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { createLocalUsageSnapshot } from '@ai-usage/reporting';
import {
  startNodeSnapshotServer,
  type SnapshotRequestEvent,
  type SnapshotServerHandle,
  type SnapshotServerInput,
} from '@ai-usage/sync/server';
import { Effect } from 'effect';
import type { SyncServerResult } from './sync.server';

export type SyncServeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface SyncServeRequestEvent extends SnapshotRequestEvent {
  at: string;
}

export interface SyncServeState {
  status: SyncServeStatus;
  host: string;
  port: number;
  urls: string[];
  machine?: UsageMachine;
  tokenRequired: boolean;
  tokenConfigured: boolean;
  startedAt?: string;
  lastError?: {
    message: string;
    tag?: string;
    reason?: string;
  };
  recentRequests: SyncServeRequestEvent[];
}

export interface StartSyncServeInput {
  host: string;
  port: number;
  token: string | null;
}

export interface SyncServeRuntimeDeps {
  getMachine: () => Promise<UsageMachine>;
  collectSnapshot: (machine: UsageMachine) => Promise<UsageSnapshot>;
  startServer: (input: SnapshotServerInput) => Promise<SnapshotServerHandle>;
  now: () => Date;
}

const defaultHost = '127.0.0.1';
const defaultPort = 3847;
const maxRecentRequests = 20;

const tokenRequiredForHost = (host: string) => host === '0.0.0.0';

const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const ok = <T>(data: T): SyncServerResult<T> => ({ ok: true, data: toJson(data) });

const errorResult = (tag: string, message: string, reason?: string): SyncServerResult<never> => ({
  ok: false,
  error: {
    tag,
    message,
    ...(reason ? { reason } : {}),
  },
});

export const createSyncServeRuntime = (deps: SyncServeRuntimeDeps) => {
  let handle: SnapshotServerHandle | null = null;
  let state: SyncServeState = {
    status: 'stopped',
    host: defaultHost,
    port: defaultPort,
    urls: [],
    tokenRequired: false,
    tokenConfigured: false,
    recentRequests: [],
  };

  const publicState = () => ({
    ...state,
    tokenRequired: tokenRequiredForHost(state.host),
    recentRequests: [...state.recentRequests],
  });

  const pushRequest = (event: SnapshotRequestEvent) => {
    state = {
      ...state,
      recentRequests: [{ ...event, at: deps.now().toISOString() }, ...state.recentRequests].slice(0, maxRecentRequests),
    };
  };

  const start = async (input: StartSyncServeInput): Promise<SyncServerResult<SyncServeState>> => {
    if (state.status === 'running' || state.status === 'starting') return ok(publicState());

    const host = input.host.trim() || defaultHost;
    const token = input.token?.trim() || null;
    if (tokenRequiredForHost(host) && !token) {
      state = {
        ...state,
        status: 'error',
        host,
        port: input.port,
        tokenConfigured: false,
        lastError: {
          tag: 'SyncServeError',
          reason: 'missing-serve-token',
          message: 'A token is required when serving on 0.0.0.0.',
        },
      };
      return ok(publicState());
    }

    const { lastError: _startingLastError, ...startingState } = state;
    state = {
      ...startingState,
      status: 'starting',
      host,
      port: input.port,
      tokenConfigured: !!token,
    };

    try {
      const machine = await deps.getMachine();
      const nextHandle = await deps.startServer({
        host,
        port: input.port,
        token,
        machine,
        collectSnapshot: () => deps.collectSnapshot(machine),
        onRequest: pushRequest,
      });
      handle = nextHandle;
      const { lastError: _runningLastError, ...runningState } = state;
      state = {
        ...runningState,
        status: 'running',
        port: nextHandle.port,
        urls: nextHandle.urls,
        machine,
        tokenConfigured: !!token,
        startedAt: deps.now().toISOString(),
      };
      return ok(publicState());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      state = {
        ...state,
        status: 'error',
        urls: [],
        tokenConfigured: !!token,
        lastError: { tag: 'SyncServeError', message },
      };
      return ok(publicState());
    }
  };

  const stop = async (): Promise<SyncServerResult<SyncServeState>> => {
    if (state.status === 'stopped' && !handle) return ok(publicState());
    state = { ...state, status: 'stopping' };
    try {
      await handle?.stop();
      handle = null;
      const { startedAt: _stoppedStartedAt, lastError: _stoppedLastError, ...stoppedState } = state;
      state = {
        ...stoppedState,
        status: 'stopped',
        urls: [],
        tokenConfigured: false,
      };
      return ok(publicState());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      state = { ...state, status: 'error', lastError: { tag: 'SyncServeError', message } };
      return ok(publicState());
    }
  };

  return {
    getState: () => ok(publicState()),
    start,
    stop,
  };
};

export const syncServeStartInputFrom = (input: unknown): StartSyncServeInput => {
  const record = objectInput(input);
  return {
    host: stringField(record, 'host'),
    port: positiveNumberField(record, 'port'),
    token: nullableStringField(record, 'token'),
  };
};

const objectInput = (input: unknown): Record<string, unknown> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected object input');
  return input as Record<string, unknown>;
};

const stringField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (typeof value !== 'string' || !value) throw new Error(`Expected ${field} to be a non-empty string`);
  return value;
};

const nullableStringField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`Expected ${field} to be a string or null`);
  return value || null;
};

const positiveNumberField = (record: Record<string, unknown>, field: string) => {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new Error(`Expected ${field} to be a positive number`);
  return value;
};

const defaultRuntime = createSyncServeRuntime({
  getMachine: () => Effect.runPromise(ensureMachineConfig.pipe(Effect.provide(LocalHistoryStorageLive))),
  collectSnapshot: (machine) =>
    Effect.runPromise(
      createLocalUsageSnapshot({
        machine,
        harness: null,
        includeCursor: true,
        includeFacets: true,
      }).pipe(Effect.provide(LocalHistoryStorageLive)),
    ),
  startServer: (input) => Effect.runPromise(startNodeSnapshotServer(input)),
  now: () => new Date(),
});

export const getSyncServeStateForServer = () => defaultRuntime.getState();

export const startSyncServeForServer = (input: StartSyncServeInput) => defaultRuntime.start(input);

export const stopSyncServeForServer = () => defaultRuntime.stop();
