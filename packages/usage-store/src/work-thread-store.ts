// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127
import { createHash } from 'node:crypto';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import { jiraKeysInBranch } from '@ai-usage/report-core/work-attention-facts';
import {
  isBranchRefName,
  isWorkThreadId,
  jiraIssueLinkKey,
  parseWorkThreadLink,
  parseWorkThreadLinkKey,
  SHARED_BRANCH_NAMES,
  WORK_THREAD_BOUNDS,
  type WorkThread,
  type WorkThreadIntent,
  type WorkThreadLink,
  type WorkThreadLinkKind,
} from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_VIEW_BOUNDS } from '@ai-usage/report-core/work-thread-view';
import { Effect } from 'effect';
import { withUsageStoreReader } from './connections';
import { type UsageStoreError, usageStoreReadError } from './errors';
import { MAX_WORK_DELEGATIONS_JSON, readWorkSessionDelegations } from './work-session-join';
import { effectiveThread, jiraKeyFollowers, memberThreadIdsOf } from './work-thread-combination';
import { BRANCH_ROOT_ROLES, BRANCH_SESSION_KEY_SQL, branchSessionVetoSql } from './work-thread-reads';
import {
  activeLinkCount,
  addEvent,
  addLink,
  canonicalLinkKey,
  comparableLinkSql,
  evidenceText,
  hasKnownWorkThreadLink,
  instant,
  invalidInput,
  newThread,
  readThread,
  record,
  type SqliteDatabase,
  saveThread,
  taskThreadsSql,
  threadFromRecord,
  validated,
  write,
} from './work-thread-rows';

export interface WorkThreadSeed {
  /** The PR's head branch key, when in its own repository: joins the task holding it (ADR 0081). */
  readonly branchKey?: string | null;
  readonly discoveredAt: string;
  readonly intent: WorkThreadIntent | null;
  readonly linkKind: WorkThreadLinkKind;
  readonly origin: 'pull-request' | 'jira-issue' | 'session';
  readonly originKey: string;
  readonly projectLabel: string | null;
  /** `jira:<site>/<KEY>` an authored PR's head branch names; routes the PR to that ticket's task. */
  readonly routingJiraKey?: string | null;
  readonly title: string;
}

interface SeedWorkThreadsInput {
  readonly dbPath: string;
  readonly declarations?: readonly DeclaredWorkThreadSession[];
  /** Incomplete discovery cannot establish a unique candidate. */
  readonly declarationsTruncated?: boolean;
  readonly machineId: string;
  readonly now: string;
  /** Successfully observed links may enrich a candidate even without author/review discovery. */
  readonly observedPullRequestKeys?: readonly string[];
  readonly seeds: readonly WorkThreadSeed[];
}

interface SeedWorkThreadsResult {
  readonly created: number;
  readonly existing: number;
  readonly uncertain: number;
}

export interface DeclaredWorkThreadSession {
  readonly provenance?: 'session-pr-link';
  readonly pullRequestKey: string;
  readonly sessionKey: string;
}

export interface AttachDeclaredWorkThreadSessionsInput {
  readonly dbPath: string;
  readonly declarations: readonly DeclaredWorkThreadSession[];
  readonly machineId: string;
  readonly now: string;
}

export interface AttachDeclaredWorkThreadSessionsResult {
  readonly detached: number;
  readonly existing: number;
  readonly linked: number;
  readonly truncated: boolean;
}

const MAX_DECLARED_SESSION_LINKS = 500;

const attachReconciledPullRequest = (
  db: SqliteDatabase,
  task: WorkThread,
  key: string,
  now: CanonicalInstant,
): void => {
  addLink(db, { threadId: task.threadId, kind: 'pull-request', key, provenance: 'declared', createdAt: now });
  saveThread(db, { ...task, updatedAt: now });
  addEvent(db, task, now, 'link-added', { linkKey: key });
};

const branchEvidence = (linkKey: string): string => `Head branch names ${linkKey.slice(linkKey.lastIndexOf('/') + 1)}`;

/** The single open task holding a branch, as its kept task; none when several do or only Done ones. */
const openBranchHolder = (db: SqliteDatabase, branchKey: string): WorkThread | null => {
  const holders = new Map<string, WorkThread>();
  for (const row of db
    .query(`SELECT t.* FROM work_threads t WHERE t.origin_key = ? OR EXISTS (
      SELECT 1 FROM work_thread_links l WHERE l.thread_id = t.thread_id AND l.kind = 'branch'
        AND ${comparableLinkSql('branch')} = ? AND l.detached_at IS NULL)`)
    .all(branchKey, branchKey)) {
    const task = effectiveThread(db, threadFromRecord(row));
    holders.set(task.threadId, task);
  }
  const [holder] = holders.values();
  return holders.size === 1 && holder !== undefined && holder.followState !== 'done' ? holder : null;
};

