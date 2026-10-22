import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import {
  BoundedProcessError,
  boundedProcessEnvironment,
  executeBoundedProcess,
  runBoundedProcess,
} from './bounded-process';

const STDERR_SENTINEL = 'PRIVATE_BOUNDED_PROCESS_STDERR_SENTINEL';
const LEAKED_VARIABLE = 'AI_USAGE_BOUNDED_PROCESS_TEST_SECRET';

const script = (source: string) => ({ args: ['-e', source], command: process.execPath });

const run = (options: Parameters<typeof runBoundedProcess>[0]) => Effect.runPromise(runBoundedProcess(options));

const failure = async (options: Parameters<typeof runBoundedProcess>[0]): Promise<BoundedProcessError> => {
  const exit = await Effect.runPromiseExit(runBoundedProcess(options));
  if (Exit.isFailure(exit)) {
    const error = Cause.failureOption(exit.cause);
    if (error._tag === 'Some') {
      return error.value;
    }
  }
  throw new Error(`Expected a bounded process failure, received ${JSON.stringify(exit)}`);
};

describe('bounded process runner', () => {
  beforeEach(() => {
    process.env[LEAKED_VARIABLE] = 'must-not-leak';
  });
  afterEach(() => {
    delete process.env[LEAKED_VARIABLE];
  });

  test('returns stdout, the exit code and a duration for a completed process', async () => {
    const result = await run({
      ...script("process.stdout.write('ok'); process.exit(3)"),
      maximumOutputBytes: 16,
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('ok');
    expect(result.exitCode).toBe(3);
    expect(Number.isSafeInteger(result.durationMs) && result.durationMs >= 0).toBe(true);
  });

  test('passes only the allow-listed environment plus the explicit variables', async () => {
    const result = await run({
      ...script('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'),
      env: { GH_TOKEN_TEST_ONLY: 'explicit' },
      maximumOutputBytes: 64 * 1024,
      timeoutMs: 5000,
    });
    const names = JSON.parse(result.stdout) as string[];
    expect(names).toContain('PATH');
    expect(names).toContain('GH_TOKEN_TEST_ONLY');
    expect(names).not.toContain(LEAKED_VARIABLE);
    for (const name of names) {
      // Bun itself may add a few runtime variables to a child; nothing inherited may be outside
      // the allow-list or the explicit set.
      expect(
        ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'GH_TOKEN_TEST_ONLY'].includes(name) ||
          name.startsWith('XDG_') ||
          name.startsWith('BUN_') ||
          name === '_',
      ).toBe(true);
    }
    expect(boundedProcessEnvironment({ EXPLICIT: '1' }, { HOME: '/h', OTHER: 'x', XDG_CONFIG_HOME: '/c' })).toEqual({
      EXPLICIT: '1',
      HOME: '/h',
      XDG_CONFIG_HOME: '/c',
    });
  });

  test('never retains stderr', async () => {
    const result = await run({
      ...script(`process.stderr.write(${JSON.stringify(STDERR_SENTINEL)}); process.stdout.write('out')`),
      maximumOutputBytes: 16,
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe('out');
    expect(JSON.stringify(result)).not.toContain(STDERR_SENTINEL);
    const error = await failure({
      ...script(`process.stderr.write(${JSON.stringify(STDERR_SENTINEL)}); setInterval(() => undefined, 1000)`),
      maximumOutputBytes: 16,
      timeoutMs: 50,
    });
    expect(error.kind).toBe('timed-out');
    expect(JSON.stringify(error)).not.toContain(STDERR_SENTINEL);
  });

  test('kills the process at the output ceiling', async () => {
    const error = await failure({
      ...script("setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"),
      maximumOutputBytes: 1024,
      timeoutMs: 5000,
    });
    expect(error.kind).toBe('output-limit');
  });

  test('kills the process at the deadline', async () => {
    const startedAt = performance.now();
    const error = await failure({
      ...script('setInterval(() => undefined, 1000)'),
      maximumOutputBytes: 16,
      timeoutMs: 100,
    });
    expect(error.kind).toBe('timed-out');
    expect(performance.now() - startedAt).toBeLessThan(4000);
  });

  test('reports a missing executable as unavailable without spawning a shell', async () => {
    const error = await failure({
      args: ['--version'],
      command: 'ai-usage-definitely-missing-executable',
      maximumOutputBytes: 16,
      timeoutMs: 1000,
    });
    expect(error.kind).toBe('unavailable');
    const notExecutable = mkdtempSync(path.join(tmpdir(), 'ai-usage-bounded-process-'));
    try {
      const filePath = path.join(notExecutable, 'tool');
      writeFileSync(filePath, '#!/bin/sh\necho hi\n');
      chmodSync(filePath, 0o600);
      expect((await failure({ args: [], command: filePath, maximumOutputBytes: 16, timeoutMs: 1000 })).kind).toBe(
        'unavailable',
      );
    } finally {
      rmSync(notExecutable, { force: true, recursive: true });
    }
  });

  test('rejects output that is not valid UTF-8', async () => {
    const error = await failure({
      ...script('process.stdout.write(Buffer.from([0xff, 0xfe, 0x41]))'),
      maximumOutputBytes: 16,
      timeoutMs: 5000,
    });
    expect(error.kind).toBe('failed');
    expect(error.failure).toBe('undecodable');
  });

  test('tells a process killed by a signal it was not sent from undecodable output', async () => {
    const error = await failure({
      ...script('process.kill(process.pid, "SIGKILL")'),
      maximumOutputBytes: 16,
      timeoutMs: 5000,
    });
    expect(error.kind).toBe('failed');
    expect(error.failure).toBe('signalled');
  });

  test('interrupts the effect and kills the child when the signal aborts', async () => {
    const controller = new AbortController();
    const running = Effect.runPromiseExit(
      runBoundedProcess({
        ...script('setInterval(() => undefined, 1000)'),
        maximumOutputBytes: 16,
        signal: controller.signal,
        timeoutMs: 10_000,
      }),
    );
    setTimeout(() => controller.abort(), 20);
    const exit = await running;
    expect(Exit.isInterrupted(exit)).toBe(true);
    const alreadyAborted = await Effect.runPromiseExit(
      runBoundedProcess({
        ...script('setInterval(() => undefined, 1000)'),
        maximumOutputBytes: 16,
        signal: AbortSignal.abort(),
        timeoutMs: 10_000,
      }),
    );
    expect(Exit.isInterrupted(alreadyAborted)).toBe(true);
  });

  test('promise form rejects with the abort reason, never with a stray error type', async () => {
    const controller = new AbortController();
    const running = executeBoundedProcess({
      ...script('setInterval(() => undefined, 1000)'),
      maximumOutputBytes: 16,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    queueMicrotask(() => controller.abort());
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      executeBoundedProcess({ ...script("process.stdout.write('too much')"), maximumOutputBytes: 2, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(BoundedProcessError);
  });
});
