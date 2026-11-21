import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  parseWorkThreadLinkKey,
  WORK_THREAD_BOUNDS,
  type WorkThread,
  type WorkThreadIntent,
  type WorkThreadLinkKind,
} from '@ai-usage/report-core/work-thread';
import type { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { effectiveThread, jiraKeyFollowers, memberThreadIdsOf } from './work-thread-combination';
import {
  activeLinkCount,
  addEvent,
  addLink,
  canonicalLinkKey,
  comparableLinkSql,
  hasKnownWorkThreadLink,
  instant,
  invalidInput,
  newThread,
  record,
  type SqliteDatabase,
  saveThread,
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
