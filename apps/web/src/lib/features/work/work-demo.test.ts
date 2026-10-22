import { describe, expect, test } from 'bun:test';
import {
  observedReviewCandidates,
  type ReviewTarget,
  simulateWorkReviewRouting,
} from '@ai-usage/report-core/work-routing';
import { demoReviewCandidates } from './work-demo';
import { WORK_DEMO_TIME } from './work-synthetic';

const target: ReviewTarget = {
  kind: 'session',
  machineId: 'fixture-machine',
  harness: 'codex',
  sourceSessionId: 'campaign-root',
};
const request = {
  action: 'read-only-review',
  target,
  requiredCapabilities: ['read-only-review'],
  minimumQuality: 'review-capable',
} as const;
const policy = {
  preferredHarness: 'claude-code',
  preferNearReset: false,
  nearResetMinutes: 60,
  forcedCandidateId: null,
} as const;

describe('Work routing demonstration inputs', () => {
  test('two declared candidates support Claude and Codex preference without comparing percentages', () => {
    const candidates = demoReviewCandidates(target);
    const input = { request, candidates, policy, referenceTime: WORK_DEMO_TIME };
    expect(candidates).toHaveLength(2);
    expect(simulateWorkReviewRouting(input).chosenCandidateId).toBe('demo-claude-code');
    expect(
      simulateWorkReviewRouting({ ...input, policy: { ...policy, preferredHarness: 'codex' } }).chosenCandidateId,
    ).toBe('demo-codex');
    expect(
      simulateWorkReviewRouting({ ...input, policy: { ...policy, preferNearReset: true } }).chosenCandidateId,
    ).toBe('demo-codex');
  });
  test('passing quota observations through the real projection never imports demo qualification', () => {
    const candidates = observedReviewCandidates(
      demoReviewCandidates(target).flatMap((candidate) => (candidate.quota ? [candidate.quota] : [])),
    );
    const result = simulateWorkReviewRouting({ request, candidates, policy, referenceTime: WORK_DEMO_TIME });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.authorization === 'unknown')).toBe(true);
    expect(result.chosenCandidateId).toBeNull();
    expect(result.evaluations.every((candidate) => candidate.missingData.length > 0)).toBe(true);
  });
});
