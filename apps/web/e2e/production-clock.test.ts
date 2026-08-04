import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOCK_EPOCH_ENVIRONMENT_KEY } from './production-clock';

const clockPath = path.join(import.meta.dir, 'production-clock.ts');
const clockUrl = pathToFileURL(clockPath).href;
const fixtureEpoch = '2026-07-03T12:00:00.000Z';

describe('production fixture clock', () => {
  test('anchors no-argument dates while time continues to advance', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        'const startedAt = Date.now(); await Bun.sleep(20); console.log(JSON.stringify({ called: Date(), explicit: new Date("2026-01-02T00:00:00.000Z").toISOString(), now: new Date().toISOString(), advancedBy: Date.now() - startedAt }))',
      ],
      {
        env: {
          ...process.env,
          [CLOCK_EPOCH_ENVIRONMENT_KEY]: fixtureEpoch,
          BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${clockUrl}`].filter(Boolean).join(' '),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as {
      readonly advancedBy: number;
      readonly called: string;
      readonly explicit: string;
      readonly now: string;
    };
    expect(result.explicit).toBe('2026-01-02T00:00:00.000Z');
    expect(Date.parse(result.now)).toBeGreaterThanOrEqual(Date.parse(fixtureEpoch));
    expect(Date.parse(result.now)).toBeLessThan(Date.parse(fixtureEpoch) + 1000);
    expect(Date.parse(result.called)).toBeGreaterThanOrEqual(Date.parse(fixtureEpoch));
    expect(result.advancedBy).toBeGreaterThanOrEqual(10);
  });

  test('rejects an invalid fixture epoch before application startup', async () => {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', '--preload', clockPath, '-e', 'console.log("started")'],
      {
        env: { ...process.env, [CLOCK_EPOCH_ENVIRONMENT_KEY]: 'not-a-date' },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(`${CLOCK_EPOCH_ENVIRONMENT_KEY} must be an ISO timestamp`);
  });
});
