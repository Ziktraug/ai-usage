import { describe, expect, test } from 'bun:test';
import { reportMutationsEnabled } from './report-mutation-availability';

describe('report mutation availability', () => {
  test('requires both live runtime and live shared source-control state', () => {
    expect(reportMutationsEnabled('live', 'connecting')).toBe(false);
    expect(reportMutationsEnabled('live', 'disconnected')).toBe(false);
    expect(reportMutationsEnabled('live', 'protocol-mismatch')).toBe(false);
    expect(reportMutationsEnabled('live', 'live')).toBe(true);
    expect(reportMutationsEnabled('demo', 'live')).toBe(false);
    expect(reportMutationsEnabled('e2e', 'live')).toBe(false);
  });
});
