import fs from 'node:fs';
import { chmod, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { providerStatusKeyForUsage, providerStatusScopeKey } from '@ai-usage/report-core/provider-status';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import {
  buildSessionCampaignViews,
  compareSessionIdentityValues,
  compareSessionTextValues,
  enrichSessionPresentationRow,
  type SessionCampaignView,
  type SessionPresentationRow,
  type SessionTextSortField,
  sessionSortFields,
  sessionTextSortFields,
  sortValueForSessionColumn,
} from '@ai-usage/report-core/session-query';

export const SESSION_QUERY_DATABASE_NAME = 'sessions.sqlite';

const SESSION_QUERY_SCHEMA_VERSION = 3;
const SESSION_ROW_INSERT_VALUE_COUNT = 74;
const createFileFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

interface SqliteStatement {
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
}

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  if (!path.isAbsolute(directory)) {
    throw new Error('Report revision directory must be absolute');
  }
  const directoryStat = await stat(directory);
  if (
    !(
      directoryStat.isDirectory() &&
      hasOwnerOnlyPermissions(directoryStat.mode) &&
      isOwnedByCurrentUser(directoryStat.uid)
    )
  ) {
    throw new Error('Report revision directory must be private and owned by the current user');
  }
};

const createDatabaseFile = async (databasePath: string): Promise<void> => {
  const handle = await open(databasePath, createFileFlags, 0o600);
  await handle.close();
};

const syncDatabaseFile = async (databasePath: string): Promise<void> => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  const handle = await open(databasePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const createSchema = (database: SqliteDatabase): void => {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE metadata (
      schema_version INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      support_json TEXT NOT NULL
    );
    CREATE TABLE session_rows (
      ordinal INTEGER PRIMARY KEY,
      row_id TEXT NOT NULL,
      row_json TEXT NOT NULL,
      source_row_json TEXT NOT NULL,
      active_date TEXT,
      active_time INTEGER,
      search_text TEXT NOT NULL,
      harness TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      machine_label TEXT NOT NULL,
      provider_scope_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_display TEXT NOT NULL,
      model_key TEXT NOT NULL,
      project_key TEXT NOT NULL,
      campaign_key TEXT,
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
      line_delta REAL,
      lines_added REAL,
      lines_deleted REAL,
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
      usage_unavailable INTEGER NOT NULL CHECK (usage_unavailable IN (0, 1))
    );
    CREATE INDEX session_rows_campaign ON session_rows(campaign_key, campaign_root, ordinal);
    CREATE INDEX session_rows_row_id ON session_rows(row_id, ordinal);
    CREATE INDEX session_rows_active_time ON session_rows(active_time);
    CREATE INDEX session_rows_facets ON session_rows(harness, machine_label, provider_display, model_key, project_key);
    CREATE INDEX session_rows_provider_scope ON session_rows(provider_scope_key, ordinal);
  `);
};

const insertSql = `
  INSERT INTO session_rows (
    ordinal, row_id, row_json, source_row_json, active_date, active_time, search_text, harness, machine_id, machine_label,
    provider_scope_key, provider, provider_display, model_key, project_key, campaign_key, campaign_root, campaign_total_count,
    ${sessionSortFields.map((field) => `sort_${field === 'cache' ? 'cache' : field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`).join(', ')},
    ${sessionTextSortFields.map((field) => `sort_${field}_rank`).join(', ')},
    row_identity_rank, session_item_identity_rank, campaign_item_identity_rank,
    cost_actual, cost_approx, cost_known, cost_quota, duration_ms, fresh_tokens, line_delta,
    lines_added, lines_deleted, rtk_command_count, rtk_input_tokens, rtk_output_tokens,
    rtk_saved_tokens, tok_cr, tok_cw, tok_in, tok_out, token_total, calls, turns, tools,
    usage_unavailable
  ) VALUES (${Array.from({ length: SESSION_ROW_INSERT_VALUE_COUNT }, () => '?').join(', ')})
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
    throw new Error(`Session query materialization omitted the ${label} rank`);
  }
  return rank;
};

