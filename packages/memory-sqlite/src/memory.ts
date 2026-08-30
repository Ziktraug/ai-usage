import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { AUTHORIZATION_MODEL_VERSION, type AuthorizationPrincipal } from '@ai-usage/authorization';
import { readAuthorizedResourceScopeIds } from '@ai-usage/authorization/scope-internal';
import { createMemorySearchChunks, memorySearchStructuredText } from '@ai-usage/memory-search/chunking';
import {
  compileMemorySearchQuery,
  explainMemorySearchMatch,
  normalizeMemorySearchScore,
  normalizeMemorySearchText,
  truncateMemorySearchGuidance,
} from '@ai-usage/memory-search/ranking';
import {
  type MemoryExportSnapshot,
  type MemoryImport,
  type MemoryItem,
  type MemoryItemResult,
  type MemoryJsonValue,
  type MemoryKind,
  type MemoryObservation,
  type MemoryObservationSourceKind,
  type MemoryProposal,
  type MemoryProposalStatus,
  type MemoryRelation,
  type MemoryRelationKind,
  type MemoryRevision,
  type MemoryScope,
  type MemorySensitivity,
  type MemoryTrust,
  memoryContentHash,
  parseMemoryJsonValue,
} from '@ai-usage/memory-service/domain';
import { memoryImportPreviewProof } from '@ai-usage/memory-service/migration';
import {
  type AcceptProposalInput,
  type ConfirmMemoryImportInput,
  type ConfirmMemoryImportResult,
  type CreateProposalInput,
  type ExportMemoryQuery,
  type ListMemoryItemsQuery,
  type ListMemoryProposalsQuery,
  type MemoryAuditEvent,
  type MemoryRepository,
  MemoryRepositoryError,
  type PreviewMemoryImportInput,
  type PreviewMemoryImportResult,
  type PurgeMemoryItemInput,
  type RecordObservationInput,
  type RejectProposalInput,
  type ReviseMemoryItemInput,
  type SupersedeMemoryItemInput,
} from '@ai-usage/memory-service/repository';
import {
  assertMemorySearchPageBounds,
  MEMORY_SEARCH_CHUNKER_VERSION,
  MEMORY_SEARCH_RANKING_VERSION,
  type MemorySearchPage,
  memorySearchBounds,
  type SearchMemoryRepositoryQuery,
} from '@ai-usage/memory-service/search';
import {
  parseCaptureContextId,
  parseInstant,
  parseMemoryImportId,
  parseMemoryItemId,
  parseMemoryObservationId,
  parseMemoryProposalId,
  parseMemoryRevisionId,
  parsePersonId,
  parseProjectId,
  parseSpaceId,
  type SpaceId,
} from '@ai-usage/platform-core/identity';
import { createSqliteReplicationOutbox, type ReplicationSqliteDatabase } from '@ai-usage/replication-outbox';
import { memoryReplicationPayloadForContext, resolveLocalMemoryReplicationContext } from './replication';

interface ObservationRow {
  readonly capture_context_id: unknown;
  readonly content_hash: unknown;
  readonly content_json: unknown;
  readonly created_by_id: unknown;
  readonly created_by_kind: unknown;
  readonly fingerprint: unknown;
  readonly id: unknown;
  readonly observed_at: unknown;
  readonly project_id: unknown;
  readonly redaction_rule_set_version: unknown;
  readonly sensitivity: unknown;
  readonly source_kind: unknown;
  readonly source_locator: unknown;
  readonly space_id: unknown;
}

interface ProposalRow {
  readonly guidance_json: unknown;
  readonly id: unknown;
  readonly project_id: unknown;
  readonly proposed_by_id: unknown;
  readonly proposed_by_kind: unknown;
  readonly proposed_kind: unknown;
  readonly review_reason: unknown;
  readonly reviewed_at: unknown;
  readonly reviewed_by_person_id: unknown;
  readonly sensitivity: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
  readonly structured_content_json: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly trust_candidate: unknown;
}

interface ItemRevisionRow {
  readonly created_at: unknown;
  readonly created_by_id: unknown;
  readonly created_by_kind: unknown;
  readonly current_revision_id: unknown;
  readonly guidance_json: unknown;
  readonly item_id: unknown;
  readonly kind: unknown;
  readonly project_id: unknown;
  readonly reason: unknown;
  readonly revision_id: unknown;
  readonly revision_number: unknown;
  readonly scope: unknown;
  readonly sensitivity: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
  readonly structured_content_json: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly trust: unknown;
}

interface ExistingObservationRow {
  readonly content_hash: unknown;
  readonly id: unknown;
}

interface ProposalObservationSourceRow {
  readonly id: unknown;
  readonly observed_at: unknown;
  readonly sensitivity: unknown;
  readonly source_kind: unknown;
  readonly source_locator: unknown;
}

interface ItemStateRow {
  readonly current_revision_id: unknown;
  readonly revision_number: unknown;
  readonly status: unknown;
}

interface MemorySearchProjectionStateRow {
  readonly source_state_version: unknown;
  readonly space_id: unknown;
}

interface MemorySearchMetadataRow {
  readonly ordered_ids: unknown;
  readonly total_count: unknown;
}

interface MemorySearchResultRow {
  readonly content_hash: unknown;
  readonly exact_score: unknown;
  readonly guidance_json: unknown;
  readonly item_id: unknown;
  readonly kind: unknown;
  readonly lexical_score: unknown;
  readonly project_id: unknown;
  readonly revision_id: unknown;
  readonly revision_number: unknown;
  readonly sensitivity: unknown;
  readonly status: unknown;
  readonly structured_content_json: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly total_score: unknown;
  readonly trigram_score: unknown;
  readonly trust: unknown;
}

interface MemoryImportRow {
  readonly confirmed_at: unknown;
  readonly confirmed_by_person_id: unknown;
  readonly content_hash: unknown;
  readonly created_at: unknown;
  readonly fingerprint: unknown;
  readonly id: unknown;
  readonly preview_proof: unknown;
  readonly project_id: unknown;
  readonly source_kind: unknown;
  readonly source_locator: unknown;
  readonly space_id: unknown;
  readonly status: unknown;
}

interface ExportRelationRow {
  readonly reason: unknown;
  readonly relation_kind: unknown;
  readonly to_memory_item_id: unknown;
}

const memoryKinds = new Set<MemoryKind>([
  'decision',
  'pattern',
  'pitfall',
  'command',
  'constraint',
  'handoff',
  'lesson',
  'preference',
]);
const observationSourceKinds = new Set<MemoryObservationSourceKind>([
  'user',
  'agent',
  'session',
  'file',
  'commit',
  'pull-request',
  'import',
]);
const proposalStatuses = new Set<MemoryProposalStatus>(['pending', 'accepted', 'rejected', 'superseded']);
const itemStatuses = new Set<MemoryItem['status']>(['active', 'superseded', 'rejected', 'archived']);
const memoryScopes = new Set<MemoryScope>(['project', 'space', 'person']);
const sensitivities = new Set<MemorySensitivity>(['normal', 'sensitive']);
const trustValues = new Set<MemoryTrust>(['explicit', 'harvest-accepted']);
const relationKinds = new Set<MemoryRelationKind>([
  'applies-to',
  'contradicts',
  'derived-from',
  'related-to',
  'supersedes',
  'supports',
]);

const requiredString = (value: unknown, operation: string): string => {
  if (typeof value !== 'string') {
    throw new MemoryRepositoryError('unavailable', operation);
  }
  return value;
};

const optionalString = (value: unknown, operation: string): string | null =>
  value === null ? null : requiredString(value, operation);

const enumValue = <Value extends string>(value: unknown, values: ReadonlySet<Value>, operation: string): Value => {
  if (typeof value !== 'string' || !values.has(value as Value)) {
    throw new MemoryRepositoryError('unavailable', operation);
  }
  return value as Value;
};

const jsonValue = (value: unknown, operation: string): MemoryJsonValue => {
  try {
    return parseMemoryJsonValue(JSON.parse(requiredString(value, operation)) as unknown, operation);
  } catch (error) {
    if (error instanceof MemoryRepositoryError) {
      throw error;
    }
    throw new MemoryRepositoryError('unavailable', operation);
  }
};

