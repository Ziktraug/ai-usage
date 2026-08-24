import { describe, expect, test } from 'bun:test';
import type { CursorCommitAttributionFacet } from '../../../../report-data';
import { cursorCommitActivity, cursorRowsInRange, groupCursorCommits, summarizeCursorAiPercentage } from './cursor';

// Literal epoch milliseconds so the expectation is an independent oracle rather than a second
// call to the same Date.parse the implementation uses.
const JULY_13_2026_0800_UTC = 1_783_929_600_000;
const JULY_20_2026_0000_UTC = 1_784_505_600_000;

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

const cursorRow = (overrides: Partial<CursorCommitAttributionFacet> = {}): CursorCommitAttributionFacet => ({
  blankLinesAdded: 0,
  blankLinesDeleted: 0,
  branchName: 'main',
  commitDate: null,
  commitHash: HASH_A,
  commitMessage: null,
  composerLinesAdded: 0,
  composerLinesDeleted: 0,
  humanLinesAdded: 0,
  humanLinesDeleted: 0,
  linesAdded: 0,
  linesDeleted: 0,
  scoredAt: null,
  tabLinesAdded: 0,
  tabLinesDeleted: 0,
  v1AiPercentage: null,
  v2AiPercentage: null,
  ...overrides,
});

const scoredRow = (percentage: number | null, lines: number): CursorCommitAttributionFacet =>
  cursorRow({
    commitHash: `${String(percentage)}-${String(lines)}`,
    linesAdded: lines,
    v2AiPercentage: percentage,
  });

describe('P8 Cursor AI attribution', () => {
  test('weights measured commit percentages by changed lines', () => {
    expect(summarizeCursorAiPercentage([scoredRow(100, 10), scoredRow(0, 30), scoredRow(null, 100)])).toEqual({
      measuredCommits: 2,
      percentage: 25,
      totalCommits: 3,
    });
  });

  test('keeps unavailable attribution distinct from zero', () => {
    expect(summarizeCursorAiPercentage([scoredRow(null, 20)])).toEqual({
      measuredCommits: 0,
      percentage: null,
      totalCommits: 1,
    });
  });
});

describe('Cursor commit activity date rule', () => {
  test('prefers the git commit date over the Cursor scoring time', () => {
    expect(
      cursorCommitActivity({ commitDate: 'Mon Jul 13 10:00:00 2026 +0200', scoredAt: '2026-07-20T00:00:00.000Z' }),
    ).toEqual({ source: 'commit', time: JULY_13_2026_0800_UTC });
  });

  test('falls back to the scoring time when the commit date is missing', () => {
    expect(cursorCommitActivity({ commitDate: null, scoredAt: '2026-07-20T00:00:00.000Z' })).toEqual({
      source: 'scored',
      time: JULY_20_2026_0000_UTC,
    });
  });

  test('falls back to the scoring time when the commit date does not parse', () => {
    expect(cursorCommitActivity({ commitDate: 'not a date', scoredAt: '2026-07-20T00:00:00.000Z' })).toEqual({
      source: 'scored',
      time: JULY_20_2026_0000_UTC,
    });
  });

  test('reports no date when neither field carries one', () => {
    expect(cursorCommitActivity({ commitDate: null, scoredAt: null })).toEqual({ source: 'none', time: null });
    expect(cursorCommitActivity({ commitDate: '', scoredAt: 'never' })).toEqual({ source: 'none', time: null });
  });
});

