import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LocalHistoryWarning, localHistoryWarningFromError } from '@ai-usage/local-machine/errors';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { firstExisting, resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import { base, isJsonObject, safeJSON, usablePrompt } from '@ai-usage/local-machine/text';
import type { TitleSource } from '@ai-usage/report-core/types';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { cachedDbCollection, dbStat, readDbRowCache, storeDbRows, writeDbRowCache } from '../collector-cache';
import {
  addNonNegativeSafeIntegers,
  metricValidationWarning,
  parseOptionalNonNegativeFiniteNumber,
  parseOptionalNonNegativeSafeInteger,
} from '../metric-validation';
import { withPerfSpan } from '../perf';
import type { CollectorRow } from '../rtk-enrichment';
import {
  type CursorCsvOptions,
  type CursorCsvTurn,
  collectCursorCsvTurnsResult,
  cursorCsvMissingInputWarning,
} from './cursor-csv';
import { type CursorReconcileOptions, reconcileCursorSessions } from './cursor-reconcile';

interface KeyValueRow {
  key: string;
  value: string;
}
const cursorTitleSource = (aiTitle: string | null | undefined, firstPrompt: string | null | undefined): TitleSource => {
  if (aiTitle) {
    return 'ai';
  }
  if (firstPrompt) {
    return 'first-prompt';
  }
  return 'id';
};

const COMPOSER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'";
const TOKEN_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"inputTokens\"%'";
const USER_BUBBLE_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"type\":1%'";
/** Per-workspace composer list: `{ allComposers: [{ composerId, ... }] }` in the workspace `state.vscdb`. */
const WORKSPACE_COMPOSERS_SQL = "SELECT value FROM ItemTable WHERE key = 'composer.composerData'";
const WORKSPACE_JSON_MAX_BYTES = 64 * 1024;
/** Workspaces are dozens on a developer machine; the bound guards a corrupt listing, not volume. */
const MAX_CURSOR_WORKSPACES = 512;

// Bumped to 8: rows now carry the billed model(s) from `usageData`, Cursor's metered cost as the
// quota perspective, the workspace folder as project, and token-less composers keep their model.
// Rows include calculated costs; invalidate them when newly priced models land.
// Bumped to 9: the shared cache entry now carries the (always empty for Cursor) retirement list
// and an entry without it is rejected on read; the bump makes that one-time re-parse explicit.
const CURSOR_DB_CACHE_VERSION = 9;
const CURSOR_DB_CACHE_FILE = 'cursor-db-cache.json';

export type CursorCsvIngestionOptions = Partial<CursorCsvOptions> & {
  maxSessionSpanMs?: number;
  reconcileWindowMs?: number;
};

export interface CursorCollectionResult {
  /**
   * Composers observed in this pass that are deliberately not Cursor usage rows. Cursor imports
   * no other tool's sessions and counts nothing under another harness, so the list is always
   * empty; it exists so the store retires rows on an explicit declaration, never on absence.
   */
  retiredSourceSessionIds: string[];
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

interface CursorDbRowsResult {
  rejectedMetricRecords: number;
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

/**
 * Cursor's own request accounting for a composer: `usageData` maps each billed model to its
 * request count and metered cost in cents. It is the only record of which model actually served
 * the requests; `modelConfig` is merely the model selected in the picker when the composer was
 * last saved. Tokens are not split per model, so no segments are fabricated from it.
 */
interface ComposerUsage {
  costCents: number;
  dominantModel: string;
  models: string[];
}

interface ComposerRecord {
  add: number;
  created: number;
  del: number;
  name: string;
  selectedModel: string | null;
  usage: ComposerUsage | null;
}

type ComposerUsageParse = { ok: true; usage: ComposerUsage | null } | { ok: false };

const parseComposerUsage = (value: unknown): ComposerUsageParse => {
  if (value === undefined || value === null) {
    return { ok: true, usage: null };
  }
  if (!isJsonObject(value)) {
    return { ok: false };
  }
  const entries: { cents: number; model: string; requests: number }[] = [];
  for (const [model, record] of Object.entries(value)) {
    if (!(model.length > 0 && isJsonObject(record))) {
      return { ok: false };
    }
    const requests = parseOptionalNonNegativeSafeInteger(record.amount);
    const cents = parseOptionalNonNegativeFiniteNumber(record.costInCents);
    if (!(requests.ok && cents.ok)) {
      return { ok: false };
    }
    entries.push({ cents: cents.value, model, requests: requests.value });
  }
  const first = entries[0];
  if (!first) {
    return { ok: true, usage: null };
  }
  // Stable sort: equal request counts keep Cursor's own key order.
  const ranked = [...entries].sort((left, right) => right.requests - left.requests);
  return {
    ok: true,
    usage: {
      costCents: entries.reduce((total, entry) => total + entry.cents, 0),
      dominantModel: (ranked[0] ?? first).model,
      models: ranked.map((entry) => entry.model),
    },
  };
};

const composerModelFields = (composer: ComposerRecord | undefined): Pick<CollectedSession, 'model' | 'models'> => {
  const model = composer?.usage?.dominantModel ?? composer?.selectedModel ?? 'cursor';
  const models = composer?.usage && composer.usage.models.length > 1 ? composer.usage.models : undefined;
  return { model, ...(models ? { models } : {}) };
};

// Cursor meters every request at API prices against the plan's included amount, then on demand.
// Without the export's `Kind` column the two cannot be told apart, so the metered value is
// reported as the quota perspective; a reconciled export replaces it with the Kind-aware split.
const composerCostFields = (composer: ComposerRecord | undefined): Pick<CollectedSession, 'costQuota'> =>
  composer?.usage ? { costQuota: composer.usage.costCents / 100 } : {};

const composerProjectFields = (
  folder: string | undefined,
): Pick<CollectedSession, 'project'> & { projectPath?: string } =>
  folder ? { project: base(folder), projectPath: folder } : { project: '' };

const hasCursorCsvInput = (cursorCsv: CursorCsvIngestionOptions | undefined) =>
  Boolean(cursorCsv?.usageExportPaths?.length || cursorCsv?.usageExportDir);

const cursorCsvTurnsOptions = (cursorCsv: CursorCsvIngestionOptions): CursorCsvOptions => ({
  usageExportPaths: cursorCsv.usageExportPaths ?? [],
  ...(cursorCsv.usageExportDir ? { usageExportDir: cursorCsv.usageExportDir } : {}),
  clusterGapMs: cursorCsv.clusterGapMs ?? 5 * 60_000,
  ...(cursorCsv.user ? { user: cursorCsv.user } : {}),
});

const cursorCsvReconcileOptions = (cursorCsv: CursorCsvIngestionOptions): CursorReconcileOptions => ({
  clusterGapMs: cursorCsv.clusterGapMs ?? 5 * 60_000,
  maxSessionSpanMs: cursorCsv.maxSessionSpanMs ?? 60 * 60_000,
  reconcileWindowMs: cursorCsv.reconcileWindowMs ?? 3 * 60_000,
});

const cursorSessionsToRows = (sessions: CollectedSession[]) => sessions.map(sessionToUsageRow);

const workspaceFolderPath = (workspaceJson: string): string | null => {
  const folder = safeJSON(workspaceJson)?.folder;
  if (typeof folder !== 'string') {
    // Multi-root (`workspace`) and remote workspaces name no local folder: no project, by design.
    return null;
  }
  try {
    const url = new URL(folder);
    return url.protocol === 'file:' ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
};

const sqliteText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : null;
};

const workspaceComposerIds = (value: unknown): string[] => {
  const text = sqliteText(value);
  const composers = text === null ? null : safeJSON(text)?.allComposers;
  if (!Array.isArray(composers)) {
    return [];
  }
  return composers.flatMap((composer) =>
    isJsonObject(composer) && typeof composer.composerId === 'string' && composer.composerId.length > 0
      ? [composer.composerId]
      : [],
  );
};

const matchFailure =
  <A, E, R>() =>
  (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'failure' as const, error }),
        onSuccess: (value) => ({ _tag: 'success' as const, value }),
      }),
    );

