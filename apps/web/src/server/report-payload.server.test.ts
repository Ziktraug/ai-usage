import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { reportCaptureFingerprint } from '@ai-usage/report-data';
import { MAX_REPORT_RUNNER_ARTIFACT_BYTES } from '@ai-usage/report-data/report-payload-artifact';
import { toWebReportPayload } from '../web-report-payload';
import {
  createReportPayloadCache,
  MAX_REPORT_RUNNER_STDERR_TAIL_BYTES,
  MAX_UNCHANGED_CAPTURE_RESULT_BYTES,
  parseRunnerCaptureResult,
  parseRunnerPayload,
  ReportPayloadRunnerProcessError,
  runReportPayloadArtifactProcess,
} from './report-payload.server';
import { reportCaptureFingerprintForPayload } from './report-revision.server';

const deferred = <A>() => {
  let reject: ((reason?: unknown) => void) | undefined;
  let resolve: ((value: A) => void) | undefined;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return {
    promise,
    reject: (reason?: unknown) => reject?.(reason),
    resolve: (value: A) => resolve?.(value),
  };
};

const payloadForRun = (generatedAt: string): UsageReportPayload => ({
  analytics: {} as UsageReportPayload['analytics'],
  filters: { since: null, project: null, limit: null, minTokens: 1, sort: 'date' },
  generatedAt,
  omittedRows: 0,
  rows: [],
  tableRows: [],
});

const withRunnerFixture = async <Result>(
  source: string,
  run: (options: { artifactParent: string; runnerPath: string }) => Promise<Result>,
): Promise<Result> => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-runner-fixture-'));
  const artifactParent = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-artifacts-'));
  await chmod(artifactParent, 0o700);
  const runnerPath = path.join(fixtureRoot, 'runner.ts');
  await writeFile(runnerPath, source);
  try {
    return await run({ artifactParent, runnerPath });
  } finally {
    await Promise.all([
      rm(fixtureRoot, { force: true, recursive: true }),
      rm(artifactParent, { force: true, recursive: true }),
    ]);
  }
};

const runFixture = (source: string, run?: (options: { artifactParent: string; runnerPath: string }) => Promise<void>) =>
  withRunnerFixture(source, async ({ artifactParent, runnerPath }) => {
    if (run) {
      await run({ artifactParent, runnerPath });
      return;
    }
    const result = await runReportPayloadArtifactProcess({
      args: [runnerPath],
      command: 'bun',
      cwd: path.dirname(runnerPath),
      temporaryDirectoryParent: artifactParent,
    });
    return { ...result, artifactEntriesAfterRun: await readdir(artifactParent) };
  });

describe('report payload cache', () => {
  test('does not republish or detach stale work after a config change', async () => {
    const firstLoad = deferred<UsageReportPayload>();
    const secondLoad = deferred<UsageReportPayload>();
    const loads = [firstLoad, secondLoad];
    let loadCount = 0;
    const cache = createReportPayloadCache({
      load: () => {
        const load = loads[loadCount];
        loadCount++;
        if (!load) {
          throw new Error('Unexpected report payload load');
        }
        return load.promise;
      },
    });

    const staleRequest = cache.collect();
    cache.invalidate();
    const currentRequest = cache.collect();

    firstLoad.resolve(payloadForRun('stale'));
    await staleRequest;

    expect(cache.collect()).toBe(currentRequest);
    expect(loadCount).toBe(2);

    const currentPayload = payloadForRun('current');
    secondLoad.resolve(currentPayload);
    await expect(currentRequest).resolves.toBe(currentPayload);
    await expect(cache.collect()).resolves.toBe(currentPayload);
    expect(loadCount).toBe(2);
  });

  test('serves the last good payload while a forced refresh runs or fails', async () => {
    const refreshLoad = deferred<UsageReportPayload>();
    const currentPayload = payloadForRun('current');
    let loadCount = 0;
    let now = 1000;
    const cache = createReportPayloadCache({
      load: () => {
        loadCount++;
        return loadCount === 1 ? Promise.resolve(currentPayload) : refreshLoad.promise;
      },
      now: () => now,
      ttlMs: 10,
    });

    await expect(cache.collect()).resolves.toBe(currentPayload);
    now += 11;
    const refreshRequest = cache.collect({ force: true });

    await expect(cache.collect()).resolves.toBe(currentPayload);
    refreshLoad.reject(new Error('Fixture refresh failure'));
    await expect(refreshRequest).rejects.toThrow('Fixture refresh failure');
    await expect(cache.collect()).resolves.toBe(currentPayload);
    expect(loadCount).toBe(2);
  });

  test('releases a synchronously failed loader before the next request', async () => {
    const recoveredPayload = payloadForRun('recovered');
    let loadCount = 0;
    const cache = createReportPayloadCache({
      load: () => {
        loadCount++;
        if (loadCount === 1) {
          throw new Error('Synchronous fixture failure');
        }
        return Promise.resolve(recoveredPayload);
      },
    });

    await expect(cache.collect()).rejects.toThrow('Synchronous fixture failure');
    await expect(cache.collect()).resolves.toBe(recoveredPayload);
    expect(loadCount).toBe(2);
  });
});

