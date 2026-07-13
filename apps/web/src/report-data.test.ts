import { describe, expect, test } from 'bun:test';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { cursorCommitAttributionFacet } from './report-data';

const cursorRow = (commitHash: string) => ({
  blankLinesAdded: 0,
  blankLinesDeleted: 0,
  branchName: 'main',
  commitDate: null,
  commitHash,
  commitMessage: null,
  composerLinesAdded: 0,
  composerLinesDeleted: 0,
  humanLinesAdded: 0,
  humanLinesDeleted: 0,
  linesAdded: 1,
  linesDeleted: 0,
  scoredAt: null,
  tabLinesAdded: 0,
  tabLinesDeleted: 0,
  v1AiPercentage: null,
  v2AiPercentage: null,
});

const minimalPayload = (overrides: Partial<UsageReportPayload>): UsageReportPayload => ({
  analytics: {} as UsageReportPayload['analytics'],
  filters: { since: null, project: null, limit: null, minTokens: 1, sort: 'date' },
  generatedAt: '2026-01-01T00:00:00.000Z',
  omittedRows: 0,
  rows: [],
  tableRows: [],
  ...overrides,
});

describe('report payload bootstrap', () => {
  test('prefers cursor attribution from datasets and falls back to legacy facets', () => {
    const payload = minimalPayload({
      datasets: {
        cursorCommitAttribution: [cursorRow('dataset')],
      },
      facets: { cursor: { commitAttribution: [cursorRow('facet')] } },
    });

    expect(cursorCommitAttributionFacet(payload).map((row) => row.commitHash)).toEqual(['dataset']);
    const legacyPayload = minimalPayload({ facets: payload.facets ?? {} });
    expect(cursorCommitAttributionFacet(legacyPayload).map((row) => row.commitHash)).toEqual(['facet']);
  });
});
