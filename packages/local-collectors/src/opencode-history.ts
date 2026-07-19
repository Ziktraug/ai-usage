import type {
  SessionDetail,
  SessionDetailPhase,
  SessionDetailPrompt,
  SessionDetailTokenCounts,
  SessionDetailTurn,
} from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import {
  addNonNegativeFiniteNumbers,
  addNonNegativeSafeIntegers,
  parseFiniteTimestamp,
  parseNonNegativeFiniteNumber,
  parseOptionalNonNegativeSafeInteger,
} from './metric-validation';
import { OPENCODE_DIRECT_USER_PART_PREDICATE } from './opencode-schema';
import { resolvePathCandidates } from './platform-paths';

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const MAX_MESSAGE_ROWS = 2048;
const MAX_PHASES = 256;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_PROMPT_ROWS = 256;
const MAX_PROMPT_TOTAL_BYTES = 512 * 1024;
const MAX_TOOL_GROUPS = 1024;
const MAX_TURNS = 1024;
const TEXT_ENCODER = new TextEncoder();

export const OPENCODE_DETAIL_SESSION_SQL = 'SELECT id, time_created, time_updated FROM session WHERE id = ? LIMIT ?';
export const OPENCODE_DETAIL_MESSAGE_SQL = `
SELECT
  id,
  json_extract(data, '$.role') AS role,
  json_extract(data, '$.parentID') AS parent_id,
  COALESCE(json_extract(data, '$.time.created'), time_created) AS created,
  json_extract(data, '$.time.completed') AS completed,
  json_extract(data, '$.providerID') AS provider_id,
  json_extract(data, '$.modelID') AS model_id,
  json_extract(data, '$.variant') AS variant,
  json_extract(data, '$.tokens.input') AS token_input,
  json_extract(data, '$.tokens.output') AS token_output,
  json_extract(data, '$.tokens.reasoning') AS token_reasoning,
  json_extract(data, '$.tokens.cache.read') AS token_cache_read,
  json_extract(data, '$.tokens.cache.write') AS token_cache_write,
  json_extract(data, '$.cost') AS cost
FROM message
WHERE session_id = ? AND json_valid(data)
ORDER BY COALESCE(json_extract(data, '$.time.created'), time_created), id
LIMIT ?`;
export const OPENCODE_DETAIL_PROMPT_SQL = `
SELECT
  p.id,
  p.message_id,
  COALESCE(json_extract(m.data, '$.time.created'), m.time_created, p.time_created) AS created,
  substr(json_extract(p.data, '$.text'), 1, 32769) AS text,
  length(json_extract(p.data, '$.text')) AS text_length
FROM part p
JOIN message m ON m.id = p.message_id
WHERE p.session_id = ?
  AND m.session_id = ?
  AND json_valid(p.data)
  AND json_valid(m.data)
  AND json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text'
  AND COALESCE(json_extract(p.data, '$.synthetic'), 0) != 1
ORDER BY COALESCE(json_extract(m.data, '$.time.created'), m.time_created, p.time_created), p.id
LIMIT ?`;
export const OPENCODE_DETAIL_PARENT_SQL = `
SELECT DISTINCT p.message_id
FROM part p
JOIN message m ON m.id = p.message_id
WHERE p.session_id = ?
  AND m.session_id = ?
  AND json_valid(p.data)
  AND json_valid(m.data)
  AND json_extract(m.data, '$.role') = 'user'
  AND ${OPENCODE_DIRECT_USER_PART_PREDICATE}
ORDER BY p.message_id
LIMIT ?`;
export const OPENCODE_DETAIL_TOOL_SQL = `
SELECT message_id, count(*) AS tool_count
FROM part
WHERE session_id = ? AND json_valid(data) AND json_extract(data, '$.type') = 'tool'
GROUP BY message_id
ORDER BY message_id
LIMIT ?`;

interface OpenCodeDetailMessageRow {
  completed: unknown;
  cost: unknown;
  created: unknown;
  id: unknown;
  model_id: unknown;
  parent_id: unknown;
  provider_id: unknown;
  role: unknown;
  token_cache_read: unknown;
  token_cache_write: unknown;
  token_input: unknown;
  token_output: unknown;
  token_reasoning: unknown;
  variant: unknown;
}