/**
 * Composer → workspace folder, from `workspaceStorage/<hash>/{workspace.json,state.vscdb}`.
 * Read-only and bounded; a workspace that cannot be read costs its own attribution and a warning,
 * never the collection. `readFailed` says whether any read failed: the attribution is then a
 * product of the failure, not of the databases, and must not be cached against the state database.
 */
const readCursorWorkspaceProjects = (storage: LocalHistoryStorageService, workspaceStorageDir: string | null) =>
  Effect.gen(function* () {
    const projects = new Map<string, string>();
    const warnings: LocalHistoryWarning[] = [];
    let readFailed = false;
    if (!workspaceStorageDir) {
      return { projects, readFailed, warnings };
    }
    const listed = yield* storage.readDir(workspaceStorageDir).pipe(matchFailure());
    if (listed._tag === 'failure') {
      warnings.push(
        localHistoryWarningFromError(listed.error, {
          harness: 'cursor',
          message: 'Failed to list Cursor workspace storage; sessions carry no project',
        }),
      );
      return { projects, readFailed: true, warnings };
    }
    const directories = listed.value
      .filter((entry) => entry.isDirectory)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (directories.length > MAX_CURSOR_WORKSPACES) {
      warnings.push({
        harness: 'cursor',
        operation: 'cursor.workspaceStorage',
        path: workspaceStorageDir,
        message: `Cursor workspace storage lists ${directories.length} workspaces; project attribution read the first ${MAX_CURSOR_WORKSPACES}.`,
      });
    }
    for (const entry of directories.slice(0, MAX_CURSOR_WORKSPACES)) {
      const workspaceDir = path.join(workspaceStorageDir, entry.name);
      const descriptionPath = path.join(workspaceDir, 'workspace.json');
      const dbPath = path.join(workspaceDir, 'state.vscdb');
      const exists = (filePath: string) => storage.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));
      // An empty-window workspace has no description; it opened no folder, so it maps nothing.
      if (!((yield* exists(descriptionPath)) && (yield* exists(dbPath)))) {
        continue;
      }
      const description = yield* storage.readText(descriptionPath, WORKSPACE_JSON_MAX_BYTES).pipe(matchFailure());
      if (description._tag === 'failure') {
        readFailed = true;
        warnings.push(
          localHistoryWarningFromError(description.error, {
            harness: 'cursor',
            message: 'Failed to read a Cursor workspace description; its sessions carry no project',
          }),
        );
        continue;
      }
      const folder = workspaceFolderPath(description.value);
      if (!folder) {
        continue;
      }
      const composers = yield* Effect.acquireUseRelease(
        storage.openDatabase(dbPath),
        (db) => db.all<{ value: unknown }>(WORKSPACE_COMPOSERS_SQL),
        (db) => db.close,
      ).pipe(matchFailure());
      if (composers._tag === 'failure') {
        readFailed = true;
        warnings.push(
          localHistoryWarningFromError(composers.error, {
            harness: 'cursor',
            message: 'Failed to read a Cursor workspace database; its sessions carry no project',
          }),
        );
        continue;
      }
      for (const row of composers.value) {
        for (const composerId of workspaceComposerIds(row.value)) {
          if (!projects.has(composerId)) {
            projects.set(composerId, folder);
          }
        }
      }
    }
    return { projects, readFailed, warnings };
  });

