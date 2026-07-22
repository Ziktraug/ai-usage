import { constants } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Effect, Layer, Ref } from 'effect';
import type { WideEventSnapshot } from '../model';
import { serializeWideEventSnapshot } from '../sanitize';
import { makeEmptyWideEventSinkDiagnostics, noopWideEventSink, WideEventSink, type WideEventSinkShape } from '../sink';
import { assertSafeRegularFilePath, ensureOwnedLogDirectory, withCooperativeLock } from './lock';
import { resolveWideEventLogDirectory } from './resolve-log-dir';

const FILE_PREFIX = 'wide-events-';
const FILE_SUFFIX = '.ndjson';
const FILE_PATTERN = /^wide-events-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.ndjson$/;
const DEFAULT_APPEND_TIMEOUT_MS = 1000;
const DEFAULT_QUEUE_CAPACITY = 128;
const DEFAULT_DRAIN_TIMEOUT_MS = 2000;
const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_SIZE_MB = 50;
const WARNING_RATE_LIMIT_MS = 30_000;

type AppendLine = (filePath: string, line: string, signal: AbortSignal) => Promise<void>;

export interface FileWideEventSinkOptions {
  readonly appendLine?: AppendLine;
  readonly appendTimeoutMs?: number;
  readonly directory: string;
  readonly drainTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly maxFiles?: number;
  readonly maxSizeMb?: number;
  readonly now?: () => Date;
  readonly queueCapacity?: number;
  readonly sweepFiles?: (directory: string, maxFiles: number) => Promise<void>;
  readonly warn?: (warning: FileWideEventWarning) => void;
}

export type FileWideEventWarningKind =
  | 'append-failure'
  | 'append-timeout'
  | 'circuit-open'
  | 'lock-timeout'
  | 'queue-full'
  | 'sweep-failure';

export interface FileWideEventWarning {
  readonly counters: {
    readonly dropped: number;
    readonly failed: number;
  };
  readonly kind: FileWideEventWarningKind;
  readonly message: string;
}

const WARNING_MESSAGES: Readonly<Record<FileWideEventWarningKind, string>> = {
  'append-failure': 'Wide-event file append failed.',
  'append-timeout': 'Wide-event file append exceeded its deadline; the circuit is open.',
  'circuit-open': 'Wide-event file delivery is disabled because its circuit is open.',
  'lock-timeout': 'Wide-event file lock acquisition timed out.',
  'queue-full': 'Wide-event file queue is full; the record was dropped.',
  'sweep-failure': 'Wide-event file retention sweep failed.',
};

interface PendingRecord {
  readonly event: WideEventSnapshot;
}

class AppendBlockedError extends Error {
  override readonly name = 'AppendBlockedError';
}

class AppendInterruptedError extends Error {
  override readonly name = 'AppendInterruptedError';
}

class LockTimeoutError extends Error {
  override readonly name = 'LockTimeoutError';
}

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

const suffixNumber = (filename: string): number => {
  const match = filename.match(FILE_PATTERN);
  return match?.[2] ? Number(match[2]) : 0;
};

const compareFileSequence = (left: string, right: string): number => {
  const leftDate = left.match(FILE_PATTERN)?.[1] ?? '';
  const rightDate = right.match(FILE_PATTERN)?.[1] ?? '';
  return leftDate.localeCompare(rightDate) || suffixNumber(left) - suffixNumber(right) || left.localeCompare(right);
};

