import { describe, expect, test } from 'bun:test';
import { applyCampaignLabelOverrideMutation } from '@ai-usage/report-core/campaign-label';
import { projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import {
  campaignLabelFor,
  focusedCampaignLabelContext,
  indexCampaignLabelOverrides,
  presentCampaignTimelineSeries,
  presentFocusedOverviewSessionItem,
  presentServedCampaignDisplayRow,
} from '../../../../campaign-label-overrides';
import { buildCampaignTableRows } from '../../../../dashboard-model';
import {
  machineFreshnessSnapshotFromFocused,
  machineLabelPresentationForSnapshot,
} from '../../../../machine-freshness-presentation';
import { demoReportPayload } from '../../../../report-data';
import type { SessionSelectionInput } from '../../sessions/detail/types';

describe('synthetic report campaign presentation', () => {
  test('renames every synthetic campaign projection locally and resets to the stable derived label after reopen', () => {
    const { rows, tableRows: _tableRows, ...support } = demoReportPayload;
    const allRows = rows.map(enrichSessionPresentationRow);
    const campaignRows = buildCampaignTableRows(allRows, allRows, [{ desc: true, id: 'date' }]);
    const campaignRow = campaignRows.find(({ sessionLabel }) => sessionLabel === 'Build report UI');
    if (!campaignRow?.campaignKey) {
      throw new Error('Expected the synthetic Codex campaign');
    }
    const campaignKey = campaignRow.campaignKey;
    const overview = projectFocusedOverview(rows, support, {
      includeAdvanced: true,
      query: {
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        range: { from: null, to: null },
        revision: 'synthetic-test',
      },
      timeline: { dimension: 'campaign', granularity: 'day' },
    });
    const overviewItem = overview.view.topSessions.find(({ label }) => label === campaignRow.sessionLabel);
    const timelineSeries = overview.timeline?.series.find(({ key }) => key === `campaign:${campaignKey}`);
    if (!(overviewItem && timelineSeries)) {
      throw new Error('Expected matching synthetic Overview campaign projections');
    }

    const renamedOverrides = applyCampaignLabelOverrideMutation([], {
      campaignKey,
      label: 'Migration campaign',
    });
    const renamedIndex = indexCampaignLabelOverrides(renamedOverrides);
    const renamedRow = presentServedCampaignDisplayRow(campaignRow, renamedIndex);
    const renamedOverview = presentFocusedOverviewSessionItem(overviewItem, (key, derivedLabel) =>
      campaignLabelFor(renamedIndex, key, derivedLabel),
    );
    const renamedTimeline = presentCampaignTimelineSeries(timelineSeries, renamedIndex);

    expect(renamedRow).toMatchObject({ campaignKey, sessionLabel: 'Migration campaign' });
    expect(focusedCampaignLabelContext(renamedOverview)?.campaignKey).toBe(campaignKey);
    expect(renamedOverview.label).toBe('Migration campaign');
    expect(renamedTimeline).toMatchObject({ key: `campaign:${campaignKey}`, label: 'Migration campaign' });

    const stableDerivedLabel =
      campaignRows.find((candidate) => candidate.campaignKey === renamedRow.campaignKey)?.sessionLabel ??
      renamedRow.sessionLabel;
    const resetOverrides = applyCampaignLabelOverrideMutation(renamedOverrides, {
      campaignKey: renamedRow.campaignKey,
      label: null,
    });
    expect(campaignLabelFor(indexCampaignLabelOverrides(resetOverrides), campaignKey, stableDerivedLabel)).toBe(
      'Build report UI',
    );
    expect(resetOverrides).toEqual([]);
  });
  test('republishes an open drawer across rename and reset without changing selection or filter identity', () => {
    const allRows = demoReportPayload.rows.map(enrichSessionPresentationRow);
    const campaignRow = buildCampaignTableRows(allRows, allRows, [{ desc: true, id: 'date' }]).find(
      ({ sessionLabel }) => sessionLabel === 'Build report UI',
    );
    if (!campaignRow?.campaignKey) {
      throw new Error('Expected the synthetic Codex campaign drawer row');
    }
    const campaignKey = campaignRow.campaignKey;
    let selection: SessionSelectionInput = { row: campaignRow };
    const publishedLabels = [campaignRow.sessionLabel];
    const republish = (overrides: ReturnType<typeof applyCampaignLabelOverrideMutation>): void => {
      const index = indexCampaignLabelOverrides(overrides);
      const row = presentServedCampaignDisplayRow({ ...selection.row, sessionLabel: campaignRow.sessionLabel }, index);
      selection = { ...selection, row };
      publishedLabels.push(row.sessionLabel);
    };

    const renamedOverrides = applyCampaignLabelOverrideMutation([], { campaignKey, label: 'Release train' });
    republish(renamedOverrides);
    expect(selection.row).toMatchObject({
      campaignKey,
      rowId: campaignRow.rowId,
      sessionLabel: 'Release train',
    });

    const resetOverrides = applyCampaignLabelOverrideMutation(renamedOverrides, { campaignKey, label: null });
    republish(resetOverrides);
    expect(selection.row).toMatchObject({
      campaignKey,
      rowId: campaignRow.rowId,
      sessionLabel: 'Build report UI',
    });
    expect(publishedLabels).toEqual(['Build report UI', 'Release train', 'Build report UI']);
  });

  test('keeps synthetic machine values stable while presenting frozen stale and unavailable labels', () => {
    const snapshot = machineFreshnessSnapshotFromFocused({
      kind: 'available',
      machines: [
        {
          id: 'fixture-machine',
          label: 'Fixture Machine',
          lastSeenAt: demoReportPayload.generatedAt,
        },
      ],
      observedAt: '2026-07-12T12:00:00.000Z',
      omittedMachines: 0,
      skippedRows: 0,
    });

    expect(machineLabelPresentationForSnapshot({ id: 'fixture-machine', label: 'Fixture Machine' }, snapshot)).toEqual({
      freshness: 'stale',
      label: 'Fixture Machine · Stale',
      value: 'fixture-machine',
    });
    expect(
      machineLabelPresentationForSnapshot(
        { id: 'fixture-machine-secondary', label: 'Fixture Machine Secondary' },
        snapshot,
      ),
    ).toEqual({
      freshness: 'unavailable',
      label: 'Fixture Machine Secondary · Freshness unavailable',
      value: 'fixture-machine-secondary',
    });
  });
});

test('keeps the compact period control global and mounts activity exploration only in Overview', async () => {
  const presentationSource = await Bun.file(
    new URL('./report-destination-presentation.svelte', import.meta.url),
  ).text();
  const overviewSource = await Bun.file(new URL('../overview/overview-page.svelte', import.meta.url)).text();
  const executiveSource = await Bun.file(new URL('../overview/executive-overview.svelte', import.meta.url)).text();
  const liveSource = await Bun.file(new URL('./live-report-destination.svelte', import.meta.url)).text();
  const syntheticSource = await Bun.file(new URL('./synthetic-report-destination.svelte', import.meta.url)).text();

  expect(presentationSource).toContain("import ReportPeriodControl from '../range/report-period-control.svelte'");
  expect(presentationSource).toContain('<ReportPeriodControl {...range.props} />');
  expect(presentationSource).not.toContain('ActivityExplorer');
  expect(overviewSource).toContain("import ExecutiveOverview from './executive-overview.svelte'");
  expect(executiveSource).toContain("import ActivityExplorer from '../range/activity-explorer.svelte'");
  expect(executiveSource).toContain('<ActivityExplorer {...activity} />');
  expect(liveSource).toContain('activity: {');
  expect(syntheticSource).toContain('activity: {');
});

test('keeps executive composition presentation-only and threads retained state through both owners', async () => {
  const overviewSource = await Bun.file(new URL('../overview/overview-page.svelte', import.meta.url)).text();
  const executiveSource = await Bun.file(new URL('../overview/executive-overview.svelte', import.meta.url)).text();
  const liveSource = await Bun.file(new URL('./live-report-destination.svelte', import.meta.url)).text();
  const syntheticSource = await Bun.file(new URL('./synthetic-report-destination.svelte', import.meta.url)).text();

  for (const source of [overviewSource, executiveSource]) {
    expect(source).not.toContain('createQuery');
    expect(source).not.toContain('fetchReport');
    expect(source).not.toContain('/rpc/');
  }
  for (const source of [liveSource, syntheticSource]) {
    expect(source).toContain('onClearFilters: navigation.clearAllFilters');
    expect(source).toContain("onOpenModels: () => navigation.setBreakdownTab('models')");
    expect(source).toContain('activeDestinationLoadFailed');
    expect(source).toContain('onRetry={retryReportDestination}');
  }
  expect(liveSource).toContain('totalSessionCount:');
  expect(syntheticSource).toContain('totalSessionCount,');
  expect(syntheticSource).toContain('hasOutput={true}');
  expect(syntheticSource).toContain(
    'responseFixture?.bootstrap.support.analytics.sessionCount ?? support.support.analytics.sessionCount',
  );
  expect(syntheticSource).not.toContain('hasOutput={!pending}');
});
