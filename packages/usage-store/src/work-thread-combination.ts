import { jiraKeysInBranch } from '@ai-usage/report-core/work-attention-facts';
import {
  jiraIssueLinkKey,
  parseWorkThreadLinkKey,
  WORK_THREAD_BOUNDS,
  type WorkThread,
} from '@ai-usage/report-core/work-thread';
import { readThread, record, type SqliteDatabase, threadFromRecord } from './work-thread-rows';

// ---------------------------------------------------------------------------------------------
// Combined tasks (ADR 0080). A member keeps its links, events and state; while the combination is
// active, every task-level reading and automatic write resolves it to the kept task.
// ---------------------------------------------------------------------------------------------

export const keptThreadIdOf = (db: SqliteDatabase, threadId: string): string | null => {
  const row = db
    .query('SELECT kept_thread_id FROM work_thread_combinations WHERE member_thread_id = ? AND separated_at IS NULL')
    .get(threadId);
  return row === null ? null : String(record(row).kept_thread_id);
};

export const memberThreadIdsOf = (db: SqliteDatabase, keptThreadId: string): string[] =>
  db
    .query(
      `SELECT member_thread_id FROM work_thread_combinations WHERE kept_thread_id = ? AND separated_at IS NULL
      ORDER BY combination_id`,
    )
    .all(keptThreadId)
    .map((row) => String(record(row).member_thread_id));

/** The task that answers for `thread`: itself, or the task it is combined into. */
export const effectiveThread = (db: SqliteDatabase, thread: WorkThread): WorkThread => {
  const kept = keptThreadIdOf(db, thread.threadId);
  return kept === null ? thread : (readThread(db, kept) ?? thread);
};

const MAX_TICKET_EVIDENCE_THREADS = 2000;

/**
 * Exactly which ticket each task follows, by the rule combinations use (stricter than routing):
 * its Jira origin, an active Jira link, or an active PR on a non-review task whose latest observed
 * head branch names exactly one key. A detached link to a ticket removes the task from it.
 */
const tasksByTicket = (db: SqliteDatabase, machineId: string): Map<string, Set<string>> => {
  const byTicket = new Map<string, Set<string>>();
  const add = (ticket: string, threadId: string) => {
    const group = byTicket.get(ticket) ?? new Set<string>();
    group.add(threadId);
    byTicket.set(ticket, group);
  };
  const vetoes = new Set(
    db
      .query(
        `SELECT l.thread_id || ' ' || l.link_key AS veto FROM work_thread_links l JOIN work_threads t USING(thread_id)
        WHERE t.machine_id = ? AND l.kind = 'jira-issue' AND l.detached_at IS NOT NULL`,
      )
      .all(machineId)
      .map((row) => String(record(row).veto)),
  );
  for (const row of db
    .query(
      `SELECT t.thread_id, t.origin_key AS ticket FROM work_threads t WHERE t.machine_id = ? AND t.origin = 'jira-issue'
      UNION SELECT l.thread_id, l.link_key FROM work_thread_links l JOIN work_threads t USING(thread_id)
        WHERE t.machine_id = ? AND l.kind = 'jira-issue' AND l.detached_at IS NULL
      LIMIT ?`,
    )
    .all(machineId, machineId, MAX_TICKET_EVIDENCE_THREADS)) {
    add(String(record(row).ticket), String(record(row).thread_id));
  }
  for (const row of db
    .query(
      `WITH latest AS (
        SELECT lower(host) || '/' || lower(repository) || '#' || number AS link_key, head_ref,
          ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
        FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
      )
      SELECT t.thread_id, latest.head_ref FROM work_threads t
      JOIN work_thread_links l ON l.thread_id = t.thread_id AND l.kind = 'pull-request' AND l.detached_at IS NULL
      JOIN latest ON latest.link_key = lower(l.link_key) AND latest.rank = 1
      WHERE t.machine_id = ? AND (t.intent IS NULL OR t.intent != 'review') LIMIT ?`,
    )
    .all(machineId, machineId, MAX_TICKET_EVIDENCE_THREADS)) {
    const keys = jiraKeysInBranch(String(record(row).head_ref ?? ''));
    const [key] = keys;
    if (keys.length === 1 && key !== undefined) {
      add(jiraIssueLinkKey({ key, site: 'default' }), String(record(row).thread_id));
    }
  }
  for (const [ticket, group] of byTicket) {
    for (const threadId of group) {
      if (vetoes.has(`${threadId} ${ticket}`)) {
        group.delete(threadId);
      }
    }
  }
  return byTicket;
};

