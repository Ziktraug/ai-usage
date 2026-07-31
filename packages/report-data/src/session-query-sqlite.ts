import { type ApiPriceMeasurement, combineApiPriceMeasurements } from '@ai-usage/report-core/provenance';
import {
  parseSessionDetailRequest,
  type SessionDetailAnchorResult,
  type SessionDetailRequest,
  sessionDetailRequestFingerprint,
  sessionDetailSourceAuthorities,
  sessionProjectionFactsForSerializedRow,
} from '@ai-usage/report-core/session-detail';
import type {
  SessionCampaignChildrenRequest,
  SessionCampaignChildrenResult,
  SessionNeighborRequest,
  SessionNeighborResult,
  SessionPageItem,
  SessionPageResult,
  SessionPresentationRow,
  SessionQueryRequest,
  SessionQuerySort,
  SessionSortField,
} from '@ai-usage/report-core/session-query';
import {
  parseSessionCampaignChildrenRequest,
  parseSessionNeighborRequest,
  parseSessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionNeighborFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { parseSessionVcsContext, type SessionVcsContext } from '@ai-usage/report-core/session-vcs';
import { usageRowApiPriceMeasurement } from '@ai-usage/report-core/usage-row';

export type SessionQueryKind = 'campaign-children' | 'neighbors' | 'session-detail-anchor' | 'sessions';

export interface SessionQuerySqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface SessionQuerySqliteDatabase {
  query(sql: string): SessionQuerySqliteStatement;
}

export type SessionQuerySqliteTrace = (query: { params: readonly unknown[]; sql: string }) => void;

const SESSION_QUERY_SCHEMA_VERSION = 16;
const CURSOR_PATTERN = /^sq1\.([0-9a-f]{16})\.([0-9a-z]+)$/;
const CAMPAIGN_EXACT_COST_SORT_FIELDS = new Set<SessionSortField>(['actual', 'cost', 'quota']);
const EMPTY_API_PRICE_MEASUREMENT = {
  knownCost: 0,
  state: 'zero',
  unpricedFreshTokens: 0,
} as const satisfies ApiPriceMeasurement;
const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const withoutSource = (row: Record<string, unknown>): Record<string, unknown> => {
  const { source: _source, ...projectionRow } = row;
  return projectionRow;
};
const SORT_COLUMN_BY_FIELD = {
  actual: 'sort_actual',
  ambiguous: 'sort_ambiguous',
  cache: 'sort_cache',
  calls: 'sort_calls',
  cost: 'sort_cost',
  date: 'sort_date',
  duration: 'sort_duration',
  fresh: 'sort_fresh',
  harness: 'sort_harness_rank',
  lines: 'sort_lines',
  machine: 'sort_machine_rank',
  model: 'sort_model_rank',
  partial: 'sort_partial',
  project: 'sort_project_rank',
  provider: 'sort_provider_rank',
  quota: 'sort_quota',
  rtkSaved: 'sort_rtk_saved',
  session: 'sort_session_rank',
  subagent: 'sort_subagent',
  tokCw: 'sort_tok_cw',
  tokIn: 'sort_tok_in',
  tokOut: 'sort_tok_out',
  tools: 'sort_tools',
  total: 'sort_total',
  turns: 'sort_turns',
} as const satisfies Record<SessionSortField, string>;

interface CountRecord {
  item_count: number;
  session_count: number;
}

interface ItemRecord {
  ambiguous: number | null;
  calls: number | null;
  campaign_key: string | null;
  classifier_count: number | null;
  classifier_fresh_tokens: number | null;
  cost_actual: number | null;
  cost_approx: number | null;
  cost_known: number | null;
  cost_quota: number | null;
  duration_ms: number | null;
  fresh_tokens: number | null;
  item_kind: 'campaign';
  latest_active_date: string | null;
  latest_active_time: number | null;
  line_delta: number | null;
  lines_added: number | null;
  lines_deleted: number | null;
  partial: number | null;
  price_measurement?: ApiPriceMeasurement;
  row_json: string;
  rtk_command_count: number | null;
  rtk_input_tokens: number | null;
  rtk_output_tokens: number | null;
  rtk_saved_tokens: number | null;
  sort_date: number;
  tok_cr: number | null;
  tok_cw: number | null;
  tok_in: number | null;
  tok_out: number | null;
  token_total: number | null;
  tools: number | null;
  total_count: number | null;
  turns: number | null;
  usage_unavailable: number | null;
  visible_count: number | null;
}

interface NeighborRecord {
  next_json: string | null;
  previous_json: string | null;
}

interface SessionDetailAnchorRecord {
  source_authority: string;
  source_row_json: string;
}

interface CampaignCostRecord {
  campaign_key: string;
  cost_actual: number | null;
  cost_approx: number;
  cost_known: number;
  cost_quota: number | null;
  row_json: string;
}

const executeAll = <RecordType>(
  database: SessionQuerySqliteDatabase,
  sql: string,
  params: readonly unknown[],
  trace?: SessionQuerySqliteTrace,
): RecordType[] => {
  trace?.({ params, sql });
  return database.query(sql).all(...params) as RecordType[];
};

const executeGet = <RecordType>(
  database: SessionQuerySqliteDatabase,
  sql: string,
  params: readonly unknown[],
  trace?: SessionQuerySqliteTrace,
): RecordType | null => {
  trace?.({ params, sql });
  return (database.query(sql).get(...params) as RecordType | null) ?? null;
};

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    // FNV-1a is deliberately defined in terms of an XOR step.
    // biome-ignore lint/suspicious/noBitwiseOperators: The bitwise operation is intrinsic to this hash.
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

const cursorScopeHash = (revision: string, requestFingerprint: string): string =>
  fnv1a64(`${revision}\n${requestFingerprint}`);

const createPageCursor = (revision: string, requestFingerprint: string, offset: number): string =>
  `sq1.${cursorScopeHash(revision, requestFingerprint)}.${offset.toString(36)}`;

const offsetFromCursor = (cursor: string | null, revision: string, requestFingerprint: string): number => {
  if (cursor === null) {
    return 0;
  }
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match || match[1] !== cursorScopeHash(revision, requestFingerprint)) {
    throw new Error('Session query cursor does not match the requested revision and query');
  }
  const offset = Number.parseInt(match[2] ?? '', 36);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Session query cursor contains an invalid offset');
  }
  return offset;
};

