import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
import type { WorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { workRequest } from '../../query/options/work';
import { syntheticSessionRow } from '../sessions/table/session-table.fixtures';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error('Work routing fixture did not expose a Svelte component.');
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
  server.ssrLoadModule('/apps/web/src/lib/features/work/work-routing.fixture.svelte'),
  server.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const { render } = rendererFrom(rendererModule);

const MACHINE = 'synthetic-machine';
const row = {
  ...syntheticSessionRow(0),
  harness: 'Claude',
  projectLabel: 'ai-usage',
  source: {
    harnessKey: 'claude' as const,
    machineId: MACHINE,
    sourceSessionId: 'root-session',
    rootSourceSessionId: 'root-session',
  },
};
const target = projectSessionPage([row], workRequest('synthetic')).items[0]?.row;
if (!target) {
  throw new Error('Synthetic target row is missing.');
}
const providers: ProviderStatus[] = [
  {
    generatedAt: new Date(Date.now() - 60_000).toISOString(),
    key: 'claude',
    label: 'Claude',
    machineId: MACHINE,
    machineLabel: 'Synthetic workstation',
    plan: 'max',
    source: 'live-api',
    state: 'ok',
    windows: [
      {
        blocked: false,
        group: '5h',
        id: 'five_hour',
        label: '5h',
        limitSeconds: null,
        remainingPercent: 60,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
        scope: 'global',
        usedPercent: 40,
      },
    ],
  },
];
const context: WorkRoutingContext = {
  configPath: '/home/operator/.config/ai-usage/config.json',
  declarationErrors: ["routing.executors[1].subscription: must be 'verified' or 'api'"],
  declarations: [
    {
      accountScope: 'personal',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: '2026-10-20T08:00:00.000Z',
      effort: 'high',
      harness: 'claude-code',
      machineId: MACHINE,
      model: 'Opus',
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }],
    },
  ],
  executorObservations: [
    {
      authEvidence: 'claude auth status exit 0 loggedIn=true',
      authState: 'logged-in',
      binaryPath: '/usr/bin/claude',
      harness: 'claude-code',
      machineId: MACHINE,
      observedAt: new Date(Date.now() - 120_000).toISOString(),
      outcome: 'observed',
      version: '2.1.303 (Claude Code)',
    },
  ],
  generatedAt: new Date().toISOString(),
  machineId: MACHINE,
  observationRead: { skipped: 0, truncated: false },
};

const html = (props: Record<string, unknown>): string =>
  render(fixture, { props: { routing: props } })
    .body.replaceAll(/\s+/g, ' ')
    .replaceAll('&lt;', '<');

describe('Work routing Svelte rendering from a supplied context', () => {
  test('renders a declared and observed candidate with per-field provenance and no simulation result', () => {
    const body = html({ context, mode: 'live', providers, quotaUnavailable: false, target });
    expect(body).toContain('Candidate evidence (1)');
    expect(body).toContain('Claude Code · personal · Synthetic workstation');
    expect(body).toContain('Authorization: allowed · declared 2026-10-20T08:00:00.000Z');
    expect(body).toContain('Subscription: verified (plan observed: max) · declared 2026-10-20T08:00:00.000Z');
    expect(body).toContain('Availability: available · observed-now');
    expect(body).toContain('Quota: ok at ');
    expect(body).toContain('· observed-now');
    expect(body).toContain('Model: Opus · declared');
    expect(body).toContain("routing.executors[1].subscription: must be 'verified' or 'api'");
    expect(body).toContain('/home/operator/.config/ai-usage/config.json');
    expect(body).not.toContain('To qualify this candidate');
    expect(body).not.toContain('Routing result');
    expect(body).not.toContain('Synthetic evidence examples');
  });

  test('names the missing declaration for an observed-only Codex and states an unavailable context', () => {
    const codex: ProviderStatus = { ...providers[0], key: 'codex', label: 'Codex' } as ProviderStatus;
    const body = html({ context, mode: 'live', providers: [...providers, codex], quotaUnavailable: false, target });
    expect(body).toContain('Candidate evidence (2)');
    expect(body).toContain("Add routing.executors[] for codex:<accountScope> with authorization 'allowed'");
    expect(body).toContain('Availability: unknown · unknown');

    const unavailable = html({ context: null, mode: 'live', providers, quotaUnavailable: true, target });
    expect(unavailable).toContain('Routing context unavailable');
    expect(unavailable).toContain('Candidate evidence (0)');
    expect(unavailable).toContain('Current quota observations are unavailable');
  });

  test('keeps the demo path on its fixtures without reading any context', () => {
    const body = html({ mode: 'demo', providers: [], quotaUnavailable: false, target });
    expect(body).toContain('Demo only');
    expect(body).toContain('Candidate evidence (2)');
    expect(body).toContain('Synthetic evidence examples');
    expect(body).not.toContain('Routing context unavailable');
  });
});
