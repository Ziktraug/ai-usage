import type { Constellation, ConstellationNode } from '@ai-usage/report-core/constellation';

interface Point3D {
  x: number;
  y: number;
  z: number;
}
export interface ConstellationPoint extends Point3D {
  node: ConstellationNode;
  radius: number;
}
const fraction = (text: string, seed: number): number => {
  let hash = seed;
  for (const character of text) {
    hash = (hash * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }
  return hash / 2_147_483_647;
};
export const constellationPositions = (map: Constellation): ConstellationPoint[] => {
  const projects = [...new Set(map.nodes.map((node) => node.projectKey))].sort();
  const maximum = Math.max(1, ...map.nodes.map((node) => node.tokens));
  return map.nodes.map((node) => {
    const index = projects.indexOf(node.projectKey);
    const angle = (index / Math.max(projects.length, 1)) * Math.PI * 2;
    const orbit = projects.length === 1 ? 0 : 150;
    const localAngle = fraction(node.id, 2_166_136_261) * Math.PI * 2;
    const localRadius = 18 + Math.sqrt(fraction(node.id, 98_771)) * 75;
    return {
      node,
      x: Math.cos(angle) * orbit + Math.cos(localAngle) * localRadius,
      y: Math.sin(angle) * orbit * 0.7 + Math.sin(localAngle) * localRadius,
      z: (fraction(node.projectKey, 12_391) - 0.5) * 120 + (fraction(node.id, 17_221) - 0.5) * 100,
      radius: 3 + 13 * Math.sqrt(node.tokens / maximum),
    };
  });
};
export const projectConstellation = (
  points: readonly ConstellationPoint[],
  mode: '2d' | '3d',
  yaw: number,
  pitch: number,
  zoom: number,
) =>
  points
    .map((point) => {
      const x = mode === '3d' ? point.x * Math.cos(yaw) - point.z * Math.sin(yaw) : point.x;
      const depth = mode === '3d' ? point.x * Math.sin(yaw) + point.z * Math.cos(yaw) : 0;
      const y = mode === '3d' ? point.y * Math.cos(pitch) - depth * Math.sin(pitch) : point.y;
      const z = mode === '3d' ? point.y * Math.sin(pitch) + depth * Math.cos(pitch) : 0;
      const perspective = mode === '3d' ? 700 / (700 + z) : 1;
      return {
        ...point,
        x: 400 + x * perspective * zoom,
        y: 250 + y * perspective * zoom,
        z,
        radius: point.radius * perspective * zoom,
      };
    })
    .sort((a, b) => b.z - a.z || a.node.id.localeCompare(b.node.id));
