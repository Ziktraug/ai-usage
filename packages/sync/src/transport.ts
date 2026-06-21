import fs from 'node:fs';
import { parseUsageSnapshot, type UsageSnapshot } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';
import { SyncTransportError, transportError } from './errors';

export interface SnapshotEndpointHealth {
  ok: boolean;
  machine: {
    id: string;
    label: string;
  };
}

export interface SnapshotTransportOptions {
  timeoutMs?: number;
}

const readFileText = (filePath: string) =>
  Effect.try({
    try: () => fs.readFileSync(filePath, 'utf8'),
    catch: (cause) => transportError('readFile', filePath, cause),
  });

const parseSnapshotText = (source: string, text: string) =>
  Effect.try({
    try: () => parseUsageSnapshot(text),
    catch: (cause) => transportError('parseSnapshot', source, cause),
  });

export const readSnapshotFile = (filePath: string): Effect.Effect<UsageSnapshot, SyncTransportError> =>
  readFileText(filePath).pipe(Effect.flatMap((text) => parseSnapshotText(filePath, text)));

const authHeaders = (token: string | null) => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
};

const fetchText = (url: string, token: string | null, options: SnapshotTransportOptions = {}) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () => {
        const controller = options.timeoutMs ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
        try {
          return await fetch(url, {
            headers: authHeaders(token),
            ...(controller ? { signal: controller.signal } : {}),
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      catch: (cause) => transportError('fetch', url, cause),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => transportError('read', url, cause, response.status),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new SyncTransportError({
          operation: 'fetch',
          source: url,
          status: response.status,
          message: `fetch ${url}: HTTP ${response.status} ${text}`,
        }),
      );
    }

    return text;
  });

export const fetchRemoteSnapshot = (
  url: string,
  token: string | null,
  options?: SnapshotTransportOptions,
): Effect.Effect<UsageSnapshot, SyncTransportError> =>
  fetchText(url, token, options).pipe(Effect.flatMap((text) => parseSnapshotText(url, text)));

const parseEndpointHealth = (url: string, text: string) =>
  Effect.try({
    try: () => {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('health must be an object');
      const record = value as Record<string, unknown>;
      const machine = record.machine;
      if (record.ok !== true) throw new Error('health ok must be true');
      if (typeof machine !== 'object' || machine === null || Array.isArray(machine))
        throw new Error('health machine must be an object');
      const machineRecord = machine as Record<string, unknown>;
      if (typeof machineRecord.id !== 'string') throw new Error('health machine missing id');
      if (typeof machineRecord.label !== 'string') throw new Error('health machine missing label');
      return { ok: true, machine: { id: machineRecord.id, label: machineRecord.label } };
    },
    catch: (cause) => transportError('parseHealth', url, cause),
  });

export const readSnapshotEndpointHealth = (
  url: string,
  token: string | null,
  options?: SnapshotTransportOptions,
): Effect.Effect<SnapshotEndpointHealth, SyncTransportError> =>
  fetchText(url, token, options).pipe(Effect.flatMap((text) => parseEndpointHealth(url, text)));
