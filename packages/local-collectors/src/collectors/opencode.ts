import {
  LocalHistoryError,
  type LocalHistoryWarning,
  localHistoryWarningFromError,
} from '@ai-usage/local-machine/errors';
import { readLocalGitRepository } from '@ai-usage/local-machine/local-git';
import { type LocalHistoryDatabase, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import {
  OPENCODE_DIRECT_USER_PART_PREDICATE,
  OPENCODE_SKILL_PART_PREDICATE,
  OPENCODE_TOOL_PART_PREDICATE,
  OPENCODE_V2_SKILL_CONTENT_PREDICATE,
  OPENCODE_V2_TOOL_CONTENT_PREDICATE,
} from '@ai-usage/local-machine/opencode-schema';
import {
  buildOpenCodeProjectionSummary,
  decodeOpenCodeMessageRow,
  decodeOpenCodeSkillPart,
  type OpenCodeMessageFact,
} from '@ai-usage/local-machine/opencode-session-facts';
import { resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import { base, safeJSON } from '@ai-usage/local-machine/text';
import { parseSessionVcsContext, type SessionVcsContext } from '@ai-usage/report-core/session-vcs';
import {
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
  skillObservationIdentity,
} from '@ai-usage/report-core/skill-observation';
import type { TitleSource } from '@ai-usage/report-core/types';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import {
  type CachedSkillObservations,
  cachedDbCollection,
  type DbRowCache,
  dbStat,
  readDbRowCache,
  storeDbRows,
  writeDbRowCache,
} from '../collector-cache';
import {
  metricValidationWarning,
  parseOptionalNonNegativeSafeInteger,
  skillObservationTruncationWarning,
  skillObservationValidationWarning,
} from '../metric-validation';
import { withPerfSpan } from '../perf';
import type { CollectorRow } from '../rtk-enrichment';

const DEFAULT_ACP_SESSION_TITLE = /^(new session\s*[.…]*|acp(?: session)?)$/i;

interface SessionMeta {
  add: number;
  del: number;
  dir: string;
  parentId: string | null;
  title: string;
}

interface SessionRow {
  directory: string | null;
  id: string;
  parent_id: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  title: string | null;
}

interface SchemaRow {
  name: string;
}
interface MessageRow {
  data: string;
  id: unknown;
  session_id: string;
  time_created?: unknown;
}
interface TurnRow {
  message_id: unknown;
  session_id: string;
}
interface ToolCountRow {
  message_id: unknown;
  n: number;
  session_id: string;
}
interface SkillPartRow {
  data: string;
  id?: string;
  message_id: unknown;
  session_id: string;
  time_created?: unknown;
}

export interface OpenCodeCollectionResult {
  observationCompleteness: SkillObservationCollectionCompleteness;
  /**
   * A new fact drawn from the collection source this collector already reads —
   * not a new collection source. The source vocabulary is unchanged.
   */
  observations: SkillObservation[];
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

// Bumped to 12 for the skill-observation stream: an entry written by version 11
// carries rows but no observations, and reusing it would report a machine with
// history as a machine that has never invoked a skill.
// Rows include calculated costs; invalidate them when newly priced models land.
// Bumped to 14 for the `session_v2` storage: an entry written by version 13 was
// read from the legacy tables only and misses every session since the migration.
const OPENCODE_DB_CACHE_VERSION = 14;
const OPENCODE_DB_CACHE_FILE = 'opencode-db-cache.json';
// Observations are tens to hundreds; the bound guards a corrupt database, not
// ordinary volume.
export const MAX_OPENCODE_SKILL_PARTS = 100_000;

/**
 * Testing override for the skill-part read budget. The production bound guards
 * a corrupt database rather than ordinary volume, so exercising the truncation
 * path honestly would mean writing 100k rows. Lowering the bound instead keeps
 * the test about the behaviour — detect the bound, flag it, carry the flag
 * through the cache — rather than about SQLite throughput.
 *
 * Follows the store's `set*FaultInjectorForTesting` precedent: an explicit,
 * named seam rather than a mock of the collector.
 */
let openCodeSkillPartLimitOverride: number | null = null;

export const setOpenCodeSkillPartLimitForTesting = (limit: number | null): void => {
  if (limit !== null && !(Number.isSafeInteger(limit) && limit > 0)) {
    throw new Error('OpenCode skill part limit override must be a positive safe integer or null');
  }
  openCodeSkillPartLimitOverride = limit;
};

const openCodeSkillPartLimit = (): number => openCodeSkillPartLimitOverride ?? MAX_OPENCODE_SKILL_PARTS;

/**
 * OpenCode has stored sessions in two schemas. The legacy one keeps sessions in
 * `session`, messages in `message` and their parts in `part`. The current one
 * (OpenCode's `session_v2` migration) keeps sessions in `session_v2` and
 * messages in `session_message`, whose `type` column carries the role and whose
 * `data.content` array carries what used to be parts. A migrated database holds
 * both: every legacy session also exists in `session_v2`, and a session's
 * messages may be split between `message` and `session_message`, so reads are
 * deduplicated by session id for metadata and by message id for usage.
 */
export const OPENCODE_SCHEMA_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
export const OPENCODE_LEGACY_SESSION_SQL =
  'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session';
export const OPENCODE_LEGACY_TOOL_COUNT_SQL = `SELECT session_id, message_id, count(*) n FROM part WHERE ${OPENCODE_TOOL_PART_PREDICATE} GROUP BY session_id, message_id`;
// One over the bound, so hitting it is detectable rather than silent.
export const openCodeLegacySkillPartSql = (limit: number) =>
  `SELECT id, message_id, session_id, time_created, data FROM part WHERE ${OPENCODE_SKILL_PART_PREDICATE} ORDER BY session_id, time_created, id LIMIT ${limit + 1}`;
export const OPENCODE_LEGACY_TURN_SQL = `SELECT m.session_id, m.id AS message_id FROM message m JOIN part p ON p.message_id = m.id WHERE json_valid(m.data) AND json_valid(p.data) AND json_extract(m.data, '$.role') = 'user' AND ${OPENCODE_DIRECT_USER_PART_PREDICATE} GROUP BY m.session_id, m.id`;
export const OPENCODE_LEGACY_MESSAGE_SQL =
  'SELECT id, session_id, data, time_created FROM message ORDER BY session_id, time_created, id';

export const OPENCODE_V2_SESSION_SQL =
  'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session_v2';
export const OPENCODE_V2_TOOL_COUNT_SQL = `SELECT sm.session_id, sm.id AS message_id, count(*) n FROM session_message sm, json_each(sm.data, '$.content') c WHERE ${OPENCODE_V2_TOOL_CONTENT_PREDICATE} GROUP BY sm.session_id, sm.id`;
export const openCodeV2SkillPartSql = (limit: number) =>
  `SELECT sm.id AS message_id, sm.session_id, sm.time_created, c.value AS data FROM session_message sm, json_each(sm.data, '$.content') c WHERE ${OPENCODE_V2_SKILL_CONTENT_PREDICATE} ORDER BY sm.session_id, sm.time_created, sm.id, c.key LIMIT ${limit + 1}`;
// Synthetic and system inputs have their own `type`, so every `user` row is a
// direct prompt; the legacy schema needs the part predicate for the same cut.
export const OPENCODE_V2_TURN_SQL = "SELECT session_id, id AS message_id FROM session_message WHERE type = 'user'";
export const OPENCODE_V2_MESSAGE_SQL =
  "SELECT id, session_id, data, time_created FROM session_message WHERE type = 'assistant' ORDER BY session_id, time_created, id";

type OpenCodeSchemaKind = 'legacy' | 'v2';

interface OpenCodeTableSet {
  kind: OpenCodeSchemaKind;
  messageSql: string;
  /** The role the message query already selected, or `null` when the payload carries it. */
  role: 'assistant' | null;
  sessionSql: string;
  skillPartSql: (limit: number) => string;
  toolCountSql: string;
  turnSql: string;
}

const OPENCODE_V2_TABLES: OpenCodeTableSet = {
  kind: 'v2',
  messageSql: OPENCODE_V2_MESSAGE_SQL,
  role: 'assistant',
  sessionSql: OPENCODE_V2_SESSION_SQL,
  skillPartSql: openCodeV2SkillPartSql,
  toolCountSql: OPENCODE_V2_TOOL_COUNT_SQL,
  turnSql: OPENCODE_V2_TURN_SQL,
};

const OPENCODE_LEGACY_TABLES: OpenCodeTableSet = {
  kind: 'legacy',
  messageSql: OPENCODE_LEGACY_MESSAGE_SQL,
  role: null,
  sessionSql: OPENCODE_LEGACY_SESSION_SQL,
  skillPartSql: openCodeLegacySkillPartSql,
  toolCountSql: OPENCODE_LEGACY_TOOL_COUNT_SQL,
  turnSql: OPENCODE_LEGACY_TURN_SQL,
};

/** The current schema is read first so that a migrated message is taken from it and skipped in the legacy tables. */
const detectOpenCodeTableSets = (tables: ReadonlySet<string>): OpenCodeTableSet[] => {
  const sets: OpenCodeTableSet[] = [];
  if (tables.has('session_v2') && tables.has('session_message')) {
    sets.push(OPENCODE_V2_TABLES);
  }
  if (tables.has('session') && tables.has('message') && tables.has('part')) {
    sets.push(OPENCODE_LEGACY_TABLES);
  }
  return sets;
};

const openCodeSchemaError = (dbPath: string, tables: ReadonlySet<string>): LocalHistoryError =>
  new LocalHistoryError({
    operation: 'opencode.schema',
    path: dbPath,
    cause: new Error(
      `No known OpenCode session schema: expected the tables session, message and part (legacy) or session_v2 and session_message (current); found ${[...tables].sort().join(', ') || 'no table'}`,
    ),
  });

const optionalId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

interface OpenCodeDatabaseFacts {
  factsBySession: Map<string, OpenCodeMessageFact[]>;
  meta: Map<string, SessionMeta>;
  rejectedMetricRecords: number;
  skillPartRows: SkillPartRow[];
  skillPartsTruncated: boolean;
  toolCount: Map<string, number>;
  turnCount: Map<string, number>;
}

const readOpenCodeDatabaseFacts = (
  db: LocalHistoryDatabase,
  dbPath: string,
  source: 'live' | 'stable',
): Effect.Effect<OpenCodeDatabaseFacts, LocalHistoryError> =>
  Effect.gen(function* () {
    const schemaRows = yield* withPerfSpan(
      'aiUsage.collect.opencode.db.query.schema',
      db.all<SchemaRow>(OPENCODE_SCHEMA_SQL),
      (rows) => ({ db: source, rows: rows.length }),
    );
    const tables = new Set(schemaRows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])));
    const tableSets = detectOpenCodeTableSets(tables);
    if (tableSets.length === 0) {
      return yield* Effect.fail(openCodeSchemaError(dbPath, tables));
    }

    const facts: OpenCodeDatabaseFacts = {
      factsBySession: new Map(),
      meta: new Map(),
      rejectedMetricRecords: 0,
      skillPartRows: [],
      skillPartsTruncated: false,
      toolCount: new Map(),
      turnCount: new Map(),
    };
    // Message ids already taken from the current schema; the same ids in the
    // legacy tables are the pre-migration copies of those messages.
    const currentMessageIds = new Set<string>();
    const limit = openCodeSkillPartLimit();

    for (const tableSet of tableSets) {
      const span = (name: string) => `aiUsage.collect.opencode.db.query.${name}`;
      const isCurrent = tableSet.kind === 'v2';
      const claim = (messageId: string | null): boolean => {
        if (messageId === null) {
          return true;
        }
        if (isCurrent) {
          currentMessageIds.add(messageId);
          return true;
        }
        return !currentMessageIds.has(messageId);
      };

      const sessionRows = yield* withPerfSpan(span('sessions'), db.all<SessionRow>(tableSet.sessionSql), (rows) => ({
        db: source,
        rows: rows.length,
        schema: tableSet.kind,
      }));
      for (const row of sessionRows) {
        const additions = parseOptionalNonNegativeSafeInteger(row.summary_additions);
        const deletions = parseOptionalNonNegativeSafeInteger(row.summary_deletions);
        if (!(typeof row.id === 'string' && additions.ok && deletions.ok)) {
          facts.rejectedMetricRecords++;
          continue;
        }
        // The current schema was read first: its row describes the session as it is now.
        if (facts.meta.has(row.id)) {
          continue;
        }
        facts.meta.set(row.id, {
          parentId: row.parent_id || null,
          title: row.title || '',
          dir: row.directory || '',
          add: additions.value,
          del: deletions.value,
        });
      }

      const messageRows = yield* withPerfSpan(span('messages'), db.all<MessageRow>(tableSet.messageSql), (rows) => ({
        db: source,
        rows: rows.length,
        schema: tableSet.kind,
      }));
      yield* withPerfSpan(
        'aiUsage.collect.opencode.parse.messages',
        Effect.sync(() => {
          let assistantRows = 0;
          let tokenRows = 0;
          let skippedRows = 0;
          for (const row of messageRows) {
            if (!claim(optionalId(row.id))) {
              skippedRows++;
              continue;
            }
            const data = safeJSON(row.data);
            if (tableSet.role === 'assistant' && data === null) {
              // The row is declared an assistant message by its type column, so
              // an unreadable payload is a lost metric record, not a non-metric row.
              facts.rejectedMetricRecords++;
              continue;
            }
            const role = tableSet.role ?? data?.role;
            if (role !== 'assistant') {
              continue;
            }
            assistantRows++;
            const decoded = decodeOpenCodeMessageRow({ ...data, role, created: row.time_created });
            if (decoded.kind === 'ignored') {
              continue;
            }
            if (decoded.kind === 'invalid') {
              facts.rejectedMetricRecords++;
              continue;
            }
            tokenRows++;
            facts.factsBySession.getOrInsertComputed(row.session_id, () => []).push(decoded.value);
          }
          return { assistantRows, skippedRows, tokenRows };
        }),
        (result) => ({
          db: source,
          rows: messageRows.length,
          schema: tableSet.kind,
          sessions: facts.factsBySession.size,
          assistantRows: result.assistantRows,
          skippedRows: result.skippedRows,
          tokenRows: result.tokenRows,
        }),
      );

      const turnRows = yield* withPerfSpan(span('turnCounts'), db.all<TurnRow>(tableSet.turnSql), (rows) => ({
        db: source,
        rows: rows.length,
        schema: tableSet.kind,
      }));
      for (const row of turnRows) {
        if (typeof row.session_id !== 'string') {
          facts.rejectedMetricRecords++;
          continue;
        }
        if (claim(optionalId(row.message_id))) {
          facts.turnCount.set(row.session_id, (facts.turnCount.get(row.session_id) ?? 0) + 1);
        }
      }

      const toolRows = yield* withPerfSpan(span('toolCounts'), db.all<ToolCountRow>(tableSet.toolCountSql), (rows) => ({
        db: source,
        rows: rows.length,
        schema: tableSet.kind,
      }));
      for (const row of toolRows) {
        const count = parseOptionalNonNegativeSafeInteger(row.n);
        if (!(typeof row.session_id === 'string' && count.ok)) {
          facts.rejectedMetricRecords++;
          continue;
        }
        if (claim(optionalId(row.message_id))) {
          facts.toolCount.set(row.session_id, (facts.toolCount.get(row.session_id) ?? 0) + count.value);
        }
      }

      // A narrowing of the tool read above, not a second read of the same
      // table for a different purpose. The read asks for one row past the
      // bound purely to detect the bound.
      const skillRows = yield* withPerfSpan(
        span('skillParts'),
        db.all<SkillPartRow>(tableSet.skillPartSql(limit)),
        (rows) => ({ db: source, rows: rows.length, schema: tableSet.kind }),
      );
      facts.skillPartsTruncated ||= skillRows.length > limit;
      for (const row of skillRows.slice(0, limit)) {
        if (claim(optionalId(row.message_id))) {
          facts.skillPartRows.push(row);
        }
      }
    }

    // Facts from both schemas interleave within a session; the summary reads
    // model chronology from their order.
    for (const sessionFacts of facts.factsBySession.values()) {
      sessionFacts.sort(
        (left, right) => (left.createdMs ?? Number.MAX_SAFE_INTEGER) - (right.createdMs ?? Number.MAX_SAFE_INTEGER),
      );
    }
    if (facts.skillPartRows.length > limit) {
      facts.skillPartsTruncated = true;
      facts.skillPartRows.length = limit;
    }
    return facts;
  });

