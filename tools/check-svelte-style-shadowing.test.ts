import { expect, test } from 'bun:test';
import path from 'node:path';
import { collectStyleShadowing, styleShadowingIn } from './check-svelte-style-shadowing';

const repositoryRoot = path.resolve(import.meta.dir, '..');

test('reports an each binding that shadows a style constant', () => {
  const source = `<script lang="ts" module>
  const handle = css({ position: 'absolute' });
</script>

{#each edges as handle (handle)}
  <span class={handle}></span>
{/each}
`;

  expect(styleShadowingIn(source)).toEqual([{ binding: 'handle', file: '', kind: 'each' }]);
});

test('reports an index binding and a snippet parameter that shadow style constants', () => {
  const source = `<script lang="ts" module>
  const row = css({ display: 'flex' });
  const cell = cx(css({ p: '2px' }));
</script>

{#each items as item, row}
  <span class={row}></span>
{/each}
{#snippet body(cell, extra)}
  <span class={cell}></span>
{/snippet}
`;

  expect(styleShadowingIn(source)).toEqual([
    { binding: 'row', file: '', kind: 'each' },
    { binding: 'cell', file: '', kind: 'snippet' },
  ]);
});

test('accepts a binding whose name differs from every style constant', () => {
  const source = `<script lang="ts" module>
  const handleThumb = css({ position: 'absolute' });
</script>

{#each edges as edge (edge)}
  <span class={handleThumb} data-edge={edge}></span>
{/each}
`;

  expect(styleShadowingIn(source)).toEqual([]);
});

test('ignores a file that declares no style constant', () => {
  expect(styleShadowingIn('{#each rows as css}<span>{css}</span>{/each}')).toEqual([]);
});

test('the repository has no Svelte template binding shadowing a style constant', async () => {
  expect(await collectStyleShadowing(repositoryRoot, repositoryRoot)).toEqual([]);
});
