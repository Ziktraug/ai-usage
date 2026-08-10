import { harnessProviderAnalyticsKey, hasMeasuredLineDelta } from '@ai-usage/report-core/analytics';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import { providerStatusKeyForUsage, providerStatusScopeKey } from '@ai-usage/report-core/provider-status';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { SERVED_REVISION_PATTERN } from '@ai-usage/report-core/served-revision';
import type { SessionDetailSourceAuthority } from '@ai-usage/report-core/session-detail';
import {
  buildSessionCampaignViews,
  compareSessionIdentityValues,
  compareSessionTextValues,
  enrichSessionPresentationRow,
  localTimeCellForTimestamp,
  type SessionCampaignView,
  type SessionPresentationRow,
  type SessionTextSortField,
  sessionModelKeys,
  sessionSortFields,
  sessionTextSortFields,
  sortValueForSessionColumn,
} from '@ai-usage/report-core/session-query';
import {
  usageRowApiPriceMeasurement,
  usageRowModelApiPriceMeasurements,
  usageRowModelContributions,
} from '@ai-usage/report-core/usage-row';

export const SERVED_REPORT_PROJECTION_SCHEMA_VERSION = 17;
export const SERVED_REPORT_REVISION_PATTERN = SERVED_REVISION_PATTERN;

export interface ServedRevisionReadStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface ServedRevisionWriteStatement extends ServedRevisionReadStatement {
  run(...params: unknown[]): unknown;
}

export interface ServedRevisionReadDatabase {
  query(sql: string): ServedRevisionReadStatement;
}

export interface ServedRevisionWriteDatabase extends ServedRevisionReadDatabase {
  exec(sql: string): unknown;
  query(sql: string): ServedRevisionWriteStatement;
}

export class ServedRevisionQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServedRevisionQueryValidationError';
  }
}

export class ServedRevisionSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServedRevisionSchemaValidationError';
  }
}

