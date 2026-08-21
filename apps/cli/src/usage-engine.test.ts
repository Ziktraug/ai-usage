import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectionSourceDefinitions } from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineCommandCompletion,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineStatus,
} from '@ai-usage/usage-engine-control';
import { type UsageEngineControlClient, UsageEngineControlError } from '@ai-usage/usage-engine-control/client';
import { usageEngineTargetIdFor } from '@ai-usage/usage-engine-control/node';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import { type CliUsageEngineExecution, createCliUsageEngine, createLiveCliUsageEngine } from './usage-engine';
import type { CliUsagePaths } from './usage-paths';

const status = {
  currentPublication: { publishedAt: '2026-07-30T10:00:00.000Z', revision: 'revision-a' },
  instanceId: 'engine-a',
  readiness: 'ready',
  storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
} as UsageEngineStatus;

const control = {
  getStatus: () => Promise.resolve(status),
} as UsageEngineControlClient;

const execution = (mode: CliUsageEngineExecution['mode']): CliUsageEngineExecution => ({
  completion: parseUsageEngineCommandCompletion({
    command: 'publish',
    commandId: 'command-a',
    completedAt: '2026-07-30T10:00:01.000Z',
    output: {
      kind: 'publication',
      publication: {
        publishedAt: '2026-07-30T10:00:00.000Z',
        revision: 'revision-a',
      },
    },
    state: 'succeeded',
  }),
  mode,
});

test('uses a valid daemon and never launches a second writer', async () => {
  let foregroundCalls = 0;
  const engine = createCliUsageEngine({
    executeDaemon: () => Promise.resolve(execution('daemon')),
    launchForeground: () => {
      foregroundCalls += 1;
      return Promise.resolve(execution('foreground'));
    },
    resolveDaemon: () => Promise.resolve({ control, kind: 'available' }),
  });

  expect((await engine.execute({ command: 'publish' })).mode).toBe('daemon');
  expect(foregroundCalls).toBe(0);
});

test('uses foreground only when no daemon is initially available', async () => {
  const engine = createCliUsageEngine({
    executeDaemon: () => Promise.reject(new Error('daemon should not execute')),
    launchForeground: () => Promise.resolve(execution('foreground')),
    resolveDaemon: () => Promise.resolve({ kind: 'absent' }),
  });

  expect((await engine.execute({ command: 'publish' })).mode).toBe('foreground');
});

test('fails a mismatched live daemon without a foreground fallback', async () => {
  let foregroundCalls = 0;
  const mismatched = {
    ...control,
    getStatus: () => Promise.reject(new UsageEngineControlError('protocol-mismatch', 'status', 'synthetic mismatch')),
  } as UsageEngineControlClient;
  const engine = createCliUsageEngine({
    executeDaemon: () => Promise.reject(new Error('daemon should not execute')),
    launchForeground: () => {
      foregroundCalls += 1;
      return Promise.resolve(execution('foreground'));
    },
    resolveDaemon: () => Promise.resolve({ control: mismatched, kind: 'available' }),
  });

  await expect(engine.execute({ command: 'publish' })).rejects.toMatchObject({ code: 'protocol-mismatch' });
  expect(foregroundCalls).toBe(0);
});

test('recovers a stale valid rendezvous through the foreground writer lock', async () => {
  const stale = {
    ...control,
    getStatus: () => Promise.reject(new UsageEngineControlError('transport-failed', 'status', 'stale endpoint')),
  } as UsageEngineControlClient;
  const engine = createCliUsageEngine({
    executeDaemon: () => Promise.reject(new Error('daemon should not execute')),
    launchForeground: () => Promise.resolve(execution('foreground')),
    resolveDaemon: () => Promise.resolve({ control: stale, kind: 'available' }),
  });

  expect((await engine.execute({ command: 'publish' })).mode).toBe('foreground');
});

const createForegroundFixture = async (): Promise<{
  readonly paths: CliUsagePaths;
  readonly root: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-cli-foreground-'));
  const homeDirectory = path.join(root, 'home');
  const stateDirectory = path.join(root, 'state');
  const temporaryRoot = path.join(root, 'tmp');
  await Promise.all([
    mkdir(homeDirectory, { mode: 0o700, recursive: true }),
    mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
  ]);
  return {
    paths: {
      configCwd: root,
      databasePath: path.join(root, 'store', 'usage.sqlite'),
      homeDirectory,
      operatorCwd: root,
      stateDirectory,
      temporaryRoot,
    },
    root,
  };
};

