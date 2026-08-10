import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  makeAiUsageWideEventResource,
  makeCaptureWideEventSink,
  makeTestWideEventSinkLayer,
  noopWideEventSink,
  testWideEventResourceLayer,
  WideEventResourceService,
  WideEventSink,
} from '@ai-usage/effect-runtime';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { ensureMachineConfig, readAiUsageConfig, writeMachineConfig } from '@ai-usage/local-machine/machine-config';
import { createUsageMergeBundle, serializeUsageMergeBundle } from '@ai-usage/report-core/merge-bundle';
import { parseMergePreviewProof } from '@ai-usage/report-core/merge-proof';
import { projectSourceSelectorKey } from '@ai-usage/report-core/project-group';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  type CollectionSourceId,
  parseSourceControlSnapshot,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import { actualCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import {
  parseUsageEngineHandoffId,
  parseUsageEngineProjectSourceReference,
  parseUsageEnginePublicationRevision,
} from '@ai-usage/usage-engine-control';
import type { UsageFileMergeService } from '@ai-usage/usage-merge';
import {
  importLocalRows,
  initializeUsageStore,
  queryCurrentServedReportRevision,
  queryReportRows,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Deferred, Duration, Effect, Layer, Stream } from 'effect';
import { readUsageEngineInput } from './input-file';
import {
  createDurableReportPublisher,
  createLiveUsageEngineMutationPort,
  createLiveUsageEngineRuntime,
  createTerminalSourceControlPort,
} from './live';
import {
  createInitialUsageEngineSourceControlView,
  UsageEngineFatalConsistencyError,
  UsageEngineSoftSourceError,
} from './runtime';
import { type ScheduledSource, SourceRunError } from './source-adapters';
import type { SourceControlService } from './source-control';
import { createUsageEngineWriterGate } from './writer-gate';

const roots: string[] = [];
const machine: UsageMachine = { id: 'engine-machine', label: 'Engine Machine' };
const now = new Date('2026-07-30T10:00:00.000Z');

const sourceSnapshot = (
  instanceId: string,
  generation: number,
  requestedGeneration: number,
  acknowledgedRequestGeneration: number,
): SourceControlView => {
  const initial = createInitialUsageEngineSourceControlView(instanceId, now);
  return parseSourceControlSnapshot({
    ...initial,
    generation,
    publication: {
      ...initial.publication,
      acknowledgedRequestGeneration,
      pendingDemand: requestedGeneration > acknowledgedRequestGeneration,
      requestedGeneration,
    },
  });
};

const sourceControlFixture = (
  snapshots: readonly SourceControlView[],
  changes: Stream.Stream<SourceControlView>,
): SourceControlService => {
  let snapshotIndex = 0;
  return {
    changes,
    detectAll: Effect.void,
    detectSource: () => Effect.succeed(false),
    getSnapshot: Effect.sync(() => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!),
    requestPublication: Effect.succeed(false),
    runAllEnabled: Effect.succeed(0),
    runNow: () => Effect.succeed(false),
    setEnabled: () => Effect.void,
    stopAutonomousCollection: Effect.void,
  };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('live usage engine publication', () => {
  test('publishes and renews a durable compatible revision from one explicit store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-live-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [] }));
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: now }));
    let publicationTime = now;
    const publisher = createDurableReportPublisher({
      configCwd: root,
      dbPath,
      machine,
      now: () => publicationTime,
      storage,
    });

    const first = await publisher.publish();
    publicationTime = new Date('2026-07-30T10:01:00.000Z');
    const second = await publisher.publish();
    const current = await Effect.runPromise(
      queryCurrentServedReportRevision({ dbPath, now: publicationTime.getTime() }),
    );

    expect(first.changed).toBe(true);
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(second).toEqual({
      changed: false,
      publishedAt: new Date(current.publishedAt).toISOString(),
      revision: first.revision,
    });
    expect(current.revision).toBe(first.revision);
    expect(current.rowCount).toBe(0);
  });

  test('keeps a committed revision successful when post-commit retention fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-retention-'));
    roots.push(root);
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const storage = createLocalHistoryStorage(path.join(root, 'home'));
    const retentionFailures: unknown[] = [];
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(importLocalRows({ dbPath, machine, rows: [] }));
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine, updatedAt: now }));
    const publisher = createDurableReportPublisher({
      configCwd: root,
      dbPath,
      machine,
      now: () => now,
      reportRetentionFailure: (cause) => retentionFailures.push(cause),
      retainRevisions: () => Promise.reject(new Error('injected retention failure')),
      storage,
    });

    const publication = await publisher.publish();
    const current = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: now.getTime() }));

    expect(publication.revision).toBe(current.revision);
    expect(publication.publishedAt).toBe(new Date(current.publishedAt).toISOString());
    expect(retentionFailures).toHaveLength(1);
  });

  test('waits for a coalesced source run and its dependent publication to become terminal', async () => {
    const allowRun = await Effect.runPromise(Deferred.make<void>());
    let publicationCalls = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () =>
        Deferred.await(allowRun).pipe(Effect.as({ changed: true, inputCount: 1, outputCount: 1, warnings: [] })),
    };
    const port = createTerminalSourceControlPort({
      instanceId: '11111111-1111-4111-8111-111111111111',
      policyStore: {
        load: Effect.succeed({}),
        setEnabled: () => Effect.void,
      },
      publication: {
        publish: Effect.sync(() => {
          publicationCalls++;
          return { changed: true, revision: `revision-${publicationCalls}` };
        }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    let completed = false;
    const command = port.runSource('claude.sessions').then(() => {
      completed = true;
    });
    await Bun.sleep(5);
    expect(completed).toBe(false);
    await Effect.runPromise(Deferred.succeed(allowRun, undefined));
    await command;

    expect(publicationCalls).toBe(1);
    await port.dispose();
  });

  test('advances immediately from a direct snapshot without waiting for a stream echo', async () => {
    const instanceId = '10101010-1010-4010-8010-101010101010';
    const initial = sourceSnapshot(instanceId, 1, 1, 0);
    const acknowledged = sourceSnapshot(instanceId, 2, 1, 1);
    const port = createTerminalSourceControlPort({
      instanceId,
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'unused' }) },
      sourceControlService: sourceControlFixture([initial, acknowledged], Stream.never),
      sources: new Map(),
      startupDeadlineMs: 25,
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await expect(port.start()).resolves.toMatchObject({ generation: 2 });
    await port.dispose();
  });

  test('fails startup at its finite publication deadline', async () => {
    const instanceId = '20202020-2020-4020-8020-202020202020';
    const pending = sourceSnapshot(instanceId, 1, 1, 0);
    const port = createTerminalSourceControlPort({
      instanceId,
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'unused' }) },
      sourceControlService: sourceControlFixture([pending], Stream.never),
      sources: new Map(),
      startupDeadlineMs: 10,
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await expect(port.start()).rejects.toThrow('timed out');
    await port.dispose();
  });

  test('applies the startup deadline while reading the initial snapshot', async () => {
    const instanceId = '21212121-2121-4121-8121-212121212121';
    const sourceControlService = sourceControlFixture([sourceSnapshot(instanceId, 1, 0, 0)], Stream.never);
    const port = createTerminalSourceControlPort({
      instanceId,
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'unused' }) },
      sourceControlService: { ...sourceControlService, getSnapshot: Effect.never },
      sources: new Map(),
      startupDeadlineMs: 10,
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await expect(port.start()).rejects.toThrow('timed out');
    await port.dispose();
  });

  test('rejects pending startup when the source-control stream dies or completes', async () => {
    const cases = [Stream.die(new Error('private stream failure')), Stream.empty] as const;
    for (const [index, changes] of cases.entries()) {
      const instanceId = index === 0 ? '30303030-3030-4030-8030-303030303030' : '40404040-4040-4040-8040-404040404040';
      const pending = sourceSnapshot(instanceId, 1, 1, 0);
      const port = createTerminalSourceControlPort({
        instanceId,
        policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
        publication: { publish: Effect.succeed({ changed: false, revision: 'unused' }) },
        sourceControlService: sourceControlFixture([pending], changes),
        sources: new Map(),
        startupDeadlineMs: 100,
        wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
      });

      await expect(port.start()).rejects.toThrow('event stream stopped unexpectedly');
      await port.dispose();
    }
  });

  test('surfaces an automatically undetected source as a soft collection outcome', async () => {
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'not-detected', reason: { code: 'input-missing' } }),
      id: 'claude.sessions',
      run: () => Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] }),
    };
    const port = createTerminalSourceControlPort({
      instanceId: '12121212-1212-4212-8212-121212121212',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    const error = await port.runSource('claude.sessions').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UsageEngineSoftSourceError);
    expect(error).toMatchObject({ reason: 'not-detected', sourceId: 'claude.sessions' });
    await port.dispose();
  });

  test('defers foreground detection and collects only an explicitly requested source', async () => {
    let requestedDetections = 0;
    let requestedRuns = 0;
    let unrelatedDetections = 0;
    let unrelatedRuns = 0;
    const requested: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() => {
        requestedDetections++;
        return { availability: 'detected' as const, reason: { code: 'none' as const } };
      }),
      id: 'claude.sessions',
      run: () => {
        requestedRuns++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const unrelated: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() => {
        unrelatedDetections++;
        return { availability: 'detected' as const, reason: { code: 'none' as const } };
      }),
      id: 'codex.sessions',
      run: () => {
        unrelatedRuns++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const port = createTerminalSourceControlPort({
      initialDetection: 'deferred',
      instanceId: '99999999-9999-4999-8999-999999999999',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([
        ['claude.sessions', requested],
        ['codex.sessions', unrelated],
      ]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    expect([requestedDetections, requestedRuns, unrelatedDetections, unrelatedRuns]).toEqual([0, 0, 0, 0]);

    await port.runSource('claude.sessions');

    expect([requestedDetections, requestedRuns, unrelatedDetections, unrelatedRuns]).toEqual([1, 1, 0, 0]);
    await port.dispose();
  });

  test('does not admit a foreground source when abort wins during targeted detection', async () => {
    const detectionStarted = await Effect.runPromise(Deferred.make<void>());
    const allowDetection = await Effect.runPromise(Deferred.make<void>());
    let runCalls = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Deferred.succeed(detectionStarted, undefined).pipe(
        Effect.andThen(Deferred.await(allowDetection)),
        Effect.as({ availability: 'detected', reason: { code: 'none' } } as const),
      ),
      id: 'claude.sessions',
      run: () => {
        runCalls++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const port = createTerminalSourceControlPort({
      initialDetection: 'deferred',
      instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });
    const controller = new AbortController();

    await port.start();
    const command = port.runSource('claude.sessions', controller.signal);
    await Effect.runPromise(Deferred.await(detectionStarted));
    controller.abort();
    const outcome = await Promise.race([
      command.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      Bun.sleep(25).then(() => 'timed-out' as const),
    ]);
    if (outcome === 'timed-out') {
      await Effect.runPromise(Deferred.succeed(allowDetection, undefined));
      await command.catch(() => undefined);
    }

    expect(outcome).toBe('rejected');
    expect(runCalls).toBe(0);
    await port.dispose();
  });

  test('detects and collects enabled sources only when foreground run-all is requested', async () => {
    let detectionCalls = 0;
    let runCalls = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() => {
        detectionCalls++;
        return { availability: 'detected' as const, reason: { code: 'none' as const } };
      }),
      id: 'claude.sessions',
      run: () => {
        runCalls++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const port = createTerminalSourceControlPort({
      initialDetection: 'deferred',
      instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    await port.publish();
    expect([detectionCalls, runCalls]).toEqual([0, 0]);

    await port.runAllEnabled();

    expect([detectionCalls, runCalls]).toEqual([1, 1]);
    await port.dispose();
  });

  test('keeps foreground run-all timer-free while another explicit source remains active', async () => {
    const blockingSourceStarted = await Effect.runPromise(Deferred.make<void>());
    const allowBlockingSource = await Effect.runPromise(Deferred.make<void>());
    let quickRuns = 0;
    let blockingRuns = 0;
    const quick: ScheduledSource = {
      cadence: Duration.millis(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () => {
        quickRuns++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const blocking: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'codex.sessions',
      run: () => {
        blockingRuns++;
        return Deferred.succeed(blockingSourceStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowBlockingSource)),
          Effect.as({ changed: false, inputCount: 0, outputCount: 0, warnings: [] }),
        );
      },
    };
    const port = createTerminalSourceControlPort({
      initialDetection: 'deferred',
      instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([
        ['claude.sessions', quick],
        ['codex.sessions', blocking],
      ]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    const command = port.runAllEnabled();
    await Effect.runPromise(Deferred.await(blockingSourceStarted));
    await Bun.sleep(10);
    await Effect.runPromise(Deferred.succeed(allowBlockingSource, undefined));
    await command;

    expect([quickRuns, blockingRuns]).toEqual([1, 1]);
    await port.dispose();
  });

  test('redetects only a foreground source before enabling and coalesces its publication', async () => {
    let requestedDetections = 0;
    let requestedRuns = 0;
    let unrelatedDetections = 0;
    let unrelatedRuns = 0;
    let publicationCalls = 0;
    const requested: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() => {
        requestedDetections++;
        return { availability: 'detected' as const, reason: { code: 'none' as const } };
      }),
      id: 'claude.sessions',
      run: () => {
        requestedRuns++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const unrelated: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() => {
        unrelatedDetections++;
        return { availability: 'detected' as const, reason: { code: 'none' as const } };
      }),
      id: 'codex.sessions',
      run: () => {
        unrelatedRuns++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const port = createTerminalSourceControlPort({
      initialDetection: 'deferred',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      policyStore: {
        load: Effect.succeed({ 'claude.sessions': { enabled: false } }),
        setEnabled: () => Effect.void,
      },
      publication: {
        publish: Effect.sync(() => {
          publicationCalls++;
          return { changed: false, revision: `revision-${publicationCalls}` };
        }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([
        ['claude.sessions', requested],
        ['codex.sessions', unrelated],
      ]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    await port.setSourceEnabled('claude.sessions', true);

    expect([requestedDetections, requestedRuns, unrelatedDetections, unrelatedRuns]).toEqual([1, 1, 0, 0]);
    expect(publicationCalls).toBe(1);
    await port.dispose();
  });

  test('keeps an already-enabled foreground source idempotent without detection or collection', async () => {
    let detectionCalls = 0;
    let runCalls = 0;
    let publicationCalls = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() => {
        detectionCalls++;
        return { availability: 'detected' as const, reason: { code: 'none' as const } };
      }),
      id: 'claude.sessions',
      run: () => {
        runCalls++;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const port = createTerminalSourceControlPort({
      initialDetection: 'deferred',
      instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: {
        publish: Effect.sync(() => {
          publicationCalls++;
          return { changed: false, revision: `revision-${publicationCalls}` };
        }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    await port.setSourceEnabled('claude.sessions', true);

    expect([detectionCalls, runCalls, publicationCalls]).toEqual([0, 0, 1]);
    await port.dispose();
  });

  test('records publication demand before exposing a changed source as terminal', async () => {
    const allowRun = await Effect.runPromise(Deferred.make<void>());
    const eventSubmissionStarted = await Effect.runPromise(Deferred.make<void>());
    const allowEventSubmission = await Effect.runPromise(Deferred.make<void>());
    let publicationCalls = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () =>
        Deferred.await(allowRun).pipe(Effect.as({ changed: true, inputCount: 1, outputCount: 1, warnings: [] })),
    };
    const port = createTerminalSourceControlPort({
      instanceId: '88888888-8888-4888-8888-888888888888',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: {
        publish: Effect.sync(() => {
          publicationCalls++;
          return { changed: true, revision: `revision-${publicationCalls}` };
        }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer({
        diagnostics: noopWideEventSink.diagnostics,
        submit: () =>
          Deferred.succeed(eventSubmissionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowEventSubmission)),
          ),
      }),
    });

    await port.start();
    let completed = false;
    const command = port.runSource('claude.sessions').then(() => {
      completed = true;
    });
    await Effect.runPromise(Deferred.succeed(allowRun, undefined));
    await Effect.runPromise(Deferred.await(eventSubmissionStarted));
    await Bun.sleep(0);
    const completedBeforeEvent = completed;
    const publicationsBeforeEvent = publicationCalls;
    await Effect.runPromise(Deferred.succeed(allowEventSubmission, undefined));
    await command;

    expect(completedBeforeEvent).toBe(false);
    expect(publicationsBeforeEvent).toBe(0);
    expect(publicationCalls).toBe(1);
    await port.dispose();
  });

  test('does not finish disposal while an admitted publication promise is still in flight', async () => {
    const publicationStarted = await Effect.runPromise(Deferred.make<void>());
    const allowPublication = await Effect.runPromise(Deferred.make<void>());
    const port = createTerminalSourceControlPort({
      instanceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: {
        publish: Deferred.succeed(publicationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowPublication)),
          Effect.as({ changed: false, revision: 'revision-1' }),
        ),
      },
      sources: new Map(),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    const publication = port.publish();
    publication.catch(() => undefined);
    await Effect.runPromise(Deferred.await(publicationStarted));
    let disposed = false;
    const disposal = port.dispose().then(() => {
      disposed = true;
    });
    await Bun.sleep(10);
    const disposedBeforePublicationSettled = disposed;
    await Effect.runPromise(Deferred.succeed(allowPublication, undefined));
    await disposal;

    expect(disposedBeforePublicationSettled).toBe(false);
    expect(disposed).toBe(true);
  });

  test('coalesces a source policy change and its unchanged collection into one publication', async () => {
    let publicationCalls = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () => Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] }),
    };
    const port = createTerminalSourceControlPort({
      instanceId: '22222222-2222-4222-8222-222222222222',
      policyStore: {
        load: Effect.succeed({ 'claude.sessions': { enabled: false } }),
        setEnabled: () => Effect.void,
      },
      publication: {
        publish: Effect.sync(() => {
          publicationCalls++;
          return { changed: false, revision: `revision-${publicationCalls}` };
        }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    await port.setSourceEnabled('claude.sessions', true);

    expect(publicationCalls).toBe(1);
    await port.dispose();
  });

  test('replays the authoritative snapshot when a runtime subscribes after source-control startup', async () => {
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'not-detected', reason: { code: 'input-missing' } }),
      id: 'claude.sessions',
      run: () => Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] }),
    };
    const port = createTerminalSourceControlPort({
      instanceId: '66666666-6666-4666-8666-666666666666',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: false, revision: 'revision-1' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });
    const started = await port.start();
    const controller = new AbortController();
    const iterator = port.changes(controller.signal)[Symbol.asyncIterator]();
    try {
      const replay = await Promise.race([
        iterator.next(),
        Bun.sleep(50).then(() => {
          throw new Error('Source-control snapshot replay timed out.');
        }),
      ]);
      expect(replay).toEqual({ done: false, value: started });
    } finally {
      controller.abort();
      await iterator.return?.();
      await port.dispose();
    }
  });

  test('redetects and runs only Cursor once without collecting unrelated sources', async () => {
    let cursorAvailable = false;
    let cursorRuns = 0;
    let unrelatedRuns = 0;
    let publicationCalls = 0;
    const cursor: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.sync(() =>
        cursorAvailable
          ? { availability: 'detected' as const, reason: { code: 'none' as const } }
          : { availability: 'not-detected' as const, reason: { code: 'input-missing' as const } },
      ),
      id: 'cursor.sessions',
      run: () => {
        cursorRuns += 1;
        return Effect.succeed({ changed: true, inputCount: 1, outputCount: 1, warnings: [] });
      },
    };
    const unrelated: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () => {
        unrelatedRuns += 1;
        return Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] });
      },
    };
    const port = createTerminalSourceControlPort({
      instanceId: '77777777-7777-4777-8777-777777777777',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: {
        publish: Effect.sync(() => {
          publicationCalls += 1;
          return { changed: true, revision: `revision-${publicationCalls}` };
        }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([
        ['cursor.sessions', cursor],
        ['claude.sessions', unrelated],
      ]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    await port.runAllEnabled();
    const unrelatedBaseline = unrelatedRuns;
    cursorAvailable = true;
    await port.redetectAndRunSource('cursor.sessions');

    expect(cursorRuns).toBe(1);
    expect(unrelatedRuns).toBe(unrelatedBaseline);
    expect(publicationCalls).toBe(1);
    await port.dispose();
  });

  test('does not let a historical failed disabled source fail a later successful run-all command', async () => {
    const failingSource: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () =>
        Effect.fail(
          new SourceRunError({
            cause: new Error('fixture failure'),
            message: 'fixture failure',
            sourceId: 'claude.sessions',
          }),
        ),
    };
    const successfulSource: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'codex.sessions',
      run: () => Effect.succeed({ changed: false, inputCount: 0, outputCount: 0, warnings: [] }),
    };
    const port = createTerminalSourceControlPort({
      instanceId: '11111111-1111-4111-8111-111111111111',
      policyStore: {
        load: Effect.succeed({}),
        setEnabled: () => Effect.void,
      },
      publication: {
        publish: Effect.succeed({ changed: false, revision: 'revision-1' }),
      },
      sources: new Map<CollectionSourceId, ScheduledSource>([
        ['claude.sessions', failingSource],
        ['codex.sessions', successfulSource],
      ]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await port.start();
    await expect(port.runAllEnabled()).rejects.toThrow('source run failed');
    await port.setSourceEnabled('claude.sessions', false);
    await expect(port.runAllEnabled()).resolves.toBeUndefined();
    await port.dispose();
  });

  test('owns machine config changes and stale-confirmed merge persistence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-mutation-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
    const mutableMachine = { ...machine };
    const port = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath,
      inboxDirectory,
      machine: mutableMachine,
      now: () => now,
      operatorCwd: root,
      storage,
    });

    await port.setMachineLabel('Renamed Engine');
    const configured = await Effect.runPromise(
      ensureMachineConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    expect(configured.label).toBe('Renamed Engine');
    expect(mutableMachine.label).toBe('Renamed Engine');

    const peerMachine = { id: 'peer-machine', label: 'Peer Machine' };
    const row = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: now,
      endDate: now,
      harness: 'Codex',
      model: 'gpt-5',
      name: 'Peer session',
      project: 'ai-usage',
      provider: 'OpenAI',
      tokens: { cr: 0, cw: 0, in: 10, out: 5 },
    });
    const mergePath = path.join(root, 'peer-merge.json');
    await writeFile(
      mergePath,
      serializeUsageMergeBundle(createUsageMergeBundle({ machine: peerMachine, rows: [row] })),
    );
    const preview = await port.previewMerge({
      command: 'preview-merge',
      input: { filePath: mergePath, kind: 'operator-file' },
    });
    await port.confirmMerge({
      command: 'confirm-merge',
      confirmationToken: preview.confirmationToken,
      documentDigest: preview.documentDigest,
      input: { filePath: mergePath, kind: 'operator-file' },
    });

    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    expect(preview).toMatchObject({ rows: 1, result: { inserted: 1 } });
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.source.machineId).toBe(peerMachine.id);
  });

  test('removes an active preview handoff when abort wins after preview computation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-preview-abort-'));
    roots.push(root);
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const handoffId = parseUsageEngineHandoffId('active-preview-abort');
    const handoffPath = path.join(inboxDirectory, `${handoffId}.upload`);
    await writeFile(handoffPath, '{}', { mode: 0o600 });
    const previewStarted = await Effect.runPromise(Deferred.make<void>());
    const allowPreview = await Effect.runPromise(Deferred.make<void>());
    const mergeService: UsageFileMergeService = {
      confirmManualMergeBundle: () => Effect.die(new Error('Confirmation is not used by this fixture.')),
      previewManualMergeBundle: () =>
        Deferred.succeed(previewStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowPreview)),
          Effect.as({
            ...parseMergePreviewProof({
              confirmationToken: `v1.${'b'.repeat(64)}`,
              documentDigest: 'a'.repeat(64),
            }),
            bytes: 2,
            deleted: 0,
            fleetChanged: false,
            generatedAt: now.toISOString(),
            inserted: 0,
            machine: { id: 'preview-peer', label: 'Preview Peer' },
            omittedWarningCount: 0,
            rows: 0,
            superseded: 0,
            unchanged: 0,
            updated: 0,
            warningCount: 0,
            warningItems: [],
            warnings: 0,
          }),
        ),
    };
    const port = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath: path.join(root, 'state', 'usage.sqlite'),
      inboxDirectory,
      machine,
      mergeService,
      operatorCwd: root,
      storage: createLocalHistoryStorage(path.join(root, 'home')),
    });
    const abort = new AbortController();
    const preview = port.previewMerge(
      { command: 'preview-merge', input: { handoffId, kind: 'inbox-handoff' } },
      abort.signal,
    );
    await Effect.runPromise(Deferred.await(previewStarted));

    abort.abort();
    await Effect.runPromise(Deferred.succeed(allowPreview, undefined));

    await expect(preview).rejects.toThrow('aborted');
    await expect(Bun.file(handoffPath).exists()).resolves.toBe(false);
  });

  test('surfaces both machine config and database compensation failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-machine-compensation-'));
    roots.push(root);
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const mutableMachine = { id: 'saga-machine', label: 'Old Label' };
    let updateCalls = 0;
    const port = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath: path.join(root, 'state', 'usage.sqlite'),
      inboxDirectory,
      machine: mutableMachine,
      operatorCwd: root,
      storage: createLocalHistoryStorage(path.join(root, 'home')),
      updateMachineLabel: () => {
        updateCalls++;
        return updateCalls === 1
          ? Promise.resolve()
          : Promise.reject(new Error('injected database compensation failure'));
      },
      writeMachine: () => Promise.reject(new Error('injected config write failure')),
    });

    const failure = await port.setMachineLabel('New Label').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageEngineFatalConsistencyError);
    expect((failure as AggregateError).errors.map(String)).toEqual([
      'Error: injected config write failure',
      'Error: injected database compensation failure',
    ]);
    expect(mutableMachine.label).toBe('Old Label');
  });

  test('cancels an autonomous source waiting behind a fatal mutation before it can write', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-fatal-source-race-'));
    roots.push(root);
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const writerGate = createUsageEngineWriterGate();
    let releaseConfigWrite = (): void => undefined;
    let signalConfigWriteStarted = (): void => undefined;
    const configWriteBlocked = new Promise<void>((resolve) => {
      releaseConfigWrite = resolve;
    });
    const configWriteStarted = new Promise<void>((resolve) => {
      signalConfigWriteStarted = resolve;
    });
    let updateCalls = 0;
    const mutation = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath: path.join(root, 'state', 'usage.sqlite'),
      inboxDirectory,
      machine: { id: 'fatal-race-machine', label: 'Old Label' },
      operatorCwd: root,
      storage: createLocalHistoryStorage(path.join(root, 'home')),
      updateMachineLabel: () => {
        updateCalls++;
        return updateCalls === 1
          ? Promise.resolve()
          : Promise.reject(new Error('injected database compensation failure'));
      },
      writeMachine: async () => {
        signalConfigWriteStarted();
        await configWriteBlocked;
        throw new Error('injected config write failure');
      },
      writerGate,
    });
    const fatalMutation = mutation.setMachineLabel('New Label');
    await configWriteStarted;
    let sourceRuns = 0;
    const source: ScheduledSource = {
      cadence: Duration.hours(1),
      detect: Effect.succeed({ availability: 'detected', reason: { code: 'none' } }),
      id: 'claude.sessions',
      run: () => {
        sourceRuns++;
        return Effect.succeed({ changed: true, inputCount: 1, outputCount: 1, warnings: [] });
      },
    };
    const sourcePort = createTerminalSourceControlPort({
      instanceId: '99999999-9999-4999-8999-999999999999',
      policyStore: { load: Effect.succeed({}), setEnabled: () => Effect.void },
      publication: { publish: Effect.succeed({ changed: true, revision: 'forbidden-revision' }) },
      sources: new Map<CollectionSourceId, ScheduledSource>([['claude.sessions', source]]),
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
      writerGate,
    });
    const queued = await sourcePort.start();
    const changesAbort = new AbortController();
    const changes = sourcePort.changes(changesAbort.signal)[Symbol.asyncIterator]();

    expect(queued.sources.find(({ id }) => id === 'claude.sessions')?.lifecycle).toBe('queued');
    releaseConfigWrite();
    const failure = await fatalMutation.catch((error: unknown) => error);
    let terminal = queued;
    while (terminal.queueDepth !== 0) {
      const next = await Promise.race([
        changes.next(),
        Bun.sleep(500).then(() => {
          throw new Error('Timed out waiting for the poisoned source job to cancel.');
        }),
      ]);
      if (next.done) {
        throw new Error('Source-control changes ended before the poisoned job was cancelled.');
      }
      terminal = next.value;
    }

    expect(String(failure)).toContain('UsageEngineFatalConsistencyError');
    expect(writerGate.isClosed()).toBe(true);
    expect(sourceRuns).toBe(0);
    expect(terminal.sources.find(({ id }) => id === 'claude.sessions')?.lifecycle).not.toBe('queued');
    changesAbort.abort();
    await changes.return?.();
    await sourcePort.dispose();
  });

  test('removes a Cursor handoff when cancellation wins before writer-gate admission', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-cursor-gate-cancel-'));
    roots.push(root);
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const writerGate = createUsageEngineWriterGate();
    let releaseHolder = (): void => undefined;
    let signalHolderEntered = (): void => undefined;
    const holderRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holderEntered = new Promise<void>((resolve) => {
      signalHolderEntered = resolve;
    });
    const holder = writerGate.run(async () => {
      signalHolderEntered();
      await holderRelease;
    });
    await holderEntered;
    const handoffId = parseUsageEngineHandoffId('cursor-gate-cancel');
    const handoffPath = path.join(inboxDirectory, `${handoffId}.upload`);
    await writeFile(handoffPath, 'Date,User,Kind,Model,Cost\n2026-07-30,user,chat,gpt-5,1\n', { mode: 0o600 });
    const port = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath: path.join(root, 'state', 'usage.sqlite'),
      inboxDirectory,
      machine,
      operatorCwd: root,
      storage: createLocalHistoryStorage(path.join(root, 'home')),
      writerGate,
    });
    const abort = new AbortController();
    const importResult = port.importCursor(
      { command: 'import-cursor', input: { handoffId, kind: 'inbox-handoff' } },
      abort.signal,
    );

    abort.abort();
    await expect(importResult).rejects.toThrow();
    await expect(Bun.file(handoffPath).exists()).resolves.toBe(false);
    releaseHolder();
    await holder;
  });

  test('reconciles stored local rows to authoritative machine config before initial publication', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-machine-reconcile-'));
    roots.push(root);
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    const temporaryRoot = path.join(root, 'legacy-temp');
    await Promise.all([
      mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const storage = createLocalHistoryStorage(path.join(root, 'home'));
    const oldMachine = { id: 'reconcile-machine', label: 'Old Label' };
    const configuredMachine = { ...oldMachine, label: 'Authoritative Label' };
    const row = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: now,
      endDate: now,
      harness: 'Codex',
      model: 'gpt-5',
      name: 'Reconcile session',
      project: 'ai-usage',
      provider: 'OpenAI',
      tokens: { cr: 0, cw: 0, in: 10, out: 5 },
    });
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(importLocalRows({ dbPath, machine: oldMachine, rows: [row] }));
    await Effect.runPromise(
      writeMachineConfig(configuredMachine).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const runtime = createLiveUsageEngineRuntime({
      acquireWriterLease: async () => ({ release: async () => undefined }),
      codexLiveAvailable: () => false,
      configCwd: root,
      dbPath,
      inboxDirectory,
      instanceId: '88888888-8888-4888-8888-888888888888',
      now: () => now,
      operatorCwd: root,
      storage,
      temporaryRoot,
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await runtime.start();
    const stored = await Effect.runPromise(queryReportRows({ dbPath }));
    await runtime.dispose();

    expect(stored.rows[0]?.source.machineLabel).toBe(configuredMachine.label);
  });

  test('persists project mutations and publishes each resulting report revision', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-project-mutations-'));
    roots.push(root);
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    const temporaryRoot = path.join(root, 'temporary');
    await Promise.all([
      mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const storage = createLocalHistoryStorage(path.join(root, 'home'));
    const configuredMachine = { id: 'project-mutation-machine', label: 'Project Mutation Machine' };
    const row = {
      ...normalizeUsageRow({
        calls: 1,
        cost: actualCost(null),
        date: now,
        endDate: now,
        harness: 'Codex',
        model: 'gpt-5',
        name: 'Project mutation session',
        project: 'raw-project',
        provider: 'OpenAI',
        tokens: { cr: 0, cw: 0, in: 10, out: 5 },
      }),
      source: {
        harnessKey: 'codex',
        sourcePath: '/work/raw-project',
        sourceSessionId: 'project-mutation-session',
      },
    };
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(importLocalRows({ dbPath, machine: configuredMachine, rows: [row] }));
    await Effect.runPromise(
      writeMachineConfig(configuredMachine).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    const runtime = createLiveUsageEngineRuntime({
      acquireWriterLease: async () => ({ release: async () => undefined }),
      codexLiveAvailable: () => false,
      configCwd: root,
      dbPath,
      inboxDirectory,
      initialSourceDetection: 'deferred',
      instanceId: 'abababab-abab-4bab-8bab-abababababab',
      now: () => now,
      operatorCwd: root,
      storage,
      temporaryRoot,
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await runtime.start();
    const initial = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: now.getTime() }));
    await runtime.executeCommand(
      {
        command: 'replace-project-aliases',
        projectAliases: [{ match: ['/work/raw-project'], name: 'Aliased Project' }],
      },
      'project-aliases',
    );
    await expect(runtime.waitForCommand('project-aliases')).resolves.toMatchObject({
      command: 'replace-project-aliases',
      state: 'succeeded',
    });
    const afterAliases = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: now.getTime() }));
    const aliasConfig = await Effect.runPromise(
      readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    expect(aliasConfig.projectAliases).toEqual([{ match: ['/work/raw-project'], name: 'Aliased Project' }]);
    expect(afterAliases.revision).not.toBe(initial.revision);

    const exactSelector = { machineId: configuredMachine.id, sourcePath: '/work/raw-project' };
    const sourceReference = parseUsageEngineProjectSourceReference(
      `project-source:${createHash('sha256').update(projectSourceSelectorKey(exactSelector)).digest('hex')}`,
    );
    await runtime.executeCommand(
      {
        command: 'replace-project-groups-by-reference',
        projectGroups: [
          {
            id: 'project-group',
            name: 'Project Group',
            sources: [sourceReference],
          },
        ],
        revision: parseUsageEnginePublicationRevision(afterAliases.revision),
      },
      'project-groups',
    );
    await expect(runtime.waitForCommand('project-groups')).resolves.toMatchObject({
      command: 'replace-project-groups-by-reference',
      state: 'succeeded',
    });
    const afterGroups = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: now.getTime() }));
    const groupConfig = await Effect.runPromise(
      readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    await runtime.executeCommand(
      {
        campaignKey: 'project-mutation-machine:codex:project-mutation-session',
        command: 'set-campaign-label-override',
        label: 'Release train',
      },
      'campaign-label',
    );
    await expect(runtime.waitForCommand('campaign-label')).resolves.toMatchObject({
      command: 'set-campaign-label-override',
      state: 'succeeded',
    });
    const afterCampaignLabel = await Effect.runPromise(
      queryCurrentServedReportRevision({ dbPath, now: now.getTime() }),
    );
    const campaignConfig = await Effect.runPromise(
      readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    await runtime.executeCommand(
      {
        campaignKey: 'project-mutation-machine:codex:project-mutation-session',
        command: 'set-campaign-label-override',
        label: null,
      },
      'campaign-label-reset',
    );
    await expect(runtime.waitForCommand('campaign-label-reset')).resolves.toMatchObject({ state: 'succeeded' });
    const resetCampaignConfig = await Effect.runPromise(
      readAiUsageConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    await runtime.dispose();

    expect(groupConfig.projectGroups).toEqual([
      {
        id: 'project-group',
        name: 'Project Group',
        sources: [exactSelector],
      },
    ]);
    expect(afterGroups.revision).not.toBe(afterAliases.revision);
    expect(campaignConfig.campaignLabelOverrides).toEqual([
      {
        campaignKey: 'project-mutation-machine:codex:project-mutation-session',
        label: 'Release train',
      },
    ]);
    expect(afterCampaignLabel.revision).toBe(afterGroups.revision);
    expect(resetCampaignConfig.campaignLabelOverrides).toBeUndefined();
  });

  test('cleans rejected handoffs and preserves stale typing when its cleanup also fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-handoff-cleanup-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(
      writeMachineConfig({ id: 'cleanup-machine', label: 'Cleanup Machine' }).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
      ),
    );
    let failCleanup = false;
    const cleanupFailures: string[] = [];
    const port = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath,
      inboxDirectory,
      machine: { id: 'cleanup-machine', label: 'Cleanup Machine' },
      now: () => now,
      operatorCwd: root,
      readInput: async (input, inputOptions) => {
        const opened = await readUsageEngineInput(input, inputOptions);
        return failCleanup
          ? { ...opened, remove: () => Promise.reject(new Error('injected stale cleanup failure')) }
          : opened;
      },
      reportCleanupFailure: (operation) => cleanupFailures.push(operation),
      storage,
    });

    const invalidPath = path.join(inboxDirectory, 'invalid-merge.upload');
    await writeFile(invalidPath, '{', { mode: 0o600 });
    await expect(
      port.previewMerge({
        command: 'preview-merge',
        input: { handoffId: parseUsageEngineHandoffId('invalid-merge'), kind: 'inbox-handoff' },
      }),
    ).rejects.toThrow();
    await expect(Bun.file(invalidPath).exists()).resolves.toBe(false);

    const peerMachine = { id: 'cleanup-peer', label: 'Cleanup Peer' };
    const previewPath = path.join(inboxDirectory, 'stale-preview.upload');
    const validBundle = serializeUsageMergeBundle(createUsageMergeBundle({ machine: peerMachine, rows: [] }));
    await writeFile(previewPath, validBundle, { mode: 0o600 });
    const preview = await port.previewMerge({
      command: 'preview-merge',
      input: { handoffId: parseUsageEngineHandoffId('stale-preview'), kind: 'inbox-handoff' },
    });
    await expect(Bun.file(previewPath).exists()).resolves.toBe(false);
    const confirmPath = path.join(inboxDirectory, 'stale-confirm.upload');
    await writeFile(confirmPath, `${validBundle}\n`, { mode: 0o600 });
    failCleanup = true;
    await expect(
      port.confirmMerge({
        command: 'confirm-merge',
        confirmationToken: preview.confirmationToken,
        documentDigest: preview.documentDigest,
        input: { handoffId: parseUsageEngineHandoffId('stale-confirm'), kind: 'inbox-handoff' },
      }),
    ).rejects.toMatchObject({ code: 'preview-stale', name: 'UsageEngineCommandError' });
    await expect(Bun.file(confirmPath).exists()).resolves.toBe(false);
    expect(cleanupFailures).toEqual(['confirm-merge']);
  });

  test('publishes after a committed merge even when handoff cleanup fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-merge-cleanup-failure-'));
    roots.push(root);
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    await mkdir(inboxDirectory, { mode: 0o700, recursive: true });
    const storage = createLocalHistoryStorage(path.join(root, 'home'));
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    const cleanupFailures: string[] = [];
    let injectCleanupFailure = false;
    const port = createLiveUsageEngineMutationPort({
      configCwd: root,
      dbPath,
      inboxDirectory,
      machine,
      now: () => now,
      operatorCwd: root,
      readInput: async (input, options) => {
        const opened = await readUsageEngineInput(input, options);
        return injectCleanupFailure
          ? { ...opened, remove: () => Promise.reject(new Error('injected cleanup failure')) }
          : opened;
      },
      reportCleanupFailure: (operation) => cleanupFailures.push(operation),
      storage,
    });
    const peerMachine = { id: 'cleanup-failure-peer', label: 'Cleanup Failure Peer' };
    const row = normalizeUsageRow({
      calls: 1,
      cost: actualCost(null),
      date: now,
      endDate: now,
      harness: 'Codex',
      model: 'gpt-5',
      name: 'Cleanup failure session',
      project: 'ai-usage',
      provider: 'OpenAI',
      tokens: { cr: 0, cw: 0, in: 10, out: 5 },
    });
    const bundleText = serializeUsageMergeBundle(createUsageMergeBundle({ machine: peerMachine, rows: [row] }));
    const previewPath = path.join(inboxDirectory, 'merge-cleanup-preview.upload');
    await writeFile(previewPath, bundleText, { mode: 0o600 });
    const previewInput = {
      handoffId: parseUsageEngineHandoffId('merge-cleanup-preview'),
      kind: 'inbox-handoff' as const,
    };
    const preview = await port.previewMerge({ command: 'preview-merge', input: previewInput });
    await expect(Bun.file(previewPath).exists()).resolves.toBe(false);
    const confirmPath = path.join(inboxDirectory, 'merge-cleanup-confirm.upload');
    await writeFile(confirmPath, bundleText, { mode: 0o600 });
    injectCleanupFailure = true;

    await port.confirmMerge({
      command: 'confirm-merge',
      confirmationToken: preview.confirmationToken,
      documentDigest: preview.documentDigest,
      input: { handoffId: parseUsageEngineHandoffId('merge-cleanup-confirm'), kind: 'inbox-handoff' },
    });

    expect((await Effect.runPromise(queryReportRows({ dbPath }))).rows).toHaveLength(1);
    expect(await Bun.file(confirmPath).exists()).toBe(true);
    expect(cleanupFailures).toEqual(['confirm-merge']);
  });

  test('emits one privacy-safe engine diagnostic when committed handoff cleanup fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-cleanup-event-'));
    roots.push(root);
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    const temporaryRoot = path.join(root, 'temporary');
    await Promise.all([
      mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const capture = makeCaptureWideEventSink();
    const privateFailure = `${root}/private-cleanup-target`;
    let failCleanup = false;
    const runtime = createLiveUsageEngineRuntime({
      acquireWriterLease: async () => ({ release: async () => undefined }),
      codexLiveAvailable: () => false,
      configCwd: root,
      dbPath,
      inboxDirectory,
      instanceId: '66666666-6666-4666-8666-666666666666',
      now: () => now,
      operatorCwd: root,
      readInput: async (input, inputOptions) => {
        const opened = await readUsageEngineInput(input, inputOptions);
        return failCleanup ? { ...opened, remove: () => Promise.reject(new Error(privateFailure)) } : opened;
      },
      storage: createLocalHistoryStorage(path.join(root, 'home')),
      temporaryRoot,
      wideEventSinkLayer: Layer.merge(
        Layer.succeed(WideEventSink, capture),
        Layer.succeed(
          WideEventResourceService,
          makeAiUsageWideEventResource({
            instanceId: '66666666-6666-4666-8666-666666666666',
            nodeEnvironment: 'test',
            surface: 'engine',
          }),
        ),
      ),
    });
    await runtime.start();
    const previewHandoffId = parseUsageEngineHandoffId('cleanup-event-preview');
    const bundleText = serializeUsageMergeBundle(
      createUsageMergeBundle({ machine: { id: 'cleanup-event-peer', label: 'Cleanup Event Peer' }, rows: [] }),
    );
    await writeFile(path.join(inboxDirectory, `${previewHandoffId}.upload`), bundleText, { mode: 0o600 });
    await runtime.executeCommand(
      { command: 'preview-merge', input: { handoffId: previewHandoffId, kind: 'inbox-handoff' } },
      'cleanup-event-preview',
    );
    const previewCompletion = await runtime.waitForCommand('cleanup-event-preview');
    if (!(previewCompletion.state === 'succeeded' && previewCompletion.command === 'preview-merge')) {
      throw new Error('Cleanup event fixture did not produce a merge preview.');
    }
    const confirmHandoffId = parseUsageEngineHandoffId('cleanup-event-confirm');
    await writeFile(path.join(inboxDirectory, `${confirmHandoffId}.upload`), bundleText, { mode: 0o600 });
    failCleanup = true;
    await runtime.executeCommand(
      {
        command: 'confirm-merge',
        confirmationToken: previewCompletion.output.confirmationToken,
        documentDigest: previewCompletion.output.documentDigest,
        input: { handoffId: confirmHandoffId, kind: 'inbox-handoff' },
      },
      'cleanup-event-confirm',
    );
    await expect(runtime.waitForCommand('cleanup-event-confirm')).resolves.toMatchObject({ state: 'succeeded' });
    await runtime.dispose();

    const cleanupEvents = capture.events().filter((event) => event.boundary === 'handoff.cleanup');
    expect(cleanupEvents).toHaveLength(1);
    expect(cleanupEvents[0]).toMatchObject({
      annotations: { operation: 'confirm-merge' },
      outcome: 'failure',
      resource: { surface: 'engine' },
    });
    expect(JSON.stringify(cleanupEvents)).not.toContain(privateFailure);
    expect(JSON.stringify(cleanupEvents)).not.toContain(root);
  });

  test('emits a privacy-safe failed retention boundary after a committed publication', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-retention-event-'));
    roots.push(root);
    const inboxDirectory = path.join(root, 'state', 'inbox');
    const temporaryRoot = path.join(root, 'temporary');
    await Promise.all([
      mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const capture = makeCaptureWideEventSink();
    const privateFailure = `${root}/private-retention-target`;
    const instanceId = '99999999-9999-4999-8999-999999999999';
    const runtime = createLiveUsageEngineRuntime({
      acquireWriterLease: async () => ({ release: async () => undefined }),
      codexLiveAvailable: () => false,
      configCwd: root,
      dbPath: path.join(root, 'state', 'usage.sqlite'),
      inboxDirectory,
      instanceId,
      now: () => now,
      operatorCwd: root,
      retainRevisions: () => Promise.reject(new Error(privateFailure)),
      storage: createLocalHistoryStorage(path.join(root, 'home')),
      temporaryRoot,
      wideEventSinkLayer: Layer.merge(
        Layer.succeed(WideEventSink, capture),
        Layer.succeed(
          WideEventResourceService,
          makeAiUsageWideEventResource({ instanceId, nodeEnvironment: 'test', surface: 'engine' }),
        ),
      ),
    });

    await runtime.start();
    await runtime.dispose();

    const failedRetentionEvents = capture
      .events()
      .filter((event) => event.boundary === 'retention' && event.outcome === 'failure');
    expect(failedRetentionEvents).toHaveLength(1);
    expect(failedRetentionEvents[0]).toMatchObject({
      annotations: { phase: 'publication' },
      resource: { surface: 'engine' },
    });
    expect(JSON.stringify(failedRetentionEvents)).not.toContain(privateFailure);
    expect(JSON.stringify(failedRetentionEvents)).not.toContain(root);
  });

  test('starts lock-first against isolated paths and reports the initial durable revision ready', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-runtime-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    const temporaryRoot = path.join(root, 'legacy-temp');
    await Promise.all([
      mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const staleHandoffPath = path.join(inboxDirectory, 'startup-stale.upload');
    await writeFile(staleHandoffPath, 'stale', { mode: 0o600 });
    const staleTime = new Date(now.getTime() - 10 * 60 * 1000);
    await utimes(staleHandoffPath, staleTime, staleTime);
    const trace: string[] = [];
    const recovery: Array<{ deletedRoots: number; skippedSuspicious: number }> = [];
    let eventSinkAcquisitions = 0;
    let eventSinkReleases = 0;
    const wideEventSinkLayer = Layer.merge(
      Layer.scoped(
        WideEventSink,
        Effect.acquireRelease(
          Effect.sync(() => {
            eventSinkAcquisitions++;
            return noopWideEventSink;
          }),
          () => Effect.sync(() => eventSinkReleases++),
        ),
      ),
      testWideEventResourceLayer,
    );
    const runtime = createLiveUsageEngineRuntime({
      acquireWriterLease: () => {
        trace.push('lock');
        return Promise.resolve({
          release: () => {
            trace.push('unlock');
            return Promise.resolve();
          },
        });
      },
      codexLiveAvailable: () => false,
      configCwd: root,
      dbPath,
      inboxDirectory,
      instanceId: '33333333-3333-4333-8333-333333333333',
      now: () => now,
      operatorCwd: root,
      reportRecovery: (result) => recovery.push(result),
      storage: createLocalHistoryStorage(home),
      temporaryRoot,
      wideEventSinkLayer,
    });

    await runtime.start();
    const status = await runtime.status();
    const current = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: now.getTime() }));

    expect(trace).toEqual(['lock']);
    expect(status).toMatchObject({
      currentPublication: { revision: current.revision },
      readiness: 'ready',
      storeSchemaVersion: expect.any(Number),
    });
    expect(recovery).toEqual([
      expect.objectContaining({
        deletedInboxBytes: 5,
        deletedInboxFiles: 1,
        deletedRoots: 0,
        skippedSuspicious: 0,
      }),
    ]);
    expect(eventSinkAcquisitions).toBe(1);
    await expect(Bun.file(staleHandoffPath).exists()).resolves.toBe(false);
    await runtime.dispose();
    expect(trace).toEqual(['lock', 'unlock']);
    expect(eventSinkReleases).toBe(1);
  });

  test('removes abandoned incomplete revisions before publishing the initial ready revision', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'plan052-engine-incomplete-revision-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const dbPath = path.join(root, 'state', 'usage.sqlite');
    const inboxDirectory = path.join(root, 'state', 'inbox');
    const temporaryRoot = path.join(root, 'legacy-temp');
    await Promise.all([
      mkdir(inboxDirectory, { mode: 0o700, recursive: true }),
      mkdir(temporaryRoot, { mode: 0o700, recursive: true }),
    ]);
    const storage = createLocalHistoryStorage(home);
    await Effect.runPromise(initializeUsageStore({ dbPath }));
    await Effect.runPromise(writeMachineConfig(machine).pipe(Effect.provideService(LocalHistoryStorage, storage)));
    const { Database } = await import('bun:sqlite');
    const database = new Database(dbPath, { create: false, readwrite: true });
    const abandonedPublishedAt = now.getTime() - 6 * 60 * 1000;
    database
      .query(`
        INSERT INTO served_report_revisions (
          revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
          usage_store_generation, machine_fleet_generation, projection_schema_version,
          generated_at, published_at, expires_at, complete, row_count, segment_count,
          filter_key_count, rows_bytes, support_bytes, projection_bytes
        ) VALUES (?, ?, ?, ?, 0, 0, 14, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
      `)
      .run(
        'abandoned-incomplete',
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
        new Date(abandonedPublishedAt).toISOString(),
        abandonedPublishedAt,
        now.getTime() + 60 * 60 * 1000,
      );
    database.close(true);

    const runtime = createLiveUsageEngineRuntime({
      acquireWriterLease: async () => ({ release: async () => undefined }),
      codexLiveAvailable: () => false,
      configCwd: root,
      dbPath,
      inboxDirectory,
      instanceId: '44444444-4444-4444-8444-444444444444',
      now: () => now,
      operatorCwd: root,
      storage,
      temporaryRoot,
      wideEventSinkLayer: makeTestWideEventSinkLayer(noopWideEventSink),
    });

    await runtime.start();
    const current = await Effect.runPromise(queryCurrentServedReportRevision({ dbPath, now: now.getTime() }));
    const inspection = new Database(dbPath, { create: false, readonly: true });
    const abandonedCount = inspection
      .query('SELECT COUNT(*) AS count FROM served_report_revisions WHERE revision = ?')
      .get('abandoned-incomplete') as { count: number };
    const currentComplete = inspection
      .query('SELECT complete FROM served_report_revisions WHERE revision = ?')
      .get(current.revision) as { complete: number };
    inspection.close(false);

    expect(abandonedCount.count).toBe(0);
    expect(currentComplete.complete).toBe(1);
    expect((await runtime.status()).currentPublication?.revision).toBe(
      parseUsageEnginePublicationRevision(current.revision),
    );
    await runtime.dispose();
  });
});
