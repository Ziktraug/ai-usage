import { describe, expect, test } from 'bun:test';
import { applyCampaignLabelOverrideMutation } from '@ai-usage/report-core/campaign-label';
import { projectFocusedOverview } from '@ai-usage/report-core/focused-report-query';
import { enrichSessionPresentationRow } from '@ai-usage/report-core/session-query';
import { compile } from 'svelte/compiler';
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
import { createSessionDetailController } from '../../sessions/detail/controller';
import type { SessionDetailQueryOwner } from '../../sessions/detail/query-owner';

const sourcePath = new URL('./synthetic-report-destination.svelte', import.meta.url);
const syntheticDetailQueryOwner = (): SessionDetailQueryOwner => ({
  close: () => undefined,
  loadDetail: () => Promise.resolve(undefined),
  loadNeighbors: () => Promise.resolve(undefined),
  loadVcs: () => Promise.resolve(undefined),
  resetDetail: () => undefined,
  resetVcs: () => undefined,
});

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
    const selectedRowIds: (string | null)[] = [];
    const controller = createSessionDetailController({
      onSelectedRowId: (rowId) => selectedRowIds.push(rowId),
      query: syntheticDetailQueryOwner(),
      rows: () => [campaignRow],
    });
    const publishedLabels: string[] = [];
    const unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.row) {
        publishedLabels.push(snapshot.row.sessionLabel);
      }
    });
    controller.select({ row: campaignRow });

    const republish = (overrides: ReturnType<typeof applyCampaignLabelOverrideMutation>): void => {
      const currentRow = controller.current().row;
      if (!currentRow) {
        throw new Error('Expected the campaign drawer to remain open');
      }
      const index = indexCampaignLabelOverrides(overrides);
      const row = presentServedCampaignDisplayRow({ ...currentRow, sessionLabel: campaignRow.sessionLabel }, index);
      controller.select({ row });
    };
    const renamedOverrides = applyCampaignLabelOverrideMutation([], { campaignKey, label: 'Release train' });
    republish(renamedOverrides);
    const renamed = controller.current().row;
    expect(renamed).toMatchObject({
      campaignKey,
      rowId: campaignRow.rowId,
      sessionLabel: 'Release train',
    });

    const resetOverrides = applyCampaignLabelOverrideMutation(renamedOverrides, { campaignKey, label: null });
    republish(resetOverrides);
    expect(controller.current().row).toMatchObject({
      campaignKey,
      rowId: campaignRow.rowId,
      sessionLabel: 'Build report UI',
    });
    expect(publishedLabels).toEqual(['Build report UI', 'Release train', 'Build report UI']);
    expect(selectedRowIds).toEqual([campaignRow.rowId]);

    unsubscribe();
    controller.dispose();
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

  test('compiles the synthetic owner and keeps campaign mutations page-local', async () => {
    const source = await Bun.file(sourcePath).text();
    const compiled = compile(source, {
      filename: sourcePath.pathname,
      generate: 'server',
      modernAst: true,
      runes: true,
    });

    expect(compiled.warnings.filter(({ code }) => code !== 'css_unused_selector')).toEqual([]);
    expect(source).toContain('let campaignLabelOverrides = $state<readonly CampaignLabelOverride[]>([])');
    expect(source).toContain('derivedCampaignLabels.get(campaignKey) ?? row.sessionLabel');
    expect(source).toContain('applyCampaignLabelOverrideMutation(campaignLabelOverrides');
    expect(source).toContain('republishSelectedCampaign(campaignKey, nextIndex)');
    expect(source).toContain('candidate.rowId === row.rowId ? row : presentCampaignRow(candidate, index)');
    expect(source).toContain('detailController.select(nextSelection)');
    expect(source).toContain('{presentCampaignSeries}');
    expect(source).toContain('{presentSessionItem}');
    expect(source).toContain('focusedCampaignLabelContext(presented)');
    expect(source).toContain('{campaignSlot}');
    expect(source).toContain('{presentMachineLabel}');
    expect(source).toContain('{presentMachineSeries}');
    expect(source).toContain("runtimeMode === 'e2e' ? syntheticMachineFreshness : support.machineFreshness");
    expect(source).toContain("runtimeMode === 'demo' ? 'Synthetic data' : machineFreshnessStatus");
    expect(source).toContain("runtimeMode === 'e2e' ? machinePresentations.get(value)?.label : undefined");
    expect(source).not.toContain('setCampaignLabelOverride');
    expect(source).not.toContain('createCampaignLabelOwner');
  });
});
