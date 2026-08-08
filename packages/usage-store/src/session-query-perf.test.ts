import { describe, expect, test } from 'bun:test';
import {
  measureSessionQueryPerfPhase,
  resetSessionQueryPerf,
  sessionQueryPerfEnabled,
  snapshotSessionQueryPerf,
} from './session-query-perf';

describe('session query perf attribution', () => {
  test('records nothing when AI_USAGE_PERF is disabled', () => {
    const previous = process.env.AI_USAGE_PERF;
    delete process.env.AI_USAGE_PERF;
    resetSessionQueryPerf();
    expect(sessionQueryPerfEnabled()).toBe(false);
    expect(measureSessionQueryPerfPhase('count', () => 41)).toBe(41);
    expect(snapshotSessionQueryPerf().samples).toBe(0);
    if (previous === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previous;
    }
  });

  test('aggregates phase timings when AI_USAGE_PERF is enabled', () => {
    const previous = process.env.AI_USAGE_PERF;
    process.env.AI_USAGE_PERF = '1';
    resetSessionQueryPerf();
    expect(sessionQueryPerfEnabled()).toBe(true);
    measureSessionQueryPerfPhase('count', () => {
      const end = performance.now() + 1;
      while (performance.now() < end) {
        // busy-wait a millisecond-scale sample
      }
      return true;
    });
    measureSessionQueryPerfPhase('projection', () => true);
    measureSessionQueryPerfPhase('materialize', () => true);
    const snapshot = snapshotSessionQueryPerf();
    expect(snapshot.phases.count.count).toBe(1);
    expect(snapshot.phases.projection.count).toBe(1);
    expect(snapshot.phases.materialize.count).toBe(1);
    expect(snapshot.phases.count.totalMs).toBeGreaterThan(0);
    resetSessionQueryPerf();
    expect(snapshotSessionQueryPerf().samples).toBe(0);
    if (previous === undefined) {
      delete process.env.AI_USAGE_PERF;
    } else {
      process.env.AI_USAGE_PERF = previous;
    }
  });
});
