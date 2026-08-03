import { describe, expect, it } from 'bun:test';
import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import { reportBootstrapKey } from '../../../query/options/report';
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

  it('awaits one live bootstrap and dehydrates the exact current alias key', async () => {
    let fetchCount = 0;
    const response = new Response(JSON.stringify({ json: { error: null, result: unavailableResult } }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });

    await expect(
      loadReportPageData({
        fetch: () => {
          fetchCount += 1;
          return Promise.resolve(response.clone());
        },
        mode: 'live',
        url: new URL('http://report.invalid/'),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(fetchCount).toBe(1);
    expect(reportBootstrapKey()).toEqual(['web', 'current-alias', 'report-bootstrap']);
  });
});
