import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Cause, Console, Data, Effect, Exit } from 'effect';
import { withPerfSpan } from './perf';

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

const errorFieldsOf = (line: string): Record<string, string> =>
  Object.fromEntries(Object.entries(fieldsOf(line)).filter(([key]) => key.startsWith('error')));

// Shaped like the store's error, whose message starts with the operation and the store path.
class StoreFailure extends Data.TaggedError('UsageStoreError')<{
  readonly message: string;
  readonly operation: string;
  readonly reason: string;
}> {}

const STORE_PATH = '/home/someone/.config/ai-usage/usage-store.sqlite';
const TRANSCRIPT_PATH = '/home/someone/.claude/projects/secret-project/session.jsonl';

describe('perf spans', () => {
  let previousPerfFlag: string | undefined;

  beforeEach(() => {
    previousPerfFlag = process.env.AI_USAGE_PERF;
  });

  afterEach(() => {
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

  test('a failed span names the error by tag, operation and reason, and never prints its message', async () => {
    process.env.AI_USAGE_PERF = '1';
    const { capture, lines } = captureConsole();
    const failure = new StoreFailure({
      message: `publishServedReportRevision ${STORE_PATH}: database is locked`,
      operation: 'publishServedReportRevision',
      reason: 'busy',
    });

    const exit = await runCaptured(withPerfSpan('aiUsage.test.failed.store', Effect.fail(failure)), capture);

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : null).toBe(failure);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line.startsWith('[perf] aiUsage.test.failed.store failed ')).toBe(true);
    expect(line).not.toContain('/');
    expect(line).not.toContain('usage-store.sqlite');
    expect(line).not.toContain('locked');
    expect(errorFieldsOf(line)).toEqual({
      error: 'UsageStoreError',
      errorOperation: 'publishServedReportRevision',
      errorReason: 'busy',
    });
  });

  test('a failed span prints no path for an untagged error, a defect, a bare value or an unsafe tag', async () => {
    process.env.AI_USAGE_PERF = '1';
    const missing = Object.assign(new Error(`ENOENT: no such file or directory, open '${TRANSCRIPT_PATH}'`), {
      code: 'ENOENT',
    });
    const cases: { readonly effect: Effect.Effect<never, unknown>; readonly expected: Record<string, string> }[] = [
      { effect: Effect.fail(missing), expected: { error: 'Error', errorCode: 'ENOENT' } },
      { effect: Effect.die(new TypeError(`cannot read ${TRANSCRIPT_PATH}`)), expected: { error: 'TypeError' } },
      { effect: Effect.fail(TRANSCRIPT_PATH), expected: { error: 'unknown' } },
      {
        effect: Effect.fail({
          _tag: TRANSCRIPT_PATH,
          code: TRANSCRIPT_PATH,
          operation: `read ${TRANSCRIPT_PATH}`,
          reason: 'a sentence is not a reason code',
        }),
        expected: { error: 'unknown' },
      },
      { effect: Effect.interrupt, expected: { error: 'interrupted' } },
    ];

    for (const { effect, expected } of cases) {
      const { capture, lines } = captureConsole();

      const exit = await runCaptured(withPerfSpan('aiUsage.test.failed.paths', effect), capture);

      expect(exit._tag).toBe('Failure');
      expect(lines).toHaveLength(1);
      const line = lines[0] ?? '';
      expect(line).not.toContain('/');
      expect(line).not.toContain('secret-project');
      expect(errorFieldsOf(line)).toEqual(expected);
    }
  });

  test('a summary that throws leaves the wrapped result alone and is named on the line', async () => {
    process.env.AI_USAGE_PERF = '1';
    const { capture, lines } = captureConsole();

    const exit = await runCaptured(
      withPerfSpan('aiUsage.test.summary.throws', Effect.succeed('kept'), () => {
        throw new RangeError(`no summary of ${TRANSCRIPT_PATH}`);
      }),
      capture,
    );

    expect(exit).toEqual(Exit.succeed('kept'));
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line.startsWith('[perf] aiUsage.test.summary.throws ok ')).toBe(true);
    expect(line).not.toContain('/');
    const fields = fieldsOf(line);
    expect(fields.summaryError).toBe('RangeError');
    for (const field of RESOURCE_FIELDS) {
      expect(Number.isFinite(Number(fields[field]))).toBe(true);
    }
  });
});
