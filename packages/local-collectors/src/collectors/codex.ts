import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessionsResult } from '../codex-history';
import { sessionToUsageRow } from '../collected-session';
import type { LocalHistoryWarning } from '../errors';
import { metricValidationWarning } from '../metric-validation';

export interface CodexCollectionResult {
  rows: ReturnType<typeof sessionToUsageRow>[];
  warnings: LocalHistoryWarning[];
}

export const collectCodexResult = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) {
    return { rows: [], warnings: [] };
  }
  const result = yield* readCodexUsageSessionsResult;
  const warning = metricValidationWarning('codex', result.rejectedMetricRecords);
  return { rows: result.sessions.map(sessionToUsageRow), warnings: warning ? [warning] : [] };
});

export const collectCodex = collectCodexResult.pipe(Effect.map((result) => result.rows));
