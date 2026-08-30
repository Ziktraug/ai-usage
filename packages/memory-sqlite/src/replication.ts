import type { Database } from 'bun:sqlite';
import {
  createCaptureContextId,
  type DeviceId,
  type Instant,
  type MemoryItemId,
  type ProjectId,
  parseCaptureContextId,
  parseDeviceId,
  parseInstant,
  parseMemoryItemId,
  parseMemoryRevisionId,
  parsePersonId,
  parseProjectId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import {
  createSqliteReplicationOutbox,
  type ReplicationSqliteDatabase,
  replicationOutboxSchemaSql,
  type SqliteReplicationOutbox,
} from '@ai-usage/replication-outbox';
import {
  type CaptureContextSnapshot,
  canonicalReplicationJson,
  MEMORY_REPLICATION_STREAM_ID,
  parseCaptureContextSnapshot,
  parseReplicationEventId,
  parseReplicationJsonValue,
  parseReplicationPayload,
  type ReplicationPayload,
  replicationEventIdForSeed,
} from '@ai-usage/replication-protocol';
import { MemoryIdentityStoreError } from './errors';
import { localMemoryReplicationPublicationSchema } from './schema';

interface BootstrapRow {
  readonly device_id: unknown;
  readonly person_id: unknown;
  readonly personal_space_id: unknown;
}

interface CaptureContextRow {
  readonly device_id: unknown;
  readonly id: unknown;
  readonly person_id: unknown;
  readonly project_id: unknown;
  readonly source: unknown;
  readonly space_id: unknown;
}

interface LegacyOutboxRow {
  readonly content_hash: unknown;
  readonly created_at: unknown;
  readonly event_id: unknown;
  readonly event_type: unknown;
  readonly fact_key: unknown;
  readonly status: unknown;
}

interface MemoryRevisionProjectionRow {
  readonly created_at: unknown;
  readonly guidance_json: unknown;
  readonly item_id: unknown;
  readonly item_kind: unknown;
  readonly item_status: unknown;
  readonly project_id: unknown;
  readonly revision_id: unknown;
  readonly revision_number: unknown;
  readonly scope: unknown;
  readonly sensitivity: unknown;
  readonly structured_content_json: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly trust: unknown;
}

interface PublicationContextRow {
  readonly capture_context_id: unknown;
  readonly local_project_id: unknown;
  readonly local_space_id: unknown;
  readonly shared_device_id: unknown;
  readonly shared_person_id: unknown;
  readonly shared_project_id: unknown;
  readonly shared_space_id: unknown;
  readonly source: unknown;
}

export interface ConfigureLocalMemoryReplicationInput {
  readonly captureContext: CaptureContextSnapshot;
  readonly configuredAt?: Date;
  readonly localProjectId: ProjectId | null;
  readonly localSpaceId: SpaceId;
}

export interface ConfigureLocalMemoryReplicationResult {
  readonly backfilled: number;
  readonly nextCursor: MemoryItemId | null;
  readonly unchanged: number;
}

export interface BackfillLocalMemoryReplicationInput {
  readonly afterItemId?: MemoryItemId | null;
  readonly enqueuedAt?: Date;
  readonly localProjectId: ProjectId | null;
  readonly localSpaceId: SpaceId;
  readonly maximumItems?: number;
}

const asReplicationDatabase = (database: Database): ReplicationSqliteDatabase =>
  database as unknown as ReplicationSqliteDatabase;

const bootstrapRow = (database: Database): BootstrapRow => {
  const row = database
    .query('SELECT device_id, person_id, personal_space_id FROM local_identity_metadata WHERE singleton = 1')
    .get() as BootstrapRow | null;
  if (!row) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'read-replication-bootstrap');
  }
  return row;
};

const mapCaptureContext = (row: CaptureContextRow): CaptureContextSnapshot => {
  if (
    row.source !== 'explicit' &&
    row.source !== 'personal-fallback' &&
    row.source !== 'project-rule' &&
    row.source !== 'unassigned'
  ) {
    throw new MemoryIdentityStoreError('validation-failed', 'map-replication-capture-context');
  }
  return {
    deviceId: parseDeviceId(row.device_id),
    id: parseCaptureContextId(row.id),
    personId: parsePersonId(row.person_id),
    projectId: row.project_id === null ? null : parseProjectId(row.project_id),
    scmAccountId: null,
    scmInstallationId: null,
    source: row.source,
    spaceId: parseSpaceId(row.space_id),
  };
};

