import { describe, expect, test } from 'bun:test';
import { sourceControlBounds } from '@ai-usage/report-core/source-control';
import { sanitizeSourceWarnings } from './source-warnings';

describe('source warning publication boundary', () => {
  test('publishes validated singular and plural counts without local diagnostic text', () => {
    const privateWarning = {
      message: 'Rejected value token=secret from /home/operator/history.db',
      operation: 'metric validation\n',
      path: '/home/operator/history.db',
      rejectedRecords: 1,
      sql: 'SELECT private_value FROM history',
    };
    const warnings = sanitizeSourceWarnings('Codex sessions', [
      privateWarning,
      { operation: 'metricValidation', rejectedRecords: 2 },
    ]);

    expect(warnings).toEqual([
      {
        code: 'metric-validation-',
        message: 'Codex sessions rejected 1 local record as incomplete or malformed.',
      },
      {
        code: 'metricValidation',
        message: 'Codex sessions rejected 2 local records as incomplete or malformed.',
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain('/home/operator');
    expect(JSON.stringify(warnings)).not.toContain('token=secret');
    expect(JSON.stringify(warnings)).not.toContain('SELECT');
  });

  test('uses the generic fallback for absent or untrusted rejected-record counts', () => {
    const warnings = sanitizeSourceWarnings('RTK savings', [
      { operation: '', rejectedRecords: 0 },
      { operation: 'metricValidation', rejectedRecords: 1_000_001 },
      { operation: 'metricValidation', rejectedRecords: Number.POSITIVE_INFINITY },
      { operation: 'metricValidation' },
    ]);

    expect(warnings[0]?.code).toBe('collector-warning');
    expect(warnings.map((warning) => warning.message)).toEqual(
      Array.from({ length: 4 }, () => 'RTK savings completed with an incomplete or rejected local record.'),
    );
  });

  test('caps warning count and code length at the source-control boundary', () => {
    const warnings = sanitizeSourceWarnings(
      'Cursor sessions',
      Array.from({ length: sourceControlBounds.maxWarningsPerSource + 2 }, () => ({
        operation: 'x'.repeat(80),
      })),
    );

    expect(warnings).toHaveLength(sourceControlBounds.maxWarningsPerSource);
    expect(warnings[0]?.code).toBe('x'.repeat(64));
  });
});
