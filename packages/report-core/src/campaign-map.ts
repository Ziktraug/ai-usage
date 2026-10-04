import {
  compareSessionIdentityValues,
  type SessionPresentationRow,
  sessionCampaignIdentityForRow,
} from './session-query';

export type CampaignMapLineageIssue = 'ambiguous-parent' | 'cycle' | 'parent-unavailable' | 'parent-undeclared';
export type CampaignMapTimingStatus = 'invalid' | 'missing-end' | 'missing-start' | 'recorded' | 'unavailable';

export interface CampaignMapNode {
  depth: number;
  endedAt: string | null;
  endMs: number | null;
  lineageIssue: CampaignMapLineageIssue | null;
  parentRowId: string | null;
  relationship: 'child' | 'review' | 'root' | 'unresolved';
  row: SessionPresentationRow;
  startedAt: string | null;
  startMs: number | null;
  timingStatus: CampaignMapTimingStatus;
  title: string;
  titleInherited: boolean;
}

export interface CampaignMap {
  campaignKey: string;
  endedAt: string | null;
  endMs: number | null;
  harnesses: string[];
  loadedCount: number;
  /** Peak overlap of observed session spans, including idle gaps; not active agent compute. */
  maxConcurrency: number | null;
  models: string[];
  nodes: CampaignMapNode[];
  /** Lower bound from loaded members with a recorded, nonzero interval. */
  observedMaxConcurrency: number;
  /** Span of all known timestamp anchors; incomplete members can widen this lower bound. */
  observedSpanMs: number | null;
  omittedCount: number;
  rootRowId: string;
  startedAt: string | null;
  startMs: number | null;
  timingComplete: boolean;
  title: string;
  /** Usage from the loaded canonical rows, never from an aggregate display row. */
  tokenTotal: number;
  totalCount: number;
  usageComplete: boolean;
  /** Exact observed envelope only when every campaign member has a recorded interval. */
  wallClockDurationMs: number | null;
}

export interface CampaignMapInput {
  campaignKey: string;
  children: readonly SessionPresentationRow[];
  /** The canonical root returned by campaignChildren, not the Sessions aggregate. */
  root: SessionPresentationRow;
  /** Full member count, including the root, before pagination. */
  totalCount: number;
}

export class CampaignMapValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignMapValidationError';
  }
}

const TITLE_LIMIT = 120;
const WHITESPACE = /\s+/g;
const GENERIC_SESSION_LABEL = /^(?:codex|claude|cursor|opencode|subagent|agent|session)(?:\s+[a-f\d-]{6,})?$/i;

const compactTitle = (value: string): string => {
  const title = value.replace(WHITESPACE, ' ').trim();
  return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
};

const genericTitle = (row: SessionPresentationRow): boolean => {
  const title = compactTitle(row.sessionLabel);
  return (
    !title || row.titleSource === 'id' || title === row.source?.sourceSessionId || GENERIC_SESSION_LABEL.test(title)
  );
};

/** Uses only the already-published label; no prompt or local-history lookup. */
export const campaignMapTitle = (row: SessionPresentationRow): string => {
  if (!genericTitle(row)) {
    return compactTitle(row.sessionLabel);
  }
  const project = row.project.trim();
  const role = row.origin === 'classifier' ? 'review' : 'session';
  return compactTitle(`${project ? `${project} · ` : ''}${row.harness} ${role}`);
};

const timestamp = (value: string | null): number | null => {
  const result = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(result) ? result : null;
};

const timingForRow = (row: SessionPresentationRow) => {
  const startMs = timestamp(row.date);
  const endMs = timestamp(row.endDate);
  let timingStatus: CampaignMapTimingStatus = 'recorded';
  if ((row.date !== null && startMs === null) || (row.endDate !== null && endMs === null)) {
    timingStatus = 'invalid';
  } else if (startMs === null) {
    timingStatus = endMs === null ? 'unavailable' : 'missing-start';
  } else if (endMs === null) {
    timingStatus = 'missing-end';
  } else if (endMs < startMs) {
    timingStatus = 'invalid';
  }
  return {
    endMs: timingStatus === 'invalid' ? null : endMs,
    endedAt: timingStatus === 'invalid' ? null : row.endDate,
    startMs: timingStatus === 'invalid' ? null : startMs,
    startedAt: timingStatus === 'invalid' ? null : row.date,
    timingStatus,
  };
};

const sourceIdentity = (row: SessionPresentationRow, sourceSessionId: string): string =>
  JSON.stringify([row.source?.machineId ?? 'local', row.source?.harnessKey ?? row.harness, sourceSessionId]);