export const buildSessionQuerySqlFilter = (request: SessionQueryRequest, alias = 'session_rows') => {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (condition: string, ...values: unknown[]): void => {
    conditions.push(condition);
    params.push(...values);
  };
  if (request.filters.query) {
    add(`instr(${alias}.search_text, ?) > 0`, request.filters.query);
  }
  if (request.filters.harness.length > 0) {
    add(`${alias}.harness IN (${request.filters.harness.map(() => '?').join(', ')})`, ...request.filters.harness);
  }
  if (request.filters.machine.length > 0) {
    add(`${alias}.machine_id IN (${request.filters.machine.map(() => '?').join(', ')})`, ...request.filters.machine);
  }
  if (request.filters.localTimeCell !== undefined) {
    const { hour, weekday } = request.filters.localTimeCell;
    add(`${alias}.local_time_weekday = ? AND ${alias}.local_time_hour = ?`, weekday, hour);
  }
  if (request.filters.origin?.length) {
    add(
      `(${alias}.origin IS NULL OR ${alias}.origin IN (${request.filters.origin.map(() => '?').join(', ')}))`,
      ...request.filters.origin,
    );
  }
  if (request.filters.fields.campaign !== undefined) {
    add(`${alias}.campaign_key = ?`, request.filters.fields.campaign);
  }
  if (request.filters.fields.provider !== undefined) {
    add(`${alias}.provider_display = ?`, request.filters.fields.provider);
  }
  if (request.filters.fields.model !== undefined) {
    add(
      `EXISTS (
        SELECT 1
        FROM session_model_filter_keys AS filtered_model_keys
        WHERE filtered_model_keys.ordinal = ${alias}.ordinal
          AND filtered_model_keys.model_key = ?
      )`,
      request.filters.fields.model,
    );
  }
  if (request.filters.fields.project !== undefined) {
    add(`${alias}.project_key = ?`, request.filters.fields.project);
  }
  if (request.range.from !== null) {
    add(`${alias}.active_time IS NOT NULL AND ${alias}.active_time >= ?`, Date.parse(request.range.from));
  }
  if (request.range.to !== null) {
    add(`${alias}.active_time IS NOT NULL AND ${alias}.active_time <= ?`, Date.parse(request.range.to));
  }
  return { params, where: conditions.length === 0 ? '1 = 1' : conditions.join(' AND ') };
};

