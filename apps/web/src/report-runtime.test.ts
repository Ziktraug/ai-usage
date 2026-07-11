import { describe, expect, test } from 'bun:test';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { mountReportRefreshAction, reportRefreshPayload } from './report-runtime';

const withWindow = (windowValue: Window, run: () => void) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: windowValue,
  });

  try {
    run();
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

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

  test('exposes refresh payload fetching for served client runtimes', () => {
    withWindow({} as Window, () => {
      expect(reportRefreshPayload()).toBeFunction();
    });
  });

  test('keeps self-contained HTML exports inert', () => {
    withWindow({ __AI_USAGE_REPORT__: {} as UsageReportPayload, __AI_USAGE_REPORT_STATIC__: true } as Window, () => {
      expect(reportRefreshPayload()).toBeUndefined();
    });
  });
});