/** Open tasks following each ticket: a Done follow-up is history and never joins a combination. */
export const openTasksByTicket = (db: SqliteDatabase, machineId: string): Map<string, WorkThread[]> => {
  const result = new Map<string, WorkThread[]>();
  const threads = new Map<string, WorkThread | null>();
  for (const [ticket, ids] of tasksByTicket(db, machineId)) {
    const open: WorkThread[] = [];
    for (const threadId of ids) {
      if (!threads.has(threadId)) {
        threads.set(threadId, readThread(db, threadId));
      }
      const thread = threads.get(threadId);
      if (thread && thread.followState !== 'done') {
        open.push(thread);
      }
    }
    result.set(ticket, open);
  }
  return result;
};

const distinctActiveLinkCount = (db: SqliteDatabase, threadIds: readonly string[]): number => {
  const row = record(
    db
      .query(
        `SELECT COUNT(DISTINCT kind || ' ' || CASE WHEN kind = 'pull-request' THEN lower(link_key) ELSE link_key END)
        AS count FROM work_thread_links WHERE detached_at IS NULL AND thread_id IN (SELECT value FROM json_each(?))`,
      )
      .get(JSON.stringify(threadIds)),
  );
  return typeof row.count === 'number' ? row.count : Number.POSITIVE_INFINITY;
};