export const buildSessionQuerySqlOrder = (
  sort: readonly SessionQuerySort[],
  identityColumn: string,
  ordinalColumn: string,
): string => {
  const clauses = sort.map(({ desc, id }) => {
    const column = SORT_COLUMN_BY_FIELD[id];
    return `${column} ${desc ? 'DESC' : 'ASC'}`;
  });
  clauses.push(`${identityColumn} ASC`, `${ordinalColumn} ASC`);
  return clauses.join(', ');
};

const filteredCte = (where: string): string => `filtered AS (SELECT * FROM session_rows WHERE ${where})`;

const campaignRollupCte = `campaign_rollup AS (
  SELECT * FROM filtered
  UNION ALL
  SELECT classifier.*
  FROM session_rows AS classifier
  WHERE classifier.origin = 'classifier'
    AND classifier.ordinal NOT IN (SELECT ordinal FROM filtered)
    AND classifier.campaign_key IN (
      SELECT campaign_key
      FROM filtered
      WHERE campaign_key IS NOT NULL
    )
)`;

const campaignProjectionCtes = `campaign_visible_counts AS (
  SELECT campaign_key, COUNT(*) AS visible_count
  FROM filtered
  WHERE campaign_key IS NOT NULL
  GROUP BY campaign_key
),
campaign_latest_candidates AS (
  SELECT
    campaign_key,
    active_date,
    active_time,
    ROW_NUMBER() OVER (
      PARTITION BY campaign_key
      ORDER BY sort_date DESC, ordinal ASC
    ) AS latest_position
  FROM campaign_rollup
  WHERE campaign_key IS NOT NULL
),
campaign_latest_rows AS (
  SELECT campaign_key, active_date, active_time
  FROM campaign_latest_candidates
  WHERE latest_position = 1
)`;

const campaignExactCostCtes = `campaign_cost_rows AS (
  SELECT
    campaign_key,
    ROW_NUMBER() OVER (
      PARTITION BY campaign_key
      ORDER BY campaign_root DESC, ordinal ASC
    ) AS cost_position,
    COUNT(*) OVER (PARTITION BY campaign_key) AS cost_count,
    cost_actual,
    cost_approx,
    cost_known,
    cost_quota
  FROM campaign_rollup
  WHERE campaign_key IS NOT NULL
),
campaign_cost_totals(
  campaign_key,
  cost_position,
  cost_count,
  cost_actual,
  cost_approx,
  cost_known,
  cost_quota
) AS (
  SELECT
    campaign_key,
    cost_position,
    cost_count,
    COALESCE(cost_actual, 0),
    cost_approx,
    cost_known,
    COALESCE(cost_quota, 0)
  FROM campaign_cost_rows
  WHERE cost_position = 1
  UNION ALL
  SELECT
    next.campaign_key,
    next.cost_position,
    next.cost_count,
    total.cost_actual + COALESCE(next.cost_actual, 0),
    total.cost_approx + next.cost_approx,
    CASE WHEN total.cost_known = 1 AND next.cost_known = 1 THEN 1 ELSE 0 END,
    total.cost_quota + COALESCE(next.cost_quota, 0)
  FROM campaign_cost_totals AS total
  INNER JOIN campaign_cost_rows AS next
    ON next.campaign_key = total.campaign_key AND next.cost_position = total.cost_position + 1
),
campaign_cost_summary AS (
  SELECT campaign_key, cost_actual, cost_approx, cost_known, cost_quota
  FROM campaign_cost_totals
  WHERE cost_position = cost_count
)`;

