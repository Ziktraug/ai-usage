import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import {
  buildFocusedDateDomain,
  buildFocusedHeatmapFromAggregates,
  buildFocusedRecordsFromAggregates,
  buildFocusedTimelineFromAggregates,
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedDateDomain,
  type FocusedDayAggregate,
  type FocusedHtmlPayloadResult,
  type FocusedOverviewRequest,
  type FocusedOverviewResult,
  type FocusedOverviewSessionItem,
  type FocusedReportQueryKind,
  type FocusedReportQueryScope,
  type FocusedReportSummary,
  type FocusedReportSupport,
  type FocusedRevisionRequest,
  type FocusedSupportResult,
  type FocusedTimelineAggregate,
  focusedBreakdownFingerprint,
  focusedOverviewFingerprint,
  parseFocusedBreakdownRequest,
  parseFocusedOverviewRequest,
  parseFocusedRevisionRequest,
  projectFocusedHtmlPayload,
  projectFocusedOverviewFromPresentationRows,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import type {
  SessionPresentationRow,
  SessionQueryRequest,
  SessionQuerySort,
} from '@ai-usage/report-core/session-query';
import { MAX_USAGE_SNAPSHOT_ROWS } from '@ai-usage/report-core/snapshot';
import {
  buildSessionQuerySqlFilter,
  type SessionQuerySqliteDatabase,
  type SessionQuerySqliteTrace,
} from './session-query-sqlite';

export type FocusedReportQueryResult =
  | FocusedBreakdownResult
  | FocusedHtmlPayloadResult
  | FocusedOverviewResult
  | FocusedSupportResult;

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

const sessionRequest = (
  query: FocusedReportQueryScope,
  sort: SessionQuerySort[] = [{ desc: true, id: 'date' }],
): SessionQueryRequest => ({
  campaigns: false,
  cursor: null,
  filters: query.filters,
  pageSize: 1,
  range: query.range,
  revision: query.revision,
  sort,
});

const readSupport = (database: SessionQuerySqliteDatabase, trace?: SessionQuerySqliteTrace): FocusedReportSupport => {
  const record = executeGet<{ support_json: string }>(database, 'SELECT support_json FROM metadata LIMIT 1', [], trace);
  if (!record) {
    throw new Error('Report revision session query database is missing support context');
  }
  const support: unknown = JSON.parse(record.support_json);
  if (typeof support !== 'object' || support === null || Array.isArray(support) || Object.hasOwn(support, 'rows')) {
    throw new Error('Report revision session query database contains invalid support context');
  }
  return support as FocusedReportSupport;
};

const readAllRows = (database: SessionQuerySqliteDatabase, trace?: SessionQuerySqliteTrace): SerializedRow[] =>
  executeAll<{ source_row_json: string }>(
    database,
    'SELECT source_row_json FROM session_rows ORDER BY ordinal',
    [],
    trace,
  ).map(({ source_row_json }) => JSON.parse(source_row_json) as SerializedRow);

interface SummaryRecord {
  actual_cost: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_quota: number | null;
  fresh: number | null;
  priced_sessions: number | null;
  rtk_input: number | null;
  rtk_output: number | null;
  rtk_saved: number | null;
  rtk_sessions: number | null;
  session_count: number;
  tok_in: number | null;
  tok_out: number | null;
  tools: number | null;
  total_cost: number | null;
  turns: number | null;
  unknown_actual: number | null;
}

interface TimelineRecord {
  cost: number;
  day_key: string;
  first_ordinal: number;
  first_time: number;
  key: string;
  last_time: number;
  sessions: number;
}

interface DayRecord {
  cost: number;
  day_key: string;
  first_ordinal: number;
  sessions: number;
}

interface RecordCandidates {
  longest_json: string | null;
  top_cost_json: string | null;
}

interface TopSessionRecord {
  cost_approx: number;
  duration_ms: number | null;
  item_kind: 'campaign' | 'session';
  row_json: string;
  session_count: number;
}

type SqlFilter = ReturnType<typeof buildSessionQuerySqlFilter>;

const parsePresentationRow = (serialized: string): SessionPresentationRow =>
  JSON.parse(serialized) as SessionPresentationRow;

const summaryFromRecord = (record: SummaryRecord | null): FocusedReportSummary => {
  const pricedSessions = record?.priced_sessions ?? 0;
  const totalCost = record?.total_cost ?? 0;
  return {
    actualCost: record?.actual_cost ?? 0,
    cacheRead: record?.cache_read ?? 0,
    cacheWrite: record?.cache_write ?? 0,
    costQuota: record?.cost_quota ?? 0,
    fresh: record?.fresh ?? 0,
    meanCost: totalCost / (pricedSessions || 1),
    pricedSessions,
    rtkInput: record?.rtk_input ?? 0,
    rtkOutput: record?.rtk_output ?? 0,
    rtkSaved: record?.rtk_saved ?? 0,
    rtkSessions: record?.rtk_sessions ?? 0,
    sessionCount: record?.session_count ?? 0,
    tokIn: record?.tok_in ?? 0,
    tokOut: record?.tok_out ?? 0,
    tools: record?.tools ?? 0,
    totalCost,
    turns: record?.turns ?? 0,
    unknownActual: record?.unknown_actual ?? 0,
  };
};

const readSummary = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): FocusedReportSummary =>
  summaryFromRecord(
    executeGet<SummaryRecord>(
      database,
      `SELECT
        COUNT(*) AS session_count,
        SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS total_cost,
        SUM(cost_known) AS priced_sessions,
        SUM(COALESCE(cost_actual, 0)) AS actual_cost,
        SUM(COALESCE(cost_quota, 0)) AS cost_quota,
        SUM(CASE WHEN cost_actual IS NULL THEN 1 ELSE 0 END) AS unknown_actual,
        SUM(fresh_tokens) AS fresh,
        SUM(tok_cr) AS cache_read,
        SUM(tok_cw) AS cache_write,
        SUM(tok_in) AS tok_in,
        SUM(tok_out) AS tok_out,
        SUM(rtk_saved_tokens) AS rtk_saved,
        SUM(rtk_input_tokens) AS rtk_input,
        SUM(rtk_output_tokens) AS rtk_output,
        SUM(CASE WHEN rtk_saved_tokens <> 0 THEN 1 ELSE 0 END) AS rtk_sessions,
        SUM(turns) AS turns,
        SUM(tools) AS tools
      FROM session_rows
      WHERE ${filter.where}`,
      filter.params,
      trace,
    ),
  );

