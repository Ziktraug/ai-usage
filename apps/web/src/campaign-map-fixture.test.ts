import { describe, expect, test } from 'bun:test';
import { buildCampaignMap } from '@ai-usage/report-core/campaign-map';
import { isSerializedUsageRow } from '@ai-usage/report-core/report-data';
import { enrichSessionPresentationRow, projectSessionPage } from '@ai-usage/report-core/session-query';
import { campaignMapFixtureRootKey, campaignMapFixtureRows } from './campaign-map-fixture';

describe('Campaigns demo fixture', () => {
  test('uses canonical portable rows without accessing local history', () => {
    for (const row of campaignMapFixtureRows) {
      expect(isSerializedUsageRow(row)).toBe(true);
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
      expect(row.source?.artifactPath).toBeUndefined();
      expect(row.source?.sourcePath).toBeUndefined();
    }
  });

  test('projects a five-session campaign and three independent campaigns', () => {
    const page = projectSessionPage(campaignMapFixtureRows, {
      cursor: null,
      filters: { fields: {}, harness: [], machine: [], query: '' },
      pageSize: 200,
      range: { from: null, to: null },
      revision: 'campaign-map-demo',
      sort: [{ desc: true, id: 'date' }],
    });
    expect(page.itemCount).toBe(4);
    expect(page.sessionCount).toBe(8);
    const main = page.items.find((item) => item.campaignKey === campaignMapFixtureRootKey);
    expect(main?.row).toMatchObject({
      campaignTotalCount: 5,
      sessionLabel: 'Build forecast model',
      tokenTotal: 1_300_000,
    });
  });

  test('retains missing timing and an unresolved parent as distinct limitations', () => {
    const incomplete = campaignMapFixtureRows.find((row) => row.source?.sourceSessionId === 'cursor-layout');
    expect(incomplete).toMatchObject({
      costKnown: false,
      date: '2026-06-11T07:00:00.000Z',
      durationMs: null,
      endDate: null,
      originProvenance: 'origin-unsupported',
      partial: true,
    });
    expect(incomplete?.origin).toBeUndefined();
    const orphan = campaignMapFixtureRows.find((row) => row.source?.sourceSessionId === 'orphan-review');
    expect(orphan?.source).toMatchObject({
      parentSourceSessionId: 'unavailable-parent',
      rootSourceSessionId: 'orphan-review',
    });
    expect(campaignMapFixtureRows.some((row) => row.source?.sourceSessionId === 'unavailable-parent')).toBe(false);
  });

  test('demonstrates nested and overlapping sessions on one observed time scale', () => {
    const [root, ...children] = campaignMapFixtureRows
      .filter((row) => row.source?.rootSourceSessionId === 'forecast-root')
      .map(enrichSessionPresentationRow);
    if (!root) {
      throw new Error('The Campaigns fixture must contain the forecast root');
    }
    const map = buildCampaignMap({ campaignKey: campaignMapFixtureRootKey, children, root, totalCount: 5 });
    expect(map).toMatchObject({
      loadedCount: 5,
      maxConcurrency: 4,
      timingComplete: true,
      tokenTotal: 1_300_000,
      usageComplete: true,
      wallClockDurationMs: 80 * 60_000,
    });
    const nested = map.nodes.find((node) => node.row.source?.sourceSessionId === 'forecast-tests');
    const parent = map.nodes.find((node) => node.row.source?.sourceSessionId === 'forecast-ingestion');
    expect(nested).toMatchObject({ depth: 2, parentRowId: parent?.row.rowId, relationship: 'child' });
  });
});
