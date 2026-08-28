import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import type {
  LocalSessionAnalysis,
  SessionDetail,
  SessionDetailPhase,
  SessionDetailPrompt,
  SessionDetailTokenCounts,
  SessionDetailTurn,
  SessionProjectionFacts,
} from '@ai-usage/report-core/session-detail';
import {
  compactSessionVcsBranchObservations,
  normalizeSessionVcsRepository,
  parseSessionVcsContext,
  type SessionVcsCommit,
  type SessionVcsContext,
  type SessionVcsRepository,
  sessionVcsCommitUrl,
} from '@ai-usage/report-core/session-vcs';
import { MAX_SKILL_OBSERVATIONS_PER_SESSION, type SkillObservation } from '@ai-usage/report-core/skill-observation';
import type { UsageModelSegment } from '@ai-usage/report-core/types';
import { UNSEGMENTED_MULTI_MODEL_LABEL } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import {
  CODEX_AVAILABLE_SKILLS_HEADING,
  type CodexSkillCatalogueEntry,
  codexSkillCatalogueObservations,
  codexSkillExecObservations,
  extractCodexSkillCatalogue,
  matchCodexSkillDocuments,
} from '../codex-skill-observation';
import type { LocalHistoryError } from '../errors';
import {
  historyPath,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from '../local-history';
import { parseNonNegativeSafeInteger } from '../metric-validation';
import { resolvePaths } from '../platform-paths';
import { deriveSessionLabelFromPrompt } from '../session-label';
import { safeJSON, usablePrompt } from '../text';

type CodexSubagent =
  | { kind: 'guardian' }
  | { kind: 'review' }
  | { kind: 'thread-spawn'; threadSpawn: Record<string, unknown> };

export type CodexSubagentKind = CodexSubagent['kind'];

export interface CodexSession {
  activeDurationMs: number | null;
  agentNickname: string | null;
  classifierParent: string | null;
  cwd: string | null;
  durationPartial: boolean;
  end: Date | null;
  firstUser: string | null;
  hasTokenUsage: boolean;
  id: string | null;
  maxTotal: number;
  model: string;
  models: string[];
  observedPriorTokenUsage: boolean;
  parent: string | null;
  phases: CodexSessionPhase[];
  rejectedMetricRecords: number;
  reportPartial: boolean;
  /** Skill candidates that failed validation, so a shape change is visible. */
  skillObservationRejects: number;
  /**
   * Codex declares no skill invocations. These are the `exposed` catalogue and
   * the `inferred` exec reads, kept as separate tiers on one list (ADR 0022).
   */
  skillObservations: SkillObservation[];
  /** Whether the per-session observation ceiling cut the list short. */
  skillObservationsTruncated: boolean;
  start: Date | null;
  subagentKind: CodexSubagentKind | null;
  subscription: boolean;
  tcr: number;
  threadSource: string | null;
  tin: number;
  tools: number;
  tout: number;
  turns: number;
  vcs?: SessionVcsContext;
}

export interface CodexSessionPhase {
  effort: string | null;
  end: Date;
  model: string;
  start: Date;
  tcr: number;
  tin: number;
  tout: number;
}

interface CodexTaskInterval {
  endMs: number;
  startMs: number;
}

export interface CodexThreadMetadata {
  agentNickname: string | null;
  cwd: string | null;
  end: Date | null;
  firstUser: string | null;
  id: string;
  model: string | null;
  parent: string | null;
  start: Date | null;
  subagentKind: CodexSubagentKind | null;
  threadSource: string | null;
}

interface CodexSessionParseResult {
  lines: number;
  parsedLines: number;
  parseMs: number;
  rejectedMetricRecords: number;
  session: CodexSession;
  skippedLines: number;
}

export const CODEX_LINEAGE_MAX_DEPTH = 32;
export const CODEX_DETAIL_MAX_PHASES = 256;
const CODEX_DETAIL_MAX_PROMPTS = 256;
const CODEX_DETAIL_MAX_PROMPT_BYTES = 32 * 1024;
const CODEX_DETAIL_MAX_PROMPT_TOTAL_BYTES = 1024 * 1024;
const CODEX_DETAIL_MAX_TURNS = 1024;
const CODEX_DETAIL_DUPLICATE_PROMPT_WINDOW_MS = 1000;

// Forked rollouts stamp copied task events at replay time while preserving the
// task's original second-resolution `started_at`. Genuine task events observed
// in the rollout may also be delivered late. Only an event whose recorded start
// predates the observed rollout can be replayed history; tolerate two seconds of
// timestamp rounding around that boundary.
const CODEX_REPLAYED_TASK_EVENT_LAG_MS = 2000;

const TRAILING_REPLACEMENT_CHARACTER = /\uFFFD$/u;

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

export const codexStateDbCandidates = (storage: LocalHistoryStorageService) => [
  historyPath(storage, '.codex', 'state_5.sqlite'),
  historyPath(storage, '.codex', 'sqlite', 'state_5.sqlite'),
];

export const THREAD_METADATA_SQL = `
select
  id,
  cwd,
  first_user_message as firstUser,
  source,
  thread_source as threadSource,
  model,
  created_at as createdAt,
  updated_at as updatedAt
from threads
`;

export interface CodexThreadMetadataRow {
  createdAt?: number | null;
  cwd?: string | null;
  firstUser?: string | null;
  id: string;
  model?: string | null;
  source?: string | null;
  threadSource?: string | null;
  updatedAt?: number | null;
}

export interface CodexThreadSpawnEdgeRow {
  child?: string | null;
  parent?: string | null;
}

export const codexParentsFromEdges = (edges: readonly CodexThreadSpawnEdgeRow[]): Map<string, string> => {
  const candidates = new Map<string, Set<string>>();
  for (const edge of edges) {
    const child = nonEmpty(edge.child);
    const parent = nonEmpty(edge.parent);
    if (!(child && parent)) {
      continue;
    }
    const parents = candidates.get(child) ?? new Set<string>();
    parents.add(parent);
    candidates.set(child, parents);
  }

  const parents = new Map<string, string>();
  for (const [child, parentCandidates] of candidates) {
    if (parentCandidates.size === 1) {
      const parent = parentCandidates.values().next().value;
      if (parent) {
        parents.set(child, parent);
      }
    }
  }
  return parents;
};

const unixDate = (seconds: unknown): Date | null => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
};