const campaignItemCte = (useExactCostSort: boolean): string => `campaign_items AS (
  SELECT
    'campaign' AS item_kind,
    'campaign:' || visible.campaign_key AS item_identity,
    MIN(visible.ordinal) AS item_ordinal,
    root.row_json,
    visible.campaign_key,
    MAX(visible_counts.visible_count) AS visible_count,
    MAX(visible.campaign_total_count) AS total_count,
    SUM(CASE WHEN visible.origin = 'classifier' THEN 1 ELSE 0 END) AS classifier_count,
    SUM(CASE WHEN visible.origin = 'classifier' THEN visible.fresh_tokens ELSE 0 END) AS classifier_fresh_tokens,
    MAX(latest.active_date) AS latest_active_date,
    MAX(latest.active_time) AS latest_active_time,
    MAX(visible.sort_date) AS sort_date,
    root.sort_session,
    root.sort_harness,
    root.sort_machine,
    root.sort_provider,
    root.sort_project,
    root.sort_model,
    root.sort_session_rank,
    root.sort_harness_rank,
    root.sort_machine_rank,
    root.sort_provider_rank,
    root.sort_project_rank,
    root.sort_model_rank,
    root.campaign_item_identity_rank AS item_identity_rank,
    SUM(visible.tok_in) AS sort_tok_in,
    SUM(visible.tok_out) AS sort_tok_out,
    SUM(visible.tok_cr) AS sort_cache,
    SUM(visible.tok_cw) AS sort_tok_cw,
    SUM(visible.fresh_tokens) AS sort_fresh,
    SUM(visible.token_total) AS sort_total,
    CASE WHEN SUM(visible.rtk_input_tokens) = 0 THEN 0
      ELSE SUM(visible.rtk_saved_tokens) * 100.0 / SUM(visible.rtk_input_tokens) END AS sort_rtk_saved,
    ${
      useExactCostSort
        ? 'CASE WHEN MAX(exact_cost.cost_known) = 1 OR MAX(exact_cost.cost_approx) > 0 THEN MAX(exact_cost.cost_approx) ELSE -1e999 END'
        : 'CASE WHEN MIN(visible.cost_known) = 1 OR SUM(visible.cost_approx) > 0 THEN SUM(visible.cost_approx) ELSE -1e999 END'
    } AS sort_cost,
    ${useExactCostSort ? 'MAX(exact_cost.cost_actual)' : 'SUM(COALESCE(visible.cost_actual, 0))'} AS sort_actual,
    ${useExactCostSort ? 'MAX(exact_cost.cost_quota)' : 'SUM(COALESCE(visible.cost_quota, 0))'} AS sort_quota,
    COALESCE(MAX(root.duration_ms), 0) AS sort_duration,
    SUM(visible.calls) AS sort_calls,
    SUM(visible.turns) AS sort_turns,
    SUM(visible.tools) AS sort_tools,
    COALESCE(SUM(visible.line_delta), 0) AS sort_lines,
    MAX(visible.sort_subagent) AS sort_subagent,
    MAX(visible.sort_partial) AS sort_partial,
    MAX(visible.sort_ambiguous) AS sort_ambiguous,
    SUM(COALESCE(visible.cost_actual, 0)) AS cost_actual,
    SUM(visible.cost_approx) AS cost_approx,
    MIN(visible.cost_known) AS cost_known,
    SUM(COALESCE(visible.cost_quota, 0)) AS cost_quota,
    MAX(root.duration_ms) AS duration_ms,
    SUM(visible.fresh_tokens) AS fresh_tokens,
    CASE WHEN COUNT(visible.line_delta) = 0 THEN NULL ELSE SUM(visible.line_delta) END AS line_delta,
    CASE WHEN COUNT(visible.lines_added) = 0 THEN NULL ELSE SUM(visible.lines_added) END AS lines_added,
    CASE WHEN COUNT(visible.lines_deleted) = 0 THEN NULL ELSE SUM(visible.lines_deleted) END AS lines_deleted,
    SUM(visible.rtk_command_count) AS rtk_command_count,
    SUM(visible.rtk_input_tokens) AS rtk_input_tokens,
    SUM(visible.rtk_output_tokens) AS rtk_output_tokens,
    SUM(visible.rtk_saved_tokens) AS rtk_saved_tokens,
    SUM(visible.tok_cr) AS tok_cr,
    SUM(visible.tok_cw) AS tok_cw,
    SUM(visible.tok_in) AS tok_in,
    SUM(visible.tok_out) AS tok_out,
    SUM(visible.token_total) AS token_total,
    SUM(visible.calls) AS calls,
    SUM(visible.turns) AS turns,
    SUM(visible.tools) AS tools,
    MIN(visible.usage_unavailable) AS usage_unavailable,
    MAX(visible.sort_partial) AS partial,
    MAX(visible.sort_ambiguous) AS ambiguous
  FROM campaign_rollup AS visible
  INNER JOIN session_rows AS root
    ON root.campaign_key = visible.campaign_key AND root.campaign_root = 1
  INNER JOIN campaign_visible_counts AS visible_counts
    ON visible_counts.campaign_key = visible.campaign_key
  INNER JOIN campaign_latest_rows AS latest
    ON latest.campaign_key = visible.campaign_key
  ${
    useExactCostSort
      ? `INNER JOIN campaign_cost_summary AS exact_cost
    ON exact_cost.campaign_key = visible.campaign_key`
      : ''
  }
  WHERE visible.campaign_key IS NOT NULL
  GROUP BY visible.campaign_key
)`;

