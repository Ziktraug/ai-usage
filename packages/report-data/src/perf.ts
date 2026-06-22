import { Console, Effect, Exit } from 'effect';

type PerfField = boolean | number | string | null | undefined;
type PerfSummary = Record<string, PerfField>;

export const perfEnabled = () => process.env.AI_USAGE_PERF === '1' || process.env.AI_USAGE_PERF === 'true';

const formatError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
};

const formatSummary = (summary: PerfSummary) =>
  Object.entries(summary)
    .filter((entry): entry is [string, Exclude<PerfField, undefined>] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ');

export const withPerfSpan = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  summarize?: (value: A) => PerfSummary,
): Effect.Effect<A, E, R> => {
  if (!perfEnabled()) {
    return effect;
  }

  return Effect.gen(function* () {
    const startedAt = Date.now();
    const exit = yield* Effect.exit(effect);
    const durationMs = Date.now() - startedAt;

    if (Exit.isSuccess(exit)) {
      const summary = formatSummary({ durationMs, ...(summarize?.(exit.value) ?? {}) });
      yield* Console.error(`[perf] ${label} ok ${summary}`);
      return exit.value;
    }

    yield* Console.error(`[perf] ${label} failed ${formatSummary({ durationMs, error: formatError(exit.cause) })}`);
    return yield* Effect.failCause(exit.cause);
  });
};
