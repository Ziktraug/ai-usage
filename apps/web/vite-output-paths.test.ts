import { describe, expect, test } from 'bun:test';
import { resolveViteRuntimePaths } from './vite-output-paths';

describe('Vite runtime output paths', () => {
  test('keeps development output separate from production build and preview output', () => {
    expect(resolveViteRuntimePaths({ command: 'serve', isPreview: false })).toEqual({
      nitroBuildDirectory: '.output-dev/work',
      nitroOutputDirectory: '.output-dev/nitro',
      viteCacheDirectory: '.output-dev/vite',
    });
    expect(resolveViteRuntimePaths({ command: 'build', isPreview: false })).toEqual({
      nitroBuildDirectory: '.output-build/work',
      nitroOutputDirectory: '.output-build/nitro',
      viteCacheDirectory: '.output-build/vite',
    });
    expect(resolveViteRuntimePaths({ command: 'serve', isPreview: true })).toEqual({
      nitroBuildDirectory: '.output-build/work',
      nitroOutputDirectory: '.output-build/nitro',
      viteCacheDirectory: '.output-build/vite',
    });
  });
});
