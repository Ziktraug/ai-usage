import { expect, test } from 'bun:test';
import path from 'node:path';
import { type DesignExport, unconsumedDesignExports } from './check-design-export-consumers';

const repositoryRoot = path.resolve(import.meta.dir, '..');
const keyOf = ({ module, name }: DesignExport): string => `${module}::${name}`;

test('the repository has no unconsumed design exports', async () => {
  const current = await unconsumedDesignExports(repositoryRoot);

  expect(current.map(keyOf)).toEqual([]);
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
