import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  isWorkThreadId,
  parseWorkThreadEvent,
  parseWorkThreadLinkKey,
  WORK_THREAD_BOUNDS,
  type WorkThread,
  type WorkThreadEvent,
  type WorkThreadLink,
} from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_VIEW_BOUNDS, type WorkThreadListQuery } from '@ai-usage/report-core/work-thread-view';
import type { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { combineBlockers, keptThreadFor, keptThreadIdOf, openTasksByTicket } from './work-thread-combination';
import {
  invalidInput,
  json,
  linkFromRecord,
  notCombinedMemberSql,
  read,
  record,
  taskThreadsSql,
  threadFromRecord,
  validated,
} from './work-thread-rows';

interface WorkThreadCombination {
  readonly keptThreadId: string;
  readonly keptTitle: string;
  readonly memberThreadId: string;
  readonly memberTitle: string;
  readonly ticketKey: string;
}

export interface WorkThreadCombineSuggestionEntry {
  readonly blockers: readonly string[];
  readonly keptThreadId: string;
  readonly participants: readonly {
    readonly pullRequestKeys: readonly string[];
    readonly sessionCount: number;
    readonly thread: WorkThread;
  }[];
  readonly ticketKey: string;
}

interface QueryWorkThreadCombineSuggestionsResult {
  readonly items: readonly WorkThreadCombineSuggestionEntry[];
  readonly truncated: boolean;
}

export interface QueryWorkThreadsPageInput {
  readonly dbPath: string;
  readonly query: WorkThreadListQuery;
}

export interface WorkThreadPageRow {
  readonly lastActivityAt: CanonicalInstant;
  readonly thread: WorkThread;
}

export interface QueryWorkThreadsPageResult {
  readonly nextCursor: string | null;
  readonly rows: readonly WorkThreadPageRow[];
}

export interface QueryWorkThreadByIdInput {
  readonly dbPath: string;
  readonly threadId: string;
}

export interface QueryWorkThreadLinksInput {
  readonly dbPath: string;
  readonly threadIds: readonly string[];
}

export interface QueryActiveWorkThreadLinksInput {
  readonly dbPath: string;
  /**
   * Apply terminal-state eligibility before the bound; a failure after a merge, or a merged read
   * without its status history, stays eligible.
   */
  readonly excludeObservedMerged?: boolean;
  /** Restrict Jira authority before the bound; omitted means all sites. */
  readonly jiraSite?: string;
  readonly kind: 'pull-request' | 'jira-issue';
  readonly limit: number;
  readonly machineId: string;
}

export interface QueryActiveWorkThreadLinksResult {
  readonly links: readonly WorkThreadLink[];
  readonly truncated: boolean;
}

const cursorScope = (query: WorkThreadListQuery): string => JSON.stringify([query.tab, query.project, query.search]);

/** Source change time and explicit operator events, evaluated before keyset pagination.
 * Discovery, polling and automatic links must not turn old work into new activity.
 */
// Aggregate each source once before joining task links; a page must not rescan every
// served transcript for every task (the 20,000-session fixture guards this boundary).
const sourceActivitySql = `source_activity AS MATERIALIZED (
 SELECT machine_id, kind, link_key, MAX(at) AS at FROM (
   SELECT machine_id, 'session' AS kind, 'session:' || machine_id || '/claude/' || cli_session_id AS link_key,
     last_activity_at AS at FROM claude_desktop_sessions
   UNION ALL
   SELECT d.machine_id, 'session', 'session:' || d.machine_id || '/claude/' || p.value, d.last_activity_at
     FROM claude_desktop_sessions d, json_each(d.prior_cli_session_ids_json) p
   UNION ALL
   SELECT s.machine_id, 'session', 'session:' || s.machine_id || '/' || json_extract(s.source_row_json, '$.source.harnessKey')
     || '/' || json_extract(s.source_row_json, '$.source.sourceSessionId'),
     strftime('%Y-%m-%dT%H:%M:%fZ', s.active_time / 1000.0, 'unixepoch')
     FROM served_report_rows s JOIN served_report_current c ON c.singleton = 1 AND c.revision = s.revision
     JOIN served_report_revisions r ON r.revision = s.revision AND r.complete = 1
     WHERE s.source_authority = 'local-observed'
   UNION ALL
   SELECT machine_id, 'pull-request', lower(host || '/' || repository || '#' || number),
     MAX(COALESCE(updated_at, ''), COALESCE(merged_at, ''), COALESCE(created_at, ''), COALESCE(closed_at, ''))
     FROM pull_request_observations WHERE outcome = 'observed'
   UNION ALL
   SELECT machine_id, 'jira-issue', 'jira:default/' || issue_key, updated_at
     FROM jira_issue_observations WHERE outcome = 'observed'
 ) WHERE at IS NOT NULL AND at != '' GROUP BY machine_id, kind, link_key
)`;

/** Roles that stand on their own on a branch; delegated sessions and reviews nest under a parent. */
export const BRANCH_ROOT_ROLES = "('interactive', 'exec', 'unknown')";
/** A detached session link anywhere in the combination, not linked again, is the operator's veto. */
export const branchSessionVetoSql = (thread: string, key: string): string => `NOT EXISTS (
  SELECT 1 FROM work_thread_links vetoed WHERE vetoed.kind = 'session' AND vetoed.detached_at IS NOT NULL
    AND vetoed.link_key = ${key} AND vetoed.thread_id IN ${taskThreadsSql(thread)}
    AND NOT EXISTS (SELECT 1 FROM work_thread_links relinked WHERE relinked.kind = 'session'
      AND relinked.link_key = vetoed.link_key AND relinked.detached_at IS NULL
      AND relinked.thread_id IN ${taskThreadsSql(thread)})
)`;

export const BRANCH_SESSION_KEY_SQL = "'session:' || sb.machine_id || '/' || sb.harness || '/' || sb.session_id";

// A kept task's activity spans its combined members' events and links (ADR 0080).
const threadActivitySql = `COALESCE((SELECT MAX(at) FROM (
  SELECT e.at AS at FROM work_thread_events e WHERE e.thread_id IN ${taskThreadsSql('t')} AND (
    json_extract(e.event_json, '$.kind') IN ('follow-state', 'note', 'renamed', 'wait-satisfied', 'combined', 'separated')
    OR (json_extract(e.event_json, '$.kind') = 'created' AND t.origin IN ('user', 'session'))
    OR (json_extract(e.event_json, '$.kind') IN ('link-added', 'link-detached') AND EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id = e.thread_id AND l.provenance = 'user'
        AND l.link_key = json_extract(e.event_json, '$.linkKey')
    ))
  )
  UNION ALL
  SELECT a.at FROM work_thread_links l JOIN source_activity a
    ON a.machine_id = t.machine_id AND a.kind = l.kind AND a.link_key = CASE WHEN l.kind = 'pull-request' THEN lower(l.link_key) ELSE l.link_key END
    WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.detached_at IS NULL
  UNION ALL
  SELECT a.at FROM work_thread_links l
    JOIN work_session_branches sb ON sb.link_key = l.link_key AND sb.machine_id = t.machine_id
      AND sb.role IN ${BRANCH_ROOT_ROLES}
    JOIN source_activity a ON a.machine_id = t.machine_id AND a.kind = 'session' AND a.link_key = ${BRANCH_SESSION_KEY_SQL}
    WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.kind = 'branch' AND l.detached_at IS NULL
      AND ${branchSessionVetoSql('t', BRANCH_SESSION_KEY_SQL)}
  UNION ALL
  SELECT j.at FROM work_thread_links l JOIN pull_request_observations p
    ON p.machine_id = t.machine_id AND lower(l.link_key) = lower(p.host || '/' || p.repository || '#' || p.number)
    JOIN source_activity j ON j.machine_id = t.machine_id AND j.kind = 'jira-issue'
      AND instr('/' || p.head_ref || '/', '/' || substr(j.link_key, length('jira:default/') + 1) || '/') > 0
    WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.kind = 'pull-request' AND l.detached_at IS NULL AND p.outcome = 'observed'
      AND p.observed_at = (SELECT MAX(last.observed_at) FROM pull_request_observations last
        WHERE last.machine_id = p.machine_id AND last.host = p.host AND last.repository = p.repository AND last.number = p.number AND last.outcome = 'observed')
      AND NOT EXISTS (SELECT 1 FROM work_thread_links detached WHERE detached.thread_id IN ${taskThreadsSql('t')}
        AND detached.link_key = j.link_key AND detached.detached_at IS NOT NULL)
) WHERE at IS NOT NULL AND at != ''), t.created_at)`;

/**
 * Where a task's work lands: the repository of its latest observed pull request, members of a
 * combination included, else its stored label. A ticket's task otherwise reads as its Jira project.
 */
const threadProjectSql = (alias: string): string => `COALESCE((
  SELECT (
    -- Linked keys are stored lowercase; discovery keeps GitHub's own spelling, which reads better.
    SELECT spelled.repository FROM pull_request_observations spelled
    WHERE spelled.machine_id = chosen.machine_id AND spelled.host = chosen.host AND spelled.number = chosen.number
      AND lower(spelled.repository) = chosen.repository
    ORDER BY spelled.repository = lower(spelled.repository), spelled.observed_at DESC LIMIT 1
  ) FROM (
    SELECT p.machine_id, p.host, p.number, lower(p.repository) AS repository
    FROM work_thread_links l JOIN pull_request_observations p
      ON p.machine_id = ${alias}.machine_id AND p.outcome = 'observed'
      AND lower(l.link_key) = lower(p.host || '/' || p.repository || '#' || p.number)
    WHERE l.thread_id IN ${taskThreadsSql(alias)} AND l.kind = 'pull-request' AND l.detached_at IS NULL
    ORDER BY p.observed_at DESC, p.id DESC LIMIT 1
  ) chosen
), ${alias}.project_label)`;

const pageFilter = (query: WorkThreadListQuery): { sql: string; params: unknown[] } => {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > WORK_THREAD_VIEW_BOUNDS.maxPageSize ||
    (query.tab !== 'open' && query.tab !== 'done') ||
    (query.project !== null &&
      (typeof query.project !== 'string' || query.project.length > WORK_THREAD_BOUNDS.maxTitle)) ||
    (query.search !== null &&
      (typeof query.search !== 'string' || query.search.length > WORK_THREAD_VIEW_BOUNDS.maxSearch))
  ) {
    return invalidInput('Invalid work thread page query');
  }
  const conditions = [
    query.tab === 'done' ? "t.follow_state = 'done'" : "t.follow_state IN ('following', 'waiting')",
    notCombinedMemberSql('t'),
  ];
  const params: unknown[] = [];
  if (query.project !== null) {
    conditions.push('t.effective_project = ?');
    params.push(query.project);
  }
  if (query.search !== null && query.search.length > 0) {
    conditions.push(`(instr(lower(t.title), lower(?)) > 0 OR EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id IN ${taskThreadsSql('t')} AND l.detached_at IS NULL AND (
        instr(lower(l.link_key), lower(?)) > 0 OR (l.kind = 'session' AND l.link_key IN (
            SELECT 'session:' || session.machine_id || '/' ||
              json_extract(session.source_row_json, '$.source.harnessKey') || '/' ||
              json_extract(session.source_row_json, '$.source.sourceSessionId')
            FROM served_report_current current
            JOIN served_report_revisions revision USING (revision)
            JOIN served_report_rows session USING (revision)
            WHERE current.singleton = 1 AND revision.complete = 1
              AND instr(lower(json_extract(session.source_row_json, '$.sessionLabel')), lower(?)) > 0
            UNION ALL
            SELECT 'session:' || desktop.machine_id || '/claude/' || desktop.cli_session_id
            FROM claude_desktop_sessions desktop
            WHERE instr(lower(desktop.title), lower(?)) > 0
            UNION ALL
            SELECT 'session:' || desktop.machine_id || '/claude/' || prior.value
            FROM claude_desktop_sessions desktop, json_each(desktop.prior_cli_session_ids_json) prior
            WHERE instr(lower(desktop.title), lower(?)) > 0
        ))
      )
    ))`);
    params.push(query.search, query.search, query.search, query.search, query.search);
  }
  if (query.cursor !== null) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 2000) {
      return invalidInput('Invalid work thread cursor');
    }
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    } catch {
      return invalidInput('Invalid work thread cursor');
    }
    if (
      !isRecord(cursor) ||
      cursor.scope !== cursorScope(query) ||
      !isWorkThreadId(cursor.threadId) ||
      typeof cursor.at !== 'string' ||
      normalizeIsoTimestamp(cursor.at) !== cursor.at
    ) {
      return invalidInput('Invalid work thread cursor or changed query scope');
    }
    conditions.push('(t.activity_at < ? OR (t.activity_at = ? AND t.thread_id > ?))');
    params.push(cursor.at, cursor.at, cursor.threadId);
  }
  return { params, sql: conditions.join(' AND ') };
};

