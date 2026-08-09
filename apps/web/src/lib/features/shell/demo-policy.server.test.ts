import { describe, expect, test } from 'bun:test';
import { demoRouteDecision } from './demo-policy.server';

describe('Svelte shell demo route policy', () => {
  test('redirects management pages before they can acquire live services', () => {
    expect(demoRouteDecision('/skills/projects/project-a', 'demo')).toBe('redirect-report');
    expect(demoRouteDecision('/sources', 'demo')).toBe('redirect-report');
    expect(demoRouteDecision('/sync', 'demo')).toBe('redirect-report');
  });

  test('returns an empty not-found decision for protected transports', () => {
    expect(demoRouteDecision('/rpc', 'demo')).toBe('not-found');
    expect(demoRouteDecision('/rpc/report/current', 'demo')).toBe('not-found');
    expect(demoRouteDecision('/api/manual-merge/upload', 'demo')).toBe('not-found');
    expect(demoRouteDecision('/api/source-control', 'demo')).toBe('not-found');
  });

  test('leaves the synthetic report and every live-mode route available', () => {
    expect(demoRouteDecision('/', 'demo')).toBe('allow');
    expect(demoRouteDecision('/skills', 'live')).toBe('allow');
  });
});
