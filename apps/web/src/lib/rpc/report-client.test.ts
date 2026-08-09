import { describe, expect, test } from 'bun:test';
import {
  type FocusedBreakdownRequest,
  type FocusedOverviewRequest,
  type FocusedRevisionRequest,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  focusedRevisionFingerprint,
} from '@ai-usage/report-core/focused-report-query';
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
    const focusedResponse = (
      path: string,
      input: FocusedBreakdownRequest | FocusedOverviewRequest | FocusedRevisionRequest,
      requestFingerprint: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<unknown> => {
      calls.push({ input, path, signal: options?.signal });
      const responseRevision = 'query' in input ? input.query.revision : input.revision;
      return Promise.resolve({
        error: { message: 'Query failed.', revision: responseRevision, tag: 'QueryFailed' },
        ok: false,
        requestFingerprint,
        revision: responseRevision,
      });
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
        focusedBreakdown: (input: FocusedBreakdownRequest, options?: { readonly signal?: AbortSignal }) =>
          focusedResponse('report.focusedBreakdown', input, focusedBreakdownFingerprint(input), options),
        focusedOverview: (input: FocusedOverviewRequest, options?: { readonly signal?: AbortSignal }) =>
          focusedResponse('report.focusedOverview', input, focusedOverviewFingerprint(input), options),
        focusedSupport: (input: FocusedRevisionRequest, options?: { readonly signal?: AbortSignal }) =>
          focusedResponse('report.focusedSupport', input, focusedRevisionFingerprint('support', input), options),
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

  test('validates focused responses against the originating request before returning them', async () => {
    const query = {
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      range: { from: null, to: null },
      revision: 'revision-a',
    };
    const breakdownInput: FocusedBreakdownRequest = { query };
    const overviewInput: FocusedOverviewRequest = {
      includeAdvanced: false,
      query,
      timeline: { dimension: 'provider', granularity: 'day' },
    };
    const supportInput: FocusedRevisionRequest = { revision: query.revision };
    const clientFor = (report: object) => createReportClient({ report } as unknown as ReportContractClient);

    await expect(
      clientFor({
        focusedSupport: () =>
          Promise.resolve({
            error: { message: 'Query failed.', revision: query.revision, tag: 'QueryFailed' },
            ok: false,
            requestFingerprint: 'wrong-fingerprint',
            revision: query.revision,
          }),
      }).getFocusedReportSupport(supportInput),
    ).rejects.toThrow('identity');

    await expect(
      clientFor({
        focusedOverview: () =>
          Promise.resolve({
            error: { message: 'Query failed.', revision: 'revision-b', tag: 'QueryFailed' },
            ok: false,
            requestFingerprint: focusedOverviewFingerprint(overviewInput),
            revision: 'revision-b',
          }),
      }).getFocusedReportOverview(overviewInput),
    ).rejects.toThrow('identity');

    await expect(
      clientFor({
        focusedBreakdown: () =>
          Promise.resolve({
            error: { message: 'Query failed.', revision: query.revision, tag: 'QueryFailed' },
            extra: true,
            ok: false,
            requestFingerprint: focusedBreakdownFingerprint(breakdownInput),
            revision: query.revision,
          }),
      }).getFocusedReportBreakdown(breakdownInput),
    ).rejects.toThrow('focused report result');

    await expect(
      clientFor({
        focusedSupport: () =>
          Promise.resolve({
            data: {},
            ok: true,
            requestFingerprint: focusedRevisionFingerprint('support', supportInput),
            revision: query.revision,
          }),
      }).getFocusedReportSupport(supportInput),
    ).rejects.toThrow();
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
