import { describe, expect, test } from 'bun:test';
import { resolveSvelteShadowOutputPaths, svelteShadowPhases } from './vite-svelte-shadow-output';

describe('SvelteKit shadow output ownership', () => {
  test('isolates every supported phase', () => {
    const paths = svelteShadowPhases.map((phase) => resolveSvelteShadowOutputPaths(phase));

    expect(new Set(paths.map(({ intermediateDirectory }) => intermediateDirectory)).size).toBe(paths.length);
    expect(new Set(paths.map(({ adapterDirectory }) => adapterDirectory)).size).toBe(paths.length);
    expect(paths).toEqual([
      {
        adapterDirectory: '.output-svelte-shadow/build',
        intermediateDirectory: '.svelte-kit-shadow/build',
        phase: 'build',
        viteCacheDirectory: '.svelte-kit-shadow/build/vite',
      },
      {
        adapterDirectory: '.output-svelte-shadow/check',
        intermediateDirectory: '.svelte-kit-shadow/check',
        phase: 'check',
        viteCacheDirectory: '.svelte-kit-shadow/check/vite',
      },
      {
        adapterDirectory: '.output-svelte-shadow/dev',
        intermediateDirectory: '.svelte-kit-shadow/dev',
        phase: 'dev',
        viteCacheDirectory: '.svelte-kit-shadow/dev/vite',
      },
    ]);
  });

  test('fails closed for an unknown or empty phase', () => {
    expect(() => resolveSvelteShadowOutputPaths('preview')).toThrow('Invalid SvelteKit shadow phase: preview');
    expect(() => resolveSvelteShadowOutputPaths('')).toThrow('Invalid SvelteKit shadow phase:');
  });
});
