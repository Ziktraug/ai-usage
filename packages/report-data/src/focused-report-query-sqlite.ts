import { type AnalyticsGroup, compareAnalyticsKeys } from '@ai-usage/report-core/analytics';
import {
  buildFocusedDateDomain,
  buildFocusedHeatmapFromAggregates,
  buildFocusedRecordsFromAggregates,
  buildFocusedTimelineFromAggregates,
  type FocusedBreakdownRequest,
  type FocusedBreakdownResult,
  type FocusedDateDomain,
  type FocusedDayAggregate,
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
  projectFocusedOverviewFromPresentationRows,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import { type ApiPriceMeasurement, apiPriceMeasurement } from '@ai-usage/report-core/provenance';
import type {
  SessionPresentationRow,
  SessionQueryRequest,
  SessionQuerySort,
} from '@ai-usage/report-core/session-query';
import { isSessionOrigin, sessionOriginLabel } from '@ai-usage/report-core/session-query';
import { isOriginProvenanceKind } from '@ai-usage/report-core/types';
import {
  buildSessionQuerySqlFilter,
  type SessionQuerySqliteDatabase,
  type SessionQuerySqliteTrace,
} from './session-query-sqlite';

export type FocusedReportQueryResult = FocusedBreakdownResult | FocusedOverviewResult | FocusedSupportResult;

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

interface SummaryRecord {
  actual_cost: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_quota: number | null;
  fresh: number | null;
  fully_priced_cost: number | null;
  partial_price_rows: number | null;
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
  unpriced_fresh_tokens: number | null;
}

interface TimelineRecord {
  cause: string | null;
  cost: number;
  day_key: string;
  first_ordinal: number;
  first_time: number;
  key: string | null;
  label: string | null;
  last_time: number;
  partial_price_rows: number;
  sessions: number;
  unpriced_fresh_tokens: number;
}

interface ModelTimelineRecord extends TimelineRecord {
  day_cost: number;
  day_partial_price_rows: number;
  day_sessions: number;
  day_unpriced_fresh_tokens: number;
  key: string;
  label: string;
}

interface DayRecord {
  cost: number;
  day_key: string;
  first_ordinal: number;
  partial_price_rows: number;
  sessions: number;
  unpriced_fresh_tokens: number;
}

interface OverviewSessionSelectionRecord {
  cost_approx: number;
  cost_known: number;
  duration_ms: number | null;
  item_kind: 'campaign' | 'session';
  item_role: 'longest' | 'top-session';
  row_json: string;
  session_count: number;
}

type SqlFilter = ReturnType<typeof buildSessionQuerySqlFilter>;

const parsePresentationRow = (serialized: string): SessionPresentationRow =>
  JSON.parse(serialized) as SessionPresentationRow;

const priceMeasurementFromSql = (
  knownCost: number,
  partialPriceRows: number,
  unpricedFreshTokens: number,
): ApiPriceMeasurement =>
  apiPriceMeasurement({
    costKnown: partialPriceRows === 0,
    freshTokens: unpricedFreshTokens,
    knownCost,
  });

const summaryFromRecord = (record: SummaryRecord | null): FocusedReportSummary => {
  const pricedSessions = record?.priced_sessions ?? 0;
  const totalCost = record?.total_cost ?? 0;
  return {
    actualCost: record?.actual_cost ?? 0,
    cacheRead: record?.cache_read ?? 0,
    cacheWrite: record?.cache_write ?? 0,
    costQuota: record?.cost_quota ?? 0,
    fresh: record?.fresh ?? 0,
    meanCost: (record?.fully_priced_cost ?? 0) / (pricedSessions || 1),
    priceMeasurement: priceMeasurementFromSql(
      totalCost,
      record?.partial_price_rows ?? 0,
      record?.unpriced_fresh_tokens ?? 0,
    ),
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
      `WITH visible AS (
        SELECT
          ordinal,
          cost_approx,
          cost_known,
          cost_actual,
          cost_quota,
          fresh_tokens,
          tok_cr,
          tok_cw,
          tok_in,
          tok_out,
          rtk_saved_tokens,
          rtk_input_tokens,
          rtk_output_tokens,
          turns,
          tools
        FROM session_rows
        WHERE ${filter.where}
      ),
      price_coverage AS (
        SELECT
          COALESCE(SUM(segments.unpriced_fresh_tokens), 0) AS unpriced_fresh_tokens
        FROM session_model_segments AS segments
        INNER JOIN visible USING (ordinal)
      )
      SELECT
        COUNT(*) AS session_count,
        SUM(cost_approx) AS total_cost,
        SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS fully_priced_cost,
        SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS partial_price_rows,
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
        SUM(tools) AS tools,
        price_coverage.unpriced_fresh_tokens AS unpriced_fresh_tokens
      FROM visible
      CROSS JOIN price_coverage`,
      filter.params,
      trace,
    ),
  );

interface TimelineDimensionProjection {
  cause: string;
  key: string;
  label: string;
}

const timelineDimensionProjection = (
  dimension: FocusedOverviewRequest['timeline']['dimension'],
): TimelineDimensionProjection => {
  // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
  switch (dimension) {
    case 'campaign':
      return {
        cause: 'NULL',
        key: "CASE WHEN session_rows.campaign_key IS NULL THEN 'session:' || session_rows.row_id ELSE 'campaign:' || session_rows.campaign_key END",
        label: 'session_rows.campaign_label',
      };
    case 'harness':
      return { cause: 'NULL', key: 'session_rows.harness', label: 'session_rows.harness' };
    case 'machine':
      return {
        cause: 'NULL',
        key: 'session_rows.machine_id',
        label: "CASE WHEN session_rows.machine_label = '' THEN 'Unknown machine' ELSE session_rows.machine_label END",
      };
    case 'model':
      return { cause: 'NULL', key: 'session_rows.model_key', label: 'session_rows.model_key' };
    case 'origin':
      return {
        cause: 'session_rows.origin_provenance',
        key: 'session_rows.origin',
        label: 'session_rows.origin',
      };
    case 'project':
      return { cause: 'NULL', key: 'session_rows.project_key', label: 'session_rows.project_label' };
    case 'provider':
      return { cause: 'NULL', key: 'session_rows.provider_display', label: 'session_rows.provider_display' };
  }
};

const timelineLabelFromRecord = (
  dimension: FocusedOverviewRequest['timeline']['dimension'],
  key: string,
  label: string,
): string => {
  // biome-ignore lint/style/useDefaultSwitchClause: Exhaustive by type so a future dimension fails compilation.
  switch (dimension) {
    case 'campaign':
    case 'harness':
    case 'machine':
    case 'model':
    case 'project':
    case 'provider':
      return label;
    case 'origin':
      if (!isSessionOrigin(key)) {
        throw new Error('Report revision contains an invalid session origin');
      }
      return sessionOriginLabel(key);
  }
};

const timeForLocalDay = (dayKey: string): number => {
  const time = new Date(`${dayKey}T00:00:00`).getTime();
  if (!Number.isFinite(time)) {
    throw new Error('Report revision contains an invalid local-day aggregate');
  }
  return time;
};

const readModelTimeline = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): { dateDomain: FocusedDateDomain | null; days: FocusedDayAggregate[]; timeline: FocusedTimelineAggregate[] } => {
  const records = executeAll<ModelTimelineRecord>(
    database,
    `WITH segment_coverage AS (
      SELECT
        ordinal,
        MAX(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS partial_price_rows,
        SUM(unpriced_fresh_tokens) AS unpriced_fresh_tokens
      FROM session_model_segments
      GROUP BY ordinal
    ),
    visible AS (
      SELECT
        session_rows.ordinal,
        active_time,
        cost_approx,
        cost_known,
        model_key AS primary_model_key,
        segment_coverage.partial_price_rows,
        segment_coverage.unpriced_fresh_tokens
      FROM session_rows
      INNER JOIN segment_coverage USING (ordinal)
      WHERE ${filter.where} AND active_time IS NOT NULL
    ),
    timeline AS (
      SELECT
        strftime('%Y-%m-%d', visible.active_time / 1000, 'unixepoch', 'localtime') AS day_key,
        segments.model_key AS key,
        segments.model_key AS label,
        SUM(segments.cost_approx) AS cost,
        MAX(CASE WHEN segments.cost_known = 0 THEN 1 ELSE 0 END) AS partial_price_rows,
        SUM(segments.unpriced_fresh_tokens) AS unpriced_fresh_tokens,
        SUM(
          CASE
            WHEN segments.model_key = visible.primary_model_key THEN 1
            WHEN segments.segment_position = 0 AND NOT EXISTS (
              SELECT 1
              FROM session_model_segments AS primary_segment
              WHERE primary_segment.ordinal = visible.ordinal
                AND primary_segment.model_key = visible.primary_model_key
            ) THEN 1
            ELSE 0
          END
        ) AS sessions,
        MIN(visible.active_time) AS first_time,
        MAX(visible.active_time) AS last_time,
        MIN(visible.ordinal) AS first_ordinal
      FROM visible
      INNER JOIN session_model_segments AS segments USING (ordinal)
      GROUP BY day_key, segments.model_key
    ),
    days AS (
      SELECT
        strftime('%Y-%m-%d', active_time / 1000, 'unixepoch', 'localtime') AS day_key,
        SUM(cost_approx) AS day_cost,
        MAX(partial_price_rows) AS day_partial_price_rows,
        SUM(unpriced_fresh_tokens) AS day_unpriced_fresh_tokens,
        COUNT(*) AS day_sessions
      FROM visible
      GROUP BY day_key
    )
    SELECT
      timeline.*,
      days.day_cost,
      days.day_partial_price_rows,
      days.day_sessions,
      days.day_unpriced_fresh_tokens
    FROM timeline
    INNER JOIN days USING (day_key)
    ORDER BY timeline.first_ordinal`,
    filter.params,
    trace,
  );
  const byDay = new Map<string, FocusedDayAggregate>();
  const timeline = records.map(
    ({
      cost,
      day_cost: dayCost,
      day_key: dayKey,
      day_partial_price_rows: dayPartialPriceRows,
      day_sessions: daySessions,
      day_unpriced_fresh_tokens: dayUnpricedFreshTokens,
      key,
      label,
      partial_price_rows: partialPriceRows,
      sessions,
      unpriced_fresh_tokens: unpricedFreshTokens,
    }) => {
      const time = timeForLocalDay(dayKey);
      if (!byDay.has(dayKey)) {
        byDay.set(dayKey, {
          cost: dayCost,
          priceMeasurement: priceMeasurementFromSql(dayCost, dayPartialPriceRows, dayUnpricedFreshTokens),
          sessions: daySessions,
          time,
        });
      }
      return {
        cost,
        key,
        kind: 'series' as const,
        label,
        priceMeasurement: priceMeasurementFromSql(cost, partialPriceRows, unpricedFreshTokens),
        sessions,
        time,
      };
    },
  );
  return {
    dateDomain: buildFocusedDateDomain(records.flatMap(({ first_time, last_time }) => [first_time, last_time])),
    days: [...byDay.values()],
    timeline,
  };
};

