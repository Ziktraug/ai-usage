import { parseSessionQueryRequest, type SessionQueryRequest } from '@ai-usage/report-core/session-query';
import type { DashboardSearch } from '../../../dashboard-search';
import { CAMPAIGN_PAGE_SIZE } from '../../query/options/campaigns';
import { INITIAL_REPORT_TIMELINE } from '../report/composition/report-destination';
import { reportDestinationForSearch } from '../report/composition/report-search';

export {
  CAMPAIGN_MEMBER_PAGE_SIZE,
  CAMPAIGN_PAGE_SIZE,
  CAMPAIGN_RESTORATION_EXTRA_PAGES,
  CAMPAIGN_RESTORATION_PAGE_BUDGET,
  type CampaignExplorationAnchors,
  type CampaignExplorationData,
  CampaignRestorationLimitError,
  campaignMatchingMembersOptions,
  campaignMembersOptions,
  campaignsExplorationOptions,
  campaignsListOptions,
  ensureCampaignExploration,
} from '../../query/options/campaigns';

export const campaignsRequest = (search: DashboardSearch, generatedAt: string, revision: string): SessionQueryRequest =>
  parseSessionQueryRequest({
    ...reportDestinationForSearch({ ...search, tab: 'sessions' }, generatedAt, INITIAL_REPORT_TIMELINE).sessions,
    cursor: null,
    pageSize: CAMPAIGN_PAGE_SIZE,
    revision,
    sort: [{ desc: true, id: 'date' }],
  });