interface OpenCodeDetailPromptRow {
  created: unknown;
  id: unknown;
  message_id: unknown;
  text: unknown;
  text_length: unknown;
}

interface OpenCodeDetailParentRow {
  message_id: unknown;
}

interface OpenCodeDetailSessionRow {
  id: unknown;
  time_created: unknown;
  time_updated: unknown;
}

interface OpenCodeDetailToolRow {
  message_id: unknown;
  tool_count: unknown;
}

interface ParsedOpenCodeTurn {
  cost: number | null;
  costKind: 'reported' | 'unknown';
  endMs: number;
  parentId: string | null;
  parentKind: 'human' | 'internal' | 'unresolved';
  startMs: number;
  turn: SessionDetailTurn;
}

interface BoundedPromptText {
  text: string;
  truncated: boolean;
}

interface MillisecondInterval {
  endMs: number;
  startMs: number;
}

const detailError = (operation: string, dbPath: string, message: string): LocalHistoryError =>
  new LocalHistoryError({ operation, path: dbPath, cause: new Error(message) });

const boundedString = (value: unknown, maximumLength = MAX_LABEL_LENGTH): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : null;
};

const timestampMs = (value: unknown): number | null => {
  const parsed = parseFiniteTimestamp(value);
  return parsed.ok ? parsed.value.getTime() : null;
};

const timestamp = (value: number): string => new Date(value).toISOString();

const addTokens = (
  left: SessionDetailTokenCounts,
  right: SessionDetailTokenCounts,
): SessionDetailTokenCounts | null => {
  const input = addNonNegativeSafeIntegers(left.input, right.input);
  const output = addNonNegativeSafeIntegers(left.output, right.output);
  const cacheRead = addNonNegativeSafeIntegers(left.cacheRead, right.cacheRead);
  const cacheWrite = addNonNegativeSafeIntegers(left.cacheWrite, right.cacheWrite);
  const total = addNonNegativeSafeIntegers(left.total, right.total);
  if (!(input.ok && output.ok && cacheRead.ok && cacheWrite.ok && total.ok)) {
    return null;
  }
  return {
    cacheRead: cacheRead.value,
    cacheWrite: cacheWrite.value,
    input: input.value,
    output: output.value,
    total: total.value,
  };
};

const tokensFromRow = (row: OpenCodeDetailMessageRow): SessionDetailTokenCounts | null => {
  const input = parseOptionalNonNegativeSafeInteger(row.token_input);
  const output = parseOptionalNonNegativeSafeInteger(row.token_output);
  const reasoning = parseOptionalNonNegativeSafeInteger(row.token_reasoning);
  const cacheRead = parseOptionalNonNegativeSafeInteger(row.token_cache_read);
  const cacheWrite = parseOptionalNonNegativeSafeInteger(row.token_cache_write);
  if (!(input.ok && output.ok && reasoning.ok && cacheRead.ok && cacheWrite.ok)) {
    return null;
  }
  const outputWithReasoning = addNonNegativeSafeIntegers(output.value, reasoning.value);
  if (!outputWithReasoning.ok) {
    return null;
  }
  const inputAndOutput = addNonNegativeSafeIntegers(input.value, outputWithReasoning.value);
  const caches = addNonNegativeSafeIntegers(cacheRead.value, cacheWrite.value);
  if (!(inputAndOutput.ok && caches.ok)) {
    return null;
  }
  const total = addNonNegativeSafeIntegers(inputAndOutput.value, caches.value);
  if (!total.ok) {
    return null;
  }
  return {
    cacheRead: cacheRead.value,
    cacheWrite: cacheWrite.value,
    input: input.value,
    output: outputWithReasoning.value,
    total: total.value,
  };
};

const modelLabel = (row: OpenCodeDetailMessageRow): string => {
  const provider = boundedString(row.provider_id) ?? 'unknown';
  const model = boundedString(row.model_id) ?? 'unknown';
  return `${provider}/${model}`;
};

