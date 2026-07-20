import fs from 'node:fs';
import path from 'node:path';
import { actualCost, approximateApiCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { parseClaudeSessionFacts } from '../claude-session-facts';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { collectorCachePath, reviveCollectorRowsResult } from '../collector-cache';
import type { LocalHistoryError, LocalHistoryWarning } from '../errors';
import { COLLECTOR_CACHE_MAX_BYTES, SMALL_HISTORY_JSON_MAX_BYTES } from '../history-budgets';
import { readLocalGitRepository } from '../local-git';
import { LocalHistoryStorage, walkFiles } from '../local-history';
import { metricValidationWarning, parseNonNegativeSafeInteger } from '../metric-validation';
import { withPerfSpan } from '../perf';
import { type HarnessPaths, resolvePaths } from '../platform-paths';
import { readPrivateJson, writePrivateJson } from '../private-storage';
import type { CollectorRow } from '../rtk-enrichment';
import { base, safeJSON, usablePrompt } from '../text';

interface ClaudeHistoryFallback {
  end: Date;
  project: string | null;
  sessionId: string;
  start: Date;
  turns: number;
}
interface FileFingerprint {
  mtimeMs: number;
  path: string;
  size: number;
}
interface ClaudeCache {
  fingerprintKey: string | null;
  rejectedMetricRecords: number;
  rows: CollectorRow[];
  version: number;
}
const CLAUDE_CACHE_VERSION = 6;
const claudeCachePath = (storage: LocalHistoryStorage) => collectorCachePath(storage, 'claude-cache.json');

const readClaudeCache = (storage: LocalHistoryStorage): ClaudeCache | null => {
  try {
    if (!fs.existsSync(storage.home)) {
      return null;
    }
    const cachePath = claudeCachePath(storage);
    if (!fs.existsSync(cachePath)) {
      return { fingerprintKey: null, rejectedMetricRecords: 0, rows: [], version: CLAUDE_CACHE_VERSION };
    }
    const parsed = readPrivateJson(cachePath, COLLECTOR_CACHE_MAX_BYTES) as {
      fingerprintKey?: unknown;
      rejectedMetricRecords?: unknown;
      rows?: unknown;
      version?: number;
    };
    if (parsed.version !== CLAUDE_CACHE_VERSION) {
      return { fingerprintKey: null, rejectedMetricRecords: 0, rows: [], version: CLAUDE_CACHE_VERSION };
    }
    const revived = reviveCollectorRowsResult(parsed.rows);
    const rejectedMetricRecords = parseNonNegativeSafeInteger(parsed.rejectedMetricRecords);
    if (!(rejectedMetricRecords.ok && revived.valid && revived.rejectedMetricRecords === 0)) {
      return { fingerprintKey: null, rejectedMetricRecords: 0, rows: [], version: CLAUDE_CACHE_VERSION };
    }
    return {
      fingerprintKey: typeof parsed.fingerprintKey === 'string' ? parsed.fingerprintKey : null,
      rejectedMetricRecords: rejectedMetricRecords.value,
      rows: revived.rows,
      version: CLAUDE_CACHE_VERSION,
    };
  } catch {
    return null;
  }
};

const writeClaudeCache = (
  storage: LocalHistoryStorage,
  fingerprintKey: string | null,
  rows: CollectorRow[],
  rejectedMetricRecords: number,
) => {
  if (!fingerprintKey) {
    return false;
  }
  const cachePath = claudeCachePath(storage);
  const value = { fingerprintKey, rejectedMetricRecords, rows, version: CLAUDE_CACHE_VERSION };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COLLECTOR_CACHE_MAX_BYTES) {
    return false;
  }
  writePrivateJson(cachePath, value);
  return true;
};

const fileFingerprint = (filePath: string): FileFingerprint | null => {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    return { mtimeMs: stat.mtimeMs, path: filePath, size: stat.size };
  } catch {
    return null;
  }
};

const createClaudeFingerprintKey = (storage: LocalHistoryStorage, paths: HarnessPaths, files: string[]) => {
  try {
    if (!fs.existsSync(storage.home)) {
      return null;
    }
    const fileFingerprints: FileFingerprint[] = [];
    for (const filePath of files) {
      const fingerprint = fileFingerprint(filePath);
      if (!fingerprint) {
        return null;
      }
      fileFingerprints.push(fingerprint);
    }
    fileFingerprints.sort((left, right) => left.path.localeCompare(right.path));
    return JSON.stringify({
      config: fileFingerprint(paths.claude.configFile),
      history: fileFingerprint(paths.claude.historyFile),
      files: fileFingerprints,
    });
  } catch {
    return null;
  }
};

const HOUSEKEEPING_COMMANDS = new Set(['/clear', '/model', '/effort', '/usage', '/rate-limit-options', '/resume']);

