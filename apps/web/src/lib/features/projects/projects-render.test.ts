import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ProjectResolutionReviewSnapshot } from '@ai-usage/web-contract/projects';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { loadProjectsPageData } from './projects-load';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Projects fixture did not expose a Svelte component.');
  }
  return value.default as Component;
};

const rendererFrom = (value: unknown): SvelteServerModule => {
  if (!(typeof value === 'object' && value !== null && 'render' in value && typeof value.render === 'function')) {
    throw new Error('Svelte server renderer is unavailable.');
  }
  return value as SvelteServerModule;
};

const snapshot: ProjectResolutionReviewSnapshot = {
  reviews: [
    {
      candidateMatches: [
        {
          canonicalLabel: 'github.com/openai/ai-usage',
          repositoryId: '0198f179-4837-7000-8000-000000000004',
        },
      ],
      checkoutId: '0198f179-4837-7000-8000-000000000002',
      destinationSpaceId: '0198f179-4837-7000-8000-000000000001',
      deviceId: '0198f179-4837-7000-8000-000000000003',
      deviceLabel: 'Opaque device',
      localLabel: 'checkout:0198f179',
      normalizedRemote: 'github.com/openai/ai-usage',
      status: 'candidate',
    },
  ],
  spaceId: '0198f179-4837-7000-8000-000000000001',
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../', import.meta.url));
const environmentFixture = fileURLToPath(new URL('../sync/sync-ssr-environment.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: { alias: { '$app/environment': environmentFixture }, conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());
const [fixtureModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/projects/projects-page.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(serverModule);

describe('Projects resolution review surface', () => {
  test('renders only opaque Checkout context with every explicit action', async () => {
    const data = await loadProjectsPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Projects fixture owns this acquisition.')),
        url: new URL('http://projects.invalid/projects'),
      },
      {
        createClient: () => ({
          applyResolutionAction: () => Promise.reject(new Error('unused')),
          resolutionReviews: () => Promise.resolve(snapshot),
        }),
      },
    );
    const body = render(fixture, { props: { data } }).body;

    expect(body).toContain('data-route-shell="projects"');
    expect(body).toContain('Opaque device');
    expect(body).toContain('checkout:0198f179');
    expect(body).toContain('github.com/openai/ai-usage');
    expect(body).toContain('Destination Space');
    expect(body).toContain('Create Project');
    expect(body).toContain('Leave unassigned');
    expect(body).toContain('>Link</button>');
    expect(body).not.toContain('/private/');
  });
});
