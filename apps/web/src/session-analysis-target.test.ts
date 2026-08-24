import { describe, expect, test } from 'bun:test';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import { buildCampaignViews } from './dashboard-model';
import { demoReportPayload } from './report-data';
import {
  sessionAnalysisTargetForCampaign,
  sessionAnalysisTargetForOverviewRow,
  sessionAnalysisTargetForPageItem,
  sessionAnalysisTargetForSession,
  sessionAnalysisTargetForTopLevelRow,
} from './session-analysis-target';

const requireValue = <Value>(value: Value | undefined, label: string): Value => {
  if (value === undefined) {
    throw new Error(`Missing ${label} fixture`);
  }
  return value;
};

const demoRows = demoReportPayload.rows.map(enrichSessionPresentationRow);
const rootRow = requireValue(demoRows[0], 'campaign root');
const childRow = requireValue(demoRows[1], 'campaign child');
const childSource = requireValue(childRow.source, 'campaign child source');
const simpleRow = requireValue(demoRows[2], 'simple row');
const campaignRows = Array.from({ length: 15 }, (_, index) => {
  if (index === 0) {
    return { ...rootRow, rowId: 'campaign-root-row' };
  }
  return {
    ...childRow,
    rowId: `campaign-child-row-${index}`,
    source: {
      ...childSource,
      parentSourceSessionId: 'campaign-root',
      rootSourceSessionId: 'campaign-root',
      sourceSessionId: `campaign-child-${index}`,
    },
  };
});

describe('session analysis target', () => {
  test('keeps atomic rows available through the explicit session target', () => {
    expect(sessionAnalysisTargetForSession(simpleRow)).toEqual({
      kind: 'session',
      reportRowId: simpleRow.rowId,
      summaryRow: simpleRow,
    });
  });

  test('adapts complete and filtered in-memory campaigns with root identity', () => {
    const complete = requireValue(buildCampaignViews(campaignRows, campaignRows)[0], 'complete campaign');
    const filtered = requireValue(buildCampaignViews(campaignRows, campaignRows.slice(0, 6))[0], 'filtered campaign');
    const completeSummary = { ...complete.root, campaignTotalCount: 15, campaignVisibleCount: 15 };
    const filteredSummary = { ...filtered.root, campaignTotalCount: 15, campaignVisibleCount: 6 };

    expect(sessionAnalysisTargetForCampaign(completeSummary, complete)).toMatchObject({
      kind: 'campaign-root',
      reportRowId: 'campaign-root-row',
      totalCount: 15,
      visibleCount: 15,
    });
    expect(sessionAnalysisTargetForCampaign(filteredSummary, filtered)).toMatchObject({
      kind: 'campaign-root',
      reportRowId: 'campaign-root-row',
      summaryRow: filteredSummary,
      totalCount: 15,
      visibleCount: 6,
    });
  });

  test('uses the served page discriminant for a campaign row', () => {
    const summaryRow = {
      ...requireValue(campaignRows[0], 'served campaign row'),
      campaignTotalCount: 15,
      campaignVisibleCount: 6,
    };
    expect(
      sessionAnalysisTargetForPageItem({ campaignKey: 'fixture-campaign', kind: 'campaign', row: summaryRow }),
    ).toMatchObject({
      campaignKey: 'fixture-campaign',
      kind: 'campaign-root',
      reportRowId: 'campaign-root-row',
      totalCount: 15,
      visibleCount: 6,
    });
  });

  test('opens the campaign an Overview aggregate row describes', () => {
    const summaryRow = {
      ...requireValue(campaignRows[0], 'overview campaign row'),
      campaignKey: 'fixture-campaign',
      campaignTotalCount: 3,
      campaignVisibleCount: 3,
    };
    expect(sessionAnalysisTargetForOverviewRow(summaryRow)).toMatchObject({
      campaignKey: 'fixture-campaign',
      kind: 'campaign-root',
      reportRowId: 'campaign-root-row',
      totalCount: 3,
      visibleCount: 3,
    });
  });

  test('keeps a plain Overview session row atomic', () => {
    expect(sessionAnalysisTargetForOverviewRow(simpleRow)).toEqual({
      kind: 'session',
      reportRowId: simpleRow.rowId,
      summaryRow: simpleRow,
    });
  });

  test('keeps campaign children and neighbor navigation atomic outside the top-level projection', () => {
    const child = requireValue(campaignRows[3], 'loaded campaign child');
    const campaign = requireValue(buildCampaignViews(campaignRows, campaignRows)[0], 'navigation campaign');
    expect(sessionAnalysisTargetForSession(child)).toMatchObject({
      kind: 'session',
      reportRowId: child.rowId,
    });
    expect(
      sessionAnalysisTargetForTopLevelRow({ campaigns: [campaign], pageItems: [], row: campaign.root }),
    ).toMatchObject({
      kind: 'campaign-root',
      reportRowId: campaign.root.rowId,
    });

    const neighborWithCampaignFields = {
      ...campaign.root,
      campaignTotalCount: 15,
      campaignVisibleCount: 6,
    };
    expect(sessionAnalysisTargetForSession(neighborWithCampaignFields)).toMatchObject({
      kind: 'session',
      reportRowId: campaign.root.rowId,
    });
  });
});