describe('Cursor commit range filter', () => {
  const inside = cursorRow({ commitDate: 'Mon Jul 13 10:00:00 2026 +0200', commitHash: HASH_A });
  const boundary = cursorRow({ commitDate: '2026-08-31T23:59:59.999Z', commitHash: HASH_B });
  const undated = cursorRow({ commitHash: HASH_C });

  test('keeps every row when both bounds are open', () => {
    expect(cursorRowsInRange([inside, boundary, undated], { from: null, to: null })).toEqual([
      inside,
      boundary,
      undated,
    ]);
  });

  test('includes a row that lands exactly on the upper bound', () => {
    expect(cursorRowsInRange([boundary], { from: '2026-07-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' })).toEqual(
      [boundary],
    );
  });

  test('filters by the commit date, not the scoring time', () => {
    const scoredInsideCommittedOutside = cursorRow({
      commitDate: 'Fri Mar 6 09:32:20 2026 +0100',
      scoredAt: '2026-07-20T00:00:00.000Z',
    });
    const scoredOutsideCommittedInside = cursorRow({
      commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
      scoredAt: '2026-12-01T00:00:00.000Z',
    });
    const range = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };
    expect(cursorRowsInRange([scoredInsideCommittedOutside], range)).toEqual([]);
    expect(cursorRowsInRange([scoredOutsideCommittedInside], range)).toEqual([scoredOutsideCommittedInside]);
  });

  test('keeps undated rows under a narrow range', () => {
    expect(
      cursorRowsInRange([inside, undated], { from: '2027-01-01T00:00:00.000Z', to: '2027-01-02T00:00:00.000Z' }),
    ).toEqual([undated]);
  });

  test('resolves a complete commit group before applying the period', () => {
    const august = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };
    const committedInJuly = cursorRow({
      branchName: 'main',
      commitDate: '2026-07-13T08:00:00.000Z',
      commitHash: HASH_A,
      scoredAt: '2026-08-02T00:00:00.000Z',
    });
    const augustScoringFallback = cursorRow({
      branchName: 'topic/z',
      commitDate: null,
      commitHash: HASH_A,
      scoredAt: '2026-08-05T00:00:00.000Z',
    });
    const committedInAugust = cursorRow({
      branchName: 'main',
      commitDate: '2026-08-13T08:00:00.000Z',
      commitHash: HASH_B,
      scoredAt: '2026-08-14T00:00:00.000Z',
    });
    const decemberScoringFallback = cursorRow({
      branchName: 'topic/z',
      commitDate: null,
      commitHash: HASH_B,
      scoredAt: '2026-12-05T00:00:00.000Z',
    });

    expect(cursorRowsInRange([committedInJuly, augustScoringFallback], august)).toEqual([]);
    expect(cursorRowsInRange([committedInAugust, decemberScoringFallback], august)).toEqual([
      committedInAugust,
      decemberScoringFallback,
    ]);
  });
});

