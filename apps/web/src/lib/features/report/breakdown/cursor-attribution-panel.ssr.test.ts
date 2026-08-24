import { afterAll, describe, expect, test } from 'bun:test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { CursorCommitAttributionFacet } from '../../../../report-data';

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Cursor attribution panel module did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = new URL('../../../../../../../', import.meta.url).pathname;
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);
const [panelModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const panel = componentFrom(panelModule);
const { render } = rendererFrom(serverModule);

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);
const HASH_D = 'd'.repeat(40);
const HASH_E = 'e'.repeat(40);
const HASH_F = 'f'.repeat(40);
const HASH_G = 'g'.repeat(40);
const HASH_H = 'h'.repeat(40);
const REPORT_RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };
const FUTURE_RANGE = { from: '2027-01-01T00:00:00.000Z', to: null };
const COMMIT_ROW_PATTERN = /data-cursor-commit="/g;
const SCORED_COMMITS_TILE_VALUE_PATTERN = />4</;
const BRANCH_ROWS_TILE_VALUE_PATTERN = />6</;
const AI_SHARE_TILE_VALUE_PATTERN = />67%</;
const HUMAN_LINES_TILE_VALUE_PATTERN = />358</;

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

// A: three branch rows of one commit, identical metrics, three scoring times.
const branchRowsForA = ['main', 'release/y', 'feature/x'].map((branchName, index) =>
  cursorRow({
    branchName,
    commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
    commitHash: HASH_A,
    commitMessage: 'tanstack init',
    humanLinesAdded: 101,
    linesAdded: 671,
    linesDeleted: 1,
    scoredAt: `2026-07-1${String(4 + index)}T00:00:00.000Z`,
    v2AiPercentage: 76.12,
  }),
);
// B: in range, no scoring time recorded.
const rowB = cursorRow({
  commitDate: 'Wed Aug 5 09:00:00 2026 +0200',
  commitHash: HASH_B,
  commitMessage: 'ship it',
  humanLinesAdded: 40,
  linesAdded: 100,
  v2AiPercentage: 50,
});
// C: no commit date and no scoring time — kept under every range.
const rowC = cursorRow({
  commitHash: HASH_C,
  commitMessage: 'undated work',
  humanLinesAdded: 5,
  linesAdded: 20,
  v2AiPercentage: 10,
});
// D: committed outside the range but scored inside it, with metrics large enough that leaking it
// into any period-scoped projection changes that projection's rendered value.
const rowD = cursorRow({
  commitDate: 'Fri Mar 6 09:32:20 2026 +0100',
  commitHash: HASH_D,
  commitMessage: 'old work',
  humanLinesAdded: 900,
  linesAdded: 1000,
  scoredAt: '2026-07-20T00:00:00.000Z',
  v2AiPercentage: 99,
});
// E: no commit date, so the scoring time carries it into the range.
const rowE = cursorRow({
  commitHash: HASH_E,
  commitMessage: 'scored only',
  humanLinesAdded: 10,
  linesAdded: 80,
  scoredAt: '2026-07-20T00:00:00.000Z',
  v2AiPercentage: 25,
});
// F: no commit date on either branch row, so the group is scoring-dated AND carries two scoring
// times -- the case where a label that only says "no commit date" would hide every instant but one.
const scoredOnlyRow = (branchName: string, scoredAt: string): CursorCommitAttributionFacet =>
  cursorRow({
    branchName,
    commitHash: HASH_F,
    commitMessage: 'scored twice',
    linesAdded: 30,
    scoredAt,
    v2AiPercentage: 40,
  });
const branchRowsForF = [
  scoredOnlyRow('main', '2026-07-05T00:00:00.000Z'),
  scoredOnlyRow('topic/z', '2026-07-09T00:00:00.000Z'),
];
// G: mixed provenance -- one branch row carries a git commit date, the other only an earlier
// scoring time. The group must be dated and labelled from the commit date.
const branchRowsForG = [
  cursorRow({
    branchName: 'main',
    commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
    commitHash: HASH_G,
    commitMessage: 'mixed provenance',
    linesAdded: 30,
    scoredAt: '2026-07-14T00:00:00.000Z',
    v2AiPercentage: 40,
  }),
  cursorRow({
    branchName: 'topic/z',
    commitHash: HASH_G,
    commitMessage: 'mixed provenance',
    linesAdded: 30,
    scoredAt: '2026-07-01T00:00:00.000Z',
    v2AiPercentage: 40,
  }),
];
// H: the only row whose own fallback is inside the period belongs to a commit
// with an authoritative date outside it. Filtering rows before grouping would
// render this commit with the wrong scoring-derived date.
const branchRowsForH = [
  cursorRow({
    branchName: 'main',
    commitDate: '2026-03-06T08:32:20.000Z',
    commitHash: HASH_H,
    commitMessage: 'group before range',
    linesAdded: 30,
    scoredAt: '2026-03-07T00:00:00.000Z',
    v2AiPercentage: 40,
  }),
  cursorRow({
    branchName: 'topic/z',
    commitHash: HASH_H,
    commitMessage: 'group before range',
    linesAdded: 30,
    scoredAt: '2026-07-09T00:00:00.000Z',
    v2AiPercentage: 40,
  }),
];
const allRows = [...branchRowsForA, rowB, rowC, rowD, rowE];

