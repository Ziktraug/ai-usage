import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkThreadCommand } from '@ai-usage/report-core/work-thread';
import { parseUsageEnginePublicationRevision } from '@ai-usage/usage-engine-control';
import { initializeUsageStore } from '@ai-usage/usage-store/writer';
import { Deferred, Effect } from 'effect';
import {
  createInitialUsageEngineSourceControlView,
  createUsageEngineRuntime,
  type UsageEngineRuntimeDependencies,
} from './runtime';
import { createWorkThreadService, type WorkThreadService } from './work-threads';
import { createUsageEngineWriterGate } from './writer-gate';

const roots: string[] = [];
const NOW = new Date('2026-10-24T10:00:00.000Z');
const MACHINE = { id: 'work-thread-machine', label: 'Work thread machine' };
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

const persistedThread = (dbPath: string, threadId: string): unknown => {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    return db
      .query(`SELECT follow_revision AS followRevision, machine_id AS machineId, title
      FROM work_threads WHERE thread_id = ?`)
      .get(threadId);
  } finally {
    db.close();
  }
};

const persistedEventCount = (dbPath: string, threadId: string): unknown => {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    return db.query('SELECT COUNT(*) AS count FROM work_thread_events WHERE thread_id = ?').get(threadId);
  } finally {
    db.close();
  }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createCommand = (): WorkThreadCommand => ({
  commandId: randomUUID(),
  intent: 'change',
  links: [],
  objective: null,
  op: 'create',
  projectLabel: 'Project',
  title: 'A durable work thread',
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'work-thread-engine-'));
  roots.push(root);
  const dbPath = join(root, 'usage.sqlite');
  const schemaVersion = await Effect.runPromise(initializeUsageStore({ dbPath }));
  const gate = createUsageEngineWriterGate();
  const service = createWorkThreadService({ dbPath, machine: () => MACHINE, now: () => NOW, runWithWriter: gate.run });
  return { dbPath, gate, schemaVersion, service };
};

const runtimeFor = (service: WorkThreadService | undefined, schemaVersion: number) => {
  const source = createInitialUsageEngineSourceControlView(INSTANCE_ID, NOW);
  const unavailable = (): Promise<never> => Promise.reject(new Error('Unrelated mutation was called.'));
  const noop = (): Promise<void> => Promise.resolve();
  const dependencies: UsageEngineRuntimeDependencies = {
    acquireWriterLease: async () => ({ release: noop }),
    initializeStore: async () => schemaVersion,
    initialSourceControl: source,
    instanceId: INSTANCE_ID,
    mutation: {
      confirmMerge: unavailable,
      discardFileInput: unavailable,
      importCursor: unavailable,
      previewMerge: unavailable,
      replaceProjectAliases: unavailable,
      replaceProjectGroups: unavailable,
      replaceProjectGroupsByReference: unavailable,
      setCampaignLabelOverride: unavailable,
      setMachineLabel: unavailable,
    },
    now: () => NOW,
    publishInitialRevision: async () => ({
      publishedAt: NOW.toISOString(),
      revision: parseUsageEnginePublicationRevision('work-thread-test-revision'),
    }),
    quiesceStore: noop,
    recover: noop,
    sourceControl: {
      changes: (signal) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise((resolve) => {
              const finish = () => resolve({ done: true, value: undefined });
              if (signal.aborted) {
                finish();
              } else {
                signal.addEventListener('abort', finish, { once: true });
              }
            }),
        }),
      }),
      detectAll: noop,
      dispose: noop,
      publish: unavailable,
      redetectAndRunSource: unavailable,
      runAllEnabled: unavailable,
      runSource: unavailable,
      setSourceEnabled: unavailable,
      start: async () => source,
      stopAutonomousCollection: noop,
    },
    validateConfig: noop,
    ...(service === undefined ? {} : { workThreads: service }),
  };
  return createUsageEngineRuntime(dependencies);
};