const collectCursorSessionsFromDb = (
  storage: LocalHistoryStorageService,
  dbPath: string,
  workspaceStorageDir: string | null,
) =>
  Effect.gen(function* () {
    const comp = new Map<string, ComposerRecord>();
    const agg = new Map<string, { in: number; out: number; cr: number; cw: number; calls: number }>();
    const naming = new Map<string, { turns: number; first: string | null }>();
    let rejectedMetricRecords = 0;

    yield* Effect.acquireUseRelease(
      withPerfSpan('aiUsage.collect.cursor.db.open', storage.openDatabase(dbPath)),
      (db) =>
        Effect.gen(function* () {
          const composerRows = yield* withPerfSpan(
            'aiUsage.collect.cursor.db.query.composers',
            db.all<KeyValueRow>(COMPOSER_SQL),
            (rows) => ({ rows: rows.length }),
          );
          yield* withPerfSpan(
            'aiUsage.collect.cursor.parse.composers',
            Effect.sync(() => {
              for (const row of composerRows) {
                const id = row.key.slice('composerData:'.length);
                const data = safeJSON(row.value);
                if (!data) {
                  continue;
                }
                const created = parseOptionalNonNegativeSafeInteger(data.createdAt);
                const added = parseOptionalNonNegativeSafeInteger(data.totalLinesAdded);
                const removed = parseOptionalNonNegativeSafeInteger(data.totalLinesRemoved);
                if (!(created.ok && added.ok && removed.ok)) {
                  rejectedMetricRecords++;
                  continue;
                }
                const usage = parseComposerUsage(data.usageData);
                if (!usage.ok) {
                  // The composer stays, attributed to its selected model; only the accounting is lost.
                  rejectedMetricRecords++;
                }
                const modelConfig = isJsonObject(data.modelConfig) ? data.modelConfig : null;
                comp.set(id, {
                  name: typeof data.name === 'string' ? data.name : '',
                  selectedModel:
                    (typeof modelConfig?.modelName === 'string' ? modelConfig.modelName : null) ??
                    (typeof modelConfig?.model === 'string' ? modelConfig.model : null),
                  usage: usage.ok ? usage.usage : null,
                  created: created.value,
                  add: added.value,
                  del: removed.value,
                });
              }
            }),
            () => ({ rows: composerRows.length, composers: comp.size }),
          );

          const tokenRows = yield* withPerfSpan(
            'aiUsage.collect.cursor.db.query.tokens',
            db.all<KeyValueRow>(TOKEN_SQL),
            (rows) => ({ rows: rows.length }),
          );
          yield* withPerfSpan(
            'aiUsage.collect.cursor.parse.tokens',
            Effect.sync(() => {
              for (const row of tokenRows) {
                const parts = String(row.key).split(':');
                const composerId = parts[1];
                const data = safeJSON(row.value);
                const tokenCount = isJsonObject(data?.tokenCount) ? data.tokenCount : null;
                if (!(tokenCount && composerId)) {
                  continue;
                }
                const input = parseOptionalNonNegativeSafeInteger(tokenCount.inputTokens);
                const output = parseOptionalNonNegativeSafeInteger(tokenCount.outputTokens);
                const cacheRead = parseOptionalNonNegativeSafeInteger(tokenCount.cacheReadTokens);
                const cacheWrite = parseOptionalNonNegativeSafeInteger(tokenCount.cacheWriteTokens);
                if (!(input.ok && output.ok && cacheRead.ok && cacheWrite.ok)) {
                  rejectedMetricRecords++;
                  continue;
                }
                const inputTotal = addNonNegativeSafeIntegers(input.value, output.value);
                const cacheTotal = addNonNegativeSafeIntegers(cacheRead.value, cacheWrite.value);
                const total =
                  inputTotal.ok && cacheTotal.ok
                    ? addNonNegativeSafeIntegers(inputTotal.value, cacheTotal.value)
                    : null;
                if (!total?.ok) {
                  rejectedMetricRecords++;
                  continue;
                }
                if (total.value === 0) {
                  continue;
                }
                const current = agg.getOrInsertComputed(composerId, () => ({ in: 0, out: 0, cr: 0, cw: 0, calls: 0 }));
                const nextInput = addNonNegativeSafeIntegers(current.in, input.value);
                const nextOutput = addNonNegativeSafeIntegers(current.out, output.value);
                const nextCacheRead = addNonNegativeSafeIntegers(current.cr, cacheRead.value);
                const nextCacheWrite = addNonNegativeSafeIntegers(current.cw, cacheWrite.value);
                const nextCalls = addNonNegativeSafeIntegers(current.calls, 1);
                if (!(nextInput.ok && nextOutput.ok && nextCacheRead.ok && nextCacheWrite.ok && nextCalls.ok)) {
                  rejectedMetricRecords++;
                  continue;
                }
                current.in = nextInput.value;
                current.out = nextOutput.value;
                current.cr = nextCacheRead.value;
                current.cw = nextCacheWrite.value;
                current.calls = nextCalls.value;
              }
            }),
            () => ({ rows: tokenRows.length, sessions: agg.size }),
          );

          const namedComposerIds = new Set(comp.keys());
          const userRows = yield* withPerfSpan(
            'aiUsage.collect.cursor.db.query.userBubbles',
            db.all<KeyValueRow>(USER_BUBBLE_SQL),
            (rows) => ({ rows: rows.length }),
          );
          yield* withPerfSpan(
            'aiUsage.collect.cursor.parse.userBubbles',
            Effect.sync(() => {
              for (const row of userRows) {
                const composerId = String(row.key).split(':')[1];
                if (!(composerId && namedComposerIds.has(composerId))) {
                  continue;
                }
                const data = safeJSON(row.value);
                if (data?.type !== 1) {
                  continue;
                }
                const current = naming.get(composerId) ?? { turns: 0, first: null };
                current.turns++;
                if (!current.first) {
                  current.first = usablePrompt(typeof data.text === 'string' ? data.text : null);
                }
                naming.set(composerId, current);
              }
            }),
            () => ({ rows: userRows.length, sessions: naming.size }),
          );
        }),
      (db) => db.close,
    );

    const workspaces = yield* withPerfSpan(
      'aiUsage.collect.cursor.workspaces',
      readCursorWorkspaceProjects(storage, workspaceStorageDir),
      (result) => ({ composers: result.projects.size, warnings: result.warnings.length }),
    );

    const sessions = yield* withPerfSpan(
      'aiUsage.collect.cursor.mapSessions',
      Effect.sync(() => {
        const mappedSessions: CollectedSession[] = [];
        for (const [composerId, current] of agg) {
          const composer = comp.get(composerId);
          const name = naming.get(composerId);
          const tokens = {
            in: current.in,
            out: current.out,
            cr: current.cr,
            cw: current.cw,
          };
          mappedSessions.push({
            source: { harnessKey: 'cursor', sourceSessionId: composerId },
            ...composerProjectFields(workspaces.projects.get(composerId)),
            date: composer?.created ? new Date(composer.created) : null,
            endDate: null,
            provider: 'Cursor sub',
            name: composer?.name || name?.first || `cursor ${composerId.slice(0, 8)}`,
            titleSource: cursorTitleSource(composer?.name, name?.first),
            // Cursor interaction-mode fields such as isAgentic and unifiedMode do not state who started the session.
            originProvenance: 'origin-unsupported',
            ...composerModelFields(composer),
            tokens,
            cost: actualCost(0),
            ...composerCostFields(composer),
            calls: current.calls,
            turns: name?.turns || 0,
            tools: 0,
            linesAdded: composer?.add ?? null,
            linesDeleted: composer?.del ?? null,
            partial: true,
          });
        }

        // Cursor stopped persisting per-bubble token counts around Feb 2026, so recent
        // composers carry no usable tokens. Surface them as usage-unavailable rows (like
        // the Claude prompt-history fallback) so the timeline still reflects the sessions.
        // Unlike that fallback, the composer still names its model: unavailability is the
        // `usageUnavailable` flag, which every consumer reads, not a model sentinel.
        for (const [composerId, composer] of comp) {
          if (agg.has(composerId)) {
            continue;
          }
          const name = naming.get(composerId);
          if (!name || name.turns === 0) {
            continue;
          }
          mappedSessions.push({
            source: { harnessKey: 'cursor', sourceSessionId: composerId },
            ...composerProjectFields(workspaces.projects.get(composerId)),
            date: composer.created ? new Date(composer.created) : null,
            endDate: null,
            provider: 'Cursor sub',
            name: composer.name || name.first || `cursor ${composerId.slice(0, 8)}`,
            titleSource: cursorTitleSource(composer.name, name.first),
            originProvenance: 'origin-unsupported',
            ...composerModelFields(composer),
            tokens: { in: 0, out: 0, cr: 0, cw: 0 },
            cost: actualCost(null),
            ...composerCostFields(composer),
            calls: 0,
            turns: name.turns,
            tools: 0,
            linesAdded: composer.add ?? null,
            linesDeleted: composer.del ?? null,
            usageUnavailable: true,
          });
        }
        return mappedSessions;
      }),
      (mappedSessions) => ({ rows: mappedSessions.length }),
    );
    return {
      rejectedMetricRecords,
      sessions,
      warnings: workspaces.warnings,
      workspaceReadFailed: workspaces.readFailed,
    };
  });

