import { describe, expect, test } from 'bun:test';
import { collectionSourceDefinitions, type SourceControlView } from '@ai-usage/report-core/source-control';
import type {
  UsageEngineCommand,
  UsageEngineCommandCompletion,
  UsageEngineEvent,
  UsageEngineInstanceId,
  UsageEngineMergePreviewOutput,
} from '@ai-usage/usage-engine-control';
import {
  createInitialUsageEngineSourceControlView,
  createUsageEngineRuntime,
  UsageEngineCommandError,
  UsageEngineFatalConsistencyError,
  type UsageEngineMutationPort,
  type UsageEngineRuntimeDependencies,
  type UsageEngineSourceControlPort,
} from './runtime';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111' as UsageEngineInstanceId;
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = new Date('2026-07-29T12:00:00.000Z');

const publishedSourceControl = (generation = 1): SourceControlView => ({
  ...createInitialUsageEngineSourceControlView(INSTANCE_ID, FIXED_NOW),
  generatedAt: FIXED_NOW.toISOString(),
  generation,
  publication: {
    acknowledgedRequestGeneration: 1,
    dirty: false,
    dirtyGeneration: 1,
    lastDurationMs: 2,
    lastOutcome: 'success',
    lastPublishedAt: FIXED_NOW.toISOString(),
    pendingDemand: false,
    publishedGeneration: 1,
    queued: false,
    requestedGeneration: 1,
    revision: 'revision-a',
    rtkCompletedGeneration: 0,
    rtkRequiredGeneration: 0,
    running: false,
  },
});

interface TestSourceControl extends UsageEngineSourceControlPort {
  readonly calls: string[];
  readonly publishSnapshot: (snapshot: SourceControlView) => void;
}

