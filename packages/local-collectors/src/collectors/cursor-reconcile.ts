import { actualCost, tokenTotal } from '@ai-usage/report-core/usage-row';
import type { CollectedSession } from '../collected-session';
import { type CursorCsvCluster, type CursorCsvTurn, clusterFromTurns, clusterTurns } from './cursor-csv';

export interface CursorReconcileOptions {
  clusterGapMs: number;
  maxSessionSpanMs: number;
  reconcileWindowMs: number;
}

const turnDistance = (session: CollectedSession, turn: CursorCsvTurn) => {
  if (!session.date) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(session.date.getTime() - turn.date.getTime());
};

const cursorSessionWindows = (sessions: CollectedSession[], options: CursorReconcileOptions) => {
  const sorted = sessions
    .map((session, index) => ({ session, index }))
    .filter((entry) => entry.session.date)
    .sort((a, b) => (a.session.date?.getTime() ?? 0) - (b.session.date?.getTime() ?? 0));
  return sorted.map((entry, sortedIndex) => {
    const start = entry.session.date?.getTime() ?? 0;
    const nextStart = sorted[sortedIndex + 1]?.session.date?.getTime();
    const maxEnd = start + options.maxSessionSpanMs;
    return {
      ...entry,
      startMs: start - options.reconcileWindowMs,
      endMs: Math.min(nextStart ? nextStart - 1 : maxEnd, maxEnd),
    };
  });
};

const modelList = (cluster: CursorCsvCluster) => (cluster.models.length > 1 ? cluster.models : undefined);

const mergeClusterIntoSession = (
  session: CollectedSession,
  cluster: CursorCsvCluster,
  ambiguous: boolean,
): CollectedSession => {
  const models = modelList(cluster);
  return {
    source: session.source,
    ...(session.projectPath === undefined ? {} : { projectPath: session.projectPath }),
    date: session.date ?? cluster.startDate,
    endDate: cluster.endDate,
    provider: session.provider,
    name: session.name,
    model: cluster.dominantModel,
    ...(models ? { models } : {}),
    project: session.project ?? '',
    tokens: cluster.tokens,
    cost: actualCost(cluster.costActual),
    costQuota: cluster.costQuota,
    costApprox: cluster.costApprox,
    costKnown: cluster.costKnown,
    calls: cluster.calls,
    turns: session.turns || cluster.calls,
    tools: session.tools ?? 0,
    linesAdded: session.linesAdded ?? null,
    linesDeleted: session.linesDeleted ?? null,
    ...(ambiguous ? { ambiguous: true } : {}),
  };
};

const sessionFromCluster = (cluster: CursorCsvCluster): CollectedSession => {
  const models = modelList(cluster);
  return {
    source: { harnessKey: 'cursor', sourceSessionId: null },
    date: cluster.startDate,
    endDate: cluster.endDate,
    provider: 'Cursor sub',
    name: `Cursor export ${cluster.startDate.toISOString()}`,
    model: cluster.dominantModel,
    ...(models ? { models } : {}),
    project: 'Cursor CSV import',
    tokens: cluster.tokens,
    cost: actualCost(cluster.costActual),
    costQuota: cluster.costQuota,
    costApprox: cluster.costApprox,
    costKnown: cluster.costKnown,
    calls: cluster.calls,
    turns: cluster.calls,
    tools: 0,
    linesAdded: null,
    linesDeleted: null,
  };
};

export const reconcileCursorSessions = (
  sessions: CollectedSession[],
  turns: CursorCsvTurn[],
  options: CursorReconcileOptions,
): CollectedSession[] => {
  if (!turns.length) {
    return sessions;
  }
  const windows = cursorSessionWindows(sessions, options);
  const assignments = new Map<number, { turns: CursorCsvTurn[]; ambiguous: boolean }>();
  const orphanTurns: CursorCsvTurn[] = [];

  for (const turn of turns) {
    const candidates = windows
      .filter((window) => {
        const time = turn.date.getTime();
        return time >= window.startMs && time <= window.endMs;
      })
      .map((window) => ({
        session: window.session,
        index: window.index,
        distance: turnDistance(window.session, turn),
      }))
      .sort((a, b) => a.distance - b.distance || tokenTotal(a.session.tokens) - tokenTotal(b.session.tokens));
    const nearbyCandidateCount = sessions.filter(
      (session) => turnDistance(session, turn) <= options.reconcileWindowMs,
    ).length;

    const best = candidates[0];
    if (!best) {
      orphanTurns.push(turn);
      continue;
    }

    const assignment = assignments.get(best.index) ?? { turns: [], ambiguous: false };
    assignment.turns.push(turn);
    assignment.ambiguous = assignment.ambiguous || candidates.length > 1 || nearbyCandidateCount > 1;
    assignments.set(best.index, assignment);
  }

  const reconciledSessions = new Map<number, CollectedSession>();
  for (const [index, assignment] of assignments) {
    const session = sessions[index];
    if (!session) {
      continue;
    }
    reconciledSessions.set(
      index,
      mergeClusterIntoSession(session, clusterFromTurns(assignment.turns), assignment.ambiguous),
    );
  }

  const cursorOutput = sessions.map((session, index) => reconciledSessions.get(index) ?? session);
  const newSessions = clusterTurns(orphanTurns, options.clusterGapMs).map(sessionFromCluster);
  return [...cursorOutput, ...newSessions];
};
