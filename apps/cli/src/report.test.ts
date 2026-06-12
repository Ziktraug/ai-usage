import { describe, expect, test } from 'bun:test';
import type { Row } from '@ai-usage/core/types';
import type { Args } from './cli';
import { prepareUsageReport, renderUsageReport } from './report';

const args = (overrides: Partial<Args> = {}): Args => ({
  since: null,
  harness: null,
  project: null,
  limit: null,
  minTokens: 1,
  format: 'table',
  cursor: true,
  color: false,
  wide: false,
  sort: 'date',
  ...overrides,
});

const row = (name: string, overrides: Partial<Row> = {}): Row => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name,
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 10,
  tokOut: 5,
  tokCr: 0,
  tokCw: 0,
  costActual: 0.1,
  costApprox: 0.1,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  ...overrides,
});

describe('Usage row report lifecycle', () => {
  test('filters by active date/project/min tokens and sorts through one seam', () => {
    const report = prepareUsageReport(
      [
        row('old', { endDate: new Date('2025-12-31T00:00:00.000Z') }),
        row('tiny', { tokIn: 0, tokOut: 0 }),
        row('other project', { project: 'other', endDate: new Date('2026-01-02T00:00:00.000Z') }),
        row('kept lower cost', { endDate: new Date('2026-01-02T00:00:00.000Z'), costApprox: 1 }),
        row('kept higher cost', { endDate: new Date('2026-01-03T00:00:00.000Z'), costApprox: 5 }),
      ],
      args({
        since: new Date('2026-01-01T12:00:00.000Z'),
        project: 'ai',
        minTokens: 1,
        sort: 'cost',
      }),
    );

    expect(report.rows.map((item) => item.name)).toEqual(['kept higher cost', 'kept lower cost']);
  });

  test('payload format emits the full report payload as JSON for the dev server', () => {
    const output = renderUsageReport([row('a'), row('b')], args({ format: 'payload', limit: 1 }));
    const payload = JSON.parse(output);

    expect(payload.rows).toHaveLength(2);
    expect(payload.tableRows).toHaveLength(1);
    expect(payload.filters.limit).toBe(1);
    expect(typeof payload.generatedAt).toBe('string');
    expect(payload.analytics.sessionCount).toBe(2);
  });

  test('limit affects table rows while analytics rows remain complete', () => {
    const report = prepareUsageReport([row('a'), row('b')], args({ limit: 1 }));

    expect(report.tableRows).toHaveLength(1);
    expect(report.rows).toHaveLength(2);
    expect(report.omittedRows).toBe(1);
    expect(renderUsageReport([row('a'), row('b')], args({ limit: 1 }))).toContain('analytics below cover all 2');
  });
});