const guidanceValue = (value: unknown, operation: string): readonly string[] => {
  const parsed = jsonValue(value, operation);
  if (!(Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'))) {
    throw new MemoryRepositoryError('unavailable', operation);
  }
  return parsed;
};

const principalColumns = (principal: AuthorizationPrincipal): { readonly id: string; readonly kind: string } =>
  principal.kind === 'person' ? { id: principal.personId, kind: 'person' } : { id: principal.id, kind: 'service' };

const mapPrincipal = (kind: unknown, id: unknown, operation: string): AuthorizationPrincipal => {
  const parsedId = requiredString(id, operation);
  if (kind === 'person') {
    return { kind, personId: parsePersonId(parsedId) };
  }
  if (kind === 'service' && parsedId.length > 0 && parsedId.length <= 256) {
    return { id: parsedId, kind };
  }
  throw new MemoryRepositoryError('unavailable', operation);
};

const mapProposal = (row: ProposalRow): MemoryProposal => ({
  guidance: guidanceValue(row.guidance_json, 'map-proposal'),
  id: parseMemoryProposalId(row.id),
  owningSpaceId: parseSpaceId(row.space_id),
  projectId: row.project_id === null ? null : parseProjectId(row.project_id),
  proposedByPrincipal: mapPrincipal(row.proposed_by_kind, row.proposed_by_id, 'map-proposal'),
  proposedKind: enumValue(row.proposed_kind, memoryKinds, 'map-proposal'),
  reviewedAt: row.reviewed_at === null ? null : parseInstant(row.reviewed_at),
  reviewedByPersonId: row.reviewed_by_person_id === null ? null : parsePersonId(row.reviewed_by_person_id),
  reviewReason: optionalString(row.review_reason, 'map-proposal'),
  sensitivity: enumValue(row.sensitivity, sensitivities, 'map-proposal'),
  status: enumValue(row.status, proposalStatuses, 'map-proposal'),
  structuredContent: jsonValue(row.structured_content_json, 'map-proposal'),
  summary: requiredString(row.summary, 'map-proposal'),
  title: requiredString(row.title, 'map-proposal'),
  trustCandidate: enumValue(row.trust_candidate, trustValues, 'map-proposal'),
});

const mapItemResult = (row: ItemRevisionRow): MemoryItemResult => {
  const itemId = parseMemoryItemId(row.item_id);
  const revisionId = parseMemoryRevisionId(row.revision_id);
  const revisionNumber = row.revision_number;
  if (!(typeof revisionNumber === 'number' && Number.isSafeInteger(revisionNumber) && revisionNumber > 0)) {
    throw new MemoryRepositoryError('unavailable', 'map-memory-item');
  }
  return {
    item: {
      currentRevisionId: parseMemoryRevisionId(row.current_revision_id),
      id: itemId,
      kind: enumValue(row.kind, memoryKinds, 'map-memory-item'),
      owningSpaceId: parseSpaceId(row.space_id),
      projectId: row.project_id === null ? null : parseProjectId(row.project_id),
      scope: enumValue(row.scope, memoryScopes, 'map-memory-item'),
      sensitivity: enumValue(row.sensitivity, sensitivities, 'map-memory-item'),
      status: enumValue(row.status, itemStatuses, 'map-memory-item'),
      trust: enumValue(row.trust, trustValues, 'map-memory-item'),
    },
    revision: {
      createdAt: parseInstant(row.created_at),
      createdByPrincipal: mapPrincipal(row.created_by_kind, row.created_by_id, 'map-memory-revision'),
      guidance: guidanceValue(row.guidance_json, 'map-memory-revision'),
      id: revisionId,
      memoryItemId: itemId,
      reason: optionalString(row.reason, 'map-memory-revision'),
      revisionNumber,
      structuredContent: jsonValue(row.structured_content_json, 'map-memory-revision'),
      summary: requiredString(row.summary, 'map-memory-revision'),
      title: requiredString(row.title, 'map-memory-revision'),
    },
  };
};

const insertAudit = (database: Database, event: MemoryAuditEvent): void => {
  const actor = principalColumns(event.actor);
  database
    .query(
      `INSERT INTO memory_audit_events
        (id, space_id, actor_kind, actor_id, action, subject_type, subject_id, result, recorded_at)
       VALUES ($id, $spaceId, $actorKind, $actorId, $action, $subjectType, $subjectId, $result, $recordedAt)`,
    )
    .run({
      action: event.action,
      actorId: actor.id,
      actorKind: actor.kind,
      id: crypto.randomUUID(),
      recordedAt: event.recordedAt,
      result: event.result,
      spaceId: event.spaceId,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
    });
};

const insertOutbox = (database: Database, event: AcceptProposalInput['outboxEvent']): void => {
  if (!event) {
    return;
  }
  const captureContext = resolveLocalMemoryReplicationContext(database, event.owningSpaceId, event.projectId);
  if (!captureContext) {
    return;
  }
  const payload = memoryReplicationPayloadForContext(event.payload, captureContext);
  createSqliteReplicationOutbox(database as unknown as ReplicationSqliteDatabase).enqueue({
    captureContext,
    changeKind: payload.kind,
    enqueuedAt: event.enqueuedAt,
    eventId: event.eventId,
    factKey: event.factKey,
    payload,
  });
};

const ensureMemoryState = (database: Database, spaceId: SpaceId): number => {
  database
    .query('INSERT INTO memory_space_state (space_id, version) VALUES ($spaceId, 0) ON CONFLICT (space_id) DO NOTHING')
    .run({ spaceId });
  const row = database.query('SELECT version FROM memory_space_state WHERE space_id = $spaceId').get({ spaceId }) as {
    readonly version: unknown;
  } | null;
  if (!(typeof row?.version === 'number' && Number.isSafeInteger(row.version) && row.version >= 0)) {
    throw new MemoryRepositoryError('unavailable', 'read-memory-state');
  }
  return row.version;
};

const markSearchProjectionState = (database: Database, spaceId: SpaceId, sourceStateVersion: number): void => {
  database
    .query(
      `INSERT INTO memory_search_projection_state (space_id, source_state_version, chunker_version)
       VALUES ($spaceId, $sourceStateVersion, $chunkerVersion)
       ON CONFLICT (space_id) DO UPDATE SET
         source_state_version = excluded.source_state_version,
         chunker_version = excluded.chunker_version`,
    )
    .run({ chunkerVersion: MEMORY_SEARCH_CHUNKER_VERSION, sourceStateVersion, spaceId });
};

const bumpMemoryState = (database: Database, spaceId: SpaceId): number => {
  ensureMemoryState(database, spaceId);
  const updated = database
    .query('UPDATE memory_space_state SET version = version + 1 WHERE space_id = $spaceId')
    .run({ spaceId });
  if (updated.changes !== 1) {
    throw new MemoryRepositoryError('unavailable', 'bump-memory-state');
  }
  const version = ensureMemoryState(database, spaceId);
  markSearchProjectionState(database, spaceId, version);
  return version;
};

const mapMemoryImport = (row: MemoryImportRow): MemoryImport => {
  if (
    (row.source_kind !== 'legacy-jsonl' && row.source_kind !== 'legacy-markdown') ||
    (row.status !== 'previewed' && row.status !== 'confirmed' && row.status !== 'quarantined' && row.status !== 'stale')
  ) {
    throw new MemoryRepositoryError('unavailable', 'map-memory-import');
  }
  return {
    confirmedAt: row.confirmed_at === null ? null : parseInstant(row.confirmed_at),
    confirmedByPersonId: row.confirmed_by_person_id === null ? null : parsePersonId(row.confirmed_by_person_id),
    contentHash: requiredString(row.content_hash, 'map-memory-import'),
    createdAt: parseInstant(row.created_at),
    destinationProjectId: row.project_id === null ? null : parseProjectId(row.project_id),
    destinationSpaceId: parseSpaceId(row.space_id),
    fingerprint: requiredString(row.fingerprint, 'map-memory-import'),
    id: parseMemoryImportId(row.id),
    previewProof: requiredString(row.preview_proof, 'map-memory-import'),
    sourceKind: row.source_kind as MemoryImport['sourceKind'],
    sourceLocator: requiredString(row.source_locator, 'map-memory-import'),
    status: row.status as MemoryImport['status'],
  };
};

const insertRevision = (database: Database, revision: MemoryRevision, spaceId: SpaceId): void => {
  const actor = principalColumns(revision.createdByPrincipal);
  database
    .query(
      `INSERT INTO memory_revisions
        (id, memory_item_id, space_id, revision_number, title, summary, guidance_json,
         structured_content_json, created_by_kind, created_by_id, created_at, reason)
       VALUES ($id, $itemId, $spaceId, $revisionNumber, $title, $summary, $guidance,
               $structuredContent, $actorKind, $actorId, $createdAt, $reason)`,
    )
    .run({
      actorId: actor.id,
      actorKind: actor.kind,
      createdAt: revision.createdAt,
      guidance: JSON.stringify(revision.guidance),
      id: revision.id,
      itemId: revision.memoryItemId,
      reason: revision.reason,
      revisionNumber: revision.revisionNumber,
      structuredContent: JSON.stringify(revision.structuredContent),
      spaceId,
      summary: revision.summary,
      title: revision.title,
    });
};

const itemSelect = `
  SELECT item.id AS item_id, item.space_id, item.project_id, item.scope, item.kind,
         item.status, item.trust, item.sensitivity, item.current_revision_id,
         revision.id AS revision_id, revision.revision_number, revision.title,
         revision.summary, revision.guidance_json, revision.structured_content_json,
         revision.created_by_kind, revision.created_by_id, revision.created_at, revision.reason
  FROM memory_items item
  INNER JOIN memory_revisions revision ON revision.id = item.current_revision_id
`;

const itemRevisionHistorySelect = `
  SELECT item.id AS item_id, item.space_id, item.project_id, item.scope, item.kind,
         item.status, item.trust, item.sensitivity, item.current_revision_id,
         revision.id AS revision_id, revision.revision_number, revision.title,
         revision.summary, revision.guidance_json, revision.structured_content_json,
         revision.created_by_kind, revision.created_by_id, revision.created_at, revision.reason
  FROM memory_items item
  INNER JOIN memory_revisions revision ON revision.memory_item_id = item.id
`;

const insertMemorySearchProjection = (database: Database, item: MemoryItem, revision: MemoryRevision): void => {
  const insert = database.query(
    `INSERT INTO memory_search_chunks
      (chunk_id, chunk_ordinal, chunker_version, content_hash, space_id, project_id,
       memory_item_id, revision_id, revision_number, scope, kind, status, trust, sensitivity,
       title, summary, guidance, structured_terms, supporting_text,
       normalized_title, normalized_summary, normalized_guidance,
       normalized_structured_terms, normalized_supporting_text)
     VALUES
      ($chunkId, $chunkOrdinal, $chunkerVersion, $contentHash, $spaceId, $projectId,
       $itemId, $revisionId, $revisionNumber, $scope, $kind, $status, $trust, $sensitivity,
       $title, $summary, $guidance, $structuredTerms, $supportingText,
       $normalizedTitle, $normalizedSummary, $normalizedGuidance,
       $normalizedStructuredTerms, $normalizedSupportingText)`,
  );
  for (const chunk of createMemorySearchChunks(item, revision)) {
    insert.run({
      chunkId: chunk.chunkId,
      chunkOrdinal: chunk.chunkOrdinal,
      chunkerVersion: chunk.chunkerVersion,
      contentHash: chunk.contentHash,
      guidance: chunk.guidance,
      itemId: item.id,
      kind: item.kind,
      normalizedGuidance: normalizeMemorySearchText(chunk.guidance),
      normalizedStructuredTerms: normalizeMemorySearchText(chunk.structuredTerms),
      normalizedSummary: normalizeMemorySearchText(chunk.summary),
      normalizedSupportingText: normalizeMemorySearchText(chunk.supportingText),
      normalizedTitle: normalizeMemorySearchText(chunk.title),
      projectId: item.projectId,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      scope: item.scope,
      sensitivity: item.sensitivity,
      spaceId: item.owningSpaceId,
      status: item.status,
      structuredTerms: chunk.structuredTerms,
      summary: chunk.summary,
      supportingText: chunk.supportingText,
      title: chunk.title,
      trust: item.trust,
    });
  }
};

const replaceMemorySearchProjection = (database: Database, item: MemoryItem, revision: MemoryRevision): void => {
  database
    .query('DELETE FROM memory_search_chunks WHERE space_id = $spaceId AND memory_item_id = $itemId')
    .run({ itemId: item.id, spaceId: item.owningSpaceId });
  insertMemorySearchProjection(database, item, revision);
};

const reindexMemorySearchItem = (database: Database, spaceId: SpaceId, itemId: string): void => {
  const row = database
    .query(`${itemSelect} WHERE item.space_id = $spaceId AND item.id = $itemId`)
    .get({ itemId, spaceId }) as ItemRevisionRow | null;
  if (!row) {
    throw new MemoryRepositoryError('not-found', 'reindex-memory-search-item');
  }
  const current = mapItemResult(row);
  replaceMemorySearchProjection(database, current.item, current.revision);
};

export const rebuildSqliteMemorySearchProjection = (database: Database, selectedSpaceId?: SpaceId): void => {
  const rebuild = database.transaction(() => {
    const states = database
      .query(
        `SELECT state.space_id, state.version AS source_state_version
         FROM memory_space_state state
         LEFT JOIN memory_search_projection_state projection ON projection.space_id = state.space_id
         WHERE ($spaceId IS NULL OR state.space_id = $spaceId)
           AND (
             projection.space_id IS NULL OR
             projection.source_state_version <> state.version OR
             projection.chunker_version <> $chunkerVersion
           )
         ORDER BY state.space_id ASC`,
      )
      .all({
        chunkerVersion: MEMORY_SEARCH_CHUNKER_VERSION,
        spaceId: selectedSpaceId ?? null,
      }) as MemorySearchProjectionStateRow[];
    for (const state of states) {
      const spaceId = parseSpaceId(state.space_id);
      if (
        typeof state.source_state_version !== 'number' ||
        !Number.isSafeInteger(state.source_state_version) ||
        state.source_state_version < 0
      ) {
        throw new MemoryRepositoryError('unavailable', 'rebuild-memory-search-projection');
      }
      database.query('DELETE FROM memory_search_chunks WHERE space_id = $spaceId').run({ spaceId });
      const rows = database.query(`${itemSelect} WHERE item.space_id = $spaceId ORDER BY item.id ASC`).all({
        spaceId,
      }) as ItemRevisionRow[];
      for (const row of rows) {
        const current = mapItemResult(row);
        insertMemorySearchProjection(database, current.item, current.revision);
      }
      markSearchProjectionState(database, spaceId, state.source_state_version);
    }
  });
  rebuild.immediate();
};

const proposalSelect = `
  SELECT id, space_id, project_id, proposed_kind, title, summary, guidance_json,
         structured_content_json, trust_candidate, sensitivity, status,
         proposed_by_kind, proposed_by_id, reviewed_by_person_id, reviewed_at, review_reason
  FROM memory_proposals
`;

const importSelect = `
  SELECT id, space_id, project_id, source_kind, source_locator, fingerprint,
         content_hash, preview_proof, status, created_at,
         confirmed_by_person_id, confirmed_at
  FROM memory_imports
`;

interface CursorPayload {
  readonly afterItemId: string;
  readonly projectId: string | null;
  readonly spaceId: string;
  readonly status: string | null;
  readonly version: 1;
}

const encodeCursor = (payload: CursorPayload): string => btoa(JSON.stringify(payload));

const decodeCursor = (cursor: string | null | undefined, query: ListMemoryItemsQuery): string | null => {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (typeof value !== 'object' || value === null) {
      throw new Error('invalid cursor');
    }
    const candidate = value as Partial<CursorPayload>;
    if (
      candidate.version !== 1 ||
      candidate.spaceId !== query.spaceId ||
      candidate.projectId !== (query.projectId ?? null) ||
      candidate.status !== (query.status ?? null) ||
      typeof candidate.afterItemId !== 'string'
    ) {
      throw new Error('invalid cursor');
    }
    return parseMemoryItemId(candidate.afterItemId);
  } catch {
    throw new MemoryRepositoryError('invalid-input', 'list-items');
  }
};