const parentIndexForRows = (rows: readonly SessionPresentationRow[]): Map<string, string | null> => {
  const index = new Map<string, string | null>();
  for (const row of rows) {
    const sourceSessionId = row.source?.sourceSessionId;
    if (sourceSessionId) {
      const key = sourceIdentity(row, sourceSessionId);
      index.set(key, index.has(key) ? null : row.rowId);
    }
  }
  return index;
};

const resolveParent = (
  node: CampaignMapNode,
  root: SessionPresentationRow,
  index: ReadonlyMap<string, string | null>,
): void => {
  const parentId = node.row.source?.parentSourceSessionId;
  if (node.row.rowId === root.rowId) {
    // An observed root can itself declare an unavailable parent (e.g. a Claude sidechain).
    if (parentId && parentId !== node.row.source?.sourceSessionId) {
      node.lineageIssue = 'parent-unavailable';
    } else if (node.row.origin === 'subagent') {
      node.lineageIssue = 'parent-undeclared';
    }
    return;
  }
  if (!parentId) {
    if (node.row.origin === 'classifier') {
      node.parentRowId = root.rowId;
      node.relationship = 'review';
    } else {
      node.lineageIssue = 'parent-undeclared';
    }
    return;
  }
  const parentRowId = index.get(sourceIdentity(node.row, parentId));
  if (parentRowId == null) {
    node.lineageIssue = parentRowId === null ? 'ambiguous-parent' : 'parent-unavailable';
    return;
  }
  node.parentRowId = parentRowId;
  node.relationship = node.row.origin === 'classifier' ? 'review' : 'child';
};

/** Each edge is visited once; malformed chains never recurse or loop. */
const detachCycles = (nodes: readonly CampaignMapNode[]): void => {
  const byId = new Map(nodes.map((node) => [node.row.rowId, node]));
  const visited = new Set<string>();
  for (const node of nodes) {
    const path = new Map<string, CampaignMapNode>();
    let current: CampaignMapNode | undefined = node;
    while (current && !visited.has(current.row.rowId)) {
      const id = current.row.rowId;
      if (path.has(id)) {
        let inCycle = false;
        for (const [pathId, member] of path) {
          inCycle ||= pathId === id;
          if (inCycle) {
            member.parentRowId = null;
            member.relationship = 'unresolved';
            member.lineageIssue = 'cycle';
          }
        }
        break;
      }
      path.set(id, current);
      current = current.parentRowId ? byId.get(current.parentRowId) : undefined;
    }
    for (const id of path.keys()) {
      visited.add(id);
    }
  }
};

const compareNodes = (left: CampaignMapNode, right: CampaignMapNode): number => {
  const leftTime = left.startMs ?? left.endMs ?? Number.POSITIVE_INFINITY;
  const rightTime = right.startMs ?? right.endMs ?? Number.POSITIVE_INFINITY;
  return (
    (leftTime === rightTime ? 0 : leftTime - rightTime) || compareSessionIdentityValues(left.row.rowId, right.row.rowId)
  );
};

const inheritTitle = (node: CampaignMapNode, context: string): void => {
  if (!(genericTitle(node.row) || node.row.titleSource === 'agent-role')) {
    return;
  }
  let role = 'Session';
  if (node.row.origin === 'classifier') {
    role = 'Automated review';
  } else if (node.row.origin === 'subagent') {
    role = 'Delegated session';
  }
  if (!genericTitle(node.row)) {
    role = compactTitle(node.row.sessionLabel);
  }
  node.title = compactTitle(`${role} · ${context}`);
  node.titleInherited = true;
};

const orderedHierarchy = (nodes: CampaignMapNode[], rootRowId: string, title: string): CampaignMapNode[] => {
  const children = new Map<string | null, CampaignMapNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentRowId) ?? [];
    siblings.push(node);
    children.set(node.parentRowId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(compareNodes);
  }
  const roots = children.get(null) ?? [];
  roots.sort((left, right) => {
    if (left.row.rowId === rootRowId) {
      return -1;
    }
    return right.row.rowId === rootRowId ? 1 : compareNodes(left, right);
  });
  const pending = roots.toReversed().map((node) => ({ context: title, depth: 0, node }));
  const ordered: CampaignMapNode[] = [];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const { node, depth, context } = entry;
    node.depth = depth;
    if (node.row.rowId !== rootRowId) {
      inheritTitle(node, context);
    }
    ordered.push(node);
    const nextContext = node.titleInherited ? context : node.title;
    const descendants = children.get(node.row.rowId) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      pending.push({ context: nextContext, depth: depth + 1, node: descendants[index]! });
    }
  }
  return ordered;
};