const isUsageBearingHistoryEntry = (text: string | null) => {
  if (!text) {
    return false;
  }
  const cleaned = text.trim();
  return cleaned.length > 0 && !HOUSEKEEPING_COMMANDS.has(cleaned);
};

const readClaudeHistoryFallbacks = (
  storage: LocalHistoryStorage,
  existingSessionIds: Set<string>,
  paths: import('../platform-paths').HarnessPaths,
): Effect.Effect<ClaudeHistoryFallback[], LocalHistoryError> =>
  Effect.gen(function* () {
    const historyFile = paths.claude.historyFile;
    if (!(yield* storage.exists(historyFile))) {
      return [];
    }

    const sessions = new Map<string, ClaudeHistoryFallback>();
    yield* storage.readLines(historyFile, (line) => {
      if (!line) {
        return;
      }
      const event = safeJSON(line);
      if (!event) {
        return;
      }
      const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : null;
      if (!sessionId || existingSessionIds.has(sessionId)) {
        return;
      }
      const timestamp = Number(event.timestamp);
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) {
        return;
      }

      const display = typeof event.display === 'string' ? event.display : null;
      const prompt = usablePrompt(display);
      const usageBearing = isUsageBearingHistoryEntry(prompt);
      const current = sessions.get(sessionId) ?? {
        sessionId,
        start: date,
        end: date,
        project: typeof event.project === 'string' ? event.project : null,
        turns: 0,
      };

      if (date < current.start) {
        current.start = date;
      }
      if (date > current.end) {
        current.end = date;
      }
      if (!current.project && typeof event.project === 'string') {
        current.project = event.project;
      }
      if (usageBearing) {
        current.turns++;
      }
      sessions.set(sessionId, current);
    });

    return [...sessions.values()].filter((session) => session.turns > 0);
  });

// Claude Code prunes chat transcripts whose last activity is older than this many
// days; the default applies when `cleanupPeriodDays` is unset in settings.json.
const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;

// Surface a heads-up when Claude Code is configured to delete transcripts, since
// this report is rebuilt from those transcripts: anything pruned is unrecoverable.
export const collectClaudeRetentionWarnings: Effect.Effect<LocalHistoryWarning[], never, LocalHistoryStorage> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const paths: HarnessPaths = resolvePaths(storage);
    const settingsFile = paths.claude.settingsFile;

    const exists = yield* storage.exists(settingsFile).pipe(Effect.catchAll(() => Effect.succeed(false)));
    // Settings are user-managed config, so read them through the
    // symlink-following path: dotfiles managers commonly install
    // ~/.claude/settings.json as a symlink, which the hardened history read
    // rejects by design.
    const raw = exists
      ? yield* storage
          .readConfigText(settingsFile, SMALL_HISTORY_JSON_MAX_BYTES)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      : '{}';
    const parsed = raw === null ? null : safeJSON(raw);
    if (parsed === null) {
      // The file exists but could not be read or parsed. Retention is unknown
      // here — say so instead of wrongly claiming the lossy default applies.
      return [
        {
          harness: 'claude',
          operation: 'claude.settings',
          path: settingsFile,
          message: `Claude Code transcript retention could not be verified: ${settingsFile} exists but could not be read as JSON. If cleanupPeriodDays is unset there, Claude Code deletes transcripts after ${CLAUDE_DEFAULT_CLEANUP_DAYS} days and that usage can no longer be reported.`,
        },
      ];
    }
    const configured = parsed.cleanupPeriodDays;
    const hasExplicit = typeof configured === 'number' && Number.isFinite(configured);
    const days = hasExplicit ? configured : CLAUDE_DEFAULT_CLEANUP_DAYS;

    // Only warn when retention is at or below the lossy default; raising the value
    // (or disabling cleanup) means history is being kept, so stay quiet.
    if (days > CLAUDE_DEFAULT_CLEANUP_DAYS) {
      return [];
    }

    const detail = hasExplicit
      ? `cleanupPeriodDays is set to ${days}`
      : `cleanupPeriodDays is unset, so the ${CLAUDE_DEFAULT_CLEANUP_DAYS}-day default applies`;
    return [
      {
        harness: 'claude',
        operation: 'claude.settings',
        path: settingsFile,
        message: `Claude Code deletes chat transcripts after ${days} days (${detail}). Usage older than ${days} days is removed permanently and can no longer be reported — raise cleanupPeriodDays in ~/.claude/settings.json to keep your history.`,
      },
    ];
  });