export const queryWorkThreadsPage = (
  input: QueryWorkThreadsPageInput,
): Effect.Effect<QueryWorkThreadsPageResult, UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadsPage', (db) => {
    const { sql, params } = pageFilter(input.query);
    const records = db
      .query(`WITH ${sourceActivitySql}, activity AS MATERIALIZED (SELECT t.*, ${threadActivitySql} AS activity_at,
          ${threadProjectSql('t')} AS effective_project FROM work_threads t)
        SELECT t.* FROM activity t WHERE ${sql}
        ORDER BY t.activity_at DESC, t.thread_id ASC LIMIT ?`)
      .all(...params, input.query.limit + 1);
    const rows = records.slice(0, input.query.limit).map(
      (value): WorkThreadPageRow => ({
        lastActivityAt: parseCanonicalInstant(record(value).activity_at),
        thread: threadFromRecord(value),
      }),
    );
    const last = rows.at(-1);
    const nextCursor =
      records.length > input.query.limit && last
        ? Buffer.from(
            JSON.stringify({
              at: last.lastActivityAt,
              scope: cursorScope(input.query),
              threadId: last.thread.threadId,
            }),
          ).toString('base64url')
        : null;
    return { nextCursor, rows };
  });

export const queryWorkThreadById = (
  input: QueryWorkThreadByIdInput,
): Effect.Effect<WorkThread | null, UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadById', (db) => {
    const row = db
      .query(`SELECT t.*, ${threadProjectSql('t')} AS effective_project FROM work_threads t WHERE t.thread_id = ?`)
      .get(input.threadId);
    return row === null ? null : threadFromRecord(row);
  });

