import { type FSWatcher, watch } from 'node:fs';
import path from 'node:path';

const GRACEFUL_SHUTDOWN_MS = 5000;
const FORCED_SHUTDOWN_MS = 3000;
const PROCESS_POLL_MS = 25;
const RESTART_DEBOUNCE_MS = 50;

const ENGINE_PRODUCTION_PACKAGES = [
  'effect-runtime',
  'local-collectors',
  'report-core',
  'report-data',
  'skills',
  'usage-engine-control',
  'usage-engine-runtime',
  'usage-store',
] as const;

export interface UsageEngineDevChild {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly isAlive: () => boolean;
  readonly pid: number;
  readonly signal: (signal: NodeJS.Signals) => void;
}

export interface UsageEngineDevChanges {
  readonly generation: () => number;
  readonly waitAfter: (generation: number) => Promise<number>;
}

export interface UsageEngineDevDependencies {
  readonly spawn: () => UsageEngineDevChild;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly writeDiagnostic: (message: string) => void;
}

export interface UsageEngineDevOptions {
  readonly changes: UsageEngineDevChanges;
  readonly termination: Promise<NodeJS.Signals>;
}

export interface UsageEngineDevWatchTarget {
  readonly entryName?: string;
  readonly path: string;
  readonly recursive: boolean;
}

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

