import {
  type FocusedReportSupport,
  type FocusedSupportResult,
  parseFocusedReportSupport,
} from '@ai-usage/report-core/focused-report-query';
import { MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import { type ProjectGroupConfig, parseProjectGroupConfigs } from '@ai-usage/report-core/project-group';
import {
  MAX_REPORT_RUNNER_ARTIFACT_BYTES,
  MAX_SESSION_QUERY_DATABASE_BYTES,
} from '@ai-usage/report-core/report-budgets';
import { reportCaptureFingerprintForPayload } from '@ai-usage/report-core/report-capture-fingerprint';
import { isSerializedUsageRow, type SerializedRow } from '@ai-usage/report-core/report-data';
import type { SessionDetailSourceAuthority } from '@ai-usage/report-core/session-detail';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';
import { UsageStoreError, type UsageStoreErrorReason } from './errors';
import type {
  CurrentServedLocalProjectSources,
  PublishServedReportRevisionCapture,
  PublishServedReportRevisionInput,
  PublishServedReportRevisionResult,
  QueryServedReportRevisionInput,
  QueryServedReportRevisionLocalSnapshotInput,
  QueryServedRevisionDataInput,
  RetainServedReportRevisionsInput,
  RetainServedReportRevisionsResult,
  ServedLocalProjectSource,
  ServedReportPublicationPhase,
  ServedReportReadPhase,
  ServedReportRevisionBootstrap,
  ServedReportRevisionLocalSnapshot,
  ServedReportRevisionManifest,
  ServedReportRevisionPortableConfig,
  ServedReportRevisionRows,
  ServedReportRevisionSlices,
  ServedReportRevisionSupport,
  UsageStoreGenerations,
} from './index';
import {
  executeServedRevisionQuery,
  parseServedRevisionQuery,
  type ServedRevisionQueryResult,
  validateServedRevisionQueryCatalog,
} from './served-query-catalog';
import {
  createServedRevisionQueryDatabase,
  insertServedReportProjection,
  SERVED_REPORT_PROJECTION_SCHEMA_VERSION,
  SERVED_REPORT_REVISION_PATTERN,
  type ServedRevisionReadDatabase,
} from './served-revision';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  finalize(): void;
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  clearStatements(): void;
  close(throwOnError?: boolean): void;
  exec(sql: string): unknown;
  readonly inTransaction: boolean;
  query(sql: string): SqliteStatement;
}

