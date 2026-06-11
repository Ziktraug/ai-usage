import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import {
  historyPath,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from './local-history';
import { safeJSON, usablePrompt } from './text';

export interface CodexSession {
  id: string | null;
  parent: string | null;
  start: Date | null;
  end: Date | null;
  cwd: string | null;
  model: string;
  sub: boolean;
  firstUser: string | null;
  turns: number;
  tools: number;
  maxTotal: number;
  tin: number;
  tcr: number;
  tout: number;
}

export interface CodexRateLimitSnapshot {
  ts: Date;
  rateLimits: any;
}

export const codexSessionsDir = (storage: LocalHistoryStorageService) => historyPath(storage, '.codex', 'sessions');

export const hasCodexHistory: Effect.Effect<boolean, LocalHistoryError, LocalHistoryStorageService> = Effect.gen(
  function* () {
    const storage = yield* LocalHistoryStorage;
    return yield* storage.exists(codexSessionsDir(storage));
  },
);

export const listCodexSessionFiles: Effect.Effect<string[], LocalHistoryError, LocalHistoryStorageService> = Effect.gen(
  function* () {
    const storage = yield* LocalHistoryStorage;
    return yield* walkFiles(storage, codexSessionsDir(storage), (fileName) => fileName.endsWith('.jsonl'));
  },
);

export const readCodexThreadNames: Effect.Effect<
  Map<string, string>,
  LocalHistoryError,
  LocalHistoryStorageService
> = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const names = new Map<string, string>();
  const indexPath = historyPath(storage, '.codex', 'session_index.jsonl');
  if (!(yield* storage.exists(indexPath))) return names;

  for (const line of (yield* storage.readText(indexPath)).split('\n')) {
    const event = safeJSON(line);
    if (event?.id && event?.thread_name) names.set(event.id, event.thread_name);
  }
  return names;
});

const emptySession = (): CodexSession => ({
  id: null,
  parent: null,
  start: null,
  end: null,
  cwd: null,
  model: 'codex',
  sub: false,
  firstUser: null,
  turns: 0,
  tools: 0,
  maxTotal: 0,
  tin: 0,
  tcr: 0,
  tout: 0,
});

export const readCodexSessions: Effect.Effect<CodexSession[], LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const sessions: CodexSession[] = [];

    for (const filePath of yield* listCodexSessionFiles) {
      const session = emptySession();
      for (const line of (yield* storage.readText(filePath)).split('\n')) {
        if (!line) continue;
        const event = safeJSON(line);
        if (!event) continue;
        if (event.timestamp) {
          const date = new Date(event.timestamp);
          if (Number.isFinite(date.getTime())) {
            if (!session.start || date < session.start) session.start = date;
            if (!session.end || date > session.end) session.end = date;
          }
        }

        const payload = event.payload ?? {};
        if (event.type === 'session_meta') {
          session.id = payload.id ?? session.id;
          session.cwd = payload.cwd ?? session.cwd;
          const spawn = payload.source?.subagent?.thread_spawn;
          if (spawn) session.parent = spawn.parent_thread_id ?? session.parent;
        }
        if (event.type === 'turn_context' && payload.model) session.model = payload.model;
        if (payload.type === 'task_started') session.turns++;
        if (typeof payload.type === 'string' && /(_call|function_call)$/.test(payload.type)) session.tools++;
        if (payload.type === 'message' && payload.role === 'user') {
          const content = Array.isArray(payload.content) ? payload.content : [];
          const text = content.map((item: any) => item?.text || item?.input_text).find(Boolean);
          if (text && !session.firstUser) session.firstUser = usablePrompt(String(text).slice(0, 200));
        }
        if (payload.type === 'token_count') {
          if (payload.rate_limits) session.sub = true;
          const usage = payload.info?.total_token_usage;
          const total = usage?.total_tokens;
          if (Number.isInteger(total) && total > session.maxTotal) {
            session.maxTotal = total;
            const input = usage.input_tokens || 0;
            const cachedInput = usage.cached_input_tokens || 0;
            session.tin = Math.max(0, input - cachedInput);
            session.tcr = cachedInput;
            session.tout = usage.output_tokens || 0;
          }
        }
      }
      if (session.id || session.start) sessions.push(session);
    }

    return sessions;
  });

export const findLatestCodexRateLimits = (
  recentFileLimit = 40,
): Effect.Effect<CodexRateLimitSnapshot | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    let latest: CodexRateLimitSnapshot | null = null;
    const files = (yield* listCodexSessionFiles).sort();

    for (const filePath of files.slice(-recentFileLimit).reverse()) {
      for (const line of (yield* storage.readText(filePath)).split('\n')) {
        if (!line.includes('rate_limits')) continue;
        const event = safeJSON(line);
        const rateLimits = event?.payload?.rate_limits;
        if (!rateLimits) continue;
        const ts = new Date(event.timestamp);
        if (!latest || ts > latest.ts) latest = { ts, rateLimits };
      }
      if (latest) break;
    }

    return latest;
  });