/** Reuse only an unambiguous, operator-linked session task with no prior PR association. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
const reconciliationCandidates = (db: SqliteDatabase, input: SeedWorkThreadsInput): Map<string, WorkThread | null> => {
  const result = new Map<string, WorkThread | null>();
  const declarations = input.declarations ?? [];
  const incomplete = declarations.length > MAX_DECLARED_SESSION_LINKS || input.declarationsTruncated;
  const seedKeys = new Set(
    input.seeds
      .filter((seed) => seed.origin === 'pull-request')
      .map((seed) => canonicalLinkKey(seed.linkKind, seed.originKey)),
  );
  for (const key of input.observedPullRequestKeys ?? []) {
    const canonical = canonicalLinkKey('pull-request', key);
    if (!parseWorkThreadLinkKey('pull-request', canonical)) {
      return invalidInput('Observed PR identities must be qualified');
    }
    seedKeys.add(canonical);
  }
  const byPullRequest = new Map<string, { all: Set<string>; strong: Set<string> }>();
  for (const declaration of declarations.slice(0, MAX_DECLARED_SESSION_LINKS)) {
    const session = parseWorkThreadLinkKey('session', declaration.sessionKey);
    const key = canonicalLinkKey('pull-request', declaration.pullRequestKey);
    if (
      session?.kind !== 'session' ||
      session.machineId !== input.machineId ||
      !parseWorkThreadLinkKey('pull-request', key)
    ) {
      return invalidInput('Reconciliation requires qualified same-machine declarations');
    }
    const group = byPullRequest.get(key) ?? { all: new Set<string>(), strong: new Set<string>() };
    group.all.add(declaration.sessionKey);
    if (declaration.provenance === 'session-pr-link' && session.harness === 'claude') {
      group.strong.add(declaration.sessionKey);
    }
    byPullRequest.set(key, group);
  }
  for (const [key, group] of byPullRequest) {
    if (!seedKeys.has(key) || hasKnownWorkThreadLink(db, 'pull-request', key)) {
      continue;
    }
    const tasks = new Map<string, WorkThread>();
    const strongTasks = new Set<string>();
    for (const sessionKey of group.all) {
      const matches = db
        .query(
          `SELECT t.* FROM work_threads t WHERE t.machine_id = ? AND EXISTS (
          SELECT 1 FROM work_thread_links s WHERE s.thread_id = t.thread_id AND s.kind = 'session'
          AND s.link_key = ? AND s.detached_at IS NULL) ORDER BY t.thread_id LIMIT 2`,
        )
        .all(input.machineId, sessionKey);
      for (const value of matches) {
        const task = effectiveThread(db, threadFromRecord(value));
        tasks.set(task.threadId, task);
        if (group.strong.has(sessionKey)) {
          strongTasks.add(task.threadId);
        }
      }
    }
    if (tasks.size === 0) {
      continue;
    }
    const task = tasks.size === 1 ? [...tasks.values()][0] : undefined;
    const priorPR =
      task &&
      db
        .query("SELECT 1 FROM work_thread_links WHERE thread_id = ? AND kind = 'pull-request' LIMIT 1")
        .get(task.threadId);
    const active =
      task &&
      record(
        db
          .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
          .get(task.threadId),
      ).count;
    result.set(
      key,
      !incomplete &&
        task &&
        strongTasks.has(task.threadId) &&
        priorPR === null &&
        typeof active === 'number' &&
        active < WORK_THREAD_BOUNDS.maxLinksPerThread
        ? task
        : null,
    );
  }
  // Reserve the whole batch per task; never choose one PR arbitrarily when capacity is insufficient.
  const additions = new Map<string, number>();
  for (const task of result.values()) {
    if (task) {
      additions.set(task.threadId, (additions.get(task.threadId) ?? 0) + 1);
    }
  }
  for (const [key, task] of result) {
    if (!task) {
      continue;
    }
    const active = record(
      db
        .query('SELECT COUNT(*) AS count FROM work_thread_links WHERE thread_id = ? AND detached_at IS NULL')
        .get(task.threadId),
    ).count;
    if (
      typeof active !== 'number' ||
      active + (additions.get(task.threadId) ?? 0) > WORK_THREAD_BOUNDS.maxLinksPerThread
    ) {
      result.set(key, null);
    }
  }
  return result;
};

// ---------------------------------------------------------------------------------------------
// Branch evidence (ADR 0081). A session's harness records its repository and branch; a task holds
// the branch as a link. Sessions on that branch read as the task's, except delegated ones (nested
// under their parent) and the ones the operator detached.
// ---------------------------------------------------------------------------------------------

/** Sessions one task reads through its branches; older ones are left out and reported truncated. */
const MAX_BRANCH_SESSIONS_PER_TASK = 60;
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