const withTimeout = async (
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  registerExternalAbort: (abort: (() => void) | undefined) => void,
  onTimeout: () => void,
): Promise<void> => {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(() => operation(controller.signal));
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (error: Error): void => {
    rejectCancellation(error);
    controller.abort();
  };
  registerExternalAbort(() => abort(new AppendInterruptedError('Wide-event file append interrupted by shutdown')));
  timeout = setTimeout(() => {
    onTimeout();
    abort(new AppendBlockedError(`Wide-event file append exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    await Promise.race([pending, cancellation]);
  } catch (error) {
    await pending.catch(() => undefined);
    throw error;
  } finally {
    registerExternalAbort(undefined);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const selectTargetFile = async ({
  directory,
  lineBytes,
  maxBytes,
  today,
}: {
  readonly directory: string;
  readonly lineBytes: number;
  readonly maxBytes: number;
  readonly today: string;
}): Promise<string> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const daily = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${FILE_PREFIX}${today}`))
    .map(({ name }) => name)
    .filter((name) => FILE_PATTERN.test(name))
    .sort((left, right) => suffixNumber(left) - suffixNumber(right));
  const latest = daily.at(-1) ?? `${FILE_PREFIX}${today}${FILE_SUFFIX}`;
  const latestPath = path.join(directory, latest);

  try {
    assertSafeRegularFilePath(latestPath);
    const metadata = await stat(latestPath);
    if (metadata.size + lineBytes <= maxBytes) {
      return latestPath;
    }
    const nextSuffix = suffixNumber(latest) + 1;
    return path.join(directory, `${FILE_PREFIX}${today}.${nextSuffix}${FILE_SUFFIX}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return latestPath;
    }
    throw error;
  }
};

const sweepOldFiles = async (directory: string, maxFiles: number): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && FILE_PATTERN.test(entry.name))
        .map(async ({ name }) => {
          const filePath = path.join(directory, name);
          try {
            assertSafeRegularFilePath(filePath);
            const metadata = await stat(filePath);
            return { mtimeMs: metadata.mtimeMs, name, path: filePath };
          } catch {
            return null;
          }
        }),
    )
  ).filter((file): file is { mtimeMs: number; name: string; path: string } => file !== null);

  files.sort((left, right) => left.mtimeMs - right.mtimeMs || compareFileSequence(left.name, right.name));

  for (const file of files.slice(0, Math.max(0, files.length - maxFiles))) {
    await unlink(file.path);
  }
};

const defaultAppendLine: AppendLine = async (filePath, line, signal) => {
  // biome-ignore lint/suspicious/noBitwiseOperators: open flags are OR'd intentionally
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY;
  const handle = await open(filePath, flags, 0o600);
  try {
    const metadata = await handle.stat();
    if (!(metadata.isFile() && metadata.nlink === 1)) {
      throw new Error(`Refusing unsafe wide-event log file: ${filePath}`);
    }
    await handle.appendFile(line, { encoding: 'utf8', signal });
    try {
      await handle.chmod(0o600);
    } catch {
      // Best-effort mode repair.
    }
  } finally {
    await handle.close();
  }
};

export const createFileWideEventSink = (
  options: FileWideEventSinkOptions,
): WideEventSinkShape & {
  readonly drain: () => Promise<void>;
  readonly dispose: () => Promise<void>;
} => {
  const directory = options.directory;
  const appendLine = options.appendLine ?? defaultAppendLine;
  const appendTimeoutMs = options.appendTimeoutMs ?? DEFAULT_APPEND_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? 1000;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = Math.max(0, (options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB) * 1024 * 1024);
  const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? (() => undefined);
  const sweepFiles = options.sweepFiles ?? sweepOldFiles;

  const diagnostics = Ref.unsafeMake(makeEmptyWideEventSinkDiagnostics());
  const pending: PendingRecord[] = [];
  let circuitOpen = false;
  let outstanding = 0;
  let resolveIdle: (() => void) | undefined;
  let idle = Promise.resolve();
  let workerRunning = false;
  let accepting = true;
  let disposed = false;
  let abortActiveAppend: (() => void) | undefined;
  let lastSweptTarget: string | undefined;
  const warningTimes = new Map<FileWideEventWarningKind, number>();

  const markSettled = (): void => {
    outstanding -= 1;
    if (outstanding === 0) {
      resolveIdle?.();
      resolveIdle = undefined;
    }
  };

  const bump = (field: 'accepted' | 'dropped' | 'failed'): void => {
    Effect.runSync(
      Ref.update(diagnostics, (current) => ({
        ...current,
        [field]: current[field] + 1,
      })),
    );
  };

  const warnKind = (kind: FileWideEventWarningKind): void => {
    const warningAt = now().getTime();
    const previous = warningTimes.get(kind);
    if (previous !== undefined && warningAt - previous < WARNING_RATE_LIMIT_MS) {
      return;
    }
    warningTimes.set(kind, warningAt);
    const current = Effect.runSync(Ref.get(diagnostics));
    try {
      warn({
        counters: { dropped: current.dropped, failed: current.failed },
        kind,
        message: WARNING_MESSAGES[kind],
      });
    } catch {
      // A diagnostic callback must never change delivery behavior.
    }
  };

  const dropPending = (): void => {
    for (const _record of pending.splice(0)) {
      bump('dropped');
      markSettled();
    }
  };

  const openCircuitAtDeadline = (): void => {
    if (!circuitOpen) {
      circuitOpen = true;
      warnKind('append-timeout');
      dropPending();
    }
  };

  const appendEvent = async (event: WideEventSnapshot): Promise<void> => {
    ensureOwnedLogDirectory(directory);
    const line = `${serializeWideEventSnapshot(event)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const locked = await withCooperativeLock(
      directory,
      async () => {
        const target = await selectTargetFile({
          directory,
          lineBytes,
          maxBytes,
          today: dateKey(now()),
        });
        assertSafeRegularFilePath(target);
        // Timeout covers filesystem I/O only; lock wait is bounded separately.
        await withTimeout(
          (signal) => appendLine(target, line, signal),
          appendTimeoutMs,
          (abort) => {
            abortActiveAppend = abort;
          },
          openCircuitAtDeadline,
        );
        if (lastSweptTarget !== target) {
          try {
            await sweepFiles(directory, maxFiles);
            lastSweptTarget = target;
          } catch {
            warnKind('sweep-failure');
          }
        }
      },
      lockTimeoutMs,
    );
    if (locked === null) {
      throw new LockTimeoutError('Wide-event file lock timed out');
    }
  };

  const drainQueue = async (): Promise<void> => {
    workerRunning = true;
    while (!(circuitOpen || disposed)) {
      const item = pending.shift();
      if (!item) {
        break;
      }
      try {
        await appendEvent(item.event);
        bump('accepted');
      } catch (error) {
        if (error instanceof AppendBlockedError) {
          circuitOpen = true;
          bump('failed');
        } else if (error instanceof AppendInterruptedError) {
          bump('dropped');
        } else if (error instanceof LockTimeoutError) {
          bump('failed');
          warnKind('lock-timeout');
        } else {
          bump('failed');
          warnKind('append-failure');
        }
      } finally {
        markSettled();
      }
    }
    if (circuitOpen) {
      dropPending();
    }
    workerRunning = false;
  };

  const enqueue = (event: WideEventSnapshot): void => {
    if (!accepting || circuitOpen) {
      bump('dropped');
      if (circuitOpen) {
        warnKind('circuit-open');
      }
      return;
    }
    if (outstanding >= queueCapacity) {
      bump('dropped');
      warnKind('queue-full');
      return;
    }
    if (outstanding === 0) {
      idle = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
    }
    outstanding += 1;
    pending.push({ event });
    if (!workerRunning) {
      drainQueue().catch(() => undefined);
    }
  };

  const drainBeforeDeadline = async (): Promise<boolean> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), drainTimeoutMs);
    });
    try {
      return await Promise.race([idle.then(() => true as const), timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  const drain = async (): Promise<void> => {
    await drainBeforeDeadline();
  };

  const dispose = async (): Promise<void> => {
    accepting = false;
    const drained = await drainBeforeDeadline();
    disposed = true;
    if (!drained) {
      abortActiveAppend?.();
    }
    dropPending();
  };

  return {
    submit: (event) => Effect.sync(() => enqueue(event)),
    diagnostics: () =>
      Ref.get(diagnostics).pipe(
        Effect.map((current) =>
          disposed && outstanding > 0 ? { ...current, dropped: current.dropped + outstanding } : current,
        ),
      ),
    drain,
    dispose,
  };
};

export const makeFileWideEventSinkLayer = (
  options: Omit<FileWideEventSinkOptions, 'directory'> & {
    readonly directory?: string | null;
  } = {},
): Layer.Layer<WideEventSink> =>
  Layer.scoped(
    WideEventSink,
    Effect.gen(function* () {
      const directory =
        options.directory === undefined
          ? yield* Effect.promise(() => resolveWideEventLogDirectory())
          : options.directory;
      if (directory === null) {
        return noopWideEventSink;
      }
      const sink = createFileWideEventSink({ ...options, directory });
      yield* Effect.addFinalizer(() => Effect.promise(() => sink.dispose()));
      return sink;
    }),
  );