const readTimeline = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  dimension: FocusedOverviewRequest['timeline']['dimension'],
  trace?: SessionQuerySqliteTrace,
): { dateDomain: FocusedDateDomain | null; days: FocusedDayAggregate[]; timeline: FocusedTimelineAggregate[] } => {
  if (dimension === 'model') {
    return readModelTimeline(database, filter, trace);
  }
  const projection = timelineDimensionProjection(dimension);
  const records = executeAll<TimelineRecord>(
    database,
    `WITH segment_coverage AS (
      SELECT
        ordinal,
        MAX(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS partial_price_rows,
        SUM(unpriced_fresh_tokens) AS unpriced_fresh_tokens
      FROM session_model_segments
      GROUP BY ordinal
    ),
    visible AS (
      SELECT
        session_rows.ordinal,
        session_rows.active_time,
        ${projection.key} AS timeline_key,
        ${projection.label} AS timeline_label,
        ${projection.cause} AS origin_cause,
        session_rows.cost_approx,
        segment_coverage.partial_price_rows,
        segment_coverage.unpriced_fresh_tokens
      FROM session_rows
      INNER JOIN segment_coverage USING (ordinal)
      WHERE ${filter.where} AND active_time IS NOT NULL
    )
    SELECT
      strftime('%Y-%m-%d', active_time / 1000, 'unixepoch', 'localtime') AS day_key,
      timeline_key AS key,
      MIN(timeline_label) AS label,
      MIN(origin_cause) AS cause,
      SUM(cost_approx) AS cost,
      MAX(partial_price_rows) AS partial_price_rows,
      SUM(unpriced_fresh_tokens) AS unpriced_fresh_tokens,
      COUNT(*) AS sessions,
      MIN(active_time) AS first_time,
      MAX(active_time) AS last_time,
      MIN(ordinal) AS first_ordinal
    FROM visible
    GROUP BY day_key, timeline_key, origin_cause
    ORDER BY first_ordinal`,
    filter.params,
    trace,
  );
  const byDay = new Map<string, FocusedDayAggregate>();
  const timeline = records.map(
    ({
      cause,
      cost,
      day_key: dayKey,
      key,
      label,
      partial_price_rows: partialPriceRows,
      sessions,
      unpriced_fresh_tokens,
    }) => {
      const time = timeForLocalDay(dayKey);
      const priceMeasurement = priceMeasurementFromSql(cost, partialPriceRows, unpriced_fresh_tokens);
      const day = byDay.get(dayKey) ?? {
        cost: 0,
        priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 }),
        sessions: 0,
        time,
      };
      day.cost += cost;
      day.priceMeasurement = apiPriceMeasurement({
        costKnown:
          day.priceMeasurement.state !== 'partially measured' && priceMeasurement.state !== 'partially measured',
        freshTokens: day.priceMeasurement.unpricedFreshTokens + priceMeasurement.unpricedFreshTokens,
        knownCost: day.priceMeasurement.knownCost + priceMeasurement.knownCost,
      });
      day.sessions += sessions;
      byDay.set(dayKey, day);
      if (dimension === 'origin' && key === null) {
        if (cause !== null && !isOriginProvenanceKind(cause)) {
          throw new Error('Report revision contains an invalid origin provenance kind');
        }
        return {
          ...(cause === null ? {} : { cause }),
          cost,
          kind: 'unclassified' as const,
          priceMeasurement,
          sessions,
          time,
        };
      }
      if (key === null || label === null) {
        throw new Error('Report revision contains an invalid timeline aggregate');
      }
      return {
        cost,
        key,
        kind: 'series' as const,
        label: timelineLabelFromRecord(dimension, key, label),
        priceMeasurement,
        sessions,
        time,
      };
    },
  );
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
    `WITH segment_coverage AS (
      SELECT
        ordinal,
        MAX(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS partial_price_rows,
        SUM(unpriced_fresh_tokens) AS unpriced_fresh_tokens
      FROM session_model_segments
      GROUP BY ordinal
    ),
    visible AS (
      SELECT
        session_rows.ordinal,
        session_rows.active_time,
        session_rows.cost_approx,
        segment_coverage.partial_price_rows,
        segment_coverage.unpriced_fresh_tokens
      FROM session_rows
      INNER JOIN segment_coverage USING (ordinal)
      WHERE ${filter.where} AND active_time IS NOT NULL
    )
    SELECT
      strftime('%Y-%m-%d', active_time / 1000, 'unixepoch', 'localtime') AS day_key,
      SUM(cost_approx) AS cost,
      MAX(partial_price_rows) AS partial_price_rows,
      SUM(unpriced_fresh_tokens) AS unpriced_fresh_tokens,
      COUNT(*) AS sessions,
      MIN(ordinal) AS first_ordinal
    FROM visible
    GROUP BY day_key
    ORDER BY first_ordinal`,
    filter.params,
    trace,
  ).map(({ cost, day_key: dayKey, partial_price_rows, sessions, unpriced_fresh_tokens }) => ({
    cost,
    priceMeasurement: priceMeasurementFromSql(cost, partial_price_rows, unpriced_fresh_tokens),
    sessions,
    time: timeForLocalDay(dayKey),
  }));