/**
 * Rows for the state database, through the per-db row cache. The cache is the only thing standing
 * between a 200 MB `state.vscdb` and a full re-parse every cycle, so every caller goes through it;
 * export reconciliation is applied on top of the cached rows, never instead of them.
 */
const collectCursorRowsFromDb = (
  storage: LocalHistoryStorageService,
  dbPath: string,
  workspaceStorageDir: string | null,
): Effect.Effect<CursorDbRowsResult, import('@ai-usage/local-machine/errors').LocalHistoryError, never> =>
  Effect.gen(function* () {
    const cache = yield* withPerfSpan(
      'aiUsage.collect.cursor.cache.read',
      Effect.sync(() => readDbRowCache(storage, CURSOR_DB_CACHE_FILE, CURSOR_DB_CACHE_VERSION)),
      (value) => ({ enabled: value !== null, entries: value ? Object.keys(value.entries).length : 0 }),
    );
    const stat = dbStat(dbPath);
    const cached = cachedDbCollection(cache, dbPath, stat);
    if (cached) {
      return yield* withPerfSpan(
        'aiUsage.collect.cursor.cache.hit',
        Effect.succeed({ rejectedMetricRecords: cached.rejectedMetricRecords, rows: cached.rows, warnings: [] }),
        (cachedResult) => ({ rows: cachedResult.rows.length }),
      );
    }
    const result = yield* collectCursorSessionsFromDb(storage, dbPath, workspaceStorageDir);
    const rows = cursorSessionsToRows(result.sessions);
    const afterStat = dbStat(dbPath);
    // The entry is keyed on the state database alone, and a hit carries no warnings. Rows attributed
    // while a workspace read failed would be served as complete until that database changed, so they
    // are not stored: the next pass reads the workspaces again and warns again if they still fail.
    if (!result.workspaceReadFailed && JSON.stringify(stat) === JSON.stringify(afterStat)) {
      storeDbRows(cache, dbPath, afterStat, rows, result.rejectedMetricRecords);
    }
    yield* withPerfSpan(
      'aiUsage.collect.cursor.cache.write',
      Effect.sync(() => writeDbRowCache(storage, CURSOR_DB_CACHE_FILE, CURSOR_DB_CACHE_VERSION, cache)),
      (wrote) => ({ wrote }),
    );
    return { rejectedMetricRecords: result.rejectedMetricRecords, rows, warnings: result.warnings };
  });

