import { describe, expect, test } from 'bun:test';
import { reportRefreshPayload } from './report-runtime';

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
  test('exposes refresh payload fetching for served client runtimes', () => {
    withWindow({} as Window, () => {
      expect(reportRefreshPayload()).toBeFunction();
    });
  });
});
