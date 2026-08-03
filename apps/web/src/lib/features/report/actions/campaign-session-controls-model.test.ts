import { describe, expect, test } from 'bun:test';
import type { SessionQueryRequest } from '@ai-usage/report-core/session-query';
import { syntheticCampaignRow, syntheticSessionRow } from '../../sessions/table/session-table.fixtures';
import { campaignSessionControlsModel } from './campaign-session-controls-model';

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
  const visibleChild = syntheticSessionRow(2);
  const hiddenChild = syntheticSessionRow(3);
  const campaign = {
    ...syntheticCampaignRow(1, [visibleChild, hiddenChild]),
    campaignKey,
    campaignTotalCount: 3,
    campaignVisibleCount: 2,
  };
  return { campaign, hiddenChild, visibleChild };
};

describe('campaign session controls model', () => {
  test('shows only filtered campaign sessions until all loaded children are requested', () => {
    const { campaign, hiddenChild, visibleChild } = campaignFixture();
    const filtered = campaignSessionControlsModel({
      campaign,
      query: query(),
      showAll: false,
      visibleRows: [campaign, visibleChild],
    });
    const all = campaignSessionControlsModel({
      campaign,
      query: query(),
      showAll: true,
      visibleRows: [campaign, visibleChild],
    });

    expect(filtered).toMatchObject({
      campaignKey,
      canClearCampaignFilter: true,
      hiddenCount: 1,
      totalCount: 3,
      visibleCount: 2,
    });
    expect(filtered?.sessions.map(({ hidden, row }) => [row.rowId, hidden])).toEqual([
      [campaign.rowId, false],
      [visibleChild.rowId, false],
    ]);
    expect(all?.sessions.map(({ hidden, row }) => [row.rowId, hidden])).toEqual([
      [campaign.rowId, false],
      [visibleChild.rowId, false],
      [hiddenChild.rowId, true],
    ]);
  });

  test('preserves stable row identity, deduplicates children, and never substitutes the campaign label for its key', () => {
    const { campaign, visibleChild } = campaignFixture();
    const model = campaignSessionControlsModel({
      campaign: { ...campaign, children: [visibleChild, visibleChild] },
      query: query(),
      showAll: true,
      visibleRows: [campaign, visibleChild],
    });

    expect(model?.campaignKey).toBe(campaignKey);
    expect(model?.campaignKey).not.toBe(campaign.sessionLabel);
    expect(model?.sessions.map(({ row }) => row.rowId)).toEqual([campaign.rowId, visibleChild.rowId]);
  });

  test('offers only the scoped clear action for the selected raw campaign filter', () => {
    const { campaign } = campaignFixture();

    expect(
      campaignSessionControlsModel({ campaign, query: query(), showAll: false, visibleRows: [campaign] })
        ?.canClearCampaignFilter,
    ).toBe(true);
    expect(
      campaignSessionControlsModel({
        campaign,
        query: query('machine-b:codex:root-b'),
        showAll: false,
        visibleRows: [campaign],
      })?.canClearCampaignFilter,
    ).toBe(false);
    expect(
      campaignSessionControlsModel({ campaign, query: query(null), showAll: false, visibleRows: [campaign] })
        ?.canClearCampaignFilter,
    ).toBe(false);
  });

  test('rejects ordinary session rows instead of fabricating a campaign identity', () => {
    expect(
      campaignSessionControlsModel({
        campaign: syntheticSessionRow(9),
        query: query(),
        showAll: false,
        visibleRows: [],
      }),
    ).toBeNull();
  });
});
