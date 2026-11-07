import {
  completeCoverage,
  type LocalSessionAnalysis,
  type SessionDetail,
  type SessionDetailChildLink,
  type SessionDetailPhase,
  type SessionDetailPrompt,
  type SessionDetailTokenCounts,
  type SessionDetailTurn,
} from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import {
  addNonNegativeFiniteNumbers,
  addNonNegativeSafeIntegers,
  parseFiniteTimestamp,
  parseOptionalNonNegativeSafeInteger,
} from './metric-validation';
import {
  OPENCODE_DIRECT_USER_PART_PREDICATE,
  OPENCODE_MESSAGE_METRIC_COLUMNS,
  OPENCODE_SCHEMA_SQL,
  OPENCODE_TOOL_PART_PREDICATE,
  OPENCODE_V2_TOOL_CONTENT_PREDICATE,
  type OpenCodeSchemaKind,
  openCodeSchemaError,
  openCodeSchemaKinds,
} from './opencode-schema';
import {
  buildOpenCodeProjectionSummary,
  decodeOpenCodeMessageColumns,
  mergeOpenCodeActivityIntervals,
  type OpenCodeMessageColumnRow,
  type OpenCodeParentKind,
  openCodeActivityDuration,
  openCodeParentKind,
} from './opencode-session-facts';
import { resolvePathCandidates } from './platform-paths';

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const MAX_MESSAGE_ROWS = 2048;
const MAX_PHASES = 256;
const MAX_PROMPT_BYTES = 32 * 1024;
// Prompt identities share the turn budget; bodies stay bounded by bytes.
const MAX_PROMPT_ROWS = 1024;
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
  ${OPENCODE_MESSAGE_METRIC_COLUMNS}
FROM message
WHERE session_id = ? AND json_valid(data)
ORDER BY time_created, id
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
export const OPENCODE_DETAIL_CHILDREN_SQL = `
SELECT id, title
FROM session
WHERE parent_id = ?
ORDER BY time_created, id
LIMIT ?`;
export const OPENCODE_DETAIL_TOOL_SQL = `
SELECT message_id, count(*) AS tool_count
FROM part
WHERE session_id = ? AND ${OPENCODE_TOOL_PART_PREDICATE}
GROUP BY message_id
ORDER BY message_id
LIMIT ?`;

/**
 * The `session_v2` counterparts. The role is the row's `type`; there is no
 * parent message id, so an assistant message is attributed to the prompt that
 * precedes it in sequence once both schemas' rows are merged. A prompt is the
 * user row itself (its text is in the payload, not in a part), so its id is
 * the message id. Synthetic and system inputs carry their own `type`, which
 * makes every `user` row a direct prompt.
 */
export const OPENCODE_DETAIL_V2_SESSION_SQL =
  'SELECT id, time_created, time_updated FROM session_v2 WHERE id = ? LIMIT ?';
export const OPENCODE_DETAIL_V2_MESSAGE_SQL = `
SELECT
  id,
  type AS role,
  NULL AS parent_id,
  ${OPENCODE_MESSAGE_METRIC_COLUMNS}
FROM session_message
WHERE session_id = ? AND type IN ('user', 'assistant') AND json_valid(data)
ORDER BY seq, time_created, id
LIMIT ?`;
export const OPENCODE_DETAIL_V2_PROMPT_SQL = `
SELECT
  id,
  id AS message_id,
  COALESCE(json_extract(data, '$.time.created'), time_created) AS created,
  substr(json_extract(data, '$.text'), 1, 32769) AS text,
  length(json_extract(data, '$.text')) AS text_length
FROM session_message
WHERE session_id = ? AND type = 'user' AND json_valid(data)
ORDER BY seq, time_created, id
LIMIT ?`;
export const OPENCODE_DETAIL_V2_CHILDREN_SQL = `
SELECT id, title
FROM session_v2
WHERE parent_id = ?
ORDER BY time_created, id
LIMIT ?`;
export const OPENCODE_DETAIL_V2_TOOL_SQL = `
SELECT sm.id AS message_id, count(*) AS tool_count
FROM session_message sm, json_each(sm.data, '$.content') c
WHERE sm.session_id = ? AND ${OPENCODE_V2_TOOL_CONTENT_PREDICATE}
GROUP BY sm.id
ORDER BY sm.id
LIMIT ?`;

