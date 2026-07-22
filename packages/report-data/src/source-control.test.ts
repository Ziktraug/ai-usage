import { describe, expect, test } from 'bun:test';
import {
  makeCaptureWideEventSink,
  makeTestWideEventSinkLayer,
  noopWideEventSink,
  type WideEventSnapshot,
} from '@ai-usage/effect-runtime';
import {
  type CollectionSourceId,
  type SourceControlView,
  type SourceDetectionResult,
  type SourcePolicyOverrides,
  updateSourcePolicyOverrides,
} from '@ai-usage/report-core/source-control';
import { Deferred, Duration, Effect, Layer, Ref, TestClock, TestContext } from 'effect';
import type { ScheduledSource } from './source-adapters';
import { SourceRunError } from './source-adapters';
import {
  createSourceControl,
  type ReportPublicationPort,
  type SourceControlService,
  type SourcePolicyStore,
} from './source-control';

const testEnvLayer = Layer.merge(TestContext.TestContext, makeTestWideEventSinkLayer(noopWideEventSink));

const withCaptureSink = () => {
  const sink = makeCaptureWideEventSink();
  return { events: sink.events, layer: Layer.merge(TestContext.TestContext, makeTestWideEventSinkLayer(sink)) };
};

const boundaryEvents = (events: readonly WideEventSnapshot[], boundary: string): readonly WideEventSnapshot[] =>
  events.filter((event) => event.boundary === boundary);

const detected: SourceDetectionResult = {
  availability: 'detected',
  reason: { code: 'none' },
};

const successResult = (changed = false) => ({
  changed,
  inputCount: 1,
  outputCount: 1,
  warnings: [],
});

const fakeSource = (
  id: CollectionSourceId,
  run: ScheduledSource['run'],
  detect: ScheduledSource['detect'] = Effect.succeed(detected),
  cadence: Duration.DurationInput = Duration.minutes(1),
): ScheduledSource => ({
  cadence: Duration.decode(cadence),
  detect,
  id,
  run,
});

const waitFor = (
  control: SourceControlService,
  predicate: (snapshot: SourceControlView) => boolean,
): Effect.Effect<SourceControlView> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const snapshot = yield* control.getSnapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
      yield* Effect.yieldNow();
    }
    return yield* Effect.die(new Error('Timed out waiting for source-control state'));
  });

const sourceView = (snapshot: SourceControlView, sourceId: CollectionSourceId) => {
  const source = snapshot.sources.find(({ id }) => id === sourceId);
  if (!source) {
    throw new Error(`Missing source view: ${sourceId}`);
  }
  return source;
};

const makePolicyStore = (
  initial: SourcePolicyOverrides = {},
): Effect.Effect<{ policies: Ref.Ref<SourcePolicyOverrides>; store: SourcePolicyStore }> =>
  Effect.gen(function* () {
    const policies = yield* Ref.make(initial);
    return {
      policies,
      store: {
        load: Ref.get(policies),
        setEnabled: (sourceId, enabled) =>
          Ref.update(policies, (current) => updateSourcePolicyOverrides(current, sourceId, enabled) ?? {}),
      },
    };
  });

const makePublication = (
  events: Ref.Ref<string[]>,
): Effect.Effect<{ calls: Ref.Ref<number>; port: ReportPublicationPort }> =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    return {
      calls,
      port: {
        publish: Effect.gen(function* () {
          const call = yield* Ref.updateAndGet(calls, (value) => value + 1);
          yield* Ref.update(events, (current) => [...current, `publish:${call}`]);
          return { changed: true, revision: `revision-${call}` };
        }),
      },
    };
  });