const timelineDimensionColumn = (dimension: FocusedOverviewRequest['timeline']['dimension']): string => {
  if (dimension === 'harness') {
    return 'harness';
  }
  if (dimension === 'model') {
    return 'model_key';
  }
  return dimension === 'project' ? 'project_key' : 'provider_display';
};

const timeForLocalDay = (dayKey: string): number => {
  const time = new Date(`${dayKey}T00:00:00`).getTime();
  if (!Number.isFinite(time)) {
    throw new Error('Report revision contains an invalid local-day aggregate');
  }
  return time;
};

const readTimeline = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  dimension: FocusedOverviewRequest['timeline']['dimension'],
  trace?: SessionQuerySqliteTrace,
): { dateDomain: FocusedDateDomain | null; days: FocusedDayAggregate[]; timeline: FocusedTimelineAggregate[] } => {
  const dimensionColumn = timelineDimensionColumn(dimension);
  const records = executeAll<TimelineRecord>(
    database,
    `SELECT
      strftime('%Y-%m-%d', active_time / 1000, 'unixepoch', 'localtime') AS day_key,
      ${dimensionColumn} AS key,
      SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS cost,
      COUNT(*) AS sessions,
      MIN(active_time) AS first_time,
      MAX(active_time) AS last_time,
      MIN(ordinal) AS first_ordinal
    FROM session_rows
    WHERE ${filter.where} AND active_time IS NOT NULL
    GROUP BY day_key, ${dimensionColumn}
    ORDER BY first_ordinal`,
    filter.params,
    trace,
  );
  const byDay = new Map<string, FocusedDayAggregate>();
  const timeline = records.map(({ cost, day_key: dayKey, key, sessions }) => {
    const time = timeForLocalDay(dayKey);
    const day = byDay.get(dayKey) ?? { cost: 0, sessions: 0, time };
    day.cost += cost;
    day.sessions += sessions;
    byDay.set(dayKey, day);
    return { cost, key, sessions, time };
  });
  return {
    dateDomain: buildFocusedDateDomain(records.flatMap(({ first_time, last_time }) => [first_time, last_time])),
    days: [...byDay.values()],
    timeline,
  };
};