describe('parseRunnerPayload', () => {
  test('ignores runtime warning lines before the JSON payload', () => {
    const payload = parseRunnerPayload('timestamp=2026-06-22T11:30:48.703Z level=WARN message=noise\n{"rows":[]}');

    expect(payload.rows).toEqual([]);
  });

  test('uses the same semantic capture fingerprint as immutable web revisions', () => {
    const payload = payloadForRun('2026-07-14T12:00:00.000Z');

    expect(reportCaptureFingerprint(payload)).toBe(reportCaptureFingerprintForPayload(toWebReportPayload(payload)));
  });

  test('accepts an unchanged result at 64 KiB and rejects one byte more', () => {
    const result = {
      captureFingerprint: 'a'.repeat(64),
      metadata: { padding: '' },
      status: 'unchanged',
      version: 1,
    };
    const empty = JSON.stringify(result);
    const exact = JSON.stringify({
      ...result,
      metadata: { padding: 'x'.repeat(MAX_UNCHANGED_CAPTURE_RESULT_BYTES - Buffer.byteLength(empty)) },
    });
    const tooLarge = exact.replace('"status"', '"metadataPadding":"x","status"');

    expect(Buffer.byteLength(exact)).toBe(MAX_UNCHANGED_CAPTURE_RESULT_BYTES);
    expect(parseRunnerCaptureResult(exact).status).toBe('unchanged');
    expect(Buffer.byteLength(tooLarge)).toBeGreaterThan(MAX_UNCHANGED_CAPTURE_RESULT_BYTES);
    expect(() => parseRunnerCaptureResult(tooLarge)).toThrow(`${MAX_UNCHANGED_CAPTURE_RESULT_BYTES}-byte limit`);
  });
});