const renderPanel = (
  rows: readonly CursorCommitAttributionFacet[],
  range: { from: string | null; to: string | null },
): string => render(panel, { props: { range, rows } }).body;

const occurrencesOf = (body: string, needle: string): number => body.split(needle).length - 1;

const rowTextFor = (body: string, hash: string): string => {
  const start = body.indexOf(`data-cursor-commit="${hash}"`);
  return body.slice(start, body.indexOf('</tr>', start));
};

/** Exactly the text of one row's scoring-time line -- not the whole row. */
const scoredAtTextFor = (body: string, hash: string): string => {
  const row = rowTextFor(body, hash);
  const marker = 'data-cursor-scored-at="">';
  const start = row.indexOf(marker) + marker.length;
  return row.slice(start, row.indexOf('</div>', start));
};

describe('Cursor AI attribution panel', () => {
  test('scopes the table to the report period and lists one row per commit', () => {
    const body = renderPanel(allRows, REPORT_RANGE);
    const positionOf = (hash: string): number => body.indexOf(`data-cursor-commit="${hash}"`);
    const rowFor = (hash: string): string => body.slice(positionOf(hash), body.indexOf('</tr>', positionOf(hash)));
    const dateCellFor = (hash: string): string => {
      const row = rowFor(hash);
      return row.slice(row.indexOf('data-cursor-date-source='));
    };

    expect(body.match(COMMIT_ROW_PATTERN)).toHaveLength(4);
    expect(body).not.toContain(HASH_D);
    expect(occurrencesOf(body, `data-cursor-commit="${HASH_A}"`)).toBe(1);
    expect(body).toContain('>feature/x, main, release/y<');
    expect(body).toContain('data-cursor-branch-count="3"');

    expect(positionOf(HASH_B)).toBeLessThan(positionOf(HASH_E));
    expect(positionOf(HASH_E)).toBeLessThan(positionOf(HASH_A));
    expect(positionOf(HASH_A)).toBeLessThan(positionOf(HASH_C));

    expect(dateCellFor(HASH_A)).toContain('data-cursor-date-source="commit"');
    expect(dateCellFor(HASH_B)).toContain('data-cursor-date-source="commit"');
    expect(dateCellFor(HASH_E)).toContain('data-cursor-date-source="scored"');
    expect(dateCellFor(HASH_E)).toContain('· scored');
    expect(dateCellFor(HASH_C)).toContain('data-cursor-date-source="none"');
    expect(dateCellFor(HASH_C)).toContain('>—<');
  });

  test('labels every column and states the date rule in visible text', () => {
    const body = renderPanel(allRows, REPORT_RANGE);

    for (const header of ['Commit', 'Branches', 'AI %', 'Composer', 'Tab', 'Human', 'Total +/-', 'Committed']) {
      expect(body).toContain(`>${header}</th>`);
    }
    expect(body.match(/scope="col"/g)).toHaveLength(8);
    // The date rule must be readable without hovering a native title tooltip.
    expect(body).toContain('id="cursor-attribution-table-description"');
    expect(body).toContain('aria-describedby="cursor-attribution-table-description"');
    expect(body).toContain('Committed is the git commit date, and it is the date the report period filters on.');
    expect(body).toContain(
      'falls back to its scoring time, marked · scored, only when no stored row carries a commit date',
    );
  });

  test('shows every scoring time as visible text rather than a hover-only tooltip', () => {
    const body = renderPanel([...allRows, ...branchRowsForF], REPORT_RANGE);
    // ' · ' separates the instants, so counting separators proves how many are rendered without
    // depending on the process time zone or on fmtDate's format.
    const instantsIn = (hash: string): number => occurrencesOf(scoredAtTextFor(body, hash), ' · ') + 1;

    expect(body.match(/data-cursor-scored-at/g)).toHaveLength(5);
    expect(scoredAtTextFor(body, HASH_A)).toStartWith('Scored ');
    expect(instantsIn(HASH_A)).toBe(3);
    expect(scoredAtTextFor(body, HASH_B)).toBe('No scoring time recorded');
    expect(scoredAtTextFor(body, HASH_C)).toBe('No scoring time recorded');
    expect(scoredAtTextFor(body, HASH_E)).toStartWith('No commit date recorded — Scored ');
    expect(instantsIn(HASH_E)).toBe(1);
    // A scoring-dated commit still lists every instant it was scored at.
    expect(scoredAtTextFor(body, HASH_F)).toStartWith('No commit date recorded — Scored ');
    expect(instantsIn(HASH_F)).toBe(2);
  });

  test('dates a mixed-provenance commit from its commit date and says so', () => {
    // One branch row has a git commit date, the other only an earlier scoring time. Dating the
    // group from the earlier scoring time would make the panel's own copy false.
    const body = renderPanel(branchRowsForG, REPORT_RANGE);

    expect(occurrencesOf(body, `data-cursor-commit="${HASH_G}"`)).toBe(1);
    expect(rowTextFor(body, HASH_G)).toContain('data-cursor-date-source="commit"');
    expect(rowTextFor(body, HASH_G)).not.toContain('· scored');
    expect(scoredAtTextFor(body, HASH_G)).toStartWith('Scored ');
    expect(scoredAtTextFor(body, HASH_G)).not.toContain('No commit date recorded');
    expect(occurrencesOf(scoredAtTextFor(body, HASH_G), ' · ')).toBe(1);
    expect(body).toContain('data-cursor-branch-count="2"');
  });

  test('does not let an in-period scoring fallback override its commit group date', () => {
    const body = renderPanel(branchRowsForH, REPORT_RANGE);

    expect(body).toContain('data-cursor-empty-state="period"');
    expect(body).not.toContain(`data-cursor-commit="${HASH_H}"`);
    expect(body).not.toContain('group before range');
  });

  test('states in the tiles what each number counts', () => {
    const body = renderPanel(allRows, REPORT_RANGE);

    expect(body).toContain('title="Unique commit hashes Cursor scored, in this period"');
    expect(body).toContain(
      'title="Cursor stores one row per branch a commit was seen on. The table folds those into one row per commit, and keeps a commit on separate rows only when its stored numbers disagree."',
    );
    expect(body).toContain('title="Lines Cursor classified as human-authored"');
    expect(body).toContain(
      `title="Component counters are vendor fields; zero may mean no attributed lines. AI % is Cursor's v2 score."`,
    );
    // The table description must not promise one row per commit -- a stored disagreement splits it.
    expect(body).toContain('stays on separate rows rather than being averaged');
  });

  test('scopes the AI share and human line tiles to the period, not the whole payload', () => {
    const body = renderPanel(allRows, REPORT_RANGE);
    const tileSlice = (from: string, to: string): string => body.slice(body.indexOf(from), body.indexOf(to));

    // In-period commits only: A 76.12% over 672 lines, B 50% over 100, C 10% over 20, E 25% over 80.
    // Leaking the out-of-range commit D (99% over 1,000 lines, 900 human lines) would render 84%,
    // "5/5 measured" and 1,258 human lines instead.
    expect(tileSlice('Scored commits', 'Branch rows')).toMatch(SCORED_COMMITS_TILE_VALUE_PATTERN);
    expect(tileSlice('Branch rows', 'AI line share')).toMatch(BRANCH_ROWS_TILE_VALUE_PATTERN);
    expect(body).toContain('AI line share · 4/4 measured');
    expect(tileSlice('AI line share', 'Human lines')).toMatch(AI_SHARE_TILE_VALUE_PATTERN);
    expect(tileSlice('Human lines', 'id="cursor-attribution-table-description"')).toMatch(
      HUMAN_LINES_TILE_VALUE_PATTERN,
    );
  });

  test('renders one row per stored disagreement when two machines score the same branch', () => {
    // The store keys dataset items by (source, machine, dataset, schema, item) while the Cursor item
    // key is only (commitHash, branchName), so the same commit on the same branch can arrive twice
    // with different numbers. Both rows must render, and their keys must differ or the keyed
    // {#each} throws in the browser.
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

    const body = renderPanel([fromOneMachine(76.12), fromOneMachine(12.5)], REPORT_RANGE);

    expect(occurrencesOf(body, `data-cursor-commit="${HASH_A}"`)).toBe(2);
    expect(body).toContain('>76%<');
    expect(body).toContain('>13%<');
    expect(occurrencesOf(body, 'data-cursor-branch-count="1"')).toBe(2);
  });

  test('separates "nothing in this period" from "nothing in the payload"', () => {
    const body = renderPanel([...branchRowsForA, rowB, rowD, rowE], FUTURE_RANGE);

    expect(body).toContain('data-cursor-empty-state="period"');
    expect(body).toContain('No Cursor commits in this period · 4 scored commits outside it');
    expect(body).not.toContain('No Cursor commit attribution data in this payload');
    expect(body).not.toContain('data-cursor-commit=');
  });

  test('never hides an undated commit behind a narrow period', () => {
    const body = renderPanel(allRows, FUTURE_RANGE);

    expect(body.match(COMMIT_ROW_PATTERN)).toHaveLength(1);
    expect(body).toContain(`data-cursor-commit="${HASH_C}"`);
    expect(body).toContain('data-cursor-date-source="none"');
  });

  test('keeps the payload empty state when no Cursor rows were collected', () => {
    const body = renderPanel([], REPORT_RANGE);

    expect(body).toContain('data-cursor-empty-state="payload"');
    expect(body).toContain('No Cursor commit attribution data in this payload');
  });
});
