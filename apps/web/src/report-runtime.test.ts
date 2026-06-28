import { describe, expect, test } from 'bun:test';
import { mountReportRefreshAction } from './report-runtime';

describe('report runtime refresh decisions', () => {
  test('refreshes immediately when the app can fetch a fresh payload even with an initial payload', () => {
    expect(
      mountReportRefreshAction({
        canRefresh: true,
        hasInitialPayload: true,
        isDemoPayload: false,
        isDevRuntime: true,
      }),
    ).toBe('fetch-payload');
  });

  test('keeps the static export path inert and preserves the demo dev fallback', () => {
    expect(
      mountReportRefreshAction({
        canRefresh: false,
        hasInitialPayload: true,
        isDemoPayload: false,
        isDevRuntime: true,
      }),
    ).toBe('none');

    expect(
      mountReportRefreshAction({
        canRefresh: false,
        hasInitialPayload: false,
        isDemoPayload: true,
        isDevRuntime: true,
      }),
    ).toBe('dev-fallback');
  });
});