export const queryWorkThreadLinks = (
  input: QueryWorkThreadLinksInput,
): Effect.Effect<readonly WorkThreadLink[], UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadLinks', (db) => {
    const ids = [...new Set(input.threadIds)];
    if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
      return invalidInput('Invalid work thread link scope');
    }
    // Active links are all returned; detached history is the latest maxEventsPerThread per thread.
    return db
      .query(`SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY thread_id, (detached_at IS NULL) ORDER BY detached_at DESC, rowid DESC
          ) AS rank FROM work_thread_links WHERE thread_id IN (SELECT value FROM json_each(?))
        ) WHERE detached_at IS NULL OR rank <= ? ORDER BY thread_id, created_at, link_id`)
      .all(JSON.stringify(ids), WORK_THREAD_BOUNDS.maxEventsPerThread)
      .map(linkFromRecord);
  });

export const queryActiveWorkThreadLinks = (
  input: QueryActiveWorkThreadLinksInput,
): Effect.Effect<QueryActiveWorkThreadLinksResult, UsageStoreError> =>
  read(input.dbPath, 'queryActiveWorkThreadLinks', (db) => {
    if (
      !input.machineId ||
      (input.kind !== 'pull-request' && input.kind !== 'jira-issue') ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500 ||
      (input.excludeObservedMerged !== undefined && typeof input.excludeObservedMerged !== 'boolean') ||
      (input.excludeObservedMerged === true && input.kind !== 'pull-request') ||
      (input.jiraSite !== undefined &&
        (input.kind !== 'jira-issue' || !parseWorkThreadLinkKey('jira-issue', `jira:${input.jiraSite}/TEST-1`)))
    ) {
      return invalidInput('Invalid active work thread link scope');
    }
    const pendingPullRequests = input.excludeObservedMerged === true;
    const latestObservations = pendingPullRequests
      ? `WITH latest_observations AS MATERIALIZED (
        SELECT lower(host) || '/' || lower(repository) || '#' || number AS link_key, outcome, state, merged_at, history,
          ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
        FROM pull_request_observations WHERE machine_id = ?
      )`
      : '';
    const eligibility = pendingPullRequests
      ? `AND NOT EXISTS (
        SELECT 1 FROM latest_observations observation WHERE observation.link_key = lower(links.link_key)
          AND observation.rank = 1 AND observation.outcome = 'observed' AND observation.state = 'MERGED'
          AND observation.history IS NOT NULL
          AND NOT coalesce((threads.follow_state = 'waiting'
            AND json_extract(threads.waiting_on_json, '$.kind') = 'pull-request-review'
            AND lower(json_extract(threads.waiting_on_json, '$.linkKey')) = lower(links.link_key)
            AND observation.merged_at > json_extract(threads.waiting_on_json, '$.since')), 0)
      )`
      : '';
    const params: unknown[] = pendingPullRequests ? [input.machineId] : [];
    params.push(input.machineId, input.kind);
    if (input.jiraSite !== undefined) {
      params.push(`jira:${input.jiraSite}/`);
    }
    params.push(input.limit + 1);
    const rows = db
      .query(`${latestObservations} SELECT * FROM (
        SELECT links.*, ROW_NUMBER() OVER (PARTITION BY ${input.kind === 'pull-request' ? 'lower(link_key)' : 'link_key'}
          ORDER BY links.created_at DESC, links.link_id) AS rank
        FROM work_thread_links links
        LEFT JOIN work_thread_combinations combination
          ON combination.member_thread_id = links.thread_id AND combination.separated_at IS NULL
        JOIN work_threads threads ON threads.thread_id = COALESCE(combination.kept_thread_id, links.thread_id)
        WHERE threads.machine_id = ? AND threads.follow_state != 'done'
          AND links.kind = ? AND links.detached_at IS NULL
          ${eligibility}
          ${input.jiraSite === undefined ? '' : 'AND instr(links.link_key, ?) = 1'}
      ) WHERE rank = 1 ORDER BY created_at DESC, link_id LIMIT ?`)
      .all(...params);
    return { links: rows.slice(0, input.limit).map(linkFromRecord), truncated: rows.length > input.limit };
  });