describe('report payload artifact process', () => {
  test('accepts a valid artifact larger than the old 64 MiB stdout ceiling', async () => {
    const result = await runFixture(`
      import { chmodSync, statSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      const outputPath = process.argv.at(-1);
      if (!outputPath) throw new Error('missing output path');
      const artifactMode = statSync(outputPath).mode & 0o777;
      const directoryMode = statSync(path.dirname(outputPath)).mode & 0o777;
      const padding = 'x'.repeat(64 * 1024 * 1024 + 1024);
      writeFileSync(outputPath, JSON.stringify({ artifactMode, directoryMode, padding, rows: [] }));
      chmodSync(outputPath, 0o600);
      process.stdout.write('discarded stdout');
    `);

    if (!result) {
      throw new Error('Expected a report payload artifact result');
    }
    expect(result.artifactEntriesAfterRun).toEqual([]);
    expect(result.artifactBytes).toBeGreaterThan(64 * 1024 * 1024);
    const parsed = JSON.parse(result.serializedPayload) as {
      artifactMode: number;
      directoryMode: number;
      padding: string;
      rows: unknown[];
    };
    expect(parsed.artifactMode).toBe(0o600);
    expect(parsed.directoryMode).toBe(0o700);
    expect(parsed.padding).toHaveLength(64 * 1024 * 1024 + 1024);
    expect(parsed.rows).toEqual([]);
  });

  test('rejects an artifact over the frozen ceiling and cleans it up', async () => {
    await runFixture(
      `
        import { truncateSync } from 'node:fs';
        const outputPath = process.argv.at(-1);
        if (!outputPath) throw new Error('missing output path');
        truncateSync(outputPath, ${MAX_REPORT_RUNNER_ARTIFACT_BYTES + 1});
      `,
      async ({ artifactParent, runnerPath }) => {
        await expect(
          runReportPayloadArtifactProcess({
            args: [runnerPath],
            command: 'bun',
            cwd: path.dirname(runnerPath),
            temporaryDirectoryParent: artifactParent,
          }),
        ).rejects.toThrow(`${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
        expect(await readdir(artifactParent)).toEqual([]);
      },
    );
  });

  test('retains only a bounded stderr tail on child failure and cleans it up', async () => {
    await runFixture(
      `
        await new Promise((resolve) => process.stderr.write('x'.repeat(${MAX_REPORT_RUNNER_STDERR_TAIL_BYTES + 4096}), resolve));
        await new Promise((resolve) => process.stderr.write('TAIL_MARKER', resolve));
        process.exit(7);
      `,
      async ({ artifactParent, runnerPath }) => {
        try {
          await runReportPayloadArtifactProcess({
            args: [runnerPath],
            command: 'bun',
            cwd: path.dirname(runnerPath),
            temporaryDirectoryParent: artifactParent,
          });
          throw new Error('Expected the fixture runner to fail');
        } catch (error) {
          expect(error).toBeInstanceOf(ReportPayloadRunnerProcessError);
          const runnerError = error as ReportPayloadRunnerProcessError;
          expect(Buffer.byteLength(runnerError.stderrTail)).toBeLessThanOrEqual(MAX_REPORT_RUNNER_STDERR_TAIL_BYTES);
          expect(runnerError.stderrTail).toEndWith('TAIL_MARKER');
        }
        expect(await readdir(artifactParent)).toEqual([]);
      },
    );
  });

  test('rejects permissive artifacts and cleans them up', async () => {
    await runFixture(
      `
        import { chmodSync, writeFileSync } from 'node:fs';
        const outputPath = process.argv.at(-1);
        if (!outputPath) throw new Error('missing output path');
        writeFileSync(outputPath, '{"rows":[]}');
        chmodSync(outputPath, 0o644);
      `,
      async ({ artifactParent, runnerPath }) => {
        await expect(
          runReportPayloadArtifactProcess({
            args: [runnerPath],
            command: 'bun',
            cwd: path.dirname(runnerPath),
            temporaryDirectoryParent: artifactParent,
          }),
        ).rejects.toThrow('private regular file');
        expect(await readdir(artifactParent)).toEqual([]);
      },
    );
  });

  test('cleans the artifact after parse failure', async () => {
    await runFixture(
      `
        import { writeFileSync } from 'node:fs';
        const outputPath = process.argv.at(-1);
        if (!outputPath) throw new Error('missing output path');
        writeFileSync(outputPath, 'not json');
      `,
      async ({ artifactParent, runnerPath }) => {
        await expect(
          runReportPayloadArtifactProcess({
            args: [runnerPath],
            command: 'bun',
            cwd: path.dirname(runnerPath),
            temporaryDirectoryParent: artifactParent,
            validate: (serializedPayload) => {
              JSON.parse(serializedPayload);
            },
          }),
        ).rejects.toThrow();
        expect(await readdir(artifactParent)).toEqual([]);
      },
    );
  });

  test('terminates and cleans the artifact when cancelled', async () => {
    await runFixture(
      `
        await Bun.sleep(10_000);
      `,
      async ({ artifactParent, runnerPath }) => {
        const controller = new AbortController();
        const cancellation = runReportPayloadArtifactProcess({
          args: [runnerPath],
          command: 'bun',
          cwd: path.dirname(runnerPath),
          signal: controller.signal,
          temporaryDirectoryParent: artifactParent,
        });
        setTimeout(() => controller.abort(), 20);
        await expect(cancellation).rejects.toThrow();
        expect(await readdir(artifactParent)).toEqual([]);
      },
    );
  });
});
