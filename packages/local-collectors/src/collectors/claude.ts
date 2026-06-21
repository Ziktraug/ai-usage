import path from 'node:path';
import { actualCost, approximateApiCost, tokenTotal } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import type { LocalHistoryError, LocalHistoryWarning } from '../errors';
import { LocalHistoryStorage, walkFiles } from '../local-history';
import { type HarnessPaths, resolvePaths } from '../platform-paths';
import { base, dominant, safeJSON, usablePrompt } from '../text';

type ClaudeHistoryFallback = {
  sessionId: string;
  start: Date;
  end: Date;
  project: string | null;
  firstPrompt: string | null;
  turns: number;
};

const HOUSEKEEPING_COMMANDS = new Set(['/clear', '/model', '/effort', '/usage', '/rate-limit-options', '/resume']);

const isUsageBearingHistoryEntry = (text: string | null) => {
  if (!text) return false;
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
    if (!(yield* storage.exists(historyFile))) return [];

    const sessions = new Map<string, ClaudeHistoryFallback>();
    for (const line of (yield* storage.readText(historyFile)).split('\n')) {
      if (!line) continue;
      const event = safeJSON(line);
      const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : null;
      if (!sessionId || existingSessionIds.has(sessionId)) continue;
      const timestamp = Number(event.timestamp);
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) continue;

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

      if (date < current.start) current.start = date;
      if (date > current.end) current.end = date;
      if (!current.project && typeof event.project === 'string') current.project = event.project;
      if (usageBearing) {
        current.turns++;
        if (!current.firstPrompt) current.firstPrompt = prompt;
      }
      sessions.set(sessionId, current);
    }

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
    const raw = exists ? yield* storage.readText(settingsFile).pipe(Effect.catchAll(() => Effect.succeed(''))) : '';
    const configured = safeJSON(raw)?.cleanupPeriodDays;
    const hasExplicit = typeof configured === 'number' && Number.isFinite(configured);
    const days = hasExplicit ? (configured as number) : CLAUDE_DEFAULT_CLEANUP_DAYS;

    // Only warn when retention is at or below the lossy default; raising the value
    // (or disabling cleanup) means history is being kept, so stay quiet.
    if (days > CLAUDE_DEFAULT_CLEANUP_DAYS) return [];

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

  let provider = 'Claude sub';
  const cfg = paths.claude.configFile;
  if (yield* storage.exists(cfg).pipe(Effect.catchAll(() => Effect.succeed(false)))) {
    const json = safeJSON(yield* storage.readText(cfg).pipe(Effect.catchAll(() => Effect.succeed(''))));
    if (json?.hasApiKey) provider = 'Claude API';
  }

  const files = yield* walkFiles(storage, dir, (fileName) => fileName.endsWith('.jsonl'));
  const sessions: CollectedSession[] = [];
  const existingSessionIds = new Set(files.map((filePath) => path.basename(filePath, '.jsonl')));
  const seen = new Set<string>();

  for (const filePath of files) {
    const sourceSessionId = path.basename(filePath, '.jsonl');
    const isAgentFile = path.basename(filePath).startsWith('agent-');
    let title: string | null = null;
    let lastPrompt: string | null = null;
    let firstPrompt: string | null = null;
    let cwd: string | null = null;
    let start: Date | null = null;
    let end: Date | null = null;
    let calls = 0;
    let turns = 0;
    let tools = 0;
    let sidechain = isAgentFile;
    const tokens = { in: 0, out: 0, cr: 0, cw: 0 };
    const byModel = new Map<string, number>();

    for (const line of (yield* storage.readText(filePath)).split('\n')) {
      if (!line) continue;
      const event = safeJSON(line);
      if (!event) continue;
      if (event.timestamp) {
        const date = new Date(event.timestamp);
        if (Number.isFinite(date.getTime())) {
          if (!start || date < start) start = date;
          if (!end || date > end) end = date;
        }
      }
      if (event.isSidechain) sidechain = true;
      if (event.type === 'ai-title' && event.aiTitle) title = event.aiTitle;
      else if (event.type === 'last-prompt' && event.lastPrompt) lastPrompt = String(event.lastPrompt);
      else if (event.type === 'user') {
        const content = event.message?.content;
        let text: string | null = null;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          const isToolResult = content.some((block: any) => block?.type === 'tool_result');
          if (!isToolResult) text = content.find((block: any) => block?.type === 'text')?.text ?? null;
        }
        if (text) {
          turns++;
          if (!firstPrompt) firstPrompt = usablePrompt(text);
        }
      } else if (event.type === 'assistant') {
        if (event.cwd) cwd = event.cwd;
        const usage = event.message?.usage;
        if (Array.isArray(event.message?.content)) {
          tools += event.message.content.filter((block: any) => block?.type === 'tool_use').length;
        }
        if (!usage) continue;
        const id = event.message?.id;
        const key = `${id}:${event.requestId}`;
        if (id && seen.has(key)) continue;
        if (id) seen.add(key);
        calls++;
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheWrite = usage.cache_creation_input_tokens || 0;
        tokens.in += input;
        tokens.out += output;
        tokens.cr += cacheRead;
        tokens.cw += cacheWrite;
        const model = event.message?.model || 'unknown';
        byModel.set(model, (byModel.get(model) || 0) + input + output + cacheRead + cacheWrite);
      }
    }

    if (!start && tokenTotal(tokens) === 0) continue;
    const model = dominant(byModel);
    const name =
      title ||
      usablePrompt(lastPrompt) ||
      firstPrompt ||
      `${sidechain ? 'subagent ' : ''}${sourceSessionId.slice(0, 8)}`;

    sessions.push({
      source: { harnessKey: 'claude', sourceSessionId, sourcePath: cwd },
      projectPath: cwd,
      date: start,
      endDate: end,
      provider,
      name,
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

  for (const session of yield* readClaudeHistoryFallbacks(storage, existingSessionIds, paths)) {
    sessions.push({
      source: { harnessKey: 'claude', sourceSessionId: session.sessionId, sourcePath: session.project },
      projectPath: session.project,
      date: session.start,
      endDate: session.end,
      provider,
      name: session.firstPrompt || `claude ${session.sessionId.slice(0, 8)}`,
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

  return sessions.map(sessionToUsageRow);
});
