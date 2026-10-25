import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { conflictingAtoms } from '../../foundation/presentation/atomic-class-conflicts';
import { deferredDelegationPageData, loadDelegationPageData } from './delegation-load';
import { DELEGATION_DESCRIPTION } from './delegation-model';
import { SYNTHETIC_DELEGATION_QUALIFICATION, SYNTHETIC_DELEGATION_SETTINGS } from './delegation-synthetic';

interface SvelteServerModule {
  readonly render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (value: unknown, label: string): Component => {
  if (!(typeof value === 'object' && value !== null && 'default' in value && typeof value.default === 'function')) {
    throw new Error(`${label} did not expose a Svelte component.`);
  }
  return value.default as Component;
};

const rendererFrom = (value: unknown): SvelteServerModule => {
  if (!(typeof value === 'object' && value !== null && 'render' in value && typeof value.render === 'function')) {
    throw new Error('Svelte server renderer is unavailable.');
  }
  return value as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../', import.meta.url));
const environmentFixture = fileURLToPath(new URL('../sync/sync-ssr-environment.fixture.ts', import.meta.url));
const navigationFixture = fileURLToPath(new URL('./delegation-navigation.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [...svelte()],
  resolve: {
    alias: { '$app/env': environmentFixture, '$app/navigation': navigationFixture },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());
const [workbenchModule, resultModule, pageModule, serverModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/delegation/delegation-workbench.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/delegation/simulation-result.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/delegation/delegation-page.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const workbench = componentFrom(workbenchModule, 'Delegation workbench fixture');
const simulationResult = componentFrom(resultModule, 'Simulation result');
const pageFixture = componentFrom(pageModule, 'Delegation page fixture');
const { render } = rendererFrom(serverModule);
const settings = SYNTHETIC_DELEGATION_SETTINGS;

describe('Delegation page', () => {
  test('server-renders the hydrated settings under the Delegation heading, on the section the URL names', async () => {
    const data = await loadDelegationPageData(
      {
        fetch: () => Promise.reject(new Error('Injected Delegation fixture owns this acquisition.')),
        url: new URL('http://delegation.invalid/delegation?section=rules'),
      },
      { createClient: () => ({ settings: () => Promise.resolve({ data: settings, ok: true as const }) }) },
    );
    const body = render(pageFixture, { props: { data } }).body;

    expect(data.section).toBe('rules');
    expect(body).toContain('data-route-shell="delegation"');
    expect(body).toContain('>Delegation</h1>');
    expect(body).toContain(DELEGATION_DESCRIPTION);
    expect(body).toContain('data-delegation-section-active="rules"');
    expect(body).toContain(`data-delegation-revision="${settings.revision}"`);
    expect(body).toContain('aria-label="Delegation sections"');
    expect(conflictingAtoms(body)).toEqual([]);
  });

  test('renders the loading state for a deferred client-side entry', () => {
    const data = deferredDelegationPageData(new URL('http://delegation.invalid/delegation'));
    const body = render(pageFixture, { props: { data } }).body;

    expect(data.section).toBe('routes');
    expect(body).toContain('Loading delegation settings…');
    expect(body).toContain('aria-live="polite"');
    expect(body).not.toContain('data-delegation-workbench');
  });
});

describe('Delegation routes section', () => {
  const body = render(workbench, { props: { section: 'routes', settings } }).body;

  test('shows the undeclared context, the declared-versus-observed identity and the stale quota', () => {
    expect(body).toContain('data-delegation-section="routes"');
    expect(body).toContain('undeclared — not admissible');
    expect(body).toContain('declared a1b2c3d4e5f60718');
    expect(body).toContain('observed f0e1d2c3b4a59687');
    expect(body).toContain('contradicted: the signed-in account is not the pinned one');
    expect(body).not.toContain('observed a1b2c3d4e5f60718');
    expect(body).toContain('not observable: this harness reports no account');
    expect(body).toContain('5h (account) · 35% remaining · resets 2026-10-25T00:30:00.000Z · stale');
    expect(body).toContain('stale (last checked 2026-10-24T20:00:00.000Z)');
    expect(body).toContain('Declare a context for codex/work in delegation.routes[]');
    expect(body).toContain('pool synthetic-machine/claude-code/personal');
  });

  test('lists every cataloged harness with its executor support and the caller statement', () => {
    expect(body).toContain('executor not supported in this version — no per-invocation read-only mode');
    expect(body).toContain('OpenCode');
    expect(body).toContain('Cursor');
    expect(body).toContain('Any MCP client can be a caller.');
    expect(body).toContain('never creates accounts and never handles provider secrets');
  });

  test('renders native forms with labelled fields, the observed pin offer and no conflicting atoms', () => {
    expect(body).toContain('data-delegation-form="executors"');
    expect(body).toContain('data-delegation-form="route-annotations"');
    expect(body).toContain('data-delegation-form="review-targets"');
    expect(body).toContain('<label for="executor-0-fingerprint">Pinned account fingerprint</label>');
    expect(body).toContain('Pin observed f0e1d2c3b4a59687');
    expect(body).toContain('<label for="route-1-context">Context</label>');
    expect(body).toContain('api (never admissible)');
    expect(body).toContain('/home/operator/.config/ai-usage/config.json');
    expect(conflictingAtoms(body)).toEqual([]);
  });
});

describe('Delegation rules section', () => {
  const body = render(workbench, { props: { section: 'rules', settings } }).body;

  test('states the fixed priority, the subscription-only rule and the three identities', () => {
    expect(body).toContain('context declared → forbid → restrict → require → preferences only order');
    expect(body).toContain('Subscription-only is fixed in this version');
    expect(body).toContain('Three different identities');
    expect(body).toContain('Rule work-repos-professional');
    expect(body).toContain('<label for="rule-1-require-evidence">Identity evidence</label>');
    expect(body).not.toContain('rule-0-require-evidence');
    expect(body).toContain('runs the same qualification as a start');
    expect(body).toContain('<label for="simulator-checkout">Checkout path</label>');
    expect(body).toContain('operator-acme');
    expect(conflictingAtoms(body)).toEqual([]);
  });
});

describe('Delegation models section', () => {
  const body = render(workbench, { props: { section: 'models', settings } }).body;

  test('labels declarations and observations apart and never ranks', () => {
    expect(body).toContain('Operator declaration; never a measured performance.');
    expect(body).toContain('Declared 2026-10-19T07:00:00.000Z.');
    expect(body).toContain('Observed in runs, not a ranking.');
    expect(body).toContain('unknown (not reported)');
    expect(body).toContain('claude-opus-4-1-20250805');
    expect(conflictingAtoms(body)).toEqual([]);
  });
});

describe('Delegation simulation result', () => {
  const body = render(simulationResult, { props: { qualification: SYNTHETIC_DELEGATION_QUALIFICATION } }).body;

  test('renders admissible and excluded routes, applied rules and assumptions', () => {
    expect(body).toContain('1 admissible route; your agent would choose among them.');
    expect(body).toContain('data-delegation-admissible="synthetic-machine/claude-code/personal/claude-opus-4-1"');
    expect(body).toContain('data-delegation-excluded="synthetic-machine/codex/work/gpt-5-codex"');
    expect(body).toContain('assumed to apply');
    expect(body).toContain('rule work-repos-professional is assumed to apply');
    expect(body).toContain('No context is declared for codex/work');
    expect(body).toContain('blockers context-undeclared, identity-evidence, quota');
    expect(body).toContain('deterministic tie-break, not a judgment');
    expect(body).toContain('policy policy00000000a1 · catalog catalog0000000001');
    expect(body).toContain('2026-10-25T10:10:00.000Z');
    expect(conflictingAtoms(body)).toEqual([]);
  });
});