describe('Cursor commit grouping', () => {
  const branchRow = (branchName: string, scoredAt: string): CursorCommitAttributionFacet =>
    cursorRow({
      branchName,
      commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
      commitHash: HASH_A,
      commitMessage: 'tanstack init',
      linesAdded: 671,
      linesDeleted: 1,
      scoredAt,
      v2AiPercentage: 76.12,
    });

  test('merges the branch rows of one commit into a single row', () => {
    const groups = groupCursorCommits([
      branchRow('main', '2026-07-14T00:00:00.000Z'),
      branchRow('release/y', '2026-07-16T00:00:00.000Z'),
      branchRow('feature/x', '2026-07-15T00:00:00.000Z'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.branches).toEqual(['feature/x', 'main', 'release/y']);
    expect(groups[0]?.rowCount).toBe(3);
    expect(groups[0]?.commitMessage).toBe('tanstack init');
    expect(groups[0]?.dateSource).toBe('commit');
    expect(groups[0]?.date).toBe('2026-07-13T08:00:00.000Z');
    expect(groups[0]?.scoredAt).toEqual([
      '2026-07-14T00:00:00.000Z',
      '2026-07-15T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
    ]);
    expect(groups[0]?.key).toStartWith(`${HASH_A}:feature/x,main,release/y:`);
    expect(groups[0]?.metrics.v2AiPercentage).toBe(76.12);
  });

  test('never merges branch rows whose metrics disagree', () => {
    const groups = groupCursorCommits([
      branchRow('main', '2026-07-14T00:00:00.000Z'),
      cursorRow({
        branchName: 'release/y',
        commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
        commitHash: HASH_A,
        commitMessage: 'tanstack init',
        linesAdded: 671,
        linesDeleted: 1,
        scoredAt: '2026-07-16T00:00:00.000Z',
        v2AiPercentage: 12.5,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.branches)).toEqual([['main'], ['release/y']]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
    expect(groups.map((group) => group.metrics.v2AiPercentage)).toEqual([76.12, 12.5]);
  });

  test('keeps same-branch rows apart when two machines disagree on the numbers', () => {
    // The store's primary key includes machine_id while the collector's item key is only
    // (commitHash, branchName), so one commit on one branch can be stored twice with different
    // numbers. Merging them would average away a real disagreement; sharing a render key would
    // make the panel's keyed {#each} throw.
    const fromOneMachine = (v2AiPercentage: number): CursorCommitAttributionFacet =>
      cursorRow({
        branchName: 'main',
        commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
        commitHash: HASH_A,
        commitMessage: 'same commit, two machines',
        linesAdded: 10,
        scoredAt: '2026-07-14T00:00:00.000Z',
        v2AiPercentage,
      });

    const groups = groupCursorCommits([fromOneMachine(76.12), fromOneMachine(12.5)]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.branches)).toEqual([['main'], ['main']]);
    expect(groups.map((group) => group.metrics.v2AiPercentage)).toEqual([12.5, 76.12]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });

  test("prefers a real commit date over another row's scoring fallback", () => {
    // Mixed provenance: one branch row carries a git commit date, the other only a (much earlier)
    // scoring time. Taking the earliest activity regardless of source would label the group
    // "scored" and date it July 1, which contradicts what the panel tells the reader.
    const groups = groupCursorCommits([
      cursorRow({
        branchName: 'main',
        commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
        commitHash: HASH_A,
        scoredAt: '2026-07-14T00:00:00.000Z',
      }),
      cursorRow({
        branchName: 'topic/z',
        commitDate: null,
        commitHash: HASH_A,
        scoredAt: '2026-07-01T00:00:00.000Z',
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.branches).toEqual(['main', 'topic/z']);
    expect(groups[0]?.dateSource).toBe('commit');
    expect(groups[0]?.date).toBe('2026-07-13T08:00:00.000Z');
    // Both scoring times survive even though neither dates the group.
    expect(groups[0]?.scoredAt).toEqual(['2026-07-01T00:00:00.000Z', '2026-07-14T00:00:00.000Z']);
  });

  test('takes the earliest commit date when several rows carry one', () => {
    const groups = groupCursorCommits([
      cursorRow({ branchName: 'main', commitDate: 'Mon Jul 13 10:00:00 2026 +0200', commitHash: HASH_A }),
      cursorRow({ branchName: 'topic/z', commitDate: 'Wed Aug 5 09:00:00 2026 +0200', commitHash: HASH_A }),
    ]);

    expect(groups[0]?.dateSource).toBe('commit');
    expect(groups[0]?.date).toBe('2026-07-13T08:00:00.000Z');
  });

  test('resolves a commit message the same way regardless of stored row order', () => {
    // Stored rows arrive in SHA-256 item-key order, so a "first non-null wins" rule would render a
    // different message on different reads. A row that stored no message never displaces one that did.
    const withMessage = (branchName: string, commitMessage: string | null): CursorCommitAttributionFacet =>
      cursorRow({ branchName, commitDate: 'Mon Jul 13 10:00:00 2026 +0200', commitHash: HASH_A, commitMessage });
    const forward = groupCursorCommits([withMessage('main', null), withMessage('topic/z', 'tanstack init')]);
    const reversed = groupCursorCommits([withMessage('topic/z', 'tanstack init'), withMessage('main', null)]);

    expect(forward[0]?.commitMessage).toBe('tanstack init');
    expect(reversed[0]?.commitMessage).toBe('tanstack init');
  });

  test('orders by commit date descending with undated commits last', () => {
    const groups = groupCursorCommits([
      cursorRow({ commitHash: HASH_C }),
      cursorRow({ commitDate: 'Mon Jul 13 10:00:00 2026 +0200', commitHash: HASH_B }),
      cursorRow({ commitDate: 'Wed Aug 5 09:00:00 2026 +0200', commitHash: HASH_A }),
    ]);

    expect(groups.map((group) => group.commitHash)).toEqual([HASH_A, HASH_B, HASH_C]);
  });

  test('breaks a date tie by commit hash ascending', () => {
    const groups = groupCursorCommits([
      cursorRow({ commitDate: 'Mon Jul 13 10:00:00 2026 +0200', commitHash: HASH_B }),
      cursorRow({ commitDate: 'Mon Jul 13 10:00:00 2026 +0200', commitHash: HASH_A }),
    ]);

    expect(groups.map((group) => group.commitHash)).toEqual([HASH_A, HASH_B]);
  });
});