const decodeProposalCursor = (cursor: string | null | undefined, query: ListMemoryProposalsQuery): string | null => {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(atob(cursor));
    if (typeof value !== 'object' || value === null) {
      throw new Error('invalid cursor');
    }
    const candidate = value as Partial<CursorPayload>;
    if (
      candidate.version !== 1 ||
      candidate.spaceId !== query.spaceId ||
      candidate.status !== query.status ||
      candidate.projectId !== null ||
      typeof candidate.afterItemId !== 'string'
    ) {
      throw new Error('invalid cursor');
    }
    return parseMemoryProposalId(candidate.afterItemId);
  } catch {
    throw new MemoryRepositoryError('invalid-input', 'list-proposals');
  }
};

const storageOperation = <Value>(operation: string, run: () => Value): Promise<Value> => {
  try {
    return Promise.resolve(run());
  } catch (error) {
    if (error instanceof MemoryRepositoryError) {
      return Promise.reject(error);
    }
    return Promise.reject(new MemoryRepositoryError('unavailable', operation));
  }
};

const authorizedMemoryIds = (
  query: Pick<ListMemoryItemsQuery, 'authorizationScope' | 'spaceId'>,
  operation: string,
): readonly string[] => {
  const { authorizationScope } = query;
  if (
    authorizationScope.activeSpaceId !== query.spaceId ||
    authorizationScope.modelVersion !== AUTHORIZATION_MODEL_VERSION ||
    authorizationScope.permission !== 'view_memory' ||
    authorizationScope.resourceKind !== 'memory'
  ) {
    throw new MemoryRepositoryError('invalid-input', operation);
  }
  try {
    return readAuthorizedResourceScopeIds(authorizationScope);
  } catch {
    throw new MemoryRepositoryError('invalid-input', operation);
  }
};

const SQLITE_MEMORY_SEARCH_ADAPTER_VERSION = 'sqlite-fts5-v1' as const;

interface SqliteMemorySearchCursor {
  readonly adapterVersion: typeof SQLITE_MEMORY_SEARCH_ADAPTER_VERSION;
  readonly chunkerVersion: typeof MEMORY_SEARCH_CHUNKER_VERSION;
  readonly expiresAtEpochMs: number;
  readonly issuedAtEpochMs: number;
  readonly offset: number;
  readonly orderHash: string;
  readonly queryFingerprint: string;
  readonly rankingVersion: typeof MEMORY_SEARCH_RANKING_VERSION;
  readonly scopeHash: string;
  readonly version: 1;
}

const encodeMemorySearchCursor = (cursor: SqliteMemorySearchCursor): string => btoa(JSON.stringify(cursor));

const decodeMemorySearchCursor = (
  value: string | null,
  query: SearchMemoryRepositoryQuery,
  scopeHash: string,
): SqliteMemorySearchCursor | null => {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('invalid cursor');
    }
    const cursor = parsed as Partial<SqliteMemorySearchCursor>;
    if (
      cursor.version !== 1 ||
      cursor.adapterVersion !== SQLITE_MEMORY_SEARCH_ADAPTER_VERSION ||
      cursor.chunkerVersion !== MEMORY_SEARCH_CHUNKER_VERSION ||
      cursor.rankingVersion !== MEMORY_SEARCH_RANKING_VERSION ||
      cursor.queryFingerprint !== query.queryFingerprint ||
      typeof cursor.orderHash !== 'string' ||
      cursor.orderHash.length !== 64 ||
      typeof cursor.issuedAtEpochMs !== 'number' ||
      typeof cursor.expiresAtEpochMs !== 'number' ||
      cursor.expiresAtEpochMs - cursor.issuedAtEpochMs !== memorySearchBounds.cursorLifetimeMs ||
      typeof cursor.offset !== 'number' ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    ) {
      throw new Error('invalid cursor');
    }
    if (query.nowEpochMs > cursor.expiresAtEpochMs || query.nowEpochMs < cursor.issuedAtEpochMs) {
      throw new MemoryRepositoryError('stale', 'search-items-cursor');
    }
    if (cursor.scopeHash !== scopeHash) {
      throw new MemoryRepositoryError('stale', 'search-items-cursor-authorization');
    }
    return cursor as SqliteMemorySearchCursor;
  } catch (error) {
    if (error instanceof MemoryRepositoryError) {
      throw error;
    }
    throw new MemoryRepositoryError('invalid-input', 'search-items-cursor');
  }
};

const authorizedSearchMemoryIds = (query: SearchMemoryRepositoryQuery): readonly string[] => {
  const expectedPermission = query.historyMode === 'include' ? 'manage_memory' : 'view_memory';
  const { authorizationScope } = query;
  if (
    authorizationScope.activeSpaceId !== query.spaceId ||
    authorizationScope.modelVersion !== AUTHORIZATION_MODEL_VERSION ||
    authorizationScope.permission !== expectedPermission ||
    authorizationScope.resourceKind !== 'memory'
  ) {
    throw new MemoryRepositoryError('invalid-input', 'search-items-authorization');
  }
  try {
    return readAuthorizedResourceScopeIds(authorizationScope)
      .map((id) => parseMemoryItemId(id))
      .sort();
  } catch {
    throw new MemoryRepositoryError('invalid-input', 'search-items-authorization');
  }
};

const memorySearchScopeHash = (query: SearchMemoryRepositoryQuery, authorizedIds: readonly string[]): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        activeSpaceId: query.spaceId,
        permission: query.authorizationScope.permission,
        resourceIds: authorizedIds,
      }),
    )
    .digest('hex');

const presenceScore = (column: string, parameter: string, weight: number): string =>
  `(CASE WHEN instr(${column}, $${parameter}) > 0 THEN ${weight} ELSE 0 END)`;

const sumScores = (scores: readonly string[]): string => (scores.length === 0 ? '0.0' : scores.join(' + '));

const weightedTermScore = (
  parameterPrefix: string,
  valueCount: number,
  fields: readonly { readonly column: string; readonly weight: number }[],
): string =>
  sumScores(
    Array.from({ length: valueCount }, (_, index) =>
      fields.map(({ column, weight }) => presenceScore(column, `${parameterPrefix}${index}`, weight)),
    ).flat(),
  );

const weightedTrigramScore = (
  trigramCount: number,
  fields: readonly { readonly column: string; readonly weight: number }[],
): string => {
  if (trigramCount === 0) {
    return '0.0';
  }
  return fields
    .map(
      ({ column, weight }) =>
        `((${sumScores(
          Array.from({ length: trigramCount }, (_, index) => presenceScore(column, `trigram${index}`, 1)),
        )}) * ${weight} / ${trigramCount})`,
    )
    .join(' + ');
};