const readDays = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): FocusedDayAggregate[] =>
  executeAll<DayRecord>(
    database,
    `SELECT
      strftime('%Y-%m-%d', active_time / 1000, 'unixepoch', 'localtime') AS day_key,
      SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS cost,
      COUNT(*) AS sessions,
      MIN(ordinal) AS first_ordinal
    FROM session_rows
    WHERE ${filter.where} AND active_time IS NOT NULL
    GROUP BY day_key
    ORDER BY first_ordinal`,
    filter.params,
    trace,
  ).map(({ cost, day_key: dayKey, sessions }) => ({ cost, sessions, time: timeForLocalDay(dayKey) }));

const readRecordCandidates = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): { longest: SessionPresentationRow | null; topCost: SessionPresentationRow | null } => {
  const candidates = executeGet<RecordCandidates>(
    database,
    `WITH visible AS (
      SELECT ordinal, row_json, cost_known, cost_approx, duration_ms
      FROM session_rows
      WHERE ${filter.where}
    )
    SELECT
      (SELECT row_json FROM visible
       WHERE cost_known = 1 AND cost_approx > 0
       ORDER BY cost_approx DESC, ordinal ASC LIMIT 1) AS top_cost_json,
      (SELECT row_json FROM visible
       WHERE duration_ms > 0
       ORDER BY duration_ms DESC, ordinal ASC LIMIT 1) AS longest_json`,
    filter.params,
    trace,
  );
  return {
    longest: candidates?.longest_json ? parsePresentationRow(candidates.longest_json) : null,
    topCost: candidates?.top_cost_json ? parsePresentationRow(candidates.top_cost_json) : null,
  };
};

const readTopSessions = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): FocusedOverviewSessionItem[] =>
  executeAll<TopSessionRecord>(
    database,
    `WITH visible AS (
      SELECT ordinal, row_json, campaign_key, cost_known, cost_approx, duration_ms
      FROM session_rows
      WHERE ${filter.where}
    ),
    items AS (
      SELECT
        'campaign' AS item_kind,
        root.row_json AS row_json,
        SUM(CASE WHEN visible.cost_known = 1 THEN visible.cost_approx ELSE 0 END) AS cost_approx,
        CASE WHEN COUNT(visible.duration_ms) = 0 THEN NULL ELSE SUM(visible.duration_ms) END AS duration_ms,
        COUNT(*) AS session_count,
        0 AS kind_order,
        MIN(visible.ordinal) AS item_ordinal
      FROM visible
      INNER JOIN session_rows AS root
        ON root.campaign_key = visible.campaign_key AND root.campaign_root = 1
      WHERE visible.campaign_key IS NOT NULL
      GROUP BY visible.campaign_key
      UNION ALL
      SELECT
        'session' AS item_kind,
        row_json,
        cost_approx,
        duration_ms,
        1 AS session_count,
        1 AS kind_order,
        ordinal AS item_ordinal
      FROM visible
      WHERE campaign_key IS NULL
    )
    SELECT item_kind, row_json, cost_approx, duration_ms, session_count
    FROM items
    WHERE cost_approx > 0
    ORDER BY cost_approx DESC, kind_order ASC, item_ordinal ASC
    LIMIT 5`,
    filter.params,
    trace,
  ).map((record) => {
    const row = parsePresentationRow(record.row_json);
    return {
      costApprox: record.cost_approx,
      durationMs: record.duration_ms,
      harness: row.harness,
      kind: record.item_kind,
      label: row.sessionLabel,
      row,
      sessionCount: record.session_count,
    };
  });

