import type { LocalHistoryError, LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import type { LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import type { CodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import {
  completeSkillObservationCollection,
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
} from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import {
  type CodexUsageSessionsResult,
  createCodexResidentIndex,
  hasCodexHistory,
  readCodexUsageSessionsIncrementally,
  readCodexUsageSessionsResult,
} from '../codex-history';
import { sessionToUsageRow } from '../collected-session';
import {
  deferredUsageOwnershipWarning,
  malformedHistoryLineWarning,
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
   * Present when `observations` holds only those of the rollouts read this pass (an incremental
   * collection that already returned the others). Absent means every observation is listed.
   */
  observationScope?: 'changed';
  /**
   * A new fact drawn from the collection source this collector already reads —
   * not a new collection source. The source vocabulary is unchanged.
   */
  observations: SkillObservation[];
  /**
   * Source session ids this pass positively observed and classified as not
   * Codex usage (transcripts Codex Desktop imported from another harness, ADR
   * 0091). Never an id that is merely absent or unreadable. The store marks
   * the matching rows deleted; a session re-emitted later becomes active again.
   */
  retiredSourceSessionIds: string[];
  rows: ReturnType<typeof sessionToUsageRow>[];
  warnings: LocalHistoryWarning[];
  workObservations: CodexWorkObservation[];
}

const collectCodexResultWith = (
  read: Effect.Effect<CodexUsageSessionsResult, LocalHistoryError, LocalHistoryStorage>,
): Effect.Effect<CodexCollectionResult, LocalHistoryError, LocalHistoryStorage> =>
  Effect.gen(function* () {
    if (!(yield* hasCodexHistory)) {
      return {
        workObservations: [],
        observationCompleteness: completeSkillObservationCollection(),
        observations: [],
        retiredSourceSessionIds: [],
        rows: [],
        warnings: [],
      };
    }
    const result = yield* read;
    const observationsTruncated =
      result.observationCompleteness.exposure.truncated || result.observationCompleteness.invocation.truncated;
    const warning = metricValidationWarning('codex', result.rejectedMetricRecords, result.metricWarningContext);
    const observationWarning = skillObservationValidationWarning('codex', result.rejectedSkillObservationRecords);
    const oversizedWarning = oversizedHistoryLineWarning('codex', result.oversizedLines);
    const malformedWarning = malformedHistoryLineWarning('codex', result.malformedLines);
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
      workObservations: result.workObservations,
      observationCompleteness: result.observationCompleteness,
      ...(result.observationScope === undefined ? {} : { observationScope: result.observationScope }),
      observations: result.observations,
      retiredSourceSessionIds: result.retiredSourceSessionIds,
      rows: result.sessions.map(sessionToUsageRow),
      warnings: [
        warning,
        observationWarning,
        oversizedWarning,
        malformedWarning,
        truncationWarning,
        unreadableWarning,
        unlistedWarning,
        deferredWarning,
      ].filter((value) => value !== null),
    };
  });

export const collectCodexResult = collectCodexResultWith(readCodexUsageSessionsResult);

/**
 * A Codex collector for a long-running process. It keeps a resident index of the parsed rollouts,
 * so a pass re-reads only the rollouts whose file changed and never reloads the session cache.
 * Rows, work observations and retirements are complete on every pass; skill observations are
 * complete when `complete` is asked and otherwise limited to the rollouts read this pass. Each call
 * of this factory owns its own index.
 */
export const createCodexIncrementalCollector = () => {
  const index = createCodexResidentIndex();
  return (request: { readonly complete: boolean }) =>
    collectCodexResultWith(readCodexUsageSessionsIncrementally({ complete: request.complete, index }));
};

export const collectCodex = collectCodexResult.pipe(Effect.map((result) => result.rows));