export const ensureLocalMemoryCaptureContext = (
  database: Database,
  spaceId: SpaceId,
  projectId: ProjectId | null,
): CaptureContextSnapshot => {
  const bootstrap = bootstrapRow(database);
  const deviceId = parseDeviceId(bootstrap.device_id);
  const personId = parsePersonId(bootstrap.person_id);
  if (parseSpaceId(bootstrap.personal_space_id) !== spaceId) {
    throw new MemoryIdentityStoreError('validation-failed', 'resolve-replication-capture-context');
  }
  if (projectId !== null) {
    const project = database
      .query('SELECT 1 FROM projects WHERE id = $projectId AND space_id = $spaceId')
      .get({ projectId, spaceId });
    if (!project) {
      throw new MemoryIdentityStoreError('validation-failed', 'resolve-replication-capture-context');
    }
  }
  const source = projectId === null ? 'personal-fallback' : 'project-rule';
  let row = database
    .query(
      `SELECT id, device_id, person_id, space_id, project_id, source
       FROM capture_contexts
       WHERE device_id = $deviceId AND person_id = $personId AND space_id = $spaceId
         AND project_id IS $projectId AND source = $source
       ORDER BY id LIMIT 1`,
    )
    .get({ deviceId, personId, projectId, source, spaceId }) as CaptureContextRow | null;
  if (!row) {
    const id = createCaptureContextId();
    database
      .query(
        `INSERT INTO capture_contexts (id, device_id, person_id, space_id, project_id, source)
         VALUES ($id, $deviceId, $personId, $spaceId, $projectId, $source)`,
      )
      .run({ deviceId, id, personId, projectId, source, spaceId });
    row = { device_id: deviceId, id, person_id: personId, project_id: projectId, source, space_id: spaceId };
  }
  return mapCaptureContext(row);
};

const mapPublicationContext = (row: PublicationContextRow): CaptureContextSnapshot =>
  parseCaptureContextSnapshot({
    deviceId: row.shared_device_id,
    id: row.capture_context_id,
    personId: row.shared_person_id,
    projectId: row.shared_project_id,
    scmAccountId: null,
    scmInstallationId: null,
    source: row.source,
    spaceId: row.shared_space_id,
  });

export const resolveLocalMemoryReplicationContext = (
  database: Database,
  localSpaceId: SpaceId,
  localProjectId: ProjectId | null,
): CaptureContextSnapshot | null => {
  database.exec(localMemoryReplicationPublicationSchema);
  const row = database
    .query(
      `SELECT local_space_id, local_project_id, shared_device_id, shared_person_id,
              shared_space_id, shared_project_id, capture_context_id, source
       FROM replication_publication_contexts
       WHERE local_space_id = $localSpaceId AND local_project_key = $localProjectKey`,
    )
    .get({ localProjectKey: localProjectId ?? '', localSpaceId }) as PublicationContextRow | null;
  return row ? mapPublicationContext(row) : null;
};

export const memoryReplicationPayloadForContext = (
  payload: ReplicationPayload,
  context: CaptureContextSnapshot,
): ReplicationPayload =>
  'projectId' in payload ? parseReplicationPayload({ ...payload, projectId: context.projectId }) : payload;

export const initializeLocalMemoryReplication = (database: Database, createdAt: Instant): SqliteReplicationOutbox => {
  const outbox = createSqliteReplicationOutbox(asReplicationDatabase(database));
  database.exec(replicationOutboxSchemaSql);
  database.exec(localMemoryReplicationPublicationSchema);
  const configured = database
    .query(
      `SELECT local_space_id, local_project_id, shared_device_id, shared_person_id,
              shared_space_id, shared_project_id, capture_context_id, source
       FROM replication_publication_contexts
       ORDER BY local_space_id, local_project_key LIMIT 1`,
    )
    .get() as PublicationContextRow | null;
  if (configured) {
    outbox.initialize({
      createdAt,
      deviceId: mapPublicationContext(configured).deviceId,
      streamId: MEMORY_REPLICATION_STREAM_ID,
    });
  }
  return outbox;
};

const requiredText = (value: unknown, operation: string): string => {
  if (typeof value !== 'string') {
    throw new MemoryIdentityStoreError('migration-incompatible', operation);
  }
  return value;
};

const parseJson = (value: unknown, operation: string): unknown => {
  try {
    return JSON.parse(requiredText(value, operation)) as unknown;
  } catch {
    throw new MemoryIdentityStoreError('migration-incompatible', operation);
  }
};