export const nonEmpty = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const agentNicknameFromSource = (source: string | null | undefined): string | null => {
  if (!source) {
    return null;
  }
  const spawn = threadSpawnFromSource(safeJSON(source));
  return nonEmpty(spawn?.agent_nickname) ?? nonEmpty(spawn?.agent_role);
};

export const codexThreadMetadataFromRow = (
  row: CodexThreadMetadataRow,
  parent: string | null,
): CodexThreadMetadata | null => {
  const id = nonEmpty(row.id);
  if (!id) {
    return null;
  }
  const subagent = codexSubagentFromSource(row.source);
  return {
    id,
    parent,
    cwd: nonEmpty(row.cwd),
    firstUser: nonEmpty(row.firstUser),
    threadSource: nonEmpty(row.threadSource),
    agentNickname: agentNicknameFromSource(row.source),
    subagentKind: subagent?.kind ?? null,
    model: nonEmpty(row.model),
    start: unixDate(row.createdAt),
    end: unixDate(row.updatedAt),
  };
};

const emptySession = (): CodexSession => ({
  activeDurationMs: null,
  classifierParent: null,
  id: null,
  parent: null,
  durationPartial: false,
  reportPartial: false,
  observedPriorTokenUsage: false,
  rejectedMetricRecords: 0,
  start: null,
  end: null,
  cwd: null,
  model: 'codex',
  models: [],
  phases: [],
  skillObservations: [],
  skillObservationRejects: 0,
  skillObservationsTruncated: false,
  subagentKind: null,
  threadSource: null,
  agentNickname: null,
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

const emptyDetailTokens = (): SessionDetailTokenCounts => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  total: 0,
});

const addDetailTokens = (target: SessionDetailTokenCounts, delta: SessionDetailTokenCounts): void => {
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.input += delta.input;
  target.output += delta.output;
  target.total += delta.total;
};

const phaseTokenTotal = (phase: CodexSessionPhase): number => phase.tin + phase.tcr + phase.tout;

const dominantCodexModel = (session: CodexSession): string => {
  const totals = new Map<string, number>();
  for (const phase of session.phases) {
    totals.set(phase.model, (totals.get(phase.model) ?? 0) + phaseTokenTotal(phase));
  }
  let dominantModel = session.models[0] ?? session.model;
  let dominantTokens = -1;
  for (const model of session.models) {
    const tokens = totals.get(model) ?? 0;
    if (tokens > dominantTokens) {
      dominantModel = model;
      dominantTokens = tokens;
    }
  }
  return dominantModel;
};

const mergedIntervalDurationMs = (intervals: CodexTaskInterval[]): number => {
  const sortedIntervals = [...intervals].sort((left, right) => left.startMs - right.startMs);
  let mergedEndMs: number | null = null;
  let mergedStartMs: number | null = null;
  let totalMs = 0;
  for (const interval of sortedIntervals) {
    if (mergedStartMs === null || mergedEndMs === null) {
      mergedStartMs = interval.startMs;
      mergedEndMs = interval.endMs;
      continue;
    }
    if (interval.startMs <= mergedEndMs) {
      mergedEndMs = Math.max(mergedEndMs, interval.endMs);
      continue;
    }
    totalMs += mergedEndMs - mergedStartMs;
    mergedStartMs = interval.startMs;
    mergedEndMs = interval.endMs;
  }
  if (mergedStartMs !== null && mergedEndMs !== null) {
    totalMs += mergedEndMs - mergedStartMs;
  }
  return totalMs;
};

const textFromContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = nonEmpty(record.text) ?? nonEmpty(record.input_text);
    if (text) {
      return text;
    }
  }
  return null;
};

const userTextFromPayload = (payload: Record<string, unknown>): string | null => {
  if (payload.type === 'message' && payload.role === 'user') {
    return textFromContent(payload.content);
  }
  if (payload.type === 'user_message') {
    return nonEmpty(payload.message) ?? nonEmpty(payload.text) ?? textFromContent(payload.content);
  }
  return null;
};

const codexLinePrefix = (line: string) => (line.length > 300 ? line.slice(0, 300) : line);

const isCodexToolCallPrefix = (prefix: string) =>
  prefix.includes('"type":"function_call"') ||
  prefix.includes('"type":"custom_tool_call"') ||
  prefix.includes('"type":"web_search_call"') ||
  prefix.includes('"type":"tool_search_call"');

/**
 * Codex injects its skill catalogue into a developer message, which the gate
 * above deliberately skips: those lines run to tens of kilobytes and parsing
 * every one of them across a full history sweep is not free.
 *
 * So the catalogue is admitted in two stages. The cheap prefix test below runs
 * on the first 300 bytes like every other gate; only a line that already looks
 * like a developer message pays for a full-line substring scan, and only a line
 * that actually contains the catalogue heading is parsed.
 */
const isCodexDeveloperMessagePrefix = (prefix: string) =>
  prefix.includes('"role":"developer"') || prefix.includes('"role": "developer"');

const isCodexSkillCatalogueLine = (prefix: string, line: string) =>
  isCodexDeveloperMessagePrefix(prefix) && line.includes(CODEX_AVAILABLE_SKILLS_HEADING);

const shouldParseCodexPrefix = (prefix: string) =>
  prefix.includes('token_count') ||
  prefix.includes('session_meta') ||
  prefix.includes('turn_context') ||
  prefix.includes('task_started') ||
  prefix.includes('task_complete') ||
  prefix.includes('turn_aborted') ||
  prefix.includes('user_message') ||
  prefix.includes('"role":"user"') ||
  prefix.includes('"role": "user"');

