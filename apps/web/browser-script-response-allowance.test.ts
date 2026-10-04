import { describe, expect, test } from 'bun:test';
import { createBrowserScriptResponseAllowance } from './e2e/browser-script-response-allowance';

const url = 'http://127.0.0.1:4178/_app/immutable/chunks/drawer.js';
const identity = { url, status: 503 };
const response = { ...identity, resourceType: 'script' };
const message = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';

describe('controlled script response failures', () => {
  test('requires an explicit allowance and consumes the response and diagnostic only once', () => {
    const allowance = createBrowserScriptResponseAllowance();
    expect(allowance.consumeResponse(response)).toBe(false);
    expect(allowance.consumeConsole({ url, message })).toBe(false);
    const verify = allowance.allowOnce(identity);
    expect(allowance.consumeResponse(response)).toBe(true);
    expect(allowance.consumeResponse(response)).toBe(false);
    expect(allowance.consumeConsole({ url, message })).toBe(true);
    expect(allowance.consumeConsole({ url, message })).toBe(false);
    expect(verify).not.toThrow();
  });

  test('does not mask different URLs, statuses, resource types or console errors', () => {
    const allowance = createBrowserScriptResponseAllowance();
    const verify = allowance.allowOnce(identity);
    expect(allowance.consumeResponse({ ...response, url: url.replace('4178', '4179') })).toBe(false);
    expect(allowance.consumeResponse({ ...response, status: 500 })).toBe(false);
    expect(allowance.consumeResponse({ ...response, resourceType: 'fetch' })).toBe(false);
    expect(allowance.consumeResponse(response)).toBe(true);
    expect(allowance.consumeConsole({ url: `${url}?another`, message })).toBe(false);
    expect(allowance.consumeConsole({ url, message: message.replace('503', '500') })).toBe(false);
    expect(allowance.consumeConsole({ url, message: 'Uncaught TypeError: module failed' })).toBe(false);
    expect(allowance.consumeConsole({ url, message })).toBe(true);
    expect(verify).not.toThrow();
  });

  test('reports missing and duplicate expected failures', () => {
    const allowance = createBrowserScriptResponseAllowance();
    const verify = allowance.allowOnce(identity);
    expect(() => allowance.allowOnce(identity)).toThrow('already active');
    expect(verify).toThrow('was not observed');
  });
});
