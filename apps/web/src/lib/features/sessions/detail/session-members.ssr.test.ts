import { afterAll, describe, expect, test } from 'bun:test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { syntheticCampaignRow, syntheticSessionRow } from '../table/session-table.fixtures';

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: new URL('../../../../../../../', import.meta.url).pathname,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());
const [{ default: Members }, { render }] = await Promise.all([
  server.ssrLoadModule('/apps/web/src/lib/features/sessions/detail/session-members.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const campaign = {
  ...syntheticCampaignRow(1),
  campaignKey: 'test-campaign',
  costApprox: 99,
  freshTokens: 777_000,
  turns: 4242,
  tools: 3131,
};
const memberRows = Array.from({ length: 361 }, (_, i) => ({ ...syntheticSessionRow(i), campaignKey: 'test-campaign' }));
const props = {
  campaign,
  rows: memberRows.slice(0, 3),
  totalCount: 3,
  hasNextPage: false,
  loading: false,
  error: null,
  expired: false,
  onNearEnd: () => false,
  onRetry: async () => undefined,
  onSelectMember: () => undefined,
};
const html = (overrides = {}) => render(Members, { props: { ...props, ...overrides } }).body.replaceAll(/\s+/g, ' ');
const counts = (body: string) =>
  body.slice(body.indexOf('data-campaign-session-counts'), body.indexOf('data-campaign-session-list'));

describe('canonical session members', () => {
  test('keeps aggregate header totals distinct from actual sessions and explains full scope', () => {
    const body = html({ rows: [...props.rows.slice(0, 2), { ...props.rows[2], origin: 'classifier' }] });
    expect(body).toContain('$99.00 API · 777k fresh tokens · 4,242 turns · 3,131 tools');
    expect(body).toContain('All campaign members, including automated reviews');
    expect(counts(body)).toContain('3 / 3 sessions shown');
    expect(counts(body)).not.toContain('automated review');
    expect(body).not.toContain('hidden by current filters');
    expect(body).not.toContain('Load more campaign sessions');
  });
  test('renders a bounded window while reporting acquired rather than mounted row count', () => {
    const body = html({ rows: memberRows.slice(0, 101), totalCount: 361, hasNextPage: true });
    expect(counts(body)).toContain('101 / 361 sessions loaded');
    const mounted = (body.match(/data-campaign-session-row-id=/g) ?? []).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(30);
    expect(body).toContain('data-loaded-rows="101"');
  });
  test('shows revision expiration without offering an impossible retry', () => {
    const body = html({ error: new Error('expired'), expired: true, hasNextPage: true });
    expect(body).toContain('This report revision expired');
    expect(body).not.toContain('Retry campaign members');
    expect(body).toContain('data-campaign-session-row-id=');
  });
  test('offers retry for transient failures and retains the readable prefix', () => {
    const body = html({ error: new Error('temporary'), hasNextPage: true });
    expect(body).toContain('Retry campaign members');
    expect(body).toContain('data-campaign-session-row-id=');
  });
});