describe('source control plane', () => {
  test('detects disabled sources, runs enabled sources, and publishes bootstrap last', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore({ 'codex.sessions': { enabled: false } });
        const publication = yield* makePublication(events);
        const claudeRuns = yield* Ref.make(0);
        const codexDetections = yield* Ref.make(0);
        const codexRuns = yield* Ref.make(0);
        const sources = new Map<CollectionSourceId, ScheduledSource>([
          [
            'claude.sessions',
            fakeSource('claude.sessions', () =>
              Effect.gen(function* () {
                yield* Ref.update(claudeRuns, (count) => count + 1);
                yield* Ref.update(events, (current) => [...current, 'run:claude']);
                return successResult();
              }),
            ),
          ],
          [
            'codex.sessions',
            fakeSource(
              'codex.sessions',
              () => Ref.updateAndGet(codexRuns, (count) => count + 1).pipe(Effect.as(successResult())),
              Ref.updateAndGet(codexDetections, (count) => count + 1).pipe(Effect.as(detected)),
            ),
          ],
        ]);
        const control = yield* createSourceControl({
          instanceId: 'test-instance',
          policyStore: store,
          publication: publication.port,
          sources,
        });

        const snapshot = yield* waitFor(
          control,
          (view) =>
            sourceView(view, 'claude.sessions').lastOutcome === 'success' && view.publication.revision === 'revision-1',
        );
        expect(yield* Ref.get(claudeRuns)).toBe(1);
        expect(yield* Ref.get(codexDetections)).toBe(1);
        expect(sourceView(snapshot, 'codex.sessions')).toMatchObject({
          availability: 'detected',
          lifecycle: 'dormant',
          policy: 'disabled',
        });
        expect(yield* Ref.get(events)).toEqual(['run:claude', 'publish:1']);

        yield* control.setEnabled('codex.sessions', true);
        yield* waitFor(control, (view) => sourceView(view, 'codex.sessions').lastOutcome === 'success');
        expect(yield* Ref.get(codexRuns)).toBe(1);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    const runEvents = boundaryEvents(capture.events(), 'source.run');
    expect(runEvents).toHaveLength(2);
    expect(runEvents[0]).toMatchObject({
      annotations: {
        changed: false,
        domainOutcome: 'success',
        inputCount: 1,
        outputCount: 1,
        queueDelayMs: 0,
        sourceId: 'claude.sessions',
        trigger: 'detection',
        warningsCount: 0,
      },
      outcome: 'success',
      services: [{ name: 'source.execute', outcome: 'success' }],
    });
    expect(runEvents[1]).toMatchObject({
      annotations: { sourceId: 'codex.sessions', trigger: 'manual' },
      outcome: 'success',
    });
    const publicationEvents = boundaryEvents(capture.events(), 'publication');
    expect(publicationEvents).toHaveLength(1);
    expect(publicationEvents[0]).toMatchObject({
      annotations: {
        changed: true,
        dataTarget: 0,
        previousPublishedGeneration: 0,
        queueDelayMs: 0,
        requestTarget: 1,
        revision: 'revision-1',
      },
      outcome: 'success',
      services: [{ name: 'publication.publish', outcome: 'success' }],
    });
  });

  test('uses completion-relative cadence and resets it after a manual run', async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const runs = yield* Ref.make(0);
        const source = fakeSource('claude.sessions', () =>
          Ref.updateAndGet(runs, (count) => count + 1).pipe(Effect.map(() => successResult())),
        );
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources: new Map([['claude.sessions', source]]),
        });
        yield* waitFor(control, (view) => sourceView(view, 'claude.sessions').lastOutcome === 'success');

        yield* TestClock.adjust(Duration.seconds(30));
        expect(yield* control.runNow('claude.sessions')).toBe(true);
        expect(yield* control.runAllEnabled).toBe(0);
        yield* waitFor(control, () => Effect.runSync(Ref.get(runs)) === 2);
        yield* TestClock.adjust(Duration.seconds(59));
        expect(yield* Ref.get(runs)).toBe(2);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* waitFor(control, () => Effect.runSync(Ref.get(runs)) === 3);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(testEnvLayer)));
  });

  test('retries failures at normal cadence', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const runs = yield* Ref.make(0);
        const source = fakeSource('claude.sessions', () =>
          Effect.gen(function* () {
            const run = yield* Ref.updateAndGet(runs, (count) => count + 1);
            if (run === 1) {
              return yield* Effect.fail(
                new SourceRunError({
                  cause: new Error('private failure'),
                  message: 'safe',
                  sourceId: 'claude.sessions',
                }),
              );
            }
            return successResult();
          }),
        );
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources: new Map([['claude.sessions', source]]),
        });
        const failed = yield* waitFor(control, (view) => sourceView(view, 'claude.sessions').lastOutcome === 'failed');
        expect(sourceView(failed, 'claude.sessions').reason.code).toBe('run-failed');

        yield* TestClock.adjust(Duration.minutes(1));
        const recovered = yield* waitFor(
          control,
          (view) => sourceView(view, 'claude.sessions').lastOutcome === 'success',
        );
        expect(sourceView(recovered, 'claude.sessions').lastSuccessAt).toBeDefined();
        expect(yield* Ref.get(runs)).toBe(2);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));
    const [failedEvent, recoveredEvent] = boundaryEvents(capture.events(), 'source.run');
    expect(failedEvent).toMatchObject({
      annotations: { failureKind: 'source-run-error', trigger: 'detection' },
      outcome: 'failure',
    });
    expect(JSON.stringify(failedEvent)).not.toContain('private failure');
    expect(recoveredEvent?.annotations.trigger).toBe('cadence');
  });

  test('lets a running source finish while disabling prevents future runs', async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { policies, store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const source = fakeSource('claude.sessions', () =>
          Effect.gen(function* () {
            yield* Ref.update(runs, (count) => count + 1);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return successResult(true);
          }),
        );
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources: new Map([['claude.sessions', source]]),
        });
        yield* Deferred.await(started);
        expect(yield* control.runNow('claude.sessions')).toBe(false);
        yield* control.setEnabled('claude.sessions', false);
        const pausing = yield* control.getSnapshot;
        expect(sourceView(pausing, 'claude.sessions').lifecycle).toBe('pausing');

        yield* Deferred.succeed(release, undefined);
        const stopped = yield* waitFor(
          control,
          (view) =>
            sourceView(view, 'claude.sessions').lastOutcome === 'success' &&
            sourceView(view, 'claude.sessions').lifecycle === 'dormant',
        );
        expect(sourceView(stopped, 'claude.sessions').policy).toBe('disabled');
        yield* TestClock.adjust(Duration.minutes(5));
        expect(yield* Ref.get(runs)).toBe(1);
        expect((yield* Ref.get(policies))['claude.sessions']).toEqual({ enabled: false });
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(testEnvLayer)));
  });

  test('consumes stale queued policy jobs and requeues the current revision', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const releaseClaude = yield* Deferred.make<void>();
        const claudeStarted = yield* Deferred.make<void>();
        const codexRuns = yield* Ref.make(0);
        const sources = new Map<CollectionSourceId, ScheduledSource>([
          [
            'claude.sessions',
            fakeSource('claude.sessions', () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(claudeStarted, undefined);
                yield* Deferred.await(releaseClaude);
                return successResult();
              }),
            ),
          ],
          [
            'codex.sessions',
            fakeSource('codex.sessions', () =>
              Ref.updateAndGet(codexRuns, (count) => count + 1).pipe(Effect.as(successResult())),
            ),
          ],
        ]);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources,
        });
        yield* Deferred.await(claudeStarted);
        yield* control.setEnabled('codex.sessions', false);
        yield* control.setEnabled('codex.sessions', true);
        yield* Deferred.succeed(releaseClaude, undefined);
        yield* waitFor(control, (view) => sourceView(view, 'codex.sessions').lastOutcome === 'success');
        expect(yield* Ref.get(codexRuns)).toBe(1);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    // The stale queued codex job that startSourceJobTransition skipped never gets a boundary event;
    // only the two jobs that actually ran (claude, then the requeued codex) do.
    const runEvents = boundaryEvents(capture.events(), 'source.run');
    expect(runEvents.map((event) => event.annotations.sourceId)).toEqual(['claude.sessions', 'codex.sessions']);
    expect(runEvents.every((event) => event.outcome === 'success')).toBe(true);
  });

  test('keeps an unavailable source dormant until explicit redetection', async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const availability = yield* Ref.make<SourceDetectionResult>(detected);
        const runs = yield* Ref.make(0);
        const source = fakeSource(
          'claude.sessions',
          () =>
            Ref.updateAndGet(runs, (count) => count + 1).pipe(
              Effect.map((run) =>
                run === 1
                  ? {
                      ...successResult(),
                      unavailable: { code: 'run-unavailable' as const },
                    }
                  : successResult(),
              ),
            ),
          Ref.get(availability),
        );
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources: new Map([['claude.sessions', source]]),
        });
        const dormant = yield* waitFor(
          control,
          (view) => sourceView(view, 'claude.sessions').availability === 'not-detected',
        );
        expect(sourceView(dormant, 'claude.sessions').lifecycle).toBe('dormant');
        yield* TestClock.adjust(Duration.minutes(5));
        expect(yield* Ref.get(runs)).toBe(1);

        yield* Ref.set(availability, detected);
        yield* control.detectAll;
        yield* waitFor(control, (view) => sourceView(view, 'claude.sessions').lastOutcome === 'success');
        expect(yield* Ref.get(runs)).toBe(2);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(testEnvLayer)));
  });

  test('orders producer, RTK, and coalesced publication with one worker', async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const sources = new Map<CollectionSourceId, ScheduledSource>([
          [
            'claude.sessions',
            fakeSource('claude.sessions', () =>
              Ref.update(events, (current) => [...current, 'run:claude']).pipe(Effect.as(successResult(true))),
            ),
          ],
          [
            'rtk.savings',
            fakeSource('rtk.savings', () =>
              Ref.update(events, (current) => [...current, 'run:rtk']).pipe(Effect.as(successResult(true))),
            ),
          ],
        ]);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources,
        });
        yield* waitFor(control, (view) => view.publication.revision === 'revision-1');
        expect(yield* Ref.get(events)).toEqual(['run:claude', 'run:rtk', 'publish:1']);
        expect(yield* Ref.get(publication.calls)).toBe(1);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(testEnvLayer)));
  });

  test('correlates a changed source generation with the publication interval', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources: new Map([
            [
              'cursor.commit-attribution',
              fakeSource('cursor.commit-attribution', () => Effect.succeed(successResult(true))),
            ],
          ]),
        });
        yield* waitFor(control, (view) => view.publication.revision === 'revision-1');
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    const sourceEvent = boundaryEvents(capture.events(), 'source.run')[0];
    const publicationEvent = boundaryEvents(capture.events(), 'publication')[0];
    expect(sourceEvent?.annotations).toMatchObject({
      publicationDataGeneration: 1,
      sourceId: 'cursor.commit-attribution',
      trigger: 'detection',
    });
    expect(publicationEvent?.annotations).toMatchObject({
      dataTarget: 1,
      previousPublishedGeneration: 0,
      requestTarget: 2,
    });
  });

  test('records publication demand arriving during a running attempt and coalesces a successor', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* makePolicyStore();
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: {
            publish: Effect.gen(function* () {
              const call = yield* Ref.updateAndGet(calls, (value) => value + 1);
              if (call === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              return { changed: true, revision: `revision-${call}` };
            }),
          },
          sources: new Map(),
        });
        yield* Deferred.await(firstStarted);
        expect(yield* control.requestPublication).toBe(true);
        expect(yield* control.requestPublication).toBe(true);
        yield* Deferred.succeed(releaseFirst, undefined);
        const settled = yield* waitFor(
          control,
          (view) =>
            view.publication.revision === 'revision-2' &&
            view.publication.acknowledgedRequestGeneration === view.publication.requestedGeneration,
        );
        expect(yield* Ref.get(calls)).toBe(2);
        expect(settled.publication.requestedGeneration).toBe(3);
        expect(settled.publication.pendingDemand).toBe(false);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    const publicationEvents = boundaryEvents(capture.events(), 'publication');
    expect(publicationEvents.map((event) => event.annotations.revision)).toEqual(['revision-1', 'revision-2']);
    expect(publicationEvents.every((event) => event.outcome === 'success')).toBe(true);
  });

  test('records a bounded publication failure kind without the port cause', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const { store } = yield* makePolicyStore();
        const control = yield* createSourceControl({
          policyStore: store,
          publication: { publish: Effect.fail(new Error('private publication cause')) },
          sources: new Map(),
        });
        yield* waitFor(control, (view) => view.publication.lastOutcome === 'failed');
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));
    const event = boundaryEvents(capture.events(), 'publication')[0];
    expect(event).toMatchObject({
      annotations: { failureKind: 'publication-failed' },
      outcome: 'failure',
    });
    expect(JSON.stringify(event)).not.toContain('private publication cause');
  });

  test('does not publish again for an unchanged periodic RTK run', async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const rtkRuns = yield* Ref.make(0);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources: new Map([
            [
              'rtk.savings',
              fakeSource('rtk.savings', () =>
                Ref.updateAndGet(rtkRuns, (value) => value + 1).pipe(Effect.as(successResult(false))),
              ),
            ],
          ]),
        });
        yield* waitFor(control, (view) => view.publication.revision === 'revision-1');
        yield* TestClock.adjust(Duration.minutes(1));
        yield* waitFor(control, () => Effect.runSync(Ref.get(rtkRuns)) === 2);
        expect(yield* Ref.get(publication.calls)).toBe(1);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(testEnvLayer)));
  });

  test('does not lose a producer change while RTK is already running with multiple workers', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const claudeStarted = yield* Deferred.make<void>();
        const releaseClaude = yield* Deferred.make<void>();
        const rtkStarted = yield* Deferred.make<void>();
        const releaseFirstRtk = yield* Deferred.make<void>();
        const rtkRuns = yield* Ref.make(0);
        const sources = new Map<CollectionSourceId, ScheduledSource>([
          [
            'claude.sessions',
            fakeSource('claude.sessions', () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(claudeStarted, undefined);
                yield* Deferred.await(releaseClaude);
                yield* Ref.update(events, (current) => [...current, 'run:claude']);
                return successResult(true);
              }),
            ),
          ],
          [
            'rtk.savings',
            fakeSource('rtk.savings', () =>
              Effect.gen(function* () {
                const run = yield* Ref.updateAndGet(rtkRuns, (count) => count + 1);
                if (run === 1) {
                  yield* Deferred.succeed(rtkStarted, undefined);
                  yield* Deferred.await(releaseFirstRtk);
                }
                yield* Ref.update(events, (current) => [...current, `run:rtk:${run}`]);
                return successResult(run === 2);
              }),
            ),
          ],
        ]);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sources,
          workerCount: 2,
        });
        yield* Deferred.await(claudeStarted);
        yield* Deferred.await(rtkStarted);
        yield* Deferred.succeed(releaseFirstRtk, undefined);
        yield* Deferred.succeed(releaseClaude, undefined);
        const published = yield* waitFor(
          control,
          (view) =>
            sourceView(view, 'claude.sessions').lastOutcome === 'success' &&
            sourceView(view, 'rtk.savings').lastOutcome === 'success' &&
            view.publication.dirty === false &&
            view.publication.revision !== undefined,
        );

        expect(yield* Ref.get(rtkRuns)).toBe(2);
        expect(sourceView(published, 'claude.sessions').lastOutcome).toBe('success');
        const finalEvents = yield* Ref.get(events);
        expect(finalEvents.indexOf('run:rtk:2')).toBeLessThan(
          finalEvents.findLastIndex((event) => event.startsWith('publish:')),
        );
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    // Concurrent workers must produce isolated wide events: distinct ids and a hop tree
    // scoped to its own job, never leaking another worker's hop into it.
    const runEvents = boundaryEvents(capture.events(), 'source.run');
    expect(runEvents).toHaveLength(3);
    expect(new Set(runEvents.map((event) => event.eventId)).size).toBe(3);
    for (const event of runEvents) {
      expect(event.services).toHaveLength(1);
      expect(event.services[0]?.name).toBe('source.execute');
    }
  });

  test('interrupts running sources when its scope closes', async () => {
    const capture = withCaptureSink();
    const program = Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      const interrupted = yield* Ref.make(false);
      const started = yield* Deferred.make<void>();
      const { store } = yield* makePolicyStore();
      const publication = yield* makePublication(events);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* createSourceControl({
            policyStore: store,
            publication: publication.port,
            sources: new Map([
              [
                'claude.sessions',
                fakeSource('claude.sessions', () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Ref.set(interrupted, true)),
                  ),
                ),
              ],
            ]),
          });
          yield* Deferred.await(started);
        }),
      );
      expect(yield* Ref.get(interrupted)).toBe(true);
    });

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    // Active shutdown interrupts the boundary's own finalizer, which still emits the event.
    const runEvents = boundaryEvents(capture.events(), 'source.run');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]).toMatchObject({ outcome: 'interrupted' });
  });

  test('times out a stuck source, aborts its provider signal, and prevents its write', async () => {
    const capture = withCaptureSink();
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([]);
        const started = yield* Deferred.make<void>();
        const aborted = yield* Ref.make(false);
        const wrote = yield* Ref.make(false);
        const { store } = yield* makePolicyStore();
        const publication = yield* makePublication(events);
        const control = yield* createSourceControl({
          policyStore: store,
          publication: publication.port,
          sourceTimeout: Duration.seconds(30),
          sources: new Map([
            [
              'claude.sessions',
              fakeSource('claude.sessions', (context) =>
                Effect.async((resume) => {
                  Effect.runSync(Deferred.succeed(started, undefined));
                  const onAbort = (): void => {
                    Effect.runSync(Ref.set(aborted, true));
                    if (!context.signal?.aborted) {
                      Effect.runSync(Ref.set(wrote, true));
                    }
                    resume(Effect.succeed(successResult(true)));
                  };
                  context.signal?.addEventListener('abort', onAbort, { once: true });
                }),
              ),
            ],
          ]),
        });
        yield* Deferred.await(started);
        yield* TestClock.adjust(Duration.seconds(30));
        const snapshot = yield* waitFor(
          control,
          (view) => sourceView(view, 'claude.sessions').lastOutcome === 'timed-out',
        );
        expect(sourceView(snapshot, 'claude.sessions').reason).toEqual({
          code: 'timed-out',
          message: 'The source run timed out; previously stored data was preserved.',
        });
        expect(yield* Ref.get(aborted)).toBe(true);
        expect(yield* Ref.get(wrote)).toBe(false);
      }),
    );

    await Effect.runPromise(program.pipe(Effect.provide(capture.layer)));

    const runEvents = boundaryEvents(capture.events(), 'source.run');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]).toMatchObject({
      annotations: {
        domainOutcome: 'timed-out',
        failureKind: 'source-timeout',
        sourceId: 'claude.sessions',
        trigger: 'detection',
      },
      outcome: 'timed-out',
      services: [{ name: 'source.execute', outcome: 'interrupted' }],
    });
  });
});