const overviewSessionItemFromRecord = (record: OverviewSessionSelectionRecord): FocusedOverviewSessionItem => {
  const row = parsePresentationRow(record.row_json);
  return {
    costApprox: record.cost_approx,
    costKnown: record.cost_known === 1,
    durationMs: record.duration_ms,
    harness: row.harness,
    kind: record.item_kind,
    label: row.sessionLabel,
    row,
    sessionCount: record.session_count,
  };
};

const readOverviewSessionSelections = (
  database: SessionQuerySqliteDatabase,
  filter: SqlFilter,
  trace?: SessionQuerySqliteTrace,
): { longest: FocusedOverviewSessionItem | null; topSessions: FocusedOverviewSessionItem[] } => {
  const records = executeAll<OverviewSessionSelectionRecord>(
    database,
    `WITH visible AS (
      SELECT ordinal, row_json, campaign_key, cost_known, cost_approx, duration_ms
      FROM session_rows
      WHERE ${filter.where}
    ),
    campaign_rollup AS (
      SELECT * FROM visible
      UNION ALL
      SELECT ordinal, row_json, campaign_key, cost_known, cost_approx, duration_ms
      FROM session_rows AS classifier
      WHERE classifier.origin = 'classifier'
        AND classifier.ordinal NOT IN (SELECT ordinal FROM visible)
        AND classifier.campaign_key IN (
          SELECT campaign_key
          FROM visible
          WHERE campaign_key IS NOT NULL
        )
    ),
    items AS (
      SELECT
        'campaign' AS item_kind,
        root.row_json AS row_json,
        SUM(rollup.cost_approx) AS cost_approx,
        MIN(rollup.cost_known) AS cost_known,
        MAX(root.duration_ms) AS duration_ms,
        (
          SELECT COUNT(*)
          FROM visible AS matched
          WHERE matched.campaign_key = rollup.campaign_key
        ) AS session_count,
        0 AS kind_order,
        MIN(rollup.ordinal) AS item_ordinal
      FROM campaign_rollup AS rollup
      INNER JOIN session_rows AS root
        ON root.campaign_key = rollup.campaign_key AND root.campaign_root = 1
      WHERE rollup.campaign_key IS NOT NULL
      GROUP BY rollup.campaign_key
      UNION ALL
      SELECT
        'session' AS item_kind,
        row_json,
        cost_approx,
        cost_known,
        duration_ms,
        1 AS session_count,
        1 AS kind_order,
        ordinal AS item_ordinal
      FROM visible
      WHERE campaign_key IS NULL
    ),
    top_sessions AS (
      SELECT *
      FROM items
      WHERE cost_approx > 0
      ORDER BY cost_approx DESC, kind_order ASC, item_ordinal ASC
      LIMIT 5
    ),
    longest_item AS (
      SELECT *
      FROM items
      WHERE duration_ms > 0
      ORDER BY duration_ms DESC, kind_order ASC, item_ordinal ASC
      LIMIT 1
    )
    SELECT
      'top-session' AS item_role,
      item_kind,
      row_json,
      cost_approx,
      cost_known,
      duration_ms,
      session_count,
      kind_order,
      item_ordinal,
      0 AS role_order
    FROM top_sessions
    UNION ALL
    SELECT
      'longest' AS item_role,
      item_kind,
      row_json,
      cost_approx,
      cost_known,
      duration_ms,
      session_count,
      kind_order,
      item_ordinal,
      1 AS role_order
    FROM longest_item
    ORDER BY role_order ASC, cost_approx DESC, kind_order ASC, item_ordinal ASC`,
    filter.params,
    trace,
  );
  const topSessions = records.filter((record) => record.item_role === 'top-session').map(overviewSessionItemFromRecord);
  const longestRecord = records.find((record) => record.item_role === 'longest');
  return {
    longest: longestRecord ? overviewSessionItemFromRecord(longestRecord) : null,
    topSessions,
  };
};

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
    `SELECT row_json FROM session_rows ORDER BY ordinal LIMIT ${MAX_PORTABLE_USAGE_ROWS + 1}`,
    [],
    trace,
  );
  if (rowsWithSentinel.length > MAX_PORTABLE_USAGE_ROWS) {
    throw new Error(`Advanced Overview exceeds the ${MAX_PORTABLE_USAGE_ROWS}-row snapshot ceiling`);
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
  const sessionSelections = readOverviewSessionSelections(database, visibleFilter, trace);
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
        sessionSelections.topSessions[0] ?? null,
        sessionSelections.longest,
        visibleDays,
        timelineAggregates.days,
      ),
      sessionShape: null,
      topSessions: sessionSelections.topSessions,
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
  priced_cost_sum: number;
  provider: string;
  sessions: number;
  tools: number;
  total_cost: number;
  turns: number;
  unpriced: number;
  unpriced_fresh_tokens: number;
  usage_unavailable: number;
}

