import { describe, expect, test } from 'bun:test';
import { assembleReport, captureReport, reportAssemblyInputFingerprint } from './report-assembly';

describe('pure report assembly', () => {
  test('is deterministic for an explicit clock and already-read inputs', () => {
    const input = {
      configuredProjectGroups: [],
      generatedAt: new Date('2026-07-14T10:00:00.000Z'),
      options: { limit: null, minTokens: 1, project: null, since: null, sort: 'date' as const },
      projectGroups: [],
      rows: [],
      warnings: [{ message: 'stable warning', operation: 'test' }],
    };

    const first = assembleReport(input);
    const second = assembleReport(structuredClone(input));

    expect(second).toEqual(first);
    expect(first.payload.generatedAt).toBe('2026-07-14T10:00:00.000Z');
    expect(first.payload.warnings).toEqual(input.warnings);
  });

  test('skips assembly for identical semantic input while detecting visible changes', () => {
    const input = {
      configuredProjectGroups: [],
      datasets: { fixture: { value: 1 } },
      generatedAt: new Date('2026-07-14T10:00:00.000Z'),
      options: { limit: null, minTokens: 1, project: null, since: null, sort: 'date' as const },
      projectGroups: [],
      rows: [],
      warnings: [{ message: 'stable warning', operation: 'test' }],
    };
    const fingerprint = reportAssemblyInputFingerprint(input);
    const unchanged = captureReport({ ...input, generatedAt: new Date('2026-07-14T10:01:00.000Z') }, fingerprint);
    const changed = captureReport(
      { ...input, warnings: [{ message: 'changed warning', operation: 'test' }] },
      fingerprint,
    );

    expect(unchanged).toEqual({ captureFingerprint: fingerprint, status: 'unchanged' });
    expect(changed.status).toBe('changed');
    expect(changed.captureFingerprint).not.toBe(fingerprint);
  });
});
