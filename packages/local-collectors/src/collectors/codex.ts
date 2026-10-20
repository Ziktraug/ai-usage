import type { LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import {
  completeSkillObservationCollection,
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
} from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessionsResult } from '../codex-history';
import { sessionToUsageRow } from '../collected-session';
import {
  deferredUsageOwnershipWarning,
  metricValidationWarning,
  oversizedHistoryLineWarning,
  skillObservationTruncationWarning,
  skillObservationValidationWarning,
  unlistedHistoryDirectoryWarning,
  unreadableHistoryFileWarning,
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
      observationCompleteness: completeSkillObservationCollection(),
      observations: [],
      rows: [],
      warnings: [],
    };
  }
  const result = yield* readCodexUsageSessionsResult;
  const observationsTruncated =
    result.observationCompleteness.exposure.truncated || result.observationCompleteness.invocation.truncated;
  const warning = metricValidationWarning('codex', result.rejectedMetricRecords, result.metricWarningContext);
  const observationWarning = skillObservationValidationWarning('codex', result.rejectedSkillObservationRecords);
  const oversizedWarning = oversizedHistoryLineWarning('codex', result.oversizedLines);
  const truncationWarning = observationsTruncated
    ? skillObservationTruncationWarning('codex', MAX_SKILL_OBSERVATIONS_PER_SESSION)
    : null;
  // Rollouts the reader could not open or decompress: their sessions are
  // missing from this pass, which has to be stated rather than inferred from
  // an absent row. `readFailures` stays on the result as the typed list.
  const unreadableWarning = unreadableHistoryFileWarning('codex', result.readFailures);
  const unlistedWarning = result.archivedWalkFailure
    ? unlistedHistoryDirectoryWarning('codex', result.archivedWalkFailure, 'the Codex archived sessions directory')
    : null;
  const deferredWarning = deferredUsageOwnershipWarning('codex', result.ownershipDeferredSessions);
  return {
    observationCompleteness: result.observationCompleteness,
    observations: result.observations,
    rows: result.sessions.map(sessionToUsageRow),
    warnings: [
      warning,
      observationWarning,
      oversizedWarning,
      truncationWarning,
      unreadableWarning,
      unlistedWarning,
      deferredWarning,
    ].filter((value) => value !== null),
  };
});

export const collectCodex = collectCodexResult.pipe(Effect.map((result) => result.rows));
