import { readClaudeSessionAnalysis } from '@ai-usage/local-collectors/claude-history';
import { readCodexSessionAnalysis } from '@ai-usage/local-collectors/codex-history';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { readOpenCodeSessionAnalysis } from '@ai-usage/local-collectors/opencode-history';
import {
  compareSessionProjectionFacts,
  type LocalSessionAnalysis,
  parseSessionDetailRequest,
  parseSessionDetailResponse,
  type SessionDetailAnchorResult,
  type SessionDetailHarnessKey,
  type SessionDetailRequest,
  type SessionDetailResponse,
  supportsSessionDetailHarness,
} from '@ai-usage/report-core/session-detail';
import type { SessionQueryServerResult } from '@ai-usage/report-core/session-query';
import { Effect } from 'effect';
import { authorizeLocalSessionAnchor } from './local-session-authority.server';
import { runRevisionQueryForServer } from './revision-query-runner.server';

export interface SessionDetailServerDependencies {
  readAnalysis(harnessKey: SessionDetailHarnessKey, sourceSessionId: string): Promise<LocalSessionAnalysis | null>;
  readMachine(): Promise<{ id: string }>;
  resolveAnchor(request: SessionDetailRequest): Promise<SessionQueryServerResult<SessionDetailAnchorResult>>;
}

const defaultDependencies = (
  storage: LocalHistoryStorageService = createLocalHistoryStorage(),
): SessionDetailServerDependencies => {
  const readers = {
    claude: readClaudeSessionAnalysis,
    codex: readCodexSessionAnalysis,
    opencode: readOpenCodeSessionAnalysis,
  } satisfies Record<SessionDetailHarnessKey, typeof readCodexSessionAnalysis>;
  return {
    readAnalysis: (harnessKey, sourceSessionId) =>
      Effect.runPromise(readers[harnessKey](sourceSessionId).pipe(Effect.provideService(LocalHistoryStorage, storage))),
    readMachine: () => Effect.runPromise(ensureMachineConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
    resolveAnchor: (request) => runRevisionQueryForServer('session-detail-anchor', request),
  };
};

const unavailable = (
  reason: Extract<SessionDetailResponse, { status: 'unavailable' }>['reason'],
  message: string,
): SessionDetailResponse => ({ message, reason, status: 'unavailable' });

const historyLabels = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
} satisfies Record<SessionDetailHarnessKey, string>;

export const getLocalSessionDetailForServer = async (
  input: SessionDetailRequest,
  dependencies: SessionDetailServerDependencies = defaultDependencies(),
): Promise<SessionDetailResponse> => {
  const request = parseSessionDetailRequest(input);
  const anchorResult = await dependencies.resolveAnchor(request);
  if (!anchorResult.ok) {
    if (anchorResult.error.tag === 'RevisionExpired') {
      return unavailable('revision-expired', 'This report revision is no longer available.');
    }
    return unavailable('history-unavailable', 'The report row could not be read safely.');
  }
  const anchor = anchorResult.data.anchor;
  if (!anchor) {
    return unavailable('report-row-not-found', 'This row does not exist in the requested report revision.');
  }
  if (!(anchor.harnessKey && anchor.machineId && anchor.sourceSessionId)) {
    return unavailable(
      'report-provenance-unavailable',
      'This report row does not include enough provenance to find local history.',
    );
  }
  if (!supportsSessionDetailHarness(anchor.harnessKey)) {
    return unavailable('unsupported', 'Detailed chronology is not available for this harness yet.');
  }

  const authorization = await authorizeLocalSessionAnchor(anchor, dependencies.readMachine);
  if (authorization.status === 'unauthorized') {
    if (authorization.reason === 'not-local') {
      return unavailable('not-local', 'Detailed chronology is only available on the session source machine.');
    }
    if (authorization.reason === 'provenance-unavailable') {
      return unavailable(
        'report-provenance-unavailable',
        'This report row does not include enough provenance to find local history.',
      );
    }
    return unavailable('history-unavailable', 'The local machine identity could not be read safely.');
  }

  try {
    const analysis = await dependencies.readAnalysis(anchor.harnessKey, anchor.sourceSessionId);
    if (!analysis) {
      return unavailable(
        'not-found',
        `The local ${historyLabels[anchor.harnessKey]} history for this session is no longer available.`,
      );
    }
    return parseSessionDetailResponse({
      consistency: compareSessionProjectionFacts(anchor.projection, analysis.projection),
      detail: analysis.detail,
      revision: request.revision,
      status: 'available',
    });
  } catch {
    return unavailable(
      'history-unavailable',
      `The local ${historyLabels[anchor.harnessKey]} history could not be read safely.`,
    );
  }
};
