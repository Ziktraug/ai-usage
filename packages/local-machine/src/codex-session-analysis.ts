import path from 'node:path';
import type { LocalSessionAnalysis } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import {
  CODEX_LINEAGE_MAX_DEPTH,
  type CodexChildLinks,
  type CodexSession,
  type CodexThreadMetadata,
  type CodexThreadMetadataRow,
  type CodexThreadSpawnEdgeRow,
  type CodexUsageOwnership,
  codexChildLinksFromEdges,
  codexChildLinksWithoutDatabase,
  codexParentsFromEdges,
  codexRolloutSessionIdCandidates,
  codexStateDbCandidates,
  codexThreadMetadataFromRow,
  createCodexSessionParser,
  isCodexRolloutFileName,
  isCodexUsageOwnedByRoot,
  listCodexRolloutFiles,
  mergeMetadata,
  readCodexRolloutWithFallback,
  THREAD_METADATA_SQL,
} from './internal/codex-history';
import {
  type LocalHistoryDatabase,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from './local-history';
import { firstExisting } from './platform-paths';

/**
 * The Codex skill extractors live in their own module because
 * `internal/codex-history.ts` — which this file imports — needs them during
 * parsing, and re-exporting them here rather than defining them here keeps that
 * dependency acyclic. They remain reachable at this seam, per plan 111.
 */
export {
  CODEX_AVAILABLE_SKILLS_HEADING,
  type CodexSkillCatalogueEntry,
  type CodexSkillObservationContext,
  codexSkillCatalogueObservations,
  codexSkillDirectory,
  extractCodexSkillCatalogue,
  extractCodexSkillExecObservation,
} from './codex-skill-observation';

const CODEX_DETAIL_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const CODEX_DETAIL_MAX_LINE_BYTES = 8 * 1024 * 1024;

const SAFE_CODEX_SESSION_ID = /^[a-z\d][a-z\d-]{0,127}$/i;

const THREAD_METADATA_FOR_ID_SQL = `${THREAD_METADATA_SQL.trim()}
where id = ?
limit 2`;

const THREAD_PARENT_FOR_CHILD_SQL = `select distinct
  parent_thread_id as parent,
  child_thread_id as child
from thread_spawn_edges
where child_thread_id = ?
limit 2`;

const CODEX_DETAIL_MAX_CHILDREN = 512;

const THREAD_CHILDREN_FOR_PARENT_SQL = `select distinct
  parent_thread_id as parent,
  child_thread_id as child
from thread_spawn_edges
where parent_thread_id = ?
limit ${CODEX_DETAIL_MAX_CHILDREN + 1}`;

const readCodexChildLinksForSession = (
  database: LocalHistoryDatabase,
  sourceSessionId: string,
): Effect.Effect<CodexChildLinks> =>
  Effect.gen(function* () {
    const edges = yield* database.all<CodexThreadSpawnEdgeRow>(THREAD_CHILDREN_FOR_PARENT_SQL, [sourceSessionId]);
    const nicknames = new Map<string, string | null>();
    for (const edge of edges) {
      const child = edge.child;
      if (!child || nicknames.has(child) || nicknames.size >= CODEX_DETAIL_MAX_CHILDREN) {
        continue;
      }
      const rows = yield* database.all<CodexThreadMetadataRow>(THREAD_METADATA_FOR_ID_SQL, [child]);
      const row = rows[0];
      const metadata = rows.length === 1 && row ? codexThreadMetadataFromRow(row, sourceSessionId) : null;
      nicknames.set(child, metadata?.agentNickname ?? null);
    }
    return codexChildLinksFromEdges(sourceSessionId, edges, nicknames, CODEX_DETAIL_MAX_CHILDREN);
  }).pipe(Effect.catch(() => Effect.succeed(codexChildLinksWithoutDatabase())));

const readCodexThreadMetadataForSession = (
  database: LocalHistoryDatabase,
  sourceSessionId: string,
): Effect.Effect<CodexThreadMetadata | null> =>
  Effect.gen(function* () {
    const rows = yield* database.all<CodexThreadMetadataRow>(THREAD_METADATA_FOR_ID_SQL, [sourceSessionId]);
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      return null;
    }
    const edges = yield* database.all<CodexThreadSpawnEdgeRow>(THREAD_PARENT_FOR_CHILD_SQL, [sourceSessionId]);
    const parent = codexParentsFromEdges(edges).get(sourceSessionId) ?? null;
    return codexThreadMetadataFromRow(row, parent);
  }).pipe(Effect.catch(() => Effect.succeed(null)));

const indexCodexRolloutFiles = (files: readonly string[]): ReadonlyMap<string, readonly string[]> => {
  const filesBySessionId = new Map<string, string[]>();
  for (const filePath of files) {
    const fileName = path.basename(filePath);
    if (!isCodexRolloutFileName(fileName)) {
      continue;
    }
    for (const [index, candidate] of codexRolloutSessionIdCandidates(fileName).entries()) {
      if (!SAFE_CODEX_SESSION_ID.test(candidate)) {
        continue;
      }
      const candidateFiles = filesBySessionId.get(candidate) ?? [];
      if (candidateFiles.includes(filePath)) {
        continue;
      }
      if (index === 0) {
        candidateFiles.unshift(filePath);
      } else {
        candidateFiles.push(filePath);
      }
      filesBySessionId.set(candidate, candidateFiles);
    }
  }
  return filesBySessionId;
};