const parsePresentationRow = (serialized: string): SessionPresentationRow =>
  JSON.parse(serialized) as SessionPresentationRow;

const campaignDisplayRow = (record: ItemRecord): SessionPresentationRow => {
  const root = parsePresentationRow(record.row_json);
  const rootWithoutModelAttribution = { ...root };
  Reflect.deleteProperty(rootWithoutModelAttribution, 'modelSegments');
  if (
    record.campaign_key === null ||
    record.visible_count === null ||
    record.total_count === null ||
    record.classifier_count === null ||
    record.classifier_fresh_tokens === null ||
    record.calls === null ||
    record.cost_actual === null ||
    record.cost_approx === null ||
    record.cost_known === null ||
    record.cost_quota === null ||
    record.fresh_tokens === null ||
    record.rtk_command_count === null ||
    record.rtk_input_tokens === null ||
    record.rtk_output_tokens === null ||
    record.rtk_saved_tokens === null ||
    record.tok_cr === null ||
    record.tok_cw === null ||
    record.tok_in === null ||
    record.tok_out === null ||
    record.token_total === null ||
    record.tools === null ||
    record.turns === null ||
    record.usage_unavailable === null ||
    record.ambiguous === null ||
    record.price_measurement === undefined ||
    record.partial === null
  ) {
    throw new Error('Session query database returned an incomplete campaign item');
  }
  return {
    ...rootWithoutModelAttribution,
    activeDate: record.latest_active_date,
    activeTime: record.latest_active_time,
    ambiguous: record.ambiguous === 1,
    calls: record.calls,
    campaignClassifierCount: record.classifier_count,
    campaignClassifierFreshTokens: record.classifier_fresh_tokens,
    campaignKey: record.campaign_key,
    campaignTotalCount: record.total_count,
    campaignVisibleCount: record.visible_count,
    costActual: record.cost_actual,
    costApprox: record.cost_approx,
    costKnown: record.cost_known === 1,
    costQuota: record.cost_quota,
    durationMs: record.duration_ms,
    freshTokens: record.fresh_tokens,
    lineDelta: record.line_delta,
    linesAdded: record.lines_added,
    linesDeleted: record.lines_deleted,
    partial: record.partial === 1,
    priceMeasurement: record.price_measurement,
    rtkCommandCount: record.rtk_command_count,
    rtkInputTokens: record.rtk_input_tokens,
    rtkOutputTokens: record.rtk_output_tokens,
    rtkSavedTokens: record.rtk_saved_tokens,
    sessionLabel: root.sessionLabel,
    sortDate: record.sort_date,
    tokCr: record.tok_cr,
    tokCw: record.tok_cw,
    tokenTotal: record.token_total,
    tokIn: record.tok_in,
    tokOut: record.tok_out,
    tools: record.tools,
    turns: record.turns,
    usageUnavailable: record.usage_unavailable === 1,
  };
};