/** Stable per task and session, so a derived row keeps its identity across reads. */
const derivedLinkId = (threadId: string, key: string): string => {
  const hex = createHash('sha256').update(`${threadId}\n${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The sessions a task reads through its active branch links: newest first, bounded, vetoes applied. */
const branchSessionLinks = (
  db: SqliteDatabase,
  scope: Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'> & { readonly threadId: string },
): { readonly links: readonly WorkThreadLink[]; readonly truncated: boolean } => {
  const branchKeys = [
    ...new Set(
      scope.links
        .filter((link) => link.kind === 'branch' && link.detachedAt === null)
        .map((link) => canonicalLinkKey('branch', link.key)),
    ),
  ];
  if (
    branchKeys.length === 0 ||
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'work_session_branches'").get() === null
  ) {
    return { links: [], truncated: false };
  }
  const linked = new Set(scope.links.filter((link) => link.kind === 'session').map((link) => link.key));
  const rows = db
    .query(`SELECT ${BRANCH_SESSION_KEY_SQL} AS session_key, MIN(sb.started_at) AS started_at
      FROM work_session_branches sb, (SELECT ? AS thread_id) t
      WHERE sb.link_key IN (SELECT value FROM json_each(?)) AND sb.machine_id = ? AND sb.role IN ${BRANCH_ROOT_ROLES}
        AND ${branchSessionVetoSql('t', BRANCH_SESSION_KEY_SQL)}
      GROUP BY sb.machine_id, sb.harness, sb.session_id
      ORDER BY MIN(sb.started_at) DESC, session_key LIMIT ?`)
    .all(scope.threadId, JSON.stringify(branchKeys), scope.machineId, MAX_BRANCH_SESSIONS_PER_TASK + linked.size + 1)
    .map(record)
    .filter((row) => !linked.has(String(row.session_key)));
  return {
    truncated: rows.length > MAX_BRANCH_SESSIONS_PER_TASK,
    links: rows.slice(0, MAX_BRANCH_SESSIONS_PER_TASK).map((row) =>
      validated(
        parseWorkThreadLink({
          createdAt: normalizeIsoTimestamp(row.started_at) ?? '1970-01-01T00:00:00.000Z',
          detachedAt: null,
          key: row.session_key,
          kind: 'session',
          linkId: derivedLinkId(scope.threadId, String(row.session_key)),
          provenance: 'declared',
          threadId: scope.threadId,
        }),
        'branch session',
      ),
    ),
  };
};

interface BranchCandidate {
  readonly firstAt: CanonicalInstant;
  readonly key: string;
  readonly repositoryLabel: string;
  readonly sourcePath: string | null;
  readonly title: string | null;
}

export const seedWorkThreads = (input: SeedWorkThreadsInput): Effect.Effect<SeedWorkThreadsResult, UsageStoreError> =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
  write(input.dbPath, 'seedWorkThreads', (db) => {
    const now = instant(input.now);
    let created = 0;
    let existing = 0;
    let uncertain = 0;
    // Compute every candidate before adding any PR: batch order cannot change identity.
    const candidates = reconciliationCandidates(db, input);
    for (const seed of input.seeds) {
      const originKey = canonicalLinkKey(seed.linkKind, seed.originKey);
      if (seed.origin !== seed.linkKind || !parseWorkThreadLinkKey(seed.linkKind, originKey)) {
        return invalidInput('Seed origin and qualified link key must match');
      }
      if (hasKnownWorkThreadLink(db, seed.linkKind, originKey)) {
        existing++;
        continue;
      }
      const candidate = candidates.get(originKey);
      if (candidate === null) {
        uncertain++;
      }
      if (candidate) {
        attachReconciledPullRequest(db, candidate, originKey, now);
        existing++;
        continue;
      }
      const branchKey = seed.branchKey ? canonicalLinkKey('branch', seed.branchKey) : null;
      if (branchKey !== null && !parseWorkThreadLinkKey('branch', branchKey)) {
        return invalidInput('A PR head branch key must be qualified');
      }
      // Branch equality is stronger evidence than a ticket key: the PR is that branch's work.
      const branchHolder = branchKey === null || seed.intent === 'review' ? null : openBranchHolder(db, branchKey);
      if (branchHolder !== null && activeLinkCount(db, branchHolder.threadId) < WORK_THREAD_BOUNDS.maxLinksPerThread) {
        addLink(db, {
          createdAt: now,
          key: originKey,
          kind: 'pull-request',
          provenance: 'declared',
          threadId: branchHolder.threadId,
        });
        saveThread(db, { ...branchHolder, updatedAt: now });
        addEvent(db, branchHolder, now, 'link-added', {
          linkKey: originKey,
          reason: `Head branch ${branchKey?.slice(branchKey.indexOf('@') + 1)}`,
        });
        existing++;
        continue;
      }
      const routingKey =
        seed.origin === 'pull-request' && seed.routingJiraKey
          ? canonicalLinkKey('jira-issue', seed.routingJiraKey)
          : null;
      if (routingKey !== null && !parseWorkThreadLinkKey('jira-issue', routingKey)) {
        return invalidInput('A routing Jira key must be qualified');
      }
      // One ticket, one delivery task: an authored PR joins the single open task that follows
      // its branch's ticket. Several followers, or a Done one, stay visible as separate tasks.
      const followers = routingKey === null ? null : jiraKeyFollowers(db, input.machineId, routingKey);
      const [joined] = followers?.open ?? [];
      if (
        routingKey !== null &&
        followers?.open.length === 1 &&
        joined &&
        activeLinkCount(db, joined.threadId) < WORK_THREAD_BOUNDS.maxLinksPerThread
      ) {
        addLink(db, {
          createdAt: now,
          key: originKey,
          kind: 'pull-request',
          provenance: 'declared',
          threadId: joined.threadId,
        });
        saveThread(db, { ...joined, updatedAt: now });
        addEvent(db, joined, now, 'link-added', { linkKey: originKey, reason: branchEvidence(routingKey) });
        existing++;
        continue;
      }
      const discoveredAt = instant(seed.discoveredAt);
      const thread = newThread({
        ...seed,
        originKey,
        machineId: input.machineId,
        now: discoveredAt,
        objective: null,
      });
      saveThread(db, { ...thread, updatedAt: now });
      addLink(db, {
        createdAt: discoveredAt,
        key: originKey,
        kind: seed.linkKind,
        provenance: 'origin',
        threadId: thread.threadId,
      });
      addEvent(db, thread, discoveredAt, 'created', { toState: 'following' });
      if (branchKey !== null && !hasKnownWorkThreadLink(db, 'branch', branchKey)) {
        addLink(db, {
          createdAt: discoveredAt,
          key: branchKey,
          kind: 'branch',
          provenance: 'declared',
          threadId: thread.threadId,
        });
      }
      if (routingKey !== null && followers?.open.length === 0 && followers.done === 0) {
        // The new task now follows the ticket, so later PRs and the Jira intake find it.
        addLink(db, {
          createdAt: discoveredAt,
          key: routingKey,
          kind: 'jira-issue',
          provenance: 'declared',
          threadId: thread.threadId,
        });
        addEvent(db, thread, discoveredAt, 'link-added', { linkKey: routingKey, reason: branchEvidence(routingKey) });
      }
      created++;
    }
    // Observation-only PRs never create a task. They may still enrich a proven followed session.
    const seededKeys = new Set(input.seeds.map((seed) => canonicalLinkKey(seed.linkKind, seed.originKey)));
    for (const [key, candidate] of candidates) {
      if (seededKeys.has(key) || hasKnownWorkThreadLink(db, 'pull-request', key)) {
        continue;
      }
      if (candidate === null) {
        uncertain++;
      } else {
        attachReconciledPullRequest(db, candidate, key, now);
        existing++;
      }
    }
    return { created, existing, uncertain };
  });

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

export const attachDeclaredWorkThreadSessions = (
  input: AttachDeclaredWorkThreadSessionsInput,
): Effect.Effect<AttachDeclaredWorkThreadSessionsResult, UsageStoreError> =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
  write(input.dbPath, 'attachDeclaredWorkThreadSessions', (db) => {
    const now = instant(input.now);
    const declarations = new Map<string, DeclaredWorkThreadSession>();
    for (const declaration of input.declarations.slice(0, MAX_DECLARED_SESSION_LINKS)) {
      const pullRequestKey = canonicalLinkKey('pull-request', declaration.pullRequestKey);
      const session = parseWorkThreadLinkKey('session', declaration.sessionKey);
      if (
        !parseWorkThreadLinkKey('pull-request', pullRequestKey) ||
        session?.kind !== 'session' ||
        session.machineId !== input.machineId
      ) {
        return invalidInput('Declared sessions require qualified pull request and same-machine session keys');
      }
      declarations.set(JSON.stringify([pullRequestKey, declaration.sessionKey]), {
        pullRequestKey,
        sessionKey: declaration.sessionKey,
      });
    }
    const result = {
      linked: 0,
      existing: 0,
      detached: 0,
      truncated: input.declarations.length > MAX_DECLARED_SESSION_LINKS,
    };
    for (const { pullRequestKey, sessionKey } of declarations.values()) {
      // Keep detached history as an operator-owned veto; a later poll may only fill previously absent links.
      const scope = `FROM work_threads t WHERE t.machine_id = ? AND EXISTS (
          SELECT 1 FROM work_thread_links p WHERE p.thread_id = t.thread_id
          AND p.kind = 'pull-request' AND lower(p.link_key) = ? AND p.detached_at IS NULL)`;
      const history = `SELECT 1 FROM work_thread_links s WHERE s.thread_id = t.thread_id
          AND s.kind = 'session' AND s.link_key = ?`;
      const activeCount =
        '(SELECT COUNT(*) FROM work_thread_links a WHERE a.thread_id = t.thread_id AND a.detached_at IS NULL)';
      const stats = record(
        db
          .query(`SELECT
          COUNT(CASE WHEN EXISTS (${history} AND s.detached_at IS NULL) THEN 1 END) AS existing,
          COUNT(CASE WHEN EXISTS (${history} AND s.detached_at IS NOT NULL) THEN 1 END) AS detached,
          COUNT(CASE WHEN NOT EXISTS (${history}) AND ${activeCount} >= ? THEN 1 END) AS full
          ${scope}`)
          .get(
            sessionKey,
            sessionKey,
            sessionKey,
            WORK_THREAD_BOUNDS.maxLinksPerThread,
            input.machineId,
            pullRequestKey,
          ),
      );
      result.existing += validated(typeof stats.existing === 'number' ? stats.existing : null, 'existing link count');
      result.detached += validated(typeof stats.detached === 'number' ? stats.detached : null, 'detached link count');
      result.truncated ||= validated(typeof stats.full === 'number' ? stats.full : null, 'full thread count') > 0;
      const remaining = MAX_DECLARED_SESSION_LINKS - result.linked;
      const candidates = db
        .query(`SELECT t.* ${scope} AND NOT EXISTS (${history})
          AND ${activeCount} < ? ORDER BY t.thread_id LIMIT ?`)
        .all(input.machineId, pullRequestKey, sessionKey, WORK_THREAD_BOUNDS.maxLinksPerThread, remaining + 1);
      result.truncated ||= candidates.length > remaining;
      for (const candidate of candidates.slice(0, remaining)) {
        // A combined task's sessions belong to the kept task; skip one that already holds it.
        const thread = effectiveThread(db, threadFromRecord(candidate));
        if (
          db
            .query(
              `SELECT 1 FROM work_thread_links WHERE kind = 'session' AND link_key = ?
                AND thread_id IN (SELECT value FROM json_each(?))`,
            )
            .get(sessionKey, JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)])) !== null
        ) {
          continue;
        }
        addLink(db, {
          threadId: thread.threadId,
          kind: 'session',
          key: sessionKey,
          provenance: 'declared',
          createdAt: now,
        });
        saveThread(db, { ...thread, updatedAt: now });
        addEvent(db, thread, now, 'link-added', { linkKey: sessionKey });
        result.linked++;
      }
    }
    return result;
  });

/** Exact linked-session evidence. Bounds apply after identity selection, never to a global recent list. */
export interface WorkThreadSessionEvidence {
  readonly branchCheckouts: readonly {
    readonly key: string;
    readonly machineId: string;
    readonly checkoutPath: string;
  }[];
  /** Sessions read through the task's branch links (ADR 0081), as links that are not stored. */
  readonly branchSessionLinks: readonly WorkThreadLink[];
  readonly generatedAt: CanonicalInstant | null;
  readonly revision: string | null;
  readonly sessions: readonly {
    readonly harness: string;
    /** Stored first-prompt excerpt only when the served row declares that title provenance. */
    readonly firstPrompt: string | null;
    readonly member: Omit<import('./work-session-join').ServedHarnessSessionMember, 'projectLabel' | 'rowId'> & {
      /** Native Desktop evidence has no served row or project label. */
      readonly projectLabel: string | null;
      readonly rowId: string | null;
    };
    readonly desktop: {
      readonly cliSessionId: string;
      readonly desktopSessionId: string;
      readonly archived: boolean;
      readonly format: string;
      readonly branch: string | null;
      readonly createdAt: CanonicalInstant;
      readonly cwd: string;
      readonly lastActivityAt: CanonicalInstant;
      readonly lastTurnReport: string | null;
      readonly observedAt: CanonicalInstant;
      readonly title: string;
      readonly turnSummary: { readonly needsAction: string | null; readonly detail: string } | null;
      readonly worktreePath: string | null;
    } | null;
  }[];
  readonly truncated: boolean;
}

export interface QueryWorkThreadSessionEvidenceInput {
  readonly dbPath: string;
  readonly links: readonly WorkThreadLink[];
  readonly machineId: string;
}

export interface QueryWorkThreadSessionEvidenceBatchInput {
  readonly dbPath: string;
  readonly threads: readonly {
    readonly threadId: string;
    readonly links: readonly WorkThreadLink[];
    readonly machineId: string;
  }[];
}

export interface WorkThreadSessionEvidenceBatchEntry {
  readonly evidence: WorkThreadSessionEvidence;
  readonly threadId: string;
}

const EVIDENCE_MEMBER_DETAILS = `
  CASE WHEN json_type(metadata.source_row_json, '$.source.delegatedSessions') IS NULL
      OR json_type(metadata.source_row_json, '$.source.delegatedSessions') = 'null' THEN NULL
    WHEN json_type(metadata.source_row_json, '$.source.delegatedSessions') = 'array'
      THEN substr(json_extract(metadata.source_row_json, '$.source.delegatedSessions'), 1, ${MAX_WORK_DELEGATIONS_JSON + 1})
    ELSE 'null' END AS delegated_sessions,
  json_extract(metadata.source_row_json, '$.source.sourcePath') AS checkout_path,
  json_extract(metadata.source_row_json, '$.source.vcs.branches[#-1].name') AS branch,
  json_extract(metadata.source_row_json, '$.date') AS started_at,
  json_extract(metadata.source_row_json, '$.endDate') AS ended_at,
  CASE WHEN json_type(metadata.source_row_json, '$.durationMs') IN ('integer', 'real')
    THEN json_extract(metadata.source_row_json, '$.durationMs') END AS duration_ms,
  json_extract(metadata.source_row_json, '$.sessionLabel') AS title,
  json_extract(metadata.source_row_json, '$.titleSource') AS title_source`;
const evidenceOptionalText = (value: unknown, maximum = 4096): string | null =>
  value === null || value === undefined ? null : validated(evidenceText(value, maximum), 'session metadata');

interface SessionEvidencePage {
  readonly branches: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly children: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly desktops: ReadonlyMap<string, Record<string, unknown>>;
  readonly generatedAt: CanonicalInstant | null;
  readonly nativeRoots: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly revision: string | null;
  readonly roots: ReadonlyMap<string, readonly Record<string, unknown>[]>;
}

const sessionEvidenceKey = (machineId: string, harness: string, sessionId: string): string =>
  `session:${machineId}/${harness}/${sessionId}`;

// A veto on any task of a combination holds for all of them (ADR 0080, 0081).
const nonDetachedSessionSql = (machine: string, harness: string, session: string): string => `NOT EXISTS (
  SELECT 1 FROM work_thread_links detached WHERE detached.thread_id IN ${taskThreadsSql('requested')}
    AND detached.kind = 'session' AND detached.detached_at IS NOT NULL
    AND detached.link_key = 'session:' || ${machine} || '/' || ${harness} || '/' || ${session}
    AND NOT EXISTS (SELECT 1 FROM work_thread_links relinked WHERE relinked.thread_id IN ${taskThreadsSql('requested')}
      AND relinked.kind = 'session' AND relinked.link_key = detached.link_key AND relinked.detached_at IS NULL)
)`;

const groupEvidenceRecords = (values: readonly unknown[]): Map<string, Record<string, unknown>[]> => {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const value of values) {
    const row = record(value);
    const key = validated(evidenceText(row.request_key), 'requested evidence key');
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  return grouped;
};

/** All page evidence uses one snapshot and a fixed number of identity-scoped SQL reads. */
const readSessionEvidencePage = (
  db: SqliteDatabase,
  scopes: readonly Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'>[],
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
): SessionEvidencePage => {
  for (const input of scopes) {
    if (
      input.links.length > WORK_THREAD_BOUNDS.maxLinksPerThread + MAX_BRANCH_SESSIONS_PER_TASK ||
      !input.machineId ||
      input.links.some((link) => parseWorkThreadLink(link) === null)
    ) {
      return invalidInput('Invalid linked session evidence scope');
    }
  }
  const nativeRequests = new Map<string, readonly string[]>();
  for (const scope of scopes) {
    for (const link of scope.links) {
      const parsed = link.detachedAt === null ? parseWorkThreadLinkKey(link.kind, link.key) : null;
      if (parsed?.kind === 'session' && parsed.harness === 'claude') {
        nativeRequests.set(link.key, [link.key, parsed.machineId, parsed.sessionId]);
      }
    }
  }
  // Only exact current CLI identities can supply a native root without a served row.
  // Two matches retain ambiguity rather than choosing a registry file by recency.
  const nativeRoots = groupEvidenceRecords(
    nativeRequests.size === 0
      ? []
      : db
          .query(`WITH requested AS (
          SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
            json_extract(value, '$[2]') AS session_id FROM json_each(?)
        ), ranked AS (
          SELECT requested.request_key, desktop.*,
            ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY desktop.id) AS rank
          FROM requested JOIN claude_desktop_sessions desktop
            ON desktop.machine_id = requested.machine AND desktop.cli_session_id = requested.session_id
        ) SELECT * FROM ranked WHERE rank <= 2 ORDER BY request_key, rank`)
          .all(JSON.stringify([...nativeRequests.values()])),
  );
  const currentValue = db
    .query(`SELECT revisions.revision, revisions.generated_at FROM served_report_current current
      JOIN served_report_revisions revisions USING(revision) WHERE current.singleton = 1 AND revisions.complete = 1`)
    .get();
  if (currentValue === null) {
    return {
      revision: null,
      generatedAt: null,
      roots: new Map(),
      children: new Map(),
      desktops: new Map(),
      branches: new Map(),
      nativeRoots,
    };
  }
  const current = record(currentValue);
  const revision = validated(evidenceText(current.revision, 512), 'served revision');
  const generatedAt = validated(normalizeIsoTimestamp(current.generated_at), 'served revision date');
  const sessionRequests = new Map<string, readonly string[]>();
  const branchRequests = new Map<string, readonly string[]>();
  for (const scope of scopes) {
    for (const link of scope.links) {
      if (link.detachedAt !== null) {
        continue;
      }
      const parsed = parseWorkThreadLinkKey(link.kind, link.key);
      if (parsed?.kind === 'session') {
        sessionRequests.set(link.key, [link.key, parsed.machineId, parsed.harness, parsed.sessionId]);
      } else if (parsed?.kind === 'branch') {
        const key = JSON.stringify([link.threadId, scope.machineId, link.key]);
        branchRequests.set(key, [
          key,
          scope.machineId,
          parsed.host.toLowerCase(),
          parsed.repository.toLowerCase(),
          parsed.ref,
          link.threadId,
        ]);
      }
    }
  }
  const memberCte = (identityFilter: string) => `members AS MATERIALIZED (
    SELECT ordinal, row_id, machine_id, project_label, campaign_root, origin, active_time,
      json_extract(source_row_json, '$.source.sourceSessionId') AS source_session_id,
      json_extract(source_row_json, '$.source.parentSourceSessionId') AS parent_session_id,
      json_extract(source_row_json, '$.source.harnessKey') AS harness_key
    FROM served_report_rows WHERE revision = ? AND (${identityFilter})
  )`;
  const requestedIdentityFilter = (identity: 'sourceSessionId' | 'parentSourceSessionId') => `
    ${identity === 'parentSourceSessionId' ? "json_extract(source_row_json, '$.source.parentSourceSessionId') IS NOT NULL AND" : ''}
    (machine_id, json_extract(source_row_json, '$.source.harnessKey'), json_extract(source_row_json, '$.source.${identity}'))
      IN (SELECT machine, harness, session_id FROM requested)`;
  const requestCte = `requested AS MATERIALIZED (
    SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
      json_extract(value, '$[2]') AS harness, json_extract(value, '$[3]') AS session_id
    FROM json_each(?)
  )`;
  const roots = groupEvidenceRecords(
    sessionRequests.size === 0
      ? []
      : db
          .query(`WITH ${requestCte}, ${memberCte(requestedIdentityFilter('sourceSessionId'))}, ranked AS (
      SELECT requested.request_key, members.*,
        ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY ordinal) AS rank
      FROM requested JOIN members ON machine_id = machine AND harness_key = harness AND source_session_id = session_id
    ) SELECT ranked.*, ${EVIDENCE_MEMBER_DETAILS} FROM ranked
      JOIN served_report_rows metadata ON metadata.revision = ? AND metadata.ordinal = ranked.ordinal
      WHERE rank <= 2 ORDER BY request_key, rank`)
          .all(JSON.stringify([...sessionRequests.values()]), revision, revision),
  );
  const desktopRequests = new Map<string, readonly string[]>();
  for (const [key, rows] of roots) {
    const request = sessionRequests.get(key);
    if (rows.length === 1 && request?.[2] === 'claude') {
      desktopRequests.set(key, request);
    }
  }
  const readDesktops = (requests: readonly (readonly string[])[]) =>
    new Map(
      (requests.length === 0
        ? []
        : db
            .query(`WITH ${requestCte}, ranked AS (
        SELECT requested.request_key, desktop.*,
          ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY last_activity_at DESC, id DESC) AS rank
        FROM requested JOIN claude_desktop_sessions desktop ON desktop.machine_id = machine
          AND (cli_session_id = session_id OR EXISTS (
            SELECT 1 FROM json_each(prior_cli_session_ids_json) WHERE value = session_id))
      ) SELECT * FROM ranked WHERE rank = 1`)
            .all(JSON.stringify(requests))
      ).map((value) => {
        const row = record(value);
        return [validated(evidenceText(row.request_key), 'Desktop request key'), row] as const;
      }),
    );
  const desktops = readDesktops([...desktopRequests.values()]);
  for (const [key, rows] of nativeRoots) {
    if ((roots.get(key)?.length ?? 0) === 0 && rows.length === 1 && rows[0]) {
      desktops.set(key, rows[0]);
    }
  }
  const childRequests = scopes.flatMap((scope) =>
    scope.links.flatMap((link) => {
      const request = sessionRequests.get(link.key);
      const rootCount = roots.get(link.key)?.length ?? 0;
      const hasRoot = rootCount === 1 || (rootCount === 0 && nativeRoots.get(link.key)?.length === 1);
      return link.detachedAt === null && link.kind === 'session' && request && hasRoot
        ? [
            [
              JSON.stringify([link.threadId, link.key]),
              ...request.slice(1),
              desktops.get(link.key)?.desktop_session_id ?? null,
              link.threadId,
              JSON.stringify(
                request[2] === 'claude'
                  ? readWorkSessionDelegations(roots.get(link.key)?.[0]?.delegated_sessions).delegatedSessions
                  : [],
              ),
            ],
          ]
        : [];
    }),
  );
  const desktopChildFilter = childRequests.some((request) => request[4] !== null)
    ? `OR (machine_id, json_extract(source_row_json, '$.source.harnessKey'),
        json_extract(source_row_json, '$.source.sourceSessionId')) IN (
        SELECT requested.machine, requested.harness, desktop.cli_session_id
        FROM requested JOIN claude_desktop_sessions desktop
          ON desktop.machine_id = requested.machine AND desktop.spawned_from_session_id = requested.desktop_id
        WHERE requested.desktop_id IS NOT NULL
      )`
    : '';
  const delegatedChildFilter = `OR (machine_id, json_extract(source_row_json, '$.source.harnessKey'),
      json_extract(source_row_json, '$.source.sourceSessionId')) IN (
      SELECT requested.machine, 'codex', json_extract(delegation.value, '$.sourceSessionId')
      FROM requested JOIN json_each(requested.delegated_sessions) delegation
    )`;
  const children = groupEvidenceRecords(
    childRequests.length === 0
      ? []
      : db
          .query(`WITH requested AS MATERIALIZED (
      SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
        json_extract(value, '$[2]') AS harness, json_extract(value, '$[3]') AS session_id,
        json_extract(value, '$[4]') AS desktop_id, json_extract(value, '$[5]') AS thread_id,
        json_extract(value, '$[6]') AS delegated_sessions FROM json_each(?)
    ), ${memberCte(`${requestedIdentityFilter('parentSourceSessionId')} ${desktopChildFilter} ${delegatedChildFilter}`)}, candidates AS (
      SELECT requested.request_key, requested.thread_id, members.*
      FROM requested JOIN members ON machine_id = machine AND harness_key = harness AND parent_session_id = session_id
      UNION
      SELECT DISTINCT requested.request_key, requested.thread_id, members.*
      FROM requested JOIN claude_desktop_sessions desktop
        ON desktop.machine_id = machine AND desktop.spawned_from_session_id = desktop_id
      JOIN members ON members.machine_id = machine AND harness_key = harness
        AND source_session_id = desktop.cli_session_id AND parent_session_id IS NULL
      WHERE desktop_id IS NOT NULL
      UNION
      SELECT requested.request_key, requested.thread_id, members.*
      FROM requested JOIN json_each(requested.delegated_sessions) delegation
      LEFT JOIN members ON members.machine_id = requested.machine AND members.harness_key = 'codex'
        AND members.source_session_id = json_extract(delegation.value, '$.sourceSessionId')
      WHERE ${nonDetachedSessionSql('requested.machine', "'codex'", "json_extract(delegation.value, '$.sourceSessionId')")}
    ), ranked AS (
      SELECT requested.*,
        COUNT(*) OVER (PARTITION BY requested.request_key, machine_id, harness_key, source_session_id) AS identity_count,
        ROW_NUMBER() OVER (PARTITION BY requested.request_key ORDER BY active_time DESC, ordinal) AS rank
      FROM candidates requested
      WHERE ${nonDetachedSessionSql('requested.machine_id', 'requested.harness_key', 'requested.source_session_id')}
    ) SELECT ranked.*, ${EVIDENCE_MEMBER_DETAILS} FROM ranked
      LEFT JOIN served_report_rows metadata ON metadata.revision = ? AND metadata.ordinal = ranked.ordinal
      WHERE rank <= ? ORDER BY request_key, rank`)
          .all(JSON.stringify(childRequests), revision, revision, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren + 1),
  );
  const childDesktopRequests = new Map<string, readonly string[]>();
  for (const rows of children.values()) {
    for (const row of rows.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
      if (row.harness_key === 'claude') {
        const machine = validated(evidenceText(row.machine_id, 512), 'child machine');
        const sessionId = validated(evidenceText(row.source_session_id, 512), 'child session identity');
        const key = sessionEvidenceKey(machine, 'claude', sessionId);
        if (!desktopRequests.has(key)) {
          childDesktopRequests.set(key, [key, machine, 'claude', sessionId]);
        }
      }
    }
  }
  for (const [key, value] of readDesktops([...childDesktopRequests.values()])) {
    desktops.set(key, value);
  }
  const branches = groupEvidenceRecords(
    branchRequests.size === 0
      ? []
      : db
          .query(`WITH requested AS MATERIALIZED (
      SELECT json_extract(value, '$[0]') AS request_key, json_extract(value, '$[1]') AS machine,
        json_extract(value, '$[2]') AS host, json_extract(value, '$[3]') AS repository,
        json_extract(value, '$[4]') AS ref, json_extract(value, '$[5]') AS thread_id FROM json_each(?)
    ), paths AS (
      SELECT DISTINCT requested.request_key, json_extract(source_row_json, '$.source.sourcePath') AS checkout_path
      FROM requested JOIN served_report_rows ON machine_id = machine AND revision = ?
        AND lower(json_extract(source_row_json, '$.source.vcs.repository.host')) = host
        AND lower(json_extract(source_row_json, '$.source.vcs.repository.ownerPath')) = repository
        AND json_extract(source_row_json, '$.source.vcs.branches[#-1].name') = ref
        AND json_extract(source_row_json, '$.source.sourcePath') IS NOT NULL
        AND ${nonDetachedSessionSql('machine_id', "json_extract(source_row_json, '$.source.harnessKey')", "json_extract(source_row_json, '$.source.sourceSessionId')")}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY request_key ORDER BY checkout_path) AS rank FROM paths
    ) SELECT * FROM ranked WHERE rank <= ? ORDER BY request_key, rank`)
          .all(JSON.stringify([...branchRequests.values()]), revision, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren + 1),
  );
  return { revision, generatedAt, roots, children, desktops, branches, nativeRoots };
};

const readThreadSessionEvidence = (
  page: SessionEvidencePage,
  input: Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'>,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
): Omit<WorkThreadSessionEvidence, 'branchSessionLinks'> => {
  const { revision, generatedAt } = page;
  const sessions = new Map<string, WorkThreadSessionEvidence['sessions'][number]>();
  const branchCheckouts: WorkThreadSessionEvidence['branchCheckouts'][number][] = [];
  let truncated = false;
  const desktopOf = (machineId: string, sessionId: string, native?: Record<string, unknown>) => {
    const desktop = native ?? page.desktops.get(sessionEvidenceKey(machineId, 'claude', sessionId));
    if (desktop === undefined) {
      return null;
    }
    const value = record(desktop);
    return {
      desktopSessionId: validated(evidenceText(value.desktop_session_id, 512), 'Desktop session identity'),
      value: {
        cliSessionId: validated(evidenceText(value.cli_session_id, 512), 'Desktop current CLI identity'),
        desktopSessionId: validated(evidenceText(value.desktop_session_id, 512), 'Desktop session identity'),
        archived: value.archived === 1,
        format: validated(evidenceText(value.format), 'Desktop format'),
        branch: evidenceOptionalText(value.branch),
        createdAt: validated(normalizeIsoTimestamp(value.created_at), 'Desktop start instant'),
        cwd: validated(evidenceText(value.cwd), 'Desktop checkout'),
        lastActivityAt: validated(normalizeIsoTimestamp(value.last_activity_at), 'Desktop activity'),
        lastTurnReport: evidenceOptionalText(value.last_turn_report, 16_000),
        observedAt: validated(normalizeIsoTimestamp(value.observed_at), 'Desktop observation instant'),
        title: validated(evidenceText(value.title), 'Desktop title'),
        turnSummary:
          value.status_category === null
            ? null
            : {
                needsAction: evidenceOptionalText(value.needs_action),
                detail: validated(evidenceText(value.status_detail), 'Desktop turn summary'),
              },
        worktreePath: evidenceOptionalText(value.worktree_path),
      },
    };
  };
  const add = (raw: unknown, harness: string, declaredParent?: string) => {
    const row = record(raw);
    const machineId = validated(evidenceText(row.machine_id, 512), 'session machine');
    const sourceSessionId = validated(evidenceText(row.source_session_id, 512), 'session identity');
    const desktop = harness === 'claude' ? desktopOf(machineId, sourceSessionId) : null;
    const startedAt =
      row.started_at === null ? null : validated(normalizeIsoTimestamp(row.started_at), 'session start instant');
    // `active_time` falls back to the start date; an absent end is not a known span.
    const activeAt =
      row.ended_at === null ? null : Date.parse(validated(normalizeIsoTimestamp(row.ended_at), 'session end instant'));
    const delegations = readWorkSessionDelegations(row.delegated_sessions);
    truncated ||= delegations.delegatedSessionsTruncated;
    const entry = {
      harness,
      firstPrompt:
        row.title_source === 'first-prompt' ? validated(evidenceText(row.title), 'first prompt excerpt') : null,
      desktop: desktop?.value ?? null,
      member: {
        ...delegations,
        activeAt,
        branch: evidenceOptionalText(row.branch),
        campaignRoot: row.campaign_root === 1,
        checkoutPath: evidenceOptionalText(row.checkout_path),
        durationMs:
          typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms) && row.duration_ms >= 0
            ? row.duration_ms
            : null,
        machineId,
        origin: evidenceOptionalText(row.origin, 64),
        parentSourceSessionId:
          evidenceOptionalText(row.parent_session_id, 512) ??
          declaredParent ??
          sessions.get(JSON.stringify([machineId, harness, sourceSessionId]))?.member.parentSourceSessionId ??
          null,
        projectLabel: validated(evidenceText(row.project_label), 'session project'),
        rowId: validated(evidenceText(row.row_id, 512), 'session row'),
        sourceSessionId,
        startedAt,
        title: validated(evidenceText(row.title), 'session title'),
      },
    };
    sessions.set(JSON.stringify([machineId, harness, sourceSessionId]), entry);
    return desktop?.desktopSessionId ?? null;
  };
  for (const link of input.links.filter((item) => item.detachedAt === null)) {
    const parsed = parseWorkThreadLinkKey(link.kind, link.key);
    if (parsed?.kind === 'session') {
      const roots = page.roots.get(link.key) ?? [];
      const native = page.nativeRoots.get(link.key) ?? [];
      if (roots.length === 0 && native.length === 1 && parsed.harness === 'claude') {
        const desktop = desktopOf(parsed.machineId, parsed.sessionId, native[0]);
        if (desktop === null) {
          return invalidInput('Native Desktop evidence is missing');
        }
        sessions.set(JSON.stringify([parsed.machineId, parsed.harness, parsed.sessionId]), {
          harness: 'claude',
          firstPrompt: null,
          desktop: desktop.value,
          member: {
            activeAt: Date.parse(desktop.value.lastActivityAt),
            branch: evidenceOptionalText(native[0]?.branch),
            campaignRoot: false,
            checkoutPath: desktop.value.worktreePath ?? desktop.value.cwd,
            durationMs: null,
            delegatedSessions: [],
            delegatedSessionsTruncated: false,
            machineId: parsed.machineId,
            origin: null,
            parentSourceSessionId: null,
            projectLabel: null,
            rowId: null,
            sourceSessionId: parsed.sessionId,
            startedAt: desktop.value.createdAt,
            title: desktop.value.title,
          },
        });
      } else if (roots.length === 1) {
        add(roots[0], parsed.harness);
      } else {
        truncated = true;
        continue;
      }
      const children = page.children.get(JSON.stringify([link.threadId, link.key])) ?? [];
      if (children.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren) {
        truncated = true;
      }
      for (const child of children.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
        if (child.ordinal === null || child.identity_count !== 1) {
          truncated = true;
          continue;
        }
        const childHarness = validated(evidenceText(child.harness_key, 512), 'child harness');
        add(child, childHarness, childHarness === parsed.harness ? parsed.sessionId : undefined);
      }
    } else if (parsed?.kind === 'branch') {
      const paths = page.branches.get(JSON.stringify([link.threadId, input.machineId, link.key])) ?? [];
      if (paths.length > WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren) {
        truncated = true;
      }
      for (const value of paths.slice(0, WORK_THREAD_VIEW_BOUNDS.maxEpisodeChildren)) {
        branchCheckouts.push({
          key: link.key,
          machineId: input.machineId,
          checkoutPath: validated(evidenceText(record(value).checkout_path), 'branch checkout'),
        });
      }
    }
  }
  return { revision, generatedAt, sessions: [...sessions.values()], branchCheckouts, truncated };
};

/** Adds the sessions the scope reads through its branch links, as links of the same thread. */
const withBranchSessions = <Scope extends Omit<QueryWorkThreadSessionEvidenceInput, 'dbPath'>>(
  db: SqliteDatabase,
  scope: Scope,
  threadId: string,
): Scope & { readonly branchLinks: readonly WorkThreadLink[]; readonly branchTruncated: boolean } => {
  if (scope.links.length > WORK_THREAD_BOUNDS.maxLinksPerThread) {
    return invalidInput('Invalid linked session evidence scope');
  }
  const branch = branchSessionLinks(db, { ...scope, threadId });
  return {
    ...scope,
    links: [...scope.links, ...branch.links],
    branchLinks: branch.links,
    branchTruncated: branch.truncated,
  };
};

const withBranchEvidence = (
  evidence: Omit<WorkThreadSessionEvidence, 'branchSessionLinks'>,
  scope: { readonly branchLinks: readonly WorkThreadLink[]; readonly branchTruncated: boolean },
): WorkThreadSessionEvidence => {
  // A derived session the read could not resolve to one served row is not shown as linked.
  const resolved = new Set(
    evidence.sessions.map((session) =>
      sessionEvidenceKey(session.member.machineId, session.harness, session.member.sourceSessionId),
    ),
  );
  return {
    ...evidence,
    branchSessionLinks: scope.branchLinks.filter((link) => resolved.has(link.key)),
    truncated: evidence.truncated || scope.branchTruncated,
  };
};

export function queryWorkThreadSessionEvidence(
  input: QueryWorkThreadSessionEvidenceInput,
): Effect.Effect<WorkThreadSessionEvidence, UsageStoreError>;
export function queryWorkThreadSessionEvidence(
  input: QueryWorkThreadSessionEvidenceBatchInput,
): Effect.Effect<readonly WorkThreadSessionEvidenceBatchEntry[], UsageStoreError>;
export function queryWorkThreadSessionEvidence(
  input: QueryWorkThreadSessionEvidenceInput | QueryWorkThreadSessionEvidenceBatchInput,
): Effect.Effect<WorkThreadSessionEvidence | readonly WorkThreadSessionEvidenceBatchEntry[], UsageStoreError> {
  return withUsageStoreReader(input.dbPath, (db) =>
    Effect.try({
      try: () => {
        db.exec('BEGIN');
        try {
          if ('threads' in input) {
            if (
              input.threads.length > WORK_THREAD_VIEW_BOUNDS.maxPageSize ||
              new Set(input.threads.map((thread) => thread.threadId)).size !== input.threads.length ||
              input.threads.some(
                (thread) =>
                  !isWorkThreadId(thread.threadId) || thread.links.some((link) => link.threadId !== thread.threadId),
              )
            ) {
              return invalidInput('Invalid work thread session evidence batch');
            }
            if (input.threads.length === 0) {
              return [];
            }
            const scopes = input.threads.map((thread) => withBranchSessions(db, thread, thread.threadId));
            const page = readSessionEvidencePage(db, scopes);
            return scopes.map((thread) => ({
              threadId: thread.threadId,
              evidence: withBranchEvidence(readThreadSessionEvidence(page, thread), thread),
            }));
          }
          const threadId = input.links[0]?.threadId;
          const scope =
            threadId === undefined
              ? { ...input, branchLinks: [], branchTruncated: false }
              : withBranchSessions(db, input, threadId);
          return withBranchEvidence(readThreadSessionEvidence(readSessionEvidencePage(db, [scope]), scope), scope);
        } finally {
          db.exec('COMMIT');
        }
      },
      catch: (cause) => usageStoreReadError('queryWorkThreadSessionEvidence', input.dbPath, cause),
    }),
  );
}
