import { expect, test } from 'bun:test';
import { buildTokenFlow } from '@ai-usage/report-core/token-flow-projection';
import { layoutTokenFlow } from './token-flow-layout';

test('both Sankey stages conserve every token and all columns share the same scale', () => {
  const flow = buildTokenFlow(
    [
      { projectKey: 'one', projectLabel: 'One', model: 'A', input: 10, cacheRead: 20, cacheWrite: 5, output: 10 },
      { projectKey: 'two', projectLabel: 'Two', model: 'B', input: 5, cacheRead: 5, cacheWrite: 0, output: 5 },
    ],
    2,
    0,
  );
  const layout = layoutTokenFlow(flow);
  for (const x of [20, 410, 800]) {
    expect(layout.nodes.filter((node) => node.x === x).reduce((sum, node) => sum + node.tokens, 0)).toBe(flow.total);
  }
  for (const node of layout.nodes) {
    expect(node.height / node.tokens).toBeCloseTo(layout.nodes[0]!.height / layout.nodes[0]!.tokens);
    expect(node.y + node.height).toBeLessThan(layout.height);
  }
  expect(layout.ribbons.reduce((sum, ribbon) => sum + ribbon.tokens, 0)).toBe(flow.total * 2);
});