interface MutableCodexTask {
  canonicalPromptSeen: boolean;
  effort: string | null;
  hasContext: boolean;
  lastPromptAt: Date | null;
  lastPromptNormalized: string | null;
  model: string;
  observedEnd: Date;
  pendingResponsePrompt: { at: Date; text: string } | null;
  promptIds: string[];
  replayed: boolean;
  start: Date;
  tokens: SessionDetailTokenCounts;
  tools: number;
  turnId: string;
}

interface CodexTokenSnapshot {
  cacheRead: number;
  input: number;
  output: number;
  total: number;
}

export type CodexUsageOwnership = 'root' | 'session' | 'unknown';

const truncatePrompt = (text: string, maximumBytes: number): { text: string; truncated: boolean } => {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maximumBytes) {
    return { text, truncated: false };
  }
  return {
    text: encoded.subarray(0, maximumBytes).toString('utf8').replace(TRAILING_REPLACEMENT_CHARACTER, ''),
    truncated: true,
  };
};

const CODEX_COMMIT_HASH = /^[0-9a-fA-F]{1,64}$/;

const codexVcsFromSessionMeta = (payload: Record<string, unknown>, at: Date): SessionVcsContext | undefined => {
  if (!isRecord(payload.git)) {
    return;
  }
  const git = payload.git;
  let partial = false;
  let repository: SessionVcsRepository | null = null;
  if (typeof git.repository_url === 'string') {
    repository = normalizeSessionVcsRepository(git.repository_url, 'harness-recorded');
    partial = repository === null;
  } else if (git.repository_url !== undefined) {
    partial = true;
  }
  const branchObservations = typeof git.branch === 'string' ? [{ name: git.branch, observedAt: at.toISOString() }] : [];
  if (git.branch !== undefined && typeof git.branch !== 'string') {
    partial = true;
  }
  const branches = compactSessionVcsBranchObservations(branchObservations, 'harness-recorded', repository);
  partial ||= branches.partial;
  let headCommit: SessionVcsCommit | null = null;
  if (typeof git.commit_hash === 'string' && CODEX_COMMIT_HASH.test(git.commit_hash)) {
    const hash = git.commit_hash.toLowerCase();
    headCommit = {
      hash,
      observedAt: at.toISOString(),
      provenance: 'harness-recorded' as const,
      webUrl: repository ? sessionVcsCommitUrl(repository, hash) : null,
    };
  } else if (git.commit_hash !== undefined) {
    partial = true;
  }
  return parseSessionVcsContext({
    branches: branches.spans,
    headCommit,
    partial,
    pullRequests: [],
    repository,
  });
};

/** Concatenate a developer message's text blocks, so the catalogue can be found in them. */
const codexDeveloperMessageText = (payload: Record<string, unknown>): string => {
  const { content } = payload;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
};

/** The identity Codex gives a tool call, used so a re-scan re-imports idempotently. */
const codexToolCallId = (payload: Record<string, unknown>, fallbackIndex: number): string =>
  nonEmpty(payload.call_id) ?? nonEmpty(payload.id) ?? `record-${fallbackIndex}`;

/**
 * The raw command blob a Codex tool call carries, whichever record shape it
 * uses. It is handed on unparsed: `matchCodexSkillDocuments` owns decoding,
 * because the blob is JSON or a JavaScript snippet rather than a shell string
 * and matching it raw captures command text.
 */
const codexToolCallCommandBlob = (payload: Record<string, unknown>): string | null => {
  if (typeof payload.input === 'string') {
    return payload.input;
  }
  if (typeof payload.arguments === 'string') {
    return payload.arguments;
  }
  const action = isRecord(payload.action) ? payload.action : null;
  return action && Array.isArray(action.command) ? JSON.stringify({ command: action.command }) : null;
};

/**
 * Tool calls that cannot be a skill read, skipped before any decoding. Patch
 * bodies and agent prompts routinely quote a SKILL.md path without reading one.
 */
const CODEX_NON_EXEC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'apply_patch',
  'spawn_agent',
  'wait_agent',
  'send_message',
  'write_stdin',
]);

interface PendingCodexExecSignal {
  at: Date;
  callId: string;
  entries: CodexSkillCatalogueEntry[];
}

interface PendingCodexCatalogueSignal {
  at: Date;
  entries: CodexSkillCatalogueEntry[];
}

