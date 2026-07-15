import fs from 'node:fs';
import path from 'node:path';
import { actualCost, approximateApiCost, tokenTotal } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { collectorCachePath, reviveCollectorRows } from '../collector-cache';
import type { LocalHistoryError, LocalHistoryWarning } from '../errors';
import { COLLECTOR_CACHE_MAX_BYTES, SMALL_HISTORY_JSON_MAX_BYTES } from '../history-budgets';
import { LocalHistoryStorage, walkFiles } from '../local-history';
import { addNonNegativeSafeIntegers, parseOptionalNonNegativeSafeInteger } from '../metric-validation';
import { withPerfSpan } from '../perf';
import { type HarnessPaths, resolvePaths } from '../platform-paths';
import { readPrivateJson, writePrivateJson } from '../private-storage';
import type { CollectorRow } from '../rtk-enrichment';
import { base, dominant, safeJSON, usablePrompt } from '../text';

interface ClaudeHistoryFallback {
  end: Date;
  firstPrompt: string | null;
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
  rows: CollectorRow[];
  version: number;
}
const CLAUDE_CACHE_VERSION = 3;
const claudeCachePath = (storage: LocalHistoryStorage) => collectorCachePath(storage, 'claude-cache.json');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const blockType = (block: unknown) => (isRecord(block) && typeof block.type === 'string' ? block.type : null);
const textBlockText = (block: unknown) => (isRecord(block) && typeof block.text === 'string' ? block.text : null);

const readClaudeCache = (storage: LocalHistoryStorage): ClaudeCache | null => {
  try {
    if (!fs.existsSync(storage.home)) {
      return null;
    }
    const cachePath = claudeCachePath(storage);
    if (!fs.existsSync(cachePath)) {
      return { fingerprintKey: null, rows: [], version: CLAUDE_CACHE_VERSION };
    }
    const parsed = readPrivateJson(cachePath, COLLECTOR_CACHE_MAX_BYTES) as {
      fingerprintKey?: unknown;
      rows?: unknown;
      version?: number;
    };
    if (parsed.version !== CLAUDE_CACHE_VERSION) {
      return { fingerprintKey: null, rows: [], version: CLAUDE_CACHE_VERSION };
    }
    return {
      fingerprintKey: typeof parsed.fingerprintKey === 'string' ? parsed.fingerprintKey : null,
      rows: reviveCollectorRows(parsed.rows),
      version: CLAUDE_CACHE_VERSION,
    };
  } catch {
    return null;
  }
};

