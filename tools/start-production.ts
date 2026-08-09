import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MAX_PORTABLE_USAGE_BYTES } from '@ai-usage/report-core/portable-usage';
import { createUsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import { usageStorePath } from '@ai-usage/usage-store/reader';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_READINESS_DEADLINE_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
const DEFAULT_FORCE_SHUTDOWN_MS = 3000;
const READINESS_POLL_MS = 50;
const CONTROL_REQUEST_TIMEOUT_MS = 1000;
const PROCESS_POLL_MS = 25;
const canonicalPortPattern = /^(?:0|[1-9]\d{0,4})$/;

export type ProductionSupervisorRole = 'engine' | 'web';

export interface ProductionSupervisorChild {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly isAlive: () => boolean;
  readonly pid: number;
  readonly signal: (signal: NodeJS.Signals) => void;
}

export interface ProductionSupervisorTermination {
  readonly first: Promise<NodeJS.Signals>;
  readonly forced: Promise<NodeJS.Signals>;
}

export interface ProductionSupervisorDependencies {
  readonly spawn: (
    role: ProductionSupervisorRole,
    command: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => ProductionSupervisorChild;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly waitForEngineReady: (options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly writeDiagnostic: (message: string) => void;
}

export interface ProductionSupervisorOptions {
  readonly commands: {
    readonly engine: readonly string[];
    readonly web: readonly string[];
  };
  readonly environment: Readonly<Record<string, string>>;
  readonly forceShutdownMs: number;
  readonly rootDirectory: string;
  readonly shutdownGraceMs: number;
  readonly termination: ProductionSupervisorTermination;
}

interface ProductionRuntimePaths {
  readonly configCwd: string;
  readonly databasePath: string;
  readonly homeDirectory: string;
  readonly logDirectory: string;
  readonly rendezvousPath: string;
  readonly stateDirectory: string;
  readonly temporaryRoot: string;
}

type SupervisorEvent =
  | { readonly kind: 'engine-ready' }
  | { readonly error: unknown; readonly kind: 'engine-readiness-failed' }
  | { readonly exitCode: number; readonly kind: 'engine-exited' }
  | { readonly exitCode: number; readonly kind: 'web-exited' }
  | { readonly kind: 'termination'; readonly signal: NodeJS.Signals };

const absolutePath = (value: string, label: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute.`);
  }
  return path.resolve(value);
};

const untrustedAdapterEnvironmentKeys = new Set([
  'ADDRESS_HEADER',
  'BODY_SIZE_LIMIT',
  'HOST_HEADER',
  'ORIGIN',
  'PORT_HEADER',
  'PROTOCOL_HEADER',
  'SOCKET_PATH',
  'XFF_DEPTH',
]);

const definedEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !untrustedAdapterEnvironmentKeys.has(entry[0]),
    ),
  );

const resolveProductionRuntimePaths = (
  rootDirectoryValue: string,
  environment: NodeJS.ProcessEnv,
): ProductionRuntimePaths => {
  const rootDirectory = absolutePath(rootDirectoryValue, 'Production root directory');
  const homeDirectory = absolutePath(
    environment.AI_USAGE_HOME ?? environment.HOME ?? os.homedir(),
    'Production home directory',
  );
  const stateDirectory = absolutePath(
    environment.AI_USAGE_ENGINE_STATE_DIR ?? path.join(homeDirectory, '.config', 'ai-usage', 'engine'),
    'Production engine state directory',
  );
  return {
    configCwd: absolutePath(environment.AI_USAGE_ROOT_DIR ?? rootDirectory, 'Production config root'),
    databasePath: absolutePath(
      environment.AI_USAGE_DATABASE_PATH ?? usageStorePath(homeDirectory),
      'Production database path',
    ),
    homeDirectory,
    logDirectory: absolutePath(
      environment.AI_USAGE_LOG_DIR ?? path.join(rootDirectory, 'logs'),
      'Production log directory',
    ),
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    stateDirectory,
    temporaryRoot: absolutePath(
      environment.AI_USAGE_TEMP_ROOT ?? environment.TMPDIR ?? os.tmpdir(),
      'Production temporary root',
    ),
  };
};

export const createProductionEnvironment = (
  rootDirectory: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const runtimePaths = resolveProductionRuntimePaths(rootDirectory, inheritedEnvironment);
  return {
    ...definedEnvironment(inheritedEnvironment),
    AI_USAGE_DATABASE_PATH: runtimePaths.databasePath,
    AI_USAGE_ENGINE_STATE_DIR: runtimePaths.stateDirectory,
    AI_USAGE_HOME: runtimePaths.homeDirectory,
    AI_USAGE_ENGINE_INSTANCE_ID: randomUUID(),
    AI_USAGE_LOG_DIR: runtimePaths.logDirectory,
    AI_USAGE_ROOT_DIR: runtimePaths.configCwd,
    AI_USAGE_TEMP_ROOT: runtimePaths.temporaryRoot,
    BODY_SIZE_LIMIT: String(MAX_PORTABLE_USAGE_BYTES),
    HOME: runtimePaths.homeDirectory,
    HOST: LOOPBACK_HOST,
    IDLE_TIMEOUT: '45',
    NODE_ENV: 'production',
    TMPDIR: runtimePaths.temporaryRoot,
    VITE_AI_USAGE_DEMO: '0',
    VITE_AI_USAGE_E2E: '0',
  };
};

const parseEnginePort = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return;
  }
  if (!canonicalPortPattern.test(value)) {
    throw new Error('AI_USAGE_ENGINE_PORT must be a canonical decimal port.');
  }
  const port = Number(value);
  if (!(Number.isSafeInteger(port) && port >= 0 && port <= 65_535)) {
    throw new Error('AI_USAGE_ENGINE_PORT must be between 0 and 65535.');
  }
  return port;
};

export const createProductionSupervisorCommands = (
  rootDirectoryValue: string,
  environment: Readonly<Record<string, string>>,
): ProductionSupervisorOptions['commands'] => {
  const rootDirectory = absolutePath(rootDirectoryValue, 'Production root directory');
  const enginePort = parseEnginePort(environment.AI_USAGE_ENGINE_PORT);
  return {
    engine: [
      process.execPath,
      '--no-env-file',
      path.join(rootDirectory, 'apps', 'usage-engine', 'src', 'main.ts'),
      'serve',
      ...(enginePort === undefined ? [] : ['--port', String(enginePort)]),
    ],
    web: [process.execPath, '--no-env-file', path.join(rootDirectory, 'apps', 'web', 'start.mjs')],
  };
};

const waitForEngineReady = async ({
  environment,
  signal,
}: {
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}): Promise<void> => {
  const stateDirectory = environment.AI_USAGE_ENGINE_STATE_DIR;
  const databasePath = environment.AI_USAGE_DATABASE_PATH;
  const configCwd = environment.AI_USAGE_ROOT_DIR;
  const expectedInstanceId = environment.AI_USAGE_ENGINE_INSTANCE_ID;
  if (!(stateDirectory && databasePath && configCwd && expectedInstanceId)) {
    throw new Error('Production engine readiness requires explicit target paths.');
  }
  const rendezvousPath = path.join(stateDirectory, 'rendezvous.json');
  const targetId = usageEngineTargetIdFor({ configCwd, databasePath });
  const deadline = Date.now() + DEFAULT_READINESS_DEADLINE_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
      assertUsageEngineRendezvousTarget(rendezvous, targetId);
      const client = createUsageEngineControlClient({
        requestTimeoutMs: CONTROL_REQUEST_TIMEOUT_MS,
        resolveRendezvous: () => Promise.resolve(rendezvous),
      });
      const status = await client.getStatus({ signal });
      if (status.instanceId === expectedInstanceId && status.readiness === 'ready') {
        return;
      }
    } catch {
      signal.throwIfAborted();
    }
    await Bun.sleep(READINESS_POLL_MS);
  }
  throw new Error('Production engine did not become ready before its deadline.');
};

const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals): void => {
  try {
    if (process.platform === 'win32') {
      process.kill(processGroupId, signal);
    } else {
      process.kill(-processGroupId, signal);
    }
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

const processGroupIsAlive = (processGroupId: number): boolean => {
  try {
    process.kill(process.platform === 'win32' ? processGroupId : -processGroupId, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

export const spawnProductionChild: ProductionSupervisorDependencies['spawn'] = (_role, command, options) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: options.env,
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  });
  return {
    exited: child.exited,
    get exitCode() {
      return child.exitCode;
    },
    isAlive: () => processGroupIsAlive(child.pid),
    pid: child.pid,
    signal: (signal) => signalProcessGroup(child.pid, signal),
  };
};

const defaultDependencies: ProductionSupervisorDependencies = {
  spawn: spawnProductionChild,
  wait: (milliseconds) => Bun.sleep(milliseconds),
  waitForEngineReady,
  writeDiagnostic: (message) => process.stderr.write(`${message}\n`),
};

const positiveDeadline = (value: number, label: string): number => {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

const childrenAreStopped = (children: readonly ProductionSupervisorChild[]): boolean =>
  children.every((child) => !child.isAlive());

const waitForChildrenToStop = async (
  children: readonly ProductionSupervisorChild[],
  deadlineMs: number,
  wait: ProductionSupervisorDependencies['wait'],
): Promise<boolean> => {
  const deadline = Date.now() + deadlineMs;
  while (!childrenAreStopped(children) && Date.now() < deadline) {
    await wait(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return childrenAreStopped(children);
};

const signalAliveChildren = (children: readonly ProductionSupervisorChild[], signal: NodeJS.Signals): void => {
  for (const child of children) {
    if (child.isAlive()) {
      child.signal(signal);
    }
  }
};

const reapChildren = async (
  children: readonly ProductionSupervisorChild[],
  signal: NodeJS.Signals,
  options: Pick<ProductionSupervisorOptions, 'forceShutdownMs' | 'shutdownGraceMs' | 'termination'>,
  dependencies: Pick<ProductionSupervisorDependencies, 'wait'>,
): Promise<void> => {
  signalAliveChildren(children, signal);
  const graceful = waitForChildrenToStop(children, options.shutdownGraceMs, dependencies.wait);
  const forced = options.termination.forced.then(() => false);
  const stoppedGracefully = await Promise.race([graceful, forced]);
  if (!stoppedGracefully) {
    signalAliveChildren(children, 'SIGKILL');
    if (!(await waitForChildrenToStop(children, options.forceShutdownMs, dependencies.wait))) {
      throw new Error('Production children survived forced shutdown.');
    }
  }
  const directChildrenReaped = await Promise.race([
    Promise.all(children.map(async (child) => await child.exited)).then(() => true),
    dependencies.wait(options.forceShutdownMs).then(() => false),
  ]);
  if (!directChildrenReaped) {
    throw new Error('Production child reaping exceeded its deadline.');
  }
};

const signalExitCode = (signal: NodeJS.Signals): number => (signal === 'SIGINT' ? 130 : 143);

const engineExitEvent = (
  child: ProductionSupervisorChild,
): Promise<Extract<SupervisorEvent, { readonly kind: 'engine-exited' }>> =>
  child.exited.then((exitCode) => ({ exitCode, kind: 'engine-exited' }));

const webExitEvent = (
  child: ProductionSupervisorChild,
): Promise<Extract<SupervisorEvent, { readonly kind: 'web-exited' }>> =>
  child.exited.then((exitCode) => ({ exitCode, kind: 'web-exited' }));

const terminationEvent = (
  termination: ProductionSupervisorTermination,
): Promise<Extract<SupervisorEvent, { readonly kind: 'termination' }>> =>
  termination.first.then((signal) => ({ kind: 'termination', signal }));

const failureExitCode = (exitCode: number): number => (exitCode === 0 ? 1 : exitCode);

interface ProductionLifecycleResult {
  readonly exitCode: number;
  readonly shutdownSignal: NodeJS.Signals;
}

const defaultLifecycleResult = (): ProductionLifecycleResult => ({
  exitCode: 1,
  shutdownSignal: 'SIGTERM',
});

const runProductionLifecycle = async (
  options: ProductionSupervisorOptions,
  dependencies: ProductionSupervisorDependencies,
  readinessSignal: AbortSignal,
  children: ProductionSupervisorChild[],
): Promise<ProductionLifecycleResult> => {
  let engine: ProductionSupervisorChild;
  try {
    engine = dependencies.spawn('engine', options.commands.engine, {
      cwd: options.rootDirectory,
      env: options.environment,
    });
    children.push(engine);
  } catch {
    dependencies.writeDiagnostic('Production engine failed to start.');
    return defaultLifecycleResult();
  }

  const readinessEvent = dependencies
    .waitForEngineReady({ environment: options.environment, signal: readinessSignal })
    .then(
      (): Extract<SupervisorEvent, { readonly kind: 'engine-ready' }> => ({ kind: 'engine-ready' }),
      (error: unknown): Extract<SupervisorEvent, { readonly kind: 'engine-readiness-failed' }> => ({
        error,
        kind: 'engine-readiness-failed',
      }),
    );
  const startup = await Promise.race([readinessEvent, engineExitEvent(engine), terminationEvent(options.termination)]);
  if (startup.kind === 'termination') {
    return { exitCode: signalExitCode(startup.signal), shutdownSignal: startup.signal };
  }
  if (startup.kind === 'engine-exited') {
    dependencies.writeDiagnostic(`Production engine exited first with code ${startup.exitCode}.`);
    return { exitCode: failureExitCode(startup.exitCode), shutdownSignal: 'SIGTERM' };
  }
  if (startup.kind === 'engine-readiness-failed') {
    dependencies.writeDiagnostic('Production engine readiness failed.');
    return defaultLifecycleResult();
  }

  let web: ProductionSupervisorChild;
  try {
    web = dependencies.spawn('web', options.commands.web, {
      cwd: options.rootDirectory,
      env: options.environment,
    });
    children.push(web);
  } catch {
    dependencies.writeDiagnostic('Production web failed to start.');
    return defaultLifecycleResult();
  }
  const running = await Promise.race([
    engineExitEvent(engine),
    webExitEvent(web),
    terminationEvent(options.termination),
  ]);
  if (running.kind === 'termination') {
    return { exitCode: signalExitCode(running.signal), shutdownSignal: running.signal };
  }
  if (running.kind === 'engine-exited') {
    dependencies.writeDiagnostic(`Production engine exited first with code ${running.exitCode}.`);
    return { exitCode: failureExitCode(running.exitCode), shutdownSignal: 'SIGTERM' };
  }
  dependencies.writeDiagnostic(`Production web exited first with code ${running.exitCode}.`);
  return { exitCode: failureExitCode(running.exitCode), shutdownSignal: 'SIGTERM' };
};

export const superviseProduction = async (
  options: ProductionSupervisorOptions,
  dependencies: ProductionSupervisorDependencies = defaultDependencies,
): Promise<number> => {
  positiveDeadline(options.shutdownGraceMs, 'Production shutdown grace');
  positiveDeadline(options.forceShutdownMs, 'Production forced shutdown deadline');
  const readinessAbort = new AbortController();
  const children: ProductionSupervisorChild[] = [];
  let lifecycleResult = defaultLifecycleResult();
  let cleanupFailed = false;
  try {
    lifecycleResult = await runProductionLifecycle(options, dependencies, readinessAbort.signal, children);
  } finally {
    readinessAbort.abort();
    try {
      await reapChildren(children, lifecycleResult.shutdownSignal, options, dependencies);
    } catch {
      dependencies.writeDiagnostic('Production child cleanup failed.');
      cleanupFailed = true;
    }
  }
  return cleanupFailed ? 1 : lifecycleResult.exitCode;
};

interface ProductionSignalController extends ProductionSupervisorTermination {
  readonly dispose: () => void;
}

const createProductionSignalController = (): ProductionSignalController => {
  let firstSignal: NodeJS.Signals | undefined;
  let resolveFirst: ((signal: NodeJS.Signals) => void) | undefined;
  let resolveForced: ((signal: NodeJS.Signals) => void) | undefined;
  const first = new Promise<NodeJS.Signals>((resolve) => {
    resolveFirst = resolve;
  });
  const forced = new Promise<NodeJS.Signals>((resolve) => {
    resolveForced = resolve;
  });
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (!firstSignal) {
      firstSignal = signal;
      resolveFirst?.(signal);
      return;
    }
    resolveForced?.(signal);
  };
  const handleSigint = (): void => handleSignal('SIGINT');
  const handleSigterm = (): void => handleSignal('SIGTERM');
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  return {
    dispose: () => {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
    },
    first,
    forced,
  };
};

export const runProductionMain = async (
  rootDirectory = path.resolve(import.meta.dirname, '..'),
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<number> => {
  const environment = createProductionEnvironment(rootDirectory, inheritedEnvironment);
  const signalController = createProductionSignalController();
  try {
    return await superviseProduction({
      commands: createProductionSupervisorCommands(rootDirectory, environment),
      environment,
      forceShutdownMs: DEFAULT_FORCE_SHUTDOWN_MS,
      rootDirectory,
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      termination: signalController,
    });
  } finally {
    signalController.dispose();
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await runProductionMain();
  } catch {
    process.stderr.write('Production supervisor failed.\n');
    process.exitCode = 1;
  }
}
