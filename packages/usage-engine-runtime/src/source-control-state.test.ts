import { describe, expect, test } from 'bun:test';
import {
  admitPublicationJob,
  admitSourceJob,
  applyDetectionTransition,
  finishPublicationJobTransition,
  finishSourceJobTransition,
  initialSourceControlState,
  lifecycleAfterPolicyChange,
  outcomeAfterRun,
  type PublicationJob,
  publicationSettleDecision,
  reasonAfterCompletion,
  reasonForAvailability,
  requestPublicationTransition,
  scheduleSourceTransition,
  setSourcePolicyTransition,
  sourceControlView,
  startPublicationJobTransition,
  startSourceJobTransition,
} from './source-control-state';

const detected = { availability: 'detected', reason: { code: 'none' } } as const;

const completionCases = [
  ['timed-out', { _tag: 'timed-out', failureKind: 'source-timeout' } as const, 'timed-out', 'timed-out'],
  ['failed', { _tag: 'failed', failureKind: 'source-run-error' } as const, 'failed', 'run-failed'],
  [
    'unavailable',
    {
      _tag: 'success',
      result: {
        changed: false,
        inputCount: 0,
        outputCount: 0,
        unavailable: { code: 'input-missing', message: 'Missing.' },
        warnings: [],
      },
    } as const,
    'skipped',
    'input-missing',
  ],
] as const;

const detectedState = (...sourceIds: Parameters<typeof initialSourceControlState>[1]) => {
  let state = initialSourceControlState('instance-a', sourceIds, {}, 0);
  let now = 1;
  for (const sourceId of sourceIds) {
    state = applyDetectionTransition(state, sourceId, detected, now++).state;
  }
  return state;
};