interface OpenCodeDetailMessageRow extends OpenCodeMessageColumnRow {
  id: unknown;
  parent_id: unknown;
}

/** A message row with the schema it was read from; only current-schema rows get a sequence-derived parent. */
interface OpenCodeMergedMessageRow extends OpenCodeDetailMessageRow {
  schema: OpenCodeSchemaKind;
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

interface OpenCodeDetailChildRow {
  id: unknown;
  title: unknown;
}

const MAX_CHILD_ROWS = 512;

interface ParsedOpenCodeTurn {
  cost: number | null;
  costKind: 'reported' | 'unknown';
  endMs: number;
  parentId: string | null;
  parentKind: OpenCodeParentKind;
  startMs: number;
  turn: SessionDetailTurn;
}

interface BoundedPromptText {
  text: string;
  truncated: boolean;
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

interface OpenCodePromptFacts {
  bodiesOmitted: number;
  identitiesOmitted: number;
  prompts: SessionDetailPrompt[];
  promptsTruncated: boolean;
}

const promptsFromRows = (rows: readonly OpenCodeDetailPromptRow[]): OpenCodePromptFacts => {
  const prompts: SessionDetailPrompt[] = [];
  let remainingBytes = MAX_PROMPT_TOTAL_BYTES;
  let identitiesOmitted = Math.max(0, rows.length - MAX_PROMPT_ROWS);
  let bodiesOmitted = 0;
  let promptsTruncated = identitiesOmitted > 0;
  for (const row of rows.slice(0, MAX_PROMPT_ROWS)) {
    const id = boundedString(row.id, MAX_ID_LENGTH);
    const created = timestampMs(row.created);
    if (!(id && created !== null && typeof row.text === 'string' && row.text.length > 0)) {
      promptsTruncated = true;
      identitiesOmitted += 1;
      continue;
    }
    // Past the body budget the identity is still kept, with an empty body, so
    // the assistant messages under it keep grouping as a prompt-led round.
    const bounded =
      remainingBytes > 0
        ? boundedPromptText(row.text, Math.min(MAX_PROMPT_BYTES, remainingBytes))
        : { text: '', truncated: true };
    const sourceLength = parseOptionalNonNegativeSafeInteger(row.text_length);
    const sqlTruncated = sourceLength.ok && sourceLength.value > row.text.length;
    const prompt: SessionDetailPrompt = {
      id,
      text: bounded.text,
      timestamp: timestamp(created),
      truncated: bounded.text ? bounded.truncated || sqlTruncated : true,
    };
    if (!bounded.text) {
      bodiesOmitted += 1;
    }
    prompts.push(prompt);
    remainingBytes -= TEXT_ENCODER.encode(prompt.text).byteLength;
    promptsTruncated = promptsTruncated || prompt.truncated;
  }
  return { bodiesOmitted, identitiesOmitted, prompts, promptsTruncated };
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
    const current = promptIdsByMessage.getOrInsertComputed(messageId, () => []);
    current.push(promptId);
  }

