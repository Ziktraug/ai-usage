import { expect, test } from 'bun:test';
import type { Constellation } from '@ai-usage/report-core/constellation';
import { constellationPositions, projectConstellation } from './constellation-layout';

const map: Constellation = {
  totalSessions: 2,
  unresolvedParents: 0,
  nodes: [
    {
      id: 'one',
      parentId: null,
      projectKey: 'a',
      projectLabel: 'A',
      title: 'One',
      harness: 'Codex',
      tokens: 100,
      partial: false,
    },
    {
      id: 'two',
      parentId: 'one',
      projectKey: 'b',
      projectLabel: 'B',
      title: 'Two',
      harness: 'Codex',
      tokens: 25,
      partial: false,
    },
  ],
};
test('projection changes real depth and rotation while preserving identities and lineage', () => {
  const points = constellationPositions(map);
  const flat = projectConstellation(points, '2d', 0, 0, 1);
  expect(projectConstellation(points, '2d', 1, 1, 1)).toEqual(flat);
  const spatial = projectConstellation(points, '3d', 0, 0, 1);
  const rotated = projectConstellation(points, '3d', Math.PI / 2, 0, 1);
  expect(rotated).not.toEqual(spatial);
  expect(rotated.map((point) => point.node).sort((a, b) => a.id.localeCompare(b.id))).toEqual(map.nodes);
  expect(points[0]!.radius).toBeGreaterThan(points[1]!.radius);
  for (const point of rotated) {
    expect([point.x, point.y, point.z, point.radius].every(Number.isFinite)).toBe(true);
  }
});