const findCursorInputs = (storage: LocalHistoryStorageService) =>
  Effect.gen(function* () {
    const candidates = resolvePathCandidates(storage).cursor;
    const dbPath = yield* withPerfSpan(
      'aiUsage.collect.cursor.findDb',
      firstExisting(storage, ...candidates.stateVscdb),
      (found) => ({ found: found !== null }),
    );
    const workspaceStorageDir = yield* firstExisting(storage, ...candidates.workspaceStorageDir);
    return { dbPath, workspaceStorageDir };
  });

/** The subset of a cached row that export reconciliation reads or carries over. */
const cursorRowToSession = (row: CollectorRow): CollectedSession => ({
  source: { ...row.source, harnessKey: 'cursor', sourceSessionId: row.source?.sourceSessionId ?? null },
  ...(row.projectPath === undefined ? {} : { projectPath: row.projectPath }),
  date: row.date,
  endDate: row.endDate,
  provider: row.provider,
  name: row.name,
  ...(row.titleSource === undefined ? {} : { titleSource: row.titleSource }),
  ...(row.originProvenance === undefined ? {} : { originProvenance: row.originProvenance }),
  model: row.model,
  ...(row.models === undefined ? {} : { models: row.models }),
  project: row.project,
  tokens: { in: row.tokIn, out: row.tokOut, cr: row.tokCr, cw: row.tokCw },
  cost: actualCost(row.costActual),
  ...(row.costQuota === undefined ? {} : { costQuota: row.costQuota }),
  calls: row.calls,
  turns: row.turns,
  tools: row.tools,
  linesAdded: row.linesAdded,
  linesDeleted: row.linesDeleted,
  ...(row.partial === undefined ? {} : { partial: row.partial }),
  ...(row.usageUnavailable === undefined ? {} : { usageUnavailable: row.usageUnavailable }),
});