export const servedReportSchemaSql = `
  CREATE TABLE IF NOT EXISTS served_report_revisions (
    revision TEXT PRIMARY KEY,
    capture_fingerprint TEXT NOT NULL,
    private_capture_fingerprint TEXT NOT NULL,
    config_fingerprint TEXT NOT NULL,
    usage_store_generation INTEGER NOT NULL CHECK (usage_store_generation >= 0),
    machine_fleet_generation INTEGER NOT NULL CHECK (machine_fleet_generation >= 0),
    projection_schema_version INTEGER NOT NULL CHECK (projection_schema_version > 0),
    generated_at TEXT NOT NULL,
    published_at INTEGER NOT NULL CHECK (published_at >= 0),
    expires_at INTEGER NOT NULL CHECK (expires_at >= published_at),
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
    filter_key_count INTEGER NOT NULL CHECK (filter_key_count >= 0),
    rows_bytes INTEGER NOT NULL CHECK (rows_bytes >= 0),
    support_bytes INTEGER NOT NULL CHECK (support_bytes >= 0),
    projection_bytes INTEGER NOT NULL CHECK (projection_bytes >= 0),
    UNIQUE (revision, complete)
  );

  CREATE TABLE IF NOT EXISTS served_report_current (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision TEXT NOT NULL,
    required_complete INTEGER NOT NULL DEFAULT 1 CHECK (required_complete = 1),
    FOREIGN KEY (revision, required_complete)
      REFERENCES served_report_revisions(revision, complete)
  );

  CREATE TABLE IF NOT EXISTS served_report_support (
    revision TEXT PRIMARY KEY REFERENCES served_report_revisions(revision) ON DELETE CASCADE,
    support_json TEXT NOT NULL,
    support_bytes INTEGER NOT NULL CHECK (support_bytes >= 0)
  );

  CREATE TABLE IF NOT EXISTS served_report_local_context (
    revision TEXT PRIMARY KEY REFERENCES served_report_revisions(revision) ON DELETE CASCADE,
    machine_id TEXT NOT NULL,
    machine_label TEXT NOT NULL,
    context_json TEXT NOT NULL,
    context_bytes INTEGER NOT NULL CHECK (context_bytes >= 0)
  );

  CREATE TABLE IF NOT EXISTS served_report_rows (
    revision TEXT NOT NULL REFERENCES served_report_revisions(revision) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    row_id TEXT NOT NULL,
    row_json TEXT NOT NULL,
    source_row_json TEXT NOT NULL,
    source_authority TEXT NOT NULL CHECK (source_authority IN ('local-observed', 'portable-opaque')),
    active_date TEXT,
    active_time INTEGER,
    local_time_weekday INTEGER CHECK (local_time_weekday BETWEEN 0 AND 6),
    local_time_hour INTEGER CHECK (local_time_hour BETWEEN 0 AND 23),
    search_text TEXT NOT NULL,
    harness TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    machine_label TEXT NOT NULL,
    provider_scope_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_display TEXT NOT NULL,
    harness_provider_key TEXT NOT NULL,
    model_key TEXT NOT NULL,
    project_key TEXT NOT NULL,
    project_label TEXT NOT NULL,
    origin TEXT CHECK (origin IN ('human', 'subagent', 'classifier')),
    origin_provenance TEXT CHECK (origin_provenance IN ('origin-unsupported', 'origin-absent', 'origin-degraded')),
    campaign_key TEXT,
    campaign_label TEXT NOT NULL,
    campaign_root INTEGER NOT NULL CHECK (campaign_root IN (0, 1)),
    campaign_total_count INTEGER,
    sort_date REAL NOT NULL,
    sort_session TEXT NOT NULL,
    sort_harness TEXT NOT NULL,
    sort_machine TEXT NOT NULL,
    sort_provider TEXT NOT NULL,
    sort_project TEXT NOT NULL,
    sort_model TEXT NOT NULL,
    sort_session_rank INTEGER NOT NULL,
    sort_harness_rank INTEGER NOT NULL,
    sort_machine_rank INTEGER NOT NULL,
    sort_provider_rank INTEGER NOT NULL,
    sort_project_rank INTEGER NOT NULL,
    sort_model_rank INTEGER NOT NULL,
    row_identity_rank INTEGER NOT NULL,
    session_item_identity_rank INTEGER NOT NULL,
    campaign_item_identity_rank INTEGER,
    sort_tok_in REAL NOT NULL,
    sort_tok_out REAL NOT NULL,
    sort_cache REAL NOT NULL,
    sort_tok_cw REAL NOT NULL,
    sort_fresh REAL NOT NULL,
    sort_total REAL NOT NULL,
    sort_rtk_saved REAL NOT NULL,
    sort_cost REAL NOT NULL,
    sort_actual REAL NOT NULL,
    sort_quota REAL NOT NULL,
    sort_duration REAL NOT NULL,
    sort_calls REAL NOT NULL,
    sort_turns REAL NOT NULL,
    sort_tools REAL NOT NULL,
    sort_lines REAL NOT NULL,
    sort_subagent INTEGER NOT NULL,
    sort_partial INTEGER NOT NULL,
    sort_ambiguous INTEGER NOT NULL,
    cost_actual REAL,
    cost_approx REAL NOT NULL,
    cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
    cost_quota REAL,
    duration_ms REAL,
    fresh_tokens REAL NOT NULL,
    unpriced_fresh_tokens REAL NOT NULL,
    line_delta REAL,
    lines_added REAL,
    lines_deleted REAL,
    lines_measured INTEGER NOT NULL CHECK (lines_measured IN (0, 1)),
    rtk_command_count REAL NOT NULL,
    rtk_input_tokens REAL NOT NULL,
    rtk_output_tokens REAL NOT NULL,
    rtk_saved_tokens REAL NOT NULL,
    tok_cr REAL NOT NULL,
    tok_cw REAL NOT NULL,
    tok_in REAL NOT NULL,
    tok_out REAL NOT NULL,
    token_total REAL NOT NULL,
    calls REAL NOT NULL,
    turns REAL NOT NULL,
    tools REAL NOT NULL,
    usage_unavailable INTEGER NOT NULL CHECK (usage_unavailable IN (0, 1)),
    PRIMARY KEY (revision, ordinal),
    UNIQUE (revision, row_id)
  );

  CREATE TABLE IF NOT EXISTS served_session_model_segments (
    revision TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    model_key TEXT NOT NULL,
    segment_position INTEGER NOT NULL,
    cost_approx REAL NOT NULL,
    cost_known INTEGER NOT NULL CHECK (cost_known IN (0, 1)),
    unpriced_fresh_tokens REAL NOT NULL,
    tok_cr REAL NOT NULL,
    tok_cw REAL NOT NULL,
    tok_in REAL NOT NULL,
    tok_out REAL NOT NULL,
    PRIMARY KEY (revision, ordinal, model_key),
    FOREIGN KEY (revision, ordinal) REFERENCES served_report_rows(revision, ordinal) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS served_session_model_filter_keys (
    revision TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    model_key TEXT NOT NULL,
    PRIMARY KEY (revision, ordinal, model_key),
    FOREIGN KEY (revision, ordinal) REFERENCES served_report_rows(revision, ordinal) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_served_report_rows_campaign
    ON served_report_rows(revision, campaign_key, campaign_root, ordinal);
  CREATE INDEX IF NOT EXISTS idx_served_report_rows_active_time
    ON served_report_rows(revision, active_time);
  CREATE INDEX IF NOT EXISTS idx_served_report_rows_local_time_cell
    ON served_report_rows(revision, local_time_weekday, local_time_hour);
  CREATE INDEX IF NOT EXISTS idx_served_report_rows_facets
    ON served_report_rows(revision, harness, machine_id, provider_display, model_key, project_key);
  CREATE INDEX IF NOT EXISTS idx_served_report_rows_provider_scope
    ON served_report_rows(revision, provider_scope_key, ordinal);
  CREATE INDEX IF NOT EXISTS idx_served_session_model_segments_model
    ON served_session_model_segments(revision, model_key, ordinal);
  CREATE INDEX IF NOT EXISTS idx_served_report_revisions_retention
    ON served_report_revisions(complete, expires_at, published_at, revision);
`;

