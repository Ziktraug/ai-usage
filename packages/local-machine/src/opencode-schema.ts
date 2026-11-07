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
 * row, so a malformed payload is skipped instead of failing the statement.
 */
export const OPENCODE_V2_ASSISTANT_CONTENT_PREDICATE = `sm.type = 'assistant' AND json_valid(sm.data) AND json_type(sm.data, '$.content') = 'array'`;

export const OPENCODE_V2_TOOL_CONTENT_PREDICATE = `${OPENCODE_V2_ASSISTANT_CONTENT_PREDICATE} AND json_extract(c.value, '$.type') = 'tool'`;

/** The v2 counterpart of `OPENCODE_SKILL_PART_PREDICATE`: a tool item names its tool in `name`. */
export const OPENCODE_V2_SKILL_CONTENT_PREDICATE = `${OPENCODE_V2_TOOL_CONTENT_PREDICATE} AND json_extract(c.value, '$.name') = 'skill'`;