const previousSummary = (
  database: SessionQuerySqliteDatabase,
  request: FocusedOverviewRequest,
  generatedAt: string,
  trace?: SessionQuerySqliteTrace,
): FocusedReportSummary | null => {
  if (request.query.range.from === null) {
    return null;
  }
  const from = Date.parse(request.query.range.from);
  const to = request.query.range.to ? Date.parse(request.query.range.to) : Date.parse(generatedAt);
  const span = Math.max(86_400_000, to - from);
  const previousRequest = sessionRequest({
    ...request.query,
    range: { from: new Date(from - span).toISOString(), to: new Date(from - 1).toISOString() },
  });
  const summary = readSummary(database, buildSessionQuerySqlFilter(previousRequest), trace);
  return summary.sessionCount > 0 ? summary : null;
};

const runAdvancedOverview = (
  database: SessionQuerySqliteDatabase,
  request: FocusedOverviewRequest,
  support: FocusedReportSupport,
  trace?: SessionQuerySqliteTrace,
): FocusedOverviewResult => {
  const rowsWithSentinel = executeAll<{ row_json: string }>(
    database,
    `SELECT row_json FROM session_rows ORDER BY ordinal LIMIT ${MAX_USAGE_SNAPSHOT_ROWS + 1}`,
    [],
    trace,
  );
  if (rowsWithSentinel.length > MAX_USAGE_SNAPSHOT_ROWS) {
    throw new Error(`Advanced Overview exceeds the ${MAX_USAGE_SNAPSHOT_ROWS}-row snapshot ceiling`);
  }
  return projectFocusedOverviewFromPresentationRows(
    rowsWithSentinel.map(({ row_json: rowJson }) => parsePresentationRow(rowJson)),
    support,
    request,
  );
};

const runOverview = (
  database: SessionQuerySqliteDatabase,
  input: FocusedOverviewRequest,
  trace?: SessionQuerySqliteTrace,
): FocusedOverviewResult => {
  const request = parseFocusedOverviewRequest(input);
  const support = readSupport(database, trace);
  if (request.includeAdvanced) {
    return runAdvancedOverview(database, request, support, trace);
  }
  const visibleFilter = buildSessionQuerySqlFilter(sessionRequest(request.query));
  const timelineFilter = buildSessionQuerySqlFilter(
    sessionRequest({ ...request.query, range: { from: null, to: null } }),
  );
  const summary = readSummary(database, visibleFilter, trace);
  const timelineAggregates = readTimeline(database, timelineFilter, request.timeline.dimension, trace);
  const visibleDays = readDays(database, visibleFilter, trace);
  const candidates = readRecordCandidates(database, visibleFilter, trace);
  return {
    dateDomain: timelineAggregates.dateDomain,
    metadata: { filters: support.filters, generatedAt: support.generatedAt, omittedRows: support.omittedRows },
    requestFingerprint: focusedOverviewFingerprint(request),
    revision: request.query.revision,
    summary,
    timeline: buildFocusedTimelineFromAggregates(timelineAggregates.timeline, request.timeline),
    view: {
      advancedSummary: null,
      heatmap: buildFocusedHeatmapFromAggregates(timelineAggregates.days),
      previousSummary: previousSummary(database, request, support.generatedAt, trace),
      punchcard: null,
      records: buildFocusedRecordsFromAggregates(
        candidates.topCost,
        candidates.longest,
        visibleDays,
        timelineAggregates.days,
      ),
      sessionShape: null,
      topSessions: readTopSessions(database, visibleFilter, trace),
    },
  };
};

