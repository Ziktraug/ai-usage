import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { DistillationCatalog, DistillationProject } from '@ai-usage/platform-core/distillation-discovery';
import {
  DistillationError,
  distillationInteger,
  distillationJsonBytes,
  distillationObject,
  distillationText,
  parseAnalysisRevisionMetadata,
  parseDistillationJobView,
} from '@ai-usage/platform-core/session-distillation';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operation = <T>(run: () => T): Promise<T> => {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
};
const cursorValue = (
  cursor: string | null,
  scope: unknown,
  mutationFingerprint?: string,
): { cutoff: number; offset: number } => {
  if (cursor === null) {
    return { cutoff: 0, offset: 0 };
  }
  try {
    const entry = distillationObject(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (entry.scope !== hash(scope)) {
      throw new DistillationError('cursor-scope-mismatch');
    }
    if (mutationFingerprint !== undefined && entry.mutationFingerprint !== mutationFingerprint) {
      throw new DistillationError('cursor-stale');
    }
    return {
      cutoff: distillationInteger(entry.cutoff, 0, Number.MAX_SAFE_INTEGER),
      offset: distillationInteger(entry.offset, 0, 1_000_000),
    };
  } catch (error) {
    if (error instanceof DistillationError) {
      throw error;
    }
    throw new DistillationError('invalid-cursor');
  }
};
const cursorFor = (scope: unknown, cutoff: number, offset: number, mutationFingerprint?: string) =>
  Buffer.from(
    JSON.stringify({
      scope: hash(scope),
      cutoff,
      offset,
      ...(mutationFingerprint === undefined ? {} : { mutationFingerprint }),
    }),
  ).toString('base64url');
const metadata = (row: Record<string, unknown>) =>
  parseAnalysisRevisionMetadata({
    id: row.id,
    projectId: row.project_id,
    machineId: row.machine_id,
    nativeSessionId: row.native_session_id,
    packetDigest: row.packet_digest,
    revision: row.revision,
    createdAt: row.created_at,
  });
const accessibleProject =
  'EXISTS (SELECT 1 FROM projects p JOIN local_identity_metadata local ON local.personal_space_id=p.space_id WHERE p.id=a.project_id)';
const visibleAnalysis =
  'NOT EXISTS (SELECT 1 FROM distillation_withdrawals withdrawn WHERE withdrawn.project_id=a.project_id AND withdrawn.machine_id=a.machine_id AND withdrawn.native_session_id=a.native_session_id)';
const maximumRowId = (
  database: Database,
  table: 'session_analyses' | 'distillation_jobs',
  projectId: string | null,
): number => {
  const row = database
    .query(
      `SELECT COALESCE(MAX(a.rowid),0) AS cutoff FROM ${table} a WHERE ${accessibleProject} AND (? IS NULL OR a.project_id=?)`,
    )
    .get(projectId, projectId) as { cutoff: number };
  return row.cutoff;
};
const withdrawalFingerprint = (database: Database, projectId: string | null): string =>
  hash(
    database
      .query(
        `SELECT COUNT(*) AS count,MAX(a.withdrawn_at) AS latest FROM distillation_withdrawals a WHERE ${accessibleProject} AND (? IS NULL OR a.project_id=?)`,
      )
      .get(projectId, projectId),
  );
const QUERY_WHITESPACE = /\s+/u;
const COMMON_TASK_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'of',
  'and',
  'or',
  'in',
  'on',
  'with',
  'how',
  'why',
  'can',
  'i',
  'we',
  'this',
  'that',
  'is',
  'was',
  'it',
  'do',
  'does',
  'le',
  'la',
  'les',
  'de',
  'du',
  'des',
  'un',
  'une',
  'et',
  'ou',
  'dans',
  'pour',
  'avec',
  'comment',
  'pourquoi',
  'je',
  'nous',
]);
const taskTerms = (query: string) => {
  const terms = distillationText(query, 1000).trim().split(QUERY_WHITESPACE);
  if (terms.length > 32) {
    throw new DistillationError('search-query-too-large');
  }
  const focused = terms.filter((term) => !COMMON_TASK_WORDS.has(term.toLowerCase()));
  return focused.length > 0 ? focused : terms;
};
const matchQuery = (query: string, mode: 'literal' | 'task') => {
  const terms = taskTerms(query);
  // Literal preserves the exact punctuated phrase. Task accepts any lexical clue,
  // with scoped overlap ranking; neither changes Project scope.
  return mode === 'literal'
    ? `"${query.replaceAll('"', '""')}"`
    : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
};

