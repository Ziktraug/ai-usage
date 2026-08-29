import type { LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import {
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
} from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessionsResult } from '../codex-history';
import { sessionToUsageRow } from '../collected-session';
import {
  metricValidationWarning,
  skillObservationTruncationWarning,
  skillObservationValidationWarning,
} from '../metric-validation';

export interface CodexCollectionResult {
  observationCompleteness: SkillObservationCollectionCompleteness;
  /**
   * A new fact drawn from the collection source this collector already reads —
   * not a new collection source. The source vocabulary is unchanged.
   */
  observations: SkillObservation[];
  rows: ReturnType<typeof sessionToUsageRow>[];
  warnings: LocalHistoryWarning[];
}

export const collectCodexResult = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) {
    return {
      observationCompleteness: {
        exposure: { rejected: 0, truncated: false },
        invocation: { rejected: 0, truncated: false },
      },
      observations: [],
      rows: [],
      warnings: [],
    };
  }
  const result = yield* readCodexUsageSessionsResult;
  const warning = metricValidationWarning('codex', result.rejectedMetricRecords);
  const observationWarning = skillObservationValidationWarning('codex', result.rejectedObservations);
  const truncationWarning = result.observationsTruncated
    ? skillObservationTruncationWarning('codex', MAX_SKILL_OBSERVATIONS_PER_SESSION)
    : null;
  return {
    // The current Codex session cache reports one combined producer bound. Until that cache carries
    // the two causes separately, attributing it to both tiers is conservative: it can hedge an
    // absence unnecessarily, but it can never certify an absence after losing an invocation.
    observationCompleteness: {
      exposure: {
        rejected: result.rejectedObservations,
        truncated: result.observationsTruncated,
      },
      invocation: {
        rejected: result.rejectedObservations,
        truncated: result.observationsTruncated,
      },
    },
    observations: result.observations,
    rows: result.sessions.map(sessionToUsageRow),
    warnings: [warning, observationWarning, truncationWarning].filter((value) => value !== null),
  };
});

export const collectCodex = collectCodexResult.pipe(Effect.map((result) => result.rows));