interface AnalyticsAggregateRecord {
  ambiguous: number;
  cache: number;
  cost_sum: number;
  first_ordinal: number;
  fresh: number;
  harness: string;
  inp: number;
  key: string;
  kind: 'harness' | 'model' | 'provider';
  lines_a: number;
  lines_d: number;
  median_cost: number | null;
  priced: number;
  provider: string;
  sessions: number;
  tools: number;
  total_cost: number;
  turns: number;
  unpriced: number;
  usage_unavailable: number;
}

interface ProjectAggregateRecord {
  cache: number;
  cost: number;
  first_ordinal: number;
  fresh: number;
  key: string;
  lines_added: number;
  lines_deleted: number;
  priced: number;
  sessions: number;
  tools: number;
  turns: number;
}

const analyticsGroupFromRecord = (record: AnalyticsAggregateRecord): AnalyticsGroup => {
  const lineCount = record.lines_a + record.lines_d;
  return {
    ambiguous: record.ambiguous,
    cache: record.cache,
    cacheHitPct: record.inp + record.cache > 0 ? (record.cache / (record.inp + record.cache)) * 100 : 0,
    costPer100Lines: lineCount && record.priced ? (record.cost_sum / lineCount) * 100 : null,
    costPercent: record.total_cost > 0 ? (record.cost_sum / record.total_cost) * 100 : 0,
    costPerSession: record.priced ? record.cost_sum / record.priced : null,
    costSum: record.cost_sum,
    fresh: record.fresh,
    harness: record.harness,
    inp: record.inp,
    key: record.key,
    lineCount,
    linesA: record.lines_a,
    linesD: record.lines_d,
    medianCost: record.median_cost,
    priced: record.priced,
    provider: record.provider,
    sessions: record.sessions,
    tools: record.tools,
    turns: record.turns,
    unpriced: record.unpriced,
    usageUnavailable: record.usage_unavailable,
  };
};

const readAnalyticsGroups = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): { harnesses: AnalyticsGroup[]; models: AnalyticsGroup[]; providers: AnalyticsGroup[] } => {
  const records = executeAll<AnalyticsAggregateRecord>(
    database,
    `WITH filtered AS (
      SELECT
        ordinal,
        harness,
        provider,
        provider_display,
        model_key,
        cost_known,
        cost_approx,
        usage_unavailable,
        sort_ambiguous,
        fresh_tokens,
        tok_in,
        tok_cr,
        lines_added,
        lines_deleted,
        turns,
        tools
      FROM session_rows
      WHERE ${filter.where}
    ),
    dimensions AS (
      SELECT 'harness' AS kind, harness AS key, * FROM filtered
      UNION ALL
      SELECT 'model' AS kind, model_key AS key, * FROM filtered
      UNION ALL
      SELECT 'provider' AS kind, provider_display AS key, * FROM filtered
    ),
    grouped AS (
      SELECT
        kind,
        key,
        MIN(ordinal) AS first_ordinal,
        COUNT(*) AS sessions,
        SUM(cost_known) AS priced,
        COUNT(*) - SUM(cost_known) AS unpriced,
        SUM(usage_unavailable) AS usage_unavailable,
        SUM(sort_ambiguous) AS ambiguous,
        SUM(fresh_tokens) AS fresh,
        SUM(tok_in) AS inp,
        SUM(tok_cr) AS cache,
        SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS cost_sum,
        SUM(COALESCE(lines_added, 0)) AS lines_a,
        SUM(COALESCE(lines_deleted, 0)) AS lines_d,
        SUM(turns) AS turns,
        SUM(tools) AS tools
      FROM dimensions
      GROUP BY kind, key
    ),
    priced AS (
      SELECT
        kind,
        key,
        cost_approx,
        ROW_NUMBER() OVER (PARTITION BY kind, key ORDER BY cost_approx, ordinal) AS cost_rank,
        COUNT(*) OVER (PARTITION BY kind, key) AS priced_count
      FROM dimensions
      WHERE cost_known = 1
    ),
    medians AS (
      SELECT kind, key, AVG(cost_approx) AS median_cost
      FROM priced
      WHERE cost_rank IN ((priced_count + 1) / 2, (priced_count + 2) / 2)
      GROUP BY kind, key
    ),
    first_rows AS (
      SELECT dimensions.kind, dimensions.key, dimensions.harness, dimensions.provider
      FROM dimensions
      INNER JOIN grouped
        ON grouped.kind = dimensions.kind
        AND grouped.key = dimensions.key
        AND grouped.first_ordinal = dimensions.ordinal
    )
    SELECT
      grouped.*,
      first_rows.harness,
      first_rows.provider,
      medians.median_cost,
      SUM(grouped.cost_sum) OVER (PARTITION BY grouped.kind) AS total_cost
    FROM grouped
    INNER JOIN first_rows USING (kind, key)
    LEFT JOIN medians USING (kind, key)
    ORDER BY grouped.kind, grouped.cost_sum DESC, grouped.first_ordinal`,
    filter.params,
    trace,
  );
  const groups = records.map(analyticsGroupFromRecord);
  return {
    harnesses: groups.filter((_, index) => records[index]?.kind === 'harness'),
    models: groups.filter((_, index) => records[index]?.kind === 'model'),
    providers: groups.filter((_, index) => records[index]?.kind === 'provider'),
  };
};