const observedConcurrency = (nodes: readonly CampaignMapNode[]): number => {
  const edges: { at: number; change: number }[] = [];
  for (const node of nodes) {
    if (node.startMs !== null && node.endMs !== null && node.endMs > node.startMs) {
      edges.push({ at: node.startMs, change: 1 }, { at: node.endMs, change: -1 });
    }
  }
  // Half-open intervals: a session ending when another starts is not an overlap.
  edges.sort((left, right) => left.at - right.at || left.change - right.change);
  let active = 0;
  let peak = 0;
  for (const edge of edges) {
    active += edge.change;
    peak = Math.max(peak, active);
  }
  return peak;
};

/**
 * Projects members of one canonical served campaign. Pagination stays upstream;
 * omitted parents remain explicit and partial metrics never become exact totals.
 * The model retains only existing published rows and does not alter their facts.
 */
export const buildCampaignMap = (input: CampaignMapInput): CampaignMap => {
  const rows = [input.root, ...input.children];
  if (!Number.isSafeInteger(input.totalCount) || input.totalCount < rows.length) {
    throw new CampaignMapValidationError('Campaign totalCount must include all loaded members');
  }
  const ids = new Set<string>();
  for (const row of rows) {
    if (sessionCampaignIdentityForRow(row).campaignKey !== input.campaignKey) {
      throw new CampaignMapValidationError('Campaign member belongs to a different canonical campaign');
    }
    if (ids.has(row.rowId)) {
      throw new CampaignMapValidationError('Campaign contains a duplicate session row');
    }
    ids.add(row.rowId);
  }
  const title = campaignMapTitle(input.root);
  const nodes: CampaignMapNode[] = rows.map((row) => ({
    ...timingForRow(row),
    depth: 0,
    lineageIssue: null,
    parentRowId: null,
    relationship: row === input.root ? 'root' : 'unresolved',
    row,
    title: campaignMapTitle(row),
    titleInherited: false,
  }));
  const index = parentIndexForRows(rows);
  for (const node of nodes) {
    resolveParent(node, input.root, index);
  }
  detachCycles(nodes);
  let startMs: number | null = null;
  let endMs: number | null = null;
  let earliestAnchor: number | null = null;
  let latestAnchor: number | null = null;
  let anchorCount = 0;
  for (const node of nodes) {
    if (node.startMs !== null) {
      startMs = startMs === null ? node.startMs : Math.min(startMs, node.startMs);
    }
    if (node.endMs !== null) {
      endMs = endMs === null ? node.endMs : Math.max(endMs, node.endMs);
    }
    for (const anchor of [node.startMs, node.endMs]) {
      if (anchor !== null) {
        earliestAnchor = earliestAnchor === null ? anchor : Math.min(earliestAnchor, anchor);
        latestAnchor = latestAnchor === null ? anchor : Math.max(latestAnchor, anchor);
        anchorCount += 1;
      }
    }
  }
  const omittedCount = input.totalCount - rows.length;
  const timingComplete = omittedCount === 0 && nodes.every((node) => node.timingStatus === 'recorded');
  const observedMaxConcurrency = observedConcurrency(nodes);
  return {
    campaignKey: input.campaignKey,
    endMs,
    endedAt: endMs === null ? null : new Date(endMs).toISOString(),
    harnesses: [...new Set(rows.map((row) => row.harness))].sort(),
    loadedCount: rows.length,
    maxConcurrency: timingComplete ? observedMaxConcurrency : null,
    models: [
      ...new Set(
        rows
          .flatMap((row) => [
            row.model,
            ...(row.models ?? []),
            ...(row.modelSegments?.map((segment) => segment.model) ?? []),
          ])
          .filter(Boolean),
      ),
    ].sort(),
    nodes: orderedHierarchy(nodes, input.root.rowId, title),
    observedMaxConcurrency,
    observedSpanMs:
      anchorCount < 2 || earliestAnchor === null || latestAnchor === null ? null : latestAnchor - earliestAnchor,
    omittedCount,
    rootRowId: input.root.rowId,
    startMs,
    startedAt: startMs === null ? null : new Date(startMs).toISOString(),
    timingComplete,
    title,
    tokenTotal: rows.reduce((sum, row) => sum + row.tokenTotal, 0),
    totalCount: input.totalCount,
    usageComplete: omittedCount === 0 && rows.every((row) => !(row.partial || row.usageUnavailable)),
    wallClockDurationMs: !timingComplete || startMs === null || endMs === null ? null : endMs - startMs,
  };
};