const hydrateExactCampaignCosts = (
  database: SessionQuerySqliteDatabase,
  records: ItemRecord[],
  filter: { params: unknown[]; where: string },
  trace?: SessionQuerySqliteTrace,
): void => {
  const campaignRecords = records.filter(
    (record): record is ItemRecord & { campaign_key: string } => record.campaign_key !== null,
  );
  const campaignKeys = [...new Set(campaignRecords.map((record) => record.campaign_key))];
  if (campaignKeys.length === 0) {
    return;
  }
  const sql = `SELECT campaign_key, cost_actual, cost_approx, cost_known, cost_quota, row_json
    FROM session_rows
    WHERE campaign_key IN (${campaignKeys.map(() => '?').join(', ')})
      AND ((${filter.where}) OR origin = 'classifier')
    ORDER BY campaign_key, campaign_root DESC, ordinal`;
  const params = [...campaignKeys, ...filter.params];
  trace?.({ params, sql });
  const totals = new Map<string, { actual: number; priceMeasurement: ApiPriceMeasurement; quota: number }>();
  for (const value of database.query(sql).iterate(...params)) {
    const row = value as CampaignCostRecord;
    const total = totals.get(row.campaign_key) ?? {
      actual: 0,
      priceMeasurement: EMPTY_API_PRICE_MEASUREMENT,
      quota: 0,
    };
    total.actual += row.cost_actual ?? 0;
    total.priceMeasurement = combineApiPriceMeasurements([
      total.priceMeasurement,
      usageRowApiPriceMeasurement(parsePresentationRow(row.row_json)),
    ]);
    total.quota += row.cost_quota ?? 0;
    totals.set(row.campaign_key, total);
  }
  for (const record of campaignRecords) {
    const total = totals.get(record.campaign_key);
    if (!total) {
      throw new Error('Session query database omitted a paged campaign aggregate');
    }
    record.cost_actual = total.actual;
    record.cost_approx = total.priceMeasurement.knownCost;
    record.cost_known = total.priceMeasurement.state === 'partially measured' ? 0 : 1;
    record.cost_quota = total.quota;
    record.price_measurement = total.priceMeasurement;
  }
};

const runSessionPage = (
  database: SessionQuerySqliteDatabase,
  input: SessionQueryRequest,
  trace?: SessionQuerySqliteTrace,
): SessionPageResult => {
  const request = parseSessionQueryRequest(input);
  const requestFingerprint = sessionQueryFingerprint(request);
  const offset = offsetFromCursor(request.cursor, request.revision, requestFingerprint);
  const filter = buildSessionQuerySqlFilter(request);
  const countSql = `WITH ${filteredCte(filter.where)} SELECT
    (SELECT COUNT(*) FROM filtered) AS session_count,
    (SELECT COUNT(DISTINCT campaign_key) FROM filtered WHERE campaign_key IS NOT NULL) AS item_count`;
  const counts = executeGet<CountRecord>(database, countSql, filter.params, trace) ?? {
    item_count: 0,
    session_count: 0,
  };
  const order = buildSessionQuerySqlOrder(request.sort, 'item_identity_rank', 'item_ordinal');
  const useExactCostSort = request.sort.some(({ id }) => CAMPAIGN_EXACT_COST_SORT_FIELDS.has(id));
  const campaignCtes = [
    filteredCte(filter.where),
    campaignRollupCte,
    campaignProjectionCtes,
    ...(useExactCostSort ? [campaignExactCostCtes] : []),
    campaignItemCte(useExactCostSort),
  ].join(',\n');
  const pageSql = `WITH${useExactCostSort ? ' RECURSIVE' : ''} ${campaignCtes}
    SELECT * FROM campaign_items ORDER BY ${order} LIMIT ? OFFSET ?`;
  const pageWithSentinel = executeAll<ItemRecord>(
    database,
    pageSql,
    [...filter.params, request.pageSize + 1, offset],
    trace,
  );
  const hasMore = pageWithSentinel.length > request.pageSize;
  const pageRecords = pageWithSentinel.slice(0, request.pageSize);
  hydrateExactCampaignCosts(database, pageRecords, filter, trace);
  const items: SessionPageItem[] = pageRecords.map((record) => ({
    campaignKey: record.campaign_key!,
    kind: 'campaign',
    row: campaignDisplayRow(record),
  }));
  return {
    itemCount: counts.item_count,
    items,
    nextCursor: hasMore ? createPageCursor(request.revision, requestFingerprint, offset + request.pageSize) : null,
    requestFingerprint,
    revision: request.revision,
    sessionCount: counts.session_count,
  };
};