const readProjectGroups = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): FocusedBreakdownResult['groups']['projects'] =>
  executeAll<ProjectAggregateRecord>(
    database,
    `SELECT
      project_key AS key,
      MIN(ordinal) AS first_ordinal,
      COUNT(*) AS sessions,
      SUM(fresh_tokens) AS fresh,
      SUM(tok_cr) AS cache,
      SUM(turns) AS turns,
      SUM(tools) AS tools,
      SUM(COALESCE(lines_added, 0)) AS lines_added,
      SUM(COALESCE(lines_deleted, 0)) AS lines_deleted,
      SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS cost,
      SUM(cost_known) AS priced
    FROM session_rows
    WHERE ${filter.where}
    GROUP BY project_key
    ORDER BY cost DESC, fresh DESC, first_ordinal`,
    filter.params,
    trace,
  ).map((record) => ({
    cache: record.cache,
    cost: record.cost,
    fresh: record.fresh,
    key: record.key,
    linesAdded: record.lines_added,
    linesDeleted: record.lines_deleted,
    priced: record.priced,
    sessions: record.sessions,
    tools: record.tools,
    turns: record.turns,
  }));

const runBreakdown = (
  database: SessionQuerySqliteDatabase,
  input: FocusedBreakdownRequest,
  trace?: SessionQuerySqliteTrace,
): FocusedBreakdownResult => {
  const request = parseFocusedBreakdownRequest(input);
  const support = readSupport(database, trace);
  const filter = buildSessionQuerySqlFilter(sessionRequest(request.query));
  const groups = readAnalyticsGroups(database, filter, trace);
  return {
    context: {
      cursorCommitAttribution: support.datasets?.cursorCommitAttribution ?? [],
      ...(support.projectGroupConfigs === undefined ? {} : { projectGroupConfigs: support.projectGroupConfigs }),
      ...(support.projectGroups === undefined ? {} : { projectGroups: support.projectGroups }),
      ...(support.warnings === undefined ? {} : { warnings: support.warnings }),
    },
    groups: { ...groups, projects: readProjectGroups(database, filter, trace) },
    requestFingerprint: focusedBreakdownFingerprint(request),
    revision: request.query.revision,
  };
};

