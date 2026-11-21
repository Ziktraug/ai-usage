import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import { jiraKeysInBranch } from '@ai-usage/report-core/work-attention-facts';
import {
  isBranchRefName,
  jiraIssueLinkKey,
  parseWorkThreadLinkKey,
  SHARED_BRANCH_NAMES,
  WORK_THREAD_BOUNDS,
} from '@ai-usage/report-core/work-thread';
import type { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { readWorkSessionDelegations } from './work-session-join';
import { effectiveThread, jiraKeyFollowers } from './work-thread-combination';
import {
  activeLinkCount,
  addEvent,
  addLink,
  evidenceText,
  hasKnownWorkThreadLink,
  instant,
  newThread,
  readThread,
  record,
  type SqliteDatabase,
  saveThread,
  validated,
  write,
} from './work-thread-rows';

// ---------------------------------------------------------------------------------------------
// Branch evidence (ADR 0081). A session's harness records its repository and branch; a task holds
// the branch as a link. Sessions on that branch read as the task's, except delegated ones (nested
// under their parent) and the ones the operator detached.
// ---------------------------------------------------------------------------------------------

/** Sessions one task reads through its branches; older ones are left out and reported truncated. */
export const MAX_BRANCH_SESSIONS_PER_TASK = 60;
/** Only sessions this recent create a task; older history joins existing tasks only. */
const BRANCH_TASK_CREATION_WINDOW_DAYS = 21;
const MAX_BRANCH_TASKS_PER_RUN = 25;
const MAX_HEAD_BRANCH_LINKS = 500;
const MAX_BRANCH_CANDIDATES = 500;

export interface ReconcileWorkBranchesInput {
  readonly dbPath: string;
  /** Resolves the default branch a checkout's `origin` names (`refs/remotes/origin/HEAD`), if known. */
  readonly defaultBranchOf?: (sourcePath: string) => string | null;
  /** SSH host alias → host, so `github-perso.com` remotes compare with `github.com` pull requests. */
  readonly hostAliases?: Readonly<Record<string, string>>;
  readonly machineId: string;
  readonly now: string;
  /** Branch names the operator's config declares shared, besides the conventional ones. */
  readonly sharedBranches?: readonly string[];
}

export interface ReconcileWorkBranchesResult {
  /** Branch links added to existing tasks: from a PR's head branch, or a ticket the branch names. */
  readonly branchLinks: number;
  readonly created: number;
  readonly indexed: boolean;
  /** Candidate branches left without a task: shared, a PR base, or no interactive session. */
  readonly suppressed: number;
  readonly truncated: boolean;
}

const currentServedRevision = (db: SqliteDatabase): string | null => {
  const value = db
    .query(`SELECT revisions.revision FROM served_report_current current
      JOIN served_report_revisions revisions USING(revision) WHERE current.singleton = 1 AND revisions.complete = 1`)
    .get();
  return value === null ? null : validated(evidenceText(record(value).revision, 512), 'served revision');
};

const sessionBranchRole = (row: Record<string, unknown>, delegatedBy: string | undefined): string => {
  if (row.origin === 'classifier') {
    return 'review';
  }
  if (row.origin === 'subagent' || typeof row.parent === 'string' || delegatedBy !== undefined) {
    return 'delegated';
  }
  if (row.launch_mode === 'exec') {
    return 'exec';
  }
  // Codex says how a run started; a row without it (an older collection) cannot create a task.
  if (row.harness === 'codex' && row.launch_mode !== 'interactive') {
    return 'unknown';
  }
  return row.origin === 'human' ? 'interactive' : 'unknown';
};

/** Rebuilds the index for `revision` unless it already exists for the same host aliases. */
const rebuildSessionBranches = (
  db: SqliteDatabase,
  revision: string,
  aliases: Readonly<Record<string, string>>,
  now: CanonicalInstant,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
): boolean => {
  const aliasesJson = JSON.stringify(Object.entries(aliases).sort(([left], [right]) => left.localeCompare(right)));
  const built = db.query('SELECT aliases_json FROM work_session_branch_builds WHERE revision = ?').get(revision);
  if (built !== null && record(built).aliases_json === aliasesJson) {
    return false;
  }
  db.query('DELETE FROM work_session_branches').run();
  db.query('DELETE FROM work_session_branch_builds').run();
  // A Claude session titled after its id reads better under its Desktop title, when it has one.
  const desktopTitles = new Map<string, string>();
  for (const value of db
    .query(`SELECT machine_id, cli_session_id, title FROM claude_desktop_sessions
      UNION ALL SELECT desktop.machine_id, prior.value, desktop.title
      FROM claude_desktop_sessions desktop, json_each(desktop.prior_cli_session_ids_json) prior`)
    .all()) {
    const row = record(value);
    if (typeof row.title === 'string' && row.title.trim()) {
      desktopTitles.set(`${String(row.machine_id)}/${String(row.cli_session_id)}`, row.title.trim());
    }
  }
  // A `codex exec` a Claude session launched is listed on the parent only; invert that edge first.
  const delegatedBy = new Map<string, string>();
  for (const value of db
    .query(`SELECT machine_id, json_extract(source_row_json, '$.source.sourceSessionId') AS parent,
        json_extract(source_row_json, '$.source.delegatedSessions') AS delegated
      FROM served_report_rows WHERE revision = ? AND json_type(source_row_json, '$.source.delegatedSessions') = 'array'`)
    .all(revision)) {
    const row = record(value);
    for (const child of readWorkSessionDelegations(row.delegated).delegatedSessions) {
      delegatedBy.set(`${String(row.machine_id)}/${child.harness}/${child.sourceSessionId}`, String(row.parent));
    }
  }
  const insert = db.query(`INSERT OR IGNORE INTO work_session_branches(revision, link_key, machine_id, harness,
    session_id, role, repository_label, started_at, title, source_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A partial context (several repositories, truncated spans) is no evidence of where work happened.
  for (const value of db
    .query(`SELECT machine_id, json_extract(source_row_json, '$.source.harnessKey') AS harness,
        json_extract(source_row_json, '$.source.sourceSessionId') AS session_id,
        json_extract(source_row_json, '$.source.parentSourceSessionId') AS parent,
        json_extract(source_row_json, '$.origin') AS origin,
        json_extract(source_row_json, '$.source.launchMode') AS launch_mode,
        json_extract(source_row_json, '$.source.vcs.repository.host') AS host,
        json_extract(source_row_json, '$.source.vcs.repository.ownerPath') AS owner_path,
        json_extract(source_row_json, '$.source.vcs.branches') AS branches,
        json_extract(source_row_json, '$.source.sourcePath') AS source_path,
        json_extract(source_row_json, '$.date') AS started_at,
        json_extract(source_row_json, '$.sessionLabel') AS title,
        json_extract(source_row_json, '$.titleSource') AS title_source
      FROM served_report_rows WHERE revision = ?
        AND json_extract(source_row_json, '$.source.vcs.partial') = 0
        AND json_extract(source_row_json, '$.source.vcs.repository.host') IS NOT NULL
        AND json_array_length(json_extract(source_row_json, '$.source.vcs.branches')) > 0`)
    .all(revision)) {
    const row = record(value);
    if (
      typeof row.harness !== 'string' ||
      typeof row.session_id !== 'string' ||
      typeof row.host !== 'string' ||
      typeof row.owner_path !== 'string' ||
      typeof row.branches !== 'string'
    ) {
      continue;
    }
    const machineId = String(row.machine_id);
    const host = row.host.toLowerCase();
    const role = sessionBranchRole(row, delegatedBy.get(`${machineId}/${row.harness}/${row.session_id}`));
    const names = new Set<string>();
    const spans: unknown = JSON.parse(row.branches);
    for (const span of Array.isArray(spans) ? spans : []) {
      if (isRecord(span) && typeof span.name === 'string' && isBranchRefName(span.name)) {
        names.add(span.name);
      }
    }
    for (const name of names) {
      const key = `branch:${aliases[host] ?? host}/${row.owner_path.toLowerCase()}@${name}`;
      if (parseWorkThreadLinkKey('branch', key) === null) {
        continue;
      }
      insert.run(
        revision,
        key,
        machineId,
        row.harness,
        row.session_id,
        role,
        row.owner_path,
        normalizeIsoTimestamp(row.started_at),
        // A title made from the session id says nothing; the Desktop title or the branch reads better.
        (typeof row.title === 'string' && row.title_source !== 'id'
          ? row.title
          : (desktopTitles.get(`${machineId}/${row.session_id}`) ?? null)
        )?.slice(0, WORK_THREAD_BOUNDS.maxTitle) ?? null,
        typeof row.source_path === 'string' ? row.source_path : null,
      );
    }
  }
  db.query('INSERT INTO work_session_branch_builds(revision, built_at, aliases_json) VALUES (?, ?, ?)').run(
    revision,
    now,
    aliasesJson,
  );
  return true;
};

interface BranchCandidate {
  readonly firstAt: CanonicalInstant;
  readonly key: string;
  readonly repositoryLabel: string;
  readonly sourcePath: string | null;
  readonly title: string | null;
}

/**
 * Branch evidence (ADR 0081), in one writer transaction: index the served revision's recorded
 * branches, give PR tasks their head branch, then route or create a task for each branch with
 * recent interactive work. Bounded; whatever is left over is reported truncated, never dropped.
 */
export const reconcileWorkBranches = (
  input: ReconcileWorkBranchesInput,
): Effect.Effect<ReconcileWorkBranchesResult, UsageStoreError> =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
  write(input.dbPath, 'reconcileWorkBranches', (db) => {
    const now = instant(input.now);
    const aliases: Record<string, string> = {};
    for (const [alias, host] of Object.entries(input.hostAliases ?? {})) {
      aliases[alias.toLowerCase()] = host.toLowerCase();
    }
    const shared = new Set([...SHARED_BRANCH_NAMES, ...(input.sharedBranches ?? [])]);
    const result = { branchLinks: 0, created: 0, indexed: false, suppressed: 0, truncated: false };
    const revision = currentServedRevision(db);
    if (revision === null) {
      return result;
    }
    result.indexed = rebuildSessionBranches(db, revision, aliases, now);

    // 1. A followed PR names its head branch: the task holds it, unless a fork's or vetoed.
    const heads = db
      .query(`WITH latest AS (
          SELECT lower(host) AS host, lower(repository) AS repository, number, head_ref, cross_repository,
            ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
          FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
        )
        SELECT l.thread_id, l.link_key AS pull_request_key, latest.host, latest.repository, latest.head_ref
        FROM work_thread_links l JOIN work_threads t ON t.thread_id = l.thread_id AND t.machine_id = ?
        JOIN latest ON latest.rank = 1 AND lower(l.link_key) = latest.host || '/' || latest.repository || '#' || latest.number
        WHERE l.kind = 'pull-request' AND l.detached_at IS NULL AND latest.cross_repository = 0
          AND latest.head_ref IS NOT NULL
        ORDER BY l.created_at, l.link_id LIMIT ?`)
      .all(input.machineId, input.machineId, MAX_HEAD_BRANCH_LINKS + 1)
      .map(record);
    result.truncated ||= heads.length > MAX_HEAD_BRANCH_LINKS;
    for (const head of heads.slice(0, MAX_HEAD_BRANCH_LINKS)) {
      const ref = String(head.head_ref);
      const key = `branch:${String(head.host)}/${String(head.repository)}@${ref}`;
      if (
        !isBranchRefName(ref) ||
        shared.has(ref) ||
        parseWorkThreadLinkKey('branch', key) === null ||
        hasKnownWorkThreadLink(db, 'branch', key)
      ) {
        continue;
      }
      const task = effectiveThread(db, validated(readThread(db, String(head.thread_id)), 'PR task'));
      if (activeLinkCount(db, task.threadId) >= WORK_THREAD_BOUNDS.maxLinksPerThread) {
        result.truncated = true;
        continue;
      }
      addLink(db, { createdAt: now, key, kind: 'branch', provenance: 'declared', threadId: task.threadId });
      addEvent(db, task, now, 'link-added', {
        linkKey: key,
        reason: `Head branch of ${String(head.pull_request_key)}`,
      });
      result.branchLinks++;
    }

    // 2. A branch with recent interactive work and no task: route it to its ticket, or create one.
    if (db.query('SELECT 1 FROM work_branch_reconciliation WHERE machine_id = ?').get(input.machineId) === null) {
      // The window is fixed when the feature first runs: older history never creates a task later.
      const cutoff = new Date(Date.parse(now) - BRANCH_TASK_CREATION_WINDOW_DAYS * 86_400_000).toISOString();
      db.query('INSERT INTO work_branch_reconciliation(machine_id, creation_cutoff_at) VALUES (?, ?)').run(
        input.machineId,
        cutoff,
      );
    }
    const cutoff = String(
      record(
        db.query('SELECT creation_cutoff_at FROM work_branch_reconciliation WHERE machine_id = ?').get(input.machineId),
      ).creation_cutoff_at,
    );
    // A branch some observed PR has as its head is that PR's work: it waits for the PR's task to
    // hold it (once GitHub says the head is not a fork) rather than becoming a second task.
    const pullRequestHeads = new Set(
      db
        .query(`SELECT DISTINCT lower(host) || '/' || lower(repository) || '@' || head_ref AS head
            FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed' AND head_ref IS NOT NULL
              AND (cross_repository IS NULL OR cross_repository = 0)`)
        .all(input.machineId)
        .map((row) => String(record(row).head)),
    );
    const openBases = new Set(
      db
        .query(`WITH latest AS (
            SELECT lower(host) AS host, lower(repository) AS repository, base_ref, state,
              ROW_NUMBER() OVER (PARTITION BY lower(host), lower(repository), number ORDER BY observed_at DESC, id DESC) AS rank
            FROM pull_request_observations WHERE machine_id = ? AND outcome = 'observed'
          ) SELECT host || '/' || repository || '@' || base_ref AS base FROM latest
            WHERE rank = 1 AND state = 'OPEN' AND base_ref IS NOT NULL`)
        .all(input.machineId)
        .map((row) => String(record(row).base)),
    );
    const candidates = db
      .query(`WITH ranked AS (
          SELECT link_key, started_at, repository_label, title, source_path,
            ROW_NUMBER() OVER (PARTITION BY link_key ORDER BY started_at, session_id) AS rank
          FROM work_session_branches
          WHERE revision = ? AND machine_id = ? AND role = 'interactive' AND started_at >= ?
        ) SELECT * FROM ranked WHERE rank = 1 ORDER BY started_at, link_key LIMIT ?`)
      .all(revision, input.machineId, cutoff, MAX_BRANCH_CANDIDATES + 1)
      .map((value): BranchCandidate => {
        const row = record(value);
        return {
          firstAt: validated(normalizeIsoTimestamp(row.started_at), 'branch session start'),
          key: String(row.link_key),
          repositoryLabel: String(row.repository_label),
          sourcePath: typeof row.source_path === 'string' ? row.source_path : null,
          title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null,
        };
      });
    result.truncated ||= candidates.length > MAX_BRANCH_CANDIDATES;
    const defaults = new Map<string, string | null>();
    const defaultBranchOf = (sourcePath: string | null): string | null => {
      if (sourcePath === null || input.defaultBranchOf === undefined) {
        return null;
      }
      if (!defaults.has(sourcePath)) {
        defaults.set(sourcePath, input.defaultBranchOf(sourcePath));
      }
      return defaults.get(sourcePath) ?? null;
    };
    let created = 0;
    for (const candidate of candidates.slice(0, MAX_BRANCH_CANDIDATES)) {
      const parsed = parseWorkThreadLinkKey('branch', candidate.key);
      if (parsed?.kind !== 'branch' || hasKnownWorkThreadLink(db, 'branch', candidate.key)) {
        continue;
      }
      // Exclusions only stop creation; a session on such a branch still joins a task holding it.
      const branchOfRepository = `${parsed.host}/${parsed.repository}@${parsed.ref}`;
      if (
        shared.has(parsed.ref) ||
        defaultBranchOf(candidate.sourcePath) === parsed.ref ||
        openBases.has(branchOfRepository) ||
        pullRequestHeads.has(branchOfRepository)
      ) {
        result.suppressed++;
        continue;
      }
      const ticketKeys = jiraKeysInBranch(parsed.ref);
      const [ticket] = ticketKeys;
      const routingKey =
        ticketKeys.length === 1 && ticket !== undefined ? jiraIssueLinkKey({ key: ticket, site: 'default' }) : null;
      const followers = routingKey === null ? null : jiraKeyFollowers(db, input.machineId, routingKey);
      const [follower] = followers?.open ?? [];
      if (
        followers?.open.length === 1 &&
        follower &&
        activeLinkCount(db, follower.threadId) < WORK_THREAD_BOUNDS.maxLinksPerThread
      ) {
        addLink(db, {
          createdAt: now,
          key: candidate.key,
          kind: 'branch',
          provenance: 'declared',
          threadId: follower.threadId,
        });
        addEvent(db, follower, now, 'link-added', { linkKey: candidate.key, reason: `Branch names ${ticket}` });
        result.branchLinks++;
        continue;
      }
      if (created >= MAX_BRANCH_TASKS_PER_RUN) {
        result.truncated = true;
        continue;
      }
      const thread = newThread({
        intent: 'change',
        machineId: input.machineId,
        now: candidate.firstAt,
        objective: null,
        origin: 'session',
        originKey: candidate.key,
        projectLabel: candidate.repositoryLabel.slice(0, WORK_THREAD_BOUNDS.maxTitle),
        title: (candidate.title ?? parsed.ref).slice(0, WORK_THREAD_BOUNDS.maxTitle),
      });
      saveThread(db, { ...thread, updatedAt: now });
      addLink(db, {
        createdAt: candidate.firstAt,
        key: candidate.key,
        kind: 'branch',
        provenance: 'origin',
        threadId: thread.threadId,
      });
      addEvent(db, thread, candidate.firstAt, 'created', {
        toState: 'following',
        reason: `Sessions recorded branch ${parsed.ref}`,
      });
      if (routingKey !== null && followers?.open.length === 0 && followers.done === 0) {
        addLink(db, {
          createdAt: candidate.firstAt,
          key: routingKey,
          kind: 'jira-issue',
          provenance: 'declared',
          threadId: thread.threadId,
        });
        addEvent(db, thread, candidate.firstAt, 'link-added', {
          linkKey: routingKey,
          reason: `Branch names ${ticket}`,
        });
      }
      created++;
    }
    result.created = created;
    return result;
  });