export const queryWorkThreadEvents = (
  input: QueryWorkThreadByIdInput | QueryWorkThreadLinksInput,
): Effect.Effect<readonly WorkThreadEvent[], UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadEvents', (db) => {
    const ids = [...new Set('threadIds' in input ? input.threadIds : [input.threadId])];
    if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
      return invalidInput('Invalid work thread event scope');
    }
    return db
      .query(`SELECT event_json FROM (
          SELECT thread_id, event_json, at, rowid AS sequence,
            ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY at DESC, rowid DESC) AS rank
          FROM work_thread_events WHERE thread_id IN (SELECT value FROM json_each(?))
        ) WHERE rank <= ? ORDER BY thread_id, at, sequence`)
      .all(JSON.stringify(ids), WORK_THREAD_BOUNDS.maxEventsPerThread)
      .map((value) => validated(parseWorkThreadEvent(json(record(value).event_json)), 'event'));
  });

export const countWorkThreads = (input: {
  readonly dbPath: string;
}): Effect.Effect<{ readonly done: number; readonly open: number }, UsageStoreError> =>
  read(input.dbPath, 'countWorkThreads', (db) => {
    const row = record(
      db
        .query(`SELECT COUNT(CASE WHEN follow_state = 'done' THEN 1 END) AS done,
        COUNT(CASE WHEN follow_state IN ('following', 'waiting') THEN 1 END) AS open FROM work_threads t
        WHERE ${notCombinedMemberSql('t')}`)
        .get(),
    );
    return {
      done: validated(typeof row.done === 'number' ? row.done : null, 'count'),
      open: validated(typeof row.open === 'number' ? row.open : null, 'count'),
    };
  });

