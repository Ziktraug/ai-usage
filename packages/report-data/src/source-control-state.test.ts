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
  reasonAfterCompletion,
  reasonForAvailability,
  requestPublicationTransition,
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

  test('captures and acknowledges publication targets without losing demand arriving during a run', () => {
    const requested = requestPublicationTransition(initialSourceControlState('instance-a', [], {}, 0), 1);
    const admitted = admitPublicationJob(requested.state, 2);
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

    const successor = admitPublicationJob(firstFinish.state, 6);
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
    const admitted = admitPublicationJob(requested.state, 2);
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
