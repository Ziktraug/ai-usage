import type { LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessionsResult } from '../codex-history';
import { sessionToUsageRow } from '../collected-session';
import { metricValidationWarning } from '../metric-validation';

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
  return {
    observations: result.observations,
    rows: result.sessions.map(sessionToUsageRow),
    warnings: warning ? [warning] : [],
  };
});

export const collectCodex = collectCodexResult.pipe(Effect.map((result) => result.rows));
