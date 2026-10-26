import type {
  WorkThreadCommandResult,
  WorkThreadFollowState,
  WorkThreadTaskCommand,
  WorkThreadWait,
} from '@ai-usage/report-core/work-thread';
import type { WorkThreadDetailDataset } from '@ai-usage/report-core/work-thread-view';
import { createWorkThreadCommandAction } from '../../rpc/work-threads-client';

export interface FollowUndoSnapshot {
  /** Null means the original closure is outside the served event history. */
  readonly acknowledgedRemainders: readonly string[] | null;
  readonly doneReason: string | null;
  readonly state: WorkThreadFollowState;
  readonly threadId: string;
  readonly waitingFor: string | null;
  readonly waitingOn: WorkThreadWait | null;
}
type Success = Extract<WorkThreadCommandResult, { ok: true }>;
type Refusal = Extract<WorkThreadCommandResult, { ok: false }>;
export type FollowUndoResult =
  | { readonly status: 'restored'; readonly result: Success }
  | { readonly status: 'refused'; readonly result: Refusal; readonly reopened: boolean }
  | { readonly status: 'history-unavailable' }
  | { readonly status: 'unavailable'; readonly reopened: boolean };
export interface FollowUndoAction {
  readonly run: () => Promise<FollowUndoResult>;
}

export const captureFollowUndo = (data: WorkThreadDetailDataset): FollowUndoSnapshot => {
  const thread = data.row.thread;
  const closure = data.events.findLast(
    (event) => event.kind === 'follow-state' && event.toState === 'done' && event.at === thread.doneAt,
  );
  let acknowledgedRemainders: readonly string[] | null = [];
  if (thread.followState === 'done') {
    acknowledgedRemainders = closure ? [...closure.acknowledgedRemainders] : null;
  }
  return {
    threadId: thread.threadId,
    state: thread.followState,
    waitingFor: thread.waitingFor,
    waitingOn: thread.waitingOn ? { ...thread.waitingOn } : null,
    doneReason: thread.doneReason,
    acknowledgedRemainders,
  };
};

/** One user action retains its command identity if its response is uncertain. */
export const createFollowUndo = (
  snapshot: FollowUndoSnapshot,
  currentState: WorkThreadFollowState,
  revision: number,
  execute: (command: WorkThreadTaskCommand) => Promise<WorkThreadCommandResult>,
): FollowUndoAction => {
  const targets: readonly WorkThreadFollowState[] =
    currentState === 'done' && snapshot.state === 'waiting' ? ['following', 'waiting'] : [snapshot.state];
  let step = 0;
  let expectedRevision = revision;
  let pending: WorkThreadTaskCommand | null = null;
  let terminal: FollowUndoResult | null = null;
  return {
    run: async () => {
      if (snapshot.state === 'done' && snapshot.acknowledgedRemainders === null) {
        return { status: 'history-unavailable' };
      }
      if (terminal) {
        return terminal;
      }
      for (const target of targets.slice(step)) {
        pending ??= createWorkThreadCommandAction({
          op: 'set-follow-state',
          threadId: snapshot.threadId,
          expectedRevision,
          to: target,
          waitingFor: target === 'waiting' ? snapshot.waitingFor : null,
          waitingOn: target === 'waiting' ? snapshot.waitingOn : null,
          reason: target === 'done' ? snapshot.doneReason : null,
          acknowledgedRemainders: target === 'done' ? (snapshot.acknowledgedRemainders ?? []) : [],
        });
        let result: WorkThreadCommandResult;
        try {
          result = await execute(pending);
        } catch {
          return { status: 'unavailable', reopened: step > 0 };
        }
        if (!result.ok) {
          terminal = { status: 'refused', result, reopened: step > 0 };
          return terminal;
        }
        expectedRevision = result.followRevision;
        pending = null;
        step += 1;
        if (step === targets.length) {
          terminal = { status: 'restored', result };
          return terminal;
        }
      }
      throw new Error('Follow-up undo has no remaining transition');
    },
  };
};