  const turns: ParsedOpenCodeTurn[] = [];
  for (const row of rows) {
    if (row.role !== 'assistant') {
      continue;
    }
    const decoded = decodeOpenCodeMessageColumns(row);
    if (decoded.kind === 'ignored') {
      continue;
    }
    if (decoded.kind === 'invalid') {
      throw detailError('readOpenCodeSessionAnalysis.message', dbPath, 'OpenCode detail contains invalid metrics');
    }
    const fact = decoded.value;
    if (!(fact.id && fact.createdMs !== null)) {
      throw detailError('readOpenCodeSessionAnalysis.message', dbPath, 'OpenCode detail contains invalid metrics');
    }
    const { id, createdMs: startMs } = fact;
    const recordedEndMs = fact.completedMs !== null && fact.completedMs >= startMs ? fact.completedMs : null;
    const hasRecordedTiming = recordedEndMs !== null;
    const endMs = recordedEndMs ?? startMs;
    const parentId = fact.parentId;
    const parentKind = openCodeParentKind(parentId, userMessageIds, directUserMessageIds);
    turns.push({
      cost: fact.reportedCostKnown ? fact.cost : null,
      costKind: fact.reportedCostKnown ? 'reported' : 'unknown',
      endMs,
      parentId,
      parentKind,
      startMs,
      turn: {
        calls: 1,
        cost: fact.reportedCostKnown ? fact.cost : null,
        costKind: fact.reportedCostKnown ? 'reported' : 'unknown',
        durationMs: hasRecordedTiming ? endMs - startMs : null,
        effort: fact.effort,
        effortKind: fact.effort ? 'recorded' : 'unavailable',
        endAt: timestamp(endMs),
        index: turns.length,
        intervals: hasRecordedTiming ? [{ endAt: timestamp(endMs), startAt: timestamp(startMs) }] : [],
        model: fact.model,
        promptIds: parentKind === 'human' && parentId !== null ? (promptIdsByMessage.get(parentId) ?? []) : [],
        startAt: timestamp(startMs),
        timingStatus: hasRecordedTiming ? 'recorded' : 'unavailable',
        tokens: fact.tokens,
        tools: toolsByMessageId.get(id) ?? 0,
      },
    });
  }
  return turns;
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
    const key = message.parentKind === 'unresolved' ? `message:${message.turn.index}` : `parent:${message.parentId}`;
    const group = groups.getOrInsertComputed(key, () => []);
    group.push(message);
  }
  if (groups.size > MAX_TURNS) {
    throw detailError('readOpenCodeSessionAnalysis.turnLimit', dbPath, 'OpenCode session exceeds its turn limit');
  }

