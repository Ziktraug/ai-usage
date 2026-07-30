import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseUsageEngineForegroundOutcome,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
} from '@ai-usage/usage-engine-control';
import {
  loadUsageEngineRendezvous,
  revealUsageEngineBearerToken,
  type UsageEngineRendezvous,
} from '@ai-usage/usage-engine-control/node';

const repositoryRoot = path.resolve(import.meta.dir, '../../..');
const mainPath = path.join(repositoryRoot, 'apps/usage-engine/src/main.ts');
const cleanupTasks: Array<() => Promise<void>> = [];
const TEST_TIMEOUT_MS = 15_000;

interface EngineFixture {
  readonly databasePath: string;
  readonly env: Record<string, string | undefined>;
  readonly lockPath: string;
  readonly rendezvousPath: string;
  readonly root: string;
  readonly stateDirectory: string;
}

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    await cleanup();
  }
});

const withTimeout = async <Value>(promise: Promise<Value>, label: string): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), TEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const createFixture = async (options: { readonly databasePath?: string } = {}): Promise<EngineFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-child-'));
  const homeDirectory = path.join(root, 'home');
  const stateDirectory = path.join(root, 'state');
  const temporaryRoot = path.join(root, 'temporary');
  const databasePath = options.databasePath ?? path.join(root, 'store', 'usage.sqlite');
  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700, recursive: true }),
    mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
  ]);
  cleanupTasks.push(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return {
    databasePath,
    env: {
      AI_USAGE_DATABASE_PATH: databasePath,
      AI_USAGE_ENGINE_STATE_DIR: stateDirectory,
      AI_USAGE_HOME: homeDirectory,
      AI_USAGE_LOG_DIR: path.join(root, 'logs'),
      AI_USAGE_ROOT_DIR: root,
      AI_USAGE_TEMP_ROOT: temporaryRoot,
      CODEX_HOME: path.join(homeDirectory, '.codex'),
      HOME: homeDirectory,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      PATH: process.env.PATH,
      TMPDIR: temporaryRoot,
      XDG_CACHE_HOME: path.join(homeDirectory, '.cache'),
      XDG_CONFIG_HOME: path.join(homeDirectory, '.config'),
      XDG_DATA_HOME: path.join(homeDirectory, '.local', 'share'),
      XDG_STATE_HOME: path.join(homeDirectory, '.local', 'state'),
    },
    lockPath: `${databasePath}.engine.lock`,
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    root,
    stateDirectory,
  };
};

const spawnEngine = (fixture: EngineFixture, args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, '--no-env-file', mainPath, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  cleanupTasks.push(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await child.exited.catch(() => undefined);
  });
  return { child, stderr, stdout };
};

const finishChild = async (child: ReturnType<typeof spawnEngine>) => ({
  exitCode: await withTimeout(child.child.exited, `child PID ${child.child.pid} to exit`),
  stderr: await child.stderr,
  stdout: await child.stdout,
});

const waitForRendezvous = async (
  child: ReturnType<typeof spawnEngine>,
  rendezvousPath: string,
  accept: (rendezvous: UsageEngineRendezvous) => boolean = () => true,
): Promise<UsageEngineRendezvous> => {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) {
      const stderr = await child.stderr;
      throw new Error(`Usage engine child exited before readiness: ${stderr}`);
    }
    try {
      const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
      if (accept(rendezvous)) {
        return rendezvous;
      }
    } catch {
      // Atomic publication may not have happened yet.
    }
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for usage engine rendezvous publication.');
};

