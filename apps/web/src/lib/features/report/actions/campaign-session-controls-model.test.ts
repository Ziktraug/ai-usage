import { describe, expect, test } from 'bun:test';
import type { SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { syntheticCampaignRow, syntheticSessionRow } from '../../sessions/table/session-table.fixtures';
import type { SessionTableQueryState } from '../../sessions/table/session-table-query-owner';
import { campaignSessionControlsModel, campaignSessionControlsState } from './campaign-session-controls-model';

const campaignKey = 'machine-a:codex:root-a';
const query = (campaign: string | null = campaignKey): SessionQueryRequest => ({
  cursor: null,
  filters: {
    fields: campaign === null ? {} : { campaign },
    harness: [],
    machine: [],
    query: '',
  },
  pageSize: 50,
  range: { from: null, to: null },
  revision: 'revision-campaign-controls',
  sort: [{ desc: true, id: 'date' }],
});

const campaignFixture = () => {
  const root = syntheticSessionRow(1);
  const visibleChild = syntheticSessionRow(2);
  const hiddenChild = syntheticSessionRow(3);
  const campaign = {
    ...syntheticCampaignRow(1),
    campaignKey,
    campaignTotalCount: 4,
    campaignVisibleCount: 2,
    costApprox: 99,
  };
  return { campaign, hiddenChild, root, visibleChild };
};

describe('campaign session controls model', () => {
  test('adapts the real owner maps without making the aggregate selectable', () => {
    const { campaign, hiddenChild, root, visibleChild } = campaignFixture();
    const ownerState = {
      campaignChildren: new Map([
        [
          campaignKey,
          {
            items: [visibleChild],
            loading: false,
            nextCursor: null,
            root,
            sessionCount: 1,
            totalCount: 1,
          },
        ],
      ]),
      campaignSessions: new Map([
        [
          campaignKey,
          {
            items: [visibleChild, hiddenChild],
            loading: false,
            nextCursor: 'next-page',
            root,
            sessionCount: 3,
            totalCount: 3,
          },
        ],
      ]),
      itemCount: 1,
      items: [{ campaignKey, kind: 'campaign' as const, row: campaign }],
      loadingMore: false,
      nextCursor: null,
      query: query(),
      sessionCount: 2,
    } satisfies SessionTableQueryState;

    const adapted = campaignSessionControlsState(ownerState, campaign);

    expect(adapted?.collection).toMatchObject({
      loading: false,
      nextCursor: 'next-page',
      totalCount: 4,
    });
    expect(adapted?.collection.items).toEqual([root, visibleChild, hiddenChild]);
    expect(adapted?.collection.items).not.toContain(campaign);
    expect(adapted?.visibleRows).toEqual([root, visibleChild]);
  });

  test('keeps partial pagination truthful and shows only loaded filtered sessions by default', () => {
    const { campaign, hiddenChild, root, visibleChild } = campaignFixture();
    const filtered = campaignSessionControlsModel({
      campaign,
      collection: { items: [root, visibleChild, hiddenChild], loading: true, nextCursor: 'next-page', totalCount: 4 },
      query: query(),
      showAll: false,
      visibleRows: [root, visibleChild],
    });
    const all = campaignSessionControlsModel({
      campaign,
      collection: { items: [root, visibleChild, hiddenChild], loading: false, nextCursor: 'next-page', totalCount: 4 },
      query: query(),
      showAll: true,
      visibleRows: [root, visibleChild],
    });

    expect(filtered).toMatchObject({
      allSessionsLoaded: false,
      campaignKey,
      canClearCampaignFilter: true,
      canLoadMore: true,
      hiddenCount: 2,
      loadedCount: 3,
      loading: true,
      totalCount: 4,
      visibleCount: 2,
    });
    expect(filtered?.sessions.map(({ hidden, row }) => [row.rowId, hidden])).toEqual([
      [root.rowId, false],
      [visibleChild.rowId, false],
    ]);
    expect(all?.sessions.map(({ hidden, row }) => [row.rowId, hidden])).toEqual([
      [root.rowId, false],
      [visibleChild.rowId, false],
      [hiddenChild.rowId, true],
    ]);
  });

  test('never prepends the aggregate and preserves the exact actual root/session objects and metrics', () => {
    const { campaign, root, visibleChild } = campaignFixture();
    const model = campaignSessionControlsModel({
      campaign,
      collection: { items: [root, visibleChild, visibleChild], loading: false, nextCursor: null, totalCount: 2 },
      query: query(),
      showAll: true,
      visibleRows: [root, visibleChild],
    });

    expect(model?.campaignKey).toBe(campaignKey);
    expect(model?.campaignKey).not.toBe(campaign.sessionLabel);
    expect(model?.sessions.map(({ row }) => row)).toEqual([root, visibleChild]);
    expect(model?.sessions[0]?.row).toBe(root);
    expect(model?.sessions[0]?.row).not.toBe(campaign);
    expect(model?.sessions[0]?.row.costApprox).toBe(root.costApprox);
    expect(model).toMatchObject({ allSessionsLoaded: true, canLoadMore: false, loadedCount: 2 });
  });

  test('offers the scoped clear action for an exact active campaign even when no sessions are hidden', () => {
    const { campaign, root, visibleChild } = campaignFixture();
    const fullyVisibleCampaign = { ...campaign, campaignTotalCount: 2, campaignVisibleCount: 2 };

    expect(
      campaignSessionControlsModel({
        campaign: fullyVisibleCampaign,
        collection: { items: [root, visibleChild], loading: false, nextCursor: null, totalCount: 2 },
        query: query(),
        showAll: false,
        visibleRows: [root, visibleChild],
      }),
    ).toMatchObject({ canClearCampaignFilter: true, hiddenCount: 0 });
    expect(
      campaignSessionControlsModel({
        campaign,
        collection: { items: [root], loading: false, nextCursor: null, totalCount: 4 },
        query: query('machine-b:codex:root-b'),
        showAll: false,
        visibleRows: [root],
      })?.canClearCampaignFilter,
    ).toBe(false);
    expect(
      campaignSessionControlsModel({
        campaign,
        collection: { items: [root], loading: false, nextCursor: null, totalCount: 4 },
        query: query(null),
        showAll: false,
        visibleRows: [root],
      })?.canClearCampaignFilter,
    ).toBe(false);
  });

  test('rejects ordinary session rows instead of fabricating a campaign identity', () => {
    expect(
      campaignSessionControlsModel({
        campaign: syntheticSessionRow(9),
        collection: { items: [], loading: false, nextCursor: null, totalCount: 0 },
        query: query(),
        showAll: false,
        visibleRows: [],
      }),
    ).toBeNull();
  });
});
