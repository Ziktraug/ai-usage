import { describe, expect, test } from 'bun:test';
import {
  type BoundedJsonlProcessHandlers,
  type BoundedJsonlProcessSpec,
  spawnBoundedJsonlProcess,
} from './review-worker-process';

/**
 * The runner against real child processes (Bun scripts): what it reports when the child ends on its
 * own, when the engine stops it, and when a stop arrives after the child has already exited.
 */
const bun = process.execPath;

const spawnScript = (
  script: string,
  handlers: BoundedJsonlProcessHandlers,
  overrides: Partial<BoundedJsonlProcessSpec> = {},
) =>
  spawnBoundedJsonlProcess(
    {
      args: ['-e', script],
      cwd: process.cwd(),
      env: { HOME: process.env.HOME ?? '/', PATH: process.env.PATH ?? '' },
      executable: bun,
      heartbeatMs: 10_000,
      maxOutputBytes: 64 * 1024,
      stdin: null,
      timeoutMs: 10_000,
      ...overrides,
    },
    handlers,
  );

/** A line handler the test releases by hand, so the end stays unsettled while the child is already gone. */
const heldHandler = () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lines: string[] = [];
  const handlers: BoundedJsonlProcessHandlers = {
    onLine: async (line) => {
      lines.push(line);
      await held;
    },
  };
  return { handlers, lines, release: () => release() };
};

const untilFirstLine = async (lines: readonly string[]): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (lines.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('the child printed nothing within 5 s');
    }
    await Bun.sleep(5);
  }
};

describe('spawnBoundedJsonlProcess', () => {
  test('a child that ends on its own reports its exit code and no stop', async () => {
    const lines: string[] = [];
    const child = spawnScript('console.log("one"); console.log("two"); process.exit(3)', {
      onLine: (line) => {
        lines.push(line);
      },
    });
    expect(child.pid).toBeGreaterThan(0);
    const end = await child.end;
    expect(lines).toEqual(['one', 'two']);
    expect(end).toMatchObject({ exitCode: 3, stop: null });
    expect(end.wallMs).toBeGreaterThanOrEqual(0);
  });

  test('a stop requested after the child exited does not relabel its outcome', async () => {
    const { handlers, lines, release } = heldHandler();
    const child = spawnScript('console.log("final")', handlers);
    await untilFirstLine(lines);
    // The child exits right after printing; the end is held open by the line handler only.
    await Bun.sleep(400);
    child.stop('cancel');
    release();
    const end = await child.end;
    expect(end).toEqual({ exitCode: 0, stop: null, wallMs: expect.any(Number) });
  });

  test('the deadline is ignored once the child exited on its own', async () => {
    const { handlers, lines, release } = heldHandler();
    const child = spawnScript('console.log("final")', handlers, { timeoutMs: 150 });
    await untilFirstLine(lines);
    // The deadline fires while the handler still holds the end; the child is long gone.
    await Bun.sleep(500);
    release();
    const end = await child.end;
    expect(end).toMatchObject({ exitCode: 0, stop: null });
  });

  test('a stop while the child runs is recorded once; the first reason wins and the child is terminated', async () => {
    const child = spawnScript('await Bun.sleep(30_000)', { onLine: () => undefined });
    await Bun.sleep(50);
    child.stop('cancel');
    child.stop('shutdown');
    const end = await child.end;
    expect(end.stop).toBe('cancel');
    expect(end.exitCode).not.toBe(0);
  });
});