const boundedPromptText = (value: string, maximumBytes: number): BoundedPromptText => {
  const characters: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const character of value) {
    const characterBytes = TEXT_ENCODER.encode(character).byteLength;
    if (characters.length >= MAX_PROMPT_BYTES || bytes + characterBytes > maximumBytes) {
      truncated = true;
      break;
    }
    characters.push(character);
    bytes += characterBytes;
  }
  return { text: characters.join(''), truncated };
};

const mergedActivityIntervals = (turns: readonly ParsedOpenCodeTurn[]): MillisecondInterval[] => {
  const intervals = turns
    .map(({ endMs, startMs }) => ({ endMs, startMs }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const first = intervals[0];
  if (!first) {
    return [];
  }
  let currentStart = first.startMs;
  let currentEnd = first.endMs;
  const merged: MillisecondInterval[] = [];
  for (const interval of intervals.slice(1)) {
    if (interval.startMs > currentEnd) {
      merged.push({ endMs: currentEnd, startMs: currentStart });
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      continue;
    }
    currentEnd = Math.max(currentEnd, interval.endMs);
  }
  merged.push({ endMs: currentEnd, startMs: currentStart });
  return merged;
};

const activeDuration = (turns: readonly ParsedOpenCodeTurn[]): number =>
  mergedActivityIntervals(turns).reduce((total, interval) => total + interval.endMs - interval.startMs, 0);

const promptsFromRows = (
  rows: readonly OpenCodeDetailPromptRow[],
): { prompts: SessionDetailPrompt[]; promptsTruncated: boolean } => {
  const prompts: SessionDetailPrompt[] = [];
  let remainingBytes = MAX_PROMPT_TOTAL_BYTES;
  let promptsTruncated = rows.length > MAX_PROMPT_ROWS;
  for (const row of rows.slice(0, MAX_PROMPT_ROWS)) {
    const id = boundedString(row.id, MAX_ID_LENGTH);
    const created = timestampMs(row.created);
    if (!(id && created !== null && typeof row.text === 'string' && row.text.length > 0)) {
      promptsTruncated = true;
      continue;
    }
    if (remainingBytes <= 0) {
      promptsTruncated = true;
      break;
    }
    const bounded = boundedPromptText(row.text, Math.min(MAX_PROMPT_BYTES, remainingBytes));
    if (!bounded.text) {
      promptsTruncated = true;
      continue;
    }
    const sourceLength = parseOptionalNonNegativeSafeInteger(row.text_length);
    const sqlTruncated = sourceLength.ok && sourceLength.value > row.text.length;
    const prompt: SessionDetailPrompt = {
      id,
      text: bounded.text,
      timestamp: timestamp(created),
      truncated: bounded.truncated || sqlTruncated,
    };
    prompts.push(prompt);
    remainingBytes -= TEXT_ENCODER.encode(prompt.text).byteLength;
    promptsTruncated = promptsTruncated || prompt.truncated;
  }
  return { prompts, promptsTruncated };
};

const parentKindFor = (
  parentId: string | null,
  userMessageIds: ReadonlySet<string>,
  directUserMessageIds: ReadonlySet<string>,
): ParsedOpenCodeTurn['parentKind'] => {
  if (parentId === null || !userMessageIds.has(parentId)) {
    return 'unresolved';
  }
  return directUserMessageIds.has(parentId) ? 'human' : 'internal';
};

const turnsFromRows = (
  rows: readonly OpenCodeDetailMessageRow[],
  prompts: readonly SessionDetailPrompt[],
  promptRows: readonly OpenCodeDetailPromptRow[],
  directUserMessageIds: ReadonlySet<string>,
  toolsByMessageId: ReadonlyMap<string, number>,
  dbPath: string,
): ParsedOpenCodeTurn[] => {
  const promptIdsByMessage = new Map<string, string[]>();
  const retainedPromptIds = new Set(prompts.map(({ id }) => id));
  const userMessageIds = new Set(
    rows.flatMap((row) => {
      const id = boundedString(row.id, MAX_ID_LENGTH);
      return row.role === 'user' && id ? [id] : [];
    }),
  );
  for (const row of promptRows) {
    const messageId = boundedString(row.message_id, MAX_ID_LENGTH);
    const promptId = boundedString(row.id, MAX_ID_LENGTH);
    if (!(messageId && promptId && retainedPromptIds.has(promptId))) {
      continue;
    }
    const current = promptIdsByMessage.get(messageId) ?? [];
    current.push(promptId);
    promptIdsByMessage.set(messageId, current);
  }

  const assistantRows = rows.filter(({ role }) => role === 'assistant');
  return assistantRows.map((row, index) => {
    const id = boundedString(row.id, MAX_ID_LENGTH);
    const startMs = timestampMs(row.created);
    const completedMs = timestampMs(row.completed);
    const tokens = tokensFromRow(row);
    if (!(id && startMs !== null && tokens)) {
      throw detailError('readOpenCodeSessionDetail.message', dbPath, 'OpenCode detail contains invalid metrics');
    }
    const endMs = completedMs === null ? startMs : Math.max(startMs, completedMs);
    const effort = boundedString(row.variant);
    const parentId = boundedString(row.parent_id, MAX_ID_LENGTH);
    const parentKind = parentKindFor(parentId, userMessageIds, directUserMessageIds);
    const cost = parseNonNegativeFiniteNumber(row.cost);
    return {
      cost: cost.ok ? cost.value : null,
      costKind: cost.ok ? 'reported' : 'unknown',
      endMs,
      parentId,
      parentKind,
      startMs,
      turn: {
        durationMs: endMs - startMs,
        effort,
        effortKind: effort ? 'recorded' : 'unavailable',
        endAt: timestamp(endMs),
        index,
        intervals: [{ endAt: timestamp(endMs), startAt: timestamp(startMs) }],
        model: modelLabel(row),
        promptIds: parentKind === 'human' && parentId !== null ? (promptIdsByMessage.get(parentId) ?? []) : [],
        startAt: timestamp(startMs),
        tokens,
        tools: toolsByMessageId.get(id) ?? 0,
      },
    };
  });
};

const dominantTurnValue = <Value extends string | null>(
  turns: readonly ParsedOpenCodeTurn[],
  select: (turn: SessionDetailTurn) => Value,
): Value => {
  const first = turns[0];
  if (!first) {
    throw new Error('Cannot summarize an empty OpenCode turn group');
  }
  const weights = new Map<Value, number>();
  for (const { turn } of turns) {
    const value = select(turn);
    weights.set(value, (weights.get(value) ?? 0) + turn.tokens.total);
  }
  let dominant = select(first.turn);
  let dominantWeight = weights.get(dominant) ?? 0;
  for (const [value, weight] of weights) {
    if (weight > dominantWeight) {
      dominant = value;
      dominantWeight = weight;
    }
  }
  return dominant;
};

const groupedTurnsFromMessages = (messages: readonly ParsedOpenCodeTurn[], dbPath: string): SessionDetailTurn[] => {
  const groups = new Map<string, ParsedOpenCodeTurn[]>();
  for (const message of messages) {
    if (message.parentKind === 'internal') {
      continue;
    }
    const key = message.parentKind === 'human' ? `parent:${message.parentId}` : `message:${message.turn.index}`;
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  if (groups.size > MAX_TURNS) {
    throw detailError('readOpenCodeSessionDetail.turnLimit', dbPath, 'OpenCode session exceeds its turn limit');
  }

  return [...groups.values()].map((group, index) => {
    let tokens: SessionDetailTokenCounts = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 };
    let tools = 0;
    const promptIds = new Set<string>();
    for (const { turn } of group) {
      const nextTokens = addTokens(tokens, turn.tokens);
      const nextTools = addNonNegativeSafeIntegers(tools, turn.tools);
      if (!(nextTokens && nextTools.ok)) {
        throw detailError('readOpenCodeSessionDetail.turnMetrics', dbPath, 'OpenCode turn metrics overflow');
      }
      tokens = nextTokens;
      tools = nextTools.value;
      for (const promptId of turn.promptIds) {
        promptIds.add(promptId);
      }
    }
    const effort = dominantTurnValue(group, (turn) => turn.effort);
    const startMs = Math.min(...group.map(({ startMs: value }) => value));
    const endMs = Math.max(...group.map(({ endMs: value }) => value));
    const intervals = mergedActivityIntervals(group);
    return {
      durationMs: activeDuration(group),
      effort,
      effortKind: effort ? 'recorded' : 'unavailable',
      endAt: timestamp(endMs),
      index,
      intervals: intervals.map(({ endMs: intervalEnd, startMs: intervalStart }) => ({
        endAt: timestamp(intervalEnd),
        startAt: timestamp(intervalStart),
      })),
      model: dominantTurnValue(group, (turn) => turn.model),
      promptIds: [...promptIds],
      startAt: timestamp(startMs),
      tokens,
      tools,
    };
  });
};

const phasesFromTurns = (turns: readonly ParsedOpenCodeTurn[], dbPath: string): SessionDetailPhase[] => {
  const phases: SessionDetailPhase[] = [];
  for (const current of turns) {
    const { turn } = current;
    const previous = phases.at(-1);
    if (previous && previous.model === turn.model && previous.effort === turn.effort) {
      const tokens = addTokens(previous.tokens, turn.tokens);
      if (!tokens) {
        throw detailError('readOpenCodeSessionDetail.phaseTokens', dbPath, 'OpenCode phase tokens overflow');
      }
      const cost =
        previous.cost === null || current.cost === null
          ? null
          : addNonNegativeFiniteNumbers(previous.cost, current.cost);
      previous.cost = cost?.ok ? cost.value : null;
      previous.costKind = previous.cost === null ? 'unknown' : 'reported';
      previous.endAt = timestamp(Math.max(Date.parse(previous.endAt), current.endMs));
      previous.tokens = tokens;
      continue;
    }
    if (phases.length >= MAX_PHASES) {
      throw detailError('readOpenCodeSessionDetail.phaseLimit', dbPath, 'OpenCode session exceeds its phase limit');
    }
    phases.push({
      cost: current.cost,
      costKind: current.costKind,
      effort: turn.effort,
      effortKind: turn.effortKind,
      endAt: turn.endAt,
      model: turn.model,
      startAt: turn.startAt,
      tokens: { ...turn.tokens },
    });
  }
  return phases;
};

const detailFromDatabase = (
  dbPath: string,
  sourceSessionId: string,
  storage: LocalHistoryStorageService,
): Effect.Effect<SessionDetail | null, LocalHistoryError> =>
  Effect.acquireUseRelease(
    storage.openDatabase(dbPath),
    (db) =>
      Effect.gen(function* () {
        const sessionRows = yield* db.all<OpenCodeDetailSessionRow>(OPENCODE_DETAIL_SESSION_SQL, [sourceSessionId, 2]);
        const sessionRow = sessionRows[0];
        if (!sessionRow || sessionRows.length > 1) {
          return null;
        }
        const messageRows = yield* db.all<OpenCodeDetailMessageRow>(OPENCODE_DETAIL_MESSAGE_SQL, [
          sourceSessionId,
          MAX_MESSAGE_ROWS + 1,
        ]);
        if (messageRows.length > MAX_MESSAGE_ROWS) {
          return yield* Effect.fail(
            detailError('readOpenCodeSessionDetail.messageLimit', dbPath, 'OpenCode session exceeds its message limit'),
          );
        }
        const promptRows = yield* db.all<OpenCodeDetailPromptRow>(OPENCODE_DETAIL_PROMPT_SQL, [
          sourceSessionId,
          sourceSessionId,
          MAX_PROMPT_ROWS + 1,
        ]);
        const parentRows = yield* db.all<OpenCodeDetailParentRow>(OPENCODE_DETAIL_PARENT_SQL, [
          sourceSessionId,
          sourceSessionId,
          MAX_TURNS + 1,
        ]);
        if (parentRows.length > MAX_TURNS) {
          return yield* Effect.fail(
            detailError('readOpenCodeSessionDetail.parentLimit', dbPath, 'OpenCode session exceeds its turn limit'),
          );
        }
        const toolRows = yield* db.all<OpenCodeDetailToolRow>(OPENCODE_DETAIL_TOOL_SQL, [
          sourceSessionId,
          MAX_TOOL_GROUPS + 1,
        ]);
        if (toolRows.length > MAX_TOOL_GROUPS) {
          return yield* Effect.fail(
            detailError('readOpenCodeSessionDetail.toolLimit', dbPath, 'OpenCode session exceeds its tool-group limit'),
          );
        }

        const toolsByMessageId = new Map<string, number>();
        for (const row of toolRows) {
          const messageId = boundedString(row.message_id, MAX_ID_LENGTH);
          const count = parseOptionalNonNegativeSafeInteger(row.tool_count);
          if (messageId && count.ok) {
            toolsByMessageId.set(messageId, count.value);
          }
        }
        const { prompts, promptsTruncated } = promptsFromRows(promptRows);
        const directUserMessageIds = new Set(
          parentRows.flatMap((row) => {
            const messageId = boundedString(row.message_id, MAX_ID_LENGTH);
            return messageId ? [messageId] : [];
          }),
        );
        const parsedTurns = turnsFromRows(
          messageRows,
          prompts,
          promptRows,
          directUserMessageIds,
          toolsByMessageId,
          dbPath,
        );
        const phases = phasesFromTurns(parsedTurns, dbPath);

        const messageTimes = messageRows.flatMap((row) => {
          const created = timestampMs(row.created);
          const completed = timestampMs(row.completed);
          return [created, completed].filter((value): value is number => value !== null);
        });
        const promptTimes = prompts.map(({ timestamp: value }) => Date.parse(value));
        const fallbackStart = timestampMs(sessionRow.time_created);
        const fallbackEnd = timestampMs(sessionRow.time_updated);
        const observedTimes = [...messageTimes, ...promptTimes];
        const startMs = observedTimes.length > 0 ? Math.min(...observedTimes) : fallbackStart;
        const endMs = observedTimes.length > 0 ? Math.max(...observedTimes) : (fallbackEnd ?? fallbackStart);
        if (startMs === null || endMs === null) {
          return null;
        }
        const boundedEndMs = Math.max(startMs, endMs);
        const elapsedDurationMs = boundedEndMs - startMs;
        const activeDurationMs = Math.min(elapsedDurationMs, activeDuration(parsedTurns));
        const missingCompletion = messageRows.some((row) => {
          if (row.role !== 'assistant') {
            return false;
          }
          const created = timestampMs(row.created);
          const completed = timestampMs(row.completed);
          return created === null || completed === null || completed < created;
        });
        const turns = groupedTurnsFromMessages(parsedTurns, dbPath);
        return {
          activeDurationMs,
          durationStatus: missingCompletion ? 'partial' : 'recorded',
          efforts: [...new Set(parsedTurns.flatMap(({ turn }) => (turn.effort ? [turn.effort] : [])))],
          elapsedDurationMs,
          endedAt: timestamp(boundedEndMs),
          idleDurationMs: elapsedDurationMs - activeDurationMs,
          models: [...new Set(parsedTurns.map(({ turn }) => turn.model))],
          observedAt: new Date().toISOString(),
          phases,
          prompts,
          promptsTruncated,
          sourceSessionId,
          startedAt: timestamp(startMs),
          turns,
          turnsStatus: parsedTurns.some(({ parentKind }) => parentKind === 'unresolved') ? 'partial' : 'recorded',
        } satisfies SessionDetail;
      }),
    (db) => db.close,
  );

export const readOpenCodeSessionDetail = (
  sourceSessionId: string,
): Effect.Effect<SessionDetail | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!(sourceSessionId.length > 0 && sourceSessionId.length <= MAX_ID_LENGTH && !sourceSessionId.includes('\0'))) {
      return null;
    }
    const storage = yield* LocalHistoryStorage;
    const candidates = resolvePathCandidates(storage).opencode;
    const paths = [...new Set([...candidates.liveDb, ...candidates.stableDb])];
    let firstError: LocalHistoryError | null = null;
    for (const dbPath of paths) {
      const exists = yield* storage.exists(dbPath).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!exists) {
        continue;
      }
      const result = yield* detailFromDatabase(dbPath, sourceSessionId, storage).pipe(Effect.either);
      if (result._tag === 'Right' && result.right) {
        return result.right;
      }
      if (result._tag === 'Left') {
        firstError = firstError ?? result.left;
      }
    }
    if (firstError) {
      return yield* Effect.fail(firstError);
    }
    return null;
  });
