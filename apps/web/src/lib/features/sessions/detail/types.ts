import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';
import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { SessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import type { SessionAnalysisError } from '../../../../session-analysis-error';
import type { SessionAnalysisTarget } from '../../../../session-analysis-target';

export interface SessionDetailNavigation {
  readonly loading: boolean;
  readonly next: SessionPresentationRow | null;
  readonly previous: SessionPresentationRow | null;
  readonly total: number;
}

export interface SessionDetailControllerSnapshot {
  readonly analysisError: SessionAnalysisError | null;
  readonly analysisLoading: boolean;
  readonly analysisOpen: boolean;
  readonly analysisResponse: SessionDetailResponse | null;
  readonly navigation: SessionDetailNavigation | undefined;
  readonly revision: string | null;
  readonly row: SessionPresentationRow | null;
  readonly target: SessionAnalysisTarget | null;
  readonly vcsResolution: SessionVcsResolveResponse | null;
  readonly vcsResolving: boolean;
}

export interface SessionSelectionInput {
  readonly query?: SessionQueryRequest;
  readonly revision?: string;
  readonly row: SessionPresentationRow;
  readonly target?: SessionAnalysisTarget;
  readonly total?: number;
}

export interface SessionDetailController {
  readonly close: () => void;
  readonly current: () => SessionDetailControllerSnapshot;
  readonly dispose: () => void;
  readonly handleKeyDown: (
    event: Pick<KeyboardEvent, 'defaultPrevented' | 'key' | 'preventDefault' | 'target'>,
  ) => void;
  readonly navigate: (delta: -1 | 1) => void;
  readonly resolveVcs: () => Promise<void>;
  readonly retryAnalysis: () => Promise<void>;
  readonly select: (selection: SessionSelectionInput) => void;
  readonly subscribe: (listener: (snapshot: SessionDetailControllerSnapshot) => void) => () => void;
  readonly toggleAnalysis: () => Promise<void>;
}

export const emptySessionDetailSnapshot = (): SessionDetailControllerSnapshot => ({
  analysisError: null,
  analysisLoading: false,
  analysisOpen: false,
  analysisResponse: null,
  navigation: undefined,
  revision: null,
  row: null,
  target: null,
  vcsResolution: null,
  vcsResolving: false,
});