export const createCodexSessionParser = (captureDetail = false) => {
  const session = emptySession();
  const completedTasks: (MutableCodexTask & { durationMs: number; end: Date })[] = [];
  const observedTaskIntervals: CodexTaskInterval[] = [];
  const openTasks = new Map<string, MutableCodexTask>();
  const prompts: SessionDetailPrompt[] = [];
  // Buffered rather than projected inline: the session id and cwd arrive with
  // session_meta, and only matched names and paths are retained — never the
  // command string, which is unbounded and carries whatever the model typed.
  const pendingExecSignals: PendingCodexExecSignal[] = [];
  let pendingCatalogue: PendingCodexCatalogueSignal | null = null;
  let skillSignalIndex = 0;
  let lines = 0;
  let parsedLines = 0;
  let skippedLines = 0;
  let currentEffort: string | null = null;
  let currentModel = 'codex';
  let hasContextualTokenSnapshot = false;
  let legacyMaxTokens: CodexTokenSnapshot | null = null;
  let previousTokens: CodexTokenSnapshot | null = null;
  let promptBytes = 0;
  let promptsTruncated = false;
  let taskObservedEnd: Date | null = null;
  let taskObservedStart: Date | null = null;
  let finalized = false;
  let timingPartial = false;
  const parseStartedAt = Date.now();

  const latestOpenTask = (): MutableCodexTask | null => {
    let latest: MutableCodexTask | null = null;
    for (const task of openTasks.values()) {
      if (!task.replayed) {
        latest = task;
      }
    }
    return latest;
  };

  const observeTask = (task: MutableCodexTask, at: Date): void => {
    if (at > task.observedEnd) {
      task.observedEnd = at;
    }
  };

  const addModel = (model: string): void => {
    if (!(session.models.includes(model) || session.models.length >= CODEX_DETAIL_MAX_PHASES)) {
      session.models.push(model);
    }
  };

  const ensurePhase = (at: Date): CodexSessionPhase | null => {
    const last = session.phases.at(-1);
    if (last?.model === currentModel && last.effort === currentEffort) {
      if (at > last.end) {
        last.end = at;
      }
      return last;
    }
    if (session.phases.length >= CODEX_DETAIL_MAX_PHASES) {
      return last ?? null;
    }
    if (last && at > last.end) {
      last.end = at;
    }
    const phaseStart = latestOpenTask()?.start ?? at;
    const phase = {
      effort: currentEffort,
      end: at < phaseStart ? phaseStart : at,
      model: currentModel,
      start: phaseStart,
      tcr: 0,
      tin: 0,
      tout: 0,
    };
    session.phases.push(phase);
    return phase;
  };

  const appendPrompt = (task: MutableCodexTask, text: string, at: Date): void => {
    const normalized = usablePrompt(text);
    if (!normalized) {
      return;
    }
    if (!session.firstUser) {
      session.firstUser = deriveSessionLabelFromPrompt(text);
    }
    if (!captureDetail) {
      return;
    }
    const adjacentDuplicate =
      normalized === task.lastPromptNormalized &&
      task.lastPromptAt !== null &&
      Math.abs(at.getTime() - task.lastPromptAt.getTime()) <= CODEX_DETAIL_DUPLICATE_PROMPT_WINDOW_MS;
    if (adjacentDuplicate) {
      task.lastPromptAt = at;
      return;
    }
    task.lastPromptAt = at;
    task.lastPromptNormalized = normalized;
    if (prompts.length >= CODEX_DETAIL_MAX_PROMPTS) {
      promptsTruncated = true;
      return;
    }
    const remainingBytes = CODEX_DETAIL_MAX_PROMPT_TOTAL_BYTES - promptBytes;
    if (remainingBytes <= 0) {
      promptsTruncated = true;
      return;
    }
    const maximumBytes = Math.min(CODEX_DETAIL_MAX_PROMPT_BYTES, remainingBytes);
    const bounded = truncatePrompt(text.trim(), maximumBytes);
    if (!bounded.text) {
      promptsTruncated = true;
      return;
    }
    if (Buffer.byteLength(text.trim(), 'utf8') > remainingBytes) {
      promptsTruncated = true;
    }
    const prompt = {
      id: `prompt-${prompts.length + 1}`,
      text: bounded.text,
      timestamp: at.toISOString(),
      truncated: bounded.truncated,
    };
    prompts.push(prompt);
    promptBytes += Buffer.byteLength(prompt.text, 'utf8');
    task.promptIds.push(prompt.id);
  };

  const recordPrompt = (task: MutableCodexTask | null, text: string, at: Date, canonical: boolean): void => {
    if (!task?.hasContext) {
      return;
    }
    observeTask(task, at);
    if (!canonical) {
      task.pendingResponsePrompt = { at, text };
      return;
    }
    task.canonicalPromptSeen = true;
    task.pendingResponsePrompt = null;
    appendPrompt(task, text, at);
  };

  const flushResponsePrompt = (task: MutableCodexTask): void => {
    if (!(task.canonicalPromptSeen || !task.pendingResponsePrompt)) {
      const pendingPrompt = task.pendingResponsePrompt;
      task.pendingResponsePrompt = null;
      appendPrompt(task, pendingPrompt.text, pendingPrompt.at);
    }
  };

  const tokenSnapshotFrom = (value: unknown): CodexTokenSnapshot | null => {
    if (!isRecord(value)) {
      return null;
    }
    const total = parseNonNegativeSafeInteger(value.total_tokens);
    const input = parseNonNegativeSafeInteger(value.input_tokens);
    const cacheRead = parseNonNegativeSafeInteger(value.cached_input_tokens);
    const output = parseNonNegativeSafeInteger(value.output_tokens);
    if (!(total.ok && input.ok && cacheRead.ok && output.ok) || cacheRead.value > input.value) {
      return null;
    }
    return { cacheRead: cacheRead.value, input: input.value, output: output.value, total: total.value };
  };

  const detailDelta = (current: CodexTokenSnapshot, baseline: CodexTokenSnapshot): SessionDetailTokenCounts => ({
    cacheRead: current.cacheRead - baseline.cacheRead,
    cacheWrite: 0,
    input: current.input - current.cacheRead - (baseline.input - baseline.cacheRead),
    output: current.output - baseline.output,
    total: current.input - baseline.input + (current.output - baseline.output),
  });

  const recordTokenDelta = (delta: SessionDetailTokenCounts, at: Date, task: MutableCodexTask): void => {
    if (delta.input < 0 || delta.cacheRead < 0 || delta.output < 0 || delta.total < 0) {
      session.rejectedMetricRecords++;
      return;
    }
    if (delta.total !== delta.input + delta.cacheRead + delta.output) {
      session.rejectedMetricRecords++;
      return;
    }
    session.tin += delta.input;
    session.tcr += delta.cacheRead;
    session.tout += delta.output;
    const phase = ensurePhase(at);
    if (phase) {
      phase.tin += delta.input;
      phase.tcr += delta.cacheRead;
      phase.tout += delta.output;
    }
    addDetailTokens(task.tokens, delta);
  };

  const recordTokens = (payload: Record<string, unknown>, at: Date): void => {
    const hasRateLimits = isRecord(payload.rate_limits);
    if (hasRateLimits) {
      session.subscription = true;
    }
    if (payload.info === null && hasRateLimits) {
      return;
    }
    const info = isRecord(payload.info) ? payload.info : null;
    const snapshot = tokenSnapshotFrom(isRecord(info?.total_token_usage) ? info.total_token_usage : null);
    if (!snapshot) {
      session.rejectedMetricRecords++;
      return;
    }
    const lastUsage = tokenSnapshotFrom(isRecord(info?.last_token_usage) ? info.last_token_usage : null);
    if (lastUsage && snapshot.total > lastUsage.total) {
      session.observedPriorTokenUsage = true;
    }
    session.hasTokenUsage = true;
    session.maxTotal = Math.max(session.maxTotal, snapshot.total);
    if (!legacyMaxTokens || snapshot.total > legacyMaxTokens.total) {
      legacyMaxTokens = snapshot;
    }
    const task = latestOpenTask();
    const contextualTask = task?.hasContext ? task : null;
    if (contextualTask) {
      observeTask(contextualTask, at);
      hasContextualTokenSnapshot = true;
    }
    if (!previousTokens) {
      previousTokens = snapshot;
      if (contextualTask) {
        const zero = { cacheRead: 0, input: 0, output: 0, total: 0 };
        recordTokenDelta(
          lastUsage && snapshot.total > lastUsage.total ? detailDelta(lastUsage, zero) : detailDelta(snapshot, zero),
          at,
          contextualTask,
        );
      }
      return;
    }
    const nonMonotonic =
      snapshot.total < previousTokens.total ||
      snapshot.input < previousTokens.input ||
      snapshot.cacheRead < previousTokens.cacheRead ||
      snapshot.output < previousTokens.output;
    if (nonMonotonic) {
      session.rejectedMetricRecords++;
      previousTokens = snapshot;
      if (lastUsage && contextualTask) {
        recordTokenDelta(detailDelta(lastUsage, { cacheRead: 0, input: 0, output: 0, total: 0 }), at, contextualTask);
      }
      return;
    }
    const delta = detailDelta(snapshot, previousTokens);
    previousTokens = snapshot;
    if (contextualTask) {
      recordTokenDelta(delta, at, contextualTask);
    }
  };

  const visit = (line: string): void => {
    if (!line) {
      return;
    }
    lines++;
    const prefix = codexLinePrefix(line);
    const skillCatalogueLine = isCodexSkillCatalogueLine(prefix, line);
    if (!(shouldParseCodexPrefix(prefix) || isCodexToolCallPrefix(prefix) || skillCatalogueLine)) {
      skippedLines++;
      return;
    }
    parsedLines++;
    const event = safeJSON(line);
    if (!event) {
      return;
    }
    const timestamp =
      typeof event.timestamp === 'string' || typeof event.timestamp === 'number' ? event.timestamp : Number.NaN;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      return;
    }
    if (!session.start || date < session.start) {
      session.start = date;
    }
    if (!session.end || date > session.end) {
      session.end = date;
    }

    const payload = isRecord(event.payload) ? event.payload : {};
    if (isCodexToolCallPrefix(prefix)) {
      const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : null;
      const turnId = nonEmpty(metadata?.turn_id);
      const task = turnId ? (openTasks.get(turnId) ?? null) : latestOpenTask();
      if (task?.hasContext) {
        observeTask(task, date);
        session.tools++;
        task.tools++;
      }
      observeCodexSkillExec(payload, date);
    }
    if (skillCatalogueLine) {
      observeCodexSkillCatalogue(codexDeveloperMessageText(payload), date);
    }
    const sessionMetaId = event.type === 'session_meta' ? nonEmpty(payload.id) : null;
    if (sessionMetaId && !session.id) {
      session.id = sessionMetaId;
      session.cwd = typeof payload.cwd === 'string' ? payload.cwd : session.cwd;
      const sessionVcs = codexVcsFromSessionMeta(payload, date);
      if (sessionVcs) {
        session.vcs = sessionVcs;
      }
      session.threadSource = typeof payload.thread_source === 'string' ? payload.thread_source : session.threadSource;
      const subagent = codexSubagentFromSource(payload.source);
      if (subagent) {
        session.subagentKind = subagent.kind;
      }
      if (subagent?.kind === 'thread-spawn') {
        session.parent = nonEmpty(subagent.threadSpawn.parent_thread_id) ?? session.parent;
        session.agentNickname =
          nonEmpty(subagent.threadSpawn.agent_nickname) ??
          nonEmpty(subagent.threadSpawn.agent_role) ??
          session.agentNickname;
      } else if (subagent?.kind === 'guardian' || subagent?.kind === 'review') {
        session.classifierParent = nonEmpty(payload.parent_thread_id) ?? session.classifierParent;
      }
    }
    if (event.type === 'turn_context' && typeof payload.model === 'string') {
      const turnId = nonEmpty(payload.turn_id);
      const task = turnId ? (openTasks.get(turnId) ?? null) : latestOpenTask();
      if (task && !task.replayed) {
        currentModel = payload.model;
        currentEffort = nonEmpty(payload.effort) ?? nonEmpty(payload.reasoning_effort);
        addModel(currentModel);
        if (!task.hasContext) {
          task.hasContext = true;
          session.turns++;
          if (!taskObservedStart || task.start < taskObservedStart) {
            taskObservedStart = task.start;
          }
        }
        observeTask(task, date);
        task.model = currentModel;
        task.effort = currentEffort;
        ensurePhase(date);
      }
    }
    const userText = userTextFromPayload(payload);
    if (userText) {
      if (session.subagentKind === 'guardian' && !session.classifierParent) {
        session.classifierParent = guardianParentSessionId(userText);
      }
      const canonical = payload.type === 'user_message';
      const promptMetadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : null;
      const promptTurnId = nonEmpty(promptMetadata?.turn_id);
      const promptTask = promptTurnId ? (openTasks.get(promptTurnId) ?? null) : latestOpenTask();
      recordPrompt(promptTask, userText, date, canonical);
    }
    if (payload.type === 'task_started') {
      const turnId = nonEmpty(payload.turn_id) ?? `turn-${lines}`;
      const recordedTaskStart = unixDate(payload.started_at);
      const taskStart = recordedTaskStart ?? date;
      const recordedStartPredatesRollout = Boolean(
        recordedTaskStart && session.start && recordedTaskStart < session.start,
      );
      const replayed = Boolean(
        recordedTaskStart &&
          recordedStartPredatesRollout &&
          date.getTime() - recordedTaskStart.getTime() > CODEX_REPLAYED_TASK_EVENT_LAG_MS,
      );
      const hasReplayLineage = session.parent !== null || session.threadSource === 'subagent';
      if (replayed && !hasReplayLineage) {
        session.durationPartial = true;
        session.reportPartial = true;
      }
      if (!(openTasks.has(turnId) || openTasks.size < CODEX_DETAIL_MAX_TURNS)) {
        const oldestUnanchored = [...openTasks].find(([, task]) => !task.hasContext)?.[0];
        if (!oldestUnanchored) {
          return;
        }
        openTasks.delete(oldestUnanchored);
      }
      openTasks.set(turnId, {
        canonicalPromptSeen: false,
        effort: currentEffort,
        hasContext: false,
        lastPromptAt: null,
        lastPromptNormalized: null,
        model: currentModel,
        observedEnd: date < taskStart ? taskStart : date,
        pendingResponsePrompt: null,
        promptIds: [],
        replayed,
        start: taskStart,
        tokens: emptyDetailTokens(),
        tools: 0,
        turnId,
      });
    }
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      const turnId = nonEmpty(payload.turn_id);
      const task = turnId ? (openTasks.get(turnId) ?? null) : latestOpenTask();
      const taskEnd = unixDate(payload.completed_at) ?? date;
      if (task && taskEnd >= task.start) {
        openTasks.delete(task.turnId);
        if (task.hasContext) {
          flushResponsePrompt(task);
          const parsedDuration = parseNonNegativeSafeInteger(payload.duration_ms);
          const recordedDurationMs = parsedDuration.ok
            ? parsedDuration.value
            : taskEnd.getTime() - task.start.getTime();
          const turnEnd = new Date(Math.min(taskEnd.getTime(), task.start.getTime() + recordedDurationMs));
          const durationMs = turnEnd.getTime() - task.start.getTime();
          observedTaskIntervals.push({
            endMs: turnEnd.getTime(),
            startMs: task.start.getTime(),
          });
          if (captureDetail && completedTasks.length < CODEX_DETAIL_MAX_TURNS) {
            completedTasks.push({ ...task, durationMs, end: turnEnd });
          }
          taskObservedEnd = !taskObservedEnd || taskEnd > taskObservedEnd ? taskEnd : taskObservedEnd;
          ensurePhase(taskEnd);
        }
      }
    }
    if (payload.type === 'token_count') {
      recordTokens(payload, date);
    }
  };

  const observeCodexSkillExec = (payload: Record<string, unknown>, at: Date): void => {
    if (pendingExecSignals.length >= MAX_SKILL_OBSERVATIONS_PER_SESSION) {
      return;
    }
    if (typeof payload.name === 'string' && CODEX_NON_EXEC_TOOL_NAMES.has(payload.name)) {
      return;
    }
    const entries = matchCodexSkillDocuments(codexToolCallCommandBlob(payload));
    if (entries.length === 0) {
      return;
    }
    skillSignalIndex += 1;
    pendingExecSignals.push({ at, callId: codexToolCallId(payload, skillSignalIndex), entries });
  };

  const observeCodexSkillCatalogue = (text: string, at: Date): void => {
    // The catalogue is re-injected on every turn. It describes one session's
    // exposure, so the first one wins rather than accumulating duplicates.
    if (pendingCatalogue) {
      return;
    }
    const entries = extractCodexSkillCatalogue(text);
    if (entries.length > 0) {
      pendingCatalogue = { at, entries };
    }
  };

  /**
   * Project the buffered signals once the session identity is known. A session
   * that never declared an id cannot key an observation, so its signals are
   * dropped here — the same rule the usage-row path applies to such a session.
   */
  const materializeSkillObservations = (): void => {
    const sessionId = session.id;
    if (!sessionId) {
      return;
    }
    const projectPath = session.cwd;
    const observations: SkillObservation[] = [];
    let rejected = 0;
    if (pendingCatalogue) {
      const exposed = codexSkillCatalogueObservations(pendingCatalogue.entries, {
        observedAt: pendingCatalogue.at.toISOString(),
        projectPath,
        sessionId,
      });
      observations.push(...exposed.observations);
      rejected += exposed.rejected;
    }
    for (const signal of pendingExecSignals) {
      const inferred = codexSkillExecObservations(signal.entries, signal.callId, {
        observedAt: signal.at.toISOString(),
        projectPath,
        sessionId,
      });
      observations.push(...inferred.observations);
      rejected += inferred.rejected;
    }
    session.skillObservations = observations.slice(0, MAX_SKILL_OBSERVATIONS_PER_SESSION);
    session.skillObservationRejects = rejected;
    session.skillObservationsTruncated = observations.length > MAX_SKILL_OBSERVATIONS_PER_SESSION;
  };

  const finalize = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    materializeSkillObservations();
    if (!hasContextualTokenSnapshot && legacyMaxTokens) {
      session.tin = legacyMaxTokens.input - legacyMaxTokens.cacheRead;
      session.tcr = legacyMaxTokens.cacheRead;
      session.tout = legacyMaxTokens.output;
    }
    if (session.models.length === 0) {
      addModel(currentModel);
    }
    for (const task of openTasks.values()) {
      if (!(task.hasContext && !task.replayed)) {
        continue;
      }
      session.durationPartial = true;
      session.reportPartial = true;
      timingPartial = true;
      flushResponsePrompt(task);
      observedTaskIntervals.push({
        endMs: task.observedEnd.getTime(),
        startMs: task.start.getTime(),
      });
      if (!taskObservedEnd || task.observedEnd > taskObservedEnd) {
        taskObservedEnd = task.observedEnd;
      }
    }
    if (taskObservedStart) {
      session.start = taskObservedStart;
    }
    if (taskObservedEnd) {
      session.end = taskObservedEnd;
    }
    session.model = dominantCodexModel(session);
    session.activeDurationMs = mergedIntervalDurationMs(observedTaskIntervals);
  };

  const detailPhases = (): SessionDetailPhase[] => {
    const sessionStart = session.start;
    const sessionEnd = session.end;
    if (!(sessionStart && sessionEnd)) {
      return [];
    }
    return session.phases.flatMap((phase) => {
      const start = phase.start < sessionStart ? sessionStart : phase.start;
      const end = phase.end > sessionEnd ? sessionEnd : phase.end;
      if (end < start) {
        return [];
      }
      const tokens = {
        cacheRead: phase.tcr,
        cacheWrite: 0,
        input: phase.tin,
        output: phase.tout,
        total: phaseTokenTotal(phase),
      };
      const pricing = priceFor(phase.model, { at: end });
      return [
        {
          cost: pricing.known
            ? approxCost(pricing.rates, { cr: phase.tcr, cw: 0, in: phase.tin, out: phase.tout })
            : null,
          costKind: pricing.known ? ('approximate' as const) : ('unknown' as const),
          effort: phase.effort,
          effortKind: phase.effort ? ('recorded' as const) : ('default' as const),
          endAt: end.toISOString(),
          model: phase.model,
          startAt: start.toISOString(),
          tokens,
        },
      ];
    });
  };

  const detailTurns = (): SessionDetailTurn[] => {
    const tasks = [...completedTasks];
    for (const task of openTasks.values()) {
      if (task.hasContext && !task.replayed) {
        tasks.push({
          ...task,
          durationMs: task.observedEnd.getTime() - task.start.getTime(),
          end: task.observedEnd,
        });
      }
    }
    tasks.sort((left, right) => left.start.getTime() - right.start.getTime());
    return tasks.slice(0, CODEX_DETAIL_MAX_TURNS).map((task, index) => ({
      durationMs: task.durationMs,
      effort: task.effort,
      effortKind: task.effort ? ('recorded' as const) : ('default' as const),
      endAt: task.end.toISOString(),
      index,
      intervals: [{ endAt: task.end.toISOString(), startAt: task.start.toISOString() }],
      model: task.model === 'codex' ? session.model : task.model,
      promptIds: task.promptIds,
      startAt: task.start.toISOString(),
      timingStatus: 'recorded',
      tokens: task.tokens,
      tools: task.tools,
    }));
  };

  const detail = (): SessionDetail | null => {
    if (!(captureDetail && session.id && session.start && session.end)) {
      return null;
    }
    const activeDurationMs = session.activeDurationMs ?? 0;
    const elapsedDurationMs = session.end.getTime() - session.start.getTime();
    const turns = detailTurns();
    return {
      activeDurationMs,
      durationStatus: timingPartial ? 'partial' : 'recorded',
      efforts: [...new Set(session.phases.flatMap((phase) => (phase.effort ? [phase.effort] : [])))],
      elapsedDurationMs,
      endedAt: session.end.toISOString(),
      idleDurationMs: Math.max(0, elapsedDurationMs - activeDurationMs),
      models: session.models,
      observedAt: new Date().toISOString(),
      phases: detailPhases(),
      prompts,
      promptsTruncated,
      sourceSessionId: session.id,
      startedAt: session.start.toISOString(),
      turns,
      turnsStatus: 'recorded',
    };
  };

  const analysis = (usageOwnership: CodexUsageOwnership = 'session'): LocalSessionAnalysis | null => {
    const parsedDetail = detail();
    if (!parsedDetail) {
      return null;
    }
    return {
      detail: parsedDetail,
      projection: codexProjectionFacts(session, usageOwnership),
    };
  };

  return {
    analysis,
    detail,
    finish: (): CodexSessionParseResult => {
      finalize();
      return {
        lines,
        parseMs: Date.now() - parseStartedAt,
        parsedLines,
        rejectedMetricRecords: session.rejectedMetricRecords,
        session,
        skippedLines,
      };
    },
    visit,
  };
};

