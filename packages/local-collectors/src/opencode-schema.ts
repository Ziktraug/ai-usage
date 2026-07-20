export const OPENCODE_DIRECT_USER_PART_PREDICATE = `(json_extract(p.data, '$.type') = 'file' OR (json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0))`;

export const OPENCODE_TOOL_PART_PREDICATE = `json_valid(data) AND json_extract(data, '$.type') = 'tool'`;