const foregroundStatus = {
  currentPublication: { publishedAt: '2026-07-30T10:00:00.000Z', revision: 'revision-a' },
  degradedReason: null,
  generatedAt: '2026-07-30T10:00:01.000Z',
  generation: 0,
  instanceId: '11111111-1111-4111-8111-111111111111',
  protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  readiness: 'ready',
  sourceControl: {
    generatedAt: '2026-07-30T10:00:01.000Z',
    generation: 0,
    instanceId: '11111111-1111-4111-8111-111111111111',
    publication: {
      acknowledgedRequestGeneration: 0,
      dirty: false,
      dirtyGeneration: 0,
      lastOutcome: 'success',
      lastPublishedAt: '2026-07-30T10:00:00.000Z',
      pendingDemand: false,
      publishedGeneration: 0,
      queued: false,
      requestedGeneration: 0,
      revision: 'revision-a',
      rtkCompletedGeneration: 0,
      rtkRequiredGeneration: 0,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map((definition) => ({
      availability: 'not-detected',
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: 'not-run',
      lifecycle: 'dormant',
      policy: definition.defaultEnabled ? 'enabled' : 'disabled',
      reason: { code: definition.defaultEnabled ? 'input-missing' : 'policy-disabled' },
      warnings: [],
    })),
  },
  storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
} as const;

test('fails closed when a rendezvous targets another database or config root', async () => {
  const fixture = await createForegroundFixture();
  try {
    await mkdir(fixture.paths.stateDirectory, { mode: 0o700 });
    await writeFile(
      path.join(fixture.paths.stateDirectory, 'rendezvous.json'),
      `${JSON.stringify({
        instanceId: '11111111-1111-4111-8111-111111111111',
        port: 41_052,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
        targetId: usageEngineTargetIdFor(fixture.paths),
        token: 'fixture-token-with-at-least-thirty-two-bytes',
      })}\n`,
      { mode: 0o600 },
    );

    for (const paths of [
      { ...fixture.paths, databasePath: `${fixture.paths.databasePath}.other` },
      { ...fixture.paths, configCwd: path.join(fixture.root, 'other-config') },
    ]) {
      const engine = createLiveCliUsageEngine({
        engineEntrypoint: path.join(fixture.root, 'must-not-start.ts'),
        paths,
      });
      await expect(engine.execute({ command: 'publish' })).rejects.toMatchObject({
        code: 'protocol-mismatch',
        message: 'Usage engine target mismatch.',
      });
    }
    await expect(Bun.file(path.join(fixture.root, 'must-not-start.ts')).exists()).resolves.toBe(false);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test('bounds foreground cancellation and reaps a child that ignores graceful signals', async () => {
  const fixture = await createForegroundFixture();
  const entrypoint = path.join(fixture.root, 'non-cooperative-engine.ts');
  const pidPath = path.join(fixture.root, 'foreground.pid');
  await writeFile(
    entrypoint,
    `
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => undefined, 1000);
`,
  );
  const controller = new AbortController();
  const engine = createLiveCliUsageEngine({
    engineEntrypoint: entrypoint,
    foregroundTerminationGraceMs: 10,
    paths: fixture.paths,
    writeDiagnostics: () => Promise.resolve(),
  });
  const execution = engine.execute({ command: 'publish' }, { signal: controller.signal });
  let pid: number | undefined;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await Bun.file(pidPath).exists()) {
        pid = Number(await Bun.file(pidPath).text());
        break;
      }
      await Bun.sleep(5);
    }
    if (pid === undefined || !Number.isSafeInteger(pid)) {
      throw new Error('Foreground child did not publish its isolated PID fixture.');
    }
    const childPid = pid;

    controller.abort();
    const outcome = await Promise.race([
      execution.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ error, kind: 'rejected' as const }),
      ),
      Bun.sleep(500).then(() => ({ kind: 'timed-out' as const })),
    ]);
    if (outcome.kind === 'timed-out') {
      process.kill(childPid, 'SIGKILL');
      await execution.catch(() => undefined);
    }
    expect(outcome).toMatchObject({ error: { code: 'aborted' }, kind: 'rejected' });

    let childAlive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(childPid, 0);
      } catch {
        childAlive = false;
        break;
      }
      await Bun.sleep(5);
    }
    expect(childAlive).toBe(false);

    await writeFile(
      entrypoint,
      `
const request = JSON.parse(Bun.argv.at(-1) ?? '{}');
process.stdout.write(JSON.stringify({
  completion: {
    command: request.command.command,
    commandId: request.commandId,
    completedAt: '2026-07-30T10:00:02.000Z',
    output: {
      kind: 'publication',
      publication: { publishedAt: '2026-07-30T10:00:00.000Z', revision: 'revision-a' },
    },
    state: 'succeeded',
  },
  instanceId: ${JSON.stringify(foregroundStatus.instanceId)},
  kind: 'command-completed',
  protocolVersion: ${USAGE_ENGINE_PROTOCOL_VERSION},
  status: ${JSON.stringify(foregroundStatus)},
}));
`,
    );
    expect((await engine.execute({ command: 'publish' })).mode).toBe('foreground');
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The expected path already reaped the isolated fixture process.
      }
    }
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test('times out and reaps a foreground command that never completes', async () => {
  const fixture = await createForegroundFixture();
  const entrypoint = path.join(fixture.root, 'stalled-engine.ts');
  const pidPath = path.join(fixture.root, 'stalled.pid');
  await writeFile(
    entrypoint,
    `
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => undefined, 1000);
`,
  );
  const engine = createLiveCliUsageEngine({
    engineEntrypoint: entrypoint,
    foregroundDeadlineMs: 20,
    foregroundTerminationGraceMs: 10,
    paths: fixture.paths,
    writeDiagnostics: () => Promise.resolve(),
  });
  let childPid: number | undefined;
  try {
    const outcome = engine.execute({ command: 'publish' });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await Bun.file(pidPath).exists()) {
        childPid = Number(await Bun.file(pidPath).text());
        break;
      }
      await Bun.sleep(5);
    }
    expect(childPid).toBeInteger();
    await expect(outcome).rejects.toMatchObject({ code: 'timeout' });

    let childAlive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(childPid!, 0);
      } catch {
        childAlive = false;
        break;
      }
      await Bun.sleep(5);
    }
    expect(childAlive).toBe(false);
  } finally {
    if (childPid !== undefined) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // The deadline path already reaped the isolated fixture process.
      }
    }
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test('drains large foreground diagnostics before accepting the bounded control outcome', async () => {
  const fixture = await createForegroundFixture();
  const entrypoint = path.join(fixture.root, 'fake-engine.ts');
  const diagnosticBytes = 1024 * 1024 + 17;
  const script = `
const request = JSON.parse(Bun.argv.at(-1) ?? '{}');
await new Promise((resolve, reject) => {
  process.stderr.write('x'.repeat(${diagnosticBytes}), (error) => error ? reject(error) : resolve());
});
process.stdout.write(JSON.stringify({
  completion: {
    command: request.command.command,
    commandId: request.commandId,
    completedAt: '2026-07-30T10:00:02.000Z',
    output: {
      kind: 'publication',
      publication: {
        publishedAt: '2026-07-30T10:00:00.000Z',
        revision: 'revision-a',
      },
    },
    state: 'succeeded',
  },
  instanceId: ${JSON.stringify(foregroundStatus.instanceId)},
  kind: 'command-completed',
  protocolVersion: ${USAGE_ENGINE_PROTOCOL_VERSION},
  status: ${JSON.stringify(foregroundStatus)},
}));
`;
  await writeFile(entrypoint, script);
  let drainedBytes = 0;
  try {
    const engine = createLiveCliUsageEngine({
      engineEntrypoint: entrypoint,
      paths: fixture.paths,
      writeDiagnostics: (bytes) => {
        drainedBytes += bytes.byteLength;
        return Promise.resolve();
      },
    });

    expect((await engine.execute({ command: 'publish' })).mode).toBe('foreground');
    expect(drainedBytes).toBe(diagnosticBytes);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test('maps a foreground process crash without a control outcome to engine unavailable', async () => {
  const fixture = await createForegroundFixture();
  const entrypoint = path.join(fixture.root, 'failed-engine.ts');
  await writeFile(entrypoint, "process.stderr.write('synthetic engine failure\\n');\nprocess.exit(7);\n");
  let diagnostics = '';
  try {
    const engine = createLiveCliUsageEngine({
      engineEntrypoint: entrypoint,
      paths: fixture.paths,
      writeDiagnostics: (bytes) => {
        diagnostics += new TextDecoder().decode(bytes);
        return Promise.resolve();
      },
    });

    await expect(engine.execute({ command: 'publish' })).rejects.toMatchObject({ code: 'engine-unavailable' });
    expect(diagnostics).toBe('synthetic engine failure\n');
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