describe('source control state transitions', () => {
  test('projects monotonic publication demand and independent RTK watermarks', () => {
    const initial = initialSourceControlState('instance-a', ['claude.sessions'], {}, 0);
    const state = {
      ...initial,
      publication: {
        ...initial.publication,
        acknowledgedRequestGeneration: 2,
        dirtyGeneration: 4,
        publishedGeneration: 3,
        requestedGeneration: 5,
      },
      rtkCompletedGeneration: 2,
      rtkRequiredGeneration: 4,
    };
    expect(sourceControlView(state).publication).toMatchObject({
      dirty: true,
      pendingDemand: true,
      rtkCompletedGeneration: 2,
      rtkRequiredGeneration: 4,
    });
  });

  test('classifies timeout distinctly and re-enables unavailable state without a disabled reason', () => {
    const source = initialSourceControlState('instance-a', ['claude.sessions'], {}, 0).sources['claude.sessions'];
    const timedOut = { _tag: 'timed-out', failureKind: 'source-timeout' } as const;
    expect(outcomeAfterRun(timedOut, undefined, 0)).toBe('timed-out');
    expect(reasonAfterCompletion(timedOut, undefined, true).code).toBe('timed-out');
    expect(lifecycleAfterPolicyChange({ ...source, availability: 'not-detected' }, true)).toBe('dormant');
    expect(reasonForAvailability('not-detected').code).toBe('input-missing');
  });

  test('keeps a picked run in pausing when policy is disabled', () => {
    const source = initialSourceControlState('instance-a', ['claude.sessions'], {}, 0).sources['claude.sessions'];
    expect(lifecycleAfterPolicyChange({ ...source, lifecycle: 'running', running: true }, false)).toBe('pausing');
  });

  test('balances queue depth for accepted, rejected, stale, and completed source jobs', () => {
    const initial = detectedState('claude.sessions');
    const accepted = admitSourceJob(initial, 'claude.sessions', true, 10, 'detection');
    const rejected = admitSourceJob(accepted.state, 'claude.sessions', true, 11, 'manual');
    expect(accepted.state.queueDepth).toBe(1);
    expect(rejected.decision).toBeUndefined();
    expect(rejected.state).toBe(accepted.state);

    const disabled = setSourcePolicyTransition(accepted.state, 'claude.sessions', false, 12);
    expect(disabled.state.sources['claude.sessions'].queued).toBe(true);
    const stale = startSourceJobTransition(disabled.state, accepted.decision!, 13);
    expect(stale.decision.run).toBe(false);
    expect(stale.state.queueDepth).toBe(0);

    const reEnabled = setSourcePolicyTransition(stale.state, 'claude.sessions', true, 14).state;
    const queued = admitSourceJob(reEnabled, 'claude.sessions', true, 15, 'manual');
    const started = startSourceJobTransition(queued.state, queued.decision!, 16);
    const finished = finishSourceJobTransition(
      started.state,
      queued.decision!,
      16,
      started.decision.rtkTargetGeneration,
      { _tag: 'success', result: { changed: false, inputCount: 1, outputCount: 1, warnings: [] } },
      17,
    );
    expect(started.state.queueDepth).toBe(0);
    expect(finished.state.queueDepth).toBe(0);
    expect(finished.state.sources['claude.sessions'].running).toBe(false);
  });

  test('preserves disable-after-pick and re-enables unavailable sources with an availability reason', () => {
    const initial = detectedState('claude.sessions');
    const queued = admitSourceJob(initial, 'claude.sessions', true, 10, 'detection');
    const started = startSourceJobTransition(queued.state, queued.decision!, 11);
    const disabled = setSourcePolicyTransition(started.state, 'claude.sessions', false, 12);
    expect(disabled.state.sources['claude.sessions'].lifecycle).toBe('pausing');
    const finished = finishSourceJobTransition(
      disabled.state,
      queued.decision!,
      11,
      started.decision.rtkTargetGeneration,
      { _tag: 'success', result: { changed: false, inputCount: 0, outputCount: 0, warnings: [] } },
      13,
    );
    expect(finished.state.sources['claude.sessions']).toMatchObject({
      enabled: false,
      lifecycle: 'dormant',
      reason: { code: 'policy-disabled' },
    });

    const unavailable = applyDetectionTransition(
      finished.state,
      'claude.sessions',
      { availability: 'not-detected', reason: { code: 'input-missing', message: 'Missing.' } },
      14,
    ).state;
    const reEnabled = setSourcePolicyTransition(unavailable, 'claude.sessions', true, 15).state;
    expect(reEnabled.sources['claude.sessions']).toMatchObject({
      lifecycle: 'dormant',
      reason: { code: 'input-missing' },
    });
  });

  test.each(completionCases)('classifies %s source completion', (_label, completion, outcome, reason) => {
    const initial = detectedState('claude.sessions');
    const queued = admitSourceJob(initial, 'claude.sessions', true, 10, 'detection');
    const started = startSourceJobTransition(queued.state, queued.decision!, 11);
    const finished = finishSourceJobTransition(
      started.state,
      queued.decision!,
      11,
      started.decision.rtkTargetGeneration,
      completion,
      12,
    );
    expect(finished.state.sources['claude.sessions'].lastOutcome).toBe(outcome);
    expect(finished.state.sources['claude.sessions'].reason.code).toBe(reason);
  });

  test('does not record a first success when a source run times out', () => {
    const initial = detectedState('claude.sessions');
    const queued = admitSourceJob(initial, 'claude.sessions', true, 10, 'detection');
    const started = startSourceJobTransition(queued.state, queued.decision!, 11);
    const finished = finishSourceJobTransition(
      started.state,
      queued.decision!,
      11,
      started.decision.rtkTargetGeneration,
      { _tag: 'timed-out', failureKind: 'source-timeout' },
      12,
    );

    expect(finished.state.sources['claude.sessions'].lastSuccessAt).toBeUndefined();
  });

  test('preserves the previous success timestamp when a later source run times out', () => {
    const initial = detectedState('claude.sessions');
    const firstQueued = admitSourceJob(initial, 'claude.sessions', true, 10, 'detection');
    const firstStarted = startSourceJobTransition(firstQueued.state, firstQueued.decision!, 11);
    const succeeded = finishSourceJobTransition(
      firstStarted.state,
      firstQueued.decision!,
      11,
      firstStarted.decision.rtkTargetGeneration,
      { _tag: 'success', result: { changed: false, inputCount: 1, outputCount: 1, warnings: [] } },
      12,
    );
    const lastSuccessAt = succeeded.state.sources['claude.sessions'].lastSuccessAt;
    const secondQueued = admitSourceJob(succeeded.state, 'claude.sessions', true, 20, 'cadence');
    const secondStarted = startSourceJobTransition(secondQueued.state, secondQueued.decision!, 21);
    const timedOut = finishSourceJobTransition(
      secondStarted.state,
      secondQueued.decision!,
      21,
      secondStarted.decision.rtkTargetGeneration,
      { _tag: 'timed-out', failureKind: 'source-timeout' },
      22,
    );

    expect(lastSuccessAt).toBe('1970-01-01T00:00:00.012Z');
    expect(timedOut.state.sources['claude.sessions'].lastSuccessAt).toBe(lastSuccessAt);
  });

  test('releases producer dirty data only after the captured RTK dependency completes', () => {
    let state = detectedState('claude.sessions', 'rtk.savings');
    const producer = admitSourceJob(state, 'claude.sessions', true, 10, 'detection');
    const producerStart = startSourceJobTransition(producer.state, producer.decision!, 11);
    const producerFinish = finishSourceJobTransition(
      producerStart.state,
      producer.decision!,
      11,
      producerStart.decision.rtkTargetGeneration,
      { _tag: 'success', result: { changed: true, inputCount: 1, outputCount: 1, warnings: [] } },
      12,
    );
    state = producerFinish.state;
    expect(state.publication.dirtyGeneration).toBe(1);
    expect(state.rtkRequiredGeneration).toBe(1);
    expect(producerFinish.decision.needsRtk).toBe(true);

    const rtk = admitSourceJob(state, 'rtk.savings', true, 13, 'dependency');
    const rtkStart = startSourceJobTransition(rtk.state, rtk.decision!, 14);
    const rtkFinish = finishSourceJobTransition(
      rtkStart.state,
      rtk.decision!,
      14,
      rtkStart.decision.rtkTargetGeneration,
      { _tag: 'success', result: { changed: false, inputCount: 1, outputCount: 1, warnings: [] } },
      15,
    );
    expect(rtkFinish.state.rtkCompletedGeneration).toBe(1);
    expect(rtkFinish.decision.needsPublicationWake).toBe(true);
  });

  test('publishes fleet-only observations without scheduling RTK', () => {
    const initial = detectedState('claude.sessions', 'rtk.savings');
    const producer = admitSourceJob(initial, 'claude.sessions', true, 10, 'detection');
    const started = startSourceJobTransition(producer.state, producer.decision!, 11);
    const finished = finishSourceJobTransition(
      started.state,
      producer.decision!,
      11,
      started.decision.rtkTargetGeneration,
      {
        _tag: 'success',
        result: { changed: false, inputCount: 1, outputCount: 1, servedProjectionChanged: true, warnings: [] },
      },
      12,
    );

    expect(finished.decision).toMatchObject({
      changed: false,
      needsPublicationWake: true,
      needsRtk: false,
      servedProjectionChanged: true,
    });
    expect(finished.state.publication.dirtyGeneration).toBe(1);
    expect(finished.state.publication.requestedGeneration).toBe(1);
    expect(finished.state.rtkRequiredGeneration).toBe(0);
  });

  test('captures and acknowledges publication targets without losing demand arriving during a run', () => {
    const requested = requestPublicationTransition(initialSourceControlState('instance-a', [], {}, 0), 1);
    const admitted = admitPublicationJob(requested.state, 2, 'request');
    const started = startPublicationJobTransition(admitted.state, 3);
    if (!started.decision.ready) {
      throw new Error('Expected publication to start');
    }
    const demandedAgain = requestPublicationTransition(started.state, 4);
    const firstFinish = finishPublicationJobTransition(
      demandedAgain.state,
      started.decision.startedAt,
      started.decision.requestTarget,
      started.decision.dataTarget,
      { revision: 'a'.repeat(64) },
      5,
    );
    expect(firstFinish.decision).toBe(true);
    expect(firstFinish.state.publication.acknowledgedRequestGeneration).toBe(1);

    const durablePublishedAt = '2026-07-30T10:00:00.000Z';
    const durableFinish = finishPublicationJobTransition(
      started.state,
      started.decision.startedAt,
      started.decision.requestTarget,
      started.decision.dataTarget,
      { publishedAt: durablePublishedAt, revision: 'b'.repeat(64) },
      10_000,
    );
    expect(durableFinish.decision).toBe(false);
    expect(durableFinish.state.publication.acknowledgedRequestGeneration).toBe(
      durableFinish.state.publication.requestedGeneration,
    );
    expect(durableFinish.state.publication.lastPublishedAt).toBe(durablePublishedAt);
    expect(durableFinish.state.publication.lastOutcome).toBe('success');

    const successor = admitPublicationJob(firstFinish.state, 6, 'request');
    const successorStart = startPublicationJobTransition(successor.state, 7);
    if (!successorStart.decision.ready) {
      throw new Error('Expected successor publication to start');
    }
    const successorFinish = finishPublicationJobTransition(
      successorStart.state,
      successorStart.decision.startedAt,
      successorStart.decision.requestTarget,
      successorStart.decision.dataTarget,
      {},
      8,
    );
    expect(successorFinish.decision).toBe(false);
    expect(successorFinish.state.publication.acknowledgedRequestGeneration).toBe(2);
    expect(successorFinish.state.generation).toBeGreaterThan(requested.state.generation);
  });

  test('preserves publication demand after failure', () => {
    const requested = requestPublicationTransition(initialSourceControlState('instance-a', [], {}, 0), 1);
    const admitted = admitPublicationJob(requested.state, 2, 'request');
    const started = startPublicationJobTransition(admitted.state, 3);
    if (!started.decision.ready) {
      throw new Error('Expected publication to start');
    }
    const failed = finishPublicationJobTransition(
      started.state,
      started.decision.startedAt,
      started.decision.requestTarget,
      started.decision.dataTarget,
      undefined,
      4,
    );
    expect(failed.decision).toBe(true);
    expect(failed.state.publication).toMatchObject({
      acknowledgedRequestGeneration: 0,
      lastOutcome: 'failed',
      requestedGeneration: 1,
    });
  });
});

