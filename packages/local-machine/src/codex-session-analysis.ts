import path from 'node:path';
import type { LocalSessionAnalysis } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import {
  CODEX_LINEAGE_MAX_DEPTH,
  type CodexSession,
  type CodexThreadMetadata,
  type CodexThreadMetadataRow,
  type CodexThreadSpawnEdgeRow,
  type CodexUsageOwnership,
  codexParentsFromEdges,
  codexStateDbCandidates,
  codexThreadMetadataFromRow,
  createCodexSessionParser,
  isCodexUsageOwnedByRoot,
  listCodexSessionFiles,
  mergeMetadata,
  THREAD_METADATA_SQL,
} from './internal/codex-history';
import {
  type LocalHistoryDatabase,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from './local-history';
import { firstExisting } from './platform-paths';

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
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

const indexCodexRolloutFiles = (files: readonly string[]): ReadonlyMap<string, readonly string[]> => {
  const filesBySessionId = new Map<string, string[]>();
  for (const filePath of files) {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith('.jsonl')) {
      continue;
    }
    const stem = fileName.slice(0, -'.jsonl'.length);
    const candidates = [stem];
    for (let separator = stem.indexOf('-'); separator >= 0; separator = stem.indexOf('-', separator + 1)) {
      candidates.push(stem.slice(separator + 1));
    }
    for (const [index, candidate] of candidates.entries()) {
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
    const files = yield* listCodexSessionFiles;
    const filesBySessionId = indexCodexRolloutFiles(files);
    const readIndexedSession = (sessionId: string, captureDetail: boolean, maximumBytes: number) =>
      Effect.gen(function* () {
        let bytes = 0;
        for (const filePath of filesBySessionId.get(sessionId) ?? []) {
          const parser = createCodexSessionParser(captureDetail);
          const read = yield* storage.readLines(filePath, parser.visit, {
            maxBytes: Math.max(0, maximumBytes - bytes),
            maxLineBytes: CODEX_DETAIL_MAX_LINE_BYTES,
          });
          bytes += read.bytes;
          const session = parser.finish().session;
          if (session.id === sessionId) {
            return { bytes, parser, session } as const;
          }
        }
        return { bytes, parser: null, session: null } as const;
      });
    const targetRead = yield* readIndexedSession(sourceSessionId, true, CODEX_DETAIL_MAX_TOTAL_BYTES);
    if (!(targetRead.parser && targetRead.session)) {
      return null;
    }
    const parser = targetRead.parser;
    const parsedSession = targetRead.session;
    const initialRemainingBytes = Math.max(0, CODEX_DETAIL_MAX_TOTAL_BYTES - targetRead.bytes);
    const analyzeWithMetadata = (database: LocalHistoryDatabase | null) =>
      Effect.gen(function* () {
        let remainingBytes = initialRemainingBytes;
        const metadata = database ? yield* readCodexThreadMetadataForSession(database, sourceSessionId) : null;
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
            break;
          }
          const ancestorRead = yield* readIndexedSession(currentAncestorId, false, remainingBytes).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catchAll(() => Effect.succeed({ ok: false as const })),
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
          const ancestorMetadata = database
            ? yield* readCodexThreadMetadataForSession(database, currentAncestorId)
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
        return parser.analysis(usageOwnership);
      });

    const dbPath = yield* firstExisting(storage, ...codexStateDbCandidates(storage));
    if (!dbPath) {
      return yield* analyzeWithMetadata(null);
    }
    const database = yield* storage.openDatabase(dbPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (!database) {
      return yield* analyzeWithMetadata(null);
    }
    return yield* analyzeWithMetadata(database).pipe(Effect.ensuring(database.close));
  });