const runHtmlPayload = (
  database: SessionQuerySqliteDatabase,
  input: FocusedRevisionRequest,
  trace?: SessionQuerySqliteTrace,
): FocusedHtmlPayloadResult => {
  const request = parseFocusedRevisionRequest(input);
  const rows = readAllRows(database, trace);
  return projectFocusedHtmlPayload(rows, readSupport(database, trace), request);
};

const runSupport = (
  database: SessionQuerySqliteDatabase,
  input: FocusedRevisionRequest,
  trace?: SessionQuerySqliteTrace,
): FocusedSupportResult => {
  const request = parseFocusedRevisionRequest(input);
  const optionCounts = executeGet<{
    first_time: number | null;
    harness_count: number;
    last_time: number | null;
    machine_count: number;
    provider_scope_count: number;
  }>(
    database,
    `SELECT
      MIN(active_time) AS first_time,
      MAX(active_time) AS last_time,
      COUNT(DISTINCT harness) AS harness_count,
      COUNT(DISTINCT CASE WHEN machine_label <> '' THEN machine_label END) AS machine_count,
      COUNT(DISTINCT provider_scope_key) AS provider_scope_count
    FROM session_rows`,
    [],
    trace,
  ) ?? { first_time: null, harness_count: 0, last_time: null, machine_count: 0, provider_scope_count: 0 };
  const options = executeAll<{ kind: 'harness' | 'machine'; value: string }>(
    database,
    `SELECT 'harness' AS kind, harness AS value FROM (SELECT DISTINCT harness FROM session_rows ORDER BY harness LIMIT 100)
     UNION ALL
     SELECT 'machine' AS kind, machine_label AS value FROM (
       SELECT DISTINCT machine_label FROM session_rows WHERE machine_label <> '' ORDER BY machine_label LIMIT 100
     )`,
    [],
    trace,
  );
  const harness = options.filter(({ kind }) => kind === 'harness').map(({ value }) => value);
  const machine = options.filter(({ kind }) => kind === 'machine').map(({ value }) => value);
  const providerRows = executeAll<{ row_json: string }>(
    database,
    `SELECT row_json FROM session_rows
     WHERE ordinal IN (
       SELECT MIN(ordinal) FROM session_rows GROUP BY provider_scope_key
     )
     ORDER BY ordinal
     LIMIT 100`,
    [],
    trace,
  ).map(({ row_json }) => JSON.parse(row_json) as SessionPresentationRow);
  return projectFocusedSupport(
    readSupport(database, trace),
    {
      harness: harness.slice(0, 100),
      machine: machine.slice(0, 100),
      truncated:
        optionCounts.harness_count > 100 || optionCounts.machine_count > 100 || optionCounts.provider_scope_count > 100,
    },
    request,
    {
      dateDomain: buildFocusedDateDomain(
        [optionCounts.first_time, optionCounts.last_time].filter((time): time is number => time !== null),
      ),
      providerRows,
      sourceOmissions: {
        harnessOptionsOmitted: Math.max(0, optionCounts.harness_count - harness.length),
        machineOptionsOmitted: Math.max(0, optionCounts.machine_count - machine.length),
        providerRowsOmitted: Math.max(0, optionCounts.provider_scope_count - providerRows.length),
      },
    },
  );
};

export const executeFocusedReportQuery = (
  database: SessionQuerySqliteDatabase,
  kind: FocusedReportQueryKind,
  request: unknown,
  trace?: SessionQuerySqliteTrace,
): FocusedReportQueryResult => {
  if (kind === 'overview') {
    return runOverview(database, parseFocusedOverviewRequest(request), trace);
  }
  if (kind === 'breakdown') {
    return runBreakdown(database, parseFocusedBreakdownRequest(request), trace);
  }
  if (kind === 'html-payload') {
    return runHtmlPayload(database, parseFocusedRevisionRequest(request), trace);
  }
  return runSupport(database, parseFocusedRevisionRequest(request), trace);
};
