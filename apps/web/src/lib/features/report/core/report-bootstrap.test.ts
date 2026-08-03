import { describe, expect, it } from 'bun:test';
import { projectFocusedSupport } from '@ai-usage/report-core/focused-report-query';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { demoReportPayload } from '../../../../report-data';
import { type ReportQueryClient, reportBootstrapKey } from '../../../query/options/report';
import {
  loadReportPageData,
  ReportBootstrapUnavailableError,
  requireAvailableReportBootstrap,
} from './report-bootstrap';

const unavailableResult: ReportRevisionBootstrapResult = {
  error: { message: 'private engine detail', tag: 'RevisionUnavailable' },
  ok: false,
  requestFingerprint: 'report-manifest:v1:{}',
};

const successfulResult = (): Extract<ReportRevisionBootstrapResult, { readonly ok: true }> => {
  const { rows: _rows, tableRows: _tableRows, ...reportSupport } = demoReportPayload;
  return {
    bootstrap: projectFocusedSupport(
      reportSupport,
      { harness: ['claude-code'], machine: [{ label: 'Laptop', value: 'machine-a' }], truncated: false },
      { revision: 'compatible-last-revision' },
      { dateDomain: { first: '2026-07-01', last: '2026-08-01' } },
    ),
    manifest: {
      captureFingerprint: 'c'.repeat(64),
      expiresAt: 2,
      generatedAt: '2026-08-01T10:00:00.000Z',
      publishedAt: 1,
      revision: 'compatible-last-revision',
      rowsBytes: 1,
      supportBytes: 1,
    },
    ok: true,
    requestFingerprint: 'report-manifest:v1:{}',
  };
};

const reportClientFixture = (result: ReportRevisionBootstrapResult): ReportQueryClient => {
  const unavailable = () => Promise.reject(new Error('Unexpected report query'));
  return {
    getFocusedReportBreakdown: unavailable,
    getFocusedReportOverview: unavailable,
    getFocusedReportSupport: unavailable,
    getReportRevisionBootstrap: () => Promise.resolve(result),
    getReportRevisionManifest: unavailable,
  };
};

describe('report bootstrap', () => {
  it('turns typed unavailability into a bounded route error', () => {
    expect(() => requireAvailableReportBootstrap(unavailableResult)).toThrow(ReportBootstrapUnavailableError);
    expect(() => requireAvailableReportBootstrap(unavailableResult)).toThrow('Report data is temporarily unavailable.');
  });

  it.each(['demo', 'e2e'] as const)('selects the %s payload before report acquisition', async (mode) => {
    let fetchCount = 0;
    const data = await loadReportPageData({
      fetch: () => {
        fetchCount += 1;
        return Promise.reject(new Error('Synthetic report mode must not acquire RPC data'));
      },
      mode,
      url: new URL('http://synthetic.invalid/'),
    });

    expect(data.mode).toBe(mode);
    expect(fetchCount).toBe(0);
    expect(data.queryState.dehydratedState.queries).toHaveLength(0);
    expect(data.mode === 'live' ? undefined : data.payload.rows.length).toBeGreaterThan(0);
  });

  it('awaits a successful compatible publication and dehydrates the exact current alias key', async () => {
    let acquisitionCount = 0;
    const result = successfulResult();
    const data = await loadReportPageData(
      {
        fetch: () => Promise.reject(new Error('The injected report client owns this test acquisition')),
        mode: 'live',
        url: new URL('http://report.invalid/'),
      },
      {
        createClient: () => {
          acquisitionCount += 1;
          return reportClientFixture(result);
        },
      },
    );

    expect(acquisitionCount).toBe(1);
    expect(data.mode).toBe('live');
    expect(data.queryState.dehydratedState.queries).toHaveLength(1);
    const [query] = data.queryState.dehydratedState.queries;
    expect(query?.queryKey).toEqual(reportBootstrapKey());
    expect(query?.state.data).toEqual(result);
  });

  it('rejects typed live unavailability without dehydrating it as successful report data', async () => {
    await expect(
      loadReportPageData(
        {
          fetch: () => Promise.reject(new Error('The injected report client owns this test acquisition')),
          mode: 'live',
          url: new URL('http://report.invalid/'),
        },
        { createClient: () => reportClientFixture(unavailableResult) },
      ),
    ).rejects.toBeInstanceOf(ReportBootstrapUnavailableError);
  });
});
