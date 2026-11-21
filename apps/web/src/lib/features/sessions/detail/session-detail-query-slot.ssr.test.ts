import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { QueryClient } from '@tanstack/svelte-query';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { createServer, type Plugin } from 'vite';
import { syntheticSessionRow } from '../table/session-table.fixtures';

/**
 * The slot owns the Session drawer's server state: it registers exactly the neighbours, detail and VCS
 * queries through the optional query factories, on the QueryClient of its context, and nothing else.
 * A harness compiled in memory provides that client, so the render shows which queries the slot owns.
 */
const SLOT_PATH = '/apps/web/src/lib/features/sessions/detail/session-detail-query-slot.svelte';
const HARNESS_ID = '\0session-detail-query-slot-harness';
const HARNESS_SOURCE = `<script>
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import Slot from '${SLOT_PATH}';
  let { queryClient, ...slotProps } = $props();
</script>
<QueryClientProvider client={queryClient}><Slot {...slotProps} {queryClient} /></QueryClientProvider>
`;

const harnessPlugin: Plugin = {
  enforce: 'pre',
  load: (id) =>
    id === HARNESS_ID
      ? compile(HARNESS_SOURCE, { dev: true, filename: 'session-detail-query-slot-harness.svelte', generate: 'server' })
          .js.code
      : undefined,
  name: 'session-detail-query-slot-harness',
  resolveId: (id) => (id === HARNESS_ID ? HARNESS_ID : undefined),
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [harnessPlugin, svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(async () => await viteServer.close());

interface SessionQueryOptionsModule {
  readonly optionalSessionDetailQueryOptions: (...args: never[]) => { readonly queryKey: readonly unknown[] };
  readonly optionalSessionNeighborsQueryOptions: (...args: never[]) => { readonly queryKey: readonly unknown[] };
  readonly optionalSessionVcsQueryOptions: (...args: never[]) => { readonly queryKey: readonly unknown[] };
}

const [harnessModule, serverModule, clientModule, optionsModule] = await Promise.all([
  viteServer.ssrLoadModule(HARNESS_ID),
  viteServer.ssrLoadModule('svelte/server'),
  viteServer.ssrLoadModule('/apps/web/src/lib/query/client.ts'),
  viteServer.ssrLoadModule('/apps/web/src/lib/query/options/session.ts'),
]);
const Harness = Reflect.get(harnessModule, 'default') as Component<Record<string, unknown>>;
const render = Reflect.get(serverModule, 'render') as (
  component: Component<Record<string, unknown>>,
  options: { props: Record<string, unknown> },
) => { body: string };
// The client and the factories come from the same module graph as the rendered slot.
const createWebQueryClient = Reflect.get(clientModule, 'createWebQueryClient') as () => QueryClient;
const options = optionsModule as unknown as SessionQueryOptionsModule;

const unreachable = (): Promise<never> => Promise.reject(new Error('A server render must not run a session query'));
const client = {
  campaignChildren: unreachable,
  detail: unreachable,
  lookup: unreachable,
  neighbors: unreachable,
  page: unreachable,
  vcs: unreachable,
};

const renderedQueryKeys = (selection: unknown): unknown[] => {
  const queryClient = createWebQueryClient();
  // The server render runs when its output is read.
  const { body } = render(Harness, {
    props: { client, onSelectionChange: () => undefined, queryClient, rows: [], selection },
  });
  if (!body.includes('data-session-detail-slot')) {
    throw new Error('The harness did not render the Session detail query slot');
  }
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey);
};

const execution = { browser: false };
type FactoryArguments = Parameters<SessionQueryOptionsModule['optionalSessionDetailQueryOptions']>;
const keyOf = (
  factory: (...args: never[]) => { readonly queryKey: readonly unknown[] },
  request: unknown,
): readonly unknown[] => factory(...([client, request, execution] as unknown as FactoryArguments)).queryKey;

describe('Session detail query slot during SSR', () => {
  test('registers exactly the disabled neighbours, detail and VCS queries when nothing is selected', () => {
    expect(renderedQueryKeys(null)).toEqual([
      keyOf(options.optionalSessionNeighborsQueryOptions, undefined),
      keyOf(options.optionalSessionDetailQueryOptions, undefined),
      keyOf(options.optionalSessionVcsQueryOptions, undefined),
    ]);
  });

  test('registers the selected row neighbours and detail through the optional factories, VCS still unrequested', () => {
    const row = syntheticSessionRow(0);
    const query = {
      cursor: null,
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      pageSize: 50,
      range: { from: null, to: null },
      revision: 'revision-1',
      sort: [{ desc: true, id: 'date' }],
    };

    expect(renderedQueryKeys({ query, revision: 'revision-1', row })).toEqual([
      keyOf(options.optionalSessionNeighborsQueryOptions, { query, rowId: row.rowId }),
      keyOf(options.optionalSessionDetailQueryOptions, { revision: 'revision-1', rowId: row.rowId }),
      keyOf(options.optionalSessionVcsQueryOptions, undefined),
    ]);
  });
});
