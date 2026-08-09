import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A Svelte template binding that reuses the name of a style constant silently
 * wins: `class={handle}` then emits the loop's `'start'` string instead of the
 * generated Panda class, the element loses every declared rule, and nothing
 * fails. Biome cannot see it — its Svelte support lints `<script>` blocks, not
 * template bindings — so the graph is checked here instead.
 */

const ignoredDirectories = new Set([
  '.direnv',
  '.git',
  '.output-build',
  '.output-dev',
  '.svelte-kit',
  '.turbo',
  '.worktrees',
  'dist',
  'node_modules',
  'styled-system',
]);
const STYLE_CONSTANT = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:css|cx|cva|sva)\(/gm;
const EACH_BINDING = /\{#each\s+[^}]*?\s+as\s+([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?/g;
const SNIPPET_PARAMETERS = /\{#snippet\s+[A-Za-z_$][\w$]*\(([^)]*)\)/g;
const PARAMETER_NAME = /^[A-Za-z_$][\w$]*/;

export interface StyleShadowing {
  binding: string;
  file: string;
  kind: 'each' | 'snippet';
}

export const styleShadowingIn = (source: string): StyleShadowing[] => {
  const styleNames = new Set([...source.matchAll(STYLE_CONSTANT)].map(([, name]) => name as string));
  if (styleNames.size === 0) {
    return [];
  }
  const found: StyleShadowing[] = [];
  for (const match of source.matchAll(EACH_BINDING)) {
    for (const binding of [match[1], match[2]]) {
      if (binding && styleNames.has(binding)) {
        found.push({ binding, file: '', kind: 'each' });
      }
    }
  }
  for (const match of source.matchAll(SNIPPET_PARAMETERS)) {
    for (const parameter of (match[1] ?? '').split(',')) {
      const binding = PARAMETER_NAME.exec(parameter.trim())?.[0];
      if (binding && styleNames.has(binding)) {
        found.push({ binding, file: '', kind: 'snippet' });
      }
    }
  }
  return found;
};

export const collectStyleShadowing = async (directory: string, root: string): Promise<StyleShadowing[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: StyleShadowing[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        found.push(...(await collectStyleShadowing(path.join(directory, entry.name), root)));
      }
      continue;
    }
    if (!(entry.isFile() && entry.name.endsWith('.svelte'))) {
      continue;
    }
    const file = path.join(directory, entry.name);
    const source = await readFile(file, 'utf8');
    found.push(...styleShadowingIn(source).map((shadowing) => ({ ...shadowing, file: path.relative(root, file) })));
  }
  return found;
};

if (import.meta.main) {
  const root = process.cwd();
  const shadowing = await collectStyleShadowing(root, root);
  if (shadowing.length > 0) {
    console.error(
      'A Svelte template binding shadows a style constant. Rename the binding or the constant; the class attribute would otherwise resolve to the bound value.',
    );
    for (const entry of shadowing) {
      console.error(`${entry.file} ${entry.kind} binding "${entry.binding}"`);
    }
    process.exitCode = 1;
  }
}
