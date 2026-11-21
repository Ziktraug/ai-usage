import { createHash } from 'node:crypto';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  isWorkThreadId,
  parseWorkThreadLink,
  parseWorkThreadLinkKey,
  WORK_THREAD_BOUNDS,
  type WorkThreadLink,
} from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_VIEW_BOUNDS } from '@ai-usage/report-core/work-thread-view';
import { Effect } from 'effect';
import { withUsageStoreReader } from './connections';
import { type UsageStoreError, usageStoreReadError } from './errors';
import { MAX_WORK_DELEGATIONS_JSON, readWorkSessionDelegations } from './work-session-join';
import { MAX_BRANCH_SESSIONS_PER_TASK } from './work-thread-branches';
import { BRANCH_ROOT_ROLES, BRANCH_SESSION_KEY_SQL, branchSessionVetoSql } from './work-thread-reads';
import {
  canonicalLinkKey,
  evidenceText,
  invalidInput,
  record,
  type SqliteDatabase,
  taskThreadsSql,
  validated,
} from './work-thread-rows';

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
