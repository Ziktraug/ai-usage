import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

interface SvelteServerModule {
  render: (component: Component) => { body: string };
}

const componentFrom = (loaded: unknown, name: string): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error(`${name} did not expose a Svelte component.`);
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render.');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => viteServer.close());

const fixture = async (name: string): Promise<Component> =>
  componentFrom(await viteServer.ssrLoadModule(`/apps/web/src/lib/query/${name}.fixture.svelte`), name);
const { render } = rendererFrom(await viteServer.ssrLoadModule('svelte/server'));
const [Reader, Provider, Required] = await Promise.all([
  fixture('rpc-context-reader'),
  fixture('rpc-context-provider'),
  fixture('rpc-context-required'),
]);

describe('Web Query RPC context', () => {
  test('reads as absent without the root provider instead of throwing', () => {
    expect(render(Reader).body).toContain('data-rpc-context="absent"');
  });

  test('hands the installed context to both readers', () => {
    const { body } = render(Provider);

    expect(body).toContain('data-rpc-context="installed"');
    expect(body).toContain('data-same-context="true"');
  });

  test('refuses a required read outside the root provider', () => {
    expect(() => render(Required).body).toThrow('missing_context');
  });
});
