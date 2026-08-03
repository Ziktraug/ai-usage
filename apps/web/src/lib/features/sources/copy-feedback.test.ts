import { describe, expect, test } from 'bun:test';
import {
  type CopyFeedbackScheduler,
  copyFeedbackDurationMs,
  createCopyFeedback,
  registerCopyFeedbackDisposal,
} from './copy-feedback';

interface ScheduledCallback {
  readonly at: number;
  readonly callback: () => void;
}

const createFakeScheduler = () => {
  let elapsedMs = 0;
  let nextHandle = 1;
  const callbacks = new Map<number, ScheduledCallback>();
  const scheduler: CopyFeedbackScheduler = {
    cancel: (handle) => {
      callbacks.delete(handle);
    },
    schedule: (callback, delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, { at: elapsedMs + delayMs, callback });
      return handle;
    },
  };
  const advanceBy = (durationMs: number): void => {
    elapsedMs += durationMs;
    const due = [...callbacks.entries()]
      .filter(([, scheduled]) => scheduled.at <= elapsedMs)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [handle, scheduled] of due) {
      if (callbacks.delete(handle)) {
        scheduled.callback();
      }
    }
  };
  return { activeCount: () => callbacks.size, advanceBy, scheduler };
};

describe('Sources copy feedback', () => {
  test('cancels and replaces the timeout when copy succeeds repeatedly', () => {
    const clock = createFakeScheduler();
    const revisions: (string | undefined)[] = [];
    const feedback = createCopyFeedback(clock.scheduler, (revision) => revisions.push(revision));

    feedback.show('first');
    clock.advanceBy(copyFeedbackDurationMs - 1);
    feedback.show('second');
    clock.advanceBy(1);

    expect(revisions.at(-1)).toBe('second');
    expect(clock.activeCount()).toBe(1);

    clock.advanceBy(copyFeedbackDurationMs);
    expect(revisions).toEqual(['first', 'second', undefined]);
    expect(clock.activeCount()).toBe(0);
  });

  test('cancels pending feedback through the registered component destruction lifecycle', () => {
    const clock = createFakeScheduler();
    const revisions: (string | undefined)[] = [];
    const feedback = createCopyFeedback(clock.scheduler, (revision) => revisions.push(revision));
    let destroy: (() => void) | undefined;
    registerCopyFeedbackDisposal((dispose) => {
      destroy = dispose;
    }, feedback);

    feedback.show('mounted');
    destroy?.();
    clock.advanceBy(copyFeedbackDurationMs);

    expect(revisions).toEqual(['mounted', undefined]);
    expect(clock.activeCount()).toBe(0);
  });

  test('disposes the pending timeout and visible feedback deterministically', () => {
    const clock = createFakeScheduler();
    const revisions: (string | undefined)[] = [];
    const feedback = createCopyFeedback(clock.scheduler, (revision) => revisions.push(revision));

    feedback.show('active');
    feedback.dispose();
    clock.advanceBy(copyFeedbackDurationMs);

    expect(revisions).toEqual(['active', undefined]);
    expect(clock.activeCount()).toBe(0);
  });
});
