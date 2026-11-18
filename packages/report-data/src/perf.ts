import { Cause, Console, Effect, Exit } from 'effect';

type PerfField = boolean | number | string | null | undefined;
type PerfSummary = Record<string, PerfField>;

export const perfEnabled = () => process.env.AI_USAGE_PERF === '1' || process.env.AI_USAGE_PERF === 'true';

const BYTES_PER_MB = 1024 * 1024;
const MICROSECONDS_PER_MS = 1000;

/** One process-wide reading: wall clock, CPU consumed so far, resident set and JS heap in use. */
interface PerfReading {
  readonly at: number;
  readonly cpuMicroseconds: number;
  readonly heapUsedMb: number;
  readonly rssMb: number;
}

const megabytes = (bytes: number) => Math.round((bytes / BYTES_PER_MB) * 10) / 10;

const readPerf = (): PerfReading => {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    at: Date.now(),
    cpuMicroseconds: cpu.user + cpu.system,
    heapUsedMb: megabytes(memory.heapUsed),
    rssMb: megabytes(memory.rss),
  };
};

/**
 * What a span cost. The figures are process-wide, so a span also carries whatever ran concurrently
 * with it; a child span's figures are included in its parent's.
 */
const resourceSummary = (before: PerfReading): PerfSummary => {
  const after = readPerf();
  return {
    durationMs: after.at - before.at,
    cpuMs: Math.round((after.cpuMicroseconds - before.cpuMicroseconds) / MICROSECONDS_PER_MS),
    rssMbBefore: before.rssMb,
    rssMbAfter: after.rssMb,
    heapUsedMbBefore: before.heapUsedMb,
    heapUsedMbAfter: after.heapUsedMb,
  };
};

const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** A short identifier (an error tag, an operation name, a reason or errno code), or nothing. */
const safeToken = (value: unknown): string | undefined =>
  typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;

/**
 * Names a failure without printing its message. These lines go to stderr, and a message can hold
 * the store path or a transcript path: `UsageStoreError.message` starts with the operation and the
 * database path. Only identifiers are printed, and a value that is not shaped like one is left out.
 */
const errorSummary = (failure: unknown): PerfSummary => {
  try {
    if (Cause.isCause(failure)) {
      return Cause.hasInterruptsOnly(failure) ? { error: 'interrupted' } : errorSummary(Cause.squash(failure));
    }
    if (typeof failure !== 'object' || failure === null) {
      return { error: 'unknown' };
    }
    const member = (key: string) => safeToken((failure as Record<string, unknown>)[key]);
    return {
      error: member('_tag') ?? (failure instanceof Error ? member('name') : undefined) ?? 'unknown',
      errorOperation: member('operation'),
      errorReason: member('reason'),
      errorCode: member('code'),
    };
  } catch {
    // Reading the failure threw. The span still reports its figures, and the failure stays as it is.
    return { error: 'unknown' };
  }
};

/**
 * The caller's own fields. They only decorate the line: when the callback throws, the span still
 * reports its figures, names the callback's error, and the wrapped work keeps its result.
 */
const callerSummary = <A>(value: A, summarize?: (value: A) => PerfSummary): PerfSummary => {
  if (summarize === undefined) {
    return {};
  }
  try {
    return summarize(value);
  } catch (error) {
    return { summaryError: errorSummary(error).error };
  }
};

const formatSummary = (summary: PerfSummary) =>
  Object.entries(summary)
    .filter((entry): entry is [string, Exclude<PerfField, undefined>] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ');

const okLine = <A>(label: string, before: PerfReading, value: A, summarize?: (value: A) => PerfSummary) =>
  `[perf] ${label} ok ${formatSummary({ ...resourceSummary(before), ...callerSummary(value, summarize) })}`;

const failedLine = (label: string, before: PerfReading, error: unknown) =>
  `[perf] ${label} failed ${formatSummary({ ...resourceSummary(before), ...errorSummary(error) })}`;

export const withPerfSpan = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  summarize?: (value: A) => PerfSummary,
): Effect.Effect<A, E, R> => {
  if (!perfEnabled()) {
    return effect;
  }

  return Effect.gen(function* () {
    const before = readPerf();
    const exit = yield* Effect.exit(effect);

    if (Exit.isSuccess(exit)) {
      yield* Console.error(okLine(label, before, exit.value, summarize));
      return exit.value;
    }

    yield* Console.error(failedLine(label, before, exit.cause));
    return yield* Effect.failCause(exit.cause);
  });
};