const CREATE_SCHEMA_STATEMENT_PATTERN = /CREATE (?:TABLE|INDEX) IF NOT EXISTS ([a-z_]+)[\s\S]*?;/g;

const normalizeSchemaSql = (sql: string): string =>
  sql
    .replace(/\bIF NOT EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([(),])/g, '$1')
    .replace(/([,(])\s+/g, '$1')
    .trim()
    .toLowerCase();

const EXPECTED_SERVED_SCHEMA_SQL = new Map(
  [...servedReportSchemaSql.matchAll(CREATE_SCHEMA_STATEMENT_PATTERN)].map((match) => {
    const [statement, name] = match;
    if (!name) {
      throw new Error('Served report schema contains an unnamed statement');
    }
    return [name, normalizeSchemaSql(statement)] as const;
  }),
);

const servedReportRowInsertColumns: readonly string[] = [
  'revision',
  'ordinal',
  'row_id',
  'row_json',
  'source_row_json',
  'source_authority',
  'active_date',
  'active_time',
  'local_time_weekday',
  'local_time_hour',
  'search_text',
  'harness',
  'machine_id',
  'machine_label',
  'provider_scope_key',
  'provider',
  'provider_display',
  'harness_provider_key',
  'model_key',
  'project_key',
  'project_label',
  'origin',
  'origin_provenance',
  'campaign_key',
  'campaign_label',
  'campaign_root',
  'campaign_total_count',
  ...sessionSortFields.map(
    (field) => `sort_${field === 'cache' ? 'cache' : field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
  ),
  ...sessionTextSortFields.map((field) => `sort_${field}_rank`),
  'row_identity_rank',
  'session_item_identity_rank',
  'campaign_item_identity_rank',
  'cost_actual',
  'cost_approx',
  'cost_known',
  'cost_quota',
  'duration_ms',
  'fresh_tokens',
  'unpriced_fresh_tokens',
  'line_delta',
  'lines_added',
  'lines_deleted',
  'lines_measured',
  'rtk_command_count',
  'rtk_input_tokens',
  'rtk_output_tokens',
  'rtk_saved_tokens',
  'tok_cr',
  'tok_cw',
  'tok_in',
  'tok_out',
  'token_total',
  'calls',
  'turns',
  'tools',
  'usage_unavailable',
];

const insertSql = `
  INSERT INTO served_report_rows (${servedReportRowInsertColumns.join(', ')})
  VALUES (${servedReportRowInsertColumns.map(() => '?').join(', ')})
`;

interface MaterializedSessionRanks {
  itemIdentity: ReadonlyMap<string, number>;
  rowIdentity: ReadonlyMap<string, number>;
  text: ReadonlyMap<SessionTextSortField, ReadonlyMap<string, number>>;
}

const buildValueRanks = (
  values: readonly string[],
  compare: (left: string, right: string) => number,
): ReadonlyMap<string, number> => {
  const orderedValues = [...new Set(values)].sort(compare);
  const ranks = new Map<string, number>();
  let currentRank = 0;
  for (const [index, value] of orderedValues.entries()) {
    const previous = orderedValues[index - 1];
    if (previous !== undefined && compare(previous, value) !== 0) {
      currentRank += 1;
    }
    ranks.set(value, currentRank);
  }
  return ranks;
};

const requireRank = (ranks: ReadonlyMap<string, number> | undefined, value: string, label: string): number => {
  const rank = ranks?.get(value);
  if (rank === undefined) {
    throw new Error(`Served Session projection omitted the ${label} rank`);
  }
  return rank;
};

const buildMaterializedSessionRanks = (
  rows: SessionPresentationRow[],
  campaigns: SessionCampaignView[],
): MaterializedSessionRanks => {
  const text = new Map<SessionTextSortField, ReadonlyMap<string, number>>();
  for (const field of sessionTextSortFields) {
    text.set(
      field,
      buildValueRanks(
        rows.map((row) => String(sortValueForSessionColumn(row, field))),
        compareSessionTextValues,
      ),
    );
  }
  return {
    itemIdentity: buildValueRanks(
      [
        ...rows.map((row) => `session:${row.rowId}`),
        ...campaigns.map((campaign) => `campaign:${campaign.campaignKey}`),
      ],
      compareSessionIdentityValues,
    ),
    rowIdentity: buildValueRanks(
      rows.map((row) => row.rowId),
      compareSessionIdentityValues,
    ),
    text,
  };
};

interface InsertProjectionInput {
  readonly revision: string;
  readonly rows: readonly SerializedRow[];
  readonly sourceAuthorities: readonly SessionDetailSourceAuthority[];
  readonly timeZone: string;
}

export interface InsertProjectionResult {
  readonly filterKeyCount: number;
  readonly projectionBytes: number;
  readonly rowCount: number;
  readonly segmentCount: number;
}

export const insertServedReportProjection = (
  database: ServedRevisionWriteDatabase,
  input: InsertProjectionInput,
): InsertProjectionResult => {
  if (input.rows.length !== input.sourceAuthorities.length) {
    throw new Error('Served report rows and source authorities must have the same length');
  }
  const presentationRows = input.rows.map(enrichSessionPresentationRow);
  const campaignByRow = new Map<
    SessionPresentationRow,
    { key: string; label: string; root: boolean; totalCount: number }
  >();
  const campaigns = buildSessionCampaignViews(presentationRows, presentationRows);
  for (const campaign of campaigns) {
    for (const campaignRow of campaign.allRows) {
      campaignByRow.set(campaignRow, {
        key: campaign.campaignKey,
        label: campaign.root.sessionLabel,
        root: campaignRow === campaign.root,
        totalCount: campaign.totalCount,
      });
    }
  }
  const ranks = buildMaterializedSessionRanks(presentationRows, campaigns);
  const insert = database.query(insertSql);
  const insertModelSegment = database.query(`
    INSERT INTO served_session_model_segments (
      revision, ordinal, model_key, segment_position, cost_approx, cost_known,
      unpriced_fresh_tokens, tok_cr, tok_cw, tok_in, tok_out
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertModelFilterKey = database.query(`
    INSERT INTO served_session_model_filter_keys (revision, ordinal, model_key) VALUES (?, ?, ?)
  `);
  let filterKeyCount = 0;
  let projectionBytes = 0;
  let segmentCount = 0;
  for (const [ordinal, row] of presentationRows.entries()) {
    const sourceRow = input.rows[ordinal];
    const sourceAuthority = input.sourceAuthorities[ordinal];
    if (!(sourceRow && sourceAuthority)) {
      throw new Error(`Served report row ${ordinal} is missing source data or authority`);
    }
    const campaign = campaignByRow.get(row);
    const sortValues = sessionSortFields.map((field) => sortValueForSessionColumn(row, field));
    const textSortRanks = sessionTextSortFields.map((field) =>
      requireRank(ranks.text.get(field), String(sortValueForSessionColumn(row, field)), `${field} sort`),
    );
    const machineId = row.source?.machineId ?? '';
    const providerKey = providerStatusKeyForUsage(row.harness, row.provider);
    const localTimeCell = row.activeTime === null ? null : localTimeCellForTimestamp(row.activeTime, input.timeZone);
    const rowJson = JSON.stringify(row);
    const sourceRowJson = JSON.stringify(sourceRow);
    insert.run(
      input.revision,
      ordinal,
      row.rowId,
      rowJson,
      sourceRowJson,
      sourceAuthority,
      row.activeDate,
      row.activeTime,
      localTimeCell?.weekday ?? null,
      localTimeCell?.hour ?? null,
      row.searchText,
      row.harness,
      machineId,
      row.source?.machineLabel ?? '',
      providerStatusScopeKey(providerKey, machineId || undefined),
      row.provider,
      row.providerDisplay,
      harnessProviderAnalyticsKey(row.harness, row.providerDisplay),
      row.modelKey,
      row.projectKey,
      row.projectLabel,
      row.origin ?? null,
      row.originProvenance ?? null,
      campaign?.key ?? null,
      campaign?.label ?? row.sessionLabel,
      campaign?.root ? 1 : 0,
      campaign?.totalCount ?? null,
      ...sortValues,
      ...textSortRanks,
      requireRank(ranks.rowIdentity, row.rowId, 'row identity'),
      requireRank(ranks.itemIdentity, `session:${row.rowId}`, 'Session item identity'),
      campaign === undefined
        ? null
        : requireRank(ranks.itemIdentity, `campaign:${campaign.key}`, 'campaign item identity'),
      row.costActual,
      row.costApprox,
      row.costKnown ? 1 : 0,
      row.costQuota ?? null,
      row.durationMs,
      row.freshTokens,
      usageRowApiPriceMeasurement(sourceRow).unpricedFreshTokens,
      row.lineDelta,
      row.linesAdded,
      row.linesDeleted,
      hasMeasuredLineDelta(row.linesAdded, row.linesDeleted) ? 1 : 0,
      row.rtkCommandCount ?? 0,
      row.rtkInputTokens ?? 0,
      row.rtkOutputTokens ?? 0,
      row.rtkSavedTokens ?? 0,
      row.tokCr,
      row.tokCw,
      row.tokIn,
      row.tokOut,
      row.tokenTotal,
      row.calls,
      row.turns,
      row.tools,
      row.usageUnavailable ? 1 : 0,
    );
    projectionBytes +=
      Buffer.byteLength(rowJson) + Buffer.byteLength(sourceRowJson) + Buffer.byteLength(sourceAuthority);
    const modelPriceMeasurements = usageRowModelApiPriceMeasurements(sourceRow);
    for (const [segmentPosition, segment] of usageRowModelContributions(sourceRow).entries()) {
      const priceMeasurement = modelPriceMeasurements.get(segment.key);
      if (!priceMeasurement) {
        throw new Error(`Served report row ${ordinal} is missing model price coverage for ${segment.key}`);
      }
      insertModelSegment.run(
        input.revision,
        ordinal,
        segment.key,
        segmentPosition,
        segment.costApprox,
        segment.costKnown ? 1 : 0,
        priceMeasurement.unpricedFreshTokens,
        segment.tokCr,
        segment.tokCw,
        segment.tokIn,
        segment.tokOut,
      );
      segmentCount += 1;
      projectionBytes += Buffer.byteLength(segment.key) + 72;
    }
    for (const modelKey of sessionModelKeys(sourceRow)) {
      insertModelFilterKey.run(input.revision, ordinal, modelKey);
      filterKeyCount += 1;
      projectionBytes += Buffer.byteLength(modelKey) + 16;
    }
  }
  return { filterKeyCount, projectionBytes, rowCount: input.rows.length, segmentCount };
};

const LOGICAL_TABLE_PATTERN = /\b(session_model_filter_keys|session_model_segments|session_rows|metadata)\b/g;
const LOGICAL_TABLE_REFERENCE_PATTERN =
  /\b(?:session_model_filter_keys|session_model_segments|session_rows|metadata)\b/;
const PHYSICAL_OR_SYSTEM_TABLE_PATTERN = /\b(?:served_(?:report|session)_[a-z_]+|sqlite_[a-z_]+)\b/i;
const READ_QUERY_PATTERN = /^\s*(?:EXPLAIN\s+QUERY\s+PLAN\s+)?(?:SELECT|WITH)\b/i;
const MAX_SERVED_REVISION_QUERY_PARAMETERS = 4096;
const MAX_SERVED_REVISION_QUERY_ROWS = MAX_PORTABLE_USAGE_ROWS + 1024;
const MAX_SERVED_REVISION_QUERY_STATEMENTS = 128;
const MAX_SERVED_REVISION_QUERY_SQL_BYTES = 256 * 1024;
const SCOPED_CTES = `
scoped_session_rows AS (
  SELECT * FROM served_report_rows WHERE revision = ?
),
scoped_session_model_segments AS (
  SELECT * FROM served_session_model_segments WHERE revision = ?
),
scoped_session_model_filter_keys AS (
  SELECT * FROM served_session_model_filter_keys WHERE revision = ?
),
scoped_metadata AS (
  SELECT
    revisions.capture_fingerprint,
    revisions.projection_schema_version AS schema_version,
    revisions.row_count,
    support.support_json
  FROM served_report_revisions AS revisions
  INNER JOIN served_report_support AS support USING (revision)
  WHERE revisions.revision = ?
)`;

const EXPLAIN_QUERY_PLAN_PATTERN = /^\s*EXPLAIN\s+QUERY\s+PLAN\s+/i;
const WITH_CLAUSE_PATTERN = /^\s*WITH\b/i;
const WITH_RECURSIVE_CLAUSE_PATTERN = /^\s*WITH\s+RECURSIVE\b/i;

const rewriteServedRevisionQuerySql = (sql: string): string => {
  const rewritten = sql.replace(LOGICAL_TABLE_PATTERN, (table) => `scoped_${table}`);
  if (WITH_RECURSIVE_CLAUSE_PATTERN.test(rewritten)) {
    return rewritten.replace(WITH_RECURSIVE_CLAUSE_PATTERN, `WITH RECURSIVE ${SCOPED_CTES},`);
  }
  if (WITH_CLAUSE_PATTERN.test(rewritten)) {
    return rewritten.replace(WITH_CLAUSE_PATTERN, `WITH ${SCOPED_CTES},`);
  }
  return `WITH ${SCOPED_CTES}\n${rewritten}`;
};

const rewriteServedRevisionSql = (sql: string): string => {
  if (!EXPLAIN_QUERY_PLAN_PATTERN.test(sql)) {
    return rewriteServedRevisionQuerySql(sql);
  }
  const querySql = sql.replace(EXPLAIN_QUERY_PLAN_PATTERN, '');
  return `EXPLAIN QUERY PLAN ${rewriteServedRevisionQuerySql(querySql)}`;
};

const scopedParams = (revision: string, params: readonly unknown[]): unknown[] => [
  revision,
  revision,
  revision,
  revision,
  ...params,
];

export interface ServedRevisionQueryTrace {
  readonly params: readonly unknown[];
  readonly sql: string;
}

export const createServedRevisionQueryDatabase = (
  database: ServedRevisionReadDatabase,
  revision: string,
  trace?: (query: ServedRevisionQueryTrace) => void,
): ServedRevisionReadDatabase => {
  let resultRows = 0;
  let statements = 0;
  const accountRows = (count: number): void => {
    resultRows += count;
    if (resultRows > MAX_SERVED_REVISION_QUERY_ROWS) {
      throw new ServedRevisionQueryValidationError('Served revision query exceeded its row budget');
    }
  };
  return {
    query: (sql) => {
      statements += 1;
      if (
        statements > MAX_SERVED_REVISION_QUERY_STATEMENTS ||
        Buffer.byteLength(sql) > MAX_SERVED_REVISION_QUERY_SQL_BYTES ||
        sql.includes(';') ||
        !READ_QUERY_PATTERN.test(sql) ||
        !LOGICAL_TABLE_REFERENCE_PATTERN.test(sql) ||
        PHYSICAL_OR_SYSTEM_TABLE_PATTERN.test(sql)
      ) {
        throw new ServedRevisionQueryValidationError('Served revision query is outside the bounded logical catalog');
      }
      const scopedSql = rewriteServedRevisionSql(sql);
      const statement = database.query(scopedSql);
      const bind = (params: readonly unknown[]): unknown[] => {
        if (params.length > MAX_SERVED_REVISION_QUERY_PARAMETERS) {
          throw new ServedRevisionQueryValidationError('Served revision query exceeded its parameter budget');
        }
        const values = scopedParams(revision, params);
        trace?.({ params: values, sql: scopedSql });
        return values;
      };
      return {
        all: (...params) => {
          const rows: unknown[] = [];
          for (const row of statement.iterate(...bind(params))) {
            accountRows(1);
            rows.push(row);
          }
          return rows;
        },
        get: (...params) => {
          const row = statement.get(...bind(params));
          accountRows(row === null || row === undefined ? 0 : 1);
          return row;
        },
        iterate: (...params) => {
          const iterator = statement.iterate(...bind(params));
          return (function* boundedIterator(): IterableIterator<unknown> {
            for (const row of iterator) {
              accountRows(1);
              yield row;
            }
          })();
        },
      };
    },
  };
};

const REQUIRED_SERVED_TABLES = [
  'collected_dataset_items',
  'provider_quota_latest_heads',
  'provider_quota_observations',
  'provider_quota_streams',
  'served_report_current',
  'served_report_local_context',
  'served_report_revisions',
  'served_report_rows',
  'served_report_support',
  'served_session_model_filter_keys',
  'served_session_model_segments',
  'usage_machine_fleet_order',
  'usage_row_enrichments',
  'usage_rows',
  'usage_store_metadata',
] as const;

const REQUIRED_SERVED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  provider_quota_latest_heads: [
    'provider_key',
    'machine_id',
    'account_scope_key',
    'observation_id',
    'confidence_rank',
    'first_observed_at',
  ],
  provider_quota_streams: ['provider_key', 'machine_id', 'account_scope_key', 'account_scope', 'source_key'],
  served_report_current: ['singleton', 'revision', 'required_complete'],
  served_report_local_context: ['revision', 'machine_id', 'machine_label', 'context_json', 'context_bytes'],
  served_report_revisions: [
    'revision',
    'capture_fingerprint',
    'private_capture_fingerprint',
    'config_fingerprint',
    'usage_store_generation',
    'machine_fleet_generation',
    'projection_schema_version',
    'generated_at',
    'published_at',
    'expires_at',
    'complete',
    'row_count',
    'segment_count',
    'filter_key_count',
    'rows_bytes',
    'support_bytes',
    'projection_bytes',
  ],
  served_report_rows: servedReportRowInsertColumns,
  served_report_support: ['revision', 'support_json', 'support_bytes'],
  served_session_model_filter_keys: ['revision', 'ordinal', 'model_key'],
  served_session_model_segments: [
    'revision',
    'ordinal',
    'model_key',
    'segment_position',
    'cost_approx',
    'cost_known',
    'unpriced_fresh_tokens',
    'tok_cr',
    'tok_cw',
    'tok_in',
    'tok_out',
  ],
};

const REQUIRED_SERVED_INDEXES: Readonly<Record<string, readonly (string | null)[]>> = {
  idx_provider_quota_anchor_exact: [
    'provider_key',
    'machine_id',
    'account_scope',
    'source_key',
    'first_observed_at',
    'id',
  ],
  idx_provider_quota_anchor_normalized: ['provider_key', 'machine_id', null, 'source_key', 'first_observed_at', 'id'],
  idx_provider_quota_heads_machine: ['machine_id', 'confidence_rank', 'first_observed_at', 'observation_id'],
  idx_provider_quota_heads_order: ['confidence_rank', 'first_observed_at', 'observation_id'],
  idx_provider_quota_heads_provider: ['provider_key', 'confidence_rank', 'first_observed_at', 'observation_id'],
  idx_provider_quota_heads_provider_machine: [
    'provider_key',
    'machine_id',
    'confidence_rank',
    'first_observed_at',
    'observation_id',
  ],
  idx_provider_quota_range_account: ['account_scope', 'first_observed_at', 'id'],
  idx_provider_quota_range_all: ['first_observed_at', 'id'],
  idx_provider_quota_range_machine: ['machine_id', 'first_observed_at', 'id'],
  idx_provider_quota_range_machine_account: ['machine_id', 'account_scope', 'first_observed_at', 'id'],
  idx_provider_quota_range_provider: ['provider_key', 'first_observed_at', 'id'],
  idx_provider_quota_range_provider_account: ['provider_key', 'account_scope', 'first_observed_at', 'id'],
  idx_provider_quota_range_provider_machine: ['provider_key', 'machine_id', 'first_observed_at', 'id'],
  idx_provider_quota_range_provider_machine_account: [
    'provider_key',
    'machine_id',
    'account_scope',
    'first_observed_at',
    'id',
  ],
  idx_served_report_revisions_retention: ['complete', 'expires_at', 'published_at', 'revision'],
  idx_served_report_rows_active_time: ['revision', 'active_time'],
  idx_served_report_rows_local_time_cell: ['revision', 'local_time_weekday', 'local_time_hour'],
  idx_served_report_rows_campaign: ['revision', 'campaign_key', 'campaign_root', 'ordinal'],
  idx_served_report_rows_facets: ['revision', 'harness', 'machine_id', 'provider_display', 'model_key', 'project_key'],
  idx_served_report_rows_provider_scope: ['revision', 'provider_scope_key', 'ordinal'],
  idx_served_session_model_segments_model: ['revision', 'model_key', 'ordinal'],
};

const schemaError = (message: string): ServedRevisionSchemaValidationError =>
  new ServedRevisionSchemaValidationError(message);

export const assertServedReportSchema = (database: ServedRevisionReadDatabase): void => {
  const rows = database
    .query(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${REQUIRED_SERVED_TABLES.map(() => '?').join(', ')})`,
    )
    .all(...REQUIRED_SERVED_TABLES) as Array<{ name?: unknown }>;
  const present = new Set(rows.map(({ name }) => name).filter((name): name is string => typeof name === 'string'));
  for (const required of REQUIRED_SERVED_TABLES) {
    if (!present.has(required)) {
      throw schemaError(`Usage store schema is missing required table ${required}`);
    }
  }
  for (const [name, expectedSql] of EXPECTED_SERVED_SCHEMA_SQL) {
    const record = database.query('SELECT sql FROM sqlite_schema WHERE name = ?').get(name) as {
      sql?: unknown;
    } | null;
    if (typeof record?.sql !== 'string' || normalizeSchemaSql(`${record.sql};`) !== expectedSql) {
      throw schemaError(`Usage store schema definition for ${name} is incompatible`);
    }
  }
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SERVED_COLUMNS)) {
    const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    const presentColumns = new Set(
      columns.map(({ name }) => name).filter((name): name is string => typeof name === 'string'),
    );
    for (const column of requiredColumns) {
      if (!presentColumns.has(column)) {
        throw schemaError(`Usage store schema is missing required column ${table}.${column}`);
      }
    }
  }
  for (const [index, requiredColumns] of Object.entries(REQUIRED_SERVED_INDEXES)) {
    const columns = database.query(`PRAGMA index_info(${index})`).all() as Array<{ name?: unknown }>;
    const actualColumns = columns.map(({ name }) => name);
    if (
      actualColumns.length !== requiredColumns.length ||
      requiredColumns.some((column, position) => actualColumns[position] !== column)
    ) {
      throw schemaError(`Usage store schema is missing required index ${index}`);
    }
  }
  const currentForeignKeys = database.query('PRAGMA foreign_key_list(served_report_current)').all() as Array<{
    from?: unknown;
    id?: unknown;
    seq?: unknown;
    table?: unknown;
    to?: unknown;
  }>;
  const pointerForeignKeys = currentForeignKeys.filter(({ table }) => table === 'served_report_revisions');
  const revisionForeignKey = pointerForeignKeys.find(({ from, to }) => from === 'revision' && to === 'revision');
  const completenessForeignKey = pointerForeignKeys.find(
    ({ from, to }) => from === 'required_complete' && to === 'complete',
  );
  if (
    !(revisionForeignKey && completenessForeignKey) ||
    revisionForeignKey.id !== completenessForeignKey.id ||
    revisionForeignKey.seq === completenessForeignKey.seq
  ) {
    throw schemaError('Usage store current revision pointer is missing its composite completeness foreign key');
  }
};