const collectFromDb = (
  dbPath: string,
  storage: LocalHistoryStorage,
  source: 'live' | 'stable',
  cache: DbRowCache | null,
): Effect.Effect<
  CachedSkillObservations & { rejectedMetricRecords: number; rows: CollectorRow[] },
  LocalHistoryError,
  never
> =>
  withPerfSpan(
    'aiUsage.collect.opencode.db',
    Effect.gen(function* () {
      const exists = yield* withPerfSpan(
        'aiUsage.collect.opencode.db.exists',
        storage.exists(dbPath).pipe(Effect.catch(() => Effect.succeed(false))),
        (value) => ({ db: source, exists: value }),
      );
      if (!exists) {
        return { observations: [], rejected: 0, rejectedMetricRecords: 0, rows: [], truncated: false };
      }

      const stat = dbStat(dbPath);
      const cached = cachedDbCollection(cache, dbPath, stat);
      if (cached) {
        return yield* withPerfSpan('aiUsage.collect.opencode.cache.hit', Effect.succeed(cached), (result) => ({
          db: source,
          observations: result.observations.length,
          rows: result.rows.length,
        }));
      }

      const facts = yield* Effect.acquireUseRelease(
        withPerfSpan('aiUsage.collect.opencode.db.open', storage.openDatabase(dbPath), () => ({ db: source })),
        (db) => readOpenCodeDatabaseFacts(db, dbPath, source),
        (db) => db.close,
      );
      const { meta, toolCount, turnCount } = facts;
      let { rejectedMetricRecords } = facts;

      const provLabel = (providerId: string, cost: number, costKnown: boolean) => {
        if (providerId === 'openai') {
          if (!costKnown) {
            return 'OpenAI via OpenCode';
          }
          return cost > 0 ? 'OpenAI API' : 'Codex sub (OC)';
        }
        // The Claude Agent SDK provider runs on the operator's Claude Code
        // login, so a zero reported cost is subscription usage like Codex above.
        if (providerId === 'claude-agent') {
          if (!costKnown) {
            return 'Claude via OpenCode';
          }
          return cost > 0 ? 'Anthropic API' : 'Claude sub (OC)';
        }
        if (providerId === 'anthropic') {
          return 'Anthropic API';
        }
        if (providerId === 'opencode') {
          return 'OpenCode Zen';
        }
        if (providerId === 'opencode-go') {
          return 'OpenCode Go';
        }
        if (providerId === 'cursor') {
          return 'via Cursor (OC)';
        }
        return providerId;
      };

      const sessions = yield* withPerfSpan(
        'aiUsage.collect.opencode.mapSessions',
        Effect.sync(() => {
          const mappedSessions: CollectedSession[] = [];
          const vcsByDirectory = new Map<string, SessionVcsContext | undefined>();
          const vcsForDirectory = (directory: string): SessionVcsContext | undefined => {
            if (vcsByDirectory.has(directory)) {
              return vcsByDirectory.get(directory);
            }
            const repository = readLocalGitRepository(directory || null);
            const vcs = repository
              ? parseSessionVcsContext({
                  branches: [],
                  headCommit: null,
                  partial: false,
                  pullRequests: [],
                  repository,
                })
              : undefined;
            vcsByDirectory.set(directory, vcs);
            return vcs;
          };
          for (const [sid, sessionFacts] of facts.factsBySession) {
            const summary = buildOpenCodeProjectionSummary(sessionFacts);
            if (!summary) {
              rejectedMetricRecords++;
              continue;
            }
            const sessionMeta = meta.get(sid);
            const tokens = {
              in: summary.tokens.input,
              out: summary.tokens.output,
              cr: summary.tokens.cacheRead,
              cw: summary.tokens.cacheWrite,
            };
            const title = classifyOpenCodeTitle(sessionMeta?.title ?? null, sid);
            const sourcePath = sessionMeta?.dir ?? null;
            const vcs = vcsForDirectory(sourcePath ?? '');
            mappedSessions.push({
              source: {
                harnessKey: 'opencode',
                sourceSessionId: sid,
                ...(sessionMeta?.parentId ? { parentSourceSessionId: sessionMeta.parentId } : {}),
                sourcePath,
                ...(vcs ? { vcs } : {}),
              },
              projectPath: sessionMeta?.dir ?? null,
              date: summary.startMs === null ? null : new Date(summary.startMs),
              endDate: summary.endMs === null ? null : new Date(summary.endMs),
              ...(sessionMeta?.parentId
                ? { origin: 'subagent' as const }
                : { originProvenance: 'origin-absent' as const }),
              provider: provLabel(
                summary.dominantProviderId,
                summary.providerCosts.get(summary.dominantProviderId) ?? 0,
                summary.providerCostsKnown.get(summary.dominantProviderId) ?? false,
              ),
              name: title.name,
              titleSource: title.source,
              model: `${summary.dominantProviderId}/${summary.dominantModelId}`,
              models: summary.models,
              modelSegments: summary.modelSegments,
              pricingModel: summary.dominantModelId,
              project: base(sessionMeta?.dir),
              tokens,
              cost: actualCost(summary.reportedCostKnown ? summary.reportedCost : null),
              costApprox: summary.costApprox,
              costKnown: summary.costKnown,
              calls: summary.calls,
              durationMs: summary.durationMs,
              partial: summary.partial,
              turns: turnCount.get(sid) || 0,
              tools: toolCount.get(sid) || 0,
              linesAdded: sessionMeta?.add ?? null,
              linesDeleted: sessionMeta?.del ?? null,
            });
          }
          return mappedSessions.map(sessionToUsageRow);
        }),
        (rows) => ({ db: source, rows: rows.length, sessions: rows.length }),
      );
      const skillObservations = yield* withPerfSpan(
        'aiUsage.collect.opencode.parse.skillParts',
        Effect.sync(() => {
          const decoded: SkillObservation[] = [];
          let rejected = 0;
          for (const row of facts.skillPartRows) {
            const observation = decodeOpenCodeSkillPart({ ...row, projectPath: meta.get(row.session_id)?.dir ?? null });
            if (observation) {
              decoded.push(observation);
            } else {
              // A row that matched the skill predicate but would not decode.
              // Counted on its own channel: this is a skill-transcript shape
              // change, not a corrupted token count.
              rejected += 1;
            }
          }
          return { observations: decoded, rejected, truncated: facts.skillPartsTruncated };
        }),
        (result) => ({
          db: source,
          observations: result.observations.length,
          rejected: result.rejected,
          truncated: result.truncated,
        }),
      );

      const afterStat = dbStat(dbPath);
      if (JSON.stringify(stat) === JSON.stringify(afterStat)) {
        storeDbRows(cache, dbPath, afterStat, sessions, rejectedMetricRecords, skillObservations);
      }
      return { ...skillObservations, rejectedMetricRecords, rows: sessions };
    }),
    (result) => ({ db: source, observations: result.observations.length, rows: result.rows.length }),
  );