interface ProjectAggregateRecord {
  cache: number;
  cost: number;
  first_ordinal: number;
  fresh: number;
  key: string;
  label: string;
  lines_added: number;
  lines_deleted: number;
  measured_sessions: number;
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
    costPer100Lines: lineCount && record.priced ? (record.priced_cost_sum / lineCount) * 100 : null,
    costPercent: record.total_cost > 0 ? (record.cost_sum / record.total_cost) * 100 : 0,
    costPerSession: record.priced ? record.priced_cost_sum / record.priced : null,
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
    unpricedFreshTokens: record.unpriced_fresh_tokens,
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
        unpriced_fresh_tokens,
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
      SELECT
        'harness' AS kind,
        harness AS key,
        ordinal,
        harness,
        provider,
        cost_known,
        cost_approx,
        usage_unavailable,
        sort_ambiguous,
        fresh_tokens,
        unpriced_fresh_tokens,
        tok_in,
        tok_cr,
        lines_added,
        lines_deleted,
        turns,
        tools
      FROM filtered
      UNION ALL
      SELECT
        'provider' AS kind,
        provider_display AS key,
        ordinal,
        harness,
        provider,
        cost_known,
        cost_approx,
        usage_unavailable,
        sort_ambiguous,
        fresh_tokens,
        unpriced_fresh_tokens,
        tok_in,
        tok_cr,
        lines_added,
        lines_deleted,
        turns,
        tools
      FROM filtered
      UNION ALL
      SELECT
        'model' AS kind,
        segments.model_key AS key,
        filtered.ordinal,
        filtered.harness,
        filtered.provider,
        segments.cost_known,
        segments.cost_approx,
        filtered.usage_unavailable,
        filtered.sort_ambiguous,
        segments.tok_in + segments.tok_out + segments.tok_cw AS fresh_tokens,
        segments.unpriced_fresh_tokens,
        segments.tok_in,
        segments.tok_cr,
        0 AS lines_added,
        0 AS lines_deleted,
        0 AS turns,
        0 AS tools
      FROM filtered
      INNER JOIN session_model_segments AS segments USING (ordinal)
    ),
    grouped AS (
      SELECT
        kind,
        key,
        MIN(ordinal) AS first_ordinal,
        COUNT(*) AS sessions,
        SUM(cost_known) AS priced,
        COUNT(*) - SUM(cost_known) AS unpriced,
        SUM(unpriced_fresh_tokens) AS unpriced_fresh_tokens,
        SUM(usage_unavailable) AS usage_unavailable,
        SUM(sort_ambiguous) AS ambiguous,
        SUM(fresh_tokens) AS fresh,
        SUM(tok_in) AS inp,
        SUM(tok_cr) AS cache,
        SUM(CASE WHEN cost_known = 1 OR kind = 'model' THEN cost_approx ELSE 0 END) AS cost_sum,
        SUM(CASE WHEN cost_known = 1 THEN cost_approx ELSE 0 END) AS priced_cost_sum,
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
    ORDER BY grouped.kind, grouped.cost_sum DESC, grouped.key ASC`,
    filter.params,
    trace,
  );
  const groups = records.map(analyticsGroupFromRecord);
  const groupsForKind = (kind: AnalyticsAggregateRecord['kind']): AnalyticsGroup[] =>
    groups
      .filter((_, index) => records[index]?.kind === kind)
      .sort((left, right) => right.costSum - left.costSum || compareAnalyticsKeys(left.key, right.key));
  return {
    harnesses: groupsForKind('harness'),
    models: groupsForKind('model'),
    providers: groupsForKind('provider'),
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
      MIN(project_label) AS label,
      MIN(ordinal) AS first_ordinal,
      COUNT(*) AS sessions,
      SUM(fresh_tokens) AS fresh,
      SUM(tok_cr) AS cache,
      SUM(turns) AS turns,
      SUM(tools) AS tools,
      SUM(CASE WHEN lines_added IS NOT NULL AND lines_deleted IS NOT NULL THEN lines_added ELSE 0 END) AS lines_added,
      SUM(CASE WHEN lines_added IS NOT NULL AND lines_deleted IS NOT NULL THEN lines_deleted ELSE 0 END) AS lines_deleted,
      SUM(CASE WHEN lines_added IS NOT NULL AND lines_deleted IS NOT NULL THEN 1 ELSE 0 END) AS measured_sessions,
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
    label: record.label,
    lineMeasurement: {
      measuredSessions: record.measured_sessions,
      totalSessions: record.sessions,
    },
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
      COUNT(DISTINCT CASE WHEN machine_id <> '' THEN machine_id END) AS machine_count,
      COUNT(DISTINCT provider_scope_key) AS provider_scope_count
    FROM session_rows`,
    [],
    trace,
  ) ?? { first_time: null, harness_count: 0, last_time: null, machine_count: 0, provider_scope_count: 0 };
  const options = executeAll<{ kind: 'harness' | 'machine'; label: string; value: string }>(
    database,
    `SELECT 'harness' AS kind, harness AS label, harness AS value FROM (
       SELECT DISTINCT harness FROM session_rows ORDER BY harness LIMIT 100
     )
     UNION ALL
     SELECT 'machine' AS kind, label, value FROM (
       SELECT machine_id AS value, COALESCE(MIN(NULLIF(machine_label, '')), machine_id) AS label
       FROM session_rows WHERE machine_id <> '' GROUP BY machine_id ORDER BY label, value LIMIT 100
     )`,
    [],
    trace,
  );
  const harness = options.filter(({ kind }) => kind === 'harness').map(({ value }) => value);
  const machine = options.filter(({ kind }) => kind === 'machine').map(({ label, value }) => ({ label, value }));
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
  return runSupport(database, parseFocusedRevisionRequest(request), trace);
};
