import { actualCost, approximateApiCost } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import type { CollectedSession } from './collected-session';
import type { LocalHistoryError } from './errors';
import {
  historyPath,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from './local-history';
import { firstExisting, resolvePaths } from './platform-paths';
import { base, safeJSON, usablePrompt } from './text';

interface CodexSession {
  id: string | null;
  parent: string | null;
  start: Date | null;
  end: Date | null;
  cwd: string | null;
  model: string;
  source: string | null;
  threadSource: string | null;
  subscription: boolean;
  firstUser: string | null;
  turns: number;
  tools: number;
  maxTotal: number;
  tin: number;
  tcr: number;
  tout: number;
  hasTokenUsage: boolean;
}

interface CodexThreadMetadata {
  id: string;
  parent: string | null;
  cwd: string | null;
  title: string | null;
  firstUser: string | null;
  source: string | null;
  threadSource: string | null;
  model: string | null;
  start: Date | null;
  end: Date | null;
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

export const codexSessionsDir = (storage: LocalHistoryStorageService) => {
  const paths = resolvePaths(storage);
  return paths.codex.sessionsDir;
};

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
  const paths = resolvePaths(storage);
  const names = new Map<string, string>();
  const indexPath = paths.codex.sessionIndexFile;
  if (!(yield* storage.exists(indexPath))) return names;

  for (const line of (yield* storage.readText(indexPath)).split('\n')) {
    const event = safeJSON(line);
    if (event?.id && event?.thread_name) names.set(event.id, event.thread_name);
  }
  return names;
});

const codexStateDbCandidates = (storage: LocalHistoryStorageService) => [
  historyPath(storage, '.codex', 'state_5.sqlite'),
  historyPath(storage, '.codex', 'sqlite', 'state_5.sqlite'),
];

const THREAD_METADATA_SQL = `
select
  id,
  cwd,
  title,
  first_user_message as firstUser,
  source,
  thread_source as threadSource,
  model,
  created_at as createdAt,
  updated_at as updatedAt
from threads
`;

const THREAD_SPAWN_EDGES_SQL = `
select parent_thread_id as parent, child_thread_id as child
from thread_spawn_edges
`;

interface CodexThreadMetadataRow {
  id: string;
  cwd?: string | null;
  title?: string | null;
  firstUser?: string | null;
  source?: string | null;
  threadSource?: string | null;
  model?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface CodexThreadSpawnEdgeRow {
  parent?: string | null;
  child?: string | null;
}

const unixDate = (seconds: unknown): Date | null => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
};

const nonEmpty = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readCodexThreadMetadata: Effect.Effect<
  Map<string, CodexThreadMetadata>,
  LocalHistoryError,
  LocalHistoryStorageService
> = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const dbPath = yield* firstExisting(storage, ...codexStateDbCandidates(storage));
  if (!dbPath) return new Map<string, CodexThreadMetadata>();

  return yield* Effect.gen(function* () {
    const db = yield* storage.openDatabase(dbPath);
    const rows = yield* db.all<CodexThreadMetadataRow>(THREAD_METADATA_SQL);
    const edges = yield* db.all<CodexThreadSpawnEdgeRow>(THREAD_SPAWN_EDGES_SQL);
    yield* db.close;

    const parents = new Map<string, string>();
    for (const edge of edges) {
      const child = nonEmpty(edge.child);
      const parent = nonEmpty(edge.parent);
      if (child && parent) parents.set(child, parent);
    }

    const metadata = new Map<string, CodexThreadMetadata>();
    for (const row of rows) {
      const id = nonEmpty(row.id);
      if (!id) continue;
      metadata.set(id, {
        id,
        parent: parents.get(id) ?? null,
        cwd: nonEmpty(row.cwd),
        title: nonEmpty(row.title),
        firstUser: nonEmpty(row.firstUser),
        source: nonEmpty(row.source),
        threadSource: nonEmpty(row.threadSource),
        model: nonEmpty(row.model),
        start: unixDate(row.createdAt),
        end: unixDate(row.updatedAt),
      });
    }

    return metadata;
  }).pipe(Effect.catchAll(() => Effect.succeed(new Map<string, CodexThreadMetadata>())));
});

const emptySession = (): CodexSession => ({
  id: null,
  parent: null,
  start: null,
  end: null,
  cwd: null,
  model: 'codex',
  source: null,
  threadSource: null,
  subscription: false,
  firstUser: null,
  turns: 0,
  tools: 0,
  maxTotal: 0,
  tin: 0,
  tcr: 0,
  tout: 0,
  hasTokenUsage: false,
});

const textFromContent = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = nonEmpty(record.text) ?? nonEmpty(record.input_text);
    if (text) return text;
  }
  return null;
};

const userTextFromPayload = (payload: Record<string, unknown>): string | null => {
  if (payload.type === 'message' && payload.role === 'user') return textFromContent(payload.content);
  if (payload.type === 'user_message')
    return nonEmpty(payload.message) ?? nonEmpty(payload.text) ?? textFromContent(payload.content);
  return null;
};

