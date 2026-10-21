import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { EMPTY_WORK_ATTENTION_SEARCH, type WorkAttentionSearch, workRootId } from './work-attention-model';
import { syntheticWorkAttentionDataset } from './work-attention-synthetic';
import { WORK_DEMO_REVISION } from './work-synthetic';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work attention fixture did not expose a Svelte component.');
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
    alias: { '$app/environment': fileURLToPath(new URL('../sync/sync-ssr-environment.fixture.ts', import.meta.url)) },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());
const [fixtureModule, rendererModule] = await Promise.all([
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-attention.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

const forbiddenRead = (): Promise<never> => Promise.reject(new Error('Server-rendered Work must not acquire data'));
const sessionClient: SessionClientAdapter = {
  campaignChildren: forbiddenRead,
  detail: forbiddenRead,
  lookup: forbiddenRead,
  neighbors: forbiddenRead,
  page: forbiddenRead,
  vcs: forbiddenRead,
};
const dataset = syntheticWorkAttentionDataset();
const noop = (): void => undefined;
const html = (search: WorkAttentionSearch, selectedId: string | null = null): string => {
  const root = selectedId ? dataset.roots.find((candidate) => workRootId(candidate) === selectedId) : undefined;
  return render(fixture, {
    props: {
      board: { dataset, onFocusRow: noop, onSearch: noop, onSelect: noop, search, selectedId },
      ...(root
        ? {
            detail: {
              loadedRows: [],
              mode: 'demo',
              onClose: noop,
              providers: [],
              quotaUnavailable: true,
              reference: dataset.generatedAt,
              revision: WORK_DEMO_REVISION,
              root,
              sessionClient,
            },
          }
        : {}),
    },
  }).body.replaceAll(/\s+/g, ' ');
};
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const rowsIn = (body: string, section: string): number => {
  const start = body.indexOf(`data-work-section="${section}"`);
  const end = body.indexOf('</section>', start);
  return occurrences(body.slice(start, end), 'data-work-root=');
};

describe('Work resume surface server rendering from the synthetic dataset', () => {
  test('renders the four sections, the coverage line and compact rows without any acquisition', () => {
    const body = html(EMPTY_WORK_ATTENTION_SEARCH);
    for (const heading of ['Needs you', 'Waiting on others', 'Leads', 'Recent, nothing pending']) {
      expect(body).toContain(heading);
    }
    expect(body).toContain('39 of 41 files parsed');
    expect(body).toContain('2 unsupported');
    expect(body).toContain(`ranking covers ${dataset.roots.length} of ${dataset.totalRoots} roots`);
    expect(body).not.toContain('Known waits');
    expect(body).not.toContain('Simulate review assignment');
    expect(occurrences(body, 'Declared by the session; current state unobserved.')).toBe(3);
    expect(rowsIn(body, 'human-request')).toBe(5);
    expect(rowsIn(body, 'none')).toBe(10);
    expect(body).toContain('Show all 13 in Recent, nothing pending');
    expect(body).toContain('Confirm whether the Codex quota window should be dated by its last confirmation');
    expect(body).toContain('blocked · <time datetime="2026-06-11T09:00:00.000Z"');
    expect(body).toContain('3 h ago');
    expect(body).toContain('28 d ago');
    // The eleventh and later recent rows are folded behind the explicit control.
    expect(body).not.toContain('40 d ago');
    expect(body).toContain('auto title');
    expect(body).toContain('archived');
    expect(body).toContain('PR #71 checks pending');
    expect(body).toContain('checkout dirty (3 modified)');
    expect(body).toContain('Jira XLB-2090 · In Progress · 2 new replies');
  });
  test('a root with a Jira fact lists it under its own source with the arrival named and its uncertainty', () => {
    const withJira = dataset.roots.find((root) => root.facts.some((fact) => fact.kind === 'jira-issue'));
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(withJira!));
    expect(body).toContain('data-work-detail=');
    expect(body).toContain('>Jira<');
    expect(body).toContain("Jira XLB-2090 In Progress, 2 comments, 2 new replies since the family's last activity");
    expect(body).toContain('2 comments arrived on XLB-2090 after this session family');
    expect(body).toContain('You may have read them in Jira; this view cannot tell.');
  });
  test('applies the address filters on the server and reports the narrowed count', () => {
    const body = html({ ...EMPTY_WORK_ATTENTION_SEARCH, query: 'mobile navigation' });
    expect(occurrences(body, 'data-work-root=')).toBe(1);
    expect(body).toContain(`1 of ${dataset.roots.length} roots shown`);
    expect(body).toContain('aria-pressed="false"');
    const chips = html({ ...EMPTY_WORK_ATTENTION_SEARCH, attention: ['optional-lead'], harness: ['claude'] });
    expect(occurrences(chips, 'data-work-root=')).toBe(3);
    expect(chips).toContain('Clear filters');
    expect(occurrences(chips, 'aria-pressed="true"')).toBe(2);
  });
  test('marks the selected row and renders its detail with the exact declaration date and grouped facts', () => {
    const selected = dataset.roots.find((root) => root.title === 'Fix mobile navigation label overlap');
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(selected!));
    expect(occurrences(body, 'aria-current="true"')).toBe(1);
    expect(body).toContain('data-work-detail=');
    expect(body).toContain('Which of the two 320px layouts do you prefer?');
    expect(body).toContain('Declared by the session at Jun 10, 2026, 10:00 UTC; its current state is unobserved.');
    expect(body).toContain('Facts by source');
    for (const source of ['Claude Desktop metadata', 'GitHub', 'Local checkout']) {
      expect(body).toContain(source);
    }
    expect(body).toContain('Uncertainty:');
    expect(body).toContain('Review assignment simulation');
    expect(body).toContain('Transcript not collected yet');
    expect(body).not.toContain('Run simulation');
  });
  test('a root joined to a served Session links to its detail and offers the related sessions on demand', () => {
    const joined = dataset.roots.find((root) => root.session?.campaignKey);
    const body = html(EMPTY_WORK_ATTENTION_SEARCH, workRootId(joined!));
    expect(body).toContain('Open session detail');
    expect(body).toContain(`/sessions/${encodeURIComponent(joined!.session!.rowId)}`);
    expect(body).toContain('Related served sessions');
    expect(body).toContain('Resolving the collected Session for this root');
  });
});
