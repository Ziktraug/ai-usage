import {
  type LocalHistoryError,
  type LocalHistoryWarning,
  localHistoryWarningFromError,
} from '@ai-usage/local-machine/errors';
import { readLocalGitRepository } from '@ai-usage/local-machine/local-git';
import { type LocalHistoryDatabase, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import {
  OPENCODE_DIRECT_USER_PART_PREDICATE,
  OPENCODE_MESSAGE_METRIC_COLUMNS,
  OPENCODE_SCHEMA_SQL,
  OPENCODE_SKILL_PART_PREDICATE,
  OPENCODE_TOOL_PART_PREDICATE,
  OPENCODE_V2_SKILL_CONTENT_PREDICATE,
  OPENCODE_V2_TOOL_CONTENT_PREDICATE,
  type OpenCodeSchemaKind,
  openCodeSchemaError,
  openCodeSchemaKinds,
} from '@ai-usage/local-machine/opencode-schema';
import {
  buildOpenCodeProjectionSummary,
  decodeOpenCodeMessageColumns,
  decodeOpenCodeSkillPart,
  isOpenCodeForeignUsageProvider,
  type OpenCodeMessageColumnRow,
  type OpenCodeMessageFact,
  partitionOpenCodeUsageFacts,
} from '@ai-usage/local-machine/opencode-session-facts';
import { resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import { base } from '@ai-usage/local-machine/text';
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
  name: unknown;
}
interface CountRow {
  n: unknown;
}
interface MessageRow extends OpenCodeMessageColumnRow {
  id: unknown;
  session_id: string;
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
  /**
   * Sessions read from the OpenCode databases in this pass whose only
   * usage-bearing messages belong to a provider another harness records (ADR
   * 0090: `claude-agent`, counted by the Claude collector). They are positively
   * observed and deliberately not OpenCode usage rows; the store retires a row
   * it previously held for them. Never an id that is merely absent or
   * unreadable, and never an id that this pass also emits as a row. A warm pass
   * served from the row cache does not re-read the databases and reports none.
   */
  retiredSourceSessionIds: string[];
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

// Bumped to 12 for the skill-observation stream: an entry written by version 11
// carries rows but no observations, and reusing it would report a machine with
// history as a machine that has never invoked a skill.
// Rows include calculated costs; invalidate them when newly priced models land.
// Bumped to 14 for the `session_v2` storage: an entry written by version 13 was
// read from the legacy tables only and misses every session since the migration.
// Bumped to 15 for cross-harness ownership (ADR 0090): an entry written by
// version 14 counts `claude-agent` messages that the Claude collector also counts.
const OPENCODE_DB_CACHE_VERSION = 15;
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
 * The two OpenCode schemas (see `OPENCODE_SCHEMA_SQL`). Message reads project
 * only the metric columns: an assistant payload in the current schema carries
 * the whole reasoning, text and tool state of the message in `data.content`,
 * which is hundreds of megabytes over a year of history and is never needed for
 * a usage row. Content is scanned only by the tool-count and skill queries,
 * which aggregate it in SQL.
 */
export const OPENCODE_LEGACY_SESSION_SQL =
  'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session';
export const OPENCODE_LEGACY_TOOL_COUNT_SQL = `SELECT session_id, message_id, count(*) n FROM part WHERE ${OPENCODE_TOOL_PART_PREDICATE} GROUP BY session_id, message_id`;
// One over the bound, so hitting it is detectable rather than silent.
export const openCodeLegacySkillPartSql = (limit: number) =>
  `SELECT id, message_id, session_id, time_created, data FROM part WHERE ${OPENCODE_SKILL_PART_PREDICATE} ORDER BY session_id, time_created, id LIMIT ${limit + 1}`;
export const OPENCODE_LEGACY_TURN_SQL = `SELECT m.session_id, m.id AS message_id FROM message m JOIN part p ON p.message_id = m.id WHERE json_valid(m.data) AND json_valid(p.data) AND json_extract(m.data, '$.role') = 'user' AND ${OPENCODE_DIRECT_USER_PART_PREDICATE} GROUP BY m.session_id, m.id`;
export const OPENCODE_LEGACY_MESSAGE_SQL = `SELECT id, session_id, json_extract(data, '$.role') AS role, ${OPENCODE_MESSAGE_METRIC_COLUMNS} FROM message WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant' ORDER BY session_id, time_created, id`;

export const OPENCODE_V2_SESSION_SQL =
  'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session_v2';
export const OPENCODE_V2_TOOL_COUNT_SQL = `SELECT sm.session_id, sm.id AS message_id, count(*) n FROM session_message sm, json_each(sm.data, '$.content') c WHERE ${OPENCODE_V2_TOOL_CONTENT_PREDICATE} GROUP BY sm.session_id, sm.id`;
export const openCodeV2SkillPartSql = (limit: number) =>
  `SELECT sm.id AS message_id, sm.session_id, sm.time_created, c.value AS data FROM session_message sm, json_each(sm.data, '$.content') c WHERE ${OPENCODE_V2_SKILL_CONTENT_PREDICATE} ORDER BY sm.session_id, sm.time_created, sm.id, c.key LIMIT ${limit + 1}`;
// Synthetic and system inputs have their own `type`, so every `user` row is a
// direct prompt; the legacy schema needs the part predicate for the same cut.
export const OPENCODE_V2_TURN_SQL = "SELECT session_id, id AS message_id FROM session_message WHERE type = 'user'";
export const OPENCODE_V2_MESSAGE_SQL = `SELECT id, session_id, 'assistant' AS role, ${OPENCODE_MESSAGE_METRIC_COLUMNS} FROM session_message WHERE type = 'assistant' AND json_valid(data) ORDER BY session_id, time_created, id`;
// The row is declared an assistant message by its type column, so an unreadable
// payload is a lost metric record; the metric read above filters it out.
export const OPENCODE_V2_MALFORMED_ASSISTANT_SQL =
  "SELECT count(*) n FROM session_message WHERE type = 'assistant' AND NOT json_valid(data)";

interface OpenCodeTableSet {
  kind: OpenCodeSchemaKind;
  malformedAssistantSql: string | null;
  messageSql: string;
  sessionSql: string;
  skillPartSql: (limit: number) => string;
  toolCountSql: string;
  turnSql: string;
}

const OPENCODE_V2_TABLES: OpenCodeTableSet = {
  kind: 'v2',
  malformedAssistantSql: OPENCODE_V2_MALFORMED_ASSISTANT_SQL,
  messageSql: OPENCODE_V2_MESSAGE_SQL,
  sessionSql: OPENCODE_V2_SESSION_SQL,
  skillPartSql: openCodeV2SkillPartSql,
  toolCountSql: OPENCODE_V2_TOOL_COUNT_SQL,
  turnSql: OPENCODE_V2_TURN_SQL,
};

const OPENCODE_LEGACY_TABLES: OpenCodeTableSet = {
  kind: 'legacy',
  malformedAssistantSql: null,
  messageSql: OPENCODE_LEGACY_MESSAGE_SQL,
  sessionSql: OPENCODE_LEGACY_SESSION_SQL,
  skillPartSql: openCodeLegacySkillPartSql,
  toolCountSql: OPENCODE_LEGACY_TOOL_COUNT_SQL,
  turnSql: OPENCODE_LEGACY_TURN_SQL,
};

const OPENCODE_TABLE_SETS: Record<OpenCodeSchemaKind, OpenCodeTableSet> = {
  legacy: OPENCODE_LEGACY_TABLES,
  v2: OPENCODE_V2_TABLES,
};

const optionalId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

interface OpenCodeDatabaseFacts {
  factsBySession: Map<string, OpenCodeMessageFact[]>;
  /** Assistant messages of a foreign-owned provider; their tool calls are that harness's too. */
  foreignMessageIds: Set<string>;
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
    const tableSets = openCodeSchemaKinds(tables).map((kind) => OPENCODE_TABLE_SETS[kind]);
    if (tableSets.length === 0) {
      return yield* Effect.fail(openCodeSchemaError(dbPath, tables));
    }

    const facts: OpenCodeDatabaseFacts = {
      factsBySession: new Map(),
      foreignMessageIds: new Set(),
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
          let tokenRows = 0;
          let skippedRows = 0;
          for (const row of messageRows) {
            if (!claim(optionalId(row.id))) {
              skippedRows++;
              continue;
            }
            const decoded = decodeOpenCodeMessageColumns(row);
            if (decoded.kind === 'ignored') {
              continue;
            }
            if (decoded.kind === 'invalid') {
              facts.rejectedMetricRecords++;
              continue;
            }
            tokenRows++;
            facts.factsBySession.getOrInsertComputed(row.session_id, () => []).push(decoded.value);
            const messageId = optionalId(row.id);
            if (messageId !== null && isOpenCodeForeignUsageProvider(decoded.value.providerId)) {
              facts.foreignMessageIds.add(messageId);
            }
          }
          return { skippedRows, tokenRows };
        }),
        (result) => ({
          db: source,
          rows: messageRows.length,
          schema: tableSet.kind,
          sessions: facts.factsBySession.size,
          skippedRows: result.skippedRows,
          tokenRows: result.tokenRows,
        }),
      );
      if (tableSet.malformedAssistantSql) {
        const malformedRows = yield* withPerfSpan(
          span('malformedMessages'),
          db.all<CountRow>(tableSet.malformedAssistantSql),
          (rows) => ({ db: source, rows: rows.length, schema: tableSet.kind }),
        );
        const malformed = parseOptionalNonNegativeSafeInteger(malformedRows[0]?.n);
        // A count that does not parse is itself one unreadable record.
        facts.rejectedMetricRecords += malformed.ok ? malformed.value : 1;
      }

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
        const toolMessageId = optionalId(row.message_id);
        // A foreign-owned message's tool calls are in that harness's transcript too.
        if (claim(toolMessageId) && !(toolMessageId !== null && facts.foreignMessageIds.has(toolMessageId))) {
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

type OpenCodeDatabaseCollection = CachedSkillObservations & {
  rejectedMetricRecords: number;
  retiredSourceSessionIds: string[];
  rows: CollectorRow[];
};

const collectFromDb = (
  dbPath: string,
  storage: LocalHistoryStorage,
  source: 'live' | 'stable',
  cache: DbRowCache | null,
): Effect.Effect<OpenCodeDatabaseCollection, LocalHistoryError, never> =>
  withPerfSpan(
    'aiUsage.collect.opencode.db',
    Effect.gen(function* () {
      const exists = yield* withPerfSpan(
        'aiUsage.collect.opencode.db.exists',
        storage.exists(dbPath).pipe(Effect.catch(() => Effect.succeed(false))),
        (value) => ({ db: source, exists: value }),
      );
      if (!exists) {
        return {
          observations: [],
          rejected: 0,
          rejectedMetricRecords: 0,
          retiredSourceSessionIds: [],
          rows: [],
          truncated: false,
        };
      }

      const stat = dbStat(dbPath);
      const cached = cachedDbCollection(cache, dbPath, stat);
      if (cached) {
        // The row cache carries no retirements: a warm pass reports none, and
        // the store keeps a retired row retired until the session is re-emitted.
        return yield* withPerfSpan(
          'aiUsage.collect.opencode.cache.hit',
          Effect.succeed({ ...cached, retiredSourceSessionIds: [] }),
          (result) => ({
            db: source,
            observations: result.observations.length,
            rows: result.rows.length,
          }),
        );
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
        // `claude-agent` never reaches here: its usage is the Claude collector's
        // (ADR 0090), so it is partitioned out before the dominant provider is chosen.
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

      const retiredSourceSessionIds: string[] = [];
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
            const { foreign, owned } = partitionOpenCodeUsageFacts(sessionFacts);
            if (owned.length === 0) {
              // Every usage-bearing message belongs to another harness: the
              // session is observed, and deliberately not an OpenCode usage row.
              retiredSourceSessionIds.push(sid);
              continue;
            }
            const summary = buildOpenCodeProjectionSummary(owned);
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
              // Foreign-owned turns leave the row a lower bound of the session's
              // activity; the "≥" marker is the existing way to say so.
              partial: summary.partial || foreign.length > 0,
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
      return { ...skillObservations, rejectedMetricRecords, retiredSourceSessionIds, rows: sessions };
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
    // Retirements are reconciled against rows at the end: a session that one
    // database retires and the other emits as a row has owned usage, so the
    // row wins.
    const retired = new Set<string>();
    let rejectedMetricRecords = 0;
    let rejectedObservations = 0;
    let databaseReadIncomplete = false;
    let observationsTruncated = false;
    const appendRows = (target: CollectorRow[], result: OpenCodeDatabaseCollection) => {
      rejectedMetricRecords += result.rejectedMetricRecords;
      rejectedObservations += result.rejected;
      observationsTruncated ||= result.truncated;
      for (const sessionId of result.retiredSourceSessionIds) {
        retired.add(sessionId);
      }
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
      retiredSourceSessionIds: [...retired].filter((sessionId) => !seen.has(sessionId)).sort(),
      rows: [...liveRows, ...stableRows],
      warnings,
    };
  },
);