const createTestSourceControl = (initial = publishedSourceControl()): TestSourceControl => {
  const calls: string[] = [];
  const listeners = new Set<(snapshot: SourceControlView) => void>();
  let snapshot = initial;
  return {
    calls,
    changes: (signal) => ({
      [Symbol.asyncIterator]: () => {
        const queue: SourceControlView[] = [];
        let pending: ((result: IteratorResult<SourceControlView>) => void) | undefined;
        const listener = (next: SourceControlView): void => {
          if (pending) {
            const resolve = pending;
            pending = undefined;
            resolve({ done: false, value: next });
            return;
          }
          queue.push(next);
        };
        listeners.add(listener);
        const close = (): void => {
          listeners.delete(listener);
          pending?.({ done: true, value: undefined });
          pending = undefined;
        };
        signal.addEventListener('abort', close, { once: true });
        return {
          next: () => {
            const next = queue.shift();
            if (next) {
              return Promise.resolve({ done: false as const, value: next });
            }
            if (signal.aborted) {
              return Promise.resolve({ done: true as const, value: undefined });
            }
            return new Promise<IteratorResult<SourceControlView>>((resolve) => {
              pending = resolve;
            });
          },
          return: () => {
            close();
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    }),
    detectAll: () => {
      calls.push('detect-all');
      return Promise.resolve();
    },
    dispose: () => {
      calls.push('source-dispose');
      return Promise.resolve();
    },
    publish: () => {
      calls.push('publish');
      return Promise.resolve();
    },
    publishSnapshot: (next) => {
      snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
    redetectAndRunSource: (sourceId) => {
      calls.push(`redetect-and-run:${sourceId}`);
      return Promise.resolve();
    },
    runAllEnabled: () => {
      calls.push('run-all-enabled');
      return Promise.resolve();
    },
    runSource: (sourceId) => {
      calls.push(`run-source:${sourceId}`);
      return Promise.resolve();
    },
    setSourceEnabled: (sourceId, enabled) => {
      calls.push(`set-source:${sourceId}:${enabled}`);
      return Promise.resolve();
    },
    start: () => {
      calls.push('source-start');
      return Promise.resolve(snapshot);
    },
    stopAutonomousCollection: () => {
      calls.push('source-admission-closed');
      return Promise.resolve();
    },
  };
};

const mergePreview: UsageEngineMergePreviewOutput = {
  bytes: 42,
  confirmationToken: 'confirmation-token',
  documentDigest: 'a'.repeat(64),
  kind: 'merge-preview',
  result: {
    deleted: 0,
    fleetChanged: false,
    inserted: 1,
    superseded: 0,
    unchanged: 0,
    updated: 0,
    warnings: 0,
  },
  rows: 1,
  warningCount: 0,
};

const createMutationPort = (calls: string[]): UsageEngineMutationPort => ({
  confirmMerge: () => {
    calls.push('confirm-merge');
    return Promise.resolve();
  },
  discardFileInput: (command) => {
    calls.push(`discard-${command.command}`);
    return Promise.resolve();
  },
  importCursor: () => {
    calls.push('import-cursor');
    return Promise.resolve();
  },
  previewMerge: () => {
    calls.push('preview-merge');
    return Promise.resolve(mergePreview);
  },
  replaceProjectAliases: () => {
    calls.push('replace-project-aliases');
    return Promise.resolve();
  },
  replaceProjectGroups: () => {
    calls.push('replace-project-groups');
    return Promise.resolve();
  },
  setMachineLabel: () => {
    calls.push('set-machine-label');
    return Promise.resolve();
  },
});

const createDependencies = (
  input: { sourceControl?: TestSourceControl; trace?: string[] } = {},
): UsageEngineRuntimeDependencies => {
  const trace = input.trace ?? [];
  return {
    acquireWriterLease: () => {
      trace.push('lock');
      return Promise.resolve({
        release: () => {
          trace.push('unlock');
          return Promise.resolve();
        },
      });
    },
    initializeStore: () => {
      trace.push('migrate');
      return Promise.resolve(14);
    },
    initialSourceControl: createInitialUsageEngineSourceControlView(INSTANCE_ID, FIXED_NOW),
    instanceId: INSTANCE_ID,
    mutation: createMutationPort(trace),
    now: () => FIXED_NOW,
    publishInitialRevision: () => {
      trace.push('initial-publication');
      return Promise.resolve({ publishedAt: FIXED_NOW.toISOString(), revision: 'revision-a' as never });
    },
    quiesceStore: () => {
      trace.push('quiesce');
      return Promise.resolve();
    },
    recover: () => {
      trace.push('recover');
      return Promise.resolve();
    },
    sourceControl: input.sourceControl ?? createTestSourceControl(),
    validateConfig: () => {
      trace.push('config');
      return Promise.resolve();
    },
  };
};

const nextCompletion = async (
  iterator: AsyncIterator<UsageEngineEvent>,
  commandId = COMMAND_ID,
): Promise<UsageEngineCommandCompletion> => {
  for (let index = 0; index < 10; index += 1) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    if (next.value.event === 'command-completed' && next.value.completion.commandId === commandId) {
      return next.value.completion;
    }
  }
  throw new Error(`No completion was emitted for ${commandId}`);
};

describe('usage engine runtime', () => {
  test('acquires one writer lease before migration and starts collection only after recovery and initial publication', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));

    await Promise.all([runtime.start(), runtime.start()]);

    expect(trace).toEqual(['lock', 'migrate', 'config', 'recover', 'initial-publication']);
    expect(sourceControl.calls).toEqual(['source-start']);
    expect(await runtime.status()).toMatchObject({
      currentPublication: { revision: 'revision-a' },
      readiness: 'ready',
      storeSchemaVersion: 14,
    });

    await Promise.all([runtime.dispose(), runtime.dispose()]);
    expect(sourceControl.calls).toEqual(['source-start', 'source-admission-closed', 'source-dispose']);
    expect(trace.slice(-2)).toEqual(['quiesce', 'unlock']);
  });

  test('serializes commands, coalesces a retried command ID, and emits bounded terminal completion', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));
    await runtime.start();
    const events = runtime.changes()[Symbol.asyncIterator]();
    const command: UsageEngineCommand = { command: 'set-machine-label', label: 'Workstation' };

    const accepted = await runtime.executeCommand(command, COMMAND_ID);
    const coalesced = await runtime.executeCommand(command, COMMAND_ID);
    const completion = await nextCompletion(events);

    expect(accepted).toMatchObject({ admission: 'accepted', commandId: COMMAND_ID, ok: true });
    expect(coalesced).toMatchObject({ admission: 'coalesced', commandId: COMMAND_ID, ok: true });
    expect(completion).toMatchObject({ command: 'set-machine-label', state: 'succeeded' });
    expect(trace.filter((entry) => entry === 'set-machine-label')).toHaveLength(1);
    expect(sourceControl.calls.filter((entry) => entry === 'publish')).toHaveLength(1);
    expect(await runtime.waitForCommand(COMMAND_ID)).toEqual(completion);

    await events.return?.();
    await runtime.dispose();
  });

  test('cleans a distinct incoming handoff rejected by a conflicting command ID', async () => {
    const trace: string[] = [];
    const runtime = createUsageEngineRuntime(createDependencies({ trace }));
    await runtime.start();
    await runtime.executeCommand({ command: 'publish' }, COMMAND_ID);
    await runtime.waitForCommand(COMMAND_ID);

    const rejected = await runtime.executeCommand(
      {
        command: 'import-cursor',
        input: { handoffId: 'conflicting-command-upload' as never, kind: 'inbox-handoff' },
      },
      COMMAND_ID,
    );
    await runtime.dispose();

    expect(rejected).toMatchObject({ error: { code: 'command-rejected' }, ok: false });
    expect(trace).toContain('discard-import-cursor');
  });

  test('does not publish success when shutdown aborts a non-cooperative preview port', async () => {
    let releasePreview: (() => void) | undefined;
    let signalPreviewStarted: (() => void) | undefined;
    const previewStarted = new Promise<void>((resolve) => {
      signalPreviewStarted = resolve;
    });
    const previewBlocked = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    const dependencies = createDependencies();
    const runtime = createUsageEngineRuntime({
      ...dependencies,
      mutation: {
        ...dependencies.mutation,
        previewMerge: async () => {
          signalPreviewStarted?.();
          await previewBlocked;
          return mergePreview;
        },
      },
    });
    await runtime.start();
    await runtime.executeCommand(
      {
        command: 'preview-merge',
        input: { handoffId: 'active-preview-upload' as never, kind: 'inbox-handoff' },
      },
      'active-preview',
    );
    await previewStarted;

    const disposal = runtime.dispose();
    releasePreview?.();
    const completion = await runtime.waitForCommand('active-preview');
    await disposal;

    expect(completion).toMatchObject({ error: { code: 'aborted' }, state: 'failed' });
  });

  test('preserves queued command completions when disposal aborts admission', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const trace: string[] = [];
    const baseSourceControl = createTestSourceControl();
    const sourceControl: TestSourceControl = {
      ...baseSourceControl,
      detectAll: async () => {
        trace.push('detect-all');
        await firstBlocked;
      },
    };
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));
    await runtime.start();
    await runtime.executeCommand({ command: 'detect-all' }, 'command-active');
    await runtime.executeCommand({ command: 'publish' }, 'command-queued');

    const disposal = runtime.dispose();
    const queued = await runtime.waitForCommand('command-queued');
    releaseFirst?.();
    await disposal;

    expect(queued).toMatchObject({ commandId: 'command-queued', error: { code: 'aborted' }, state: 'failed' });
  });

  test('aborts an active manual collection during first-phase shutdown', async () => {
    let releaseCollection: (() => void) | undefined;
    let signalCollectionStarted: (() => void) | undefined;
    const collectionStarted = new Promise<void>((resolve) => {
      signalCollectionStarted = resolve;
    });
    const collectionBlocked = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    let observedAbort = false;
    const baseSourceControl = createTestSourceControl();
    const sourceControl: TestSourceControl = {
      ...baseSourceControl,
      runSource: async (sourceId, signal) => {
        baseSourceControl.calls.push(`run-source:${sourceId}`);
        signalCollectionStarted?.();
        await Promise.race([
          collectionBlocked,
          new Promise<void>((_resolve, reject) => {
            const onAbort = (): void => {
              observedAbort = true;
              reject(Object.assign(new Error('collection aborted'), { name: 'AbortError' }));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      },
    };
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl }));
    await runtime.start();
    await runtime.executeCommand({ command: 'run-source', sourceId: 'claude.sessions' }, 'active-collection');
    await collectionStarted;

    const disposal = runtime.dispose();
    const outcome = await Promise.race([
      disposal.then(() => 'completed' as const),
      Bun.sleep(25).then(() => 'timed-out' as const),
    ]);
    if (outcome === 'timed-out') {
      releaseCollection?.();
      await disposal;
    }
    const completion = await runtime.waitForCommand('active-collection');

    expect(outcome).toBe('completed');
    expect(observedAbort).toBe(true);
    expect(completion).toMatchObject({ error: { code: 'aborted' }, state: 'failed' });
  });

  test('lets an admitted durable mutation reach its required publication before shutdown', async () => {
    let releaseMutation: (() => void) | undefined;
    let signalMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      signalMutationStarted = resolve;
    });
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const trace: string[] = [];
    const baseSourceControl = createTestSourceControl();
    const sourceControl: TestSourceControl = {
      ...baseSourceControl,
      stopAutonomousCollection: () => {
        baseSourceControl.calls.push('source-admission-closed');
        return Promise.resolve();
      },
    };
    const dependencies = createDependencies({ sourceControl, trace });
    const runtime = createUsageEngineRuntime({
      ...dependencies,
      mutation: {
        ...dependencies.mutation,
        confirmMerge: async (_command, signal) => {
          trace.push('merge-committed');
          signalMutationStarted?.();
          await mutationBlocked;
          if (signal?.aborted) {
            throw new Error('mutation publication chain was interrupted');
          }
          trace.push('handoff-cleanup-complete');
        },
      },
    });
    await runtime.start();
    await runtime.executeCommand(
      {
        command: 'confirm-merge',
        confirmationToken: 'confirmation-token',
        documentDigest: 'a'.repeat(64),
        input: { filePath: '/synthetic/merge.json', kind: 'operator-file' },
      },
      'durable-command',
    );
    await mutationStarted;
    await runtime.executeCommand(
      {
        command: 'import-cursor',
        input: { handoffId: 'queued-shutdown-upload' as never, kind: 'inbox-handoff' },
      },
      'queued-shutdown-upload',
    );

    const disposal = runtime.dispose();
    await Promise.resolve();
    expect(sourceControl.calls).toContain('source-admission-closed');
    expect(sourceControl.calls).not.toContain('publish');
    releaseMutation?.();
    const completion = await runtime.waitForCommand('durable-command');
    const queuedCompletion = await runtime.waitForCommand('queued-shutdown-upload');
    await disposal;

    expect(completion.state).toBe('succeeded');
    expect(queuedCompletion).toMatchObject({ error: { code: 'aborted' }, state: 'failed' });
    expect(trace).toContain('discard-import-cursor');
    expect(sourceControl.calls).toContain('publish');
    expect(trace.indexOf('handoff-cleanup-complete')).toBeLessThan(trace.indexOf('quiesce'));
    expect(trace.at(-1)).toBe('unlock');
  });

  test('degrades terminally and stops autonomous writers after unreconciled mutation compensation', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const dependencies = createDependencies({ sourceControl, trace });
    const runtime = createUsageEngineRuntime({
      ...dependencies,
      mutation: {
        ...dependencies.mutation,
        setMachineLabel: () =>
          Promise.reject(
            new UsageEngineFatalConsistencyError(
              [new Error('config write failed'), new Error('database rollback failed')],
              'Machine state could not be reconciled.',
            ),
          ),
      },
    });
    await runtime.start();
    const fatalAdmission = runtime.executeCommand(
      { command: 'set-machine-label', label: 'New Label' },
      'fatal-command',
    );
    const queuedAdmission = runtime.executeCommand(
      { command: 'replace-project-aliases', projectAliases: [] },
      'queued-after-fatal',
    );
    const queuedUploadAdmission = runtime.executeCommand(
      {
        command: 'import-cursor',
        input: { handoffId: 'queued-fatal-upload' as never, kind: 'inbox-handoff' },
      },
      'queued-upload-after-fatal',
    );
    await Promise.all([fatalAdmission, queuedAdmission, queuedUploadAdmission]);

    const completion = await runtime.waitForCommand('fatal-command');
    const queuedCompletion = await runtime.waitForCommand('queued-after-fatal');
    const queuedUploadCompletion = await runtime.waitForCommand('queued-upload-after-fatal');
    const status = await runtime.status();
    const rejected = await runtime.executeCommand({ command: 'publish' }, 'after-fatal');

    expect(completion.state).toBe('failed');
    expect(status).toMatchObject({
      degradedReason: { code: 'mutation-consistency-unknown' },
      readiness: 'degraded',
    });
    expect(sourceControl.calls).toContain('source-admission-closed');
    expect(queuedCompletion).toMatchObject({ error: { code: 'engine-busy' }, state: 'failed' });
    expect(queuedUploadCompletion).toMatchObject({ error: { code: 'engine-busy' }, state: 'failed' });
    expect(trace).toContain('discard-import-cursor');
    expect(trace).not.toContain('replace-project-aliases');
    expect(rejected).toMatchObject({ error: { code: 'engine-busy' }, ok: false });
    await runtime.disposeRetainingWriterLease();
    expect(trace).not.toContain('unlock');
  });

  test('preserves a stale merge confirmation as a typed terminal completion', async () => {
    const trace: string[] = [];
    const dependencies = createDependencies({ trace });
    const runtime = createUsageEngineRuntime({
      ...dependencies,
      mutation: {
        ...dependencies.mutation,
        confirmMerge: () =>
          Promise.reject(
            new UsageEngineCommandError('preview-stale', 'The merge file changed after it was previewed.'),
          ),
      },
    });
    await runtime.start();
    await runtime.executeCommand(
      {
        command: 'confirm-merge',
        confirmationToken: 'confirmation-token',
        documentDigest: 'a'.repeat(64),
        input: { filePath: '/synthetic/merge.json', kind: 'operator-file' },
      },
      'stale-confirmation',
    );

    const completion = await runtime.waitForCommand('stale-confirmation');

    expect(completion).toMatchObject({
      error: { code: 'preview-stale', message: 'The merge file changed after it was previewed.' },
      state: 'failed',
    });
    await runtime.dispose();
  });

  test('routes every command family without returning report data through command admission', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));
    await runtime.start();
    const commands: UsageEngineCommand[] = [
      { command: 'detect-all' },
      { command: 'run-all-enabled' },
      { command: 'run-source', sourceId: 'codex.sessions' },
      { command: 'publish' },
      { command: 'set-source-enabled', enabled: false, sourceId: 'claude.sessions' },
      { command: 'replace-project-aliases', projectAliases: [] },
      { command: 'replace-project-groups', projectGroups: [] },
      { command: 'collect-fresh-quota' },
      { command: 'import-cursor', input: { filePath: '/synthetic/cursor.csv', kind: 'operator-file' } },
      { command: 'preview-merge', input: { filePath: '/synthetic/merge.json', kind: 'operator-file' } },
      {
        command: 'confirm-merge',
        confirmationToken: 'confirmation-token',
        documentDigest: 'a'.repeat(64),
        input: { filePath: '/synthetic/merge.json', kind: 'operator-file' },
      },
    ];

    for (const [index, command] of commands.entries()) {
      const result = await runtime.executeCommand(command, `command-${index}`);
      expect(result).toMatchObject({ ok: true });
    }
    await runtime.waitForIdle();

    expect(sourceControl.calls).toEqual([
      'source-start',
      'detect-all',
      'run-all-enabled',
      'run-source:codex.sessions',
      'publish',
      'set-source:claude.sessions:false',
      'publish',
      'publish',
      'run-source:codex.usage-limits',
      'redetect-and-run:cursor.sessions',
      'publish',
    ]);
    expect(trace).toContain('replace-project-groups');
    expect(trace).toContain('replace-project-aliases');
    expect(trace).toContain('import-cursor');
    expect(trace).toContain('preview-merge');
    expect(trace).toContain('confirm-merge');
    await runtime.dispose();
  });

  test('publishes source changes with engine identity and stops admitting collection after disposal', async () => {
    const sourceControl = createTestSourceControl();
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl }));
    await runtime.start();
    const events = runtime.changes()[Symbol.asyncIterator]();

    sourceControl.publishSnapshot(publishedSourceControl(2));
    const event = await events.next();
    expect(event.value).toMatchObject({ event: 'source-control', instanceId: INSTANCE_ID });

    await runtime.dispose();
    const rejected = await runtime.execute({ command: 'run-source', sourceId: collectionSourceDefinitions[0]!.id });
    expect(rejected).toMatchObject({ error: { code: 'engine-busy' }, ok: false });
    expect(sourceControl.calls.filter((entry) => entry.startsWith('run-source'))).toHaveLength(0);
  });

  test('emits authoritative ready and stopping status transitions', async () => {
    const runtime = createUsageEngineRuntime(createDependencies());
    const events = runtime.changes()[Symbol.asyncIterator]();

    await runtime.start();
    expect(await events.next()).toMatchObject({
      value: { event: 'status', status: { readiness: 'ready' } },
    });

    const disposal = runtime.dispose();
    expect(await events.next()).toMatchObject({
      value: { event: 'status', status: { readiness: 'stopping' } },
    });
    await disposal;
  });

  test('releases the writer lease when startup fails before collection begins', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const dependencies: UsageEngineRuntimeDependencies = {
      ...createDependencies({ sourceControl, trace }),
      validateConfig: () => {
        trace.push('config');
        return Promise.reject(new Error('invalid config'));
      },
    };
    const runtime = createUsageEngineRuntime(dependencies);

    await expect(runtime.start()).rejects.toThrow('invalid config');

    expect(trace).toEqual(['lock', 'migrate', 'config', 'quiesce', 'unlock']);
    expect(sourceControl.calls).toEqual([]);
  });

  test('stops a source runtime and quiesces the store before unlocking after late startup failure', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl({
      ...publishedSourceControl(),
      instanceId: '33333333-3333-4333-8333-333333333333',
    });
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));

    await expect(runtime.start()).rejects.toThrow('another instance identity');

    expect(sourceControl.calls).toEqual(['source-start', 'source-admission-closed', 'source-dispose']);
    expect(trace).toEqual(['lock', 'migrate', 'config', 'recover', 'initial-publication', 'quiesce', 'unlock']);
  });

  test('retains the writer lease when source shutdown cannot be proven', async () => {
    const trace: string[] = [];
    const baseSourceControl = createTestSourceControl();
    const sourceControl: TestSourceControl = {
      ...baseSourceControl,
      dispose: () => {
        sourceControl.calls.push('source-dispose');
        return Promise.reject(new Error('source shutdown failed'));
      },
    };
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));
    await runtime.start();

    await expect(runtime.dispose()).rejects.toThrow('could not safely release its writer lease');

    expect(sourceControl.calls).toContain('source-dispose');
    expect(trace).toContain('quiesce');
    expect(trace).not.toContain('unlock');
  });

  test('retains the writer lease when store quiescence cannot be proven', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const dependencies: UsageEngineRuntimeDependencies = {
      ...createDependencies({ sourceControl, trace }),
      quiesceStore: () => {
        trace.push('quiesce');
        return Promise.reject(new Error('store quiescence failed'));
      },
    };
    const runtime = createUsageEngineRuntime(dependencies);
    await runtime.start();

    await expect(runtime.dispose()).rejects.toThrow('could not safely release its writer lease');

    expect(sourceControl.calls).toContain('source-dispose');
    expect(trace).toContain('quiesce');
    expect(trace).not.toContain('unlock');
  });

  test('can quiesce owned resources while deliberately retaining the writer lease', async () => {
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const runtime = createUsageEngineRuntime(createDependencies({ sourceControl, trace }));
    await runtime.start();

    await runtime.disposeRetainingWriterLease();

    expect(sourceControl.calls).toContain('source-dispose');
    expect(trace).toContain('quiesce');
    expect(trace).not.toContain('unlock');
  });

  test('unwinds startup when disposal wins a lifecycle race', async () => {
    let releaseMigration: (() => void) | undefined;
    let signalMigrationStarted: (() => void) | undefined;
    const migrationStarted = new Promise<void>((resolve) => {
      signalMigrationStarted = resolve;
    });
    const migrationBlocked = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const trace: string[] = [];
    const sourceControl = createTestSourceControl();
    const dependencies: UsageEngineRuntimeDependencies = {
      ...createDependencies({ sourceControl, trace }),
      initializeStore: async () => {
        trace.push('migrate');
        signalMigrationStarted?.();
        await migrationBlocked;
        return 14;
      },
    };
    const runtime = createUsageEngineRuntime(dependencies);

    const startup = runtime.start();
    await migrationStarted;
    const disposal = runtime.dispose();
    releaseMigration?.();

    await expect(startup).rejects.toThrow('Usage engine startup was aborted.');
    await disposal;

    expect(trace).toEqual(['lock', 'migrate', 'quiesce', 'unlock']);
    expect(sourceControl.calls).toEqual([]);
    expect(await runtime.status()).toMatchObject({ readiness: 'stopping' });
    await expect(runtime.start()).rejects.toThrow('Usage engine startup was aborted.');
  });
});
