import { describe, expect, test } from 'bun:test';
import { createBrowserRequestAbortAllowance } from './e2e/browser-request-abort-allowance';

const syncDataAbort = {
  errorText: 'net::ERR_ABORTED',
  pathname: '/sync/__data.json',
  resourceType: 'fetch',
} as const;

describe('browser request abort allowance', () => {
  test('consumes one exact intentional abort', () => {
    const allowance = createBrowserRequestAbortAllowance();
    allowance.allowOnce(syncDataAbort);

    expect(allowance.consume(syncDataAbort)).toBe(true);
    expect(allowance.consume(syncDataAbort)).toBe(false);
  });

  test('does not consume mismatched failures', () => {
    const allowance = createBrowserRequestAbortAllowance();
    allowance.allowOnce(syncDataAbort);

    expect(allowance.consume({ ...syncDataAbort, pathname: '/sources/__data.json' })).toBe(false);
    expect(allowance.consume({ ...syncDataAbort, resourceType: 'xhr' })).toBe(false);
    expect(allowance.consume({ ...syncDataAbort, errorText: 'net::ERR_FAILED' })).toBe(false);
    expect(allowance.consume(syncDataAbort)).toBe(true);
  });

  test('rejects duplicate active allowances and releases idempotently', () => {
    const allowance = createBrowserRequestAbortAllowance();
    const release = allowance.allowOnce(syncDataAbort);

    expect(() => allowance.allowOnce(syncDataAbort)).toThrow('already active');
    release();
    release();
    expect(allowance.consume(syncDataAbort)).toBe(false);
  });

  test('isolates registries between tests', () => {
    const first = createBrowserRequestAbortAllowance();
    const second = createBrowserRequestAbortAllowance();
    first.allowOnce(syncDataAbort);

    expect(second.consume(syncDataAbort)).toBe(false);
    expect(first.consume(syncDataAbort)).toBe(true);
  });
});
