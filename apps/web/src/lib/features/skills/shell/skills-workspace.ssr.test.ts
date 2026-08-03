import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { createWebRpcHttpHandler } from '../../../server/rpc/handler.server';
import type { WebRpcRouterDependencies } from '../../../server/rpc/router';
import type { SkillsCapability, SkillsCapabilityResult } from '../../../server/rpc/skills';
import { loadSkillsShellRoute } from './data';
import {
  syntheticInventories,
  syntheticKnownPaths,
  syntheticManagedDocument,
  syntheticProjectDocument,
  syntheticSnapshot,
} from './synthetic-fixture.test-helper';

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Skills workspace fixture did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const navigationFixturePath = fileURLToPath(new URL('./sveltekit-navigation.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: {
    alias: { '$app/navigation': navigationFixturePath },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);

const [fixtureModule, hydrationFixtureModule, convergenceFixtureModule, svelteServerModule] = await Promise.all([
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-workspace.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-shell.hydration.fixture.svelte'),
  viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-convergence.fixture.svelte'),
  viteServer.ssrLoadModule('svelte/server'),
]);
const fixture = componentFrom(fixtureModule);
const hydrationFixture = componentFrom(hydrationFixtureModule);
const convergenceFixture = componentFrom(convergenceFixtureModule);
const { render } = rendererFrom(svelteServerModule);

const ok = <Value>(data: Value): SkillsCapabilityResult<Value> => ({ data, ok: true });
const unavailable = (): Promise<never> => Promise.reject(new Error('Synthetic unrelated service unavailable.'));
const unavailableServices = <Services>(): Services =>
  new Proxy(
    {},
    {
      get: () => unavailable,
    },
  ) as Services;

const trustedHandlerFetch = (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
  const headers = new Headers(request.headers);
  headers.set('host', '127.0.0.1:4178');
  headers.set('origin', 'http://127.0.0.1:4178');
  headers.set('sec-fetch-site', 'same-origin');
  return await handler(new Request(request, { headers }));
};

describe('Svelte Skills workspace SSR', () => {
  test('renders a meaningful selected Global workspace without ClientOnly', () => {
    const html = render(fixture).body;
    expect(html).toContain('data-skills-workspace');
    expect(html).toContain('Global and project scopes');
    expect(html).toContain('alpha-skill');
    expect(html).toContain('Editable SKILL.md');
    expect(html).toContain('# Alpha synthetic document');
    expect(html).toContain('aria-label="Inspector"');
    expect(html).toContain('Health integration');
    expect(html).toContain('Browse skills');
    expect(html).toContain('aria-label="Skill picker scopes"');
    expect(html).toContain('aria-label="Selected skill detail"');
    expect(html).toContain('data-p9-slot-contract');
    expect(html).not.toContain('Loading skills');
  });
  test('marks populated and empty scope names with their full labels', () => {
    const html = render(fixture, { props: { includeEmptyScope: true, pathname: '/skills/global' } }).body;
    const markers = html.match(/data-skill-scope-name/gu) ?? [];

    expect(markers.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('data-skill-scope-name="" title="Synthetic group"');
    expect(html).toContain('data-skill-scope-name="" title="Synthetic empty project"');
  });

  test('renders nested Project selection and its settled read-only document', () => {
    const html = render(fixture, {
      props: { pathname: '/skills/projects/synthetic-group/project-review' },
    }).body;
    expect(html).toContain('project-review');
    expect(html).toContain('Project skill · read-only');
    expect(html).toContain('# Project synthetic document');
    expect(html).toContain('/skills/projects/synthetic-group/project-review');
  });

  test('exposes the management packet matrix slot without implementing it', () => {
    const html = render(fixture, { props: { pathname: '/skills/matrix' } }).body;
    expect(html).toContain('aria-label="Synthetic matrix slot"');
    expect(html).toContain('Matrix integration');
    expect(html).toContain('Matrix integration · settled');
  });

  test('composes the real editor, health, and matrix slots through one shell context', () => {
    const html = render(convergenceFixture).body;
    expect(html).toContain('data-skills-workspace');
    expect(html).toContain('data-skill-markdown-editor');
    expect(html).toContain('data-skills-management-health-slot');
    expect(html).not.toContain('Synthetic editor slot');
    expect(html).not.toContain('Health integration');

    const matrixHtml = render(convergenceFixture, { props: { pathname: '/skills/matrix' } }).body;
    expect(matrixHtml).toContain('data-skills-management-matrix-slot');
    expect(matrixHtml).not.toContain('Synthetic matrix slot');
  });

  test('hydrates a bounded awaited route into a new provider without duplicate Skills acquisition', async () => {
    const calls = { acquisitions: 0, inventories: 0, knownPaths: 0, managed: 0, snapshot: 0 };
    const snapshot = syntheticSnapshot();
    const capability: SkillsCapability = {
      createTargetDirectory: unavailable,
      previewReconcileAll: unavailable,
      readKnownProjectPaths: () => {
        calls.knownPaths += 1;
        return ok([...syntheticKnownPaths]);
      },
      readMarkdown: () => {
        calls.managed += 1;
        return ok(syntheticManagedDocument);
      },
      readProjectInventories: () => {
        calls.inventories += 1;
        return ok([...syntheticInventories]);
      },
      readProjectMarkdown: () => ok(syntheticProjectDocument),
      readSnapshot: () => {
        calls.snapshot += 1;
        return ok(snapshot);
      },
      reconcileAll: unavailable,
      reconcileSkill: unavailable,
      refreshSnapshot: unavailable,
      saveConfig: unavailable,
      saveMarkdown: unavailable,
      toggleSkill: unavailable,
    };
    const handler = createWebRpcHttpHandler({
      createDependencies: () => {
        calls.acquisitions += 1;
        return Promise.resolve({
          report: unavailableServices<WebRpcRouterDependencies['report']>(),
          session: unavailableServices<WebRpcRouterDependencies['session']>(),
          skills: {
            preflight: () => ({ allowed: true }),
            selectCapability: () => capability,
          },
          sync: unavailableServices<WebRpcRouterDependencies['sync']>(),
        });
      },
    });
    const result = await loadSkillsShellRoute({
      mode: 'e2e',
      options: {
        fetch: trustedHandlerFetch(handler),
        requestOwner: 'p5-hydration-fixture',
        url: new URL('http://127.0.0.1:4178/skills/global/alpha-skill'),
      },
      pathname: '/skills/global/alpha-skill',
    });
    if (result.decision !== 'render') {
      throw new Error('The live Skills hydration fixture must render.');
    }
    const callsAfterRoute = { ...calls };
    const html = render(hydrationFixture, {
      props: { hydrationState: result.queryState },
    }).body;

    expect(html).toContain('data-skills-workspace');
    expect(html).toContain('alpha-skill');
    expect(html).toContain('aria-label="Selected skill detail"');
    expect(html).not.toContain('Loading skills');
    expect(callsAfterRoute).toEqual({ acquisitions: 4, inventories: 1, knownPaths: 1, managed: 1, snapshot: 1 });
    expect(calls).toEqual(callsAfterRoute);
  });
});
