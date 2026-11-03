import {
  type Constellation,
  type ConstellationNode,
  MAX_CONSTELLATION_SESSIONS,
  parseConstellation,
} from './constellation';
import type { SessionPresentationRow } from './session-query';

const identity = (row: SessionPresentationRow, nativeId: string): string =>
  JSON.stringify([row.source?.machineId ?? 'local', row.source?.harnessKey ?? row.harness, nativeId]);

/** Only the displayed canonical rows participate in edges; proximity never supplies a parent. */
export const buildConstellation = (rows: readonly SessionPresentationRow[], totalSessions: number): Constellation => {
  const selected = [...rows]
    .sort((a, b) => b.tokenTotal - a.tokenTotal || a.rowId.localeCompare(b.rowId))
    .slice(0, MAX_CONSTELLATION_SESSIONS);
  const identities = new Map<string, string | null>();
  for (const row of selected) {
    const nativeId = row.source?.sourceSessionId;
    if (nativeId) {
      const key = identity(row, nativeId);
      identities.set(key, identities.has(key) ? null : row.rowId);
    }
  }
  let unresolvedParents = 0;
  const nodes = selected.map((row): ConstellationNode => {
    const parent = row.source?.parentSourceSessionId;
    const parentId = parent ? (identities.get(identity(row, parent)) ?? null) : null;
    if (parent && !parentId) {
      unresolvedParents += 1;
    }
    return {
      id: row.rowId,
      parentId,
      projectKey: row.projectKey,
      projectLabel: row.projectLabel.slice(0, 240),
      title: (row.name || row.sessionLabel).slice(0, 120),
      harness: row.harness,
      tokens: row.tokenTotal,
      partial: Boolean(row.partial || row.usageUnavailable),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const cyclic = new Set<string>();
  for (const node of nodes) {
    const path = new Set<string>();
    let current: ConstellationNode | undefined = node;
    while (current) {
      if (path.has(current.id)) {
        for (const id of path) {
          cyclic.add(id);
        }
        break;
      }
      path.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  for (const node of nodes) {
    if (cyclic.has(node.id) && node.parentId) {
      node.parentId = null;
      unresolvedParents += 1;
    }
  }
  return parseConstellation({ nodes, totalSessions, unresolvedParents });
};
