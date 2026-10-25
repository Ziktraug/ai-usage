import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { workRequest } from '../../query/options/work';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { syntheticSessionRow } from '../sessions/table/session-table.fixtures';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work session fixture did not expose a Svelte component.');
  }
  return value.default as Component;
};
const rendererFrom = (value: unknown): SvelteServerModule => {
  if (!(typeof value === 'object' && value !== null && 'render' in value && typeof value.render === 'function')) {
    throw new Error('Svelte server renderer is unavailable.');
  }
  return value as SvelteServerModule;
};

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: {
    alias: { '$app/env': fileURLToPath(new URL('../sync/sync-ssr-environment.fixture.ts', import.meta.url)) },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());
const [fixtureModule, rendererModule] = await Promise.all([
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-session.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

const forbiddenRead = (): Promise<never> => Promise.reject(new Error('Collapsed Work session must not acquire data'));
const client: SessionClientAdapter = {
  campaignChildren: forbiddenRead,
  detail: forbiddenRead,
  lookup: forbiddenRead,
  neighbors: forbiddenRead,
  page: forbiddenRead,
  vcs: forbiddenRead,
};
const revision = 'synthetic-parent-removed';

describe('Work session Svelte rendering from synthetic projection boundaries', () => {
  test('keeps a delegated root and exposes unavailable parent evidence after its declaring transcript is removed', () => {
    // This is the collected shape after the parent's derived spawn declaration is removed:
    // delegated origin survives, but neither a stale parent id nor a parent row is retained.
    const child = {
      ...syntheticSessionRow(0),
      harness: 'Claude',
      origin: 'subagent' as const,
      subagent: true,
      source: {
        harnessKey: 'claude' as const,
        machineId: 'synthetic-machine',
        sourceSessionId: 'remaining-child',
        rootSourceSessionId: 'remaining-child',
      },
    };
    const page = projectSessionPage([child], workRequest(revision));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.row.source?.parentSourceSessionId).toBeUndefined();
    expect(page.items[0]?.row.campaignTotalCount).toBe(1);
    expect(page.items[0]?.row.originProvenance).toBeUndefined();
    const html = render(fixture, {
      props: { session: { client, item: page.items[0], revision } },
    }).body.replaceAll(/\s+/g, ' ');
    expect(html).toContain('Delegated');
    expect(html).toContain('Parent relationship unavailable');
    expect(html).toContain('No parent identifier is present in this observation.');
    expect(html).not.toContain('Declared parent:');
    expect(html).not.toContain('related sessions and technical reviews');
    expect(html).toContain('Open session detail');
  });

  test.each(['human', undefined] as const)('does not invent a missing-parent defect for a %s root', (origin) => {
    const { origin: _origin, ...row } = syntheticSessionRow(0);
    const page = projectSessionPage([{ ...row, ...(origin ? { origin } : {}) }], workRequest(revision));
    const html = render(fixture, {
      props: { session: { client, item: page.items[0], revision } },
    }).body;
    expect(html).not.toContain('Parent relationship unavailable');
    expect(html).not.toContain('Declared parent:');
  });

  test('exposes both native identity and parent evidence gaps for a delegated observation lacking them', () => {
    const { source: _source, ...row } = syntheticSessionRow(0);
    const page = projectSessionPage([{ ...row, origin: 'subagent', subagent: true }], workRequest(revision));
    const html = render(fixture, {
      props: { session: { client, item: page.items[0], revision } },
    }).body;
    expect(html).toContain('Native session identity is unavailable');
    expect(html).toContain('Parent relationship unavailable');
    expect(html).not.toContain('Declared parent:');
  });

  test('keeps an explicit unresolved parent declaration distinct from an unavailable identifier', () => {
    const row = syntheticSessionRow(0);
    const page = projectSessionPage(
      [
        {
          ...row,
          origin: 'subagent',
          subagent: true,
          source: { ...row.source!, parentSourceSessionId: 'declared-parent' },
        },
      ],
      workRequest(revision),
    );
    const html = render(fixture, {
      props: { session: { client, item: page.items[0], revision } },
    }).body.replaceAll(/\s+/g, ' ');
    expect(html).toContain('Declared parent: declared-parent');
    expect(html).not.toContain('No parent identifier is present in this observation.');
  });
});
