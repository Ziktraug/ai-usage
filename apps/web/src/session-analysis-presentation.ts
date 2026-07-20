import type {
  SessionDetailComparableField,
  SessionDetailConsistency,
  SessionDetailCoverageStatus,
} from '@ai-usage/report-core/session-detail';
import type { SessionAnalysisTarget } from './session-analysis-target';

export type SessionAnalysisPresentationItem =
  | { kind: 'consistency-meta'; text: string; tone: 'neutral' }
  | { kind: 'consistency-warning'; text: string; tone: 'warning' }
  | { kind: 'scope'; text: string; tone: 'neutral' }
  | { kind: 'privacy'; text: string; tone: 'neutral' }
  | { kind: 'partial-duration'; text: string; tone: 'neutral' }
  | { kind: 'partial-turns'; text: string; tone: 'neutral' }
  | { kind: 'prompt-truncation'; text: string; tone: 'neutral' };

const comparableFieldLabels: Record<SessionDetailComparableField, string> = {
  calls: 'calls',
  coverage: 'coverage',
  duration: 'duration',
  'model-attribution': 'model attribution',
  tokens: 'tokens',
  tools: 'tools',
  turns: 'turns',
};

const consistencyItem = (consistency: SessionDetailConsistency): SessionAnalysisPresentationItem => {
  if (consistency.status === 'matches-report') {
    return {
      kind: 'consistency-meta',
      text: 'Local detail · comparable metrics match this report revision.',
      tone: 'neutral',
    };
  }
  if (consistency.status === 'cannot-compare') {
    return {
      kind: 'consistency-meta',
      text: 'Local detail · comparison unavailable for this row.',
      tone: 'neutral',
    };
  }
  const fields = consistency.differingFields.map((field) => comparableFieldLabels[field]).join(', ');
  return {
    kind: 'consistency-warning',
    text: `Local trace differs from this report revision. Differing metrics: ${fields}.`,
    tone: 'warning',
  };
};

const scopeItem = (target: SessionAnalysisTarget): SessionAnalysisPresentationItem | null => {
  if (target.kind === 'session') {
    return null;
  }
  const count =
    target.visibleCount === target.totalCount
      ? `${target.totalCount} rollouts`
      : `${target.visibleCount} visible of ${target.totalCount} rollouts`;
  return { kind: 'scope', text: `Root rollout · ${count}`, tone: 'neutral' };
};

export const buildSessionAnalysisPresentation = (input: {
  consistency: SessionDetailConsistency;
  durationPartialBody: string;
  durationStatus: SessionDetailCoverageStatus;
  promptDataTruncated: boolean;
  target: SessionAnalysisTarget;
  turnsStatus: SessionDetailCoverageStatus;
}): SessionAnalysisPresentationItem[] => {
  const items: SessionAnalysisPresentationItem[] = [consistencyItem(input.consistency)];
  const scope = scopeItem(input.target);
  if (scope) {
    items.push(scope);
  }
  if (input.durationStatus === 'partial') {
    items.push({
      kind: 'partial-duration',
      text: input.durationPartialBody,
      tone: 'neutral',
    });
  }
  if (input.turnsStatus === 'partial') {
    items.push({
      kind: 'partial-turns',
      text: 'Some recorded assistant activity cannot be linked to a user prompt. It remains visible without an invented association.',
      tone: 'neutral',
    });
  }
  items.push({
    kind: 'privacy',
    text: 'Local only · detailed prompt bodies are not included in reports or exports.',
    tone: 'neutral',
  });
  if (input.promptDataTruncated) {
    items.push({
      kind: 'prompt-truncation',
      text: 'Some prompt text is truncated in this local view. Timeline and usage totals are unaffected.',
      tone: 'neutral',
    });
  }
  return items;
};
