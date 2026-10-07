import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { MemoryProposalReviewSnapshot } from '@ai-usage/web-contract/memory';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { createWebQueryClient, dehydrateWebQueryClient } from '../../query/client';
import { memoryProposalReviewsKey } from '../../query/options/memory';
import { loadMemoryPageData } from './memory-load';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Memory fixture did not expose a Svelte component.');
  }
  return value.default as Component;
};

const rendererFrom = (value: unknown): SvelteServerModule => {
  if (!(typeof value === 'object' && value !== null && 'render' in value && typeof value.render === 'function')) {
    throw new Error('Svelte server renderer is unavailable.');
  }
  return value as SvelteServerModule;
};

const snapshot: MemoryProposalReviewSnapshot = {
  nextCursor: null,
  proposals: [
    {
      guidance: ['Keep authority local.'],
      observationSources: [
        {
          id: '0198f179-4837-7000-8000-000000000003',
          observedAt: '2026-08-29T08:30:00.000Z',
          sensitivity: 'normal',
          sourceKind: 'commit',
          sourceLocator: 'commit:0123456789ab',
        },
      ],
      projectId: null,
      proposalId: '0198f179-4837-7000-8000-000000000002',
      proposedByKind: 'service',
      proposedKind: 'decision',
      sensitivity: 'normal',
      structuredContent: { authority: 'sqlite' },
      summary: 'A generated summary.',
      title: 'Keep Memory local',
      trustCandidate: 'harvest-accepted',
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
  viteServer.ssrLoadModule('/apps/web/src/lib/features/memory/memory-page.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(serverModule);

describe('Memory proposal review surface', () => {
  test('renders generated status, provenance, trust, and every explicit review action', async () => {
    const data = await loadMemoryPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Memory fixture owns this acquisition.')),
        url: new URL('http://memory.invalid/memory'),
      },
      {
        createClient: () => ({
          applyProposalReviewAction: () => Promise.reject(new Error('unused')),
          proposalReviews: () => Promise.resolve(snapshot),
          search: () => Promise.reject(new Error('unused')),
        }),
      },
    );
    const body = render(fixture, { props: { data } }).body;

    expect(body).toContain('data-route-shell="memory"');
    expect(body).toContain('Generated proposal · review required');
    expect(body).toContain('Keep Memory local');
    expect(body).toContain('harvest-accepted');
    expect(body).toContain('commit:0123456789ab');
    expect(body).toContain('Accept proposal');
    expect(body).toContain('Edit before accepting');
    expect(body).toContain('Reject proposal');
    expect(body).not.toContain('proposedByPrincipal');
    const initialLibrary = render(fixture, { props: { data, address: '/memory' } }).body;
    expect(initialLibrary).toContain('Reading recognized Projects');
    expect(initialLibrary).not.toContain('No recognized Projects');
  });
  test('marks the addressed proposal and refuses a malformed address before any read', () => {
    const proposalId = snapshot.proposals[0]!.proposalId;
    const client = createWebQueryClient();
    client.setQueryData(memoryProposalReviewsKey({ proposalId }), snapshot);
    const data = { queryState: dehydrateWebQueryClient(client) };
    client.clear();

    const addressed = render(fixture, {
      props: { data, address: `/memory?view=review&proposal=${proposalId}` },
    }).body;
    expect(addressed).toContain('The requested proposal is shown first');
    expect(addressed).toContain('Requested proposal · review required');
    expect(addressed).toContain('data-memory-proposal-target');
    expect(addressed).toContain('Newest proposals');

    const malformed = render(fixture, {
      props: { data, address: '/memory?view=review&proposal=not-a-proposal' },
    }).body;
    expect(malformed).toContain('This Memory proposal is not pending review or is not accessible.');
    expect(malformed).toContain('Open the review queue');
    expect(malformed).not.toContain('Keep Memory local');
  });
});
