import { expect, test } from 'bun:test';
import { svelteKitRuntimeDecision } from './sveltekit-runtime-decision';

const semanticVersionPattern = /^\d+\.\d+\.\d+$/;

test('pins the fully proven Bun runtime ecosystem', () => {
  expect(svelteKitRuntimeDecision.adapter).toEqual({
    package: 'svelte-adapter-bun',
    version: '1.0.1',
  });
  expect(svelteKitRuntimeDecision.configuration.host).toBe('127.0.0.1');
  expect(svelteKitRuntimeDecision.configuration.idleTimeoutSeconds).toBeGreaterThan(30);
  expect(svelteKitRuntimeDecision.configuration.launchFlags).toEqual(['--no-env-file', '--no-install']);
  expect(Object.values(svelteKitRuntimeDecision.pins).every((version) => semanticVersionPattern.test(version))).toBe(
    true,
  );
  expect(svelteKitRuntimeDecision.rejectedAdapter.reasons).toHaveLength(2);
});
