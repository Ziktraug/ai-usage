import { readLocalSessionAnalysis } from '@ai-usage/local-machine/session-detail';
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
import { authorizeLocalSessionAnchor } from './local-session-authority.server';
import { runRevisionQueryForServer } from './revision-query-runner.server';
import { resolveUsageReadModelForServer } from './usage-read-model-resolver.server';

export interface SessionDetailServerDependencies {
  readAnalysis(harnessKey: SessionDetailHarnessKey, sourceSessionId: string): Promise<LocalSessionAnalysis | null>;
  readMachine(): Promise<{ id: string }>;
  resolveAnchor(request: SessionDetailRequest): Promise<SessionQueryServerResult<SessionDetailAnchorResult>>;
}

const defaultDependencies = (signal?: AbortSignal): SessionDetailServerDependencies => ({
  readAnalysis: async (harnessKey, sourceSessionId) => {
    signal?.throwIfAborted();
    const analysis = await readLocalSessionAnalysis({ harnessKey, sourceSessionId });
    signal?.throwIfAborted();
    return analysis;
  },
  readMachine: async () =>
    await (await resolveUsageReadModelForServer()).readLocalMachine(signal === undefined ? {} : { signal }),
  resolveAnchor: (request) =>
    runRevisionQueryForServer('session-detail-anchor', request, undefined, signal === undefined ? {} : { signal }),
});

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
  dependencies?: SessionDetailServerDependencies,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SessionDetailResponse> => {
  options.signal?.throwIfAborted();
  const activeDependencies = dependencies ?? defaultDependencies(options.signal);
  const request = parseSessionDetailRequest(input);
  const anchorResult = await activeDependencies.resolveAnchor(request);
  options.signal?.throwIfAborted();
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

  const authorization = await authorizeLocalSessionAnchor(anchor, activeDependencies.readMachine);
  options.signal?.throwIfAborted();
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
    const analysis = await activeDependencies.readAnalysis(anchor.harnessKey, anchor.sourceSessionId);
    options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    return unavailable(
      'history-unavailable',
      `The local ${historyLabels[anchor.harnessKey]} history could not be read safely.`,
    );
  }
};