const memoryRevisionPayload = (
  database: Database,
  itemIdValue: unknown,
  revisionIdValue: unknown,
): { readonly payload: ReplicationPayload; readonly projectId: ProjectId | null } => {
  const itemId = parseMemoryItemId(itemIdValue);
  const revisionId = parseMemoryRevisionId(revisionIdValue);
  const row = database
    .query(
      `SELECT item.id AS item_id, item.project_id, item.kind AS item_kind,
              item.status AS item_status, item.scope, item.sensitivity, item.trust,
              revision.id AS revision_id, revision.revision_number, revision.title,
              revision.summary, revision.guidance_json, revision.structured_content_json,
              revision.created_at
       FROM memory_items item
       JOIN memory_revisions revision
         ON revision.memory_item_id = item.id AND revision.space_id = item.space_id
       WHERE item.id = $itemId AND revision.id = $revisionId`,
    )
    .get({ itemId, revisionId }) as MemoryRevisionProjectionRow | null;
  if (!row) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'migrate-replication-revision');
  }
  if (
    row.sensitivity !== 'normal' ||
    (row.item_kind !== 'decision' &&
      row.item_kind !== 'pattern' &&
      row.item_kind !== 'pitfall' &&
      row.item_kind !== 'command' &&
      row.item_kind !== 'constraint' &&
      row.item_kind !== 'handoff' &&
      row.item_kind !== 'lesson' &&
      row.item_kind !== 'preference') ||
    (row.item_status !== 'active' &&
      row.item_status !== 'archived' &&
      row.item_status !== 'rejected' &&
      row.item_status !== 'superseded') ||
    (row.scope !== 'person' && row.scope !== 'project' && row.scope !== 'space') ||
    (row.trust !== 'explicit' && row.trust !== 'harvest-accepted') ||
    typeof row.revision_number !== 'number' ||
    !Number.isSafeInteger(row.revision_number) ||
    row.revision_number <= 0
  ) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'migrate-replication-revision');
  }
  const guidanceValue = parseJson(row.guidance_json, 'migrate-replication-guidance');
  if (!(Array.isArray(guidanceValue) && guidanceValue.every((entry) => typeof entry === 'string'))) {
    throw new MemoryIdentityStoreError('migration-incompatible', 'migrate-replication-guidance');
  }
  const projectId = row.project_id === null ? null : parseProjectId(row.project_id);
  return {
    payload: {
      guidance: guidanceValue,
      itemId: parseMemoryItemId(row.item_id),
      itemKind: row.item_kind,
      kind: 'memory-item-revision-upsert',
      projectId,
      revisionCreatedAt: parseInstant(row.created_at, 'revisionCreatedAt'),
      revisionId: parseMemoryRevisionId(row.revision_id),
      revisionNumber: row.revision_number,
      scope: row.scope,
      sensitivity: 'normal',
      status: row.item_status,
      structuredContent: parseReplicationJsonValue(
        parseJson(row.structured_content_json, 'migrate-replication-structured-content'),
        'structuredContent',
      ),
      summary: requiredText(row.summary, 'migrate-replication-summary'),
      title: requiredText(row.title, 'migrate-replication-title'),
      trust: row.trust,
    },
    projectId,
  };
};

interface BackfillMemoryItemRow {
  readonly current_revision_id: unknown;
  readonly id: unknown;
  readonly status: unknown;
}

const backfillMemoryReplicationContext = (
  database: Database,
  context: CaptureContextSnapshot,
  localSpaceId: SpaceId,
  localProjectId: ProjectId | null,
  enqueuedAt: Instant,
  afterItemId: MemoryItemId | null,
  maximumItems: number,
): ConfigureLocalMemoryReplicationResult => {
  if (!Number.isSafeInteger(maximumItems) || maximumItems <= 0 || maximumItems > 1000) {
    throw new MemoryIdentityStoreError('validation-failed', 'backfill-replication-bounds');
  }
  const outbox = createSqliteReplicationOutbox(asReplicationDatabase(database));
  const rows = database
    .query(
      `SELECT id, current_revision_id, status
       FROM memory_items
       WHERE space_id = $localSpaceId AND project_id IS $localProjectId
         AND sensitivity = 'normal' AND id > $afterItemId
       ORDER BY id
       LIMIT $limit`,
    )
    .all({
      afterItemId: afterItemId ?? '',
      limit: maximumItems + 1,
      localProjectId,
      localSpaceId,
    }) as BackfillMemoryItemRow[];
  const hasNext = rows.length > maximumItems;
  const selected = hasNext ? rows.slice(0, maximumItems) : rows;
  let backfilled = 0;
  let unchanged = 0;
  for (const row of selected) {
    const itemId = parseMemoryItemId(row.id);
    const mapped = memoryRevisionPayload(database, itemId, row.current_revision_id);
    const payload =
      row.status === 'superseded'
        ? parseReplicationPayload({
            itemId,
            kind: 'memory-fact-tombstone',
            reasonCode: 'superseded',
            tombstonedAt: enqueuedAt,
          })
        : memoryReplicationPayloadForContext(mapped.payload, context);
    const factKey = `memory-item:${itemId}`;
    const eventId = replicationEventIdForSeed({ captureContextId: context.id, factKey, payload });
    const existed = database.query('SELECT 1 FROM replication_outbox_events WHERE event_id = ?').get(eventId) !== null;
    outbox.enqueue({
      captureContext: context,
      changeKind: payload.kind,
      enqueuedAt,
      eventId,
      factKey,
      payload,
    });
    if (existed) {
      unchanged += 1;
    } else {
      backfilled += 1;
    }
  }
  return {
    backfilled,
    nextCursor: hasNext ? parseMemoryItemId(selected.at(-1)?.id) : null,
    unchanged,
  };
};