export const createDistillationCatalog = (database: Database): DistillationCatalog => ({
  history: (projectId, analysisId, limit, cursor) =>
    operation(() => {
      distillationInteger(limit, 1, 50);
      const anchor = database
        .query(
          `SELECT a.machine_id,a.native_session_id FROM session_analyses a WHERE a.project_id=? AND a.id=? AND ${accessibleProject}`,
        )
        .get(projectId, analysisId) as { machine_id: string; native_session_id: string } | null;
      if (!anchor) {
        throw new DistillationError('analysis-not-found');
      }
      const scope = { kind: 'history', projectId, analysisId };
      const mutationFingerprint = withdrawalFingerprint(database, projectId);
      const position = cursorValue(cursor, scope, mutationFingerprint);
      const cutoff = cursor === null ? maximumRowId(database, 'session_analyses', projectId) : position.cutoff;
      const rows = database
        .query(
          'SELECT * FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=? AND rowid<=? ORDER BY revision DESC LIMIT ? OFFSET ?',
        )
        .all(projectId, anchor.machine_id, anchor.native_session_id, cutoff, limit + 1, position.offset) as Record<
        string,
        unknown
      >[];
      return {
        items: rows.slice(0, limit).map(metadata),
        nextCursor: rows.length > limit ? cursorFor(scope, cutoff, position.offset + limit, mutationFingerprint) : null,
      };
    }),
  projects: (limit, cursor, selector) =>
    operation(() => {
      distillationInteger(limit, 1, 50);
      const scope = { kind: 'projects', selector: selector ?? null };
      const { offset } = cursorValue(cursor, scope);
      const params: SQLQueryBindings[] = [];
      let filter = '';
      if (selector) {
        if (selector.kind === 'project') {
          filter = 'AND (p.id=? OR p.display_name=?)';
          params.push(selector.value, selector.value);
        } else {
          filter = "AND (c.local_path=? OR substr(?,1,length(c.local_path)+1)=c.local_path || '/')";
          params.push(selector.value, selector.value);
        }
      }
      const rows = database
        .query(
          `SELECT p.id,p.display_name FROM projects p JOIN local_identity_metadata local ON local.personal_space_id=p.space_id WHERE p.status='active' AND EXISTS (SELECT 1 FROM project_source_mappings m JOIN checkouts c ON c.id=m.checkout_id AND c.space_id=m.space_id WHERE m.project_id=p.id AND m.space_id=p.space_id AND c.project_id=p.id AND c.device_id=local.device_id AND c.status='available' ${filter}) ORDER BY p.display_name,p.id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit + 1, offset) as { id: string; display_name: string }[];
      const items: DistillationProject[] = rows.slice(0, limit).map((row) => {
        const checkouts = database
          .query(
            `SELECT c.local_path AS path,m.project_source_id AS projectSourceId,m.acknowledged_at AS acknowledgedAt FROM project_source_mappings m JOIN checkouts c ON c.id=m.checkout_id AND c.space_id=m.space_id JOIN local_identity_metadata local ON local.personal_space_id=m.space_id AND local.device_id=c.device_id WHERE m.project_id=? AND c.project_id=? AND c.status='available' ORDER BY m.project_source_id LIMIT 101`,
          )
          .all(row.id, row.id) as DistillationProject['checkouts'];
        if (checkouts.length > 100) {
          throw new DistillationError('project-mapping-limit');
        }
        return { projectId: row.id, displayName: row.display_name, checkouts };
      });
      return { items, nextCursor: rows.length > limit ? cursorFor(scope, 0, offset + items.length) : null };
    }),
  browse: (request) =>
    operation(() => {
      const { cursor, limit, ...scope } = request;
      distillationInteger(limit, 1, 50);
      const mutationFingerprint = withdrawalFingerprint(database, request.projectId);
      const position = cursorValue(cursor, scope, mutationFingerprint);
      const cutoff = cursor === null ? maximumRowId(database, 'session_analyses', request.projectId) : position.cutoff;
      const params: SQLQueryBindings[] = [cutoff, cutoff];
      let filter = '';
      if (request.projectId !== null) {
        filter += ' AND a.project_id=?';
        params.push(request.projectId);
      }
      const sessionDate = "json_extract(a.analysis_json,'$.source.sessionDate')";
      if (request.since !== null) {
        filter += ` AND ${sessionDate}>=?`;
        params.push(request.since);
      }
      if (request.until !== null) {
        filter += ` AND ${sessionDate}<?`;
        params.push(request.until);
      }
      if (request.query) {
        filter += ' AND instr(lower(a.analysis_json),lower(?))>0';
        params.push(distillationText(request.query, 1000));
      }
      const rows = database
        .query(
          `SELECT a.*,p.display_name AS project_name,${sessionDate} AS session_date FROM session_analyses a JOIN projects p ON p.id=a.project_id WHERE ${accessibleProject} AND ${visibleAnalysis} AND a.rowid<=? AND NOT EXISTS (SELECT 1 FROM session_analyses newer WHERE newer.project_id=a.project_id AND newer.machine_id=a.machine_id AND newer.native_session_id=a.native_session_id AND newer.revision>a.revision AND newer.rowid<=?) ${filter} ORDER BY COALESCE(${sessionDate},a.created_at) DESC,a.id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit + 1, position.offset) as Record<string, unknown>[];
      const items = rows.slice(0, limit).map((row) => ({
        ...metadata(row),
        projectName: String(row.project_name),
        summary: String(row.summary),
        coverage: row.coverage_status === 'complete' ? ('complete' as const) : ('partial' as const),
        episodeIds: JSON.parse(String(row.episode_ids_json)) as string[],
        sessionDate: typeof row.session_date === 'string' ? row.session_date : null,
      }));
      while (
        items.length > 1 &&
        distillationJsonBytes({
          items,
          nextCursor: cursorFor(scope, cutoff, position.offset + items.length, mutationFingerprint),
        }) >
          128 * 1024
      ) {
        items.pop();
      }
      return {
        items,
        nextCursor:
          rows.length > items.length
            ? cursorFor(scope, cutoff, position.offset + items.length, mutationFingerprint)
            : null,
      };
    }),
  jobs: (projectId, limit, cursor) =>
    operation(() => {
      distillationInteger(limit, 1, 50);
      const scope = { kind: 'jobs', projectId };
      const position = cursorValue(cursor, scope);
      const cutoff = cursor === null ? maximumRowId(database, 'distillation_jobs', projectId) : position.cutoff;
      const rows = database
        .query(
          `SELECT a.*,progress.segment_index,progress.stage,progress.source_digest FROM distillation_jobs a LEFT JOIN distillation_progress progress ON progress.job_id=a.id WHERE a.project_id=? AND a.rowid<=? AND ${accessibleProject} ORDER BY a.rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(projectId, cutoff, limit + 1, position.offset) as Record<string, unknown>[];
      const items = rows.slice(0, limit).map((row) => ({
        ...parseDistillationJobView({
          id: row.id,
          state: row.state,
          attempt: row.attempt,
          errorCode: row.error_code,
          analysisId: row.analysis_id,
          ...(row.segment_index === null
            ? {}
            : {
                progress: {
                  segmentIndex: row.segment_index,
                  completedSegments: row.segment_index,
                  stage: row.stage,
                  snapshotDigest: row.source_digest,
                },
              }),
        }),
        nativeSessionId: String(row.native_session_id),
        updatedAt: String(row.updated_at),
      }));
      return {
        items,
        nextCursor: rows.length > limit ? cursorFor(scope, cutoff, position.offset + items.length) : null,
      };
    }),
  search: (projectId, query, limit, mode = 'literal') =>
    operation(() => {
      distillationInteger(limit, 1, 20);
      const match = matchQuery(query, mode);
      const literalFilter = mode === 'literal' ? ' AND instr(lower(f.content),lower(?))>0' : '';
      const predicate = `f.project_id=? AND session_analyses_fts MATCH ? AND ${accessibleProject} AND ${visibleAnalysis}${literalFilter}`;
      const params: SQLQueryBindings[] = mode === 'literal' ? [projectId, match, query] : [projectId, match];
      const count = database
        .query(
          `SELECT COUNT(*) AS count FROM session_analyses_fts f JOIN session_analyses a ON a.id=f.analysis_id WHERE ${predicate}`,
        )
        .get(...params) as { count: number };
      const rankTerms = mode === 'task' ? taskTerms(query) : [];
      const rank = rankTerms.length
        ? rankTerms.map(() => 'CASE WHEN instr(lower(f.content),lower(?))>0 THEN 1 ELSE 0 END').join('+')
        : 'CASE WHEN 1 THEN 0 END';
      const rows = database
        .query(
          `SELECT a.* FROM session_analyses_fts f JOIN session_analyses a ON a.id=f.analysis_id WHERE ${predicate} ORDER BY (${rank}) DESC,a.created_at DESC,a.id LIMIT ?`,
        )
        .all(...params, ...rankTerms, limit) as Record<string, unknown>[];
      const items = rows.map((row) => ({
        ...metadata(row),
        summary: String(row.summary),
        coverage: row.coverage_status === 'complete' ? ('complete' as const) : ('partial' as const),
        episodeIds: JSON.parse(String(row.episode_ids_json)) as string[],
      }));
      return { corpus: 'session-analyses', items, omitted: Math.max(0, count.count - items.length) };
    }),
});
