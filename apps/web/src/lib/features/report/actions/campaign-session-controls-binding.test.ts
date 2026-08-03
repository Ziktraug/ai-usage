import { describe, expect, test } from 'bun:test';
import { parseSessionQueryRequest } from '@ai-usage/report-core/session-query';
import { syntheticCampaignRow, syntheticSessionRow } from '../../sessions/table/session-table.fixtures';
import {
  type CampaignSessionControlsBinding,
  campaignFilterMatchesBinding,
  campaignSessionSelectionFor,
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
  sessionCount: 1,
  visibleRows: [campaign],
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

  test('keeps hidden-child selection on the served query and its session count', () => {
    expect(campaignSessionSelectionFor(binding, hiddenSession)).toEqual({ query, row: hiddenSession, total: 1 });
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
