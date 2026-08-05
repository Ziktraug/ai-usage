import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type DesignExport, unconsumedDesignExports } from './check-design-export-consumers';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const baselinePath = path.join(repositoryRoot, 'tools/fixtures/design-export-debt.json');

const keyOf = ({ module, name }: DesignExport): string => `${module}::${name}`;

test('the recorded debt still matches the measured graph and never grows', async () => {
  const baseline: DesignExport[] = JSON.parse(await readFile(baselinePath, 'utf8'));
  const current = await unconsumedDesignExports(repositoryRoot);
  const recorded = new Set(baseline.map(keyOf));

  // Losing a consumer is how the Activity chart's semantic layer went dark
  // without a single failing test. Regaining one is always welcome.
  expect(current.filter((entry) => !recorded.has(keyOf(entry))).map(keyOf)).toEqual([]);
  expect(current.length).toBeLessThanOrEqual(baseline.length);
});

test('a consumed export is not reported as debt', async () => {
  const current = new Set((await unconsumedDesignExports(repositoryRoot)).map(keyOf));

  for (const consumed of [
    'time-slider::timeSliderThumb',
    'time-slider::timeSliderBrushTrack',
    'time-slider::monthGridline',
    'chart::dimensionSwatch',
    'chart::accentFill',
    'panel::panel',
  ]) {
    expect(current.has(consumed), consumed).toBe(false);
  }
});

test('the recorded debt is sorted by module then name, and free of duplicates', async () => {
  const baseline: DesignExport[] = JSON.parse(await readFile(baselinePath, 'utf8'));
  const keys = baseline.map(keyOf);

  expect(new Set(keys).size).toBe(keys.length);
  expect(baseline).toEqual(
    [...baseline].sort((left, right) => left.module.localeCompare(right.module) || left.name.localeCompare(right.name)),
  );
});
