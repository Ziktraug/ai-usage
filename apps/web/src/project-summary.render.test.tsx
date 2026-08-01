import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { ProjectGroup } from './dashboard-analytics';

interface ProjectSummaryProps {
  groups: ProjectGroup[];
  onManageProjectGroups: () => void;
  onProjectFilter: (value: string) => void;
}

const isProjectSummaryModule = (value: unknown): value is { ProjectSummary: Component<ProjectSummaryProps> } =>
  typeof value === 'object' &&
  value !== null &&
  'ProjectSummary' in value &&
  typeof value.ProjectSummary === 'function';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  plugins: [solidPlugin({ ssr: true })],
  root: import.meta.dir.replace(/\/src$/, ''),
  server: { hmr: false, middlewareMode: true, ws: false },
});
const loadedModule: unknown = await viteServer.ssrLoadModule('/src/project-summary.tsx');
if (!isProjectSummaryModule(loadedModule)) {
  throw new Error('Vite did not load the Project summary');
}
const ProjectSummary = loadedModule.ProjectSummary;
afterAll(async () => {
  await viteServer.close();
});

const projectGroup = (
  key: string,
  linesAdded: number,
  linesDeleted: number,
  measuredSessions: number,
  totalSessions: number,
  priced = totalSessions,
): ProjectGroup => ({
  cache: 0,
  cost: 1,
  fresh: 0,
  key,
  label: key,
  lineMeasurement: { measuredSessions, totalSessions },
  linesAdded,
  linesDeleted,
  priced,
  sessions: totalSessions,
  tools: 0,
  turns: 0,
});

const countOccurrences = (value: string, fragment: string): number => value.split(fragment).length - 1;

const withoutSsrMarkers = (value: string): string =>
  value.replaceAll('<!--#-->', '').replaceAll('<!--$-->', '').replaceAll('<!--/-->', '');

describe('ProjectSummary line measurements', () => {
  test('shares complete, partial, absent, and measured-zero rendering across desktop and mobile', () => {
    const html = renderToString(() =>
      createComponent(ProjectSummary, {
        groups: [
          projectGroup('complete', 3, 2, 2, 2),
          projectGroup('partial', 5, 1, 1, 2),
          projectGroup('unmeasured', 0, 0, 0, 1),
          projectGroup('measured-zero', 0, 0, 1, 1),
        ],
        onManageProjectGroups: () => undefined,
        onProjectFilter: () => undefined,
      }),
    );
    const visibleHtml = withoutSsrMarkers(html);

    expect(countOccurrences(visibleHtml, '+3/-2')).toBe(2);
    expect(countOccurrences(visibleHtml, '+5/-1 · 1/2 measured')).toBe(2);
    expect(countOccurrences(visibleHtml, '>—</')).toBe(2);
    expect(countOccurrences(visibleHtml, '+0/-0')).toBe(2);
  });

  test('keeps partially priced project values visibly lower-bounded on desktop and mobile', () => {
    const html = withoutSsrMarkers(
      renderToString(() =>
        createComponent(ProjectSummary, {
          groups: [projectGroup('partial-price', 0, 0, 1, 2, 1), projectGroup('complete-price', 0, 0, 1, 2)],
          onManageProjectGroups: () => undefined,
          onProjectFilter: () => undefined,
        }),
      ),
    );

    expect(countOccurrences(html, '>≥ $1.00<')).toBe(2);
    expect(countOccurrences(html, '>$1.00<')).toBe(2);
  });
  test('labels only locked data-quality shapes and retains every desktop and mobile row', () => {
    const projectLabels = ['usage.csv', 'agent-a1', '(unknown)', 'regular-project', 'report.csv.json'];
    const html = renderToString(() =>
      createComponent(ProjectSummary, {
        groups: projectLabels.map((label) => projectGroup(label, 0, 0, 1, 1)),
        onManageProjectGroups: () => undefined,
        onProjectFilter: () => undefined,
      }),
    );
    const visibleHtml = withoutSsrMarkers(html);

    expect(countOccurrences(visibleHtml, '<tr')).toBe(projectLabels.length + 1);
    expect(countOccurrences(visibleHtml, '<li')).toBe(projectLabels.length);
    for (const projectLabel of projectLabels) {
      expect(countOccurrences(visibleHtml, `>${projectLabel}</button>`)).toBe(2);
    }
    expect(countOccurrences(visibleHtml, '>Filename-like</button>')).toBe(2);
    expect(countOccurrences(visibleHtml, '>Worktree-like</button>')).toBe(2);
    expect(countOccurrences(visibleHtml, '>No detected project</button>')).toBe(2);
    expect(countOccurrences(visibleHtml, 'title="Open Manage project groups"')).toBe(6);
  });
});
