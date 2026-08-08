import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProbe } from './plan072-keyset-a1';

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = undefined;
  }
});

const readProbeVersion = (value: unknown): number => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tool' in value) ||
    value.tool !== 'plan072-keyset-a1' ||
    !('version' in value) ||
    typeof value.version !== 'number'
  ) {
    throw new Error('Expected a Plan 072 keyset probe output');
  }
  return value.version;
};

describe('plan072 keyset A1', () => {
  test('profiles real 5k/20k SQLite traversals and exact revision cache transitions', async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'plan072-keyset-test-'));
    const outputPath = path.join(temporaryDirectory, 'output.json');
    const output = await runProbe(outputPath);

    expect(output.configuration.fixtureSizes).toEqual([5000, 20_000]);
    expect(output.scenarios).toHaveLength(12);
    expect(output.scenarios.every((scenario) => scenario.samples.length === 3)).toBe(true);
    expect(output.scenarios.every((scenario) => scenario.median.duplicateIdentityCount === 0)).toBe(true);
    expect(output.scenarios.every((scenario) => scenario.median.sqlite.counters.identityChecks > 0)).toBe(true);
    expect(output.revisionTransition.firstRevisionProjectionMisses).toBeGreaterThan(0);
    expect(output.revisionTransition.secondRevisionProjectionMisses).toBeGreaterThan(0);
    expect(output.revisionTransition.identitiesOverlap).toBe(0);

    const persisted: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(readProbeVersion(persisted)).toBe(2);
  }, 120_000);
});
