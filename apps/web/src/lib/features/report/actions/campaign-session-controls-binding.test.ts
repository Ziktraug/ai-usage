import { describe, expect, test } from 'bun:test';
import {
  parseSessionQueryRequest,
  projectSessionCampaignChildren,
  projectSessionNeighbors,
  projectSessionPage,
} from '@ai-usage/report-core/session-query';
import { demoReportPayload } from '../../../../report-data';
import { syntheticCampaignRow, syntheticSessionRow } from '../../sessions/table/session-table.fixtures';
import {
  type CampaignSessionControlsBinding,
  campaignFilterMatchesBinding,
  campaignSessionSelectionFor,
  campaignSessionSelectionQuery,
  campaignSessionsNeedInitialLoad,
  createCampaignSessionControlsPublisher,
} from './campaign-session-controls-binding';

const campaign = syntheticCampaignRow(1);
const hiddenSession = syntheticSessionRow(2);
const query = parseSessionQueryRequest({
  cursor: null,
  filters: {
    fields: { campaign: campaign.campaignKey },
    harness: [],
    machine: [],
    origin: [],
    query: '',
  },
  pageSize: 100,
  range: { from: null, to: null },
  revision: 'revision-a',
  sort: [{ desc: true, id: 'date' }],
});
const binding: CampaignSessionControlsBinding = {
  campaign,
  collection: { items: [campaign, hiddenSession], loading: false, nextCursor: null, totalCount: 2 },
  loadMore: () => undefined,
  query,
  rolledUpClassifierCount: 0,
  selectionQuery: campaignSessionSelectionQuery(query, campaign.campaignKey ?? ''),
  sessionCount: 1,
  visibleRows: [campaign],
};

const requireValue = <Value>(value: Value | undefined | null, label: string): Value => {
  if (value == null) {
    throw new Error(`Missing ${label} fixture.`);
  }
  return value;
};

describe('campaign session composition binding', () => {
  test('loads only the absent initial collection and leaves reselection to the explicit pager', () => {
    expect(campaignSessionsNeedInitialLoad(undefined, 'campaign-a')).toBe(true);
    expect(campaignSessionsNeedInitialLoad(new Map(), 'campaign-a')).toBe(true);
    expect(campaignSessionsNeedInitialLoad(new Map([['campaign-a', { nextCursor: 'next' }]]), 'campaign-a')).toBe(
      false,
    );
  });

  test('clears only the exact campaign still represented by the binding', () => {
    expect(campaignFilterMatchesBinding('campaign-a', 'campaign-a')).toBe(true);
    expect(campaignFilterMatchesBinding('campaign-b', 'campaign-a')).toBe(false);
    expect(campaignFilterMatchesBinding(undefined, 'campaign-a')).toBe(false);
  });

  test('uses an exact campaign-scoped query and consistent total for hidden-child selection', () => {
    const selection = campaignSessionSelectionFor(binding, hiddenSession);
    expect(selection).toEqual({ query: binding.selectionQuery, row: hiddenSession, total: 1 });
    expect(selection.query).toMatchObject({
      cursor: null,
      filters: {
        fields: { campaign: campaign.campaignKey },
        harness: [],
        machine: [],
        origin: [],
        query: '',
      },
      range: { from: null, to: null },
      revision: query.revision,
      sort: query.sort,
    });

    const unfilteredPage = projectSessionPage(demoReportPayload.rows, {
      ...query,
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
    });
    const campaignWithChildren = requireValue(
      unfilteredPage.items
        .map((item) => ({
          children: projectSessionCampaignChildren(demoReportPayload.rows, {
            campaignKey: item.campaignKey,
            query: campaignSessionSelectionQuery(query, item.campaignKey),
          }),
          item,
        }))
        .find(({ children }) => children.itemCount > 0),
      'campaign with children',
    );
    const selectedHiddenRow = requireValue(campaignWithChildren.children.items[0], 'hidden campaign child');
    const exactCampaignQuery = campaignSessionSelectionQuery(query, campaignWithChildren.item.campaignKey);
    expect(
      projectSessionNeighbors(demoReportPayload.rows, { query: exactCampaignQuery, rowId: selectedHiddenRow.rowId }),
    ).toMatchObject({ found: true, revision: query.revision });
    expect(projectSessionPage(demoReportPayload.rows, exactCampaignQuery).sessionCount).toBe(
      campaignWithChildren.children.itemCount + 1,
    );
  });

  test('publishes one null binding when the Sessions owner unmounts', () => {
    const published: (CampaignSessionControlsBinding | null)[] = [];
    const publisher = createCampaignSessionControlsPublisher(() => (value) => published.push(value));
    publisher.publish(binding);
    publisher.dispose();
    publisher.dispose();
    publisher.publish(binding);
    expect(published).toEqual([binding, null]);
  });
});