const removeSelfParent = (session: CodexSession): CodexSession => {
  if (session.id && session.parent === session.id) {
    session.parent = null;
  }
  return session;
};

export const mergeMetadata = (session: CodexSession, metadata: CodexThreadMetadata | undefined) => {
  if (!metadata) {
    return removeSelfParent(session);
  }
  session.parent = session.parent ?? metadata.parent;
  session.start = session.start ?? metadata.start;
  session.end = session.end ?? metadata.end;
  session.cwd = session.cwd ?? metadata.cwd;
  if (session.model === 'codex' && metadata.model) {
    session.model = metadata.model;
    session.models = session.models.map((model) => (model === 'codex' ? (metadata.model ?? model) : model));
    for (const phase of session.phases) {
      if (phase.model === 'codex') {
        phase.model = metadata.model;
      }
    }
  }
  session.threadSource = session.threadSource ?? metadata.threadSource;
  session.agentNickname = session.agentNickname ?? metadata.agentNickname;
  session.subagentKind = session.subagentKind ?? metadata.subagentKind;
  if (session.subagentKind === 'guardian' && !session.classifierParent) {
    session.classifierParent = guardianParentSessionId(metadata.firstUser);
  }
  const metadataFirstUser =
    metadata.firstUser && usablePrompt(metadata.firstUser) ? deriveSessionLabelFromPrompt(metadata.firstUser) : null;
  session.firstUser = session.firstUser ?? metadataFirstUser;
  return removeSelfParent(session);
};

