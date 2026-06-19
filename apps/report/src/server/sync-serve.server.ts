import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

export interface StartSyncServeShareInput {
  port: number;
}

export interface SyncServeShareInstructions {
  state: SyncServeState;
  envKey: string;
  envPath: string;
  remoteName: string;
  snapshotUrl: string;
  copyText: string;
}

export interface SyncServeRuntimeDeps {
  getMachine: () => Promise<UsageMachine>;
  collectSnapshot: (machine: UsageMachine) => Promise<UsageSnapshot>;
  startServer: (input: SnapshotServerInput) => Promise<SnapshotServerHandle>;
  generateSecret: () => string;
  upsertEnvToken: (key: string, value: string) => Promise<{ path: string }>;
  now: () => Date;
}

const defaultHost = '127.0.0.1';
const defaultPort = 3847;
const maxRecentRequests = 20;

const tokenRequiredForHost = (host: string) => host === '0.0.0.0';

const shellToken = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

const remoteNameForMachine = (machine: UsageMachine) =>
  machine.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'remote';

export const syncTokenEnvNameForMachine = (machine: UsageMachine) =>
  `AI_USAGE_SYNC_${shellToken(machine.label || machine.id) || 'REMOTE'}_TOKEN`;

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const shareCopyText = (input: { envKey: string; secret: string; remoteName: string; snapshotUrl: string }) =>
  `TOKEN_ENV=${shellQuote(input.envKey)}
TOKEN_VALUE=${shellQuote(input.secret)}
ENV_FILE=.env
touch "$ENV_FILE"
awk -v key="$TOKEN_ENV" -v value="$TOKEN_VALUE" 'BEGIN { found = 0 } $0 ~ "^" key "=" { print key "=" value; found = 1; next } { print } END { if (!found) print key "=" value }' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
bun run cli -- sync add ${shellQuote(input.remoteName)} ${shellQuote(input.snapshotUrl)} --token-env "$TOKEN_ENV"
bun run cli -- sync pull ${shellQuote(input.remoteName)}`;

const isAddressAlreadyInUse = (state: SyncServeState) =>
  state.status === 'error' && /EADDRINUSE|address already in use/i.test(state.lastError?.message ?? '');

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

  const startShare = async (
    input: StartSyncServeShareInput,
  ): Promise<SyncServerResult<SyncServeShareInstructions>> => {
    if (state.status === 'running' || state.status === 'starting') {
      return errorResult(
        'SyncServeError',
        'Stop the current snapshot server before generating a new all-in-one setup.',
        'serve-already-running',
      );
    }

    const machine = await deps.getMachine();
    const secret = deps.generateSecret();
    const envKey = syncTokenEnvNameForMachine(machine);
    const { path: envPath } = await deps.upsertEnvToken(envKey, secret);
    let started = await start({ host: '0.0.0.0', port: input.port, token: secret });
    if (started.ok && isAddressAlreadyInUse(started.data) && input.port !== 0) {
      started = await start({ host: '0.0.0.0', port: 0, token: secret });
    }
    if (!started.ok) return started;
    if (started.data.status !== 'running' || !started.data.urls[0]) {
      return errorResult(
        'SyncServeError',
        started.data.lastError?.message ?? 'Snapshot server did not start.',
        started.data.lastError?.reason,
      );
    }

    const remoteName = remoteNameForMachine(machine);
    const snapshotUrl = started.data.urls[0];
    return ok({
      state: started.data,
      envKey,
      envPath,
      remoteName,
      snapshotUrl,
      copyText: shareCopyText({ envKey, secret, remoteName, snapshotUrl }),
    });
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
    startShare,
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

export const syncServeShareInputFrom = (input: unknown): StartSyncServeShareInput => {
  const record = objectInput(input);
  return {
    port: positiveNumberField(record, 'port'),
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

const findWorkspaceRoot = (cwd = process.cwd()) => {
  let current = path.resolve(cwd);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { workspaces?: unknown };
        if (parsed.workspaces) return current;
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
};

export const upsertEnvToken = async (key: string, value: string, cwd = process.cwd()) => {
  const envPath = path.join(findWorkspaceRoot(cwd), '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escapedKey}=.*$`, 'm');
  const next = matcher.test(existing)
    ? existing.replace(matcher, line)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, next, 'utf8');
  return { path: envPath };
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
  generateSecret: () => crypto.randomBytes(32).toString('base64url'),
  upsertEnvToken,
  now: () => new Date(),
});

export const getSyncServeStateForServer = () => defaultRuntime.getState();

export const startSyncServeForServer = (input: StartSyncServeInput) => defaultRuntime.start(input);

export const startSyncServeShareForServer = (input: StartSyncServeShareInput) => defaultRuntime.startShare(input);

export const stopSyncServeForServer = () => defaultRuntime.stop();