export interface ClaudeCollectionResult {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

export const collectClaudeResult = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const paths = resolvePaths(storage);
  const dir = paths.claude.projectsDir;
  const files = yield* withPerfSpan(
    'aiUsage.collect.claude.walkFiles',
    walkFiles(storage, dir, (fileName) => fileName.endsWith('.jsonl')),
    (value) => ({ files: value.length }),
  );
  const fingerprintKey = yield* withPerfSpan(
    'aiUsage.collect.claude.fingerprint',
    Effect.sync(() => createClaudeFingerprintKey(storage, paths, files)),
    (value) => ({ enabled: value !== null }),
  );
  const cache = yield* withPerfSpan(
    'aiUsage.collect.claude.cache.read',
    Effect.sync(() => readClaudeCache(storage)),
    (value) => ({ enabled: value !== null, rows: value?.rows.length ?? 0 }),
  );
  if (cache?.fingerprintKey && cache.fingerprintKey === fingerprintKey) {
    const warning = metricValidationWarning('claude', cache.rejectedMetricRecords);
    return yield* withPerfSpan(
      'aiUsage.collect.claude.cache.hit',
      Effect.succeed({ rows: cache.rows, warnings: warning ? [warning] : [] }),
      (result) => ({ rows: result.rows.length, warnings: result.warnings.length }),
    );
  }

  let provider = 'Claude sub';
  const cfg = paths.claude.configFile;
  if (yield* storage.exists(cfg).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
    const json = safeJSON(
      yield* storage.readConfigText(cfg, SMALL_HISTORY_JSON_MAX_BYTES).pipe(Effect.catchAll(() => Effect.succeed(''))),
    );
    if (json?.hasApiKey) {
      provider = 'Claude API';
    }
  }

  const sessions: CollectedSession[] = [];
  const existingSessionIds = new Set(files.map((filePath) => path.basename(filePath, '.jsonl')));
  let rejectedMetricRecords = 0;

  yield* withPerfSpan(
    'aiUsage.collect.claude.parseFiles',
    Effect.gen(function* () {
      let lines = 0;
      for (const filePath of files) {
        const sourceSessionId = path.basename(filePath, '.jsonl');
        const isAgentFile = path.basename(filePath).startsWith('agent-');
        const records: unknown[] = [];

        yield* storage.readLines(filePath, (line) => {
          if (!line) {
            return;
          }
          lines++;
          const event = safeJSON(line);
          if (event) {
            records.push(event);
          }
        });

        const initialFacts = parseClaudeSessionFacts({ isAgentFile, records, repository: null, sourceSessionId });
        if (!initialFacts) {
          continue;
        }
        const repository = readLocalGitRepository(initialFacts.source.sourcePath);
        const facts = repository
          ? (parseClaudeSessionFacts({ isAgentFile, records, repository, sourceSessionId }) ?? initialFacts)
          : initialFacts;
        const { projection, report, source } = facts;
        rejectedMetricRecords += report.rejectedMetricRecords;

        sessions.push({
          source: {
            harnessKey: 'claude',
            sourceSessionId,
            ...(source.parentSourceSessionId === null ? {} : { parentSourceSessionId: source.parentSourceSessionId }),
            sourcePath: source.sourcePath,
            ...(source.vcs ? { vcs: source.vcs } : {}),
          },
          projectPath: source.sourcePath,
          date: report.start,
          endDate: report.end,
          provider,
          name: report.name,
          titleSource: report.titleSource,
          model: report.model,
          models: report.models,
          modelSegments: report.modelSegments,
          project: base(source.sourcePath),
          tokens: report.tokens,
          cost: provider === 'Claude API' ? approximateApiCost : actualCost(0),
          calls: report.calls,
          durationMs: projection.durationMs ?? 0,
          partial: projection.partial,
          turns: report.turns,
          tools: report.tools,
          linesAdded: null,
          linesDeleted: null,
          subagent: report.sidechain,
        });
      }
      return { files: files.length, lines, sessions: sessions.length };
    }),
    (result) => result,
  );

  for (const session of yield* readClaudeHistoryFallbacks(storage, existingSessionIds, paths)) {
    sessions.push({
      source: { harnessKey: 'claude', sourceSessionId: session.sessionId, sourcePath: session.project },
      projectPath: session.project,
      date: session.start,
      endDate: session.end,
      provider,
      name: `claude ${session.sessionId.slice(0, 8)}`,
      titleSource: 'id',
      model: 'usage unavailable',
      project: base(session.project),
      tokens: { in: 0, out: 0, cr: 0, cw: 0 },
      cost: actualCost(null),
      calls: 0,
      turns: session.turns,
      tools: 0,
      linesAdded: null,
      linesDeleted: null,
      usageUnavailable: true,
    });
  }

  const rows = sessions.map(sessionToUsageRow);
  yield* withPerfSpan(
    'aiUsage.collect.claude.cache.write',
    Effect.sync(() => writeClaudeCache(storage, fingerprintKey, rows, rejectedMetricRecords)),
    (wrote) => ({ wrote }),
  );
  const warning = metricValidationWarning('claude', rejectedMetricRecords);
  return { rows, warnings: warning ? [warning] : [] };
});

export const collectClaude = collectClaudeResult.pipe(Effect.map((result) => result.rows));
