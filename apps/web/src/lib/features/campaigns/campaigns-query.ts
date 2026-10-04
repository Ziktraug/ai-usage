import { parseSessionQueryRequest, type SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { DashboardSearch } from '../../../dashboard-search';
import { sessionCampaignInfiniteOptions, sessionPagesInfiniteOptions } from '../../query/options/session-window';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { INITIAL_REPORT_TIMELINE } from '../report/composition/report-destination';
import { reportDestinationForSearch } from '../report/composition/report-search';

export const CAMPAIGN_PAGE_SIZE = 40;
export const CAMPAIGN_MEMBER_PAGE_SIZE = 100;

export const campaignsRequest = (search: DashboardSearch, generatedAt: string, revision: string): SessionQueryRequest =>
  parseSessionQueryRequest({
    ...reportDestinationForSearch({ ...search, tab: 'sessions' }, generatedAt, INITIAL_REPORT_TIMELINE).sessions,
    cursor: null,
    pageSize: CAMPAIGN_PAGE_SIZE,
    revision,
    sort: [{ desc: true, id: 'date' }],
  });

export const campaignsListOptions = (client: SessionClientAdapter, request: SessionQueryRequest) => {
  const { cursor: _cursor, revision, ...scope } = request;
  return sessionPagesInfiniteOptions(client, scope, revision);
};

export const campaignMembersOptions = (client: SessionClientAdapter, revision: string, campaignKey: string) =>
  sessionCampaignInfiniteOptions(
    client,
    parseSessionQueryRequest({
      cursor: null,
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      pageSize: CAMPAIGN_MEMBER_PAGE_SIZE,
      range: { from: null, to: null },
      revision,
      sort: [{ desc: false, id: 'date' }],
    }),
    campaignKey,
    'campaign-sessions',
  );
