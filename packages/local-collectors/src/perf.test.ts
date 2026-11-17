import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Console, Effect } from 'effect';
import { withPerfSpan, withPerfSpanPromise } from './perf';

const captureConsole = () => {
  const lines: string[] = [];
  const capture: Console.Console = {
    ...globalThis.console,
    error: (...values: unknown[]) => {
      lines.push(values.map(String).join(' '));
    },
  };
  return { capture, lines };
};

const runCaptured = async <A, E>(effect: Effect.Effect<A, E>, capture: Console.Console) =>
  await Effect.runPromiseExit(effect.pipe(Effect.provideService(Console.Console, capture)));

const fieldsOf = (line: string): Record<string, string> =>
  Object.fromEntries(
    line
      .split(' ')
      .filter((token) => token.includes('='))
      .map((token) => {
        const separator = token.indexOf('=');
        return [token.slice(0, separator), token.slice(separator + 1)];
      }),
  );

const RESOURCE_FIELDS = ['cpuMs', 'heapUsedMbAfter', 'heapUsedMbBefore', 'rssMbAfter', 'rssMbBefore'] as const;

describe('perf spans', () => {
  let previousPerfFlag: string | undefined;
  let previousConsoleError: typeof console.error;

  beforeEach(() => {
    previousPerfFlag = process.env.AI_USAGE_PERF;
    previousConsoleError = console.error;
  });

  afterEach(() => {
    console.error = previousConsoleError;
    if (previousPerfFlag === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previousPerfFlag;
    }
  });

  test('returns the effect unchanged and reports nothing when AI_USAGE_PERF is disabled', async () => {
    delete process.env.AI_USAGE_PERF;
    const { capture, lines } = captureConsole();
    const effect = Effect.succeed(7);

    const spanned = withPerfSpan('aiUsage.test.disabled', effect, () => ({ rows: 1 }));

    expect(spanned).toBe(effect);
    await runCaptured(spanned, capture);
    expect(lines).toEqual([]);
  });

  test('reports duration, CPU, resident and heap figures with the summary when enabled', async () => {
    process.env.AI_USAGE_PERF = '1';
    const { capture, lines } = captureConsole();

    const exit = await runCaptured(
      withPerfSpan('aiUsage.test.enabled', Effect.succeed([1, 2, 3]), (rows) => ({ rows: rows.length })),
      capture,
    );

    expect(exit._tag).toBe('Success');
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line.startsWith('[perf] aiUsage.test.enabled ok ')).toBe(true);
    const fields = fieldsOf(line);
    expect(fields.rows).toBe('3');
    expect(Number(fields.durationMs)).toBeGreaterThanOrEqual(0);
    for (const field of RESOURCE_FIELDS) {
      expect(Number.isFinite(Number(fields[field]))).toBe(true);
      expect(Number(fields[field])).toBeGreaterThanOrEqual(0);
    }
    expect(Number(fields.rssMbBefore)).toBeGreaterThan(0);
    expect(Number(fields.heapUsedMbAfter)).toBeGreaterThan(0);
  });

  test('reports the resource figures of a failed span and keeps its failure', async () => {
    process.env.AI_USAGE_PERF = 'true';
    const { capture, lines } = captureConsole();

    const exit = await runCaptured(withPerfSpan('aiUsage.test.failed', Effect.fail(new Error('boom'))), capture);

    expect(exit._tag).toBe('Failure');
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line.startsWith('[perf] aiUsage.test.failed failed ')).toBe(true);
    const fields = fieldsOf(line);
    for (const field of RESOURCE_FIELDS) {
      expect(Number.isFinite(Number(fields[field]))).toBe(true);
    }
  });

  test('the promise span runs the operation once and reports nothing when disabled', async () => {
    delete process.env.AI_USAGE_PERF;
    const lines: string[] = [];
    console.error = (...values: unknown[]) => {
      lines.push(values.map(String).join(' '));
    };
    let calls = 0;

    const value = await withPerfSpanPromise(
      'aiUsage.test.promise.disabled',
      () => {
        calls += 1;
        return Promise.resolve('done');
      },
      () => ({ rows: 1 }),
    );

    expect(value).toBe('done');
    expect(calls).toBe(1);
    expect(lines).toEqual([]);
  });

  test('the promise span reports the same figures when enabled and rethrows the original failure', async () => {
    process.env.AI_USAGE_PERF = '1';
    const lines: string[] = [];
    console.error = (...values: unknown[]) => {
      lines.push(values.map(String).join(' '));
    };

    const value = await withPerfSpanPromise(
      'aiUsage.test.promise.enabled',
      () => Promise.resolve([1, 2]),
      (rows) => ({ rows: rows.length }),
    );
    const failure = new Error('assembly failed');
    const rejected = await withPerfSpanPromise('aiUsage.test.promise.failed', () => Promise.reject(failure)).then(
      () => null,
      (error: unknown) => error,
    );

    expect(value).toEqual([1, 2]);
    expect(rejected).toBe(failure);
    expect(lines).toHaveLength(2);
    const ok = fieldsOf(lines[0] ?? '');
    const failed = fieldsOf(lines[1] ?? '');
    expect((lines[0] ?? '').startsWith('[perf] aiUsage.test.promise.enabled ok ')).toBe(true);
    expect((lines[1] ?? '').startsWith('[perf] aiUsage.test.promise.failed failed ')).toBe(true);
    expect(ok.rows).toBe('2');
    for (const field of RESOURCE_FIELDS) {
      expect(Number.isFinite(Number(ok[field]))).toBe(true);
      expect(Number.isFinite(Number(failed[field]))).toBe(true);
    }
  });
});
