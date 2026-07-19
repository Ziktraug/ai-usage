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

const demoRows = demoReportPayload.rows.map(enrichSessionPresentationRow);
const simpleRow = demoRows[2]!;
const campaignRows = Array.from({ length: 15 }, (_, index) => {
  const root = demoRows[0]!;
  if (index === 0) {
    return { ...root, rowId: 'campaign-root-row' };
  }
  return {
    ...demoRows[1]!,
    rowId: `campaign-child-row-${index}`,
    source: {
      ...demoRows[1]!.source!,
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
    const complete = buildCampaignViews(campaignRows, campaignRows)[0]!;
    const filtered = buildCampaignViews(campaignRows, campaignRows.slice(0, 6))[0]!;
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
    const summaryRow = { ...campaignRows[0]!, campaignTotalCount: 15, campaignVisibleCount: 6 };
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
    const child = campaignRows[3]!;
    const campaign = buildCampaignViews(campaignRows, campaignRows)[0]!;
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