const REVIEWED_CODEX_SESSION_ID =
  /Reviewed Codex session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/iu;

const guardianParentSessionId = (conversation: string | null | undefined): string | null =>
  conversation?.match(REVIEWED_CODEX_SESSION_ID)?.[1] ?? null;

const resolveCodexRootId = (session: CodexSession, sessionsById: ReadonlyMap<string, CodexSession>): string | null => {
  const sourceSessionId = session.id;
  if (!sourceSessionId) {
    return null;
  }

  let current = session;
  const seen = new Set<string>();
  let traversedEdges = 0;
  while (current.id) {
    if (seen.has(current.id)) {
      return sourceSessionId;
    }
    seen.add(current.id);
    if (!current.parent) {
      return current.id;
    }
    if (traversedEdges >= CODEX_LINEAGE_MAX_DEPTH) {
      return sourceSessionId;
    }
    const parent = sessionsById.get(current.parent);
    if (!parent) {
      return sourceSessionId;
    }
    current = parent;
    traversedEdges++;
  }
  return sourceSessionId;
};

export const codexModelSegments = (session: CodexSession): UsageModelSegment[] => {
  const segments = new Map<string, UsageModelSegment>();
  const addSegment = (model: string, tokens: { cr: number; in: number; out: number }, at: Date | null): void => {
    const pricing = priceFor(model, { at });
    const tokenBearing = tokens.in + tokens.cr + tokens.out > 0;
    const current = segments.get(model) ?? {
      costApprox: 0,
      costKnown: true,
      model,
      tokCr: 0,
      tokCw: 0,
      tokIn: 0,
      tokOut: 0,
    };
    current.costApprox += approxCost(pricing.rates, { ...tokens, cw: 0 });
    current.costKnown = current.costKnown && (!tokenBearing || pricing.known);
    current.tokCr += tokens.cr;
    current.tokIn += tokens.in;
    current.tokOut += tokens.out;
    segments.set(model, current);
  };

  if (session.phases.length === 0) {
    addSegment(session.model, { cr: session.tcr, in: session.tin, out: session.tout }, session.end);
  } else {
    for (const phase of session.phases) {
      addSegment(phase.model, { cr: phase.tcr, in: phase.tin, out: phase.tout }, phase.end);
    }
    const phaseTotals = [...segments.values()].reduce(
      (totals, segment) => ({
        cr: totals.cr + segment.tokCr,
        in: totals.in + segment.tokIn,
        out: totals.out + segment.tokOut,
      }),
      { cr: 0, in: 0, out: 0 },
    );
    const phasesReconcile =
      phaseTotals.cr === session.tcr && phaseTotals.in === session.tin && phaseTotals.out === session.tout;
    if (!phasesReconcile) {
      // A cumulative snapshot observed outside a contextual task can only be
      // attributed when every model observation agrees. Otherwise keep the
      // aggregate intact in an explicit unsegmented lower-bound bucket.
      const observedModels = new Set([...session.models, ...session.phases.map((phase) => phase.model)]);
      if (observedModels.size === 0) {
        observedModels.add(session.model);
      }
      const fallbackModel = observedModels.size === 1 ? ([...observedModels][0] ?? session.model) : null;
      segments.clear();
      addSegment(
        fallbackModel ?? UNSEGMENTED_MULTI_MODEL_LABEL,
        { cr: session.tcr, in: session.tin, out: session.tout },
        session.end,
      );
    }
  }
  return [...segments.values()];
};