const statusRequest = (rendezvous: UsageEngineRendezvous, token?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${rendezvous.port}/v1/status`, {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'x-ai-usage-protocol-version': String(USAGE_ENGINE_PROTOCOL_VERSION),
    },
  });

describe('usage engine real process lifecycle', () => {
  test('serves authenticated status, rejects a second writer, and cleans up on SIGTERM', async () => {
    const fixture = await createFixture();
    const primary = spawnEngine(fixture, ['serve', '--port', '0']);
    const rendezvous = await waitForRendezvous(primary, fixture.rendezvousPath);
    const token = revealUsageEngineBearerToken(rendezvous.token);

    expect((await statusRequest(rendezvous)).status).toBe(401);
    const statusResponse = await statusRequest(rendezvous, token);
    expect(statusResponse.status).toBe(200);
    expect(parseUsageEngineStatus(await statusResponse.json())).toMatchObject({
      instanceId: rendezvous.instanceId,
      readiness: 'ready',
    });

    const contender = spawnEngine(fixture, ['serve', '--port', '0']);
    const contenderResult = await finishChild(contender);
    expect(contenderResult.exitCode).toBe(1);
    expect(contenderResult.stderr).toContain(`owned by live PID ${primary.child.pid}`);
    expect(contenderResult.stderr).toContain(fixture.lockPath);
    expect(await loadUsageEngineRendezvous(fixture.rendezvousPath)).toEqual(rendezvous);
    expect((await statusRequest(rendezvous, token)).status).toBe(200);

    primary.child.kill('SIGTERM');
    expect((await finishChild(primary)).exitCode).toBe(0);
    await expect(Bun.file(fixture.rendezvousPath).exists()).resolves.toBe(false);
    await expect(Bun.file(fixture.lockPath).exists()).resolves.toBe(false);
  });

  test('recovers a SIGKILL crash, rotates credentials, and cleans up on SIGINT', async () => {
    const fixture = await createFixture();
    const crashed = spawnEngine(fixture, ['serve', '--port', '0']);
    const staleRendezvous = await waitForRendezvous(crashed, fixture.rendezvousPath);
    const staleToken = revealUsageEngineBearerToken(staleRendezvous.token);

    crashed.child.kill('SIGKILL');
    expect((await finishChild(crashed)).exitCode).not.toBe(0);
    await expect(Bun.file(fixture.rendezvousPath).exists()).resolves.toBe(true);
    await expect(Bun.file(fixture.lockPath).exists()).resolves.toBe(true);

    const replacement = spawnEngine(fixture, ['serve', '--port', '0']);
    const currentRendezvous = await waitForRendezvous(
      replacement,
      fixture.rendezvousPath,
      ({ instanceId }) => instanceId !== staleRendezvous.instanceId,
    );
    const currentToken = revealUsageEngineBearerToken(currentRendezvous.token);

    expect(currentRendezvous.instanceId).not.toBe(staleRendezvous.instanceId);
    expect(currentToken).not.toBe(staleToken);
    expect((await statusRequest(currentRendezvous, staleToken)).status).toBe(401);
    expect((await statusRequest(currentRendezvous, currentToken)).status).toBe(200);

    replacement.child.kill('SIGINT');
    expect((await finishChild(replacement)).exitCode).toBe(0);
    await expect(Bun.file(fixture.rendezvousPath).exists()).resolves.toBe(false);
    await expect(Bun.file(fixture.lockPath).exists()).resolves.toBe(false);
  });

  test('rejects a second writer for the same database through a different state directory', async () => {
    const primaryFixture = await createFixture();
    const alternateFixture = await createFixture({ databasePath: primaryFixture.databasePath });
    const primary = spawnEngine(primaryFixture, ['serve', '--port', '0']);
    const primaryRendezvous = await waitForRendezvous(primary, primaryFixture.rendezvousPath);
    const contender = spawnEngine(alternateFixture, ['serve', '--port', '0']);
    const contenderOutcome = await Promise.race([
      contender.child.exited.then((exitCode) => ({ exitCode, kind: 'exited' as const })),
      waitForRendezvous(contender, alternateFixture.rendezvousPath).then(() => ({ kind: 'ready' as const })),
    ]);
    if (contenderOutcome.kind === 'ready') {
      contender.child.kill('SIGTERM');
      await finishChild(contender);
    }

    expect(primaryFixture.stateDirectory).not.toBe(alternateFixture.stateDirectory);
    expect(contenderOutcome).toEqual({ exitCode: 1, kind: 'exited' });
    expect((await statusRequest(primaryRendezvous, revealUsageEngineBearerToken(primaryRendezvous.token))).status).toBe(
      200,
    );

    primary.child.kill('SIGTERM');
    expect((await finishChild(primary)).exitCode).toBe(0);
  });

  test('releases the writer lock when the requested control port is occupied', async () => {
    const fixture = await createFixture();
    const occupied = Bun.serve({
      fetch: () => new Response('occupied'),
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      const engine = spawnEngine(fixture, ['serve', '--port', String(occupied.port)]);
      const result = await finishChild(engine);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.length).toBeGreaterThan(0);
      await expect(Bun.file(fixture.rendezvousPath).exists()).resolves.toBe(false);
      await expect(Bun.file(fixture.lockPath).exists()).resolves.toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe('occupied');
    } finally {
      await occupied.stop(true);
    }
  });

  test('executes one foreground command without publishing a control rendezvous', async () => {
    const fixture = await createFixture();
    const commandRequest = JSON.stringify({
      command: { command: 'publish' },
      commandId: 'foreground-publish-1',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });
    const foreground = spawnEngine(fixture, ['once', commandRequest]);
    const result = await finishChild(foreground);
    const outputLines = result.stdout.split('\n').filter(Boolean);

    expect(result.exitCode).toBe(0);
    expect(outputLines).toHaveLength(1);
    expect(parseUsageEngineForegroundOutcome(JSON.parse(outputLines[0] ?? 'null'))).toMatchObject({
      completion: { commandId: 'foreground-publish-1', state: 'succeeded' },
      kind: 'command-completed',
    });
    await expect(Bun.file(fixture.rendezvousPath).exists()).resolves.toBe(false);
    await expect(Bun.file(fixture.lockPath).exists()).resolves.toBe(false);
  });
});
