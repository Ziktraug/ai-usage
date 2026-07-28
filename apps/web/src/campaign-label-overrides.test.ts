import { describe, expect, test } from 'bun:test';
import type { FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import {
  campaignLabelFor,
  focusedCampaignLabelContext,
  indexCampaignLabelOverrides,
  presentCampaignTimelineSeries,
  presentFocusedOverviewSessionItem,
  presentServedCampaignDisplayRow,
} from './campaign-label-overrides';
import { demoReportPayload } from './report-data';
import { enrichReportRow } from './shared';

const baseRow = enrichReportRow(demoReportPayload.rows[0]!);

describe('campaign label presentation', () => {
  test('indexes exact opaque keys and falls back to the derived label', () => {
    const index = indexCampaignLabelOverrides([{ campaignKey: 'machine-a:codex:root', label: 'Release' }]);
    expect(campaignLabelFor(index, 'machine-a:codex:root', 'Derived')).toBe('Release');
    expect(campaignLabelFor(index, 'machine-b:codex:root', 'Derived')).toBe('Derived');
  });

  test('clones only an overridden served campaign display row without changing totals or keys', () => {
    const row = { ...baseRow, campaignKey: 'machine-a:codex:root', campaignTotalCount: 2, campaignVisibleCount: 2 };
    const index = indexCampaignLabelOverrides([{ campaignKey: row.campaignKey, label: 'Release' }]);
    const presented = presentServedCampaignDisplayRow(row, index);
    expect(presented).not.toBe(row);
    expect(presented).toEqual({ ...row, sessionLabel: 'Release' });
    expect(presentServedCampaignDisplayRow(row, new Map())).toBe(row);
  });

  test('maps only campaign-prefixed timeline series', () => {
    const index = indexCampaignLabelOverrides([{ campaignKey: 'machine-a:codex:root', label: 'Release' }]);
    expect(
      presentCampaignTimelineSeries({ key: 'campaign:machine-a:codex:root', label: 'Derived', total: 2 }, index),
    ).toEqual({ key: 'campaign:machine-a:codex:root', label: 'Release', total: 2 });
    const sessionSeries = { key: 'session:machine-a:codex:root', label: 'Derived', total: 1 };
    expect(presentCampaignTimelineSeries(sessionSeries, index)).toBe(sessionSeries);
  });

  test('isolates colliding root ids by machine and harness in focused Overview items', () => {
    const focusedItem = (machineId: string, harnessKey: string): FocusedOverviewSessionItem => ({
      costApprox: 1,
      costKnown: true,
      durationMs: 1,
      harness: harnessKey,
      kind: 'campaign',
      label: 'Derived root',
      row: enrichSessionPresentationRow({
        ...baseRow,
        harness: harnessKey,
        source: {
          ...baseRow.source,
          harnessKey,
          machineId,
          rootSourceSessionId: 'shared-root',
          sourceSessionId: 'shared-root',
        },
      }),
      sessionCount: 2,
    });
    const first = focusedItem('machine-a', 'codex');
    const second = focusedItem('machine-b', 'claude');
    const firstContext = focusedCampaignLabelContext(first);
    const secondContext = focusedCampaignLabelContext(second);
    if (!(firstContext && secondContext)) {
      throw new Error('Expected campaign contexts');
    }
    const index = indexCampaignLabelOverrides([{ campaignKey: firstContext.campaignKey, label: 'Release' }]);

    expect(
      presentFocusedOverviewSessionItem(first, (key, derived) => campaignLabelFor(index, key, derived)).label,
    ).toBe('Release');
    expect(
      presentFocusedOverviewSessionItem(second, (key, derived) => campaignLabelFor(index, key, derived)).label,
    ).toBe('Derived root');
    expect(firstContext.campaignKey).not.toBe(secondContext.campaignKey);
  });
});