export const queryWorkThreadProjects = (input: {
  readonly dbPath: string;
}): Effect.Effect<readonly string[], UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadProjects', (db) =>
    db
      .query(`SELECT DISTINCT project_label FROM (SELECT ${threadProjectSql('t')} AS project_label FROM work_threads t
      WHERE ${notCombinedMemberSql('t')}) WHERE project_label IS NOT NULL ORDER BY project_label LIMIT ?`)
      .all(WORK_THREAD_VIEW_BOUNDS.maxProjects)
      .map((value) =>
        validated(
          typeof record(value).project_label === 'string' ? String(record(value).project_label) : null,
          'project',
        ),
      ),
  );

/** Active combinations touching these tasks, kept or member, with both titles. */
export const queryWorkThreadCombinations = (
  input: QueryWorkThreadLinksInput,
): Effect.Effect<readonly WorkThreadCombination[], UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadCombinations', (db) => {
    const ids = [...new Set(input.threadIds)];
    if (ids.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize || !ids.every(isWorkThreadId)) {
      return invalidInput('Invalid work thread combination scope');
    }
    return db
      .query(
        `SELECT c.kept_thread_id, kept.title AS kept_title, c.member_thread_id, member.title AS member_title, c.ticket_key
          FROM work_thread_combinations c
          JOIN work_threads kept ON kept.thread_id = c.kept_thread_id
          JOIN work_threads member ON member.thread_id = c.member_thread_id
          WHERE c.separated_at IS NULL AND (c.kept_thread_id IN (SELECT value FROM json_each(?))
            OR c.member_thread_id IN (SELECT value FROM json_each(?)))
          ORDER BY c.combination_id`,
      )
      .all(JSON.stringify(ids), JSON.stringify(ids))
      .map((row): WorkThreadCombination => {
        const value = record(row);
        return {
          keptThreadId: String(value.kept_thread_id),
          keptTitle: String(value.kept_title),
          memberThreadId: String(value.member_thread_id),
          memberTitle: String(value.member_title),
          ticketKey: String(value.ticket_key),
        };
      });
  });