  return [...groups.values()].map((group, index) => {
    let tokens: SessionDetailTokenCounts = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 };
    let tools = 0;
    const promptIds = new Set<string>();
    for (const { turn } of group) {
      const nextTokens = addTokens(tokens, turn.tokens);
      const nextTools = addNonNegativeSafeIntegers(tools, turn.tools);
      if (!(nextTokens && nextTools.ok)) {
        throw detailError('readOpenCodeSessionAnalysis.turnMetrics', dbPath, 'OpenCode turn metrics overflow');
      }
      tokens = nextTokens;
      tools = nextTools.value;
      for (const promptId of turn.promptIds) {
        promptIds.add(promptId);
      }
    }
    const effort = dominantTurnValue(group, (turn) => turn.effort);
    let cost: number | null = 0;
    for (const message of group) {
      if (cost === null || message.cost === null) {
        cost = null;
        break;
      }
      const next = addNonNegativeFiniteNumbers(cost, message.cost);
      cost = next.ok ? next.value : null;
    }
    const startMs = Math.min(...group.map(({ startMs: value }) => value));
    const endMs = Math.max(...group.map(({ endMs: value }) => value));
    const timedGroup = group.filter(({ turn }) => turn.timingStatus === 'recorded');
    const intervals = mergeOpenCodeActivityIntervals(timedGroup);
    const timingStatus = intervals.length > 0 ? 'recorded' : 'unavailable';
    return {
      calls: group.length,
      cost,
      costKind: cost === null ? 'unknown' : 'reported',
      durationMs: timingStatus === 'recorded' ? openCodeActivityDuration(timedGroup) : null,
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
      timingStatus,
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
        throw detailError('readOpenCodeSessionAnalysis.phaseTokens', dbPath, 'OpenCode phase tokens overflow');
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
      throw detailError('readOpenCodeSessionAnalysis.phaseLimit', dbPath, 'OpenCode session exceeds its phase limit');
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

interface OpenCodeDetailQuerySet {
  childrenSql: string;
  messageSql: string;
  promptParameters: (sourceSessionId: string, limit: number) => Array<string | number>;
  promptSql: string;
  sessionSql: string;
  toolSql: string;
}

const OPENCODE_DETAIL_QUERIES: Record<OpenCodeSchemaKind, OpenCodeDetailQuerySet> = {
  legacy: {
    childrenSql: OPENCODE_DETAIL_CHILDREN_SQL,
    messageSql: OPENCODE_DETAIL_MESSAGE_SQL,
    promptParameters: (sourceSessionId, limit) => [sourceSessionId, sourceSessionId, limit],
    promptSql: OPENCODE_DETAIL_PROMPT_SQL,
    sessionSql: OPENCODE_DETAIL_SESSION_SQL,
    toolSql: OPENCODE_DETAIL_TOOL_SQL,
  },
  v2: {
    childrenSql: OPENCODE_DETAIL_V2_CHILDREN_SQL,
    messageSql: OPENCODE_DETAIL_V2_MESSAGE_SQL,
    promptParameters: (sourceSessionId, limit) => [sourceSessionId, limit],
    promptSql: OPENCODE_DETAIL_V2_PROMPT_SQL,
    sessionSql: OPENCODE_DETAIL_V2_SESSION_SQL,
    toolSql: OPENCODE_DETAIL_V2_TOOL_SQL,
  },
};

interface OpenCodeDetailRows {
  childRows: OpenCodeDetailChildRow[];
  childrenOmitted: boolean;
  directUserMessageIds: Set<string>;
  messageRows: OpenCodeDetailMessageRow[];
  promptRows: OpenCodeDetailPromptRow[];
  sessionRow: OpenCodeDetailSessionRow;
  toolRows: OpenCodeDetailToolRow[];
}

const compareByCreated = (left: { created: unknown }, right: { created: unknown }): number =>
  (timestampMs(left.created) ?? Number.MAX_SAFE_INTEGER) - (timestampMs(right.created) ?? Number.MAX_SAFE_INTEGER);

/**
 * Read one session from every schema the database holds, current schema first.
 * A message found in the current schema is skipped in the legacy tables, since
 * the legacy copy is its pre-migration form; a session's rows may be split
 * between the two, so the merge is by message id, not by session.
 */
const readOpenCodeDetailRows = (
  db: Awaited<
    ReturnType<LocalHistoryStorageService['openDatabase']> extends Effect.Effect<infer Db, unknown, unknown>
      ? Db
      : never
  >,
  dbPath: string,
  sourceSessionId: string,
): Effect.Effect<OpenCodeDetailRows | null, LocalHistoryError> =>
  Effect.gen(function* () {
    const schemaRows = yield* db.all<{ name: unknown }>(OPENCODE_SCHEMA_SQL);
    const tables = new Set(schemaRows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])));
    const kinds = openCodeSchemaKinds(tables);
    if (kinds.length === 0) {
      return yield* Effect.fail(openCodeSchemaError(dbPath, tables));
    }

    let sessionRow: OpenCodeDetailSessionRow | null = null;
    const mergedRows: OpenCodeMergedMessageRow[] = [];
    const promptRows: OpenCodeDetailPromptRow[] = [];
    const directUserMessageIds = new Set<string>();
    const toolRows: OpenCodeDetailToolRow[] = [];
    const childRows: OpenCodeDetailChildRow[] = [];
    let childrenOmitted = false;
    const currentMessageIds = new Set<string>();

    for (const kind of kinds) {
      const queries = OPENCODE_DETAIL_QUERIES[kind];
      const isCurrent = kind === 'v2';
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

      const sessionRows = yield* db.all<OpenCodeDetailSessionRow>(queries.sessionSql, [sourceSessionId, 2]);
      if (sessionRows.length > 1) {
        return null;
      }
      const found = sessionRows[0];
      if (!found) {
        // A schema without the session row holds none of its messages either.
        continue;
      }
      sessionRow ??= found;

      const messageRows = yield* db.all<OpenCodeDetailMessageRow>(queries.messageSql, [
        sourceSessionId,
        MAX_MESSAGE_ROWS + 1,
      ]);
      if (messageRows.length > MAX_MESSAGE_ROWS) {
        return yield* Effect.fail(
          detailError('readOpenCodeSessionAnalysis.messageLimit', dbPath, 'OpenCode session exceeds its message limit'),
        );
      }
      for (const row of messageRows) {
        const messageId = boundedString(row.id, MAX_ID_LENGTH);
        if (!claim(messageId)) {
          continue;
        }
        mergedRows.push({ ...row, schema: kind });
        if (isCurrent && row.role === 'user' && messageId) {
          directUserMessageIds.add(messageId);
        }
      }

      const schemaPromptRows = yield* db.all<OpenCodeDetailPromptRow>(
        queries.promptSql,
        queries.promptParameters(sourceSessionId, MAX_PROMPT_ROWS + 1),
      );
      for (const row of schemaPromptRows) {
        if (claim(boundedString(row.message_id, MAX_ID_LENGTH))) {
          promptRows.push(row);
        }
      }

      if (!isCurrent) {
        const parentRows = yield* db.all<OpenCodeDetailParentRow>(OPENCODE_DETAIL_PARENT_SQL, [
          sourceSessionId,
          sourceSessionId,
          MAX_TURNS + 1,
        ]);
        if (parentRows.length > MAX_TURNS) {
          return yield* Effect.fail(
            detailError('readOpenCodeSessionAnalysis.parentLimit', dbPath, 'OpenCode session exceeds its turn limit'),
          );
        }
        for (const row of parentRows) {
          const messageId = boundedString(row.message_id, MAX_ID_LENGTH);
          if (messageId && claim(messageId)) {
            directUserMessageIds.add(messageId);
          }
        }
      }

      const schemaToolRows = yield* db.all<OpenCodeDetailToolRow>(queries.toolSql, [
        sourceSessionId,
        MAX_TOOL_GROUPS + 1,
      ]);
      if (schemaToolRows.length > MAX_TOOL_GROUPS) {
        return yield* Effect.fail(
          detailError('readOpenCodeSessionAnalysis.toolLimit', dbPath, 'OpenCode session exceeds its tool-group limit'),
        );
      }
      for (const row of schemaToolRows) {
        if (claim(boundedString(row.message_id, MAX_ID_LENGTH))) {
          toolRows.push(row);
        }
      }

      const schemaChildRows = yield* db.all<OpenCodeDetailChildRow>(queries.childrenSql, [
        sourceSessionId,
        MAX_CHILD_ROWS + 1,
      ]);
      childrenOmitted ||= schemaChildRows.length > MAX_CHILD_ROWS;
      childRows.push(...schemaChildRows.slice(0, MAX_CHILD_ROWS));
    }
    if (!sessionRow) {
      return null;
    }
    if (mergedRows.length > MAX_MESSAGE_ROWS) {
      return yield* Effect.fail(
        detailError('readOpenCodeSessionAnalysis.messageLimit', dbPath, 'OpenCode session exceeds its message limit'),
      );
    }
    if (directUserMessageIds.size > MAX_TURNS) {
      return yield* Effect.fail(
        detailError('readOpenCodeSessionAnalysis.parentLimit', dbPath, 'OpenCode session exceeds its turn limit'),
      );
    }

    // Rows from both schemas interleave in time; the current schema records no
    // parent message, so its assistant rows are attributed to the prompt that
    // precedes them in that order.
    mergedRows.sort(compareByCreated);
    promptRows.sort(compareByCreated);
    let lastUserMessageId: string | null = null;
    const messageRows: OpenCodeDetailMessageRow[] = mergedRows.map((row) => {
      const messageId = boundedString(row.id, MAX_ID_LENGTH);
      if (row.role === 'user') {
        lastUserMessageId = messageId ?? lastUserMessageId;
        return row;
      }
      if (row.schema === 'v2' && row.role === 'assistant' && row.parent_id === null) {
        return { ...row, parent_id: lastUserMessageId };
      }
      return row;
    });
    return { childRows, childrenOmitted, directUserMessageIds, messageRows, promptRows, sessionRow, toolRows };
  });

