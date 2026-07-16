import { describe, expect, test } from 'bun:test';
import {
  initialSourceControlState,
  lifecycleAfterPolicyChange,
  outcomeAfterRun,
  reasonAfterCompletion,
  reasonForAvailability,
  sourceControlView,
} from './source-control-state';

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
    expect(outcomeAfterRun({ _tag: 'timed-out' }, undefined, 0)).toBe('timed-out');
    expect(reasonAfterCompletion({ _tag: 'timed-out' }, undefined, true).code).toBe('timed-out');
    expect(lifecycleAfterPolicyChange({ ...source, availability: 'not-detected' }, true)).toBe('dormant');
    expect(reasonForAvailability('not-detected').code).toBe('input-missing');
  });

  test('keeps a picked run in pausing when policy is disabled', () => {
    const source = initialSourceControlState('instance-a', ['claude.sessions'], {}, 0).sources['claude.sessions'];
    expect(lifecycleAfterPolicyChange({ ...source, lifecycle: 'running', running: true }, false)).toBe('pausing');
  });
});
