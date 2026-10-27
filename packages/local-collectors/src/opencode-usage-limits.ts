import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BoundedProcessError,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeOpenCodeUsageLimitsObservation } from '@ai-usage/report-core/provider-quota';
import { Data, Effect } from 'effect';
import type { ProviderQuotaBatchSource } from './provider-quota';

/**
 * OpenCode Go quota, read through the operator's own OpenCode CLI (2.2.0 and later). The CLI's
 * server owns the Console sign-in and calls the Console itself; AI Usage never reads
 * `auth.json` or a key, and never calls the Console. `--standalone` runs a private server for the
 * one request rather than the shared background service, which may belong to an older OpenCode
 * Desktop build that has no such route.
 */
const OPENCODE_USAGE_LIMITS_ARGS = ['api', '--standalone', 'experimental.usage.limits'] as const;

/**
 * Starting a private server takes a few seconds, and OpenCode gives its own Console reads fifteen.
 * The budget covers both, so a Console that cannot answer degrades to a warning from OpenCode itself
 * rather than a kill from this side.
 */
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 256 * 1024;

/**
 * Forced for the call: no colour, and none of the work a private server would otherwise start for an
 * interactive session — update check, file watching, the models catalogue fetch.
 */
const OPENCODE_ENVIRONMENT: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_FILEWATCHER: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
};

/** An abort is not a reason: the bounded runner kills the child and interrupts the read. */
export type OpenCodeQuotaCollectionErrorReason =
  | 'auth-required'
  | 'malformed-result'
  | 'protocol'
  | 'timeout'
  | 'unsupported';

export class OpenCodeQuotaCollectionError extends Data.TaggedError('OpenCodeQuotaCollectionError')<{
  readonly message: string;
  readonly reason: OpenCodeQuotaCollectionErrorReason;
}> {}

const collectionError = (reason: OpenCodeQuotaCollectionErrorReason, message: string): OpenCodeQuotaCollectionError =>
  new OpenCodeQuotaCollectionError({ message, reason });

export interface OpenCodeUsageLimitsSourceOptions {
  /** A bare name resolved on the bounded PATH, or an absolute path. Defaults to `opencode`. */
  readonly command?: string;
  readonly maximumOutputBytes?: number;
  /** Injected in tests. */
  readonly run?: BoundedProcessRunner;
  readonly timeoutMs?: number;
}

/**
 * The one stderr fact read: a CLI older than the route names the missing operation. Everything else
 * on stderr — stack traces, paths, Console diagnostics — is never returned.
 */
const classifyStderr = (stderr: string): string | null =>
  stderr.includes('Operation not found') ? 'unknown-operation' : null;

/** The Console workspace is the account boundary; only a digest of its id is stored. */
const workspaceFingerprint = (data: Record<string, unknown>): string | null => {
  const workspace = isRecord(data.workspace) ? data.workspace : null;
  const id = typeof workspace?.id === 'string' ? workspace.id.trim() : '';
  if (!id || id.length > 512) {
    return null;
  }
  return createHash('sha256').update(`ai-usage opencode workspace v1\n${id}`).digest('hex').slice(0, 16);
};

const processFailure = (error: BoundedProcessError): OpenCodeQuotaCollectionError => {
  switch (error.kind) {
    case 'unavailable':
      return collectionError('unsupported', 'The OpenCode CLI is unavailable on the bounded PATH.');
    case 'timed-out':
      return collectionError('timeout', 'The OpenCode usage-limits read timed out.');
    default:
      return collectionError('protocol', 'The OpenCode usage-limits read failed.');
  }
};

export const createOpenCodeUsageLimitsBatchSource = (
  options: OpenCodeUsageLimitsSourceOptions = {},
): ProviderQuotaBatchSource<OpenCodeQuotaCollectionError> => {
  const run = options.run ?? runBoundedProcess;
  const command = options.command ?? 'opencode';
  return {
    collect: (request) =>
      Effect.gen(function* () {
        if (command.includes('/') && !path.isAbsolute(command)) {
          return yield* collectionError('unsupported', 'The OpenCode executable must be absolute or a name on PATH.');
        }
        const result = yield* run({
          args: OPENCODE_USAGE_LIMITS_ARGS,
          classifyStderr,
          command,
          // The route answers for a location; a neutral one keeps the engine's checkout out of it.
          cwd: tmpdir(),
          env: OPENCODE_ENVIRONMENT,
          maximumOutputBytes: options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }).pipe(Effect.mapError(processFailure));
        if (result.exitCode !== 0) {
          return yield* result.stderrClass === 'unknown-operation'
            ? collectionError('unsupported', 'The installed OpenCode CLI predates the usage-limits route (2.2.0).')
            : collectionError('protocol', `The OpenCode usage-limits read exited with code ${result.exitCode}.`);
        }
        const response = yield* Effect.try({
          catch: () => collectionError('malformed-result', 'The OpenCode usage-limits read returned no JSON.'),
          try: (): unknown => JSON.parse(result.stdout),
        });
        if (!(isRecord(response) && 'data' in response)) {
          return yield* collectionError('malformed-result', 'The OpenCode usage-limits response has no data member.');
        }
        // `null` is OpenCode's own answer for a location not signed in to the Console.
        if (response.data === null) {
          return yield* collectionError('auth-required', 'OpenCode is not signed in to the OpenCode Console.');
        }
        if (!isRecord(response.data)) {
          return yield* collectionError('malformed-result', 'The OpenCode usage-limits data is not an object.');
        }
        const observation = normalizeOpenCodeUsageLimitsObservation({
          accountScope: workspaceFingerprint(response.data),
          machineId: request.machineId,
          ...(request.machineLabel === undefined ? {} : { machineLabel: request.machineLabel }),
          observedAt: request.observedAt ?? new Date(),
          result: response.data,
        });
        if (observation === null) {
          return yield* collectionError('malformed-result', 'The OpenCode usage limits could not be normalised.');
        }
        return { checkpoints: [], hasMore: false, observations: [observation], sourceEvents: [] };
      }),
  };
};