const memorySearchSql = (
  query: SearchMemoryRepositoryQuery,
): {
  readonly bindings: Record<string, number | string | null>;
  readonly cte: string;
  readonly orderBy: string;
} => {
  const compiled = compileMemorySearchQuery(query.query, query.matchingMode);
  const bindings: Record<string, number | string | null> = {
    authorizedIds: JSON.stringify(authorizedSearchMemoryIds(query)),
    includeSpaceWide: query.includeSpaceWide ? 1 : 0,
    kinds: JSON.stringify(query.kinds),
    lexicalFtsQuery: compiled.lexicalFtsQuery,
    literal: compiled.normalizedLiteral,
    literal0: compiled.normalizedLiteral,
    minimumScore: query.matchingMode === 'literal' ? 1 : 1.5,
    projectId: query.projectId,
    spaceId: query.spaceId,
    statuses: JSON.stringify(query.statuses),
    trigramFtsQuery: compiled.trigramFtsQuery,
    trust: JSON.stringify(query.trust),
  };
  for (const [index, term] of compiled.terms.entries()) {
    bindings[`term${index}`] = term;
  }
  for (const [index, trigram] of compiled.trigrams.entries()) {
    bindings[`trigram${index}`] = trigram;
  }
  const candidateSources = [
    `SELECT eligible.rowid
     FROM eligible
     WHERE instr(eligible.normalized_title, $literal) > 0
        OR instr(eligible.normalized_summary, $literal) > 0
        OR instr(eligible.normalized_guidance, $literal) > 0
        OR instr(eligible.normalized_structured_terms, $literal) > 0
        OR instr(eligible.normalized_supporting_text, $literal) > 0`,
  ];
  if (query.matchingMode === 'hybrid' && compiled.lexicalFtsQuery.length > 0) {
    candidateSources.push(
      `SELECT eligible.rowid
       FROM memory_search_fts
       INNER JOIN eligible ON eligible.rowid = memory_search_fts.rowid
       WHERE memory_search_fts MATCH $lexicalFtsQuery`,
    );
  }
  if (query.matchingMode === 'hybrid' && compiled.trigramFtsQuery.length > 0) {
    candidateSources.push(
      `SELECT eligible.rowid
       FROM memory_search_trigram_fts
       INNER JOIN eligible ON eligible.rowid = memory_search_trigram_fts.rowid
       WHERE memory_search_trigram_fts MATCH $trigramFtsQuery`,
    );
  }
  const exactScore = weightedTermScore('literal', 1, [
    { column: 'eligible.normalized_title', weight: 100 },
    { column: 'eligible.normalized_summary', weight: 60 },
    { column: 'eligible.normalized_guidance', weight: 50 },
    { column: 'eligible.normalized_structured_terms', weight: 50 },
    { column: 'eligible.normalized_supporting_text', weight: 20 },
  ]);
  const lexicalScore = weightedTermScore('term', compiled.terms.length, [
    { column: 'eligible.normalized_title', weight: 12 },
    { column: 'eligible.normalized_summary', weight: 6 },
    { column: 'eligible.normalized_guidance', weight: 5 },
    { column: 'eligible.normalized_structured_terms', weight: 4 },
    { column: 'eligible.normalized_supporting_text', weight: 1 },
  ]);
  const trigramScore = weightedTrigramScore(compiled.trigrams.length, [
    { column: 'eligible.normalized_title', weight: 6 },
    { column: 'eligible.normalized_summary', weight: 3 },
    { column: 'eligible.normalized_guidance', weight: 2.5 },
    { column: 'eligible.normalized_structured_terms', weight: 2 },
    { column: 'eligible.normalized_supporting_text', weight: 1 },
  ]);
  const orderBy = 'total_score DESC, exact_score DESC, lexical_score DESC, trigram_score DESC, memory_item_id ASC';
  return {
    bindings,
    cte: `
      WITH eligible AS (
        SELECT chunk.*
        FROM memory_search_chunks chunk
        WHERE chunk.space_id = $spaceId
          AND chunk.memory_item_id IN (SELECT value FROM json_each($authorizedIds))
          AND chunk.kind IN (SELECT value FROM json_each($kinds))
          AND chunk.status IN (SELECT value FROM json_each($statuses))
          AND chunk.trust IN (SELECT value FROM json_each($trust))
          AND (
            $projectId IS NULL OR
            chunk.project_id = $projectId OR
            ($includeSpaceWide = 1 AND chunk.scope IN ('space', 'person'))
          )
      ),
      candidate_rowids AS (
        ${candidateSources.join('\nUNION\n')}
      ),
      component_scores AS (
        SELECT eligible.*,
               (${exactScore}) AS exact_score,
               (${lexicalScore}) AS lexical_score,
               (${trigramScore}) AS trigram_score
        FROM eligible
        INNER JOIN candidate_rowids candidate ON candidate.rowid = eligible.rowid
      ),
      scored_chunks AS (
        SELECT component_scores.*,
               exact_score + lexical_score + trigram_score AS total_score
        FROM component_scores
      ),
      ranked_chunks AS (
        SELECT scored_chunks.*,
               row_number() OVER (
                 PARTITION BY memory_item_id
                 ORDER BY total_score DESC, exact_score DESC, lexical_score DESC,
                          trigram_score DESC, chunk_ordinal ASC
               ) AS item_chunk_rank
        FROM scored_chunks
        WHERE total_score >= $minimumScore
      ),
      best_items AS (
        SELECT * FROM ranked_chunks WHERE item_chunk_rank = 1
      )`,
    orderBy,
  };
};

const numberValue = (value: unknown, operation: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MemoryRepositoryError('unavailable', operation);
  }
  return value;
};

const insertImportedObservation = (database: Database, observation: MemoryObservation): void => {
  const actor = principalColumns(observation.createdByPrincipal);
  database
    .query(
      `INSERT INTO memory_observations
        (id, space_id, project_id, capture_context_id, source_kind, source_locator,
         fingerprint, content_hash, observed_at, content_json, sensitivity,
         redaction_rule_set_version, created_by_kind, created_by_id)
       VALUES ($id, $spaceId, $projectId, $captureContextId, $sourceKind, $sourceLocator,
               $fingerprint, $contentHash, $observedAt, $content, $sensitivity,
               $ruleSetVersion, $actorKind, $actorId)`,
    )
    .run({
      actorId: actor.id,
      actorKind: actor.kind,
      captureContextId: observation.captureContextId,
      content: JSON.stringify(observation.content),
      contentHash: observation.contentHash,
      fingerprint: observation.fingerprint,
      id: observation.id,
      observedAt: observation.observedAt,
      projectId: observation.projectId,
      ruleSetVersion: observation.redactionRuleSetVersion,
      sensitivity: observation.sensitivity,
      sourceKind: observation.sourceKind,
      sourceLocator: observation.sourceLocator,
      spaceId: observation.owningSpaceId,
    });
};

const insertImportedProposal = (database: Database, proposal: MemoryProposal, itemId: string | null): void => {
  const actor = principalColumns(proposal.proposedByPrincipal);
  database
    .query(
      `INSERT INTO memory_proposals
        (id, space_id, project_id, proposed_kind, title, summary, guidance_json,
         structured_content_json, trust_candidate, sensitivity, status,
         proposed_by_kind, proposed_by_id, reviewed_by_person_id, reviewed_at,
         review_reason, accepted_memory_item_id)
       VALUES ($id, $spaceId, $projectId, $kind, $title, $summary, $guidance,
               $structuredContent, $trust, $sensitivity, $status,
               $actorKind, $actorId, $reviewedBy, $reviewedAt, $reviewReason, $itemId)`,
    )
    .run({
      actorId: actor.id,
      actorKind: actor.kind,
      guidance: JSON.stringify(proposal.guidance),
      id: proposal.id,
      itemId,
      kind: proposal.proposedKind,
      projectId: proposal.projectId,
      reviewedAt: proposal.reviewedAt,
      reviewedBy: proposal.reviewedByPersonId,
      reviewReason: proposal.reviewReason,
      sensitivity: proposal.sensitivity,
      spaceId: proposal.owningSpaceId,
      status: proposal.status,
      structuredContent: JSON.stringify(proposal.structuredContent),
      summary: proposal.summary,
      title: proposal.title,
      trust: proposal.trustCandidate,
    });
};

const insertImportedItem = (database: Database, item: MemoryItem, revision: MemoryRevision): void => {
  database
    .query(
      `INSERT INTO memory_items
        (id, space_id, project_id, scope, kind, status, trust, sensitivity, current_revision_id)
       VALUES ($id, $spaceId, $projectId, $scope, $kind, $status, $trust, $sensitivity, $revisionId)`,
    )
    .run({
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      revisionId: item.currentRevisionId,
      scope: item.scope,
      sensitivity: item.sensitivity,
      spaceId: item.owningSpaceId,
      status: item.status,
      trust: item.trust,
    });
  insertRevision(database, revision, item.owningSpaceId);
};

const insertImportedRelation = (database: Database, relation: MemoryRelation): void => {
  const actor = principalColumns(relation.createdByPrincipal);
  database
    .query(
      `INSERT INTO memory_relations
        (id, space_id, from_memory_item_id, to_memory_item_id, relation_kind,
         created_by_kind, created_by_id, created_at, reason)
       VALUES ($id, $spaceId, $fromId, $toId, $kind, $actorKind, $actorId, $createdAt, $reason)
       ON CONFLICT (space_id, from_memory_item_id, to_memory_item_id, relation_kind) DO NOTHING`,
    )
    .run({
      actorId: actor.id,
      actorKind: actor.kind,
      createdAt: relation.createdAt,
      fromId: relation.fromMemoryItemId,
      id: relation.id,
      kind: relation.kind,
      reason: relation.reason,
      spaceId: relation.owningSpaceId,
      toId: relation.toMemoryItemId,
    });
};