const projectionTokens = (tokens: { cr: number; cw: number; in: number; out: number }): SessionDetailTokenCounts => ({
  cacheRead: tokens.cr,
  cacheWrite: tokens.cw,
  input: tokens.in,
  output: tokens.out,
  total: tokens.cr + tokens.cw + tokens.in + tokens.out,
});

const codexProjectionFacts = (session: CodexSession, usageOwnership: CodexUsageOwnership): SessionProjectionFacts => {
  let modelSegments: SessionProjectionFacts['modelSegments'];
  if (usageOwnership === 'unknown') {
    modelSegments = null;
  } else if (usageOwnership === 'root') {
    modelSegments =
      session.models.length > 1
        ? null
        : [{ model: session.model, tokens: projectionTokens({ cr: 0, cw: 0, in: 0, out: 0 }) }];
  } else {
    modelSegments = codexModelSegments(session)
      .map((segment) => ({
        model: segment.model,
        tokens: projectionTokens({ cr: segment.tokCr, cw: segment.tokCw, in: segment.tokIn, out: segment.tokOut }),
      }))
      .sort((left, right) => left.model.localeCompare(right.model));
  }
  const usageUnavailable = usageOwnership !== 'session' || !session.hasTokenUsage;
  return {
    calls: 1,
    durationMs: session.activeDurationMs ?? 0,
    modelSegments,
    partial: session.reportPartial,
    tokens: usageUnavailable ? null : projectionTokens({ cr: session.tcr, cw: 0, in: session.tin, out: session.tout }),
    tools: session.tools,
    turns: session.turns,
  };
};

