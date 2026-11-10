import { LocalHistoryError } from './errors';

export const OPENCODE_DIRECT_USER_PART_PREDICATE = `(json_extract(p.data, '$.type') = 'file' OR (json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0))`;

export const OPENCODE_TOOL_PART_PREDICATE = `json_valid(data) AND json_extract(data, '$.type') = 'tool'`;

/**
 * A narrowing of `OPENCODE_TOOL_PART_PREDICATE`, not a second read: skill
 * invocations are the subset of tool parts whose `tool` is `skill`. OpenCode
 * declares them as first-class tool calls, so observations selected here are
 * `declared` tier (ADR 0022).
 */
export const OPENCODE_SKILL_PART_PREDICATE = `${OPENCODE_TOOL_PART_PREDICATE} AND json_extract(data, '$.tool') = 'skill'`;

/**
 * The `session_v2` storage keeps a message's parts inside `session_message.data.content`
 * (an array of `reasoning`, `text` and `tool` items) rather than in a part table;
 * `session_part` exists but stays empty. These predicates expect the message row
 * aliased `sm` joined to `json_each(sm.data, '$.content') c`. The `json_valid`
 * and `json_type` guards on `sm` are evaluated before `json_each` runs for the
 * row, so a malformed payload is skipped instead of failing the statement, and
 * the `c.type` guard skips a non-object item, on which `json_extract` would
 * raise and take the whole read down.
 */
export const OPENCODE_V2_ASSISTANT_CONTENT_PREDICATE = `sm.type = 'assistant' AND json_valid(sm.data) AND json_type(sm.data, '$.content') = 'array'`;

export const OPENCODE_V2_TOOL_CONTENT_PREDICATE = `${OPENCODE_V2_ASSISTANT_CONTENT_PREDICATE} AND c.type = 'object' AND json_extract(c.value, '$.type') = 'tool'`;

/** The v2 counterpart of `OPENCODE_SKILL_PART_PREDICATE`: a tool item names its tool in `name`. */
export const OPENCODE_V2_SKILL_CONTENT_PREDICATE = `${OPENCODE_V2_TOOL_CONTENT_PREDICATE} AND json_extract(c.value, '$.name') = 'skill'`;

/**
 * OpenCode has stored sessions in two schemas. The legacy one keeps sessions in
 * `session`, messages in `message` and their parts in `part`. The current one
 * (OpenCode's `session_v2` migration) keeps sessions in `session_v2` and
 * messages in `session_message`, whose `type` column carries the role. A
 * migrated database holds both: every legacy session also exists in
 * `session_v2`, and a session's messages may be split between `message` and
 * `session_message`. Readers therefore list the tables first and deduplicate by
 * session id for metadata (the current row describes the session as it is now)
 * and by message id for usage, where the legacy copy wins: the migration copied
 * every message with its tokens intact but stamped `time.completed` with the
 * migration instant, so the `session_message` copy of a legacy message carries
 * the wrong end time, duration and pricing date.
 */
export const OPENCODE_SCHEMA_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";

export type OpenCodeSchemaKind = 'legacy' | 'v2';

/**
 * The schemas a database holds, in read order: legacy first, so that a message
 * present in both tables is taken from its original record and its migrated
 * copy is skipped by message id.
 */
export const openCodeSchemaKinds = (tables: ReadonlySet<string>): OpenCodeSchemaKind[] => {
  const kinds: OpenCodeSchemaKind[] = [];
  if (tables.has('session') && tables.has('message') && tables.has('part')) {
    kinds.push('legacy');
  }
  if (tables.has('session_v2') && tables.has('session_message')) {
    kinds.push('v2');
  }
  return kinds;
};

export const openCodeSchemaError = (dbPath: string, tables: ReadonlySet<string>): LocalHistoryError =>
  new LocalHistoryError({
    operation: 'opencode.schema',
    path: dbPath,
    cause: new Error(
      `No known OpenCode session schema: expected the tables session, message and part (legacy) or session_v2 and session_message (current); found ${[...tables].sort().join(', ') || 'no table'}`,
    ),
  });

/**
 * The usage metrics of one assistant message, projected out of its JSON payload
 * in SQL so a read never loads the message body, tool state or reasoning. Both
 * schemas are covered: the legacy payload carries `providerID`/`modelID`/`variant`
 * at the top level, the current one nests them under `model`. The row's
 * `time_created` stands in when the payload has no `time.created`. Decode the
 * columns with `decodeOpenCodeMessageColumns`.
 */
export const OPENCODE_MESSAGE_METRIC_COLUMNS = [
  "coalesce(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS provider_id",
  "coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.id')) AS model_id",
  "coalesce(json_extract(data, '$.variant'), json_extract(data, '$.model.variant')) AS variant",
  "coalesce(json_extract(data, '$.time.created'), time_created) AS created",
  "json_extract(data, '$.time.completed') AS completed",
  "json_extract(data, '$.tokens.input') AS token_input",
  "json_extract(data, '$.tokens.output') AS token_output",
  "json_extract(data, '$.tokens.reasoning') AS token_reasoning",
  "json_extract(data, '$.tokens.cache.read') AS token_cache_read",
  "json_extract(data, '$.tokens.cache.write') AS token_cache_write",
  "json_type(data, '$.tokens') AS tokens_type",
  "json_extract(data, '$.cost') AS cost",
].join(', ');
