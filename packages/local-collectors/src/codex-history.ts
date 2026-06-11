import type { TokenCounts } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import {
  historyPath,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from './local-history';
import { safeJSON, usablePrompt } from './text';

interface CodexSession {
  id: string | null;
  parent: string | null;
  start: Date | null;
  end: Date | null;
  cwd: string | null;
  model: string;
  subscription: boolean;
  firstUser: string | null;
  turns: number;
  tools: number;
  maxTotal: number;
  tin: number;
  tcr: number;
  tout: number;
}

export interface CodexUsageSession {
  start: Date | null;
  end: Date | null;
  cwd: string | null;
  model: string;
  subscription: boolean;
  name: string;
  tokens: TokenCounts;
  calls: number;
  turns: number;
  tools: number;
  hasSubagents: boolean;
}

export interface CodexQuotaWindow {
  windowMinutes: number;
  usedPercent: number;
  resetsAt: Date | null;
}

export interface CodexQuotaSnapshot {
  ts: Date;
  planType: string;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  credits: number | null;
}

interface RawCodexRateLimitSnapshot {
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

const readCodexThreadNames: Effect.Effect<
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
  subscription: false,
  firstUser: null,
  turns: 0,
  tools: 0,
  maxTotal: 0,
  tin: 0,
  tcr: 0,
  tout: 0,
});

const readCodexSessions: Effect.Effect<CodexSession[], LocalHistoryError, LocalHistoryStorageService> = Effect.gen(
  function* () {
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
          if (payload.rate_limits) session.subscription = true;
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
  },
);

const sum = (sessions: CodexSession[], pick: (session: CodexSession) => number) =>
  sessions.reduce((total, session) => total + pick(session), 0);

export const readCodexUsageSessions: Effect.Effect<CodexUsageSession[], LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const names = yield* readCodexThreadNames;
    const sessions = yield* readCodexSessions;
    const byId = new Map<string, CodexSession>();
    for (const session of sessions) {
      if (session.id) byId.set(session.id, session);
    }

    const children = new Map<string, CodexSession[]>();
    const childIds = new Set<string>();
    for (const session of sessions) {
      if (session.id && session.parent && byId.has(session.parent)) {
        childIds.add(session.id);
        const siblings = children.get(session.parent) ?? [];
        siblings.push(session);
        children.set(session.parent, siblings);
      }
    }

    const usageSessions: CodexUsageSession[] = [];
    for (const session of sessions) {
      if (session.id && childIds.has(session.id)) continue;
      const kids = (session.id && children.get(session.id)) || [];
      const tokens = {
        in: session.tin + sum(kids, (kid) => kid.tin),
        out: session.tout + sum(kids, (kid) => kid.tout),
        cr: session.tcr + sum(kids, (kid) => kid.tcr),
        cw: 0,
      };
      const end = [session, ...kids].reduce<Date | null>(
        (latest, current) => (current.end && (!latest || current.end > latest) ? current.end : latest),
        null,
      );
      usageSessions.push({
        start: session.start,
        end,
        cwd: session.cwd,
        model: session.model,
        subscription: session.subscription || kids.some((kid) => kid.subscription),
        name:
          (session.id && names.get(session.id)) ||
          session.firstUser ||
          (session.id ? `codex ${session.id.slice(0, 8)}` : 'codex'),
        tokens,
        calls: 1 + kids.length,
        turns: session.turns + sum(kids, (kid) => kid.turns),
        tools: session.tools + sum(kids, (kid) => kid.tools),
        hasSubagents: kids.length > 0,
      });
    }

    return usageSessions;
  });

const findLatestRawCodexRateLimits = (
  recentFileLimit = 40,
): Effect.Effect<RawCodexRateLimitSnapshot | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    let latest: RawCodexRateLimitSnapshot | null = null;
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

const normalizeQuotaWindow = (window: any): CodexQuotaWindow | null => {
  if (!window) return null;
  const windowMinutes = Number(window.window_minutes ?? 0);
  const usedPercent = Number(window.used_percent ?? 0);
  const resetsAt = Number.isFinite(window.resets_at) ? new Date(window.resets_at * 1000) : null;
  return { windowMinutes, usedPercent, resetsAt };
};

export const findLatestCodexQuotaSnapshot = (
  recentFileLimit = 40,
): Effect.Effect<CodexQuotaSnapshot | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const latest = yield* findLatestRawCodexRateLimits(recentFileLimit);
    if (!latest) return null;
    const { rateLimits, ts } = latest;
    return {
      ts,
      planType: String(rateLimits.plan_type ?? 'unknown'),
      primary: normalizeQuotaWindow(rateLimits.primary),
      secondary: normalizeQuotaWindow(rateLimits.secondary),
      credits: rateLimits.credits == null ? null : Number(rateLimits.credits),
    };
  });