export const classifyOpenCodeTitle = (
  title: string | null,
  sessionId: string,
): { name: string; source: TitleSource } => {
  const normalized = title?.trim().replace(/\s+/g, ' ') ?? '';
  if (!normalized) {
    return { name: sessionId.slice(0, 10), source: 'id' };
  }
  if (DEFAULT_ACP_SESSION_TITLE.test(normalized)) {
    return { name: normalized.toLowerCase().startsWith('acp') ? 'ACP session' : sessionId.slice(0, 10), source: 'id' };
  }
  return { name: normalized, source: 'ai' };
};

export const collectOpenCode = Effect.gen(function* () {
  const result = yield* collectOpenCodeResult;
  return result.rows;
});

export const collectOpenCodeResult: Effect.Effect<OpenCodeCollectionResult, never, LocalHistoryStorage> = Effect.gen(
  function* () {
    const storage = yield* LocalHistoryStorage;
    const paths = resolvePathCandidates(storage).opencode;
    const cache = yield* withPerfSpan(
      'aiUsage.collect.opencode.cache.read',
      Effect.sync(() => readDbRowCache(storage, OPENCODE_DB_CACHE_FILE, OPENCODE_DB_CACHE_VERSION)),
      (value) => ({ enabled: value !== null, entries: value ? Object.keys(value.entries).length : 0 }),
    );
    const seen = new Set<string>();
    const warnings: LocalHistoryWarning[] = [];
    const observations: SkillObservation[] = [];
    // The live and stable databases overlap, so observations are deduplicated on
    // the same identity the store keys on rather than on their session: an
    // observation can belong to a session whose row was already taken from the
    // other database.
    const seenObservations = new Set<string>();
    let rejectedMetricRecords = 0;
    let rejectedObservations = 0;
    let databaseReadIncomplete = false;
    let observationsTruncated = false;
    const appendRows = (
      target: CollectorRow[],
      result: CachedSkillObservations & { rejectedMetricRecords: number; rows: CollectorRow[] },
    ) => {
      rejectedMetricRecords += result.rejectedMetricRecords;
      rejectedObservations += result.rejected;
      observationsTruncated ||= result.truncated;
      for (const row of result.rows) {
        const sessionId = row.source?.sourceSessionId;
        if (sessionId && seen.has(sessionId)) {
          continue;
        }
        if (sessionId) {
          seen.add(sessionId);
        }
        target.push(row);
      }
      for (const observation of result.observations) {
        const identity = skillObservationIdentity(observation);
        if (seenObservations.has(identity)) {
          continue;
        }
        seenObservations.add(identity);
        observations.push(observation);
      }
    };

    const liveRows: CollectorRow[] = [];
    for (const dbPath of paths.liveDb) {
      const result = yield* collectFromDb(dbPath, storage, 'live', cache).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: 'failure' as const, error }),
          onSuccess: (collected) => ({ _tag: 'success' as const, result: collected }),
        }),
      );
      if (result._tag === 'failure') {
        databaseReadIncomplete = true;
        warnings.push(
          localHistoryWarningFromError(result.error, {
            harness: 'opencode',
            message: 'Failed to read OpenCode live database',
          }),
        );
      } else {
        appendRows(liveRows, result.result);
      }
    }

    const stableRows: CollectorRow[] = [];
    for (const dbPath of paths.stableDb) {
      const result = yield* collectFromDb(dbPath, storage, 'stable', cache).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: 'failure' as const, error }),
          onSuccess: (collected) => ({ _tag: 'success' as const, result: collected }),
        }),
      );
      if (result._tag === 'failure') {
        databaseReadIncomplete = true;
        warnings.push(
          localHistoryWarningFromError(result.error, {
            harness: 'opencode',
            message: 'Failed to read OpenCode stable database',
          }),
        );
      } else {
        appendRows(stableRows, result.result);
      }
    }

    yield* withPerfSpan(
      'aiUsage.collect.opencode.cache.write',
      Effect.sync(() => writeDbRowCache(storage, OPENCODE_DB_CACHE_FILE, OPENCODE_DB_CACHE_VERSION, cache)),
      (wrote) => ({ wrote }),
    );

    const metricWarning = metricValidationWarning('opencode', rejectedMetricRecords);
    if (metricWarning) {
      warnings.push(metricWarning);
    }
    const observationWarning = skillObservationValidationWarning('opencode', rejectedObservations);
    if (observationWarning) {
      warnings.push(observationWarning);
    }
    if (observationsTruncated) {
      warnings.push(skillObservationTruncationWarning('opencode', openCodeSkillPartLimit()));
    }
    return {
      observationCompleteness: {
        exposure: { rejected: 0, truncated: false },
        invocation: { rejected: rejectedObservations, truncated: observationsTruncated || databaseReadIncomplete },
      },
      observations,
      rows: [...liveRows, ...stableRows],
      warnings,
    };
  },
);