export const spawnUsageEngineDevChild = (engineDirectory: string): UsageEngineDevChild => {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'src/main.ts', 'serve'], {
    cwd: engineDirectory,
    detached: process.platform !== 'win32',
    env: process.env,
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

const waitUntilStopped = async (
  child: UsageEngineDevChild,
  deadlineMs: number,
  wait: UsageEngineDevDependencies['wait'],
): Promise<boolean> => {
  const deadline = Date.now() + deadlineMs;
  while (child.isAlive() && Date.now() < deadline) {
    await wait(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return !child.isAlive();
};

const stopChild = async (child: UsageEngineDevChild, wait: UsageEngineDevDependencies['wait']): Promise<void> => {
  if (child.isAlive()) {
    child.signal('SIGTERM');
  }
  if (!(await waitUntilStopped(child, GRACEFUL_SHUTDOWN_MS, wait))) {
    child.signal('SIGKILL');
    if (!(await waitUntilStopped(child, FORCED_SHUTDOWN_MS, wait))) {
      throw new Error('Development usage engine survived forced shutdown.');
    }
  }
  const reaped = await Promise.race([child.exited.then(() => true), wait(FORCED_SHUTDOWN_MS).then(() => false)]);
  if (!reaped) {
    throw new Error('Development usage engine reaping exceeded its deadline.');
  }
};

type UsageEngineDevEvent =
  | { readonly exitCode: number; readonly kind: 'exit' }
  | { readonly generation: number; readonly kind: 'restart' }
  | { readonly kind: 'termination'; readonly signal: NodeJS.Signals };

export const superviseUsageEngineDevelopment = async (
  options: UsageEngineDevOptions,
  dependencies: UsageEngineDevDependencies,
): Promise<number> => {
  let observedGeneration = options.changes.generation();
  let child: UsageEngineDevChild;
  try {
    child = dependencies.spawn();
  } catch {
    dependencies.writeDiagnostic('Development usage engine failed to start.');
    return 1;
  }
  const terminationEvent = options.termination.then((signal): UsageEngineDevEvent => ({ kind: 'termination', signal }));
  while (true) {
    const event = await Promise.race<UsageEngineDevEvent>([
      child.exited.then((exitCode) => ({ exitCode, kind: 'exit' })),
      options.changes.waitAfter(observedGeneration).then((generation) => ({ generation, kind: 'restart' })),
      terminationEvent,
    ]);
    if (event.kind === 'exit') {
      await stopChild(child, dependencies.wait);
      dependencies.writeDiagnostic(`Development usage engine exited with code ${event.exitCode}.`);
      return event.exitCode === 0 ? 1 : event.exitCode;
    }
    if (event.kind === 'termination') {
      await stopChild(child, dependencies.wait);
      return event.signal === 'SIGINT' ? 130 : 143;
    }
    observedGeneration = event.generation;
    await dependencies.wait(RESTART_DEBOUNCE_MS);
    observedGeneration = options.changes.generation();
    await stopChild(child, dependencies.wait);
    try {
      child = dependencies.spawn();
    } catch {
      dependencies.writeDiagnostic('Development usage engine failed to restart.');
      return 1;
    }
  }
};

interface ChangeController extends UsageEngineDevChanges {
  readonly notify: () => void;
}

export const createUsageEngineDevChanges = (): ChangeController => {
  let currentGeneration = 0;
  const waiters = new Set<{ readonly after: number; readonly resolve: (generation: number) => void }>();
  return {
    generation: () => currentGeneration,
    notify: () => {
      currentGeneration += 1;
      for (const waiter of waiters) {
        if (currentGeneration > waiter.after) {
          waiters.delete(waiter);
          waiter.resolve(currentGeneration);
        }
      }
    },
    waitAfter: (after) => {
      if (currentGeneration > after) {
        return Promise.resolve(currentGeneration);
      }
      return new Promise((resolve) => {
        waiters.add({ after, resolve });
      });
    },
  };
};

export const createUsageEngineDevWatchTargets = (engineDirectoryValue: string): UsageEngineDevWatchTarget[] => {
  const engineDirectory = path.resolve(engineDirectoryValue);
  const repositoryRoot = path.resolve(engineDirectory, '..', '..');
  const targets: UsageEngineDevWatchTarget[] = [
    { entryName: 'bun.lock', path: repositoryRoot, recursive: false },
    { entryName: 'package.json', path: engineDirectory, recursive: false },
    { path: path.join(engineDirectory, 'src'), recursive: true },
  ];
  for (const packageName of ENGINE_PRODUCTION_PACKAGES) {
    const packageDirectory = path.join(repositoryRoot, 'packages', packageName);
    targets.push(
      { entryName: 'package.json', path: packageDirectory, recursive: false },
      { path: path.join(packageDirectory, 'src'), recursive: true },
    );
  }
  return targets;
};

const createTermination = (): { readonly dispose: () => void; readonly signal: Promise<NodeJS.Signals> } => {
  let resolveSignal: ((signal: NodeJS.Signals) => void) | undefined;
  let settled = false;
  const signal = new Promise<NodeJS.Signals>((resolve) => {
    resolveSignal = resolve;
  });
  const dispose = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
  const finish = (receivedSignal: NodeJS.Signals): void => {
    if (settled) {
      return;
    }
    settled = true;
    dispose();
    resolveSignal?.(receivedSignal);
  };
  const onSigint = (): void => finish('SIGINT');
  const onSigterm = (): void => finish('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return { dispose, signal };
};

export const runUsageEngineDevMain = async (
  engineDirectory = path.resolve(import.meta.dirname, '..'),
): Promise<number> => {
  const changes = createUsageEngineDevChanges();
  const watchers: FSWatcher[] = [];
  const termination = createTermination();
  try {
    for (const target of createUsageEngineDevWatchTargets(engineDirectory)) {
      watchers.push(
        watch(target.path, { recursive: target.recursive }, (_eventType, filename) => {
          if (target.entryName === undefined || filename?.toString() === target.entryName) {
            changes.notify();
          }
        }),
      );
    }
    return await superviseUsageEngineDevelopment(
      { changes, termination: termination.signal },
      {
        spawn: () => spawnUsageEngineDevChild(engineDirectory),
        wait: (milliseconds) => Bun.sleep(milliseconds),
        writeDiagnostic: (message) => process.stderr.write(`${message}\n`),
      },
    );
  } finally {
    for (const watcher of watchers) {
      watcher.close();
    }
    termination.dispose();
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await runUsageEngineDevMain();
  } catch {
    process.stderr.write('Development usage engine supervisor failed.\n');
    process.exitCode = 1;
  }
}