export const configureLocalMemoryReplication = (
  database: Database,
  input: ConfigureLocalMemoryReplicationInput,
): ConfigureLocalMemoryReplicationResult => {
  const configure = database.transaction((): ConfigureLocalMemoryReplicationResult => {
    database.exec(replicationOutboxSchemaSql);
    database.exec(localMemoryReplicationPublicationSchema);
    const bootstrap = bootstrapRow(database);
    const localSpaceId = parseSpaceId(bootstrap.personal_space_id);
    const context = parseCaptureContextSnapshot(input.captureContext);
    if (
      input.localSpaceId !== localSpaceId ||
      (input.localProjectId === null) !== (context.projectId === null) ||
      (input.localProjectId === null
        ? context.source !== 'personal-fallback' && context.source !== 'unassigned'
        : context.source !== 'explicit' && context.source !== 'project-rule')
    ) {
      throw new MemoryIdentityStoreError('validation-failed', 'configure-replication-context');
    }
    if (input.localProjectId !== null) {
      const project = database
        .query('SELECT 1 FROM projects WHERE id = $projectId AND space_id = $spaceId')
        .get({ projectId: input.localProjectId, spaceId: input.localSpaceId });
      if (!project) {
        throw new MemoryIdentityStoreError('validation-failed', 'configure-replication-project');
      }
    }
    const priorContext = database
      .query(
        `SELECT local_space_id, local_project_id, shared_device_id, shared_person_id,
                shared_space_id, shared_project_id, capture_context_id, source
         FROM replication_publication_contexts
         ORDER BY local_space_id, local_project_key LIMIT 1`,
      )
      .get() as PublicationContextRow | null;
    if (priorContext) {
      const prior = mapPublicationContext(priorContext);
      if (
        prior.deviceId !== context.deviceId ||
        prior.personId !== context.personId ||
        prior.spaceId !== context.spaceId
      ) {
        throw new MemoryIdentityStoreError('validation-failed', 'configure-replication-identity');
      }
    }
    const state = database
      .query(
        `SELECT device_id, acknowledged_through_generation,
                (SELECT count(*) FROM replication_outbox_events) AS event_count
         FROM replication_outbox_state WHERE singleton = 1`,
      )
      .get() as {
      readonly acknowledged_through_generation: unknown;
      readonly device_id: unknown;
      readonly event_count: unknown;
    } | null;
    if (state && state.device_id !== context.deviceId) {
      if (state.acknowledged_through_generation !== 0 || state.event_count !== 0) {
        throw new MemoryIdentityStoreError('validation-failed', 'configure-replication-repair-required');
      }
      database.query('DELETE FROM replication_outbox_state WHERE singleton = 1').run();
    }
    const configuredAt = parseInstant((input.configuredAt ?? new Date()).toISOString(), 'configuredAt');
    database
      .query(
        `INSERT INTO replication_publication_contexts
           (local_space_id, local_project_key, local_project_id, shared_device_id,
            shared_person_id, shared_space_id, shared_project_id, capture_context_id, source, configured_at)
         VALUES ($localSpaceId, $localProjectKey, $localProjectId, $deviceId,
                 $personId, $spaceId, $projectId, $contextId, $source, $configuredAt)
         ON CONFLICT (local_space_id, local_project_key) DO NOTHING`,
      )
      .run({
        configuredAt,
        contextId: context.id,
        deviceId: context.deviceId,
        localProjectId: input.localProjectId,
        localProjectKey: input.localProjectId ?? '',
        localSpaceId: input.localSpaceId,
        personId: context.personId,
        projectId: context.projectId,
        source: context.source,
        spaceId: context.spaceId,
      });
    const stored = resolveLocalMemoryReplicationContext(database, input.localSpaceId, input.localProjectId);
    if (!stored || canonicalReplicationJson(stored) !== canonicalReplicationJson(context)) {
      throw new MemoryIdentityStoreError('validation-failed', 'configure-replication-context-conflict');
    }
    createSqliteReplicationOutbox(asReplicationDatabase(database)).initialize({
      createdAt: configuredAt,
      deviceId: context.deviceId,
      streamId: MEMORY_REPLICATION_STREAM_ID,
    });
    return backfillMemoryReplicationContext(
      database,
      context,
      input.localSpaceId,
      input.localProjectId,
      configuredAt,
      null,
      500,
    );
  });
  return configure.immediate();
};

