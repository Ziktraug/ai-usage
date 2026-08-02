import { describe, expect, test } from 'bun:test';
import type { ReportContractClient } from '@ai-usage/web-contract/report';
import { createReportClient } from './report-client';

interface RecordedCall {
  readonly input: unknown;
  readonly path: string;
  readonly signal: AbortSignal | undefined;
}

describe('report client adapter', () => {
  test('maps every legacy-facing method to its exact contract operation and forwards abort signals', async () => {
    const calls: RecordedCall[] = [];
    const signal = new AbortController().signal;
    const record =
      (path: string, result: unknown) =>
      (input: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown> => {
        calls.push({ input, path, signal: options?.signal });
        return Promise.resolve(result);
      };
    const transport = {
      campaign: {
        labelOverrides: record('campaign.labelOverrides', { campaignLabelOverrides: [] }),
        setLabelOverride: record('campaign.setLabelOverride', { campaignLabelOverrides: [] }),
      },
      projectGroup: {
        save: record('projectGroup.save', { accepted: true }),
      },
      quota: {
        history: record('quota.history', {
          coverage: [],
          generatedAt: '2026-08-02T00:00:00.000Z',
          latest: [],
          points: [],
          skipped: 0,
          truncated: false,
        }),
      },
      report: {
        focusedBreakdown: record('report.focusedBreakdown', {}),
        focusedOverview: record('report.focusedOverview', {}),
        focusedSupport: record('report.focusedSupport', {}),
        revisionBootstrap: record('report.revisionBootstrap', {}),
        revisionManifest: record('report.revisionManifest', {}),
      },
      runtime: {
        reportPerfEnabled: record('runtime.reportPerfEnabled', true),
      },
    } as unknown as ReportContractClient;
    const client = createReportClient(transport);
    const query = {
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      range: { from: null, to: null },
      revision: 'revision-a',
    };
    const options = { signal };

    await client.getCampaignLabelOverrides(options);
    await client.setCampaignLabelOverride({ campaignKey: 'campaign-a', label: 'Alpha' }, options);
    await client.saveProjectGroups(
      {
        command: 'replace-project-groups-by-reference',
        projectGroups: [
          {
            id: 'group-a',
            name: 'Group A',
            sources: [`project-source:${'a'.repeat(64)}`],
          },
        ],
        revision: 'publication-a',
      },
      options,
    );
    await client.getProviderQuotaHistory(
      {
        from: '2026-08-01T00:00:00.000Z',
        maximumPoints: 1000,
        to: '2026-08-02T00:00:00.000Z',
      },
      options,
    );
    await client.getFocusedReportBreakdown({ query }, options);
    await client.getFocusedReportOverview(
      {
        includeAdvanced: false,
        query,
        timeline: { dimension: 'provider', granularity: 'day' },
      },
      options,
    );
    await client.getFocusedReportSupport({ revision: 'revision-a' }, options);
    await client.getReportRevisionBootstrap(options);
    await client.getReportRevisionManifest(options);
    await client.getReportPerfEnabled(options);

    expect(calls.map(({ path }) => path)).toEqual([
      'campaign.labelOverrides',
      'campaign.setLabelOverride',
      'projectGroup.save',
      'quota.history',
      'report.focusedBreakdown',
      'report.focusedOverview',
      'report.focusedSupport',
      'report.revisionBootstrap',
      'report.revisionManifest',
      'runtime.reportPerfEnabled',
    ]);
    expect(calls.every((call) => call.signal === signal)).toBe(true);
    expect(calls[0]?.input).toEqual({});
    expect(calls[7]?.input).toEqual({});
    expect(calls[8]?.input).toEqual({});
    expect(calls[9]?.input).toEqual({});
  });

  test('omits the signal option when the caller has no signal', async () => {
    const calls: RecordedCall[] = [];
    const transport = {
      campaign: {
        labelOverrides: (input: unknown, options?: { readonly signal?: AbortSignal }) => {
          calls.push({ input, path: 'campaign.labelOverrides', signal: options?.signal });
          return Promise.resolve({ campaignLabelOverrides: [] });
        },
      },
    } as unknown as ReportContractClient;

    await createReportClient(transport).getCampaignLabelOverrides();

    expect(calls).toEqual([{ input: {}, path: 'campaign.labelOverrides', signal: undefined }]);
  });

  test('imports only the public contract boundary and no server module', async () => {
    const source = await Bun.file(new URL('./report-client.ts', import.meta.url)).text();

    expect(source).toContain('@ai-usage/web-contract/report');
    expect(source).not.toContain('@orpc/server');
    expect(source).not.toContain('$lib/server');
    expect(source).not.toContain('.server');
    expect(source).not.toContain('@ai-usage/usage-store');
    expect(source).not.toContain('@ai-usage/report-data');
  });
});