const runCampaignChildren = (
  database: SessionQuerySqliteDatabase,
  input: SessionCampaignChildrenRequest,
  trace?: SessionQuerySqliteTrace,
): SessionCampaignChildrenResult => {
  const request = parseSessionCampaignChildrenRequest(input);
  const requestFingerprint = sessionCampaignChildrenFingerprint(request);
  const offset = offsetFromCursor(request.query.cursor, request.query.revision, requestFingerprint);
  const filter = buildSessionQuerySqlFilter(request.query);
  const matchedWhere = `(${filter.where}) AND session_rows.campaign_key = ? AND session_rows.campaign_root = 0`;
  const rollupWhere = `session_rows.campaign_key = ? AND session_rows.campaign_root = 0
    AND ((${filter.where}) OR session_rows.origin = 'classifier')`;
  const count = executeGet<CountRecord>(
    database,
    `SELECT
      (SELECT COUNT(*) FROM session_rows WHERE ${rollupWhere}) AS item_count,
      (SELECT COUNT(*) FROM session_rows WHERE ${matchedWhere}) AS session_count`,
    [request.campaignKey, ...filter.params, ...filter.params, request.campaignKey],
    trace,
  ) ?? { item_count: 0, session_count: 0 };
  const order = buildSessionQuerySqlOrder(request.query.sort, 'row_identity_rank', 'ordinal');
  const rows = executeAll<{ row_json: string }>(
    database,
    `SELECT row_json FROM session_rows WHERE ${rollupWhere} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [request.campaignKey, ...filter.params, request.query.pageSize + 1, offset],
    trace,
  );
  const hasMore = rows.length > request.query.pageSize;
  return {
    campaignKey: request.campaignKey,
    itemCount: count.item_count,
    items: rows.slice(0, request.query.pageSize).map(({ row_json }) => parsePresentationRow(row_json)),
    nextCursor: hasMore
      ? createPageCursor(request.query.revision, requestFingerprint, offset + request.query.pageSize)
      : null,
    requestFingerprint,
    revision: request.query.revision,
    sessionCount: count.session_count,
  };
};

const runNeighbors = (
  database: SessionQuerySqliteDatabase,
  input: SessionNeighborRequest,
  trace?: SessionQuerySqliteTrace,
): SessionNeighborResult => {
  const request = parseSessionNeighborRequest(input);
  const requestFingerprint = sessionNeighborFingerprint(request);
  const filter = buildSessionQuerySqlFilter(request.query);
  const order = buildSessionQuerySqlOrder(request.query.sort, 'row_identity_rank', 'ordinal');
  const neighbor = executeGet<NeighborRecord>(
    database,
    `WITH ${filteredCte(filter.where)},
      ordered AS (
        SELECT
          row_id,
          ordinal,
          ROW_NUMBER() OVER (ORDER BY ${order}) AS sequence_position,
          LAG(row_json) OVER (ORDER BY ${order}) AS previous_json,
          LEAD(row_json) OVER (ORDER BY ${order}) AS next_json
        FROM filtered
      )
      SELECT previous_json, next_json
      FROM ordered
      WHERE row_id = ?
      ORDER BY sequence_position
      LIMIT 1`,
    [...filter.params, request.rowId],
    trace,
  );
  return {
    found: neighbor !== null,
    next: neighbor?.next_json ? parsePresentationRow(neighbor.next_json) : null,
    previous: neighbor?.previous_json ? parsePresentationRow(neighbor.previous_json) : null,
    requestFingerprint,
    revision: request.query.revision,
  };
};

const runSessionDetailAnchor = (
  database: SessionQuerySqliteDatabase,
  input: SessionDetailRequest,
  trace?: SessionQuerySqliteTrace,
): SessionDetailAnchorResult => {
  const request = parseSessionDetailRequest(input);
  const rows = executeAll<SessionDetailAnchorRecord>(
    database,
    `SELECT source_authority, source_row_json
    FROM session_rows
    WHERE row_id = ?
    ORDER BY ordinal
    LIMIT 2`,
    [request.rowId],
    trace,
  );
  if (rows.length > 1) {
    throw new Error('Report revision session row identity is not unique');
  }
  const sourceRow = rows[0];
  if (!sourceRow) {
    return {
      anchor: null,
      requestFingerprint: sessionDetailRequestFingerprint(request),
      revision: request.revision,
    };
  }
  const sourceAuthority = sessionDetailSourceAuthorities.find((authority) => authority === sourceRow.source_authority);
  if (!sourceAuthority) {
    throw new Error('Report revision session detail source authority is invalid');
  }
  let serializedRow: unknown;
  try {
    serializedRow = JSON.parse(sourceRow.source_row_json);
  } catch {
    throw new Error('Report revision session detail source row is invalid JSON');
  }
  const source = isUnknownRecord(serializedRow) ? serializedRow.source : null;
  const projectionSource = isUnknownRecord(serializedRow) ? withoutSource(serializedRow) : serializedRow;
  const projection = sessionProjectionFactsForSerializedRow(projectionSource);
  const provenance = isUnknownRecord(source) ? source : null;
  let vcs: SessionVcsContext | null = null;
  if (provenance?.vcs !== undefined) {
    vcs = parseSessionVcsContext(provenance.vcs);
  }
  const nullableIdentity = (key: 'harnessKey' | 'machineId' | 'sourceSessionId'): string | null => {
    if (!(provenance && key in provenance)) {
      return null;
    }
    const value = provenance[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    anchor: {
      harnessKey: nullableIdentity('harnessKey'),
      machineId: nullableIdentity('machineId'),
      projection,
      sourceAuthority,
      sourceSessionId: nullableIdentity('sourceSessionId'),
      vcs,
    },
    requestFingerprint: sessionDetailRequestFingerprint(request),
    revision: request.revision,
  };
};

export const assertSessionQueryDatabase = (
  database: SessionQuerySqliteDatabase,
  trace?: SessionQuerySqliteTrace,
): void => {
  const metadata = executeGet<{ schema_version: number }>(
    database,
    'SELECT schema_version FROM metadata LIMIT 1',
    [],
    trace,
  );
  if (metadata?.schema_version !== SESSION_QUERY_SCHEMA_VERSION) {
    throw new Error('Report revision session query database has an unsupported schema');
  }
};

export function executeMaterializedSessionQuery(
  database: SessionQuerySqliteDatabase,
  kind: 'sessions',
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): SessionPageResult;
export function executeMaterializedSessionQuery(
  database: SessionQuerySqliteDatabase,
  kind: 'campaign-children',
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): SessionCampaignChildrenResult;
export function executeMaterializedSessionQuery(
  database: SessionQuerySqliteDatabase,
  kind: 'neighbors',
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): SessionNeighborResult;
export function executeMaterializedSessionQuery(
  database: SessionQuerySqliteDatabase,
  kind: 'session-detail-anchor',
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): SessionDetailAnchorResult;
export function executeMaterializedSessionQuery(
  database: SessionQuerySqliteDatabase,
  kind: SessionQueryKind,
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): SessionPageResult | SessionCampaignChildrenResult | SessionNeighborResult | SessionDetailAnchorResult;
export function executeMaterializedSessionQuery(
  database: SessionQuerySqliteDatabase,
  kind: SessionQueryKind,
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): SessionPageResult | SessionCampaignChildrenResult | SessionNeighborResult | SessionDetailAnchorResult {
  if (kind === 'sessions') {
    return runSessionPage(database, parseSessionQueryRequest(request), trace);
  }
  if (kind === 'campaign-children') {
    return runCampaignChildren(database, parseSessionCampaignChildrenRequest(request), trace);
  }
  if (kind === 'session-detail-anchor') {
    return runSessionDetailAnchor(database, parseSessionDetailRequest(request), trace);
  }
  return runNeighbors(database, parseSessionNeighborRequest(request), trace);
}
