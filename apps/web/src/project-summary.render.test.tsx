import { afterAll, describe, expect, test } from 'bun:test';
import { type Component, createComponent } from 'solid-js';
import { renderToString } from 'solid-js/web';
import { createServer } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import type { ProjectGroup } from './dashboard-analytics';

interface ProjectSummaryProps {
  groups: ProjectGroup[];
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
): ProjectGroup => ({
  cache: 0,
  cost: 1,
  fresh: 0,
  key,
  label: key,
  lineMeasurement: { measuredSessions, totalSessions },
  linesAdded,
  linesDeleted,
  priced: totalSessions,
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
        onProjectFilter: () => undefined,
      }),
    );
    const visibleHtml = withoutSsrMarkers(html);

    expect(countOccurrences(visibleHtml, '+3/-2')).toBe(2);
    expect(countOccurrences(visibleHtml, '+5/-1 · 1/2 measured')).toBe(2);
    expect(countOccurrences(visibleHtml, '>—</')).toBe(2);
    expect(countOccurrences(visibleHtml, '+0/-0')).toBe(2);
  });
});
