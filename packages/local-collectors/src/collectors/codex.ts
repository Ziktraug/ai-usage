import type { LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import { MAX_SKILL_OBSERVATIONS_PER_SESSION, type SkillObservation } from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessionsResult } from '../codex-history';
import { sessionToUsageRow } from '../collected-session';
import {
  metricValidationWarning,
  skillObservationTruncationWarning,
  skillObservationValidationWarning,
} from '../metric-validation';

export interface CodexCollectionResult {
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
    return { observations: [], rows: [], warnings: [] };
  }
  const result = yield* readCodexUsageSessionsResult;
  const warning = metricValidationWarning('codex', result.rejectedMetricRecords);
  const observationWarning = skillObservationValidationWarning('codex', result.rejectedObservations);
  const truncationWarning = result.observationsTruncated
    ? skillObservationTruncationWarning('codex', MAX_SKILL_OBSERVATIONS_PER_SESSION)
    : null;
  return {
    observations: result.observations,
    rows: result.sessions.map(sessionToUsageRow),
    warnings: [warning, observationWarning, truncationWarning].filter((value) => value !== null),
  };
});

export const collectCodex = collectCodexResult.pipe(Effect.map((result) => result.rows));
