import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createProductionEnvironment,
  type ProductionSupervisorChild,
  type ProductionSupervisorDependencies,
  spawnProductionChild,
  superviseProduction,
} from './start-production';

const never = new Promise<never>(() => undefined);
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const developmentRuntimeEnvironmentKeys = [
  'AI_USAGE_CODEX_FIXTURE_LOG',
  'AI_USAGE_DATABASE_PATH',
  'AI_USAGE_ENGINE_INSTANCE_ID',
  'AI_USAGE_ENGINE_PORT',
  'AI_USAGE_ENGINE_STATE_DIR',
  'AI_USAGE_HOME',
  'AI_USAGE_LOG_DIR',
  'AI_USAGE_PERF',
  'AI_USAGE_ROOT_DIR',
  'AI_USAGE_TEMP_ROOT',
  'BROWSER',
  'CI',
  'HOME',
  'HOST',
  'NITRO_HOST',
  'NITRO_PORT',
  'NITRO_SSL_CERT',
  'NITRO_SSL_KEY',
  'NO_COLOR',
  'PORT',
  'SERVER_SHUTDOWN_TIMEOUT',
  'TMPDIR',
  'TZ',
  'VITE_AI_USAGE_DEMO',
  'VITE_AI_USAGE_E2E',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const;

const fixtureSignalExitCode = (signal: NodeJS.Signals): number => {
  if (signal === 'SIGKILL') {
    return 137;
  }
  return signal === 'SIGINT' ? 130 : 143;
};

class FixtureChild implements ProductionSupervisorChild {
  readonly observedSignals: NodeJS.Signals[] = [];
  readonly pid: number;
  exitCode: number | null = null;
  readonly exited: Promise<number>;
  private finishExit: ((exitCode: number) => void) | undefined;
  private readonly ignoreGracefulSignals: boolean;
  private readonly surviveSigkill: boolean;

  constructor(pid: number, options: { ignoreGracefulSignals?: boolean; surviveSigkill?: boolean } = {}) {
    this.pid = pid;
    this.ignoreGracefulSignals = options.ignoreGracefulSignals ?? false;
    this.surviveSigkill = options.surviveSigkill ?? false;
    this.exited = new Promise((resolve) => {
      this.finishExit = resolve;
    });
  }

  complete(exitCode: number): void {
    if (this.exitCode !== null) {
      return;
    }
    this.exitCode = exitCode;
    this.finishExit?.(exitCode);
  }

  isAlive(): boolean {
    return this.exitCode === null;
  }

  signal(signal: NodeJS.Signals): void {
    this.observedSignals.push(signal);
    if ((signal === 'SIGKILL' && !this.surviveSigkill) || (signal !== 'SIGKILL' && !this.ignoreGracefulSignals)) {
      this.complete(fixtureSignalExitCode(signal));
    }
  }
}

interface FixtureDependencies {
  readonly dependencies: ProductionSupervisorDependencies;
  readonly diagnostics: string[];
  readonly engine: FixtureChild;
  readonly spawnedRoles: string[];
  readonly web: FixtureChild;
}

const fixtureDependencies = (
  options: {
    engineSpawnError?: Error;
    engine?: FixtureChild;
    ready?: Promise<void>;
    spawnWebError?: Error;
    web?: FixtureChild;
  } = {},
): FixtureDependencies => {
  const engine = options.engine ?? new FixtureChild(4101);
  const web = options.web ?? new FixtureChild(4102);
  const diagnostics: string[] = [];
  const spawnedRoles: string[] = [];
  return {
    dependencies: {
      spawn: (role) => {
        spawnedRoles.push(role);
        if (role === 'engine' && options.engineSpawnError) {
          throw options.engineSpawnError;
        }
        if (role === 'web' && options.spawnWebError) {
          throw options.spawnWebError;
        }
        return role === 'engine' ? engine : web;
      },
      wait: (milliseconds) => Bun.sleep(milliseconds),
      waitForEngineReady: () => options.ready ?? Promise.resolve(),
      writeDiagnostic: (message) => diagnostics.push(message),
    },
    diagnostics,
    engine,
    spawnedRoles,
    web,
  };
};

const runFixture = (
  fixture: FixtureDependencies,
  options: {
    first?: Promise<NodeJS.Signals>;
    forceShutdownMs?: number;
    forced?: Promise<NodeJS.Signals>;
    shutdownGraceMs?: number;
  } = {},
): Promise<number> =>
  superviseProduction(
    {
      commands: { engine: ['engine'], web: ['web'] },
      environment: { PATH: '/fixture/bin' },
      forceShutdownMs: options.forceShutdownMs ?? 50,
      rootDirectory: '/fixture/root',
      shutdownGraceMs: options.shutdownGraceMs ?? 20,
      termination: {
        first: options.first ?? never,
        forced: options.forced ?? never,
      },
    },
    fixture.dependencies,
  );

describe('production supervisor', () => {
  test('starts web only after authenticated engine readiness and stops both on SIGTERM', async () => {
    let reportReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      reportReady = resolve;
    });
    let terminate: ((signal: NodeJS.Signals) => void) | undefined;
    const first = new Promise<NodeJS.Signals>((resolve) => {
      terminate = resolve;
    });
    const fixture = fixtureDependencies({ ready });
    const running = runFixture(fixture, { first });

    await Bun.sleep(0);
    expect(fixture.spawnedRoles).toEqual(['engine']);
    reportReady?.();
    await Bun.sleep(0);
    expect(fixture.spawnedRoles).toEqual(['engine', 'web']);
    terminate?.('SIGTERM');

    expect(await running).toBe(143);
    expect(fixture.engine.observedSignals).toEqual(['SIGTERM']);
    expect(fixture.web.observedSignals).toEqual(['SIGTERM']);
  });

  test('reports engine startup failure without spawning web', async () => {
    const engine = new FixtureChild(4201);
    const fixture = fixtureDependencies({ engine, ready: never });
    const running = runFixture(fixture);
    engine.complete(7);

    expect(await running).toBe(7);
    expect(fixture.spawnedRoles).toEqual(['engine']);
    expect(fixture.diagnostics).toEqual(['Production engine exited first with code 7.']);
  });

  test('reports an engine spawn failure without exposing its cause', async () => {
    const fixture = fixtureDependencies({ engineSpawnError: new Error('/private/engine/path') });

    expect(await runFixture(fixture)).toBe(1);
    expect(fixture.spawnedRoles).toEqual(['engine']);
    expect(fixture.diagnostics).toEqual(['Production engine failed to start.']);
  });

  test('stops the engine when authenticated readiness fails', async () => {
    const fixture = fixtureDependencies({ ready: Promise.reject(new Error('fixture token')) });

    expect(await runFixture(fixture)).toBe(1);
    expect(fixture.spawnedRoles).toEqual(['engine']);
    expect(fixture.engine.observedSignals).toEqual(['SIGTERM']);
    expect(fixture.diagnostics).toEqual(['Production engine readiness failed.']);
  });

  test('forwards a startup signal without ever spawning web', async () => {
    const fixture = fixtureDependencies({ ready: never });

    expect(await runFixture(fixture, { first: Promise.resolve('SIGINT') })).toBe(130);
    expect(fixture.spawnedRoles).toEqual(['engine']);
    expect(fixture.engine.observedSignals).toEqual(['SIGINT']);
  });

  test('maps an unexpected clean engine exit to supervisor failure', async () => {
    const engine = new FixtureChild(4251);
    const fixture = fixtureDependencies({ engine, ready: never });
    const running = runFixture(fixture);
    engine.complete(0);

    expect(await running).toBe(1);
    expect(fixture.diagnostics).toEqual(['Production engine exited first with code 0.']);
  });

  test('reaps engine when web startup throws', async () => {
    const fixture = fixtureDependencies({ spawnWebError: new Error('private fixture path') });

    expect(await runFixture(fixture)).toBe(1);
    expect(fixture.engine.observedSignals).toEqual(['SIGTERM']);
    expect(fixture.diagnostics).toEqual(['Production web failed to start.']);
  });

  test('stops the sibling and preserves the first crashing child exit code', async () => {
    const engineFailure = fixtureDependencies();
    const engineRun = runFixture(engineFailure);
    await Bun.sleep(0);
    engineFailure.engine.complete(9);
    expect(await engineRun).toBe(9);
    expect(engineFailure.web.observedSignals).toEqual(['SIGTERM']);
    expect(engineFailure.diagnostics).toEqual(['Production engine exited first with code 9.']);

    const webFailure = fixtureDependencies();
    const webRun = runFixture(webFailure);
    await Bun.sleep(0);
    webFailure.web.complete(11);
    expect(await webRun).toBe(11);
    expect(webFailure.engine.observedSignals).toEqual(['SIGTERM']);
    expect(webFailure.diagnostics).toEqual(['Production web exited first with code 11.']);
  });

  test('forces and reaps non-cooperative children at the bounded deadline', async () => {
    const engine = new FixtureChild(4301, { ignoreGracefulSignals: true });
    const web = new FixtureChild(4302, { ignoreGracefulSignals: true });
    const fixture = fixtureDependencies({ engine, web });

    expect(await runFixture(fixture, { first: Promise.resolve('SIGINT'), shutdownGraceMs: 1 })).toBe(130);
    expect(engine.observedSignals).toEqual(['SIGINT', 'SIGKILL']);
    expect(web.observedSignals).toEqual(['SIGINT', 'SIGKILL']);
    expect(engine.isAlive()).toBe(false);
    expect(web.isAlive()).toBe(false);
  });

  test('lets a second signal force shutdown before the graceful deadline', async () => {
    const engine = new FixtureChild(4351, { ignoreGracefulSignals: true });
    const web = new FixtureChild(4352, { ignoreGracefulSignals: true });
    const fixture = fixtureDependencies({ engine, web });

    expect(
      await runFixture(fixture, {
        first: Promise.resolve('SIGTERM'),
        forced: Promise.resolve('SIGINT'),
        shutdownGraceMs: 10_000,
      }),
    ).toBe(143);
    expect(engine.observedSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(web.observedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('turns an unproven forced cleanup into a supervisor failure', async () => {
    const engine = new FixtureChild(4401, { ignoreGracefulSignals: true, surviveSigkill: true });
    const fixture = fixtureDependencies({ engine });

    expect(
      await runFixture(fixture, {
        first: Promise.resolve('SIGTERM'),
        forceShutdownMs: 1,
        shutdownGraceMs: 1,
      }),
    ).toBe(1);
    expect(fixture.diagnostics).toEqual(['Production child cleanup failed.']);
  });

  test('kills and reaps a detached process group with a signal-resistant grandchild', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'plan052-production-supervisor-'));
    const pidFile = path.join(root, 'pids.json');
    const fixtureScript = path.join(import.meta.dir, 'fixtures', 'production-supervisor-child.ts');
    const web = new FixtureChild(4502);
    let webSpawned = false;
    let terminate: ((signal: NodeJS.Signals) => void) | undefined;
    const first = new Promise<NodeJS.Signals>((resolve) => {
      terminate = resolve;
    });
    const environment = {
      PATH: process.env.PATH ?? '',
      PLAN052_SUPERVISOR_PID_FILE: pidFile,
    };
    const dependencies: ProductionSupervisorDependencies = {
      spawn: (role, command, options) => {
        if (role === 'web') {
          webSpawned = true;
          return web;
        }
        return spawnProductionChild(role, command, options);
      },
      wait: (milliseconds) => Bun.sleep(milliseconds),
      waitForEngineReady: async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (await Bun.file(pidFile).exists()) {
            return;
          }
          await Bun.sleep(5);
        }
        throw new Error('Process-group fixture did not publish its PIDs.');
      },
      writeDiagnostic: () => undefined,
    };
    let pids: { grandchild: number; parent: number } | undefined;
    try {
      const running = superviseProduction(
        {
          commands: {
            engine: [process.execPath, '--no-env-file', fixtureScript, 'parent'],
            web: ['in-memory-web'],
          },
          environment,
          forceShutdownMs: 2000,
          rootDirectory: root,
          shutdownGraceMs: 10,
          termination: { first, forced: never },
        },
        dependencies,
      );
      const webDeadline = Date.now() + 2000;
      while (!webSpawned && Date.now() < webDeadline) {
        await Bun.sleep(5);
      }
      expect(webSpawned).toBe(true);
      pids = JSON.parse(await readFile(pidFile, 'utf8')) as { grandchild: number; parent: number };
      terminate?.('SIGTERM');
      expect(await running).toBe(143);

      for (const pid of [pids.parent, pids.grandchild]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      for (const pid of pids ? [pids.parent, pids.grandchild] : []) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The expected supervisor path already reaped the owned fixture group.
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('production environment', () => {
  test('binds both children to one explicit target and numeric loopback', () => {
    const rootDirectory = '/srv/ai-usage';
    const homeDirectory = '/var/lib/ai-usage-fixture';
    const environment = createProductionEnvironment(rootDirectory, {
      AI_USAGE_HOME: homeDirectory,
      HOST: '0.0.0.0',
      NITRO_HOST: 'localhost',
      PATH: '/fixture/bin',
      TMPDIR: '/var/tmp/ai-usage-fixture',
    });

    expect(environment).toMatchObject({
      AI_USAGE_DATABASE_PATH: path.join(homeDirectory, '.config/ai-usage/usage-store.sqlite'),
      AI_USAGE_ENGINE_STATE_DIR: path.join(homeDirectory, '.config/ai-usage/engine'),
      AI_USAGE_HOME: homeDirectory,
      AI_USAGE_ROOT_DIR: rootDirectory,
      HOME: homeDirectory,
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      NODE_ENV: 'production',
      PATH: '/fixture/bin',
      TMPDIR: '/var/tmp/ai-usage-fixture',
      VITE_AI_USAGE_DEMO: '0',
      VITE_AI_USAGE_E2E: '0',
    });
    expect(environment.AI_USAGE_ENGINE_INSTANCE_ID).toMatch(uuidV4Pattern);
    expect(environment.AI_USAGE_TEMP_ROOT).toBe('/var/tmp/ai-usage-fixture');
    expect(environment.AI_USAGE_LOG_DIR).toBe(path.join(rootDirectory, 'logs'));
  });

  test('uses absolute system defaults without accepting relative runtime paths', () => {
    const environment = createProductionEnvironment('/srv/ai-usage', {
      HOME: os.homedir(),
      PATH: '/fixture/bin',
    });
    expect(path.isAbsolute(environment.AI_USAGE_DATABASE_PATH ?? '')).toBe(true);
    expect(() =>
      createProductionEnvironment('/srv/ai-usage', {
        AI_USAGE_DATABASE_PATH: 'relative.sqlite',
        HOME: os.homedir(),
      }),
    ).toThrow('absolute');
  });
});

describe('root development composition', () => {
  test('passes one explicit runtime target through both strict Turbo tasks', async () => {
    const rootDirectory = path.resolve(import.meta.dir, '..');
    const turboConfig = JSON.parse(await readFile(path.join(rootDirectory, 'turbo.json'), 'utf8')) as {
      tasks?: Record<string, { inputs?: string[]; interruptible?: boolean; passThroughEnv?: string[] }>;
    };
    const rootPackage = JSON.parse(await readFile(path.join(rootDirectory, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(rootPackage.scripts?.dev).toContain('AI_USAGE_ROOT_DIR=$PWD');
    for (const taskName of ['@ai-usage/usage-engine#dev', '@ai-usage/web#dev']) {
      const passThroughEnvironment = new Set(turboConfig.tasks?.[taskName]?.passThroughEnv ?? []);
      for (const environmentKey of developmentRuntimeEnvironmentKeys) {
        expect(passThroughEnvironment.has(environmentKey)).toBe(true);
      }
    }
    const engineInputs = new Set(turboConfig.tasks?.['@ai-usage/usage-engine#dev']?.inputs ?? []);
    expect(engineInputs.has('$TURBO_ROOT$/packages/usage-engine-runtime/src/**')).toBe(true);
    expect(engineInputs.has('$TURBO_ROOT$/packages/usage-store/src/**')).toBe(true);
    expect(engineInputs.has('$TURBO_ROOT$/packages/design-system/src/**')).toBe(false);
    expect(engineInputs.has('$TURBO_ROOT$/apps/web/**')).toBe(false);
    expect(turboConfig.tasks?.['@ai-usage/usage-engine#dev']?.interruptible).toBe(false);
  });
});