/**
 * Tickets followed by several open tasks, each with the task that would be kept and what blocks
 * the combination. Groups already combined into one task are not proposed again.
 */
export const queryWorkThreadCombineSuggestions = (input: {
  readonly dbPath: string;
  readonly machineId: string;
}): Effect.Effect<QueryWorkThreadCombineSuggestionsResult, UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadCombineSuggestions', (db) => {
    const items: WorkThreadCombineSuggestionEntry[] = [];
    let oversized = false;
    for (const [ticketKey, threads] of openTasksByTicket(db, input.machineId)) {
      const effective = new Set(threads.map((thread) => keptThreadIdOf(db, thread.threadId) ?? thread.threadId));
      const kept = keptThreadFor(threads, ticketKey);
      if (effective.size < 2 || !kept) {
        continue;
      }
      if (threads.length > WORK_THREAD_VIEW_BOUNDS.maxCombineParticipants) {
        oversized = true;
        continue;
      }
      items.push({
        blockers: combineBlockers(db, threads).slice(0, WORK_THREAD_VIEW_BOUNDS.maxCombineBlockers),
        keptThreadId: kept.threadId,
        participants: threads.map((thread) => {
          const links = db
            .query(
              `SELECT kind, link_key FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL
                AND kind IN ('pull-request', 'session')`,
            )
            .all(thread.threadId)
            .map(record);
          return {
            pullRequestKeys: links.filter((link) => link.kind === 'pull-request').map((link) => String(link.link_key)),
            sessionCount: links.filter((link) => link.kind === 'session').length,
            thread,
          };
        }),
        ticketKey,
      });
    }
    items.sort((left, right) => left.ticketKey.localeCompare(right.ticketKey));
    return {
      items: items.slice(0, WORK_THREAD_VIEW_BOUNDS.maxCombineSuggestions),
      truncated: oversized || items.length > WORK_THREAD_VIEW_BOUNDS.maxCombineSuggestions,
    };
  });
