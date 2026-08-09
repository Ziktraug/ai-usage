import type { LocalSessionAnalysis, SessionDetailHarnessKey } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { readClaudeSessionAnalysis } from './claude-session-analysis';
import { readCodexSessionAnalysis } from './codex-session-analysis';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from './local-history';
import { readOpenCodeSessionAnalysis } from './opencode-session-analysis';

export interface LocalSessionAnalysisRequest {
  readonly harnessKey: SessionDetailHarnessKey;
  readonly homePath?: string;
  readonly sourceSessionId: string;
}

export interface LocalSessionAnalysisOptions {
  readonly signal?: AbortSignal;
  readonly storage?: LocalHistoryStorageService;
}

const sessionAnalysisReaders = {
  claude: readClaudeSessionAnalysis,
  codex: readCodexSessionAnalysis,
  opencode: readOpenCodeSessionAnalysis,
} satisfies Record<SessionDetailHarnessKey, typeof readCodexSessionAnalysis>;

export const readLocalSessionAnalysis = (
  request: LocalSessionAnalysisRequest,
  options: LocalSessionAnalysisOptions = {},
): Promise<LocalSessionAnalysis | null> => {
  const storage = options.storage ?? createLocalHistoryStorage(request.homePath);
  return Effect.runPromise(
    sessionAnalysisReaders[request.harnessKey](request.sourceSessionId).pipe(
      Effect.provideService(LocalHistoryStorage, storage),
    ),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
};
