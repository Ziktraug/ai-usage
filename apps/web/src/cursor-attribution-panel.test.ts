import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { summarizeCursorAiPercentage } from './cursor-attribution-panel';
import type { CursorCommitAttributionFacet } from './report-data';

interface CursorAttributionPanelProps {
  rows: CursorCommitAttributionFacet[];
}

const isCursorAttributionPanelModule = (
  value: unknown,
): value is { CursorAttributionPanel: Component<CursorAttributionPanelProps> } =>
  typeof value === 'object' &&
  value !== null &&
  'CursorAttributionPanel' in value &&
  typeof value.CursorAttributionPanel === 'function';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loadedModule: unknown = await viteServer.ssrLoadModule('/src/cursor-attribution-panel.tsx');
if (!isCursorAttributionPanelModule(loadedModule)) {
  throw new Error('Vite did not load the Cursor attribution panel');
}
const CursorAttributionPanel = loadedModule.CursorAttributionPanel;
afterAll(async () => {
  await viteServer.close();
});

const cursorRow = (
  commitHash: string,
  v2AiPercentage: number | null,
  linesAdded: number,
  linesDeleted = 0,
): CursorCommitAttributionFacet => ({
  blankLinesAdded: 0,
  blankLinesDeleted: 0,
  branchName: 'main',
  commitDate: 'Mon Jul 13 10:00:00 2026 +0200',
  commitHash,
  commitMessage: 'Synthetic commit',
  composerLinesAdded: 0,
  composerLinesDeleted: 0,
  humanLinesAdded: 0,
  humanLinesDeleted: 0,
  linesAdded,
  linesDeleted,
  scoredAt: '2026-07-13T08:00:00.000Z',
  tabLinesAdded: 0,
  tabLinesDeleted: 0,
  v1AiPercentage: null,
  v2AiPercentage,
});

describe('Cursor AI percentage summary', () => {
  test('weights distinct commits without counting identical branch duplicates twice', () => {
    const summary = summarizeCursorAiPercentage([
      cursorRow('commit-a', 25, 75, 25),
      { ...cursorRow('commit-a', 25, 75, 25), branchName: 'release' },
      cursorRow('commit-b', 75, 250, 50),
    ]);

    expect(summary).toEqual({ measuredCommits: 2, percentage: 62.5, totalCommits: 2 });
  });

  test('excludes conflicting, null-only, and zero-weight commits while reporting partial coverage', () => {
    const summary = summarizeCursorAiPercentage([
      cursorRow('conflict', 20, 100),
      { ...cursorRow('conflict', 30, 100), branchName: 'release' },
      cursorRow('null-only', null, 100),
      cursorRow('zero-weight', 80, 0),
      cursorRow('measured', 40, 150, 50),
    ]);

    expect(summary).toEqual({ measuredCommits: 1, percentage: 40, totalCommits: 4 });
  });

  test('returns an absent percentage when no distinct commit is measurable', () => {
    const summary = summarizeCursorAiPercentage([cursorRow('null-only', null, 100), cursorRow('zero-weight', 80, 0)]);

    expect(summary).toEqual({ measuredCommits: 0, percentage: null, totalCommits: 2 });
  });
});

describe('CursorAttributionPanel', () => {
  test('renders the line-weighted v2 score, distinct-commit coverage, and vendor-field hint', () => {
    const html = renderToString(() =>
      createComponent(CursorAttributionPanel, {
        rows: [cursorRow('commit-a', 25, 75, 25), cursorRow('commit-b', 75, 250, 50)],
      }),
    );

    expect(html).toContain('AI line share · 2/2 measured');
    expect(html).toContain('63%');
    expect(html).toContain(
      "Component counters are vendor fields; zero may mean no attributed lines. AI % is Cursor's v2 score.",
    );
  });

  test('renders an em dash and zero measured coverage when no commit has an authoritative score', () => {
    const html = renderToString(() =>
      createComponent(CursorAttributionPanel, {
        rows: [cursorRow('null-only', null, 100), cursorRow('zero-weight', 80, 0)],
      }),
    );

    expect(html).toContain('AI line share · 0/2 measured');
    expect(html).toContain('data-metric-value>—</div>');
  });
});
