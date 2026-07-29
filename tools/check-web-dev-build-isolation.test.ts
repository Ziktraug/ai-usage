import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertDirectoryIdentitiesPreserved,
  captureBoundedStream,
  createWebBuildIsolationEnvironment,
  snapshotDirectoryIdentities,
} from './check-web-dev-build-isolation';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createFixture = async (): Promise<string> => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'plan052-web-build-isolation-unit-'));
  fixtures.push(fixture);
  return fixture;
};

describe('web dev/build isolation helpers', () => {
  test('retains build-time log messages after startup exceeds the capture budget', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
    });
    const captured = captureBoundedStream(stream);
    streamController?.enqueue(new Uint8Array(140 * 1024).fill(65));
    await Bun.sleep(0);
    const buildStartedAt = captured.position();
    streamController?.enqueue(new TextEncoder().encode('hmr update after capped startup logs\n'));
    streamController?.close();
    await captured.done;

    expect(captured.textSince(buildStartedAt)).toContain('hmr update after capped startup logs');
  });

  test('rejects and cancels a stream at its hard total-output budget', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array(5));
      },
    });
    const captured = captureBoundedStream(stream, { maximumRetainedBytes: 4, maximumTotalBytes: 4 });

    await expect(captured.done).rejects.toThrow('4-byte budget');
  });

  test('requires every recorded dev output inode while allowing new output', async () => {
    const fixture = await createFixture();
    const retainedFile = path.join(fixture, 'nitro', 'server.mjs');
    const replacedFile = path.join(fixture, 'vite', 'cache.bin');
    await Promise.all([mkdir(path.dirname(retainedFile), { recursive: true }), mkdir(path.dirname(replacedFile))]);
    await Promise.all([writeFile(retainedFile, 'server\n'), writeFile(replacedFile, 'cache\n')]);
    const before = await snapshotDirectoryIdentities(fixture);

    await writeFile(path.join(fixture, 'added.txt'), 'allowed\n');
    expect(await assertDirectoryIdentitiesPreserved(fixture, before)).toEqual({ checkedFiles: 2 });

    await rename(replacedFile, `${replacedFile}.old`);
    await writeFile(replacedFile, 'replacement\n');
    await expect(assertDirectoryIdentitiesPreserved(fixture, before)).rejects.toThrow('vite/cache.bin');
  });

  test('constructs an isolated child environment without unrelated inherited values', async () => {
    const fixture = await createFixture();
    const environment = createWebBuildIsolationEnvironment({
      inheritedEnvironment: {
        AWS_SECRET_ACCESS_KEY: 'must-not-pass-through',
        PATH: '/synthetic/bin',
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/synthetic/chrome',
      },
      repositoryDirectory: '/synthetic/repository',
      runtimeRoot: fixture,
      useE2eAdapters: true,
    });

    expect(environment).toMatchObject({
      AI_USAGE_LOG_DIR: path.join(fixture, 'logs'),
      AI_USAGE_ROOT_DIR: '/synthetic/repository',
      HOME: path.join(fixture, 'home'),
      PATH: '/synthetic/bin',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/synthetic/chrome',
      TMPDIR: path.join(fixture, 'tmp'),
      VITE_AI_USAGE_DEMO: '0',
      VITE_AI_USAGE_E2E: '1',
      XDG_CACHE_HOME: path.join(fixture, 'cache'),
      XDG_CONFIG_HOME: path.join(fixture, 'config'),
      XDG_DATA_HOME: path.join(fixture, 'data'),
    });
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
