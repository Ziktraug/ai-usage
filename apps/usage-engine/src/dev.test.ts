import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createUsageEngineDevChanges,
  createUsageEngineDevTermination,
  createUsageEngineDevWatchTargets,
  superviseUsageEngineDevelopment,
  type UsageEngineDevChild,
} from './dev';

const never = new Promise<never>(() => undefined);
const TEST_DEADLINE_MS = 500;

class FixtureChild implements UsageEngineDevChild {
  readonly exited: Promise<number>;
  readonly observedSignals: NodeJS.Signals[] = [];
  readonly pid: number;
  exitCode: number | null = null;
  private finish: ((exitCode: number) => void) | undefined;
  private groupAlive = true;

  constructor(pid: number) {
    this.pid = pid;
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  complete(exitCode: number, groupAlive = false): void {
    this.exitCode = exitCode;
    this.groupAlive = groupAlive;
    this.finish?.(exitCode);
  }

  stopGroup(): void {
    this.groupAlive = false;
  }

  isAlive(): boolean {
    return this.groupAlive;
  }

  signal(signal: NodeJS.Signals): void {
    this.observedSignals.push(signal);
  }
}

const waitFor = async (predicate: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + TEST_DEADLINE_MS;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(1);
  }
  return predicate();
};

describe('development usage engine supervisor', () => {
  test('keeps signal ownership until detached child cleanup completes', async () => {
    const emitter = new EventEmitter();
    const termination = createUsageEngineDevTermination(emitter);

    emitter.emit('SIGINT');
    expect(await termination.signal).toBe('SIGINT');
    expect(emitter.listenerCount('SIGINT')).toBe(1);
    expect(emitter.listenerCount('SIGTERM')).toBe(1);

    emitter.emit('SIGTERM');
    expect(await termination.signal).toBe('SIGINT');
    expect(emitter.listenerCount('SIGINT')).toBe(1);
    expect(emitter.listenerCount('SIGTERM')).toBe(1);

    termination.dispose();
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  test('fully stops and reaps the previous engine before spawning its replacement', async () => {
    const changes = createUsageEngineDevChanges();
    const first = new FixtureChild(5101);
    const second = new FixtureChild(5102);
    const children = [first, second];
    let spawnCount = 0;
    const running = superviseUsageEngineDevelopment(
      { changes, termination: never },
      {
        spawn: () => {
          const child = children[spawnCount];
          spawnCount += 1;
          if (!child) {
            throw new Error('Unexpected fixture spawn.');
          }
          return child;
        },
        wait: (milliseconds) => Bun.sleep(milliseconds),
        writeDiagnostic: () => undefined,
      },
    );

    changes.notify();
    expect(await waitFor(() => first.observedSignals.length > 0)).toBe(true);
    expect(first.observedSignals).toEqual(['SIGTERM']);
    expect(spawnCount).toBe(1);
    first.complete(143);
    expect(await waitFor(() => spawnCount === 2)).toBe(true);
    second.complete(9);
    expect(await running).toBe(9);
  });

  test('forwards termination and reports the signal exit code after cleanup', async () => {
    const child = new FixtureChild(5201);
    let terminate: ((signal: NodeJS.Signals) => void) | undefined;
    const termination = new Promise<NodeJS.Signals>((resolve) => {
      terminate = resolve;
    });
    const running = superviseUsageEngineDevelopment(
      { changes: createUsageEngineDevChanges(), termination },
      {
        spawn: () => child,
        wait: (milliseconds) => Bun.sleep(milliseconds),
        writeDiagnostic: () => undefined,
      },
    );

    terminate?.('SIGINT');
    expect(await waitFor(() => child.observedSignals.length > 0)).toBe(true);
    expect(child.observedSignals).toEqual(['SIGTERM']);
    child.complete(143);
    expect(await running).toBe(130);
  });

  test('reaps surviving descendants after the direct engine process exits', async () => {
    const child = new FixtureChild(5301);
    const diagnostics: string[] = [];
    const running = superviseUsageEngineDevelopment(
      { changes: createUsageEngineDevChanges(), termination: never },
      {
        spawn: () => child,
        wait: (milliseconds) => Bun.sleep(milliseconds),
        writeDiagnostic: (message) => diagnostics.push(message),
      },
    );

    child.complete(7, true);
    expect(await waitFor(() => child.observedSignals.length > 0)).toBe(true);
    expect(child.observedSignals).toEqual(['SIGTERM']);
    child.stopGroup();
    expect(await running).toBe(7);
    expect(diagnostics).toEqual(['Development usage engine exited with code 7.']);
  });

  test('watches the engine production closure without Web-only packages', () => {
    const repositoryRoot = path.resolve('/fixture/repository');
    const targets = createUsageEngineDevWatchTargets(path.join(repositoryRoot, 'apps', 'usage-engine'));
    const relativePaths = targets.map((target) => path.relative(repositoryRoot, target.path));
    const rootFileTarget = targets.find((target) => target.path === repositoryRoot);

    expect(relativePaths).toContain(path.join('apps', 'usage-engine', 'src'));
    expect(relativePaths).toContain(path.join('packages', 'usage-engine-runtime', 'src'));
    expect(relativePaths).toContain(path.join('packages', 'usage-store', 'src'));
    expect(relativePaths).not.toContain(path.join('apps', 'web', 'src'));
    expect(relativePaths).not.toContain(path.join('packages', 'design-system', 'src'));
    expect(rootFileTarget?.entryName).toBe('bun.lock');
  });
});

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('development usage engine process', () => {
  /**
   * The supervisor can die without running its graceful stop (`turbo watch`
   * killing its task outright, an OOM kill). The engine is in its own process
   * group, so nothing else reaches it: it must notice its parent is gone and
   * exit instead of holding the writer lock and the task's output open.
   */
  test('the engine exits when its supervisor is killed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'usage-engine-dev-orphan-'));
    const childPidPath = path.join(root, 'engine.pid');
    let childPid: number | undefined;
    try {
      // A stand-in engine directory: `src/main.ts` publishes its PID and idles.
      const engineDirectory = path.join(root, 'engine');
      await mkdir(path.join(engineDirectory, 'src'), { recursive: true });
      await writeFile(
        path.join(engineDirectory, 'src', 'main.ts'),
        `await Bun.write(${JSON.stringify(childPidPath)}, String(process.pid));\nsetInterval(() => undefined, 1000);\n`,
      );
      const supervisorPath = path.join(root, 'supervisor.ts');
      await writeFile(
        supervisorPath,
        `import { spawnUsageEngineDevChild } from ${JSON.stringify(path.join(import.meta.dir, 'dev.ts'))};\nspawnUsageEngineDevChild(${JSON.stringify(engineDirectory)});\nsetInterval(() => undefined, 1000);\n`,
      );
      const supervisor = Bun.spawn([process.execPath, '--no-env-file', supervisorPath], {
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'ignore',
      });
      const publishDeadline = Date.now() + 10_000;
      while (childPid === undefined && Date.now() < publishDeadline) {
        if (await Bun.file(childPidPath).exists()) {
          const text = await Bun.file(childPidPath).text();
          childPid = text === '' ? undefined : Number(text);
        }
        await Bun.sleep(10);
      }
      if (childPid === undefined) {
        throw new Error('The stand-in engine did not publish its PID.');
      }
      // Alive under a live supervisor: the parent-death watch does not fire early.
      await Bun.sleep(200);
      expect(processIsAlive(childPid)).toBe(true);

      supervisor.kill('SIGKILL');
      await supervisor.exited;
      const exitDeadline = Date.now() + 5000;
      while (processIsAlive(childPid) && Date.now() < exitDeadline) {
        await Bun.sleep(10);
      }
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      if (childPid !== undefined && processIsAlive(childPid)) {
        process.kill(childPid, 'SIGKILL');
      }
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);
});
