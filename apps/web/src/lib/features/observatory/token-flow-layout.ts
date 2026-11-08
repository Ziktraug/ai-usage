import { flowTokens, type TokenFlow, tokenCategories } from '@ai-usage/report-core/observatory';

export const categoryLabels = {
  input: 'Fresh input',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache written',
  output: 'Output',
} as const;
export interface FlowNode {
  height: number;
  key: string;
  label: string;
  tokens: number;
  x: number;
  y: number;
}
export interface FlowRibbon {
  from: string;
  key: string;
  path: string;
  to: string;
  tokens: number;
}

/** Every column uses the same pixels/token scale; gaps never stand for usage. */
export const layoutTokenFlow = (flow: TokenFlow) => {
  const columns: Map<string, { label: string; tokens: number }>[] = [new Map(), new Map(), new Map()];
  const edges = new Map<string, { from: string; to: string; tokens: number }>();
  const addNode = (column: number, key: string, label: string, tokens: number) => {
    const previous = columns[column]!.get(key);
    columns[column]!.set(key, { label, tokens: (previous?.tokens ?? 0) + tokens });
  };
  const addEdge = (from: string, to: string, tokens: number) => {
    if (tokens === 0) {
      return;
    }
    const key = JSON.stringify([from, to]);
    edges.set(key, { from, to, tokens: (edges.get(key)?.tokens ?? 0) + tokens });
  };
  for (const link of flow.links) {
    const project = JSON.stringify(['project', link.projectKey]);
    const model = JSON.stringify(['model', link.model]);
    const total = flowTokens(link);
    addNode(0, project, link.projectKey === null ? 'Other projects (grouped)' : link.projectLabel, total);
    addNode(1, model, link.model ?? 'Other models (grouped)', total);
    addEdge(project, model, total);
    for (const category of tokenCategories) {
      if (!link[category]) {
        continue;
      }
      addNode(2, category, categoryLabels[category], link[category]);
      addEdge(model, category, link[category]);
    }
  }
  const height = Math.max(360, Math.max(...columns.map((column) => column.size)) * 38);
  const scale = flow.total ? (height - 16 * (Math.max(...columns.map((column) => column.size)) - 1)) / flow.total : 0;
  const nodes: FlowNode[] = [];
  columns.forEach((column, index) => {
    let y = 36;
    for (const [key, value] of [...column].sort(([a, x], [b, z]) => z.tokens - x.tokens || a.localeCompare(b))) {
      const nodeHeight = value.tokens * scale;
      nodes.push({ key, ...value, x: 20 + index * 390, y, height: nodeHeight });
      y += nodeHeight + 16;
    }
  });
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  const ribbons: FlowRibbon[] = [];
  for (const [key, edge] of edges) {
    const from = byKey.get(edge.from)!;
    const to = byKey.get(edge.to)!;
    const x = from.x + 8;
    const right = to.x;
    const y = from.y + (outgoing.get(from.key) ?? 0);
    const nextY = to.y + (incoming.get(to.key) ?? 0);
    const width = edge.tokens * scale;
    outgoing.set(from.key, (outgoing.get(from.key) ?? 0) + width);
    incoming.set(to.key, (incoming.get(to.key) ?? 0) + width);
    const mid = (x + right) / 2;
    ribbons.push({
      key,
      tokens: edge.tokens,
      from: from.label,
      to: to.label,
      path: `M${x},${y} C${mid},${y} ${mid},${nextY} ${right},${nextY} L${right},${nextY + width} C${mid},${nextY + width} ${mid},${y + width} ${x},${y + width} Z`,
    });
  }
  return { nodes, ribbons, height: height + 80 };
};
