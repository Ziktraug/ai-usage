import type { MemoryItemId } from '@ai-usage/platform-core/identity';
import type { MemorySearchEvaluationCase, MemorySearchEvaluationClass } from './evaluation';

export interface MemorySearchEvaluationObservation {
  readonly caseId: string;
  readonly durationMs: number;
  readonly responseBytes: number;
  readonly returnedIds: readonly MemoryItemId[];
}

export interface MemorySearchEvaluationMetricSet {
  readonly caseCount: number;
  readonly falsePositiveRate: number;
  readonly latencyMs: {
    readonly maximum: number;
    readonly median: number;
    readonly p95: number;
  };
  readonly meanReciprocalRank: number;
  readonly recallAt1: number;
  readonly recallAt10: number;
  readonly responseBytes: {
    readonly maximum: number;
    readonly median: number;
    readonly p95: number;
  };
}

export interface MemorySearchEvaluationReport {
  readonly adapter: string;
  readonly aggregate: MemorySearchEvaluationMetricSet;
  readonly authorizationNoLeakPassed: boolean;
  readonly byClass: Readonly<Partial<Record<MemorySearchEvaluationClass, MemorySearchEvaluationMetricSet>>>;
  readonly languageConfiguration: 'simple-plus-trigram';
  readonly vectorGate: {
    readonly failures: readonly string[];
    readonly failuresAreSemanticParaphrases: boolean;
    readonly lexicalRecallAt10: number;
    readonly shouldAddPgvector: boolean;
  };
}

interface EvaluatedCase {
  readonly definition: MemorySearchEvaluationCase;
  readonly observation: MemorySearchEvaluationObservation;
}

const rounded = (value: number): number => Number(value.toFixed(6));

const quantile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1);
  return rounded(ordered[index] ?? 0);
};

const expectedRank = ({ definition, observation }: EvaluatedCase): number | null => {
  if (definition.noAnswer) {
    return null;
  }
  const expected = new Set(definition.expectedIds);
  const index = observation.returnedIds.findIndex((id) => expected.has(id));
  return index < 0 ? 0 : index + 1;
};

const metricSet = (evaluated: readonly EvaluatedCase[]): MemorySearchEvaluationMetricSet => {
  const relevant = evaluated.filter(({ definition }) => !definition.noAnswer);
  const noAnswer = evaluated.filter(({ definition }) => definition.noAnswer);
  const ranks = relevant.map(expectedRank).map((rank) => rank ?? 0);
  const falsePositiveCount = noAnswer.filter(({ observation }) => observation.returnedIds.length > 0).length;
  const ratio = (count: number, total: number) => (total === 0 ? 0 : rounded(count / total));
  return Object.freeze({
    caseCount: evaluated.length,
    falsePositiveRate: ratio(falsePositiveCount, noAnswer.length),
    latencyMs: Object.freeze({
      maximum: rounded(Math.max(0, ...evaluated.map(({ observation }) => observation.durationMs))),
      median: quantile(
        evaluated.map(({ observation }) => observation.durationMs),
        0.5,
      ),
      p95: quantile(
        evaluated.map(({ observation }) => observation.durationMs),
        0.95,
      ),
    }),
    meanReciprocalRank: ratio(
      ranks.reduce((total, rank) => total + (rank > 0 ? 1 / rank : 0), 0),
      relevant.length,
    ),
    recallAt1: ratio(ranks.filter((rank) => rank === 1).length, relevant.length),
    recallAt10: ratio(ranks.filter((rank) => rank > 0 && rank <= 10).length, relevant.length),
    responseBytes: Object.freeze({
      maximum: Math.max(0, ...evaluated.map(({ observation }) => observation.responseBytes)),
      median: quantile(
        evaluated.map(({ observation }) => observation.responseBytes),
        0.5,
      ),
      p95: quantile(
        evaluated.map(({ observation }) => observation.responseBytes),
        0.95,
      ),
    }),
  });
};

export const summarizeMemorySearchEvaluation = (input: {
  readonly adapter: string;
  readonly authorizationNoLeakPassed: boolean;
  readonly cases: readonly MemorySearchEvaluationCase[];
  readonly observations: readonly MemorySearchEvaluationObservation[];
}): MemorySearchEvaluationReport => {
  const observationByCase = new Map(input.observations.map((observation) => [observation.caseId, observation]));
  if (
    observationByCase.size !== input.observations.length ||
    input.observations.length !== input.cases.length ||
    input.cases.some((definition) => !observationByCase.has(definition.id))
  ) {
    throw new Error('Memory search evaluation observations must match the committed cases exactly.');
  }
  const evaluated = input.cases.map((definition) => ({
    definition,
    observation: observationByCase.get(definition.id) as MemorySearchEvaluationObservation,
  }));
  for (const entry of evaluated) {
    if (
      !Number.isFinite(entry.observation.durationMs) ||
      entry.observation.durationMs < 0 ||
      !Number.isSafeInteger(entry.observation.responseBytes) ||
      entry.observation.responseBytes < 0 ||
      entry.definition.forbiddenIds.some((id) => entry.observation.returnedIds.includes(id))
    ) {
      throw new Error(`Memory search evaluation observation is invalid for ${entry.definition.id}.`);
    }
  }
  const byClass: Partial<Record<MemorySearchEvaluationClass, MemorySearchEvaluationMetricSet>> = {};
  for (const entry of evaluated) {
    const matchingClass = evaluated.filter(({ definition }) => definition.class === entry.definition.class);
    byClass[entry.definition.class] = metricSet(matchingClass);
  }
  const aggregate = metricSet(evaluated);
  const failures = evaluated
    .filter((entry) => {
      const rank = expectedRank(entry);
      return rank !== null && (rank === 0 || rank > 10);
    })
    .map(({ definition }) => definition.id);
  const failuresAreSemanticParaphrases = failures.every((id) => {
    const definition = input.cases.find((entry) => entry.id === id);
    return definition?.class === 'semantic-paraphrase';
  });
  return Object.freeze({
    adapter: input.adapter,
    aggregate,
    authorizationNoLeakPassed: input.authorizationNoLeakPassed,
    byClass: Object.freeze(byClass),
    languageConfiguration: 'simple-plus-trigram',
    vectorGate: Object.freeze({
      failures: Object.freeze(failures),
      failuresAreSemanticParaphrases,
      lexicalRecallAt10: aggregate.recallAt10,
      shouldAddPgvector: aggregate.recallAt10 < 0.8 && failuresAreSemanticParaphrases && failures.length > 0,
    }),
  });
};
