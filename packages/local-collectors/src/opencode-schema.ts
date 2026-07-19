export const OPENCODE_DIRECT_USER_PART_PREDICATE = `(json_extract(p.data, '$.type') = 'file' OR (json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0))`;