export const createSqliteMemoryRepository = (database: Database): MemoryRepository => {
  rebuildSqliteMemorySearchProjection(database);
  const repository: MemoryRepository = {
    acceptProposal: (input) =>
      storageOperation('accept-proposal', () => {
        const accept = database.transaction(() => {
          if (
            input.item.owningSpaceId !== input.audit.spaceId ||
            input.item.id !== input.revision.memoryItemId ||
            input.item.currentRevisionId !== input.revision.id ||
            input.revision.revisionNumber !== 1 ||
            (input.item.scope === 'project' && input.item.projectId === null)
          ) {
            throw new MemoryRepositoryError('invalid-input', 'accept-proposal');
          }
          const proposal = database
            .query('SELECT project_id, status FROM memory_proposals WHERE id = $id AND space_id = $spaceId')
            .get({ id: input.proposalId, spaceId: input.item.owningSpaceId }) as {
            readonly project_id: unknown;
            readonly status: unknown;
          } | null;
          if (!proposal) {
            throw new MemoryRepositoryError('not-found', 'accept-proposal');
          }
          if (proposal.status !== 'pending' || proposal.project_id !== input.item.projectId) {
            throw new MemoryRepositoryError('conflict', 'accept-proposal');
          }
          database
            .query(
              `INSERT INTO memory_items
                (id, space_id, project_id, scope, kind, status, trust, sensitivity, current_revision_id)
               VALUES ($id, $spaceId, $projectId, $scope, $kind, $status, $trust, $sensitivity, $revisionId)`,
            )
            .run({
              id: input.item.id,
              kind: input.item.kind,
              projectId: input.item.projectId,
              revisionId: input.item.currentRevisionId,
              scope: input.item.scope,
              sensitivity: input.item.sensitivity,
              spaceId: input.item.owningSpaceId,
              status: input.item.status,
              trust: input.item.trust,
            });
          insertRevision(database, input.revision, input.item.owningSpaceId);
          const updated = database
            .query(
              `UPDATE memory_proposals
               SET status = 'accepted', reviewed_by_person_id = $personId,
                   reviewed_at = $reviewedAt, review_reason = $reason,
                   accepted_memory_item_id = $itemId
               WHERE id = $id AND space_id = $spaceId AND status = 'pending'`,
            )
            .run({
              id: input.proposalId,
              itemId: input.item.id,
              personId: input.reviewerPersonId,
              reason: input.revision.reason,
              reviewedAt: input.reviewedAt,
              spaceId: input.item.owningSpaceId,
            });
          if (updated.changes !== 1) {
            throw new MemoryRepositoryError('conflict', 'accept-proposal');
          }
          replaceMemorySearchProjection(database, input.item, input.revision);
          insertOutbox(database, input.outboxEvent);
          bumpMemoryState(database, input.item.owningSpaceId);
          insertAudit(database, input.audit);
        });
        accept.immediate();
        return { item: input.item, revision: input.revision };
      }),
    confirmImport: (input: ConfirmMemoryImportInput): Promise<ConfirmMemoryImportResult> =>
      storageOperation('confirm-import', () => {
        const confirm = database.transaction((): ConfirmMemoryImportResult => {
          const row = database
            .query(`${importSelect} WHERE id = $id AND space_id = $spaceId`)
            .get({ id: input.importId, spaceId: input.spaceId }) as MemoryImportRow | null;
          if (!row) {
            throw new MemoryRepositoryError('not-found', 'confirm-import');
          }
          const memoryImport = mapMemoryImport(row);
          if (memoryImport.status === 'confirmed') {
            return { kind: 'already-confirmed' };
          }
          if (memoryImport.status === 'quarantined') {
            return { kind: 'quarantined' };
          }
          const stateVersion = ensureMemoryState(database, input.spaceId);
          const currentProof = memoryImportPreviewProof({
            contentHash: memoryImport.contentHash,
            destinationProjectId: memoryImport.destinationProjectId,
            destinationSpaceId: memoryImport.destinationSpaceId,
            destinationStateVersion: stateVersion,
            fingerprint: memoryImport.fingerprint,
          });
          if (input.previewProof !== memoryImport.previewProof || currentProof !== memoryImport.previewProof) {
            database
              .query("UPDATE memory_imports SET status = 'stale' WHERE id = $id AND space_id = $spaceId")
              .run({ id: input.importId, spaceId: input.spaceId });
            insertAudit(database, { ...input.audit, result: 'rejected' });
            return { kind: 'stale' };
          }
          for (const record of input.records) {
            const { item, observation, proposal, revision } = record;
            const itemPairIsValid =
              (item === null && revision === null && proposal.status !== 'accepted') ||
              (item !== null &&
                revision !== null &&
                proposal.status === 'accepted' &&
                item.id === revision.memoryItemId &&
                item.currentRevisionId === revision.id &&
                revision.revisionNumber === 1);
            if (
              !itemPairIsValid ||
              observation.owningSpaceId !== input.spaceId ||
              proposal.owningSpaceId !== input.spaceId ||
              proposal.projectId !== observation.projectId ||
              (item !== null && (item.owningSpaceId !== input.spaceId || item.projectId !== proposal.projectId)) ||
              memoryContentHash(observation.content) !== observation.contentHash
            ) {
              throw new MemoryRepositoryError('invalid-input', 'confirm-import');
            }
          }
          const importedFingerprints: string[] = [];
          for (const record of input.records) {
            const existing = database
              .query(
                `SELECT id, content_hash FROM memory_observations
                 WHERE space_id = $spaceId AND fingerprint = $fingerprint`,
              )
              .get({
                fingerprint: record.observation.fingerprint,
                spaceId: input.spaceId,
              }) as ExistingObservationRow | null;
            if (existing) {
              if (
                parseMemoryObservationId(existing.id) !== record.observation.id ||
                existing.content_hash !== record.observation.contentHash
              ) {
                throw new MemoryRepositoryError('conflict', 'confirm-import');
              }
              continue;
            }
            insertImportedObservation(database, record.observation);
            insertImportedProposal(database, record.proposal, record.item?.id ?? null);
            database
              .query(
                `INSERT INTO memory_proposal_observations (space_id, proposal_id, observation_id)
                 VALUES ($spaceId, $proposalId, $observationId)`,
              )
              .run({
                observationId: record.observation.id,
                proposalId: record.proposal.id,
                spaceId: input.spaceId,
              });
            if (record.item && record.revision) {
              insertImportedItem(database, record.item, record.revision);
              insertOutbox(database, record.outboxEvent);
            }
            importedFingerprints.push(record.observation.fingerprint);
          }
          for (const relation of input.relations) {
            if (relation.owningSpaceId !== input.spaceId) {
              throw new MemoryRepositoryError('invalid-input', 'confirm-import');
            }
            insertImportedRelation(database, relation);
          }
          const updated = database
            .query(
              `UPDATE memory_imports
               SET status = 'confirmed', confirmed_by_person_id = $personId, confirmed_at = $confirmedAt
               WHERE id = $id AND space_id = $spaceId AND status IN ('previewed', 'stale')`,
            )
            .run({
              confirmedAt: input.confirmedAt,
              id: input.importId,
              personId: input.confirmedByPersonId,
              spaceId: input.spaceId,
            });
          if (updated.changes !== 1) {
            throw new MemoryRepositoryError('stale', 'confirm-import');
          }
          for (const record of input.records) {
            if (record.item && record.revision) {
              replaceMemorySearchProjection(database, record.item, record.revision);
            }
          }
          bumpMemoryState(database, input.spaceId);
          insertAudit(database, input.audit);
          return { importedObservationFingerprints: importedFingerprints, kind: 'confirmed' };
        });
        return confirm.immediate();
      }),
    createProposal: (input: CreateProposalInput) =>
      storageOperation('create-proposal', () => {
        const create = database.transaction(() => {
          if (input.proposal.owningSpaceId !== input.audit.spaceId || input.proposal.status !== 'pending') {
            throw new MemoryRepositoryError('invalid-input', 'create-proposal');
          }
          const actor = principalColumns(input.proposal.proposedByPrincipal);
          database
            .query(
              `INSERT INTO memory_proposals
                (id, space_id, project_id, proposed_kind, title, summary, guidance_json,
                 structured_content_json, trust_candidate, sensitivity, status,
                 proposed_by_kind, proposed_by_id)
               VALUES ($id, $spaceId, $projectId, $kind, $title, $summary, $guidance,
                       $structuredContent, $trust, $sensitivity, 'pending', $actorKind, $actorId)`,
            )
            .run({
              actorId: actor.id,
              actorKind: actor.kind,
              guidance: JSON.stringify(input.proposal.guidance),
              id: input.proposal.id,
              kind: input.proposal.proposedKind,
              projectId: input.proposal.projectId,
              sensitivity: input.proposal.sensitivity,
              spaceId: input.proposal.owningSpaceId,
              structuredContent: JSON.stringify(input.proposal.structuredContent),
              summary: input.proposal.summary,
              title: input.proposal.title,
              trust: input.proposal.trustCandidate,
            });
          const uniqueObservationIds = new Set(input.observationIds);
          if (
            uniqueObservationIds.size !== input.observationIds.length ||
            (input.proposal.trustCandidate === 'harvest-accepted' && uniqueObservationIds.size === 0)
          ) {
            throw new MemoryRepositoryError('invalid-input', 'create-proposal');
          }
          const link = database.query(
            `INSERT INTO memory_proposal_observations (space_id, proposal_id, observation_id)
             VALUES ($spaceId, $proposalId, $observationId)`,
          );
          for (const observationId of uniqueObservationIds) {
            link.run({ observationId, proposalId: input.proposal.id, spaceId: input.proposal.owningSpaceId });
          }
          bumpMemoryState(database, input.proposal.owningSpaceId);
          insertAudit(database, input.audit);
        });
        create.immediate();
        return input.proposal.id;
      }),
    createRelation: (relation: MemoryRelation, event: MemoryAuditEvent) =>
      storageOperation('create-relation', () => {
        const create = database.transaction(() => {
          if (relation.owningSpaceId !== event.spaceId || relation.fromMemoryItemId === relation.toMemoryItemId) {
            throw new MemoryRepositoryError('invalid-input', 'create-relation');
          }
          const itemCount = database
            .query(
              `SELECT count(*) AS count FROM memory_items
               WHERE space_id = $spaceId AND id IN ($fromId, $toId)`,
            )
            .get({
              fromId: relation.fromMemoryItemId,
              spaceId: relation.owningSpaceId,
              toId: relation.toMemoryItemId,
            }) as { readonly count: unknown } | null;
          if (itemCount?.count !== 2) {
            throw new MemoryRepositoryError('invalid-input', 'create-relation');
          }
          const actor = principalColumns(relation.createdByPrincipal);
          database
            .query(
              `INSERT INTO memory_relations
                (id, space_id, from_memory_item_id, to_memory_item_id, relation_kind,
                 created_by_kind, created_by_id, created_at, reason)
               VALUES ($id, $spaceId, $fromId, $toId, $kind, $actorKind, $actorId, $createdAt, $reason)`,
            )
            .run({
              actorId: actor.id,
              actorKind: actor.kind,
              createdAt: relation.createdAt,
              fromId: relation.fromMemoryItemId,
              id: relation.id,
              kind: relation.kind,
              reason: relation.reason,
              spaceId: relation.owningSpaceId,
              toId: relation.toMemoryItemId,
            });
          bumpMemoryState(database, relation.owningSpaceId);
          insertAudit(database, event);
        });
        create.immediate();
      }),
    exportMemory: (query: ExportMemoryQuery): Promise<MemoryExportSnapshot> =>
      storageOperation('export-memory', () => {
        const authorizedIds = JSON.stringify(authorizedMemoryIds(query, 'export-memory'));
        const itemRows = database
          .query(
            `${itemSelect}
             WHERE item.space_id = $spaceId
               AND item.id IN (SELECT value FROM json_each($authorizedIds))
               AND ($projectId IS NULL OR item.project_id = $projectId)
             ORDER BY item.id ASC LIMIT 1001`,
          )
          .all({ authorizedIds, projectId: query.projectId ?? null, spaceId: query.spaceId }) as ItemRevisionRow[];
        if (itemRows.length > 1000) {
          throw new MemoryRepositoryError('invalid-input', 'export-memory');
        }
        const revisionsQuery = database.query(
          `${itemRevisionHistorySelect}
           WHERE item.space_id = $spaceId AND item.id = $itemId
           ORDER BY revision.revision_number ASC LIMIT 1001`,
        );
        const provenanceQuery = database.query(
          `SELECT observation.id, observation.source_kind, observation.source_locator,
                  observation.observed_at, observation.sensitivity
           FROM memory_proposals proposal
           INNER JOIN memory_proposal_observations link ON link.proposal_id = proposal.id
           INNER JOIN memory_observations observation ON observation.id = link.observation_id
           WHERE proposal.space_id = $spaceId AND proposal.accepted_memory_item_id = $itemId
           ORDER BY observation.id ASC LIMIT 101`,
        );
        const relationsQuery = database.query(
          `SELECT relation_kind, to_memory_item_id, reason
           FROM memory_relations
           WHERE space_id = $spaceId AND from_memory_item_id = $itemId
           ORDER BY relation_kind ASC, to_memory_item_id ASC LIMIT 101`,
        );
        const items = itemRows.map((itemRow) => {
          const current = mapItemResult(itemRow);
          const revisionRows = revisionsQuery.all({
            itemId: current.item.id,
            spaceId: query.spaceId,
          }) as ItemRevisionRow[];
          const sourceRows = provenanceQuery.all({
            itemId: current.item.id,
            spaceId: query.spaceId,
          }) as ProposalObservationSourceRow[];
          const relationRows = relationsQuery.all({
            itemId: current.item.id,
            spaceId: query.spaceId,
          }) as ExportRelationRow[];
          if (revisionRows.length > 1000 || sourceRows.length > 100 || relationRows.length > 100) {
            throw new MemoryRepositoryError('invalid-input', 'export-memory');
          }
          return {
            item: current.item,
            provenance: sourceRows.map((source) => ({
              id: parseMemoryObservationId(source.id),
              observedAt: parseInstant(source.observed_at),
              sensitivity: enumValue(source.sensitivity, sensitivities, 'map-export-source'),
              sourceKind: enumValue(source.source_kind, observationSourceKinds, 'map-export-source'),
              sourceLocator: optionalString(source.source_locator, 'map-export-source'),
            })),
            relations: relationRows.map((relation) => ({
              kind: enumValue(relation.relation_kind, relationKinds, 'map-export-relation'),
              reason: optionalString(relation.reason, 'map-export-relation'),
              toMemoryItemId: parseMemoryItemId(relation.to_memory_item_id),
            })),
            revisions: revisionRows.map((row) => mapItemResult(row).revision),
          };
        });
        return { items, spaceId: query.spaceId };
      }),
    getItem: (spaceId, itemId) =>
      storageOperation('get-item', () => {
        const row = database
          .query(`${itemSelect} WHERE item.space_id = $spaceId AND item.id = $itemId`)
          .get({ itemId, spaceId }) as ItemRevisionRow | null;
        return row ? mapItemResult(row) : null;
      }),
    getProposal: (spaceId, proposalId) =>
      storageOperation('get-proposal', () => {
        const row = database
          .query(`${proposalSelect} WHERE space_id = $spaceId AND id = $proposalId`)
          .get({ proposalId, spaceId }) as ProposalRow | null;
        return row ? mapProposal(row) : null;
      }),
    listAuthorizationResourceIds: (spaceId) =>
      storageOperation('list-memory-authorization-resources', () => {
        const rows = database
          .query(
            `SELECT id FROM memory_items WHERE space_id = $spaceId
             UNION
             SELECT id FROM memory_proposals WHERE space_id = $spaceId AND status = 'pending'
             ORDER BY id ASC`,
          )
          .all({ spaceId }) as { readonly id: unknown }[];
        return rows.map((row) => requiredString(row.id, 'list-memory-authorization-resources'));
      }),
    listItems: (query) =>
      storageOperation('list-items', () => {
        if (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100) {
          throw new MemoryRepositoryError('invalid-input', 'list-items');
        }
        const authorizedIds = JSON.stringify(authorizedMemoryIds(query, 'list-items'));
        const afterItemId = decodeCursor(query.cursor, query);
        const rows = database
          .query(
            `${itemSelect}
             WHERE item.space_id = $spaceId
               AND item.id IN (SELECT value FROM json_each($authorizedIds))
               AND ($projectId IS NULL OR item.project_id = $projectId)
               AND ($status IS NULL OR item.status = $status)
               AND ($afterItemId IS NULL OR item.id > $afterItemId)
             ORDER BY item.id ASC
             LIMIT $limit`,
          )
          .all({
            afterItemId,
            authorizedIds,
            limit: query.pageSize + 1,
            projectId: query.projectId ?? null,
            spaceId: query.spaceId,
            status: query.status ?? null,
          }) as ItemRevisionRow[];
        const hasNext = rows.length > query.pageSize;
        const items = (hasNext ? rows.slice(0, query.pageSize) : rows).map(mapItemResult);
        const lastItem = items.at(-1);
        return {
          items,
          nextCursor:
            hasNext && lastItem
              ? encodeCursor({
                  afterItemId: lastItem.item.id,
                  projectId: query.projectId ?? null,
                  spaceId: query.spaceId,
                  status: query.status ?? null,
                  version: 1,
                })
              : null,
        };
      }),
    listProposals: (query) =>
      storageOperation('list-proposals', () => {
        if (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100) {
          throw new MemoryRepositoryError('invalid-input', 'list-proposals');
        }
        const authorizedIds = JSON.stringify(authorizedMemoryIds(query, 'list-proposals'));
        const afterProposalId = decodeProposalCursor(query.cursor, query);
        const rows = database
          .query(
            `${proposalSelect}
             WHERE space_id = $spaceId AND status = $status
               AND id IN (SELECT value FROM json_each($authorizedIds))
               AND ($afterProposalId IS NULL OR id > $afterProposalId)
             ORDER BY id ASC LIMIT $limit`,
          )
          .all({
            afterProposalId,
            authorizedIds,
            limit: query.pageSize + 1,
            spaceId: query.spaceId,
            status: query.status,
          }) as ProposalRow[];
        const hasNext = rows.length > query.pageSize;
        const pageRows = hasNext ? rows.slice(0, query.pageSize) : rows;
        const sourcesQuery = database.query(
          `SELECT observation.id, observation.source_kind, observation.source_locator,
                  observation.observed_at, observation.sensitivity
           FROM memory_proposal_observations link
           INNER JOIN memory_observations observation ON observation.id = link.observation_id
           WHERE link.space_id = $spaceId AND link.proposal_id = $proposalId
           ORDER BY observation.id ASC LIMIT 101`,
        );
        const items = pageRows.map((row) => {
          const proposal = mapProposal(row);
          const sources = sourcesQuery.all({
            proposalId: proposal.id,
            spaceId: query.spaceId,
          }) as ProposalObservationSourceRow[];
          if (sources.length > 100) {
            throw new MemoryRepositoryError('unavailable', 'list-proposals');
          }
          return {
            observationSources: sources.map((source) => ({
              id: parseMemoryObservationId(source.id),
              observedAt: parseInstant(source.observed_at),
              sensitivity: enumValue(source.sensitivity, sensitivities, 'map-proposal-source'),
              sourceKind: enumValue(source.source_kind, observationSourceKinds, 'map-proposal-source'),
              sourceLocator: optionalString(source.source_locator, 'map-proposal-source'),
            })),
            proposal,
          };
        });
        const lastProposal = items.at(-1)?.proposal;
        return {
          items,
          nextCursor:
            hasNext && lastProposal
              ? encodeCursor({
                  afterItemId: lastProposal.id,
                  projectId: null,
                  spaceId: query.spaceId,
                  status: query.status,
                  version: 1,
                })
              : null,
        };
      }),
    previewImport: (input: PreviewMemoryImportInput): Promise<PreviewMemoryImportResult> =>
      storageOperation('preview-import', () => {
        const preview = database.transaction((): PreviewMemoryImportResult => {
          if (
            input.audit.spaceId !== input.destinationSpaceId ||
            input.audit.subjectId !== input.id ||
            input.observationFingerprints.length > 1000 ||
            new Set(input.observationFingerprints).size !== input.observationFingerprints.length ||
            input.sourceLocator.length === 0 ||
            input.sourceLocator.length > 4096
          ) {
            throw new MemoryRepositoryError('invalid-input', 'preview-import');
          }
          const stateVersion = ensureMemoryState(database, input.destinationSpaceId);
          const previewProof = memoryImportPreviewProof({
            contentHash: input.contentHash,
            destinationProjectId: input.destinationProjectId,
            destinationSpaceId: input.destinationSpaceId,
            destinationStateVersion: stateVersion,
            fingerprint: input.fingerprint,
          });
          const existingRow = database
            .query(`${importSelect} WHERE space_id = $spaceId AND fingerprint = $fingerprint`)
            .get({ fingerprint: input.fingerprint, spaceId: input.destinationSpaceId }) as MemoryImportRow | null;
          if (existingRow && parseMemoryImportId(existingRow.id) !== input.id) {
            throw new MemoryRepositoryError('conflict', 'preview-import');
          }
          const duplicateFingerprints: string[] = [];
          const observationQuery = database.query(
            'SELECT id FROM memory_observations WHERE space_id = $spaceId AND fingerprint = $fingerprint',
          );
          for (const fingerprint of input.observationFingerprints) {
            if (observationQuery.get({ fingerprint, spaceId: input.destinationSpaceId })) {
              duplicateFingerprints.push(fingerprint);
            }
          }
          if (existingRow && existingRow.status === 'confirmed') {
            insertAudit(database, input.audit);
            return {
              alreadyConfirmed: true,
              duplicateObservationFingerprints: duplicateFingerprints,
              memoryImport: mapMemoryImport(existingRow),
            };
          }
          database
            .query(
              `INSERT INTO memory_imports
                (id, space_id, project_id, source_kind, source_locator, fingerprint,
                 content_hash, preview_proof, status, created_at)
               VALUES ($id, $spaceId, $projectId, $sourceKind, $sourceLocator, $fingerprint,
                       $contentHash, $previewProof, $status, $createdAt)
               ON CONFLICT (space_id, fingerprint) DO UPDATE SET
                 project_id = excluded.project_id,
                 source_kind = excluded.source_kind,
                 source_locator = excluded.source_locator,
                 content_hash = excluded.content_hash,
                 preview_proof = excluded.preview_proof,
                 status = excluded.status,
                 created_at = excluded.created_at,
                 confirmed_by_person_id = NULL,
                 confirmed_at = NULL`,
            )
            .run({
              contentHash: input.contentHash,
              createdAt: input.createdAt,
              fingerprint: input.fingerprint,
              id: input.id,
              previewProof,
              projectId: input.destinationProjectId,
              sourceKind: input.sourceKind,
              sourceLocator: input.sourceLocator,
              spaceId: input.destinationSpaceId,
              status: input.status,
            });
          const stored = database
            .query(`${importSelect} WHERE id = $id AND space_id = $spaceId`)
            .get({ id: input.id, spaceId: input.destinationSpaceId }) as MemoryImportRow | null;
          if (!stored) {
            throw new MemoryRepositoryError('unavailable', 'preview-import');
          }
          insertAudit(database, input.audit);
          return {
            alreadyConfirmed: false,
            duplicateObservationFingerprints: duplicateFingerprints,
            memoryImport: mapMemoryImport(stored),
          };
        });
        return preview.immediate();
      }),
    purgeItem: (input: PurgeMemoryItemInput) =>
      storageOperation('purge-memory-item', () => {
        const purge = database.transaction(() => {
          if (
            input.audit.spaceId !== input.spaceId ||
            input.audit.subjectId !== input.itemId ||
            input.audit.subjectType !== 'memory-item' ||
            (input.outboxEvent !== null &&
              (input.outboxEvent.factKey !== `memory-item:${input.itemId}` ||
                input.outboxEvent.owningSpaceId !== input.spaceId ||
                input.outboxEvent.payload.kind !== 'memory-fact-tombstone' ||
                input.outboxEvent.payload.itemId !== input.itemId ||
                input.outboxEvent.payload.reasonCode !== 'privacy-purged'))
          ) {
            throw new MemoryRepositoryError('invalid-input', 'purge-memory-item');
          }
          const exists = database
            .query('SELECT 1 FROM memory_items WHERE id = $itemId AND space_id = $spaceId')
            .get({ itemId: input.itemId, spaceId: input.spaceId });
          if (!exists) {
            throw new MemoryRepositoryError('not-found', 'purge-memory-item');
          }
          const observationRows = database
            .query(
              `SELECT DISTINCT link.observation_id
               FROM memory_proposals proposal
               INNER JOIN memory_proposal_observations link
                 ON link.proposal_id = proposal.id AND link.space_id = proposal.space_id
               WHERE proposal.space_id = $spaceId AND proposal.accepted_memory_item_id = $itemId`,
            )
            .all({ itemId: input.itemId, spaceId: input.spaceId }) as { readonly observation_id: unknown }[];
          database.query('INSERT INTO memory_privacy_purge_context (singleton) VALUES (1)').run();
          database
            .query(
              `DELETE FROM memory_proposal_observations
               WHERE space_id = $spaceId AND proposal_id IN (
                 SELECT id FROM memory_proposals
                 WHERE space_id = $spaceId AND accepted_memory_item_id = $itemId
               )`,
            )
            .run({ itemId: input.itemId, spaceId: input.spaceId });
          database
            .query(
              `DELETE FROM memory_proposals
               WHERE space_id = $spaceId AND accepted_memory_item_id = $itemId`,
            )
            .run({ itemId: input.itemId, spaceId: input.spaceId });
          database
            .query(
              `DELETE FROM memory_relations
               WHERE space_id = $spaceId AND (from_memory_item_id = $itemId OR to_memory_item_id = $itemId)`,
            )
            .run({ itemId: input.itemId, spaceId: input.spaceId });
          insertOutbox(database, input.outboxEvent);
          database
            .query('DELETE FROM memory_revisions WHERE space_id = $spaceId AND memory_item_id = $itemId')
            .run({ itemId: input.itemId, spaceId: input.spaceId });
          database
            .query('DELETE FROM memory_items WHERE space_id = $spaceId AND id = $itemId')
            .run({ itemId: input.itemId, spaceId: input.spaceId });
          const deleteObservation = database.query(
            `DELETE FROM memory_observations
             WHERE space_id = $spaceId AND id = $observationId
               AND NOT EXISTS (
                 SELECT 1 FROM memory_proposal_observations link
                 WHERE link.space_id = $spaceId AND link.observation_id = $observationId
               )`,
          );
          for (const row of observationRows) {
            deleteObservation.run({
              observationId: parseMemoryObservationId(row.observation_id),
              spaceId: input.spaceId,
            });
          }
          database.query('DELETE FROM memory_privacy_purge_context WHERE singleton = 1').run();
          bumpMemoryState(database, input.spaceId);
          insertAudit(database, input.audit);
        });
        purge.immediate();
      }),
    recordAuditEvent: (event) =>
      storageOperation('record-audit-event', () => {
        insertAudit(database, event);
      }),
    recordObservation: (input: RecordObservationInput) =>
      storageOperation('record-observation', () => {
        const record = database.transaction(() => {
          const { observation } = input;
          if (
            observation.owningSpaceId !== input.audit.spaceId ||
            memoryContentHash(observation.content) !== observation.contentHash
          ) {
            throw new MemoryRepositoryError('invalid-input', 'record-observation');
          }
          const existing = database
            .query(
              `SELECT id, content_hash FROM memory_observations
               WHERE space_id = $spaceId AND fingerprint = $fingerprint`,
            )
            .get({
              fingerprint: observation.fingerprint,
              spaceId: observation.owningSpaceId,
            }) as ExistingObservationRow | null;
          if (existing) {
            const existingId = parseMemoryObservationId(existing.id);
            if (existingId !== observation.id || existing.content_hash !== observation.contentHash) {
              throw new MemoryRepositoryError('conflict', 'record-observation');
            }
            insertAudit(database, input.audit);
            return { created: false, id: existingId };
          }
          const actor = principalColumns(observation.createdByPrincipal);
          database
            .query(
              `INSERT INTO memory_observations
                (id, space_id, project_id, capture_context_id, source_kind, source_locator,
                 fingerprint, content_hash, observed_at, content_json, sensitivity,
                 redaction_rule_set_version, created_by_kind, created_by_id)
               VALUES ($id, $spaceId, $projectId, $captureContextId, $sourceKind, $sourceLocator,
                       $fingerprint, $contentHash, $observedAt, $content, $sensitivity,
                       $ruleSetVersion, $actorKind, $actorId)`,
            )
            .run({
              actorId: actor.id,
              actorKind: actor.kind,
              captureContextId: observation.captureContextId,
              content: JSON.stringify(observation.content),
              contentHash: observation.contentHash,
              fingerprint: observation.fingerprint,
              id: observation.id,
              observedAt: observation.observedAt,
              projectId: observation.projectId,
              ruleSetVersion: observation.redactionRuleSetVersion,
              sensitivity: observation.sensitivity,
              sourceKind: observation.sourceKind,
              sourceLocator: observation.sourceLocator,
              spaceId: observation.owningSpaceId,
            });
          bumpMemoryState(database, observation.owningSpaceId);
          insertAudit(database, input.audit);
          return { created: true, id: observation.id };
        });
        return record.immediate();
      }),
    rejectProposal: (input: RejectProposalInput) =>
      storageOperation('reject-proposal', () => {
        const reject = database.transaction(() => {
          const updated = database
            .query(
              `UPDATE memory_proposals
               SET status = 'rejected', reviewed_by_person_id = $personId,
                   reviewed_at = $reviewedAt, review_reason = $reason
               WHERE id = $id AND space_id = $spaceId AND status = 'pending'`,
            )
            .run({
              id: input.proposalId,
              personId: input.reviewerPersonId,
              reason: input.reason,
              reviewedAt: input.reviewedAt,
              spaceId: input.spaceId,
            });
          if (updated.changes !== 1) {
            const exists = database
              .query('SELECT 1 FROM memory_proposals WHERE id = $id AND space_id = $spaceId')
              .get({ id: input.proposalId, spaceId: input.spaceId });
            throw new MemoryRepositoryError(exists ? 'conflict' : 'not-found', 'reject-proposal');
          }
          bumpMemoryState(database, input.spaceId);
          insertAudit(database, input.audit);
        });
        reject.immediate();
      }),
    reviseItem: (input: ReviseMemoryItemInput) =>
      storageOperation('revise-item', () => {
        const revise = database.transaction(() => {
          const state = database
            .query(
              `SELECT item.current_revision_id, item.status, revision.revision_number
               FROM memory_items item
               INNER JOIN memory_revisions revision ON revision.id = item.current_revision_id
               WHERE item.id = $itemId AND item.space_id = $spaceId`,
            )
            .get({ itemId: input.revision.memoryItemId, spaceId: input.spaceId }) as ItemStateRow | null;
          if (!state) {
            throw new MemoryRepositoryError('not-found', 'revise-item');
          }
          if (
            state.status !== 'active' ||
            state.current_revision_id !== input.expectedCurrentRevisionId ||
            typeof state.revision_number !== 'number' ||
            input.revision.revisionNumber !== state.revision_number + 1
          ) {
            throw new MemoryRepositoryError('stale', 'revise-item');
          }
          insertRevision(database, input.revision, input.spaceId);
          const updated = database
            .query(
              `UPDATE memory_items SET current_revision_id = $revisionId, sensitivity = $sensitivity
               WHERE id = $itemId AND space_id = $spaceId AND current_revision_id = $expectedRevisionId`,
            )
            .run({
              expectedRevisionId: input.expectedCurrentRevisionId,
              itemId: input.revision.memoryItemId,
              revisionId: input.revision.id,
              sensitivity: input.sensitivity,
              spaceId: input.spaceId,
            });
          if (updated.changes !== 1) {
            throw new MemoryRepositoryError('stale', 'revise-item');
          }
          reindexMemorySearchItem(database, input.spaceId, input.revision.memoryItemId);
          insertOutbox(database, input.outboxEvent);
          bumpMemoryState(database, input.spaceId);
          insertAudit(database, input.audit);
        });
        revise.immediate();
        return input.revision;
      }),
    searchItems: (query: SearchMemoryRepositoryQuery): Promise<MemorySearchPage> =>
      storageOperation('search-items', () => {
        if (
          query.signal?.aborted ||
          !Number.isFinite(query.nowEpochMs) ||
          !Number.isFinite(query.deadlineEpochMs) ||
          query.deadlineEpochMs <= query.nowEpochMs ||
          query.deadlineEpochMs - query.nowEpochMs > memorySearchBounds.timeoutMs
        ) {
          throw new MemoryRepositoryError(query.signal?.aborted ? 'cancelled' : 'timeout', 'search-items');
        }
        const startedAt = performance.now();
        const budgetMs = query.deadlineEpochMs - query.nowEpochMs;
        const authorizedIds = authorizedSearchMemoryIds(query);
        const scopeHash = memorySearchScopeHash(query, authorizedIds);
        const cursor = decodeMemorySearchCursor(query.cursor, query, scopeHash);
        const compiled = compileMemorySearchQuery(query.query, query.matchingMode);
        const searchSql = memorySearchSql(query);
        const search = database.transaction((): MemorySearchPage => {
          const metadata = database
            .query(
              `${searchSql.cte}
               SELECT count(*) AS total_count,
                      (
                        SELECT group_concat(result_identity, ',')
                        FROM (
                        SELECT memory_item_id || ':' || revision_id || ':' || content_hash || ':' ||
                               status || ':' || printf('%.6f', exact_score) || ':' ||
                               printf('%.6f', lexical_score) || ':' || printf('%.6f', trigram_score) || ':' ||
                               printf('%.6f', total_score) AS result_identity
                        FROM best_items ORDER BY ${searchSql.orderBy}
                        ) ordered_items
                      ) AS ordered_ids
               FROM best_items`,
            )
            .get(searchSql.bindings) as MemorySearchMetadataRow | null;
          const total = numberValue(metadata?.total_count, 'search-items-metadata');
          if (!Number.isSafeInteger(total) || total < 0) {
            throw new MemoryRepositoryError('unavailable', 'search-items-metadata');
          }
          const orderedIds =
            metadata?.ordered_ids === null ? '' : requiredString(metadata?.ordered_ids, 'search-items-metadata');
          const orderHash = createHash('sha256').update(orderedIds).digest('hex');
          if (cursor && cursor.orderHash !== orderHash) {
            throw new MemoryRepositoryError('stale', 'search-items-cursor-order');
          }
          const offset = cursor?.offset ?? 0;
          if (offset > total) {
            throw new MemoryRepositoryError('stale', 'search-items-cursor-offset');
          }
          const rows = database
            .query(
              `${searchSql.cte}
               SELECT best.memory_item_id AS item_id, best.project_id, best.kind, best.status,
                      best.trust, best.sensitivity, best.content_hash, best.revision_id,
                      best.revision_number, revision.title, revision.summary,
                      revision.guidance_json, revision.structured_content_json,
                      best.exact_score, best.lexical_score, best.trigram_score, best.total_score
               FROM best_items best
               INNER JOIN memory_revisions revision
                 ON revision.id = best.revision_id
                AND revision.memory_item_id = best.memory_item_id
                AND revision.space_id = best.space_id
               ORDER BY best.total_score DESC, best.exact_score DESC, best.lexical_score DESC,
                        best.trigram_score DESC, best.memory_item_id ASC
               LIMIT $pageLimit OFFSET $pageOffset`,
            )
            .all({ ...searchSql.bindings, pageLimit: query.limit, pageOffset: offset }) as MemorySearchResultRow[];
          const provenanceQuery = database.query(
            `SELECT observation.id, observation.source_kind, observation.observed_at,
                    observation.sensitivity
             FROM memory_proposals proposal
             INNER JOIN memory_proposal_observations link
               ON link.proposal_id = proposal.id AND link.space_id = proposal.space_id
             INNER JOIN memory_observations observation
               ON observation.id = link.observation_id AND observation.space_id = link.space_id
             WHERE proposal.space_id = $spaceId AND proposal.accepted_memory_item_id = $itemId
             ORDER BY observation.id ASC
             LIMIT $provenanceLimit`,
          );
          const items = rows.map((row) => {
            const guidance = guidanceValue(row.guidance_json, 'search-items-guidance');
            const structuredContent = jsonValue(row.structured_content_json, 'search-items-structured-content');
            const title = requiredString(row.title, 'search-items-title').slice(
              0,
              memorySearchBounds.maxTitleCharacters,
            );
            const summary = requiredString(row.summary, 'search-items-summary').slice(
              0,
              memorySearchBounds.maxSummaryCharacters,
            );
            const itemId = parseMemoryItemId(row.item_id);
            const provenanceRows = provenanceQuery.all({
              itemId,
              provenanceLimit: memorySearchBounds.maxProvenancePerResult,
              spaceId: query.spaceId,
            }) as ProposalObservationSourceRow[];
            const revisionNumber = numberValue(row.revision_number, 'search-items-revision-number');
            if (!Number.isSafeInteger(revisionNumber) || revisionNumber <= 0) {
              throw new MemoryRepositoryError('unavailable', 'search-items-revision-number');
            }
            const exact = normalizeMemorySearchScore(numberValue(row.exact_score, 'search-items-score'));
            const lexical = normalizeMemorySearchScore(numberValue(row.lexical_score, 'search-items-score'));
            const trigram = normalizeMemorySearchScore(numberValue(row.trigram_score, 'search-items-score'));
            const totalScore = normalizeMemorySearchScore(numberValue(row.total_score, 'search-items-score'));
            return {
              chunkerVersion: MEMORY_SEARCH_CHUNKER_VERSION,
              contentHash: requiredString(row.content_hash, 'search-items-content-hash'),
              guidance: truncateMemorySearchGuidance(guidance),
              id: itemId,
              kind: enumValue(row.kind, memoryKinds, 'search-items-kind'),
              matchedBecause: explainMemorySearchMatch(
                {
                  guidance: guidance.join('\n'),
                  structuredContent: memorySearchStructuredText(structuredContent),
                  summary,
                  title,
                },
                compiled,
              ),
              projectId: row.project_id === null ? null : parseProjectId(row.project_id),
              provenance: provenanceRows.map((source) => ({
                observationId: parseMemoryObservationId(source.id),
                observedAt: parseInstant(source.observed_at),
                sensitivity: enumValue(source.sensitivity, sensitivities, 'search-items-provenance'),
                sourceKind: enumValue(source.source_kind, observationSourceKinds, 'search-items-provenance'),
                verification: 'accepted-proposal-evidence' as const,
              })),
              rank: { exact, lexical, total: totalScore, trigram },
              resourceKind: 'memory' as const,
              revisionId: parseMemoryRevisionId(row.revision_id),
              revisionNumber,
              sensitivity: enumValue(row.sensitivity, sensitivities, 'search-items-sensitivity'),
              status: enumValue(row.status, itemStatuses, 'search-items-status'),
              summary,
              title,
              trust: enumValue(row.trust, trustValues, 'search-items-trust'),
            };
          });
          if (query.signal?.aborted) {
            throw new MemoryRepositoryError('cancelled', 'search-items');
          }
          if (performance.now() - startedAt > budgetMs) {
            throw new MemoryRepositoryError('timeout', 'search-items');
          }
          const nextOffset = offset + items.length;
          const page: MemorySearchPage = {
            items,
            nextCursor:
              nextOffset < total
                ? encodeMemorySearchCursor({
                    adapterVersion: SQLITE_MEMORY_SEARCH_ADAPTER_VERSION,
                    chunkerVersion: MEMORY_SEARCH_CHUNKER_VERSION,
                    expiresAtEpochMs: query.nowEpochMs + memorySearchBounds.cursorLifetimeMs,
                    issuedAtEpochMs: query.nowEpochMs,
                    offset: nextOffset,
                    orderHash,
                    queryFingerprint: query.queryFingerprint,
                    rankingVersion: MEMORY_SEARCH_RANKING_VERSION,
                    scopeHash,
                    version: 1,
                  })
                : null,
            queryFingerprint: query.queryFingerprint,
            rankingVersion: `${MEMORY_SEARCH_RANKING_VERSION}/${SQLITE_MEMORY_SEARCH_ADAPTER_VERSION}`,
            total,
          };
          assertMemorySearchPageBounds(page);
          return page;
        });
        return search();
      }),
    supersedeItem: (input: SupersedeMemoryItemInput) =>
      storageOperation('supersede-item', () => {
        const supersede = database.transaction(() => {
          const updated = database
            .query(
              `UPDATE memory_items SET status = 'superseded'
               WHERE id = $itemId AND space_id = $spaceId AND status = 'active'`,
            )
            .run({ itemId: input.itemId, spaceId: input.spaceId });
          if (updated.changes !== 1) {
            const exists = database
              .query('SELECT 1 FROM memory_items WHERE id = $itemId AND space_id = $spaceId')
              .get({ itemId: input.itemId, spaceId: input.spaceId });
            throw new MemoryRepositoryError(exists ? 'conflict' : 'not-found', 'supersede-item');
          }
          reindexMemorySearchItem(database, input.spaceId, input.itemId);
          insertOutbox(database, input.outboxEvent);
          bumpMemoryState(database, input.spaceId);
          insertAudit(database, input.audit);
        });
        supersede.immediate();
      }),
  };
  return Object.freeze(repository);
};

export const mapSqliteMemoryObservationForTesting = (row: ObservationRow): MemoryObservation => ({
  captureContextId: row.capture_context_id === null ? null : parseCaptureContextId(row.capture_context_id),
  content: jsonValue(row.content_json, 'map-observation'),
  contentHash: requiredString(row.content_hash, 'map-observation'),
  createdByPrincipal: mapPrincipal(row.created_by_kind, row.created_by_id, 'map-observation'),
  fingerprint: requiredString(row.fingerprint, 'map-observation'),
  id: parseMemoryObservationId(row.id),
  observedAt: parseInstant(row.observed_at),
  owningSpaceId: parseSpaceId(row.space_id),
  projectId: row.project_id === null ? null : parseProjectId(row.project_id),
  redactionRuleSetVersion: 'memory-redaction-v1',
  sensitivity: enumValue(row.sensitivity, sensitivities, 'map-observation'),
  sourceKind: enumValue(row.source_kind, observationSourceKinds, 'map-observation'),
  sourceLocator: optionalString(row.source_locator, 'map-observation'),
});
