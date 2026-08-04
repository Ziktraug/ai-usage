import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveSvelteKitOutputPaths, resolveSvelteKitVersionName, svelteKitPhases } from './sveltekit-output-paths';

describe('SvelteKit output ownership', () => {
  test('isolates every supported phase', () => {
    const paths = svelteKitPhases.map((phase) => resolveSvelteKitOutputPaths(phase));

    expect(new Set(paths.map(({ intermediateDirectory }) => intermediateDirectory)).size).toBe(paths.length);
    expect(new Set(paths.map(({ adapterDirectory }) => adapterDirectory)).size).toBe(paths.length);
    expect(paths).toEqual([
      {
        adapterDirectory: '.output-build/sveltekit',
        intermediateDirectory: '.svelte-kit/build',
        phase: 'build',
        viteCacheDirectory: '.svelte-kit/build/vite',
      },
      {
        adapterDirectory: '.svelte-kit/check/adapter-bun',
        intermediateDirectory: '.svelte-kit/check',
        phase: 'check',
        viteCacheDirectory: '.svelte-kit/check/vite',
      },
      {
        adapterDirectory: '.svelte-kit/dev/adapter-bun',
        intermediateDirectory: '.svelte-kit/dev',
        phase: 'dev',
        viteCacheDirectory: '.svelte-kit/dev/vite',
      },
    ]);
  });

  test('fails closed for an unknown or empty phase', () => {
    expect(() => resolveSvelteKitOutputPaths('preview')).toThrow('Invalid SvelteKit phase: preview');
    expect(() => resolveSvelteKitOutputPaths('')).toThrow('Invalid SvelteKit phase:');
  });

  test('pins emitted asset identity to the complete source revision', () => {
    const repositoryDirectory = path.resolve(import.meta.dirname, '../..');
    const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repositoryDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    expect(resolveSvelteKitVersionName(repositoryDirectory)).toBe(revision);
    expect(revision).toHaveLength(40);
    expect([...revision].every((character) => '0123456789abcdef'.includes(character))).toBe(true);
  });
});
