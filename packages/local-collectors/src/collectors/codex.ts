import { Effect } from 'effect';
import { hasCodexHistory, readCodexUsageSessions } from '../codex-history';
import { sessionToUsageRow } from '../collected-session';

export const collectCodex = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) return [];
  return (yield* readCodexUsageSessions).map(sessionToUsageRow);
});
