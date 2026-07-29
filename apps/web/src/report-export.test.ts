import { describe, expect, test } from 'bun:test';
import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { ProjectGroup } from './dashboard-analytics';
import { analyticsBreakdownCsv, projectBreakdownCsv, reportCsvFilename } from './report-export';

const analyticsGroup = (overrides: Partial<AnalyticsGroup> = {}): AnalyticsGroup => ({
  ambiguous: 0,
  cache: 5,
  cacheHitPct: 33.333,
  costPer100Lines: null,
  costPercent: 100,
  costPerSession: 1.25,
  costSum: 1.25,
  fresh: 10,
  harness: 'Codex',
  inp: 10,
  key: 'group',
  lineCount: 0,
  linesA: 0,
  linesD: 0,
  medianCost: 1.25,
  priced: 2,
  provider: 'Codex API',
  sessions: 2,
  tools: 4,
  turns: 3,
  unpriced: 0,
  unpricedFreshTokens: 0,
  usageUnavailable: 0,
  ...overrides,
});

const projectGroup = (overrides: Partial<ProjectGroup> = {}): ProjectGroup => ({
  cache: 5,
  cost: 1.25,
  fresh: 10,
  key: 'project',
  label: 'Project',
  lineMeasurement: { measuredSessions: 2, totalSessions: 2 },
  linesAdded: 7,
  linesDeleted: 2,
  priced: 2,
  sessions: 2,
  tools: 4,
  turns: 3,
  ...overrides,
});

const analyticsHeader =
  'label,sessions,fresh_tokens,cache_read_tokens,cache_hit_percent,api_value_known,api_value_display,api_value_measurement,fully_priced_sessions,total_sessions,unpriced_fresh_tokens,turns,tools';
const projectHeader =
  'label,sessions,fresh_tokens,cache_read_tokens,api_value_known,api_value_display,api_value_measurement,fully_priced_sessions,total_sessions,lines_added,lines_deleted,line_measured_sessions,line_total_sessions,turns,tools';

describe('report CSV export', () => {
  test('projects analytics columns in locked order with raw numbers and every measurement state', () => {
    const csv = analyticsBreakdownCsv([
      { group: analyticsGroup(), label: '模型, "quoted"\nÉquipe' },
      {
        group: analyticsGroup({
          costSum: 0.5,
          priced: 1,
          sessions: 2,
          unpriced: 1,
          unpricedFreshTokens: 9,
        }),
        label: '=SUM(A1:A2)',
      },
      {
        group: analyticsGroup({
          costSum: 0,
          priced: 0,
          sessions: 1,
          unpriced: 1,
          usageUnavailable: 1,
        }),
        label: '+missing',
      },
    ]);

    expect(csv.startsWith(`${analyticsHeader}\r\n`)).toBe(true);
    expect(csv).toContain('"模型, ""quoted""\nÉquipe",2,10,5,33.333,1.25,$1.25,complete,2,2,0,3,4');
    expect(csv).toContain("'=SUM(A1:A2),2,10,5,33.333,0.5,≥ $0.50,partial,1,2,9,3,4");
    expect(csv).toContain("'+missing,1,10,5,33.333,0,—,unavailable,0,1,0,3,4");
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  test('neutralizes every spreadsheet formula prefix before RFC-4180 escaping', () => {
    const csv = analyticsBreakdownCsv(
      ['=formula', '+formula', '-formula', '@formula'].map((label) => ({
        group: analyticsGroup({ key: label }),
        label,
      })),
    );

    for (const label of ["'=formula", "'+formula", "'-formula", "'@formula"]) {
      expect(csv).toContain(`\r\n${label},`);
    }
  });

  test('neutralizes formulas hidden behind leading whitespace or control characters', () => {
    for (const label of ['\t=formula', '  +formula', '\r\n@formula']) {
      const csv = analyticsBreakdownCsv([{ group: analyticsGroup({ key: label }), label }]);

      expect(csv).toContain(`'${label}`);
    }
  });

  test('projects project coverage and complete, partial, and unavailable API value states', () => {
    const csv = projectBreakdownCsv([
      projectGroup({ label: 'Complet, "quoted"' }),
      projectGroup({
        cost: 0.75,
        label: '-Partial',
        lineMeasurement: { measuredSessions: 1, totalSessions: 2 },
        priced: 1,
      }),
      projectGroup({
        cost: 0,
        label: '@Unavailable',
        lineMeasurement: { measuredSessions: 0, totalSessions: 1 },
        priced: 0,
        sessions: 1,
      }),
    ]);

    expect(csv.startsWith(`${projectHeader}\r\n`)).toBe(true);
    expect(csv).toContain('"Complet, ""quoted""",2,10,5,1.25,$1.25,complete,2,2,7,2,2,2,3,4');
    expect(csv).toContain("'-Partial,2,10,5,0.75,≥ $0.75,partial,1,2,7,2,1,2,3,4");
    expect(csv).toContain("'@Unavailable,1,10,5,0,—,unavailable,0,1,7,2,0,1,3,4");
  });

  test('builds a stable generated-date filename for every supported dimension', () => {
    expect(reportCsvFilename('models', '2026-07-29T18:45:00.000Z')).toBe('ai-usage-models-2026-07-29.csv');
    expect(reportCsvFilename('harnesses', '2026-07-29T18:45:00.000Z')).toBe('ai-usage-harnesses-2026-07-29.csv');
    expect(reportCsvFilename('projects', '2026-07-29T18:45:00.000Z')).toBe('ai-usage-projects-2026-07-29.csv');
    expect(reportCsvFilename('providers', '2026-07-29T18:45:00.000Z')).toBe('ai-usage-providers-2026-07-29.csv');
  });
});