const buildMaterializedSessionRanks = (
  rows: SessionPresentationRow[],
  campaigns: SessionCampaignView[],
): MaterializedSessionRanks => {
  const text = new Map<SessionTextSortField, ReadonlyMap<string, number>>();
  for (const field of sessionTextSortFields) {
    const values = rows.map((row) => String(sortValueForSessionColumn(row, field)));
    text.set(field, buildValueRanks(values, compareSessionTextValues));
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

const insertRow = (
  insert: SqliteStatement,
  row: SessionPresentationRow,
  sourceRow: SerializedRow,
  ordinal: number,
  campaign: { key: string; root: boolean; totalCount: number } | undefined,
  ranks: MaterializedSessionRanks,
): void => {
  const sortValues = sessionSortFields.map((field) => sortValueForSessionColumn(row, field));
  const textSortRanks = sessionTextSortFields.map((field) => {
    const value = String(sortValueForSessionColumn(row, field));
    return requireRank(ranks.text.get(field), value, `${field} sort`);
  });
  const machineId = row.source?.machineId ?? '';
  const providerKey = providerStatusKeyForUsage(row.harness, row.provider);
  insert.run(
    ordinal,
    row.rowId,
    JSON.stringify(row),
    JSON.stringify(sourceRow),
    row.activeDate,
    row.activeTime,
    row.searchText,
    row.harness,
    machineId,
    row.source?.machineLabel ?? '',
    providerStatusScopeKey(providerKey, machineId || undefined),
    row.provider,
    row.providerDisplay,
    row.modelKey,
    row.projectKey,
    campaign?.key ?? null,
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
    row.lineDelta,
    row.linesAdded,
    row.linesDeleted,
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
};

/**
 * Builds the query-only SQLite artifact while a revision is still private and
 * unpublished. The caller must publish the revision directory only after this
 * promise resolves and must include this file in its immutable manifest.
 */
export const materializeSessionQueryDatabase = async (
  revisionDirectory: string,
  rows: SerializedRow[],
  support: FocusedReportSupport = {
    analytics: {
      averageDurationMs: null,
      byHarness: [],
      byModel: [],
      byProvider: [],
      costPer100Lines: null,
      durationMs: 0,
      durationRows: 0,
      lineCount: 0,
      linesA: 0,
      linesD: 0,
      meanCost: 0,
      medianCost: 0,
      pricedCount: 0,
      recentSessions: 0,
      sessionCount: 0,
      tools: 0,
      totalCost: 0,
      turns: 0,
      unpricedCount: 0,
    },
    filters: { limit: null, minTokens: 0, project: null, since: null, sort: 'date' },
    generatedAt: new Date(0).toISOString(),
    omittedRows: 0,
  },
): Promise<string> => {
  await ensurePrivateDirectory(revisionDirectory);
  const databasePath = path.join(revisionDirectory, SESSION_QUERY_DATABASE_NAME);
  await createDatabaseFile(databasePath);
  let database: SqliteDatabase | undefined;
  try {
    const { Database } = await import('bun:sqlite');
    database = new Database(databasePath, { create: false, strict: true }) as SqliteDatabase;
    createSchema(database);
    const presentationRows = rows.map(enrichSessionPresentationRow);
    const campaignByRow = new Map<SessionPresentationRow, { key: string; root: boolean; totalCount: number }>();
    const campaigns = buildSessionCampaignViews(presentationRows, presentationRows);
    for (const campaign of campaigns) {
      for (const campaignRow of campaign.allRows) {
        campaignByRow.set(campaignRow, {
          key: campaign.campaignKey,
          root: campaignRow === campaign.root,
          totalCount: campaign.totalCount,
        });
      }
    }
    const ranks = buildMaterializedSessionRanks(presentationRows, campaigns);

    const insert = database.query(insertSql);
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const [ordinal, row] of presentationRows.entries()) {
        insertRow(insert, row, rows[ordinal]!, ordinal, campaignByRow.get(row), ranks);
      }
      database
        .query('INSERT INTO metadata (schema_version, row_count, support_json) VALUES (?, ?, ?)')
        .run(SESSION_QUERY_SCHEMA_VERSION, rows.length, JSON.stringify(support));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.exec('PRAGMA optimize');
    database.close();
    database = undefined;
    await chmod(databasePath, 0o600);
    await syncDatabaseFile(databasePath);
    return databasePath;
  } catch (error) {
    database?.close();
    await Promise.all(
      ['', '-journal', '-shm', '-wal'].map((suffix) => rm(`${databasePath}${suffix}`, { force: true })),
    );
    throw error;
  }
};
