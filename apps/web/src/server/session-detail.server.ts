import { readCodexSessionDetail } from '@ai-usage/local-collectors/codex-history';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { readOpenCodeSessionDetail } from '@ai-usage/local-collectors/opencode-history';
import {
  parseSessionDetailRequest,
  parseSessionDetailResponse,
  type SessionDetail,
  type SessionDetailHarnessKey,
  type SessionDetailRequest,
  type SessionDetailResponse,
  supportsSessionDetailHarness,
} from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';

interface SessionDetailServerDependencies {
  readDetail(harnessKey: SessionDetailHarnessKey, sourceSessionId: string): Promise<SessionDetail | null>;
  readMachine(): Promise<{ id: string }>;
}

const defaultDependencies = (
  storage: LocalHistoryStorageService = createLocalHistoryStorage(),
): SessionDetailServerDependencies => ({
  readDetail: (harnessKey, sourceSessionId) => {
    const detailEffect =
      harnessKey === 'codex' ? readCodexSessionDetail(sourceSessionId) : readOpenCodeSessionDetail(sourceSessionId);
    return Effect.runPromise(detailEffect.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  },
  readMachine: () => Effect.runPromise(ensureMachineConfig.pipe(Effect.provideService(LocalHistoryStorage, storage))),
});

const unavailable = (
  reason: Extract<SessionDetailResponse, { status: 'unavailable' }>['reason'],
  message: string,
): SessionDetailResponse => ({ message, reason, status: 'unavailable' });

const historyLabel = (harnessKey: SessionDetailHarnessKey): string => (harnessKey === 'codex' ? 'Codex' : 'OpenCode');

export const getLocalSessionDetailForServer = async (
  input: SessionDetailRequest,
  dependencies: SessionDetailServerDependencies = defaultDependencies(),
): Promise<SessionDetailResponse> => {
  const request = parseSessionDetailRequest(input);
  if (!supportsSessionDetailHarness(request.harnessKey)) {
    return unavailable('unsupported', 'Detailed chronology is not available for this harness yet.');
  }

  try {
    const machine = await dependencies.readMachine();
    if (machine.id !== request.machineId) {
      return unavailable('not-local', 'Detailed chronology is only available on the session source machine.');
    }
    const detail = await dependencies.readDetail(request.harnessKey, request.sourceSessionId);
    if (!detail) {
      return unavailable(
        'not-found',
        `The local ${historyLabel(request.harnessKey)} history for this session is no longer available.`,
      );
    }
    return parseSessionDetailResponse({ detail, status: 'available' });
  } catch {
    return unavailable(
      'history-unavailable',
      `The local ${historyLabel(request.harnessKey)} history could not be read safely.`,
    );
  }
};