interface ServedReportRevisionReadContext {
  readonly database: ServedRevisionReadDatabase;
  readonly manifest: ServedReportRevisionManifest;
  readonly revision: string;
  readonly storeDatabase: SqliteDatabase;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface ServedReportStoreDependencies {
  readonly readUsageLocalMachineWithDatabase: (database: SqliteDatabase, dbPath: string) => UsageMachine;
  readonly readUsageStoreGenerations: (database: SqliteDatabase) => UsageStoreGenerations;
  readonly usageStoreError: (
    operation: string,
    dbPath: string,
    cause: unknown,
    reason: UsageStoreErrorReason,
  ) => UsageStoreError;
  readonly usageStoreServedReadError: (operation: string, dbPath: string, cause: unknown) => UsageStoreError;
  readonly withUsageStoreReader: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
  readonly withUsageStoreWriter: <Value>(
    dbPath: string,
    use: (database: SqliteDatabase) => Effect.Effect<Value, UsageStoreError>,
  ) => Effect.Effect<Value, UsageStoreError>;
}

export const createServedReportStore = (dependencies: ServedReportStoreDependencies) => {
  const {
    readUsageLocalMachineWithDatabase,
    readUsageStoreGenerations,
    usageStoreError,
    usageStoreServedReadError,
    withUsageStoreReader,
    withUsageStoreWriter,
  } = dependencies;

  interface ServedReportRevisionRecord {
    capture_fingerprint: string;
    complete: number;
    config_fingerprint: string;
    expires_at: number;
    filter_key_count: number;
    generated_at: string;
    is_current: number;
    machine_fleet_generation: number;
    private_capture_fingerprint: string;
    projection_bytes: number;
    projection_schema_version: number;
    published_at: number;
    revision: string;
    row_count: number;
    rows_bytes: number;
    segment_count: number;
    support_bytes: number;
    usage_store_generation: number;
  }

  interface ServedReportProjectionCountsRecord {
    context_bytes: number | null;
    context_count: number;
    filter_key_count: number;
    row_count: number;
    segment_count: number;
    support_bytes: number | null;
    support_count: number;
  }

  interface ServedReportLocalContextRecord {
    context_bytes: number;
    context_json: string;
    machine_id: string;
    machine_label: string;
  }

  interface ServedReportLocalContext {
    readonly machine: UsageMachine;
    readonly projectAliases: readonly ProjectAliasEntry[];
    readonly projectGroupConfigs: readonly ProjectGroupConfig[];
  }

  const DEFAULT_SERVED_REPORT_REVISION_TTL_MS = 5 * 60 * 1000;
  const DEFAULT_SERVED_REPORT_RENEWAL_WINDOW_MS = 60_000;
  const DEFAULT_MAXIMUM_SERVED_REPORT_REVISIONS = 3;
  const DEFAULT_MAXIMUM_SERVED_REPORT_ROWS = MAX_PORTABLE_USAGE_ROWS * DEFAULT_MAXIMUM_SERVED_REPORT_REVISIONS;
  const DEFAULT_MAXIMUM_SERVED_REPORT_BYTES =
    (MAX_REPORT_RUNNER_ARTIFACT_BYTES + MAX_SESSION_QUERY_DATABASE_BYTES) * DEFAULT_MAXIMUM_SERVED_REPORT_REVISIONS;
  const DEFAULT_ABANDONED_SERVED_REPORT_REVISION_MS = 5 * 60 * 1000;
  const MAX_SERVED_LOCAL_PROJECT_SOURCES_BYTES = 512 * 1024;
  const isServedUsageMachine = (value: unknown): value is UsageMachine => {
    if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).sort().join(',') === 'id,label' &&
      typeof record.id === 'string' &&
      record.id.length > 0 &&
      typeof record.label === 'string'
    );
  };

  const parseServedProjectAliases = (value: unknown): readonly ProjectAliasEntry[] => {
    if (!Array.isArray(value)) {
      throw new Error('Served report local context contains invalid project aliases');
    }
    return value.map((entry) => {
      if (!(typeof entry === 'object' && entry !== null && !Array.isArray(entry))) {
        throw new Error('Served report local context contains an invalid project alias');
      }
      const record = entry as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'match,name' ||
        typeof record.name !== 'string' ||
        record.name.length === 0 ||
        !Array.isArray(record.match) ||
        record.match.some((pattern) => typeof pattern !== 'string' || pattern.length === 0)
      ) {
        throw new Error('Served report local context contains an invalid project alias');
      }
      return { match: [...record.match] as string[], name: record.name };
    });
  };

  const parseServedReportLocalContext = (value: unknown): ServedReportLocalContext => {
    if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) {
      throw new Error('Served report local context is invalid');
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'machine,projectAliases,projectGroupConfigs') {
      throw new Error('Served report local context contains unknown or missing fields');
    }
    if (!isServedUsageMachine(record.machine)) {
      throw new Error('Served report local context contains an invalid machine');
    }
    return {
      machine: { ...record.machine },
      projectAliases: parseServedProjectAliases(record.projectAliases),
      projectGroupConfigs: parseProjectGroupConfigs(record.projectGroupConfigs).map((group) => ({
        ...group,
        sources: group.sources.map((source) => ({ ...source })),
      })),
    };
  };

  const readServedReportLocalContext = (database: SqliteDatabase, revision: string): ServedReportLocalContext => {
    const record = database
      .query(`
        SELECT context_bytes, context_json, machine_id, machine_label
        FROM served_report_local_context
        WHERE revision = ?
      `)
      .get(revision) as ServedReportLocalContextRecord | null;
    if (!record || Buffer.byteLength(record.context_json) !== record.context_bytes) {
      throw new Error('Served report local context is incomplete or has invalid byte accounting');
    }
    const context = parseServedReportLocalContext(JSON.parse(record.context_json) as unknown);
    if (context.machine.id !== record.machine_id || context.machine.label !== record.machine_label) {
      throw new Error('Served report local context machine identity is inconsistent');
    }
    return context;
  };

  let servedReportPublicationFaultInjector: ((phase: ServedReportPublicationPhase) => void) | undefined;
  let servedReportReadFaultInjector: ((phase: ServedReportReadPhase) => void) | undefined;

  const setServedReportPublicationFaultInjectorForTesting = (
    injector: (phase: ServedReportPublicationPhase) => void,
  ): (() => void) => {
    if (servedReportPublicationFaultInjector) {
      throw new Error('A served report publication fault injector is already active');
    }
    servedReportPublicationFaultInjector = injector;
    return () => {
      if (servedReportPublicationFaultInjector === injector) {
        servedReportPublicationFaultInjector = undefined;
      }
    };
  };

  const setServedReportReadFaultInjectorForTesting = (
    injector: (phase: ServedReportReadPhase) => void,
  ): (() => void) => {
    if (servedReportReadFaultInjector) {
      throw new Error('A served report read fault injector is already active');
    }
    servedReportReadFaultInjector = injector;
    return () => {
      if (servedReportReadFaultInjector === injector) {
        servedReportReadFaultInjector = undefined;
      }
    };
  };

  const visitPublicationPhase = (phase: ServedReportPublicationPhase): void => {
    servedReportPublicationFaultInjector?.(phase);
  };

  const visitServedReportReadPhase = (phase: ServedReportReadPhase): void => {
    servedReportReadFaultInjector?.(phase);
  };

  const isSafeNonNegativeInteger = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;

  const manifestFromServedRevisionRecord = (record: ServedReportRevisionRecord): ServedReportRevisionManifest => {
    if (
      !(
        SERVED_REPORT_REVISION_PATTERN.test(record.revision) &&
        SHA256_PATTERN.test(record.capture_fingerprint) &&
        SHA256_PATTERN.test(record.config_fingerprint) &&
        Number.isFinite(Date.parse(record.generated_at)) &&
        isSafeNonNegativeInteger(record.expires_at) &&
        isSafeNonNegativeInteger(record.machine_fleet_generation) &&
        isSafeNonNegativeInteger(record.projection_bytes) &&
        isSafeNonNegativeInteger(record.published_at) &&
        isSafeNonNegativeInteger(record.row_count) &&
        isSafeNonNegativeInteger(record.rows_bytes) &&
        isSafeNonNegativeInteger(record.support_bytes) &&
        isSafeNonNegativeInteger(record.usage_store_generation) &&
        SHA256_PATTERN.test(record.private_capture_fingerprint) &&
        record.expires_at >= record.published_at &&
        record.projection_schema_version === SERVED_REPORT_PROJECTION_SCHEMA_VERSION &&
        record.complete === 1
      )
    ) {
      throw new Error('Served report revision metadata is invalid');
    }
    return {
      captureFingerprint: record.capture_fingerprint,
      expiresAt: record.expires_at,
      generatedAt: record.generated_at,
      machineFleetGeneration: record.machine_fleet_generation,
      projectionBytes: record.projection_bytes,
      publishedAt: record.published_at,
      revision: record.revision,
      rowCount: record.row_count,
      rowsBytes: record.rows_bytes,
      supportBytes: record.support_bytes,
      usageStoreGeneration: record.usage_store_generation,
    };
  };

  const readCurrentServedRevisionRecord = (database: SqliteDatabase): ServedReportRevisionRecord | null =>
    database
      .query(`
        SELECT revisions.*, 1 AS is_current
        FROM served_report_current AS current
        INNER JOIN served_report_revisions AS revisions USING (revision)
        WHERE current.singleton = 1 AND revisions.complete = 1
      `)
      .get() as ServedReportRevisionRecord | null;

  const readExactServedRevisionRecord = (
    database: SqliteDatabase,
    revision: string,
  ): ServedReportRevisionRecord | null =>
    database
      .query(`
        SELECT revisions.*, CASE WHEN current.revision IS NULL THEN 0 ELSE 1 END AS is_current
        FROM served_report_revisions AS revisions
        LEFT JOIN served_report_current AS current
          ON current.singleton = 1 AND current.revision = revisions.revision
        WHERE revisions.revision = ? AND revisions.complete = 1
      `)
      .get(revision) as ServedReportRevisionRecord | null;

  const revisionUnavailableError = (dbPath: string, revision?: string): UsageStoreError =>
    usageStoreError(
      'readServedReportRevision',
      dbPath,
      revision === undefined ? 'No current served report revision is available' : `Revision ${revision} is unavailable`,
      'revision-unavailable',
    );

  const validateServedRevisionCounts = (database: SqliteDatabase, record: ServedReportRevisionRecord): void => {
    const counts = database
      .query(`
        SELECT
          (SELECT COUNT(*) FROM served_report_rows WHERE revision = ?) AS row_count,
          (SELECT COUNT(*) FROM served_session_model_segments WHERE revision = ?) AS segment_count,
          (SELECT COUNT(*) FROM served_session_model_filter_keys WHERE revision = ?) AS filter_key_count,
          (SELECT COUNT(*) FROM served_report_support WHERE revision = ?) AS support_count,
          (SELECT support_bytes FROM served_report_support WHERE revision = ?) AS support_bytes,
          (SELECT COUNT(*) FROM served_report_local_context WHERE revision = ?) AS context_count,
          (SELECT context_bytes FROM served_report_local_context WHERE revision = ?) AS context_bytes
      `)
      .get(
        record.revision,
        record.revision,
        record.revision,
        record.revision,
        record.revision,
        record.revision,
        record.revision,
      ) as ServedReportProjectionCountsRecord | null;
    if (
      !counts ||
      counts.row_count !== record.row_count ||
      counts.segment_count !== record.segment_count ||
      counts.filter_key_count !== record.filter_key_count ||
      counts.support_count !== 1 ||
      counts.support_bytes !== record.support_bytes ||
      counts.context_count !== 1 ||
      counts.context_bytes === null ||
      record.rows_bytes + record.support_bytes + counts.context_bytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES ||
      record.projection_bytes > MAX_SESSION_QUERY_DATABASE_BYTES
    ) {
      throw new Error(`Served report revision ${record.revision} failed count or byte validation`);
    }
  };

  const validateServedRevisionOrphans = (database: SqliteDatabase, revision: string): void => {
    const orphanCount = database
      .query(`
        SELECT
          (SELECT COUNT(*) FROM served_session_model_segments AS segment
            WHERE segment.revision = ? AND NOT EXISTS (
              SELECT 1 FROM served_report_rows AS row
              WHERE row.revision = segment.revision AND row.ordinal = segment.ordinal
            )) +
          (SELECT COUNT(*) FROM served_session_model_filter_keys AS filter_key
            WHERE filter_key.revision = ? AND NOT EXISTS (
              SELECT 1 FROM served_report_rows AS row
              WHERE row.revision = filter_key.revision AND row.ordinal = filter_key.ordinal
            )) AS orphan_count
      `)
      .get(revision, revision) as { orphan_count?: unknown } | null;
    if (orphanCount?.orphan_count !== 0) {
      throw new Error('Served report projection contains orphaned model rows');
    }
  };

  const validateServedRevisionPayload = (database: SqliteDatabase, record: ServedReportRevisionRecord): void => {
    const supportRecord = database
      .query('SELECT support_json FROM served_report_support WHERE revision = ?')
      .get(record.revision) as { support_json?: unknown } | null;
    if (typeof supportRecord?.support_json !== 'string') {
      throw new Error('Served report revision support is incomplete');
    }
    const support = parseFocusedReportSupport(JSON.parse(supportRecord.support_json) as unknown);
    const localContext = readServedReportLocalContext(database, record.revision);
    const rowRecords = database
      .query(`
        SELECT source_authority, source_row_json
        FROM served_report_rows
        WHERE revision = ?
        ORDER BY ordinal
      `)
      .all(record.revision) as Array<{ source_authority?: unknown; source_row_json?: unknown }>;
    const rows: SerializedRow[] = [];
    const sourceAuthorities: SessionDetailSourceAuthority[] = [];
    for (const rowRecord of rowRecords) {
      const sourceAuthority =
        rowRecord.source_authority === 'local-observed' || rowRecord.source_authority === 'portable-opaque'
          ? rowRecord.source_authority
          : undefined;
      if (typeof rowRecord.source_row_json !== 'string' || sourceAuthority === undefined) {
        throw new Error('Served report revision contains invalid source material');
      }
      const row: unknown = JSON.parse(rowRecord.source_row_json);
      if (!isSerializedUsageRow(row)) {
        throw new Error('Served report revision contains an invalid serialized row');
      }
      rows.push(row);
      sourceAuthorities.push(sourceAuthority);
    }
    const payload = { ...support, rows };
    if (
      Buffer.byteLength(JSON.stringify(rows)) !== record.rows_bytes ||
      Buffer.byteLength(supportRecord.support_json) !== record.support_bytes ||
      reportCaptureFingerprintForPayload(payload) !== record.capture_fingerprint ||
      reportCaptureFingerprintForPayload({ ...payload, localContext }, sourceAuthorities) !==
        record.private_capture_fingerprint
    ) {
      throw new Error('Served report revision payload does not match its manifest');
    }
  };

  const readServedReportRevision = <Result>(
    input: QueryServedReportRevisionInput,
    read: (context: ServedReportRevisionReadContext) => Result,
  ): Effect.Effect<Result, UsageStoreError> =>
    withUsageStoreReader(input.dbPath, (database) =>
      Effect.try({
        try: () => {
          database.exec('BEGIN');
          try {
            if (input.revision !== undefined && !SERVED_REPORT_REVISION_PATTERN.test(input.revision)) {
              throw revisionUnavailableError(input.dbPath, input.revision);
            }
            const record =
              input.revision === undefined
                ? readCurrentServedRevisionRecord(database)
                : readExactServedRevisionRecord(database, input.revision);
            if (!record) {
              throw revisionUnavailableError(input.dbPath, input.revision);
            }
            const now = input.now ?? Date.now();
            if (!isSafeNonNegativeInteger(now)) {
              throw usageStoreError(
                'readServedReportRevision',
                input.dbPath,
                'Revision read time must be a non-negative safe integer',
                'invalid-input',
              );
            }
            if (record.is_current !== 1 && record.expires_at <= now) {
              throw usageStoreError(
                'readServedReportRevision',
                input.dbPath,
                `Revision ${record.revision} expired at ${record.expires_at}`,
                'revision-expired',
              );
            }
            validateServedRevisionCounts(database, record);
            const manifest = manifestFromServedRevisionRecord(record);
            visitServedReportReadPhase('after-resolve');
            const result = read({
              database: createServedRevisionQueryDatabase(database, record.revision, input.trace),
              manifest,
              revision: record.revision,
              storeDatabase: database,
            });
            if (result instanceof Promise) {
              throw new Error('Served report revision reads must complete synchronously inside one SQLite snapshot');
            }
            database.exec('COMMIT');
            return result;
          } catch (cause) {
            try {
              database.exec('ROLLBACK');
            } catch {
              // The read or validation failure remains authoritative.
            }
            throw cause;
          }
        },
        catch: (cause) => usageStoreServedReadError('readServedReportRevision', input.dbPath, cause),
      }),
    );

  const queryServedRevisionData = (
    input: QueryServedRevisionDataInput,
  ): Effect.Effect<ServedRevisionQueryResult, UsageStoreError> =>
    Effect.try({
      try: () => {
        const parsed = parseServedRevisionQuery(input.kind, input.request);
        if (parsed.revision !== input.revision) {
          throw usageStoreError(
            'queryServedRevisionData',
            input.dbPath,
            `Served revision query request ${parsed.revision} does not match scope ${input.revision}`,
            'invalid-input',
          );
        }
        return parsed;
      },
      catch: (cause) =>
        cause instanceof UsageStoreError
          ? cause
          : usageStoreError('queryServedRevisionData', input.dbPath, cause, 'invalid-input'),
    }).pipe(
      Effect.flatMap((parsed) =>
        readServedReportRevision(input, ({ database }) => executeServedRevisionQuery(database, parsed)),
      ),
    );

  const queryCurrentServedReportRevision = (
    input: Omit<QueryServedReportRevisionInput, 'revision'>,
  ): Effect.Effect<ServedReportRevisionManifest, UsageStoreError> =>
    readServedReportRevision(input, ({ manifest }) => manifest);

  const queryCurrentServedReportRevisionBootstrap = (
    input: Omit<QueryServedReportRevisionInput, 'revision'>,
  ): Effect.Effect<ServedReportRevisionBootstrap, UsageStoreError> =>
    readServedReportRevision(input, ({ database, manifest, revision }) => ({
      manifest,
      support: executeServedRevisionQuery(
        database,
        parseServedRevisionQuery('support', {
          revision,
        }),
      ) as FocusedSupportResult,
    }));

  const queryCurrentServedLocalProjectSources = (
    input: Omit<QueryServedReportRevisionInput, 'revision'>,
  ): Effect.Effect<CurrentServedLocalProjectSources, UsageStoreError> =>
    readServedReportRevision(input, ({ database, revision }) => {
      const records = database.query(`
          SELECT source_row_json
          FROM session_rows
          WHERE source_authority = 'local-observed'
          ORDER BY ordinal
          LIMIT ${MAX_PORTABLE_USAGE_ROWS + 1}
        `);
      const sources = new Map<string, ServedLocalProjectSource>();
      let projectedBytes = Buffer.byteLength(JSON.stringify({ revision, sources: [] }));
      let scannedRows = 0;
      for (const value of records.iterate()) {
        scannedRows += 1;
        if (scannedRows > MAX_PORTABLE_USAGE_ROWS) {
          throw usageStoreError(
            'queryCurrentServedLocalProjectSources',
            input.dbPath,
            `Served local project sources exceed ${MAX_PORTABLE_USAGE_ROWS} input rows`,
            'invalid-input',
          );
        }
        const record = value as { source_row_json?: unknown };
        if (typeof record.source_row_json !== 'string') {
          throw new Error('Served local project source row is invalid');
        }
        const rowValue: unknown = JSON.parse(record.source_row_json);
        if (!isSerializedUsageRow(rowValue)) {
          throw new Error('Served local project source row is invalid');
        }
        const machineId = rowValue.source?.machineId?.trim();
        const sourcePath = rowValue.source?.sourcePath?.trim();
        if (!(machineId && sourcePath)) {
          continue;
        }
        const project = rowValue.rawProject?.trim() || rowValue.project;
        const key = JSON.stringify([machineId, sourcePath, project]);
        const existing = sources.get(key);
        const source =
          existing === undefined
            ? {
                label: rowValue.project,
                machineId,
                machineLabel: rowValue.source?.machineLabel?.trim() ?? '',
                project,
                sessions: 1,
                sourcePath,
              }
            : { ...existing, sessions: existing.sessions + 1 };
        const previousBytes = existing === undefined ? 0 : Buffer.byteLength(JSON.stringify(existing));
        const separatorBytes = existing === undefined && sources.size > 0 ? 1 : 0;
        projectedBytes += Buffer.byteLength(JSON.stringify(source)) - previousBytes + separatorBytes;
        if (projectedBytes > MAX_SERVED_LOCAL_PROJECT_SOURCES_BYTES) {
          throw usageStoreError(
            'queryCurrentServedLocalProjectSources',
            input.dbPath,
            `Served local project sources exceed ${MAX_SERVED_LOCAL_PROJECT_SOURCES_BYTES} bytes`,
            'invalid-input',
          );
        }
        sources.set(key, source);
      }
      return {
        revision,
        sources: [...sources.values()].sort(
          (left, right) =>
            right.sessions - left.sessions ||
            left.label.localeCompare(right.label) ||
            left.sourcePath.localeCompare(right.sourcePath),
        ),
      };
    });

  const readServedReportSupport = (
    database: ServedRevisionReadDatabase,
    manifest: ServedReportRevisionManifest,
  ): FocusedReportSupport => {
    const supportRecord = database.query('SELECT support_json FROM metadata LIMIT 1').get() as {
      support_json?: unknown;
    } | null;
    if (typeof supportRecord?.support_json !== 'string') {
      throw new Error('Served report revision support is incomplete');
    }
    const supportValue: unknown = JSON.parse(supportRecord.support_json);
    if (Buffer.byteLength(supportRecord.support_json) !== manifest.supportBytes) {
      throw new Error('Served report revision support is invalid');
    }
    return parseFocusedReportSupport(supportValue);
  };

  const readServedReportRows = (
    database: ServedRevisionReadDatabase,
    manifest: ServedReportRevisionManifest,
  ): readonly SerializedRow[] => {
    const rowRecords = database.query('SELECT source_row_json FROM session_rows ORDER BY ordinal').all() as Array<{
      source_row_json?: unknown;
    }>;
    if (rowRecords.length !== manifest.rowCount) {
      throw new Error('Served report revision rows are incomplete');
    }
    const rows: SerializedRow[] = [];
    for (const record of rowRecords) {
      if (typeof record.source_row_json !== 'string') {
        throw new Error('Served report revision contains an invalid serialized row');
      }
      const value: unknown = JSON.parse(record.source_row_json);
      if (!isSerializedUsageRow(value)) {
        throw new Error('Served report revision contains an invalid serialized row');
      }
      rows.push(value);
    }
    if (Buffer.byteLength(JSON.stringify(rows)) !== manifest.rowsBytes) {
      throw new Error('Served report revision row bytes do not match metadata');
    }
    return rows;
  };

  const queryServedReportRevisionSupport = (
    input: QueryServedReportRevisionInput,
  ): Effect.Effect<ServedReportRevisionSupport, UsageStoreError> =>
    readServedReportRevision(input, ({ database, manifest }) => ({
      manifest,
      support: readServedReportSupport(database, manifest),
    }));

  const queryServedReportRevisionRows = (
    input: QueryServedReportRevisionInput,
  ): Effect.Effect<ServedReportRevisionRows, UsageStoreError> =>
    readServedReportRevision(input, ({ database, manifest }) => ({
      manifest,
      rows: readServedReportRows(database, manifest),
    }));

  const queryServedReportRevisionSlices = (
    input: QueryServedReportRevisionInput,
  ): Effect.Effect<ServedReportRevisionSlices, UsageStoreError> =>
    readServedReportRevision(input, ({ database, manifest }) => {
      const support = readServedReportSupport(database, manifest);
      const rows = readServedReportRows(database, manifest);
      return { manifest, rows, support };
    });

  const queryServedReportRevisionPortableConfig = (
    input: QueryServedReportRevisionInput,
  ): Effect.Effect<ServedReportRevisionPortableConfig, UsageStoreError> =>
    readServedReportRevision(input, ({ manifest, revision, storeDatabase }) => {
      const context = readServedReportLocalContext(storeDatabase, revision);
      return {
        manifest,
        projectAliases: context.projectAliases,
        projectGroupConfigs: context.projectGroupConfigs,
      };
    });

  const queryServedReportRevisionLocalSnapshot = (
    input: QueryServedReportRevisionLocalSnapshotInput,
  ): Effect.Effect<ServedReportRevisionLocalSnapshot, UsageStoreError> =>
    readServedReportRevision(input, ({ database, manifest, revision, storeDatabase }) => {
      const support = readServedReportSupport(database, manifest);
      const { machine } = readServedReportLocalContext(storeDatabase, revision);
      const records = database
        .query(`
          SELECT source_row_json
          FROM session_rows
          WHERE source_authority = 'local-observed' AND machine_id = ?
          ORDER BY ordinal
          LIMIT ${MAX_PORTABLE_USAGE_ROWS + 1}
        `)
        .all(machine.id) as Array<{ source_row_json?: unknown }>;
      if (records.length > MAX_PORTABLE_USAGE_ROWS) {
        throw usageStoreError(
          'queryServedReportRevisionLocalSnapshot',
          input.dbPath,
          `Served local snapshot exceeds ${MAX_PORTABLE_USAGE_ROWS} rows`,
          'invalid-input',
        );
      }
      const rows: SerializedRow[] = [];
      for (const record of records) {
        if (typeof record.source_row_json !== 'string') {
          throw new Error('Served local snapshot contains an invalid serialized row');
        }
        const value: unknown = JSON.parse(record.source_row_json);
        if (!isSerializedUsageRow(value)) {
          throw new Error('Served local snapshot contains an invalid serialized row');
        }
        rows.push(value);
      }
      return {
        machine,
        manifest,
        rows,
        support,
      };
    });

  interface PreparedPublicationOptions {
    readonly expiresAt: number;
    readonly now: number;
    readonly renewalWindowMs: number;
  }

  const preparePublicationOptions = (input: PublishServedReportRevisionInput): PreparedPublicationOptions => {
    const now = input.now ?? Date.now();
    const ttlMs = input.ttlMs ?? DEFAULT_SERVED_REPORT_REVISION_TTL_MS;
    const renewalWindowMs = input.renewalWindowMs ?? DEFAULT_SERVED_REPORT_RENEWAL_WINDOW_MS;
    const expiresAt = input.expiresAt ?? now + ttlMs;
    if (
      !(
        SERVED_REPORT_REVISION_PATTERN.test(input.revision) &&
        isSafeNonNegativeInteger(now) &&
        Number.isSafeInteger(ttlMs) &&
        ttlMs > 0 &&
        Number.isSafeInteger(renewalWindowMs) &&
        renewalWindowMs >= 0 &&
        isSafeNonNegativeInteger(expiresAt) &&
        expiresAt >= now &&
        typeof input.assemble === 'function'
      )
    ) {
      throw usageStoreError(
        'publishServedReportRevision',
        input.dbPath,
        'Served report publication options are invalid',
        'invalid-input',
      );
    }
    return { expiresAt, now, renewalWindowMs };
  };

  const validatePublicationInput = (
    capture: PublishServedReportRevisionCapture,
    options: PreparedPublicationOptions,
    machine: UsageMachine,
  ): {
    captureFingerprint: string;
    configFingerprint: string;
    expiresAt: number;
    generatedAt: string;
    localContext: ServedReportLocalContext;
    localContextBytes: number;
    localContextJson: string;
    now: number;
    privateCaptureFingerprint: string;
    renewalWindowMs: number;
    rows: readonly SerializedRow[];
    rowsBytes: number;
    sourceAuthorities: readonly SessionDetailSourceAuthority[];
    timeZone: string;
    supportJson: string;
    supportBytes: number;
  } => {
    if (
      !(
        SHA256_PATTERN.test(capture.configFingerprint) &&
        Number.isFinite(Date.parse(capture.generatedAt)) &&
        capture.rows.length <= MAX_PORTABLE_USAGE_ROWS &&
        capture.rows.length === capture.sourceAuthorities.length &&
        capture.rows.every((row) => isSerializedUsageRow(row))
      )
    ) {
      throw new Error('Served report publication input is invalid or exceeds its row budget');
    }
    const reportSupport = parseFocusedReportSupport(capture.support);
    const localContext = parseServedReportLocalContext({
      machine,
      projectAliases: capture.projectAliases,
      projectGroupConfigs: capture.projectGroupConfigs,
    });
    const serializedRows = JSON.stringify(capture.rows);
    const supportJson = JSON.stringify(reportSupport);
    const localContextJson = JSON.stringify(localContext);
    const rowsBytes = Buffer.byteLength(serializedRows);
    const supportBytes = Buffer.byteLength(supportJson);
    const localContextBytes = Buffer.byteLength(localContextJson);
    const payload = { ...reportSupport, rows: capture.rows };
    const captureFingerprint = reportCaptureFingerprintForPayload(payload);
    const privateCaptureFingerprint = reportCaptureFingerprintForPayload(
      { ...payload, localContext },
      capture.sourceAuthorities,
    );
    if (rowsBytes + supportBytes + localContextBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Served report publication exceeds ${MAX_REPORT_RUNNER_ARTIFACT_BYTES} bytes`);
    }
    return {
      captureFingerprint,
      configFingerprint: capture.configFingerprint,
      expiresAt: options.expiresAt,
      generatedAt: capture.generatedAt,
      localContext,
      localContextBytes,
      localContextJson,
      now: options.now,
      privateCaptureFingerprint,
      renewalWindowMs: options.renewalWindowMs,
      rows: capture.rows,
      rowsBytes,
      sourceAuthorities: capture.sourceAuthorities,
      timeZone: reportSupport.timeZone,
      supportBytes,
      supportJson,
    };
  };

  const servedRevisionManifestsMatch = (
    left: ServedReportRevisionManifest,
    right: ServedReportRevisionManifest,
  ): boolean =>
    left.captureFingerprint === right.captureFingerprint &&
    left.expiresAt === right.expiresAt &&
    left.generatedAt === right.generatedAt &&
    left.machineFleetGeneration === right.machineFleetGeneration &&
    left.projectionBytes === right.projectionBytes &&
    left.publishedAt === right.publishedAt &&
    left.revision === right.revision &&
    left.rowCount === right.rowCount &&
    left.rowsBytes === right.rowsBytes &&
    left.supportBytes === right.supportBytes &&
    left.usageStoreGeneration === right.usageStoreGeneration;

  const publicationOutcomeCommitted = (
    database: SqliteDatabase,
    expected: PublishServedReportRevisionResult,
  ): boolean => {
    if (database.inTransaction) {
      return false;
    }
    try {
      const current = readCurrentServedRevisionRecord(database);
      if (!current) {
        return false;
      }
      validateServedRevisionCounts(database, current);
      validateServedRevisionOrphans(database, current.revision);
      validateServedRevisionPayload(database, current);
      validateServedRevisionQueryCatalog(
        () => createServedRevisionQueryDatabase(database, current.revision),
        current.revision,
      );
      return servedRevisionManifestsMatch(manifestFromServedRevisionRecord(current), expected.manifest);
    } catch {
      return false;
    }
  };

  const publishServedReportRevision = (
    input: PublishServedReportRevisionInput,
  ): Effect.Effect<PublishServedReportRevisionResult, UsageStoreError> =>
    Effect.try({
      try: () => preparePublicationOptions(input),
      catch: (cause) =>
        cause instanceof UsageStoreError
          ? cause
          : usageStoreError('publishServedReportRevision', input.dbPath, cause, 'invalid-input'),
    }).pipe(
      Effect.flatMap((options) =>
        withUsageStoreWriter(input.dbPath, (database) =>
          Effect.tryPromise({
            try: async () => {
              let expectedCommittedResult: PublishServedReportRevisionResult | undefined;
              database.exec('BEGIN IMMEDIATE');
              try {
                const generations = readUsageStoreGenerations(database);
                visitPublicationPhase('after-generation-read');
                const capture = await input.assemble({ generations });
                const machine = readUsageLocalMachineWithDatabase(database, input.dbPath);
                const prepared = validatePublicationInput(capture, options, machine);
                const current = readCurrentServedRevisionRecord(database);
                let renewableManifest: ServedReportRevisionManifest | undefined;
                if (current?.private_capture_fingerprint === prepared.privateCaptureFingerprint) {
                  try {
                    validateServedRevisionCounts(database, current);
                    validateServedRevisionOrphans(database, current.revision);
                    validateServedRevisionPayload(database, current);
                    validateServedRevisionQueryCatalog(
                      () => createServedRevisionQueryDatabase(database, current.revision),
                      current.revision,
                    );
                    renewableManifest = manifestFromServedRevisionRecord(current);
                  } catch {
                    renewableManifest = undefined;
                  }
                }
                if (current && renewableManifest) {
                  const renewed = current.expires_at - prepared.now <= prepared.renewalWindowMs;
                  if (renewed) {
                    database
                      .query(`
                    UPDATE served_report_revisions
                    SET published_at = ?, expires_at = ?
                    WHERE revision = ? AND complete = 1
                  `)
                      .run(prepared.now, prepared.expiresAt, current.revision);
                    current.published_at = prepared.now;
                    current.expires_at = prepared.expiresAt;
                  }
                  expectedCommittedResult = {
                    changed: false,
                    manifest: renewed ? manifestFromServedRevisionRecord(current) : renewableManifest,
                    renewed,
                  };
                  database.exec('COMMIT');
                  visitPublicationPhase('after-commit');
                  return expectedCommittedResult;
                }
                database
                  .query(`
                INSERT INTO served_report_revisions (
                  revision, capture_fingerprint, private_capture_fingerprint, config_fingerprint,
                  usage_store_generation, machine_fleet_generation, projection_schema_version,
                  generated_at, published_at, expires_at, complete, row_count, segment_count,
                  filter_key_count, rows_bytes, support_bytes, projection_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, 0)
              `)
                  .run(
                    input.revision,
                    prepared.captureFingerprint,
                    prepared.privateCaptureFingerprint,
                    prepared.configFingerprint,
                    generations.usageStoreGeneration,
                    generations.machineFleetGeneration,
                    SERVED_REPORT_PROJECTION_SCHEMA_VERSION,
                    prepared.generatedAt,
                    prepared.now,
                    prepared.expiresAt,
                    prepared.rows.length,
                    prepared.rowsBytes,
                    prepared.supportBytes,
                  );
                visitPublicationPhase('after-metadata');
                database
                  .query(`
                INSERT INTO served_report_support (revision, support_json, support_bytes) VALUES (?, ?, ?)
              `)
                  .run(input.revision, prepared.supportJson, prepared.supportBytes);
                database
                  .query(`
                INSERT INTO served_report_local_context (
                  revision, machine_id, machine_label, context_json, context_bytes
                ) VALUES (?, ?, ?, ?, ?)
              `)
                  .run(
                    input.revision,
                    prepared.localContext.machine.id,
                    prepared.localContext.machine.label,
                    prepared.localContextJson,
                    prepared.localContextBytes,
                  );
                visitPublicationPhase('after-support');
                const projection = insertServedReportProjection(database, {
                  revision: input.revision,
                  rows: prepared.rows,
                  sourceAuthorities: prepared.sourceAuthorities,
                  timeZone: prepared.timeZone,
                });
                database
                  .query(`
                UPDATE served_report_revisions
                SET segment_count = ?, filter_key_count = ?, projection_bytes = ?
                WHERE revision = ? AND complete = 0
              `)
                  .run(
                    projection.segmentCount,
                    projection.filterKeyCount,
                    projection.projectionBytes + prepared.localContextBytes,
                    input.revision,
                  );
                visitPublicationPhase('after-projection');
                const staged = readExactServedRevisionRecord(database, input.revision);
                if (staged !== null) {
                  throw new Error('Incomplete served report revision became visible before validation');
                }
                const stagedRecord = database
                  .query(`
                SELECT revisions.*, 0 AS is_current
                FROM served_report_revisions AS revisions
                WHERE revision = ? AND complete = 0
              `)
                  .get(input.revision) as ServedReportRevisionRecord | null;
                if (!stagedRecord) {
                  throw new Error('Served report publication lost its staging metadata');
                }
                validateServedRevisionCounts(database, stagedRecord);
                validateServedRevisionOrphans(database, input.revision);
                validateServedRevisionQueryCatalog(
                  () => createServedRevisionQueryDatabase(database, input.revision),
                  input.revision,
                );
                visitPublicationPhase('after-validation');
                database
                  .query('UPDATE served_report_revisions SET complete = 1 WHERE revision = ? AND complete = 0')
                  .run(input.revision);
                visitPublicationPhase('after-complete');
                const completed = readExactServedRevisionRecord(database, input.revision);
                if (!completed) {
                  throw new Error('Completed served report revision is unavailable before commit');
                }
                const manifest = manifestFromServedRevisionRecord(completed);
                database
                  .query(`
                INSERT INTO served_report_current (singleton, revision, required_complete)
                VALUES (1, ?, 1)
                ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, required_complete = 1
              `)
                  .run(input.revision);
                visitPublicationPhase('after-pointer');
                expectedCommittedResult = { changed: true, manifest, renewed: false };
                database.exec('COMMIT');
                visitPublicationPhase('after-commit');
                return expectedCommittedResult;
              } catch (cause) {
                if (database.inTransaction) {
                  try {
                    database.exec('ROLLBACK');
                  } catch {
                    // Reconciliation below refuses to inspect an active transaction.
                  }
                }
                if (expectedCommittedResult && publicationOutcomeCommitted(database, expectedCommittedResult)) {
                  return expectedCommittedResult;
                }
                throw cause;
              }
            },
            catch: (cause) =>
              cause instanceof UsageStoreError
                ? cause
                : usageStoreError('publishServedReportRevision', input.dbPath, cause, 'storage-failure'),
          }),
        ),
      ),
    );

  const retainServedReportRevisionsWithDatabase = (
    database: SqliteDatabase,
    input: Omit<RetainServedReportRevisionsInput, 'dbPath'>,
  ): RetainServedReportRevisionsResult => {
    const now = input.now ?? Date.now();
    const maximumRevisions = input.maximumRevisions ?? DEFAULT_MAXIMUM_SERVED_REPORT_REVISIONS;
    const maximumRows = input.maximumRows ?? DEFAULT_MAXIMUM_SERVED_REPORT_ROWS;
    const maximumBytes = input.maximumBytes ?? DEFAULT_MAXIMUM_SERVED_REPORT_BYTES;
    const abandonedAfterMs = input.abandonedAfterMs ?? DEFAULT_ABANDONED_SERVED_REPORT_REVISION_MS;
    if (
      !(
        isSafeNonNegativeInteger(now) &&
        Number.isSafeInteger(maximumRevisions) &&
        maximumRevisions > 0 &&
        Number.isSafeInteger(maximumRows) &&
        maximumRows > 0 &&
        Number.isSafeInteger(maximumBytes) &&
        maximumBytes > 0 &&
        Number.isSafeInteger(abandonedAfterMs) &&
        abandonedAfterMs >= 0
      )
    ) {
      throw new Error('Served report retention options are invalid');
    }
    const capacityExpired = database
      .query(`
        WITH ranked AS (
          SELECT
            revisions.revision,
            current.revision IS NOT NULL AS is_current,
            ROW_NUMBER() OVER (
              ORDER BY (current.revision IS NOT NULL) DESC, revisions.published_at DESC, revisions.revision DESC
            ) AS retained_position,
            SUM(revisions.row_count) OVER (
              ORDER BY (current.revision IS NOT NULL) DESC, revisions.published_at DESC, revisions.revision DESC
            ) AS retained_rows,
            SUM(revisions.projection_bytes + revisions.support_bytes) OVER (
              ORDER BY (current.revision IS NOT NULL) DESC, revisions.published_at DESC, revisions.revision DESC
            ) AS retained_bytes
          FROM served_report_revisions AS revisions
          LEFT JOIN served_report_current AS current ON current.revision = revisions.revision
          WHERE revisions.complete = 1
        )
        SELECT revision
        FROM ranked
        WHERE is_current = 0
          AND (retained_position > ? OR retained_rows > ? OR retained_bytes > ?)
        ORDER BY retained_position, revision
      `)
      .all(maximumRevisions, maximumRows, maximumBytes) as Array<{ revision: string }>;
    const expireForCapacity = database.query(`
      UPDATE served_report_revisions
      SET expires_at = MIN(expires_at, ?)
      WHERE revision = ? AND complete = 1
        AND revision <> COALESCE((SELECT revision FROM served_report_current WHERE singleton = 1), '')
    `);
    for (const candidate of capacityExpired) {
      expireForCapacity.run(now, candidate.revision);
    }
    const candidates = database
      .query(`
        SELECT revision, row_count, projection_bytes + support_bytes AS logical_bytes
        FROM served_report_revisions
        WHERE (
          complete = 0 AND published_at <= ?
        ) OR (
          complete = 1
          AND expires_at <= ?
          AND revision <> COALESCE((SELECT revision FROM served_report_current WHERE singleton = 1), '')
        )
        ORDER BY complete, published_at, revision
      `)
      .all(now - abandonedAfterMs, now) as Array<{
      logical_bytes: number;
      revision: string;
      row_count: number;
    }>;
    const remove = database.query('DELETE FROM served_report_revisions WHERE revision = ?');
    let deletedBytes = 0;
    let deletedRows = 0;
    for (const candidate of candidates) {
      remove.run(candidate.revision);
      deletedBytes += candidate.logical_bytes;
      deletedRows += candidate.row_count;
    }
    return {
      deletedBytes,
      deletedRevisions: candidates.length,
      deletedRows,
      expiredRevisions: capacityExpired.length,
    };
  };

  const retainServedReportRevisions = (
    input: RetainServedReportRevisionsInput,
  ): Effect.Effect<RetainServedReportRevisionsResult, UsageStoreError> =>
    withUsageStoreWriter(input.dbPath, (database) =>
      Effect.try({
        try: () => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const result = retainServedReportRevisionsWithDatabase(database, input);
            database.exec('COMMIT');
            return result;
          } catch (cause) {
            database.exec('ROLLBACK');
            throw cause;
          }
        },
        catch: (cause) => usageStoreError('retainServedReportRevisions', input.dbPath, cause, 'storage-failure'),
      }),
    );

  return {
    setServedReportPublicationFaultInjectorForTesting,
    setServedReportReadFaultInjectorForTesting,
    queryServedRevisionData,
    queryCurrentServedReportRevision,
    queryCurrentServedReportRevisionBootstrap,
    queryCurrentServedLocalProjectSources,
    queryServedReportRevisionSupport,
    queryServedReportRevisionRows,
    queryServedReportRevisionSlices,
    queryServedReportRevisionPortableConfig,
    queryServedReportRevisionLocalSnapshot,
    publishServedReportRevision,
    retainServedReportRevisions,
  };
};
