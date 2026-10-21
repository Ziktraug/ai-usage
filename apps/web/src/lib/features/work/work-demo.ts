import type { ReviewCandidate, ReviewTarget } from '@ai-usage/report-core/work-routing';
import type { WorkEvidence } from './work-evidence';
import { WORK_DEMO_TIME } from './work-synthetic';

/** Explicit simulation fixtures, never supplied to the real candidate path. */
export const demoReviewCandidates = (target: ReviewTarget): readonly ReviewCandidate[] =>
  (['claude-code', 'codex'] as const).map((harness) => ({
    id: `demo-${harness}`,
    machineId: target.machineId,
    machineLabel: 'Synthetic workstation',
    accountScope: `demo-${harness}-subscription`,
    harness,
    model: 'Fixture review model',
    effort: 'Fixture declared effort',
    authorization: 'allowed',
    authorizedTarget: target,
    subscription: 'verified',
    availability: 'available',
    capabilities: ['read-only-review'],
    quality: 'review-capable',
    quota: {
      accountLabel: `demo-${harness}-subscription`,
      generatedAt: WORK_DEMO_TIME,
      key: `${harness === 'claude-code' ? 'claude' : 'codex'}:demo-${harness}-subscription`,
      label: harness === 'claude-code' ? 'Claude Code demo' : 'Codex demo',
      machineId: target.machineId,
      machineLabel: 'Synthetic workstation',
      plan: 'Synthetic subscription',
      source: 'live-api',
      state: 'ok',
      windows: [
        {
          id: 'demo-window',
          label: 'Synthetic subscription window',
          blocked: false,
          group: 'session',
          limitSeconds: 18_000,
          usedPercent: harness === 'claude-code' ? 55 : 75,
          remainingPercent: harness === 'claude-code' ? 45 : 25,
          resetsAt: new Date(Date.parse(WORK_DEMO_TIME) + (harness === 'codex' ? 20 : 180) * 60_000).toISOString(),
          scope: 'provider',
        },
      ],
    },
    evidence: { source: 'Synthetic routing fixture; no live qualification', observedAt: WORK_DEMO_TIME },
  }));

export const demoWorkEvidence = (target: ReviewTarget): readonly WorkEvidence[] => {
  const session = { machineId: target.machineId, harness: target.harness, sessionId: target.sourceSessionId };
  const base = { session, source: 'Synthetic projection-boundary fixture', coverage: 'partial' as const };
  const pullRequest = { host: 'github.example', repository: 'demo/example', number: 42 };
  return [
    {
      ...base,
      id: 'demo-request',
      observedAt: '2026-06-11T08:00:00.000Z',
      kind: 'pr-request',
      repository: pullRequest,
    },
    {
      ...base,
      session: { ...session, sessionId: 'demo-other-session' },
      id: 'demo-opened',
      observedAt: '2026-06-11T09:00:00.000Z',
      kind: 'pr-opened',
      pullRequest,
      fulfillsRequest: { session, requestId: 'demo-request' },
    },
    { ...base, id: 'demo-modified', observedAt: '2026-06-11T09:10:00.000Z', kind: 'local-modifications' },
    { ...base, id: 'demo-proposal', observedAt: '2026-06-11T09:15:00.000Z', kind: 'proposal', response: 'unanswered' },
  ];
};
