import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { WorkRoot } from '@ai-usage/report-core/work-attention';
import { syntheticWorkAttentionDataset } from './work-attention-synthetic';

/** A native question with exact call/question response identity; no Desktop declaration. */
export const nativeQuestionRoot = (): WorkRoot => {
  const base = syntheticWorkAttentionDataset().roots.find((root) => root.key.harness === 'codex');
  if (!base) {
    throw new Error('Codex fixture root unavailable');
  }
  const at = canonicalInstantFromDate(new Date('2026-06-11T11:00:00.000Z'));
  return {
    ...base,
    attention: 'human-request',
    declared: null,
    facts: [
      {
        id: 'native-question',
        kind: 'codex-user-request',
        sourceSessionId: base.key.sourceSessionId,
        provenance: { coverage: 'complete', source: 'codex-rollout', machineId: base.key.machineId, observedAt: at },
        request: {
          askedAt: at,
          acknowledgedAt: at,
          rejectedAt: null,
          callId: 'call-1',
          tool: 'request_user_input',
          questions: [
            { id: 'question-1', text: 'Keep the bounded context?', textTruncated: false, answeredAt: at },
            { id: 'question-2', text: 'Which review model should run?', textTruncated: false, answeredAt: null },
          ],
        },
      },
    ],
    interpretations: [
      {
        kind: 'request-open',
        evidence: ['native-question'],
        text: 'One native question remains pending.',
        uncertainty: 'Only matching call and question answers count.',
      },
    ],
  };
};