export const backfillLocalMemoryReplication = (
  database: Database,
  input: BackfillLocalMemoryReplicationInput,
): ConfigureLocalMemoryReplicationResult => {
  const backfill = database.transaction(() => {
    const context = resolveLocalMemoryReplicationContext(database, input.localSpaceId, input.localProjectId);
    if (!context) {
      throw new MemoryIdentityStoreError('validation-failed', 'backfill-replication-context');
    }
    const enqueuedAt = parseInstant((input.enqueuedAt ?? new Date()).toISOString(), 'enqueuedAt');
    return backfillMemoryReplicationContext(
      database,
      context,
      input.localSpaceId,
      input.localProjectId,
      enqueuedAt,
      input.afterItemId ?? null,
      input.maximumItems ?? 500,
    );
  });
  return backfill.immediate();
};

export const migrateLegacyMemoryReplicationOutbox = (database: Database, migratedAt: Instant): void => {
  const columns = database.query('PRAGMA table_info(replication_outbox_events)').all() as Array<{
    readonly name?: unknown;
  }>;
  if (!columns.some(({ name }) => name === 'event_type')) {
    database.exec(replicationOutboxSchemaSql);
    database.exec(localMemoryReplicationPublicationSchema);
    return;
  }
  database.exec('ALTER TABLE replication_outbox_events RENAME TO legacy_replication_outbox_events_v4');
  database.exec(replicationOutboxSchemaSql);
  database.exec(localMemoryReplicationPublicationSchema);
  database.exec(`
    CREATE TABLE replication_legacy_content_hashes (
      event_id TEXT PRIMARY KEY,
      legacy_content_hash TEXT NOT NULL CHECK (length(legacy_content_hash) = 64),
      legacy_fact_key TEXT NOT NULL,
      legacy_event_type TEXT NOT NULL,
      legacy_created_at TEXT NOT NULL,
      migrated_at TEXT NOT NULL
    ) STRICT
  `);
  const rows = database
    .query(
      `SELECT event_id, fact_key, event_type, content_hash, status, created_at
       FROM legacy_replication_outbox_events_v4
       ORDER BY created_at, event_id`,
    )
    .all() as LegacyOutboxRow[];
  for (const row of rows) {
    if (row.status !== 'pending') {
      throw new MemoryIdentityStoreError('migration-incompatible', 'migrate-replication-state');
    }
    database
      .query(
        `INSERT INTO replication_legacy_content_hashes
           (event_id, legacy_content_hash, legacy_fact_key, legacy_event_type, legacy_created_at, migrated_at)
         VALUES ($eventId, $contentHash, $factKey, $eventType, $createdAt, $migratedAt)`,
      )
      .run({
        createdAt: parseInstant(row.created_at, 'legacyCreatedAt'),
        contentHash: requiredText(row.content_hash, 'migrate-replication-content-hash'),
        eventId: parseReplicationEventId(row.event_id),
        eventType: requiredText(row.event_type, 'migrate-replication-event-type'),
        factKey: requiredText(row.fact_key, 'migrate-replication-fact-key'),
        migratedAt,
      });
  }
  database.exec('DROP TABLE legacy_replication_outbox_events_v4');
};

export const localMemoryReplicationIdentity = (
  database: Database,
): {
  readonly deviceId: DeviceId;
  readonly spaceId: SpaceId;
} => {
  const bootstrap = bootstrapRow(database);
  return {
    deviceId: parseDeviceId(bootstrap.device_id),
    spaceId: parseSpaceId(bootstrap.personal_space_id),
  };
};