/** A key active on one participant but detached (an operator veto) on another. */
const crossVetoedKeys = (db: SqliteDatabase, threadIds: readonly string[]): string[] =>
  db
    .query(
      `SELECT DISTINCT active.link_key AS key FROM work_thread_links active JOIN work_thread_links detached
        ON detached.kind = active.kind AND detached.link_key = active.link_key AND detached.detached_at IS NOT NULL
        AND detached.thread_id != active.thread_id
      WHERE active.detached_at IS NULL AND active.thread_id IN (SELECT value FROM json_each(?))
        AND detached.thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(threadIds), JSON.stringify(threadIds))
    .map((row) => String(record(row).key));

/** Why a group cannot be combined yet; empty when it can. Readable as preview text. */
export const combineBlockers = (db: SqliteDatabase, threads: readonly WorkThread[]): string[] => {
  const blockers: string[] = [];
  const ids = threads.map((thread) => thread.threadId);
  for (const thread of threads) {
    const name = `“${thread.title.slice(0, 60)}”`;
    if (thread.followState !== 'following') {
      blockers.push(`${name} is ${thread.followState === 'done' ? 'Done' : 'Waiting'}; resume following it first.`);
    }
    if (thread.intent === 'review') {
      blockers.push(`${name} is a review; a review stays its own task.`);
    }
    if (thread.note !== null) {
      blockers.push(`${name} has a note; move or clear it first.`);
    }
    if (keptThreadIdOf(db, thread.threadId) !== null || memberThreadIdsOf(db, thread.threadId).length > 0) {
      blockers.push(`${name} is already part of a combination.`);
    }
  }
  if (threads.length > WORK_THREAD_BOUNDS.maxCombinedThreads) {
    blockers.push(`More than ${WORK_THREAD_BOUNDS.maxCombinedThreads} tasks follow this ticket.`);
  }
  if (distinctActiveLinkCount(db, ids) > WORK_THREAD_BOUNDS.maxLinksPerThread) {
    blockers.push(`Together they hold more than ${WORK_THREAD_BOUNDS.maxLinksPerThread} links.`);
  }
  for (const key of crossVetoedKeys(db, ids)) {
    blockers.push(`${key} is detached from one task but active on another.`);
  }
  return blockers;
};

/** The ticket's own task keeps the combination; otherwise the oldest. */
export const keptThreadFor = (threads: readonly WorkThread[], ticketKey: string): WorkThread | undefined =>
  threads.find((thread) => thread.originKey === ticketKey) ??
  threads.toSorted(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId),
  )[0];

interface JiraKeyFollowers {
  /** Done tasks following the ticket: a new PR does not silently reopen or join them. */
  readonly done: number;
  /** Following or Waiting tasks that follow the ticket, oldest first. */
  readonly open: readonly WorkThread[];
}

/**
 * Tasks that follow one Jira issue: by origin, by an active link, or (for change tasks) through an
 * active pull request whose latest head branch names the key as a whole segment. Review tasks only
 * count through an explicit link: a teammate's ticket is context. A detached link to the issue is
 * the operator's veto and removes that task.
 */
export const jiraKeyFollowers = (db: SqliteDatabase, machineId: string, linkKey: string): JiraKeyFollowers => {
  const parsed = parseWorkThreadLinkKey('jira-issue', linkKey);
  if (parsed?.kind !== 'jira-issue') {
    return { done: 0, open: [] };
  }
  const vetoed = new Set(
    db
      .query(
        "SELECT thread_id FROM work_thread_links WHERE kind = 'jira-issue' AND link_key = ? AND detached_at IS NOT NULL",
      )
      .all(linkKey)
      .map((row) => String(record(row).thread_id)),
  );
  const tasks = new Map<string, WorkThread>();
  for (const row of db
    .query(
      `SELECT t.* FROM work_threads t WHERE t.machine_id = ? AND (t.origin_key = ? OR EXISTS (
        SELECT 1 FROM work_thread_links l WHERE l.thread_id = t.thread_id AND l.kind = 'jira-issue'
        AND l.link_key = ? AND l.detached_at IS NULL))`,
    )
    .all(machineId, linkKey, linkKey)) {
    const task = threadFromRecord(row);
    tasks.set(task.threadId, task);
  }
  // A cheap prefilter on the key text; the exact segment rule decides.
  const branches = db
    .query(
      `WITH latest AS (
        SELECT lower(host) || '/' || lower(repository) || '#' || number AS link_key, head_ref,
          ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
        FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
      )
      SELECT t.*, latest.head_ref AS routed_head_ref FROM work_threads t
      JOIN work_thread_links l ON l.thread_id = t.thread_id AND l.kind = 'pull-request' AND l.detached_at IS NULL
      JOIN latest ON latest.link_key = lower(l.link_key) AND latest.rank = 1
      WHERE t.machine_id = ? AND (t.intent IS NULL OR t.intent != 'review') AND latest.head_ref LIKE ?`,
    )
    .all(machineId, machineId, `%${parsed.key}%`);
  for (const row of branches) {
    const headRef = record(row).routed_head_ref;
    if (typeof headRef === 'string' && jiraKeysInBranch(headRef).includes(parsed.key)) {
      const task = threadFromRecord(row);
      tasks.set(task.threadId, task);
    }
  }
  // A combination answers as its kept task, and a veto on any of its tasks holds for all of them.
  const effective = new Map<string, WorkThread>();
  for (const task of tasks.values()) {
    const kept = effectiveThread(db, task);
    effective.set(kept.threadId, kept);
  }
  const vetoedTasks = new Set([...vetoed].map((threadId) => keptThreadIdOf(db, threadId) ?? threadId));
  const followers = [...effective.values()].filter((task) => !vetoedTasks.has(task.threadId));
  return {
    done: followers.filter((task) => task.followState === 'done').length,
    open: followers
      .filter((task) => task.followState !== 'done')
      .sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId),
      ),
  };
};
