import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type {
  CodexWorkQuestion,
  CodexWorkRequest,
  StoredCodexWorkObservation,
} from '@ai-usage/report-core/codex-work-observation';
import { type ClaudeDesktopTurnDeclaration, WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { sessionLinkKey } from '@ai-usage/report-core/work-thread';
import type { WorkThreadNativeRequest } from '@ai-usage/report-core/work-thread-view';
import {
  queryClaudeDesktopCollectionState,
  queryClaudeDesktopTurnDeclarations,
  queryCodexWorkObservations,
  type UsageStoreError,
  type WorkThreadSessionEvidence,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

type Session = WorkThreadSessionEvidence['sessions'][number];
export interface WorkThreadNativeSessionRequests {
  readonly observedAt: CanonicalInstant | null;
  readonly partial: boolean;
  readonly requests: readonly WorkThreadNativeRequest[];
}
export type WorkThreadNativeRequestsRead = ReadonlyMap<string, WorkThreadNativeSessionRequests>;
const keyOf = (session: Session): string =>
  sessionLinkKey({
    machineId: session.member.machineId,
    harness: session.harness,
    sessionId: session.member.sourceSessionId,
  });
type RequestStanding = Pick<WorkThreadNativeRequest, 'state' | 'detail'>;
const codexStanding = (request: CodexWorkRequest, question: CodexWorkQuestion): RequestStanding => {
  if (request.rejectedAt !== null) {
    return { state: 'withdrawn', detail: 'The native tool rejected this request; presentation is not established.' };
  }
  if (question.answeredAt !== null) {
    return { state: 'answered', detail: 'The native answer identifies this call and question.' };
  }
  return {
    state: 'open',
    detail:
      request.acknowledgedAt === null
        ? 'Invocation observed; presentation is not confirmed. No attributable answer is recorded.'
        : 'The tool accepted this request. No attributable answer is recorded.',
  };
};
const claudeStanding = (archived: boolean, declaration: ClaudeDesktopTurnDeclaration): RequestStanding => {
  if (archived) {
    return { state: 'withdrawn', detail: 'The session was archived natively; no answer is established.' };
  }
  if (declaration.supersededAt !== null) {
    return {
      state: 'uncertain',
      detail: 'A later declaration replaced this request; no attributable answer is recorded.',
    };
  }
  return {
    state: 'open',
    detail:
      declaration.repliedAt === null
        ? 'The session declared a request. No attributable answer is recorded.'
        : 'A later user message is recorded; it does not identify an answer to this request.',
  };
};
const codexRequests = (session: Session, observation: StoredCodexWorkObservation): WorkThreadNativeSessionRequests => {
  const sessionKey = keyOf(session);
  return {
    observedAt: observation.observedAt,
    partial:
      (session.member.activeAt !== null && Date.parse(observation.lastEventAt) < session.member.activeAt) ||
      observation.omittedRequests > 0 ||
      observation.rejectedRecords > 0 ||
      observation.requests.some((request) => request.questions.some((question) => question.textTruncated)),
    requests: observation.requests.flatMap((request) =>
      request.questions.map(
        (question, index): WorkThreadNativeRequest => ({
          key: JSON.stringify([sessionKey, request.callId, question.id ?? index]),
          sessionKey,
          machineId: session.member.machineId,
          harness: session.harness,
          sourceSessionId: session.member.sourceSessionId,
          callId: request.callId,
          questionId: question.id,
          askedAt: request.askedAt,
          answeredAt: question.answeredAt,
          observedAt: observation.observedAt,
          text: question.text,
          ...codexStanding(request, question),
          evidence:
            request.tool === 'request_user_input' ? 'codex-request-user-input' : 'codex-request-user-input-async',
        }),
      ),
    ),
  };
};
const claudeRequests = (
  session: Session,
  declarations: readonly ClaudeDesktopTurnDeclaration[],
  partial: boolean,
): WorkThreadNativeSessionRequests => {
  const sessionKey = keyOf(session);
  const desktop = session.desktop;
  if (desktop === null || desktop.cliSessionId !== session.member.sourceSessionId) {
    return { requests: [], observedAt: desktop?.observedAt ?? null, partial: true };
  }
  return {
    observedAt: desktop?.observedAt ?? null,
    partial:
      (session.member.activeAt !== null && Date.parse(desktop.lastActivityAt) < session.member.activeAt) ||
      declarations.length >= WORK_ATTENTION_BOUNDS.maxDeclarationsPerSession ||
      partial ||
      desktop?.archived === true ||
      desktop === null ||
      desktop.format !== 'claude-desktop-session-v1' ||
      declarations.length === 0,
    requests: declarations
      // Only an action the session asked for is a request. "Review ready" without one is a report
      // ("CI running, auto-fix on"): it stays on its session and never ranks as the operator's move.
      .filter(
        (declaration) =>
          (declaration.status === 'blocked' || declaration.status === 'review_ready') &&
          Boolean(declaration.needsAction?.trim()),
      )
      .map((declaration) => ({
        key: JSON.stringify([sessionKey, desktop?.desktopSessionId, declaration.declarationKey]),
        sessionKey,
        machineId: session.member.machineId,
        harness: session.harness,
        sourceSessionId: session.member.sourceSessionId,
        callId: null,
        questionId: null,
        askedAt: declaration.declaredAt,
        answeredAt: null,
        observedAt: desktop?.observedAt ?? declaration.firstObservedAt,
        text: (declaration.needsAction ?? '').slice(0, 1000),
        ...claudeStanding(desktop?.archived ?? false, declaration),
        evidence: 'claude-desktop-declaration',
      })),
  };
};

/** Read only qualified sessions already admitted by the task evidence reader, in bounded batches. */
export const readWorkThreadNativeRequests = (
  dbPath: string,
  evidence: readonly WorkThreadSessionEvidence[],
): Effect.Effect<WorkThreadNativeRequestsRead, UsageStoreError> =>
  Effect.gen(function* () {
    const sessions = new Map(
      evidence.flatMap((item) => item.sessions.map((session) => [keyOf(session), session] as const)),
    );
    const groups = new Map<string, Session[]>();
    for (const session of sessions.values()) {
      const key = JSON.stringify([session.member.machineId, session.harness]);
      const group = groups.get(key) ?? [];
      group.push(session);
      groups.set(key, group);
    }
    const result = new Map<string, WorkThreadNativeSessionRequests>();
    for (const group of groups.values()) {
      const groupSession = group[0];
      const collection =
        groupSession?.harness === 'claude'
          ? (yield* queryClaudeDesktopCollectionState({ dbPath, machineId: groupSession.member.machineId })).states[0]
          : undefined;
      const claudeCollectionPartial =
        collection === undefined ||
        collection.completeness.rejected > 0 ||
        collection.completeness.truncated ||
        collection.completeness.unsupported > 0 ||
        collection.completeness.filesParsed < collection.completeness.filesSeen ||
        collection.completeness.filesSeen === 0;
      for (let offset = 0; offset < group.length; offset += 100) {
        const batch = group.slice(offset, offset + 100);
        const first = batch[0];
        if (!first) {
          continue;
        }
        if (first.harness === 'codex') {
          const read = yield* queryCodexWorkObservations({
            dbPath,
            machineId: first.member.machineId,
            sourceSessionIds: batch.map((session) => session.member.sourceSessionId),
          });
          const observations = new Map(read.observations.map((item) => [item.sourceSessionId, item]));
          for (const session of batch) {
            const observation = observations.get(session.member.sourceSessionId);
            const projected =
              observation === undefined
                ? { requests: [], partial: true, observedAt: null }
                : codexRequests(session, observation);
            result.set(keyOf(session), {
              ...projected,
              partial:
                read.skipped > 0 ||
                read.incompleteSessionIds.includes(session.member.sourceSessionId) ||
                projected.partial,
            });
          }
        } else if (first.harness === 'claude') {
          const read = yield* queryClaudeDesktopTurnDeclarations({
            dbPath,
            machineId: first.member.machineId,
            desktopSessionIds: batch.flatMap((session) =>
              session.desktop === null ? [] : [session.desktop.desktopSessionId],
            ),
          });
          for (const session of batch) {
            result.set(
              keyOf(session),
              claudeRequests(
                session,
                read.declarations.filter((item) => item.desktopSessionId === session.desktop?.desktopSessionId),
                read.skipped > 0 ||
                  claudeCollectionPartial ||
                  (collection !== undefined &&
                    (session.desktop === null ||
                      Date.parse(session.desktop.observedAt) < Date.parse(collection.collectedAt))),
              ),
            );
          }
        } else {
          for (const session of batch) {
            result.set(keyOf(session), { requests: [], partial: true, observedAt: null });
          }
        }
      }
    }
    return result;
  });
