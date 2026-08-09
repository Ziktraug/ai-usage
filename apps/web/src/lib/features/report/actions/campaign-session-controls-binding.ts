import {
  parseSessionQueryRequest,
  type SessionPresentationRow,
  type SessionQueryRequest,
} from '@ai-usage/report-core/session-query';
import type { CampaignSessionCollection } from './campaign-session-controls-model';

export interface CampaignSessionControlsBinding {
  readonly campaign: SessionPresentationRow;
  readonly collection: CampaignSessionCollection;
  readonly loadMore: () => void;
  readonly query: SessionQueryRequest;
  readonly selectionQuery: SessionQueryRequest;
  readonly sessionCount: number;
  readonly visibleRows: readonly SessionPresentationRow[];
}

export interface CampaignSessionControlsPublisher {
  readonly dispose: () => void;
  readonly publish: (binding: CampaignSessionControlsBinding | null) => void;
}

export const campaignSessionsNeedInitialLoad = (
  sessions: ReadonlyMap<string, unknown> | undefined,
  campaignKey: string,
): boolean => sessions?.has(campaignKey) !== true;

export const campaignFilterMatchesBinding = (currentCampaignKey: string | undefined, campaignKey: string): boolean =>
  currentCampaignKey === campaignKey;

export const campaignSessionSelectionQuery = (query: SessionQueryRequest, campaignKey: string): SessionQueryRequest =>
  parseSessionQueryRequest({
    ...query,
    cursor: null,
    filters: {
      fields: { campaign: campaignKey },
      harness: [],
      machine: [],
      origin: [],
      query: '',
    },
    range: { from: null, to: null },
  });

export const campaignSessionSelectionFor = (
  binding: CampaignSessionControlsBinding,
  row: SessionPresentationRow,
): { readonly query: SessionQueryRequest; readonly row: SessionPresentationRow; readonly total: number } => ({
  query: binding.selectionQuery,
  row,
  total: binding.sessionCount,
});

export const createCampaignSessionControlsPublisher = (
  listener: () => (binding: CampaignSessionControlsBinding | null) => void,
): CampaignSessionControlsPublisher => {
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      listener()(null);
    },
    publish: (binding) => {
      if (!disposed) {
        listener()(binding);
      }
    },
  };
};
