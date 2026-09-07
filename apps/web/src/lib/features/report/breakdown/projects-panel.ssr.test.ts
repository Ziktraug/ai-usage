import { afterAll, describe, expect, test } from 'bun:test';
import type { UsageReportProjectGroup, UsageReportProjectSource } from '@ai-usage/report-core/report-data';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { ProjectGroup } from '../../../../dashboard-analytics';

const LEGACY_MEASUREMENT_PATTERN = /\d+\/\d+ measured/;
const MOBILE_EMPTY_STATUS_PATTERN = /<li[^>]*><span role="status">No projects<\/span><\/li>/;

interface SvelteServerModule {
  render(component: Component, options?: { props?: Record<string, unknown> }): { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Projects panel module did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const source = (id: string, machineId: string, machineLabel: string, project: string): UsageReportProjectSource => ({
  gitRemote: '',
  id,
  machineId,
  machineLabel,
  project,
  sessions: 3,
  sourcePath: `/home/alex/${project}`,
  tokens: 0,
});

const reportGroup = (
  id: string,
  name: string,
  grouped: boolean,
  sources: readonly UsageReportProjectSource[],
): UsageReportProjectGroup => ({
  cache: 0,
  cost: 0,
  fresh: 0,
  grouped,
  id,
  linesAdded: 0,
  linesDeleted: 0,
  name,
  priced: 0,
  sessions: 0,
  sources: [...sources],
  tokens: 0,
  tools: 0,
  turns: 0,
});

const project = (
  key: string,
  label: string,
  measuredSessions: number,
  totalSessions: number,
  linesAdded: number,
  linesDeleted: number,
): ProjectGroup => ({
  cache: 0,
  cost: 0,
  fresh: 0,
  key,
  label,
  lineMeasurement: { measuredSessions, totalSessions },
  linesAdded,
  linesDeleted,
  priced: totalSessions,
  sessions: totalSessions,
  tools: 0,
  turns: 0,
});

const fixtureASource = source('fixture-a|/home/alex/fixture-app', 'fixture-a', 'Fixture Machine', 'fixture-app');
const fixtureBSource = source(
  'fixture-b|/home/alex/fixture-app',
  'fixture-b',
  'Fixture Machine Secondary',
  'fixture-app',
);
const catalogue = [
  reportGroup('source:fixture-a|/home/alex/fixture-app', 'fixture-app — Fixture Machine', false, [fixtureASource]),
  reportGroup('source:fixture-b|/home/alex/fixture-app', 'fixture-app — Fixture Machine Secondary', false, [
    fixtureBSource,
  ]),
  reportGroup('group:shared', 'Shared tooling', true, [fixtureASource, fixtureBSource]),
];
const groups = [
  project(catalogue[0]!.id, catalogue[0]!.name, 1, 3, 0, 0),
  project(catalogue[1]!.id, catalogue[1]!.name, 2, 2, 860, 120),
  project(catalogue[2]!.id, catalogue[2]!.name, 0, 4, 0, 0),
];

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
afterAll(() => viteServer.close());
const [componentModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/report/breakdown/projects-panel.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const component = componentFrom(componentModule);
const { render } = rendererFrom(serverModule);

const props = {
  disabled: false,
  generatedAt: '2026-08-09T12:00:00.000Z',
  groups,
  onProjectFilter: () => undefined,
  onSave: () => Promise.resolve(),
  payload: { projectGroupConfigs: [], projectGroups: catalogue },
};

describe('Projects breakdown render', () => {
  test('separates project and machine identity with semantic headers and line provenance', () => {
    const { body } = render(component, { props });
    const breakdownBody = body.slice(0, body.indexOf('<details class='));

    expect(body).toContain('data-breakdown-panel="projects"');
    expect(body).toContain('aria-label="Search this breakdown"');
    expect(body).toContain('>3 projects<');
    expect(body.match(/scope="col"/g)).toHaveLength(8);
    expect(body.match(/scope="row"/g)).toHaveLength(3);
    expect(body).toContain('>Lines changed</th>');
    expect(body).not.toContain('>Lines</th>');
    expect(body.match(/data-project-name/g)).toHaveLength(6);
    expect(breakdownBody).not.toContain('fixture-app — Fixture Machine');
    expect(body).toContain('>fixture-app</button>');
    expect(body).toContain('>Shared tooling</button>');
    expect(body).toContain('aria-label="Filter sessions by project fixture-app"');
    expect(body.match(/data-project-machine/g)).toHaveLength(6);
    expect(body).toContain('Fixture Machine');
    expect(body).toContain('Fixture Machine Secondary');
    expect(body).toContain('Fixture Machine · Fixture Machine Secondary');
    expect(body).toContain('data-project-lines="lower-bound"');
    expect(body).toContain('+0/-0');
    expect(body).not.toContain('≥ +0/-0');
    expect(body).toContain('1 of 3 sessions measured');
    expect(body).toContain('data-project-lines="exact"');
    expect(body).toContain('+860/-120');
    expect(body).toContain('data-project-lines="unknown"');
    expect(body.match(/data-project-lines-coverage/g)).toHaveLength(2);
    expect(body).not.toMatch(LEGACY_MEASUREMENT_PATTERN);
  });

  test('keeps the shared empty status in desktop and mobile representations', () => {
    const { body } = render(component, { props: { ...props, groups: [] } });
    expect(body.match(/role="status"/g)).toHaveLength(2);
    expect(body).toMatch(MOBILE_EMPTY_STATUS_PATTERN);
    expect(body).toContain('No projects');
  });
});
