export const MAX_CONSTELLATION_SESSIONS = 900;
export interface ConstellationNode {
  harness: string;
  id: string;
  parentId: string | null;
  partial: boolean;
  projectKey: string;
  projectLabel: string;
  title: string;
  tokens: number;
}
export interface Constellation {
  nodes: ConstellationNode[];
  totalSessions: number;
  unresolvedParents: number;
}

export const parseConstellation = (value: unknown): Constellation => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid constellation');
  }
  const map = value as Record<string, unknown>;
  if (
    Object.keys(map).sort().join() !== 'nodes,totalSessions,unresolvedParents' ||
    !Array.isArray(map.nodes) ||
    map.nodes.length > MAX_CONSTELLATION_SESSIONS
  ) {
    throw new Error('Invalid constellation bounds');
  }
  for (const key of ['totalSessions', 'unresolvedParents']) {
    if (typeof map[key] !== 'number' || !Number.isSafeInteger(map[key]) || map[key] < 0) {
      throw new Error('Invalid constellation counts');
    }
  }
  if (Number(map.totalSessions) < map.nodes.length || Number(map.unresolvedParents) > map.nodes.length) {
    throw new Error('Invalid constellation coverage');
  }
  const ids = new Set<string>();
  for (const raw of map.nodes) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Invalid constellation node');
    }
    const node = raw as Record<string, unknown>;
    if (Object.keys(node).sort().join() !== 'harness,id,parentId,partial,projectKey,projectLabel,title,tokens') {
      throw new Error('Invalid constellation fields');
    }
    for (const key of ['id', 'projectKey', 'projectLabel', 'title', 'harness']) {
      if (typeof node[key] !== 'string' || node[key].length > 2048) {
        throw new Error('Invalid constellation label');
      }
    }
    if (node.parentId !== null && typeof node.parentId !== 'string') {
      throw new Error('Invalid constellation parent');
    }
    if (
      typeof node.partial !== 'boolean' ||
      typeof node.tokens !== 'number' ||
      !Number.isSafeInteger(node.tokens) ||
      node.tokens < 0
    ) {
      throw new Error('Invalid constellation usage');
    }
    const id = String(node.id);
    if (!id || ids.has(id)) {
      throw new Error('Duplicate constellation identity');
    }
    ids.add(id);
  }
  for (const raw of map.nodes) {
    if (raw.parentId !== null && (!ids.has(raw.parentId) || raw.parentId === raw.id)) {
      throw new Error('Invalid constellation edge');
    }
  }
  return value as Constellation;
};
