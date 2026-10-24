import { describe, expect, test } from 'bun:test';
import type { WorkThreadCommand, WorkThreadCommandResult } from '@ai-usage/report-core/work-thread';
import {
  createSyntheticWorkThreadStore,
  WORK_THREADS_FIXTURE_IDS,
} from '../../../server/work-threads-e2e-fixture.server';
import { captureFollowUndo, createFollowUndo } from './work-thread-follow-undo';

const success = (result: WorkThreadCommandResult) => {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result;
};
const read = async (store: ReturnType<typeof createSyntheticWorkThreadStore>, threadId: string) => {
  const data = await store.readDetail(threadId);
  if (!data) {
    throw new Error('Fixture task unavailable');
  }
  return data;
};
const endedWait = async () => {
  const store = createSyntheticWorkThreadStore();
  const previous = await read(store, WORK_THREADS_FIXTURE_IDS.badges);
  const ended = success(
    await store.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'set-follow-state',
      threadId: previous.row.thread.threadId,
      expectedRevision: previous.row.thread.followRevision,
      to: 'done',
      reason: 'Pause ownership',
      acknowledgedRemainders: ['Product reply is still expected'],
      waitingFor: null,
      waitingOn: null,
    }),
  );
  return { store, previous, ended };
};

describe('follow-up undo', () => {
  test('restores Waiting through Following with the revision returned by each command', async () => {
    const { store, previous, ended } = await endedWait();
    const commands: WorkThreadCommand[] = [];
    const snapshot = captureFollowUndo(previous);
    expect(snapshot.waitingOn).not.toBe(previous.row.thread.waitingOn);
    const action = createFollowUndo(snapshot, 'done', ended.followRevision, (command) => {
      commands.push(command);
      return store.executeCommand(command);
    });
    expect((await action.run()).status).toBe('restored');
    expect(
      commands.map((command) => (command.op === 'set-follow-state' ? [command.to, command.expectedRevision] : [])),
    ).toEqual([
      ['following', ended.followRevision],
      ['waiting', ended.followRevision + 1],
    ]);
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(2);
    const restored = await read(store, ended.threadId);
    expect(restored.row.thread).toMatchObject({
      followState: 'waiting',
      waitingFor: previous.row.thread.waitingFor,
      waitingOn: previous.row.thread.waitingOn,
      followRevision: ended.followRevision + 2,
    });
  });
  test('captures the matching closure before later notes and restores its reason and acknowledgements', async () => {
    const store = createSyntheticWorkThreadStore();
    const initial = await read(store, WORK_THREADS_FIXTURE_IDS.payments);
    const acknowledged = ['The PR is open', 'Review changes remain'];
    const reason = 'Ownership handed to the payments team';
    const ended = success(
      await store.executeCommand({
        commandId: crypto.randomUUID(),
        op: 'set-follow-state',
        threadId: initial.row.thread.threadId,
        expectedRevision: initial.row.thread.followRevision,
        to: 'done',
        reason,
        acknowledgedRemainders: acknowledged,
        waitingFor: null,
        waitingOn: null,
      }),
    );
    await store.executeCommand({
      commandId: crypto.randomUUID(),
      op: 'set-note',
      threadId: ended.threadId,
      note: 'A note after closure',
    });
    const endedDetail = await read(store, ended.threadId);
    const snapshot = captureFollowUndo(endedDetail);
    expect(snapshot.doneReason).toBe(reason);
    expect(snapshot.acknowledgedRemainders).toEqual(acknowledged);
    const event = endedDetail.events.findLast((item) => item.kind === 'follow-state' && item.toState === 'done');
    expect(snapshot.acknowledgedRemainders).not.toBe(event?.acknowledgedRemainders);
    const reopened = success(
      await store.executeCommand({
        commandId: crypto.randomUUID(),
        op: 'set-follow-state',
        threadId: ended.threadId,
        expectedRevision: ended.followRevision,
        to: 'following',
        reason: null,
        acknowledgedRemainders: [],
        waitingFor: null,
        waitingOn: null,
      }),
    );
    const undo = createFollowUndo(snapshot, 'following', reopened.followRevision, store.executeCommand);
    expect((await undo.run()).status).toBe('restored');
    const restored = await read(store, ended.threadId);
    expect(restored.row.thread).toMatchObject({ followState: 'done', doneReason: reason });
    expect(restored.events.findLast((item) => item.kind === 'follow-state')?.acknowledgedRemainders).toEqual(
      acknowledged,
    );
  });
  test('resuming Following can be undone to the captured wait in one transition', async () => {
    const store = createSyntheticWorkThreadStore();
    const waiting = await read(store, WORK_THREADS_FIXTURE_IDS.badges);
    const snapshot = captureFollowUndo(waiting);
    const resumed = success(
      await store.executeCommand({
        commandId: crypto.randomUUID(),
        op: 'set-follow-state',
        threadId: snapshot.threadId,
        expectedRevision: waiting.row.thread.followRevision,
        to: 'following',
        reason: null,
        acknowledgedRemainders: [],
        waitingFor: null,
        waitingOn: null,
      }),
    );
    expect((await read(store, snapshot.threadId)).row.thread).toMatchObject({
      followState: 'following',
      waitingFor: null,
      waitingOn: null,
    });
    const undo = createFollowUndo(snapshot, 'following', resumed.followRevision, store.executeCommand);
    expect((await undo.run()).status).toBe('restored');
    expect((await read(store, snapshot.threadId)).row.thread).toMatchObject({
      followState: 'waiting',
      followRevision: resumed.followRevision + 1,
      waitingFor: snapshot.waitingFor,
      waitingOn: snapshot.waitingOn,
    });
  });
  test('a refused first transition stops without changing or retrying the newer revision', async () => {
    const { store, previous, ended } = await endedWait();
    success(
      await store.executeCommand({
        commandId: crypto.randomUUID(),
        op: 'set-follow-state',
        threadId: ended.threadId,
        expectedRevision: ended.followRevision,
        to: 'following',
        reason: null,
        acknowledgedRemainders: [],
        waitingFor: null,
        waitingOn: null,
      }),
    );
    const before = await read(store, ended.threadId);
    let calls = 0;
    const undo = createFollowUndo(captureFollowUndo(previous), 'done', ended.followRevision, (command) => {
      calls += 1;
      return store.executeCommand(command);
    });
    const result = await undo.run();
    expect(result).toMatchObject({
      status: 'refused',
      reopened: false,
      result: { failure: 'revision-conflict', currentRevision: before.row.thread.followRevision },
    });
    expect(await undo.run()).toBe(result);
    expect(calls).toBe(1);
    expect(await read(store, ended.threadId)).toEqual(before);
  });
  test('does not claim restoration when the second transition is refused', async () => {
    const { store, previous, ended } = await endedWait();
    let calls = 0;
    const undo = createFollowUndo(captureFollowUndo(previous), 'done', ended.followRevision, (command) => {
      calls++;
      return calls === 2
        ? Promise.resolve({
            ok: false,
            failure: 'revision-conflict',
            currentRevision: ended.followRevision + 2,
            message: 'Task changed elsewhere',
          })
        : store.executeCommand(command);
    });
    expect(await undo.run()).toMatchObject({
      status: 'refused',
      reopened: true,
      result: { failure: 'revision-conflict' },
    });
    expect((await read(store, ended.threadId)).row.thread.followState).toBe('following');
    expect(calls).toBe(2);
  });
  test('an uncertain second response retries its ID without repeating the confirmed reopen', async () => {
    const { store, previous, ended } = await endedWait();
    const calls: WorkThreadCommand[] = [];
    let loseResponse = true;
    const undo = createFollowUndo(captureFollowUndo(previous), 'done', ended.followRevision, async (command) => {
      calls.push(command);
      const result = await store.executeCommand(command);
      if (command.op === 'set-follow-state' && command.to === 'waiting' && loseResponse) {
        loseResponse = false;
        throw new Error('Response lost after the command was applied');
      }
      return result;
    });
    expect(await undo.run()).toMatchObject({ status: 'unavailable', reopened: true });
    expect((await undo.run()).status).toBe('restored');
    expect(calls).toHaveLength(3);
    expect(calls[1]?.commandId).toBe(calls[2]?.commandId);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect((await read(store, ended.threadId)).row.thread.followRevision).toBe(ended.followRevision + 2);
  });
  test('an uncertain first response retries its ID before moving to Waiting', async () => {
    const { store, previous, ended } = await endedWait();
    const calls: WorkThreadCommand[] = [];
    const undo = createFollowUndo(captureFollowUndo(previous), 'done', ended.followRevision, async (command) => {
      calls.push(command);
      const result = await store.executeCommand(command);
      if (calls.length === 1) {
        throw new Error('First response lost');
      }
      return result;
    });
    expect(await undo.run()).toMatchObject({ status: 'unavailable', reopened: false });
    expect((await undo.run()).status).toBe('restored');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.commandId).toBe(calls[1]?.commandId);
    expect((await read(store, ended.threadId)).row.thread.followState).toBe('waiting');
  });
  test('missing closure history cannot be invented as an empty acknowledgement list', async () => {
    const store = createSyntheticWorkThreadStore();
    const ended = await read(store, WORK_THREADS_FIXTURE_IDS.done);
    let called = false;
    const snapshot = captureFollowUndo({ ...ended, events: [] });
    const undo = createFollowUndo(snapshot, 'following', ended.row.thread.followRevision + 1, () => {
      called = true;
      throw new Error('Must not execute without closure history');
    });
    expect((await undo.run()).status).toBe('history-unavailable');
    expect(called).toBe(false);
  });
});
