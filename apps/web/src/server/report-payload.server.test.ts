import { describe, expect, test } from 'bun:test';
import { parseRunnerPayload } from './report-payload.server';

describe('parseRunnerPayload', () => {
  test('ignores runtime warning lines before the JSON payload', () => {
    const payload = parseRunnerPayload('timestamp=2026-06-22T11:30:48.703Z level=WARN message=noise\n{"rows":[]}');

    expect(payload.rows).toEqual([]);
  });
});
