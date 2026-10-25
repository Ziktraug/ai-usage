import { describe, expect, test } from 'bun:test';
import type { SourcedRow } from '@ai-usage/report-core/types';
import { approximateApiCost, normalizeUsageRow } from '@ai-usage/report-core/usage-row';
import { authorizeRows, buildProjectProjection } from './project-projection';

const sourcedRow = (sessionId: string, sourcePath: string): SourcedRow => ({
  ...normalizeUsageRow({
    calls: 1,
    cost: approximateApiCost,
    date: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-01T00:01:00.000Z'),
    harness: 'Claude Code',
    model: 'claude-sonnet-4-6',
    name: sessionId,
    project: sessionId,
    provider: 'Claude API',
    tokens: { cr: 0, cw: 0, in: 10, out: 5 },
  }),
  source: { harnessKey: 'claude', sourcePath, sourceSessionId: sessionId },
});

const legacyGroupMembers = (sourcePaths: readonly string[], pattern: string): string[] => {
  const projection = buildProjectProjection(
    authorizeRows(
      sourcePaths.map((sourcePath, index) => sourcedRow(`session-${index}`, sourcePath)),
      'local-observed',
    ),
    [],
    [{ match: [pattern], name: 'Legacy' }],
  );
  return projection.rows
    .filter((row) => row.projectGroupId === 'legacy-alias:Legacy')
    .map((row) => row.source.sourcePath ?? '')
    .sort();
};

describe('legacy project aliases', () => {
  test('match every character but the * wildcard literally', () => {
    // `?`, `.`, `(`, `+` and `[` are path characters, not regular-expression syntax.
    expect(legacyGroupMembers(['/work/proj?', '/work/pro', '/work/proj'], '/work/proj?')).toEqual(['/work/proj?']);
    expect(legacyGroupMembers(['/work/a.b', '/work/aXb'], '/work/a.b')).toEqual(['/work/a.b']);
    expect(legacyGroupMembers(['/work/c++ (v2) [x]', '/work/cc (v2) x'], '/work/c++ (v2) [x]')).toEqual([
      '/work/c++ (v2) [x]',
    ]);
    // `*` still spans any run of characters.
    expect(legacyGroupMembers(['/work/deep/tree/name', '/other/name'], '/work/*/name')).toEqual([
      '/work/deep/tree/name',
    ]);
  });
});