describe('publication settling', () => {
  const job: PublicationJob = { _tag: 'publication', deferrals: 0, queuedAt: 1000, reason: 'source-wake' };

  test.each(['request', 'source-wake'] as const)('records %s admission without allowing a second job', (reason) => {
    const initial = requestPublicationTransition(detectedState('claude.sessions'), 1000).state;
    const admitted = admitPublicationJob(initial, 1000, reason);
    expect(admitted.decision).toEqual({ ...job, reason });
    expect(admitted.state.queueDepth).toBe(1);
    expect(admitted.state.publication.queued).toBe(true);
    expect(admitPublicationJob(admitted.state, 1001, reason).decision).toBeUndefined();
    const started = startPublicationJobTransition(admitted.state, 1002);
    expect(admitPublicationJob(started.state, 1003, reason).decision).toBeUndefined();
  });

  test('runs when no source is queued or due soon', () => {
    expect(publicationSettleDecision(detectedState('claude.sessions'), job, 1000, 5000, 2)).toEqual({ defer: false });
  });

  test('yields immediately to a queued source without mutating pending publication demand', () => {
    const requested = requestPublicationTransition(detectedState('claude.sessions', 'codex.sessions'), 1000).state;
    const admitted = admitPublicationJob(requested, 1000, 'source-wake');
    const queued = admitSourceJob(admitted.state, 'codex.sessions', true, 1000, 'cadence').state;

    expect(publicationSettleDecision(queued, job, 1000, 5000, 2)).toEqual({ defer: true, waitMs: 0 });
    expect(queued.publication).toMatchObject({
      acknowledgedRequestGeneration: 0,
      queued: true,
      requestedGeneration: 1,
      running: false,
    });
    expect(queued.queueDepth).toBe(2);
  });

  test.each([
    [3000, { defer: true, waitMs: 3000 }],
    [5000, { defer: true, waitMs: 5000 }],
    [8000, { defer: false }],
    [-1000, { defer: true, waitMs: 0 }],
  ] as const)('handles a source due in %i ms', (untilDue, expected) => {
    const scheduled = scheduleSourceTransition(
      detectedState('claude.sessions', 'codex.sessions'),
      'codex.sessions',
      1000 + untilDue,
      1000,
    ).state;
    expect(publicationSettleDecision(scheduled, job, 1000, 5000, 2)).toEqual(expected);
  });

  test.each([
    [-1000, { defer: true, waitMs: 250 }],
    [100, { defer: true, waitMs: 250 }],
    [3000, { defer: true, waitMs: 3000 }],
  ] as const)('waits at least the minimum for a due but unqueued source (%i ms)', (untilDue, expected) => {
    const scheduled = scheduleSourceTransition(
      detectedState('claude.sessions', 'codex.sessions'),
      'codex.sessions',
      1000 + untilDue,
      1000,
    ).state;
    expect(publicationSettleDecision(scheduled, job, 1000, 5000, 2, 250)).toEqual(expected);
    // A queued source still yields immediately: the re-offer lands behind it.
    const queued = admitSourceJob(scheduled, 'codex.sessions', true, 1000, 'cadence').state;
    expect(publicationSettleDecision(queued, job, 1000, 5000, 2, 250)).toEqual({ defer: true, waitMs: 0 });
  });

  test('chooses the earliest due source', () => {
    const initial = detectedState('claude.sessions', 'codex.sessions');
    const first = scheduleSourceTransition(initial, 'claude.sessions', 5000, 1000).state;
    const second = scheduleSourceTransition(first, 'codex.sessions', 3000, 1000).state;
    expect(publicationSettleDecision(second, job, 1000, 5000, 2)).toEqual({ defer: true, waitMs: 2000 });
  });

  test('never defers an explicit request or a job at its deferral limit', () => {
    const queued = admitSourceJob(detectedState('codex.sessions'), 'codex.sessions', true, 1000, 'manual').state;
    expect(publicationSettleDecision(queued, { ...job, reason: 'request' }, 1000, 5000, 2)).toEqual({ defer: false });
    expect(publicationSettleDecision(queued, { ...job, deferrals: 1 }, 1000, 5000, 2)).toEqual({
      defer: true,
      waitMs: 0,
    });
    expect(publicationSettleDecision(queued, { ...job, deferrals: 2 }, 1000, 5000, 2)).toEqual({ defer: false });
    expect(publicationSettleDecision(queued, { ...job, deferrals: 3 }, 1000, 5000, 2)).toEqual({ defer: false });
  });

  test('keeps an explicit request that joins a queued source-wake job from settling', () => {
    const woken = admitPublicationJob(detectedState('claude.sessions', 'codex.sessions'), 1000, 'source-wake');
    const queuedSource = admitSourceJob(woken.state, 'codex.sessions', true, 1000, 'cadence').state;
    expect(publicationSettleDecision(queuedSource, job, 1000, 5000, 2)).toEqual({ defer: true, waitMs: 0 });

    const joined = requestPublicationTransition(queuedSource, 1001);
    expect(joined.decision).toEqual({ shouldQueue: false });
    expect(joined.state.publication).toMatchObject({
      explicitRequestPending: true,
      queued: true,
      requestedGeneration: 1,
    });
    expect(publicationSettleDecision(joined.state, job, 1001, 5000, 2)).toEqual({ defer: false });

    const started = startPublicationJobTransition(joined.state, 1002);
    expect(started.decision.ready).toBe(true);
    expect(started.state.publication).toMatchObject({ explicitRequestPending: false, queued: false, running: true });
  });

  test('leaves the explicit marker clear when a request is admitted as its own job', () => {
    const requested = requestPublicationTransition(detectedState('claude.sessions'), 1000);
    expect(requested.decision).toEqual({ shouldQueue: true });
    expect(requested.state.publication.explicitRequestPending).toBe(false);
  });

  test('ignores disabled and unavailable sources even when queued or due soon', () => {
    const initial = detectedState('claude.sessions', 'codex.sessions');
    const scheduled = scheduleSourceTransition(initial, 'claude.sessions', 4000, 1000).state;
    const queued = admitSourceJob(scheduled, 'codex.sessions', true, 1000, 'manual').state;
    const ignored = {
      ...queued,
      sources: {
        ...queued.sources,
        'claude.sessions': { ...queued.sources['claude.sessions'], enabled: false, queued: true },
        'codex.sessions': {
          ...queued.sources['codex.sessions'],
          availability: 'not-detected' as const,
          nextDueAt: new Date(4000).toISOString(),
        },
      },
    };
    expect(publicationSettleDecision(ignored, job, 1000, 5000, 2)).toEqual({ defer: false });
  });
});
