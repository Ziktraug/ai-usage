export const OPENCODE_DIRECT_USER_PART_PREDICATE = `(json_extract(p.data, '$.type') = 'file' OR (json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0))`;

export const OPENCODE_TOOL_PART_PREDICATE = `json_valid(data) AND json_extract(data, '$.type') = 'tool'`;

/**
 * A narrowing of `OPENCODE_TOOL_PART_PREDICATE`, not a second read: skill
 * invocations are the subset of tool parts whose `tool` is `skill`. OpenCode
 * declares them as first-class tool calls, so observations selected here are
 * `declared` tier (ADR 0022).
 */
export const OPENCODE_SKILL_PART_PREDICATE = `${OPENCODE_TOOL_PART_PREDICATE} AND json_extract(data, '$.tool') = 'skill'`;