export const isCodexUsageOwnedByRoot = (
  session: CodexSession,
  sessionsById: ReadonlyMap<string, CodexSession>,
): boolean => {
  if (!(session.id && session.parent && session.observedPriorTokenUsage)) {
    return false;
  }
  if (session.phases.some((phase) => phaseTokenTotal(phase) > 0)) {
    return false;
  }
  const rootId = resolveCodexRootId(session, sessionsById);
  const root = rootId ? sessionsById.get(rootId) : undefined;
  return Boolean(rootId && root && root.id !== session.id && root.hasTokenUsage && root.maxTotal >= session.maxTotal);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const codexSourceRecord = (source: unknown): Record<string, unknown> | null => {
  if (typeof source === 'string') {
    return safeJSON(source);
  }
  return isRecord(source) ? source : null;
};

const codexSubagentFromSource = (source: unknown): CodexSubagent | null => {
  const parsedSource = codexSourceRecord(source);
  if (!parsedSource) {
    return null;
  }
  const { subagent } = parsedSource;
  if (subagent === 'review') {
    return { kind: 'review' };
  }
  if (!isRecord(subagent)) {
    return null;
  }
  if (isRecord(subagent.thread_spawn)) {
    return { kind: 'thread-spawn', threadSpawn: subagent.thread_spawn };
  }
  return subagent.other === 'guardian' ? { kind: 'guardian' } : null;
};

const threadSpawnFromSource = (source: unknown): Record<string, unknown> | null => {
  const subagent = codexSubagentFromSource(source);
  return subagent?.kind === 'thread-spawn' ? subagent.threadSpawn : null;
};
