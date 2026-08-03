import type { SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { CampaignSessionCollection } from './campaign-session-controls-model';

export interface CampaignSessionControlsBinding {
  readonly campaign: SessionPresentationRow;
  readonly collection: CampaignSessionCollection;
  readonly loadMore: () => void;
  readonly query: SessionQueryRequest;
  readonly visibleRows: readonly SessionPresentationRow[];
}
