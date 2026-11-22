import { randomUUID } from 'node:crypto';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import {
  isWorkThreadId,
  parseWorkThreadCommand,
  parseWorkThreadLinkKey,
  WORK_THREAD_BOUNDS,
  WORK_THREAD_COMMAND_FAILURES,
  type WorkIntakeCommandResult,
  type WorkThread,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
  type WorkThreadTaskCommand,
} from '@ai-usage/report-core/work-thread';
import type { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import {
  combineBlockers,
  keptThreadFor,
  keptThreadIdOf,
  memberThreadIdsOf,
  openTasksByTicket,
} from './work-thread-combination';
import {
  addEvent,
  addLink,
  canonicalLinkKey,
  comparableLinkSql,
  instant,
  invalidInput,
  json,
  linkFromRecord,
  newThread,
  readThread,
  record,
  type SqliteDatabase,
  saveThread,
  validated,
  waitLinkKind,
  write,
} from './work-thread-rows';

interface ApplyWorkThreadCommandInput {
  readonly command: WorkThreadCommand;
  readonly dbPath: string;
  readonly machineId: string;
  readonly now: string;
}

const normalizeCommandLink = (link: unknown): unknown =>
  isRecord(link) && typeof link.key === 'string' && (link.kind === 'pull-request' || link.kind === 'branch')
    ? { ...link, key: canonicalLinkKey(link.kind, link.key) }
    : link;

const success = (thread: WorkThread, applied = true): WorkThreadCommandResult => ({
  applied,
  followRevision: thread.followRevision,
  ok: true,
  threadId: thread.threadId,
});
const failure = (
  kind: Extract<WorkThreadCommandResult, { ok: false }>['failure'],
  message: string,
  currentRevision: number | null = null,
): WorkThreadCommandResult => ({ currentRevision, failure: kind, message, ok: false });

const replayResult = (value: unknown): WorkThreadCommandResult | WorkIntakeCommandResult => {
  const result = record(json(record(value).result_json));
  if (
    result.ok === true &&
    typeof result.applied === 'boolean' &&
    (result.threadId === null || isWorkThreadId(result.threadId)) &&
    typeof result.followRevision === 'number' &&
    Number.isSafeInteger(result.followRevision) &&
    result.followRevision >= 1
  ) {
    return isWorkThreadId(result.threadId)
      ? { applied: false, followRevision: result.followRevision, ok: true, threadId: result.threadId }
      : { applied: false, followRevision: INTAKE_RESULT_REVISION, ok: true, threadId: null };
  }
  if (
    result.ok === false &&
    typeof result.message === 'string' &&
    (result.currentRevision === null ||
      (typeof result.currentRevision === 'number' &&
        Number.isSafeInteger(result.currentRevision) &&
        result.currentRevision >= 1))
  ) {
    const kind = WORK_THREAD_COMMAND_FAILURES.find((entry) => entry === result.failure);
    if (kind) {
      return failure(kind, result.message, result.currentRevision);
    }
  }
  return validated<WorkThreadCommandResult>(null, 'command result');
};

const applyFollowState = (
  db: SqliteDatabase,
  thread: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'set-follow-state' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  if (thread.followRevision !== command.expectedRevision) {
    return failure(
      'revision-conflict',
      'The follow state changed since this command was prepared',
      thread.followRevision,
    );
  }
  if (thread.followState === command.to || (thread.followState === 'done' && command.to !== 'following')) {
    return failure('invalid-transition', 'This follow-state transition is not allowed', thread.followRevision);
  }
  const next: WorkThread = {
    ...thread,
    followRevision: thread.followRevision + 1,
    followState: command.to,
    updatedAt: now,
    doneAt: command.to === 'done' ? now : null,
    doneReason: command.to === 'done' ? command.reason : null,
    waitingFor: command.to === 'waiting' ? command.waitingFor : null,
    waitingOn: command.to === 'waiting' ? command.waitingOn : null,
  };
  saveThread(db, next);
  addEvent(db, next, now, 'follow-state', {
    acknowledgedRemainders: command.acknowledgedRemainders,
    fromState: thread.followState,
    toState: next.followState,
    reason: command.reason,
  });
  return success(next);
};

const applyLink = (
  db: SqliteDatabase,
  thread: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'link' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  if (
    db
      .query(
        `SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = ? AND ${comparableLinkSql(command.kind)} = ? AND detached_at IS NULL`,
      )
      .get(thread.threadId, command.kind, canonicalLinkKey(command.kind, command.key)) !== null
  ) {
    return success(thread, false);
  }
  const active = record(
    db
      .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
      .get(thread.threadId),
  );
  if (typeof active.count !== 'number' || active.count >= WORK_THREAD_BOUNDS.maxLinksPerThread) {
    return failure('invalid-link', 'The thread has reached its active link limit', thread.followRevision);
  }
  addLink(db, { createdAt: now, key: command.key, kind: command.kind, provenance: 'user', threadId: thread.threadId });
  saveThread(db, { ...thread, updatedAt: now });
  addEvent(db, thread, now, 'link-added', { linkKey: command.key });
  return success(thread);
};

/**
 * Combine the tasks following one ticket (ADR 0080). The engine recomputes the group from current
 * evidence inside this transaction: the operator approved exactly these tasks for this ticket, so
 * any difference is `stale-preview`, never a silent adjustment.
 */
const applyCombine = (
  db: SqliteDatabase,
  machineId: string,
  kept: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'combine' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  const ticketKey = canonicalLinkKey('jira-issue', command.ticketKey);
  const expected = new Map(command.participants.map((item) => [item.threadId, item.expectedRevision]));
  const group = new Set((openTasksByTicket(db, machineId).get(ticketKey) ?? []).map((thread) => thread.threadId));
  const threads: WorkThread[] = [];
  for (const threadId of expected.keys()) {
    const thread = readThread(db, threadId);
    if (!thread || thread.machineId !== machineId) {
      return failure('not-found', 'A task of this combination was not found', kept.followRevision);
    }
    threads.push(thread);
  }
  if (group.size !== expected.size || [...group].some((threadId) => !expected.has(threadId))) {
    return failure(
      'stale-preview',
      'The tasks following this ticket changed since the preview; review the combination again.',
      kept.followRevision,
    );
  }
  for (const thread of threads) {
    if (thread.followRevision !== expected.get(thread.threadId)) {
      return failure('revision-conflict', `“${thread.title}” changed since the preview`, thread.followRevision);
    }
  }
  if (keptThreadFor(threads, ticketKey)?.threadId !== kept.threadId) {
    return failure('stale-preview', 'Another task now keeps this combination; review it again.', kept.followRevision);
  }
  const blockers = combineBlockers(db, threads);
  if (blockers.length > 0) {
    return failure('invalid-transition', blockers.join(' '), kept.followRevision);
  }
  // Revisions advance so a follow-state command prepared before the combination conflicts.
  const nextKept = { ...kept, followRevision: kept.followRevision + 1, updatedAt: now };
  saveThread(db, nextKept);
  const members = threads.filter((thread) => thread.threadId !== kept.threadId);
  for (const member of members) {
    db.query(`INSERT INTO work_thread_combinations(member_thread_id, kept_thread_id, ticket_key, combined_at,
      combine_command_id) VALUES (?, ?, ?, ?, ?)`).run(
      member.threadId,
      kept.threadId,
      ticketKey,
      now,
      command.commandId,
    );
    const next = { ...member, followRevision: member.followRevision + 1, updatedAt: now };
    saveThread(db, next);
    addEvent(db, next, now, 'combined', { linkKey: ticketKey, reason: `Combined into “${kept.title}”` });
  }
  addEvent(db, nextKept, now, 'combined', {
    linkKey: ticketKey,
    reason:
      `Combined ${members.length} ${members.length === 1 ? 'task' : 'tasks'}: ${members.map((member) => `“${member.title}”`).join(', ')}`.slice(
        0,
        WORK_THREAD_BOUNDS.maxNote,
      ),
  });
  return success(nextKept);
};

/** End a combination: members return with the state they kept; work done on the kept task stays. */
const applySeparate = (
  db: SqliteDatabase,
  kept: WorkThread,
  command: Extract<WorkThreadCommand, { op: 'separate' }>,
  now: CanonicalInstant,
): WorkThreadCommandResult => {
  if (kept.followRevision !== command.expectedRevision) {
    return failure('revision-conflict', 'The task changed since this command was prepared', kept.followRevision);
  }
  const memberIds = memberThreadIdsOf(db, kept.threadId);
  if (memberIds.length === 0) {
    return failure('invalid-transition', 'No task is combined into this one', kept.followRevision);
  }
  const wait = kept.waitingOn;
  if (
    wait !== null &&
    db
      .query(
        `SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = ? AND detached_at IS NULL
        AND ${comparableLinkSql(waitLinkKind(wait.kind))} = ?`,
      )
      .get(kept.threadId, waitLinkKind(wait.kind), canonicalLinkKey(waitLinkKind(wait.kind), wait.linkKey)) === null
  ) {
    return failure(
      'invalid-transition',
      'This task waits on a link that would leave with a separated task; change the wait first.',
      kept.followRevision,
    );
  }
  db.query(
    'UPDATE work_thread_combinations SET separated_at = ?, separate_command_id = ? WHERE kept_thread_id = ? AND separated_at IS NULL',
  ).run(now, command.commandId, kept.threadId);
  const nextKept = { ...kept, followRevision: kept.followRevision + 1, updatedAt: now };
  saveThread(db, nextKept);
  addEvent(db, nextKept, now, 'separated', {
    reason: `Separated ${memberIds.length} ${memberIds.length === 1 ? 'task' : 'tasks'}`,
  });
  for (const memberId of memberIds) {
    const member = readThread(db, memberId);
    if (member) {
      const next = { ...member, followRevision: member.followRevision + 1, updatedAt: now };
      saveThread(db, next);
      addEvent(db, next, now, 'separated', { reason: `Separated from “${kept.title}”` });
    }
  }
  return success(nextKept);
};

/** Intake decisions carry no follow state; the fixed revision only satisfies the result shape. */
const INTAKE_RESULT_REVISION = 1;

const applyIntakeDismissal = (
  db: SqliteDatabase,
  machineId: string,
  command: Extract<WorkThreadCommand, { op: 'dismiss-intake' }>,
  now: CanonicalInstant,
): WorkIntakeCommandResult => {
  const key = canonicalLinkKey('jira-issue', command.key);
  const row = db
    .query('SELECT dismissed_at FROM work_jira_intake WHERE machine_id = ? AND link_key = ?')
    .get(machineId, key);
  const dismissedAt = command.dismissed ? now : null;
  if (row === null) {
    // Dismissing before discovery returned the issue still records the operator's choice.
    db.query(`INSERT INTO work_jira_intake(machine_id, link_key, first_seen_at, assigned, assigned_at, dismissed_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run(machineId, key, now, now, dismissedAt);
  } else if ((record(row).dismissed_at !== null) === command.dismissed) {
    return { applied: false, followRevision: INTAKE_RESULT_REVISION, ok: true, threadId: null };
  } else {
    db.query('UPDATE work_jira_intake SET dismissed_at = ? WHERE machine_id = ? AND link_key = ?').run(
      dismissedAt,
      machineId,
      key,
    );
  }
  return { applied: true, followRevision: INTAKE_RESULT_REVISION, ok: true, threadId: null };
};

const executeCommand = (
  db: SqliteDatabase,
  input: ApplyWorkThreadCommandInput,
  now: CanonicalInstant,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
): WorkThreadCommandResult | WorkIntakeCommandResult => {
  let normalized: unknown = input.command;
  if (input.command.op === 'create' && Array.isArray(input.command.links)) {
    normalized = { ...input.command, links: input.command.links.map(normalizeCommandLink) };
  } else if (input.command.op === 'link') {
    normalized = normalizeCommandLink(input.command);
  }
  const command = parseWorkThreadCommand(normalized);
  if (!command) {
    if (
      input.command.op === 'link' &&
      isWorkThreadId(input.command.threadId) &&
      typeof input.command.key === 'string' &&
      !parseWorkThreadLinkKey(input.command.kind, input.command.key)
    ) {
      return failure(
        'invalid-link',
        'The link key is not qualified for its kind',
        readThread(db, input.command.threadId)?.followRevision ?? null,
      );
    }
    return invalidInput('Invalid work thread command');
  }
  if (command.op === 'create') {
    const thread = newThread({ ...command, machineId: input.machineId, now, origin: 'user', originKey: null });
    saveThread(db, thread);
    const seen = new Set<string>();
    for (const link of command.links) {
      const identity = JSON.stringify([link.kind, canonicalLinkKey(link.kind, link.key)]);
      if (!seen.has(identity)) {
        addLink(db, { ...link, createdAt: now, provenance: 'user', threadId: thread.threadId });
        seen.add(identity);
      }
    }
    addEvent(db, thread, now, 'created', { toState: 'following' });
    return success(thread);
  }
  if (command.op === 'dismiss-intake') {
    return applyIntakeDismissal(db, input.machineId, command, now);
  }
  const thread = readThread(db, command.threadId);
  if (!thread) {
    return failure('not-found', 'The work thread was not found');
  }
  const keptId = keptThreadIdOf(db, thread.threadId);
  if (keptId !== null) {
    const kept = readThread(db, keptId);
    return failure(
      'task-combined',
      `This task was combined into “${kept?.title ?? keptId}”; act on that task or separate it first.`,
      thread.followRevision,
    );
  }
  switch (command.op) {
    case 'combine':
      return applyCombine(db, input.machineId, thread, command, now);
    case 'separate':
      return applySeparate(db, thread, command, now);
    case 'set-follow-state':
      return applyFollowState(db, thread, command, now);
    case 'link':
      return applyLink(db, thread, command, now);
    case 'detach-link': {
      // A kept task shows its members' links as its own: detaching one detaches every active copy
      // of that key across the combination, so it cannot stay attached through another member.
      const group = JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)]);
      const row = db
        .query('SELECT * FROM work_thread_links WHERE link_id = ? AND thread_id IN (SELECT value FROM json_each(?))')
        .get(command.linkId, group);
      if (row === null) {
        return failure('invalid-link', 'The link does not belong to this thread', thread.followRevision);
      }
      const link = linkFromRecord(row);
      if (link.detachedAt !== null) {
        return success(thread, false);
      }
      db.query(
        `UPDATE work_thread_links SET detached_at = ? WHERE detached_at IS NULL AND kind = ?
        AND ${comparableLinkSql(link.kind)} = ? AND thread_id IN (SELECT value FROM json_each(?))`,
      ).run(now, link.kind, canonicalLinkKey(link.kind, link.key), group);
      saveThread(db, { ...thread, updatedAt: now });
      addEvent(db, thread, now, 'link-detached', { linkKey: link.key });
      return success(thread);
    }
    case 'detach-session': {
      const group = JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)]);
      const active = db
        .query(`SELECT 1 FROM work_thread_links WHERE kind = 'session' AND link_key = ? AND detached_at IS NULL
          AND thread_id IN (SELECT value FROM json_each(?))`)
        .get(command.key, group);
      if (active === null) {
        const vetoed = db
          .query(`SELECT 1 FROM work_thread_links WHERE kind = 'session' AND link_key = ?
            AND thread_id IN (SELECT value FROM json_each(?))`)
          .get(command.key, group);
        if (vetoed !== null) {
          return success(thread, false);
        }
        // A session read through the branch has no stored link; the detached row is the veto.
        db.query(`INSERT INTO work_thread_links(link_id, thread_id, kind, link_key, provenance, created_at, detached_at)
          VALUES (?, ?, 'session', ?, 'user', ?, ?)`).run(randomUUID(), thread.threadId, command.key, now, now);
      } else {
        db.query(`UPDATE work_thread_links SET detached_at = ? WHERE kind = 'session' AND link_key = ?
          AND detached_at IS NULL AND thread_id IN (SELECT value FROM json_each(?))`).run(now, command.key, group);
      }
      saveThread(db, { ...thread, updatedAt: now });
      addEvent(db, thread, now, 'link-detached', { linkKey: command.key });
      return success(thread);
    }
    case 'set-note':
      if (thread.note === command.note) {
        return success(thread, false);
      }
      saveThread(db, { ...thread, note: command.note, updatedAt: now });
      addEvent(db, thread, now, 'note', { reason: command.note });
      return success(thread);
    case 'rename':
      if (thread.title === command.title) {
        return success(thread, false);
      }
      saveThread(db, { ...thread, title: command.title, updatedAt: now });
      addEvent(db, thread, now, 'renamed', { reason: command.title });
      return success(thread);
    default:
      return command satisfies never;
  }
};

// A task command's result names its task; only an intake decision answers without one.
export function applyWorkThreadCommand(
  input: ApplyWorkThreadCommandInput & { readonly command: WorkThreadTaskCommand },
): Effect.Effect<WorkThreadCommandResult, UsageStoreError>;
export function applyWorkThreadCommand(
  input: ApplyWorkThreadCommandInput,
): Effect.Effect<WorkThreadCommandResult | WorkIntakeCommandResult, UsageStoreError>;
export function applyWorkThreadCommand(
  input: ApplyWorkThreadCommandInput,
): Effect.Effect<WorkThreadCommandResult | WorkIntakeCommandResult, UsageStoreError> {
  return write(input.dbPath, 'applyWorkThreadCommand', (db) => {
    if (!isWorkThreadId(input.command.commandId)) {
      return invalidInput('Invalid work thread command id');
    }
    const existing = db
      .query('SELECT result_json FROM work_thread_commands WHERE command_id = ?')
      .get(input.command.commandId);
    if (existing !== null) {
      return replayResult(existing);
    }
    const now = instant(input.now);
    const result = executeCommand(db, input, now);
    db.query('INSERT INTO work_thread_commands(command_id, result_json, recorded_at) VALUES (?, ?, ?)').run(
      input.command.commandId,
      JSON.stringify(result),
      now,
    );
    return result;
  });
}