const reconcileCursorRows = (
  rows: CollectorRow[],
  turns: CursorCsvTurn[],
  options: CursorReconcileOptions,
): CollectorRow[] => {
  if (!turns.length) {
    return rows;
  }
  const sessions = rows.map(cursorRowToSession);
  const reconciled = reconcileCursorSessions(sessions, turns, options);
  // A session the export did not touch comes back as the same object: its cached row stays as is.
  return reconciled.map((session, index) => {
    const row = rows[index];
    return row && session === sessions[index] ? row : sessionToUsageRow(session);
  });
};

export const collectCursor = withPerfSpan(
  'aiUsage.collect.cursor.details',
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const { dbPath, workspaceStorageDir } = yield* findCursorInputs(storage);
    if (!dbPath) {
      return [];
    }
    const result = yield* collectCursorRowsFromDb(storage, dbPath, workspaceStorageDir);
    return result.rows;
  }),
  (rows) => ({ rows: rows.length }),
);

export const collectCursorResult = (
  cursorCsv?: CursorCsvIngestionOptions,
): Effect.Effect<
  CursorCollectionResult,
  import('@ai-usage/local-machine/errors').LocalHistoryError,
  LocalHistoryStorageService
> =>
  withPerfSpan(
    'aiUsage.collect.cursor.ingestion',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const { dbPath, workspaceStorageDir } = yield* findCursorInputs(storage);
      const warnings: LocalHistoryWarning[] = [];
      let rows: CollectorRow[] = [];
      let rejectedMetricRecords = 0;

      if (dbPath) {
        const dbResult = yield* collectCursorRowsFromDb(storage, dbPath, workspaceStorageDir).pipe(matchFailure());
        if (dbResult._tag === 'failure') {
          warnings.push(
            localHistoryWarningFromError(dbResult.error, {
              harness: 'cursor',
              message: 'Failed to read Cursor database',
            }),
          );
        } else {
          rows = dbResult.value.rows;
          rejectedMetricRecords += dbResult.value.rejectedMetricRecords;
          warnings.push(...dbResult.value.warnings);
        }
      }

      if (cursorCsv && hasCursorCsvInput(cursorCsv)) {
        const turnsResult = yield* withPerfSpan(
          'aiUsage.collect.cursorCsv',
          collectCursorCsvTurnsResult(cursorCsvTurnsOptions(cursorCsv)).pipe(matchFailure()),
          (result) => ({ status: result._tag, turns: result._tag === 'success' ? result.value.turns.length : 0 }),
        );

        if (turnsResult._tag === 'failure') {
          warnings.push(
            localHistoryWarningFromError(turnsResult.error, {
              harness: 'cursor',
              message: 'Failed to import Cursor CSV usage export',
            }),
          );
        } else {
          warnings.push(...turnsResult.value.missingInputs.map(cursorCsvMissingInputWarning));
          rejectedMetricRecords += turnsResult.value.rejectedMetricRecords;
          rows = reconcileCursorRows(rows, turnsResult.value.turns, cursorCsvReconcileOptions(cursorCsv));
        }
      }

      const metricWarning = metricValidationWarning('cursor', rejectedMetricRecords);
      if (metricWarning) {
        warnings.push(metricWarning);
      }
      return { retiredSourceSessionIds: [], rows, warnings };
    }),
    (result) => ({ rows: result.rows.length, warnings: result.warnings.length }),
  );