describe('work-thread engine service', () => {
  test('dispatches persisted commands and keeps replay and revision conflicts as succeeded completions', async () => {
    const { dbPath, schemaVersion, service } = await fixture();
    const runtime = runtimeFor(service, schemaVersion);
    await runtime.start();
    try {
      const input = createCommand();
      const accepted = await runtime.executeCommand({ command: 'work-thread', input }, randomUUID());
      expect(accepted.ok).toBe(true);
      const created = await runtime.waitForCommand(accepted.commandId);
      expect(created.state).toBe('succeeded');
      if (!(created.state === 'succeeded' && created.command === 'work-thread' && created.output.result.ok)) {
        throw new Error('Expected a successful work-thread creation.');
      }
      const threadId = created.output.result.threadId;
      expect(persistedThread(dbPath, threadId)).toMatchObject({
        followRevision: 1,
        machineId: MACHINE.id,
        title: 'A durable work thread',
      });
      const replay = await runtime.executeCommand({ command: 'work-thread', input }, randomUUID());
      expect(await runtime.waitForCommand(replay.commandId)).toMatchObject({
        output: { kind: 'work-thread', result: { applied: false, ok: true, threadId } },
        state: 'succeeded',
      });
      const done: WorkThreadCommand = {
        acknowledgedRemainders: [],
        commandId: randomUUID(),
        expectedRevision: 1,
        op: 'set-follow-state',
        reason: 'Delivered',
        threadId,
        to: 'done',
        waitingFor: null,
        waitingOn: null,
      };
      const firstTab = await runtime.executeCommand({ command: 'work-thread', input: done }, randomUUID());
      expect(await runtime.waitForCommand(firstTab.commandId)).toMatchObject({
        output: { result: { applied: true, followRevision: 2, ok: true } },
        state: 'succeeded',
      });
      const secondTab = await runtime.executeCommand(
        { command: 'work-thread', input: { ...done, commandId: randomUUID() } },
        randomUUID(),
      );
      expect(await runtime.waitForCommand(secondTab.commandId)).toMatchObject({
        output: { kind: 'work-thread', result: { currentRevision: 2, failure: 'revision-conflict', ok: false } },
        state: 'succeeded',
      });
      expect(persistedEventCount(dbPath, threadId)).toEqual({ count: 2 });
    } finally {
      await runtime.dispose();
    }
  });

  test('waits for the writer gate for commands and seeding, and refuses writes after gate closure', async () => {
    const { dbPath, gate, service } = await fixture();
    const holderEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseHolder = await Effect.runPromise(Deferred.make<void>());
    const holder = gate.run(async () => {
      await Effect.runPromise(Deferred.succeed(holderEntered, undefined));
      await Effect.runPromise(Deferred.await(releaseHolder));
    });
    await Effect.runPromise(Deferred.await(holderEntered));
    let completed = 0;
    const pending = service.execute(createCommand()).then((result) => {
      completed += 1;
      return result;
    });
    const seeds = [
      {
        discoveredAt: NOW.toISOString(),
        intent: 'change' as const,
        linkKind: 'pull-request' as const,
        origin: 'pull-request' as const,
        originKey: 'github.com/owner/repo#7',
        projectLabel: 'Project',
        title: 'Discovered change',
      },
    ];
    const seeded = service.seedWorkThreads(seeds).then((result) => {
      completed += 1;
      return result;
    });
    try {
      await Bun.sleep(5);
      expect(completed).toBe(0);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseHolder, undefined));
      await holder;
    }
    const commandResult = await pending;
    expect(commandResult.result.ok).toBe(true);
    expect(await seeded).toEqual({ created: 1, existing: 0 });
    expect(await service.seedWorkThreads(seeds)).toEqual({ created: 0, existing: 1 });
    gate.close();
    await expect(service.execute(createCommand())).rejects.toThrow('closed');
    await expect(service.seedWorkThreads(seeds)).rejects.toThrow('closed');
    if (commandResult.result.ok) {
      expect(persistedThread(dbPath, commandResult.result.threadId)).not.toBeNull();
    }
  });

  test('keeps an admitted write noninterruptible while it waits for the writer gate', async () => {
    const { gate, schemaVersion, service } = await fixture();
    const runtime = runtimeFor(service, schemaVersion);
    await runtime.start();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const holder = gate.run(async () => {
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(release));
    });
    await Effect.runPromise(Deferred.await(entered));
    try {
      const accepted = await runtime.executeCommand({ command: 'work-thread', input: createCommand() }, randomUUID());
      // Let the coordinator dispatch the command so cancellation observes an active durable write.
      await Bun.sleep(5);
      expect(await runtime.cancelCommand(accepted.commandId)).toMatchObject({ disposition: 'finishing' });
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await holder;
      expect(await runtime.waitForCommand(accepted.commandId)).toMatchObject({ state: 'succeeded' });
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await holder;
      await runtime.dispose();
    }
  });

  test('reports unavailable composition and store failures as failed engine completions', async () => {
    const { gate, schemaVersion, service } = await fixture();
    for (const available of [false, true]) {
      const runtime = runtimeFor(available ? service : undefined, schemaVersion);
      await runtime.start();
      if (available) {
        gate.close();
      }
      try {
        const accepted = await runtime.executeCommand({ command: 'work-thread', input: createCommand() }, randomUUID());
        expect(await runtime.waitForCommand(accepted.commandId)).toMatchObject({
          error: { code: 'command-failed' },
          state: 'failed',
        });
      } finally {
        await runtime.dispose();
      }
    }
  });
});