const writeClaudeCache = (storage: LocalHistoryStorage, fingerprintKey: string | null, rows: CollectorRow[]) => {
  if (!fingerprintKey) {
    return false;
  }
  const cachePath = claudeCachePath(storage);
  const value = { fingerprintKey, rows, version: CLAUDE_CACHE_VERSION };
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
        firstPrompt: null,
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
        if (!current.firstPrompt) {
          current.firstPrompt = prompt;
        }
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

export const collectClaude = Effect.gen(function* () {
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
    return yield* withPerfSpan('aiUsage.collect.claude.cache.hit', Effect.succeed(cache.rows), (rows) => ({
      rows: rows.length,
    }));
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
  const seen = new Set<string>();

  yield* withPerfSpan(
    'aiUsage.collect.claude.parseFiles',
    Effect.gen(function* () {
      let lines = 0;
      for (const filePath of files) {
        const sourceSessionId = path.basename(filePath, '.jsonl');
        const isAgentFile = path.basename(filePath).startsWith('agent-');
        let title: string | null = null;
        let lastPrompt: string | null = null;
        let firstPrompt: string | null = null;
        let parentSourceSessionId: string | null = null;
        let cwd: string | null = null;
        let start: Date | null = null;
        let end: Date | null = null;
        let calls = 0;
        let turns = 0;
        let tools = 0;
        let sidechain = isAgentFile;
        const tokens = { in: 0, out: 0, cr: 0, cw: 0 };
        const byModel = new Map<string, number>();

        yield* storage.readLines(filePath, (line) => {
          if (!line) {
            return;
          }
          lines++;
          const event = safeJSON(line);
          if (!event) {
            return;
          }
          if (isAgentFile && typeof event.sessionId === 'string' && event.sessionId !== sourceSessionId) {
            parentSourceSessionId = event.sessionId;
          }
          if (typeof event.timestamp === 'string' || typeof event.timestamp === 'number') {
            const date = new Date(event.timestamp);
            if (Number.isFinite(date.getTime())) {
              if (!start || date < start) {
                start = date;
              }
              if (!end || date > end) {
                end = date;
              }
            }
          }
          if (event.isSidechain) {
            sidechain = true;
          }
          if (event.type === 'ai-title' && typeof event.aiTitle === 'string') {
            title = event.aiTitle;
          } else if (event.type === 'last-prompt' && event.lastPrompt) {
            lastPrompt = String(event.lastPrompt);
          } else if (event.type === 'user') {
            const message = isRecord(event.message) ? event.message : null;
            const content = message?.content;
            let text: string | null = null;
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              const isToolResult = content.some((block) => blockType(block) === 'tool_result');
              if (!isToolResult) {
                text = content.map(textBlockText).find((value) => value !== null) ?? null;
              }
            }
            if (text) {
              turns++;
              if (!firstPrompt) {
                firstPrompt = usablePrompt(text);
              }
            }
          } else if (event.type === 'assistant') {
            if (typeof event.cwd === 'string') {
              cwd = event.cwd;
            }
            const message = isRecord(event.message) ? event.message : null;
            const usage = isRecord(message?.usage) ? message.usage : null;
            if (Array.isArray(message?.content)) {
              tools += message.content.filter((block: unknown) => blockType(block) === 'tool_use').length;
            }
            if (!usage) {
              return;
            }
            const input = parseOptionalNonNegativeSafeInteger(usage.input_tokens);
            const output = parseOptionalNonNegativeSafeInteger(usage.output_tokens);
            const cacheRead = parseOptionalNonNegativeSafeInteger(usage.cache_read_input_tokens);
            const cacheWrite = parseOptionalNonNegativeSafeInteger(usage.cache_creation_input_tokens);
            if (!(input.ok && output.ok && cacheRead.ok && cacheWrite.ok)) {
              return;
            }
            const id = typeof message?.id === 'string' ? message.id : undefined;
            const key = `${id}:${event.requestId}`;
            if (id && seen.has(key)) {
              return;
            }
            if (id) {
              seen.add(key);
            }
            const nextCalls = addNonNegativeSafeIntegers(calls, 1);
            const nextInput = addNonNegativeSafeIntegers(tokens.in, input.value);
            const nextOutput = addNonNegativeSafeIntegers(tokens.out, output.value);
            const nextCacheRead = addNonNegativeSafeIntegers(tokens.cr, cacheRead.value);
            const nextCacheWrite = addNonNegativeSafeIntegers(tokens.cw, cacheWrite.value);
            if (!(nextCalls.ok && nextInput.ok && nextOutput.ok && nextCacheRead.ok && nextCacheWrite.ok)) {
              return;
            }
            calls = nextCalls.value;
            tokens.in = nextInput.value;
            tokens.out = nextOutput.value;
            tokens.cr = nextCacheRead.value;
            tokens.cw = nextCacheWrite.value;
            const model = typeof message?.model === 'string' ? message.model : 'unknown';
            byModel.set(
              model,
              (byModel.get(model) || 0) + input.value + output.value + cacheRead.value + cacheWrite.value,
            );
          }
        });

        if (!start && tokenTotal(tokens) === 0) {
          continue;
        }
        const model = dominant(byModel);
        const name =
          title ||
          usablePrompt(lastPrompt) ||
          firstPrompt ||
          `${sidechain ? 'subagent ' : ''}${sourceSessionId.slice(0, 8)}`;
        let titleSource: 'ai' | 'agent-role' | 'first-prompt' | 'id';
        if (title) {
          titleSource = 'ai';
        } else if (sidechain && !lastPrompt && !firstPrompt) {
          titleSource = 'agent-role';
        } else if (lastPrompt || firstPrompt) {
          titleSource = 'first-prompt';
        } else {
          titleSource = 'id';
        }

        sessions.push({
          source: {
            harnessKey: 'claude',
            sourceSessionId,
            ...(parentSourceSessionId === null ? {} : { parentSourceSessionId }),
            sourcePath: cwd,
          },
          projectPath: cwd,
          date: start,
          endDate: end,
          provider,
          name,
          titleSource,
          model,
          project: base(cwd),
          tokens,
          cost: provider === 'Claude API' ? approximateApiCost : actualCost(0),
          calls,
          turns,
          tools,
          linesAdded: null,
          linesDeleted: null,
          subagent: sidechain,
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
      name: session.firstPrompt || `claude ${session.sessionId.slice(0, 8)}`,
      titleSource: session.firstPrompt ? 'first-prompt' : 'id',
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
    Effect.sync(() => writeClaudeCache(storage, fingerprintKey, rows)),
    (wrote) => ({ wrote }),
  );
  return rows;
});
