import { fileURLToPath } from 'node:url';
import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';

/** The campaign page's rune modules and their test fixtures; nothing else is compiled or redirected. */
const RUNE_MODULES =
  /\/campaigns-(?:exploration-state|focus-restoration|navigation-actions|reactivity\.fixture)\.svelte\.ts$/u;
const SVELTE_IMPORT = /from\s*(['"])svelte\1/gu;
const SERVER_ENTRY = /index-server\.js$/u;

let registered = false;

/**
 * Compiles the campaign page's `.svelte.ts` modules for the client, so `$state`, `$effect` and
 * `tick` behave as they do in the browser. Their own `svelte` import is pointed at the client entry;
 * the process-wide `svelte` entry stays the server one, so the other test files of the same
 * `bun test` run are unaffected. Call before importing a rune module; later calls do nothing.
 */
export const compileCampaignRuneModulesForClient = (): void => {
  if (registered) {
    return;
  }
  registered = true;
  // Bun resolves `svelte` to its server entry; the client one owns `flushSync` and `tick` as a browser sees them.
  const svelteServerEntry = fileURLToPath(import.meta.resolve('svelte'));
  if (!SERVER_ENTRY.test(svelteServerEntry)) {
    throw new Error(`Expected the svelte server entry, got ${svelteServerEntry}.`);
  }
  const svelteClientEntry = svelteServerEntry.replace(SERVER_ENTRY, 'index-client.js');
  plugin({
    name: 'campaigns page rune modules (client)',
    setup(build) {
      build.onLoad({ filter: RUNE_MODULES }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const stripped = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
        const { js } = compileModule(stripped, { filename: path, generate: 'client' });
        return {
          contents: js.code.replace(SVELTE_IMPORT, `from ${JSON.stringify(svelteClientEntry)}`),
          loader: 'js',
        };
      });
    },
  });
};