const detailFromDatabase = (
  dbPath: string,
  sourceSessionId: string,
  storage: LocalHistoryStorageService,
): Effect.Effect<LocalSessionAnalysis | null, LocalHistoryError> =>
  Effect.acquireUseRelease(
    storage.openDatabase(dbPath),
    (db) =>
      Effect.gen(function* () {
        const read = yield* readOpenCodeDetailRows(db, dbPath, sourceSessionId);
        if (!read) {
          return null;
        }
        const { childRows, childrenOmitted, directUserMessageIds, messageRows, promptRows, sessionRow, toolRows } =
          read;
        const children: SessionDetailChildLink[] = [];
        for (const row of childRows) {
          const id = boundedString(row.id, MAX_ID_LENGTH);
          if (id && id !== sourceSessionId && !children.some((child) => child.sourceSessionId === id)) {
            children.push({
              agentType: null,
              evidence: 'opencode-session-parent',
              label: boundedString(row.title),
              sourceSessionId: id,
              spawnTurnIndex: null,
            });
          }
        }

        const toolsByMessageId = new Map<string, number>();
        let projectionTools = 0;
        for (const row of toolRows) {
          const messageId = boundedString(row.message_id, MAX_ID_LENGTH);
          const count = parseOptionalNonNegativeSafeInteger(row.tool_count);
          if (messageId && count.ok) {
            toolsByMessageId.set(messageId, count.value);
            const nextTools = addNonNegativeSafeIntegers(projectionTools, count.value);
            if (!nextTools.ok) {
              return yield* Effect.fail(
                detailError('readOpenCodeSessionAnalysis.toolMetrics', dbPath, 'OpenCode tool metrics overflow'),
              );
            }
            projectionTools = nextTools.value;
          }
        }
        const { bodiesOmitted, identitiesOmitted, prompts, promptsTruncated } = promptsFromRows(promptRows);
        const parsedTurns = turnsFromRows(
          messageRows,
          prompts,
          promptRows,
          directUserMessageIds,
          toolsByMessageId,
          dbPath,
        );
        const phases = phasesFromTurns(parsedTurns, dbPath);
        const messageFacts = messageRows.flatMap((row) => {
          const decoded = decodeOpenCodeMessageColumns(row);
          return decoded.kind === 'fact' ? [decoded.value] : [];
        });
        const projectionSummary = buildOpenCodeProjectionSummary(messageFacts);
        if (!projectionSummary) {
          return null;
        }

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
        const activeDurationMs = Math.min(elapsedDurationMs, openCodeActivityDuration(parsedTurns));
        const missingCompletion = messageRows.some((row) => {
          const decoded = decodeOpenCodeMessageColumns(row);
          if (decoded.kind !== 'fact') {
            return false;
          }
          const { completedMs: completed, createdMs: created } = decoded.value;
          return created === null || completed === null || completed < created;
        });
        const turns = groupedTurnsFromMessages(parsedTurns, dbPath);
        const unresolvedTurns = parsedTurns.filter(({ parentKind }) => parentKind === 'unresolved').length;
        const detail = {
          activeDurationMs,
          children,
          coverage: {
            childDiscovery:
              children.length === 0 && !childrenOmitted
                ? completeCoverage()
                : {
                    omittedCount: childrenOmitted ? null : 0,
                    reasons: childrenOmitted
                      ? ['harness-no-spawn-evidence', 'child-budget']
                      : ['harness-no-spawn-evidence'],
                    status: 'partial',
                  },
            grouping:
              unresolvedTurns > 0
                ? { omittedCount: unresolvedTurns, reasons: ['unattributed-activity'], status: 'partial' }
                : completeCoverage(),
            // OpenCode links a child session to its parent session, never to the message that opened it.
            interactionAttribution: {
              omittedCount: null,
              reasons: ['harness-no-spawn-evidence'],
              status: 'unavailable',
            },
            promptBodies: promptsTruncated
              ? {
                  omittedCount: bodiesOmitted + identitiesOmitted,
                  reasons: identitiesOmitted > 0 ? ['prompt-body-budget', 'prompt-budget'] : ['prompt-body-budget'],
                  status: 'partial',
                }
              : completeCoverage(),
            recordedTiming: missingCompletion
              ? { omittedCount: null, reasons: ['timing-not-recorded'], status: 'partial' }
              : completeCoverage(),
          },
          durationStatus: missingCompletion ? 'partial' : 'recorded',
          efforts: [...new Set(parsedTurns.flatMap(({ turn }) => (turn.effort ? [turn.effort] : [])))],
          elapsedDurationMs,
          endedAt: timestamp(boundedEndMs),
          idleDurationMs: elapsedDurationMs - activeDurationMs,
          interactions: [],
          models: [...new Set(parsedTurns.map(({ turn }) => turn.model))],
          observedAt: new Date().toISOString(),
          phases,
          prompts,
          promptsTruncated,
          sourceSessionId,
          startedAt: timestamp(startMs),
          turns,
          turnsStatus: parsedTurns.some(({ parentKind }) => parentKind !== 'human') ? 'partial' : 'recorded',
        } satisfies SessionDetail;
        return {
          detail,
          projection: {
            calls: projectionSummary.calls,
            durationMs: projectionSummary.durationMs,
            modelSegments: projectionSummary.modelSegments
              .map((segment) => ({
                model: segment.model,
                tokens: {
                  cacheRead: segment.tokCr,
                  cacheWrite: segment.tokCw,
                  input: segment.tokIn,
                  output: segment.tokOut,
                  total: segment.tokCr + segment.tokCw + segment.tokIn + segment.tokOut,
                },
              }))
              .sort((left, right) => left.model.localeCompare(right.model)),
            partial: projectionSummary.partial,
            tokens: projectionSummary.tokens,
            tools: projectionTools,
            turns: directUserMessageIds.size,
          },
        } satisfies LocalSessionAnalysis;
      }),
    (db) => db.close,
  );

export const readOpenCodeSessionAnalysis = (
  sourceSessionId: string,
): Effect.Effect<LocalSessionAnalysis | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!(sourceSessionId.length > 0 && sourceSessionId.length <= MAX_ID_LENGTH && !sourceSessionId.includes('\0'))) {
      return null;
    }
    const storage = yield* LocalHistoryStorage;
    const candidates = resolvePathCandidates(storage).opencode;
    const paths = [...new Set([...candidates.liveDb, ...candidates.stableDb])];
    let firstError: LocalHistoryError | null = null;
    for (const dbPath of paths) {
      const exists = yield* storage.exists(dbPath).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!exists) {
        continue;
      }
      const result = yield* detailFromDatabase(dbPath, sourceSessionId, storage).pipe(Effect.result);
      if (result._tag === 'Success' && result.success) {
        return result.success;
      }
      if (result._tag === 'Failure') {
        firstError = firstError ?? result.failure;
      }
    }
    if (firstError) {
      return yield* Effect.fail(firstError);
    }
    return null;
  });
