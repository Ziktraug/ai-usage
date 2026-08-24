import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { productionBuildLockPath, runProductionWebBuild, withProductionBuildLock } from './sveltekit-production-build';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createWebFixture = async (): Promise<string> => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'plan052-web-build-lock-'));
  const canonicalFixture = await realpath(fixture);
  fixtures.push(canonicalFixture);
  return canonicalFixture;
};

const staleLockMetadata = async (webDirectory: string, pid: number, processStartTimeTicks: string | null = '1') => ({
  appRoot: await realpath(webDirectory),
  createdAt: '2026-07-29T00:00:00.000Z',
  hostname: os.hostname(),
  ownerId: '00000000-0000-4000-8000-000000000052',
  pid,
  processStartTimeTicks,
  version: 1,
});

const writeLockFixture = async (webDirectory: string, value: unknown): Promise<string> => {
  const lockPath = productionBuildLockPath(webDirectory);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return lockPath;
};

describe('production web build lock', () => {
  test('rejects a symlinked production container before touching its target', async () => {
    const webDirectory = await createWebFixture();
    const foreignDirectory = await createWebFixture();
    const sentinelPath = path.join(foreignDirectory, 'sentinel.txt');
    await writeFile(sentinelPath, 'must remain\n');
    await symlink(foreignDirectory, path.join(webDirectory, '.output-build'));

    await expect(withProductionBuildLock(webDirectory, () => undefined)).rejects.toThrow(
      `Production web build container must be an owned directory: ${path.join(webDirectory, '.output-build')}`,
    );

    expect(await readFile(sentinelPath, 'utf8')).toBe('must remain\n');
    expect((await lstat(path.join(webDirectory, '.output-build'))).isSymbolicLink()).toBe(true);
  });

  test('fails fast with the live owner PID and lock path', async () => {
    const webDirectory = await createWebFixture();
    let markFirstBuildEntered: (() => void) | undefined;
    let releaseFirstBuild: (() => void) | undefined;
    const firstBuildEntered = new Promise<void>((resolve) => {
      markFirstBuildEntered = resolve;
    });
    const firstBuildCanFinish = new Promise<void>((resolve) => {
      releaseFirstBuild = resolve;
    });
    const firstBuild = withProductionBuildLock(webDirectory, async () => {
      markFirstBuildEntered?.();
      await firstBuildCanFinish;
    });
    const lockPath = productionBuildLockPath(webDirectory);

    await firstBuildEntered;
    await expect(Bun.file(lockPath).exists()).resolves.toBe(true);
    const startedAt = performance.now();
    await expect(withProductionBuildLock(webDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock ${lockPath} is owned by live PID ${process.pid}`,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);

    releaseFirstBuild?.();
    await firstBuild;
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  test('waits briefly for an exclusively created lock to finish initialization', async () => {
    const webDirectory = await createWebFixture();
    const lockPath = productionBuildLockPath(webDirectory);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, '', { mode: 0o600 });
    const finishInitialization = Bun.sleep(25).then(async () => {
      await writeFile(lockPath, `${JSON.stringify(await staleLockMetadata(webDirectory, process.pid, null))}\n`);
    });

    await expect(withProductionBuildLock(webDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock ${lockPath} is owned by live PID ${process.pid}`,
    );
    await finishInitialization;
  });

  test('releases the owned lock when the build fails', async () => {
    const webDirectory = await createWebFixture();
    const lockPath = productionBuildLockPath(webDirectory);

    await expect(
      withProductionBuildLock(webDirectory, () => {
        throw new Error('synthetic build failure');
      }),
    ).rejects.toThrow('synthetic build failure');

    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  test('recovers a validated dead owner and enforces owner-only permissions', async () => {
    const webDirectory = await createWebFixture();
    const lockPath = await writeLockFixture(webDirectory, await staleLockMetadata(webDirectory, 2_147_483_647));
    let observedLockMode = 0;
    let observedContainerMode = 0;

    await withProductionBuildLock(webDirectory, async () => {
      observedLockMode = (await lstat(lockPath)).mode % 0o1000;
      observedContainerMode = (await lstat(path.dirname(lockPath))).mode % 0o1000;
    });

    expect(observedLockMode).toBe(0o600);
    expect(observedContainerMode).toBe(0o700);
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  test('recovers stale metadata when a live PID has a different process identity', async () => {
    // Process start-time identity is available from /proc only. Other hosts
    // deliberately preserve a live owner's lock when PID reuse cannot be disproved.
    if (process.platform !== 'linux') {
      return;
    }
    const webDirectory = await createWebFixture();
    const lockPath = await writeLockFixture(webDirectory, await staleLockMetadata(webDirectory, process.pid, '0'));

    await withProductionBuildLock(webDirectory, () => undefined);

    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  test('preserves malformed and symlink locks instead of guessing ownership', async () => {
    const malformedWebDirectory = await createWebFixture();
    const malformedLockPath = await writeLockFixture(malformedWebDirectory, { pid: 123 });
    await expect(withProductionBuildLock(malformedWebDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock has invalid metadata and was preserved: ${malformedLockPath}`,
    );
    await expect(Bun.file(malformedLockPath).exists()).resolves.toBe(true);

    const malformedIdentityWebDirectory = await createWebFixture();
    const malformedIdentityLockPath = await writeLockFixture(
      malformedIdentityWebDirectory,
      await staleLockMetadata(malformedIdentityWebDirectory, process.pid, 'not-process-ticks'),
    );
    await expect(withProductionBuildLock(malformedIdentityWebDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock has invalid metadata and was preserved: ${malformedIdentityLockPath}`,
    );
    await expect(Bun.file(malformedIdentityLockPath).exists()).resolves.toBe(true);

    const symlinkWebDirectory = await createWebFixture();
    const symlinkLockPath = productionBuildLockPath(symlinkWebDirectory);
    const symlinkTarget = path.join(symlinkWebDirectory, 'foreign-lock');
    await mkdir(path.dirname(symlinkLockPath), { recursive: true });
    await writeFile(symlinkTarget, 'foreign\n');
    await symlink(symlinkTarget, symlinkLockPath);
    await expect(withProductionBuildLock(symlinkWebDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock must not be a symlink: ${symlinkLockPath}`,
    );
    expect((await lstat(symlinkLockPath)).isSymbolicLink()).toBe(true);
  });

  test('preserves hard-linked and group-readable locks instead of recovering them', async () => {
    const hardLinkWebDirectory = await createWebFixture();
    const foreignPath = path.join(hardLinkWebDirectory, 'foreign-lock');
    await writeFile(foreignPath, `${JSON.stringify(await staleLockMetadata(hardLinkWebDirectory, 2_147_483_647))}\n`, {
      mode: 0o600,
    });
    const hardLinkPath = productionBuildLockPath(hardLinkWebDirectory);
    await mkdir(path.dirname(hardLinkPath), { recursive: true });
    await link(foreignPath, hardLinkPath);

    await expect(withProductionBuildLock(hardLinkWebDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock must be owner-only and singly linked: ${hardLinkPath}`,
    );
    await expect(Bun.file(hardLinkPath).exists()).resolves.toBe(true);
    await expect(Bun.file(foreignPath).exists()).resolves.toBe(true);

    const readableWebDirectory = await createWebFixture();
    const readableLockPath = await writeLockFixture(
      readableWebDirectory,
      await staleLockMetadata(readableWebDirectory, 2_147_483_647),
    );
    await chmod(readableLockPath, 0o640);

    await expect(withProductionBuildLock(readableWebDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock must be owner-only and singly linked: ${readableLockPath}`,
    );
    await expect(Bun.file(readableLockPath).exists()).resolves.toBe(true);
  });

  test('rejects a special-file lock without opening it', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const webDirectory = await createWebFixture();
    const lockPath = productionBuildLockPath(webDirectory);
    await mkdir(path.dirname(lockPath), { recursive: true });
    expect(await Bun.spawn(['mkfifo', lockPath]).exited).toBe(0);

    await expect(withProductionBuildLock(webDirectory, () => undefined)).rejects.toThrow(
      `Production web build lock is not a bounded regular file: ${lockPath}`,
    );
    expect((await lstat(lockPath)).isFIFO()).toBe(true);
  });

  test('does not remove a replacement lock during final release', async () => {
    const webDirectory = await createWebFixture();
    const lockPath = productionBuildLockPath(webDirectory);
    const displacedLockPath = `${lockPath}.displaced`;

    await withProductionBuildLock(webDirectory, async () => {
      await rename(lockPath, displacedLockPath);
      await writeFile(lockPath, 'replacement lock\n', { mode: 0o600 });
    });

    expect(await readFile(lockPath, 'utf8')).toBe('replacement lock\n');
  });

  test('reports failure to release an unchanged owned lock', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const webDirectory = await createWebFixture();
    const containerPath = path.dirname(productionBuildLockPath(webDirectory));

    try {
      await expect(
        withProductionBuildLock(webDirectory, async () => {
          await chmod(containerPath, 0o500);
        }),
      ).rejects.toThrow(`Unable to release production web build lock: ${productionBuildLockPath(webDirectory)}`);
    } finally {
      await chmod(containerPath, 0o700);
    }
  });
});

describe('production web build command', () => {
  test('cannot be bypassed by a Turbo cache restore from the root build entrypoint', async () => {
    const repositoryDirectory = path.resolve(import.meta.dirname, '../..');
    const turboConfig = JSON.parse(await readFile(path.join(repositoryDirectory, 'turbo.json'), 'utf8')) as {
      tasks?: Record<string, { cache?: boolean }>;
    };
    const packageManifest = JSON.parse(await readFile(path.join(import.meta.dirname, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(turboConfig.tasks?.['@ai-usage/web#build']?.cache).toBe(false);
    expect(packageManifest.scripts?.build).toBe('bun --no-env-file sveltekit-production-build.ts');
    expect(packageManifest.scripts?.['dev:prepare']).toStartWith(
      'AI_USAGE_SVELTEKIT_PHASE=check bun --no-env-file svelte-kit sync &&',
    );
  });

  test('runs every build phase under the lock and cleans only production output', async () => {
    const repositoryDirectory = await createWebFixture();
    const webDirectory = path.join(repositoryDirectory, 'apps', 'web');
    const devOutputFile = path.join(webDirectory, '.svelte-kit', 'dev', 'dev.txt');
    const productionOutputFiles = [
      path.join(webDirectory, '.output-build', 'sveltekit', 'old-server.txt'),
      path.join(webDirectory, '.svelte-kit', 'build', 'old-cache.txt'),
    ];
    await Promise.all(
      [devOutputFile, ...productionOutputFiles].map(async (filePath) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, 'fixture\n');
      }),
    );
    const commands: Array<{ command: readonly string[]; cwd: string }> = [];

    await runProductionWebBuild({
      repositoryDirectory,
      runCommand: (command, cwd) => {
        commands.push({ command, cwd });
      },
      webDirectory,
    });

    expect(commands).toEqual([
      {
        command: ['bun', '--no-env-file', '--filter', '@ai-usage/design-system', 'build'],
        cwd: repositoryDirectory,
      },
      { command: ['bun', '--no-env-file', 'run', 'dev:prepare'], cwd: webDirectory },
      { command: ['bun', '--no-env-file', 'run', 'typecheck'], cwd: webDirectory },
      { command: ['bun', '--no-env-file', 'sveltekit-vite-build.ts'], cwd: webDirectory },
    ]);
    await expect(Bun.file(devOutputFile).exists()).resolves.toBe(true);
    for (const productionOutputFile of productionOutputFiles) {
      await expect(Bun.file(productionOutputFile).exists()).resolves.toBe(false);
    }
    await expect(Bun.file(productionBuildLockPath(webDirectory)).exists()).resolves.toBe(false);
  });
});

describe('production web runtime bootstrap', () => {
  test('rebuilds a trusted HTTP loopback origin after purging inherited adapter configuration', async () => {
    const bootstrapPath = path.join(import.meta.dirname, 'start.mjs');
    const source = await readFile(bootstrapPath, 'utf8');
    const purgeIndex = source.indexOf('delete process.env[key]');
    const trustedOriginIndex = source.indexOf('process.env.ORIGIN =');

    expect(purgeIndex).toBeGreaterThanOrEqual(0);
    expect(trustedOriginIndex).toBeGreaterThan(purgeIndex);

    const invalidPortProcess = Bun.spawn([process.execPath, '--no-env-file', bootstrapPath], {
      cwd: import.meta.dirname,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: '65536',
      },
      stderr: 'pipe',
      stdout: 'ignore',
    });
    const stderr = await new Response(invalidPortProcess.stderr).text();
    expect(await invalidPortProcess.exited).not.toBe(0);
    expect(stderr).toContain('PORT must be a canonical integer between 1 and 65535.');
  });
});
