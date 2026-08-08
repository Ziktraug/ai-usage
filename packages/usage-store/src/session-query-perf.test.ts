import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  measureSessionQueryPerfPhase,
  resetSessionQueryPerf,
  sessionQueryPerfEnabled,
  snapshotSessionQueryPerf,
} from './session-query-perf';

describe('session query perf attribution', () => {
  let previousPerfFlag: string | undefined;

  beforeEach(() => {
    previousPerfFlag = process.env.AI_USAGE_PERF;
    resetSessionQueryPerf();
  });

  afterEach(() => {
    resetSessionQueryPerf();
    if (previousPerfFlag === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previousPerfFlag;
    }
  });

  test('records nothing when AI_USAGE_PERF is disabled', () => {
    delete process.env.AI_USAGE_PERF;
    expect(sessionQueryPerfEnabled()).toBe(false);
    expect(measureSessionQueryPerfPhase('count', () => 41)).toBe(41);
    expect(snapshotSessionQueryPerf().samples).toBe(0);
  });

  test('aggregates phase timings when AI_USAGE_PERF is enabled', () => {
    process.env.AI_USAGE_PERF = '1';
    expect(sessionQueryPerfEnabled()).toBe(true);
    measureSessionQueryPerfPhase('count', () => {
      const end = performance.now() + 1;
      while (performance.now() < end) {
        // busy-wait a millisecond-scale sample
      }
      return true;
    });
    measureSessionQueryPerfPhase('identity', () => true);
    measureSessionQueryPerfPhase('projection', () => true);
    measureSessionQueryPerfPhase('materialize', () => true);
    measureSessionQueryPerfPhase('slice', () => true);
    const snapshot = snapshotSessionQueryPerf();
    expect(snapshot.samples).toBe(5);
    expect(snapshot.phases.count.count).toBe(1);
    expect(snapshot.phases.identity.count).toBe(1);
    expect(snapshot.phases.projection.count).toBe(1);
    expect(snapshot.phases.materialize.count).toBe(1);
    expect(snapshot.phases.slice.count).toBe(1);
    expect(snapshot.phases.count.totalMs).toBeGreaterThan(0);
    resetSessionQueryPerf();
    expect(snapshotSessionQueryPerf().samples).toBe(0);
  });
});
