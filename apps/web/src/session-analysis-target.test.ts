import { describe, expect, test } from 'bun:test';
import { enrichSessionPresentationRow, type SessionPageItem } from '@ai-usage/report-core/session-query';
import { buildCampaignViews } from './dashboard-model';
import { demoReportPayload } from './report-data';
import {
  sessionAnalysisTargetForCampaign,
  sessionAnalysisTargetForPageItem,
  sessionAnalysisTargetForSession,
  sessionAnalysisTargetForTopLevelRow,
} from './session-analysis-target';
import { canAnalyzeSession } from './session-detail-client';

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
  test('keeps a simple served session atomic', () => {
    const item = { kind: 'session', row: simpleRow } satisfies SessionPageItem;
    expect(sessionAnalysisTargetForPageItem(item)).toEqual({
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

  test('keeps a loaded campaign child and neighbor navigation atomic', () => {
    const child = requireValue(campaignRows[3], 'loaded campaign child');
    const campaign = requireValue(buildCampaignViews(campaignRows, campaignRows)[0], 'navigation campaign');
    expect(sessionAnalysisTargetForTopLevelRow({ campaigns: [campaign], pageItems: [], row: child })).toMatchObject({
      kind: 'session',
      reportRowId: child.rowId,
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

  test('does not offer analysis for Overview selection without a served revision', () => {
    const target = sessionAnalysisTargetForSession(simpleRow);
    expect(canAnalyzeSession({ revision: null, rowId: target.reportRowId })).toBe(false);
    expect(canAnalyzeSession({ revision: 'revision-a', rowId: target.reportRowId })).toBe(true);
  });
});