const mergeMetadata = (session: CodexSession, metadata: CodexThreadMetadata | undefined) => {
  if (!metadata) return session;
  session.parent = session.parent ?? metadata.parent;
  session.start = session.start ?? metadata.start;
  session.end = session.end ?? metadata.end;
  session.cwd = session.cwd ?? metadata.cwd;
  session.model = session.model === 'codex' && metadata.model ? metadata.model : session.model;
  session.source = session.source ?? metadata.source;
  session.threadSource = session.threadSource ?? metadata.threadSource;
  session.firstUser = session.firstUser ?? (metadata.firstUser ? usablePrompt(metadata.firstUser.slice(0, 200)) : null);
  return session;
};

const isGuardianSession = (session: CodexSession, candidateName: string | null) =>
  session.source?.includes('"guardian"') || candidateName?.startsWith('The following is the Codex agent history');

const guardianName = (candidateName: string | null) => {
  const reviewedId = candidateName?.match(/Reviewed Codex session id:\s*([0-9a-f-]{36})/i)?.[1];
  return reviewedId ? `Codex guardian approval (${reviewedId.slice(0, 8)})` : 'Codex guardian approval';
};

const codexSessionName = (
  session: CodexSession,
  indexedName: string | undefined,
  metadata: CodexThreadMetadata | undefined,
) => {
  if (indexedName) return indexedName;
  const candidate = metadata?.title || session.firstUser;
  if (isGuardianSession(session, candidate ?? null)) return guardianName(candidate ?? null);
  return candidate || (session.id ? `codex ${session.id.slice(0, 8)}` : 'codex');
};

const readCodexSessions: Effect.Effect<CodexSession[], LocalHistoryError, LocalHistoryStorageService> = Effect.gen(
  function* () {
    const storage = yield* LocalHistoryStorage;
    const metadata = yield* readCodexThreadMetadata;
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
          session.source = payload.source == null ? session.source : JSON.stringify(payload.source);
          session.threadSource = payload.thread_source ?? session.threadSource;
          const spawn = payload.source?.subagent?.thread_spawn;
          if (spawn) session.parent = spawn.parent_thread_id ?? session.parent;
        }
        if (event.type === 'turn_context' && payload.model) session.model = payload.model;
        if (payload.type === 'task_started') session.turns++;
        if (typeof payload.type === 'string' && /(_call|function_call)$/.test(payload.type)) session.tools++;
        const userText = userTextFromPayload(payload);
        if (userText && !session.firstUser) session.firstUser = usablePrompt(userText.slice(0, 200));
        if (payload.type === 'token_count') {
          if (payload.rate_limits) session.subscription = true;
          const usage = payload.info?.total_token_usage;
          const total = usage?.total_tokens;
          if (Number.isInteger(total) && total > session.maxTotal) {
            session.hasTokenUsage = true;
            session.maxTotal = total;
            const input = usage.input_tokens || 0;
            const cachedInput = usage.cached_input_tokens || 0;
            session.tin = Math.max(0, input - cachedInput);
            session.tcr = cachedInput;
            session.tout = usage.output_tokens || 0;
          }
        }
      }
      mergeMetadata(session, session.id ? metadata.get(session.id) : undefined);
      if (session.id || session.start) sessions.push(session);
    }

    return sessions.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  },
);

export const readCodexUsageSessions: Effect.Effect<CollectedSession[], LocalHistoryError, LocalHistoryStorageService> =
  Effect.gen(function* () {
    const names = yield* readCodexThreadNames;
    const metadata = yield* readCodexThreadMetadata;
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

    const usageSessions: CollectedSession[] = [];
    for (const session of sessions) {
      const kids = (session.id && children.get(session.id)) || [];
      const meta = session.id ? metadata.get(session.id) : undefined;
      const tokens = {
        in: session.tin,
        out: session.tout,
        cr: session.tcr,
        cw: 0,
      };
      const isSubagent = (session.id ? childIds.has(session.id) : false) || session.threadSource === 'subagent';
      const parentSession = session.parent ? byId.get(session.parent) : undefined;
      const subscription = session.subscription || Boolean(parentSession?.subscription);
      usageSessions.push({
        source: {
          harnessKey: 'codex',
          sourceSessionId: session.id,
          sourcePath: session.cwd,
        },
        projectPath: session.cwd,
        date: session.start,
        endDate: session.end,
        provider: subscription ? 'Codex sub' : 'Codex API',
        model: session.model,
        name: codexSessionName(session, session.id ? names.get(session.id) : undefined, meta),
        project: base(session.cwd),
        tokens,
        cost: subscription ? actualCost(0) : approximateApiCost,
        calls: 1,
        turns: session.turns,
        tools: session.tools,
        linesAdded: null,
        linesDeleted: null,
        subagent: isSubagent || kids.length > 0,
        usageUnavailable: !session.hasTokenUsage,
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