export const readCodexSessionAnalysis = (
  sourceSessionId: string,
): Effect.Effect<LocalSessionAnalysis | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!SAFE_CODEX_SESSION_ID.test(sourceSessionId)) {
      return null;
    }
    const storage = yield* LocalHistoryStorage;
    const { archivedWalkFailure, files } = yield* listCodexRolloutFiles;
    const filesBySessionId = indexCodexRolloutFiles(files);
    const readIndexedSession = (sessionId: string, captureDetail: boolean, maximumBytes: number) =>
      Effect.gen(function* () {
        let bytes = 0;
        for (const filePath of filesBySessionId.get(sessionId) ?? []) {
          const read = yield* readCodexRolloutWithFallback(storage, filePath, (candidatePath) => {
            const parser = createCodexSessionParser(captureDetail);
            return storage
              .readLines(candidatePath, parser.visit, {
                maxBytes: Math.max(0, maximumBytes - bytes),
                maxLineBytes: CODEX_DETAIL_MAX_LINE_BYTES,
              })
              .pipe(Effect.map((result) => ({ bytes: result.bytes, parser })));
          });
          bytes += read.value.bytes;
          const parser = read.value.parser;
          const session = parser.finish().session;
          if (session.id === sessionId) {
            return { bytes, parser, session } as const;
          }
        }
        return { bytes, parser: null, session: null } as const;
      });
    const targetRead = yield* readIndexedSession(sourceSessionId, true, CODEX_DETAIL_MAX_TOTAL_BYTES);
    if (!(targetRead.parser && targetRead.session)) {
      // Not found is only an answer when every rollout was listed; with the
      // archived directory unlisted, the session may be there.
      if (archivedWalkFailure) {
        return yield* Effect.fail(archivedWalkFailure);
      }
      return null;
    }
    const parser = targetRead.parser;
    const parsedSession = targetRead.session;
    const initialRemainingBytes = Math.max(0, CODEX_DETAIL_MAX_TOTAL_BYTES - targetRead.bytes);
    const analyzeWithMetadata = (historyDatabase: LocalHistoryDatabase | null) =>
      Effect.gen(function* () {
        let remainingBytes = initialRemainingBytes;
        const metadata = historyDatabase
          ? yield* readCodexThreadMetadataForSession(historyDatabase, sourceSessionId)
          : null;
        mergeMetadata(parsedSession, metadata ?? undefined);

        const sessionsById = new Map<string, CodexSession>([[sourceSessionId, parsedSession]]);
        const seen = new Set([sourceSessionId]);
        let lineageBudgetTruncated = false;
        let ancestorId = parsedSession.parent;
        for (let depth = 0; ancestorId && depth < CODEX_LINEAGE_MAX_DEPTH; depth += 1) {
          const currentAncestorId = ancestorId;
          if (seen.has(currentAncestorId)) {
            break;
          }
          seen.add(currentAncestorId);
          if (!filesBySessionId.has(currentAncestorId)) {
            // An ancestor absent from a partial listing may be an archived
            // rollout, so the root's totals are unknown rather than absent.
            lineageBudgetTruncated ||= archivedWalkFailure !== null;
            break;
          }
          const ancestorRead = yield* readIndexedSession(currentAncestorId, false, remainingBytes).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch(() => Effect.succeed({ ok: false as const })),
          );
          if (!ancestorRead.ok) {
            lineageBudgetTruncated = true;
            break;
          }
          remainingBytes = Math.max(0, remainingBytes - ancestorRead.result.bytes);
          const ancestor = ancestorRead.result.session;
          if (!ancestor) {
            break;
          }
          const ancestorMetadata = historyDatabase
            ? yield* readCodexThreadMetadataForSession(historyDatabase, currentAncestorId)
            : null;
          mergeMetadata(ancestor, ancestorMetadata ?? undefined);
          sessionsById.set(currentAncestorId, ancestor);
          ancestorId = ancestor.parent;
        }

        let usageOwnership: CodexUsageOwnership = 'session';
        if (lineageBudgetTruncated) {
          usageOwnership = 'unknown';
        } else if (isCodexUsageOwnedByRoot(parsedSession, sessionsById)) {
          usageOwnership = 'root';
        }
        const links = historyDatabase
          ? yield* readCodexChildLinksForSession(historyDatabase, sourceSessionId)
          : undefined;
        return parser.analysis(usageOwnership, links);
      });

    const dbPath = yield* firstExisting(storage, ...codexStateDbCandidates(storage));
    if (!dbPath) {
      return yield* analyzeWithMetadata(null);
    }
    const database = yield* storage.openDatabase(dbPath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!database) {
      return yield* analyzeWithMetadata(null);
    }
    return yield* analyzeWithMetadata(database).pipe(Effect.ensuring(database.close));
  });
