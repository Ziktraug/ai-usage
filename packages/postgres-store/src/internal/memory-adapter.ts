import { AUTHORIZATION_MODEL_VERSION, type AuthorizationPrincipal } from '@ai-usage/authorization';
import {
  readAuthorizedResourceScopeAdapterBinding,
  readAuthorizedResourceScopeIds,
} from '@ai-usage/authorization/scope-internal';
import { createMemorySearchChunks, memorySearchStructuredText } from '@ai-usage/memory-search/chunking';
import {
  compileMemorySearchQuery,
  explainMemorySearchMatch,
  normalizeMemorySearchScore,
  truncateMemorySearchGuidance,
} from '@ai-usage/memory-search/ranking';
import {
  type MemoryExportItem,
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
  type Instant,
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
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { PlatformMemoryRepository } from '../memory';
import { authorizationScopeSql } from './authorization-query';
import { isPostgreSqlAuthorizationScopeBinding } from './authorization-scope-binding';

interface ProposalRow extends QueryResultRow {
  readonly guidance: unknown;
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
  readonly structured_content: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly trust_candidate: unknown;
}

interface ItemRevisionRow extends QueryResultRow {
  readonly created_at: unknown;
  readonly created_by_id: unknown;
  readonly created_by_kind: unknown;
  readonly current_revision_id: unknown;
  readonly guidance: unknown;
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
  readonly structured_content: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly trust: unknown;
}

interface ExistingObservationRow extends QueryResultRow {
  readonly content_hash: unknown;
  readonly id: unknown;
}

interface ItemStateRow extends QueryResultRow {
  readonly current_revision_id: unknown;
  readonly revision_number: unknown;
  readonly status: unknown;
}

interface MemorySearchProjectionStateRow extends QueryResultRow {
  readonly chunker_version: unknown;
  readonly source_state_version: unknown;
}

interface MemorySearchMetadataRow extends QueryResultRow {
  readonly order_hash: unknown;
  readonly scope_hash: unknown;
  readonly total_count: unknown;
}

interface MemorySearchResultRow extends QueryResultRow {
  readonly content_hash: unknown;
  readonly exact_score: unknown;
  readonly guidance: unknown;
  readonly item_id: unknown;
  readonly kind: unknown;
  readonly lexical_score: unknown;
  readonly project_id: unknown;
  readonly revision_id: unknown;
  readonly revision_number: unknown;
  readonly sensitivity: unknown;
  readonly status: unknown;
  readonly structured_content: unknown;
  readonly summary: unknown;
  readonly title: unknown;
  readonly total_score: unknown;
  readonly trigram_score: unknown;
  readonly trust: unknown;
}

interface ProposalObservationSourceRow extends QueryResultRow {
  readonly id: unknown;
  readonly observed_at: unknown;
  readonly sensitivity: unknown;
  readonly source_kind: unknown;
  readonly source_locator: unknown;
}

interface MemoryImportRow extends QueryResultRow {
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

interface ExportRelationRow extends QueryResultRow {
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

const mappedInstant = (value: unknown, operation: string): Instant =>
  parseInstant(value instanceof Date ? value.toISOString() : value, operation);

const jsonValue = (value: unknown, operation: string): MemoryJsonValue => {
  try {
    return parseMemoryJsonValue(value, operation);
  } catch {
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

const principalColumns = (
  principal: AuthorizationPrincipal,
): { readonly personId: string | null; readonly serviceId: string | null } =>
  principal.kind === 'person'
    ? { personId: principal.personId, serviceId: null }
    : { personId: null, serviceId: principal.id };

const principalStorageColumns = (
  principal: AuthorizationPrincipal,
): { readonly id: string; readonly kind: 'person' | 'service' } =>
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
  guidance: guidanceValue(row.guidance, 'map-proposal'),
  id: parseMemoryProposalId(row.id),
  owningSpaceId: parseSpaceId(row.space_id),
  projectId: row.project_id === null ? null : parseProjectId(row.project_id),
  proposedByPrincipal: mapPrincipal(row.proposed_by_kind, row.proposed_by_id, 'map-proposal'),
  proposedKind: enumValue(row.proposed_kind, memoryKinds, 'map-proposal'),
  reviewedAt: row.reviewed_at === null ? null : mappedInstant(row.reviewed_at, 'proposal.reviewedAt'),
  reviewedByPersonId: row.reviewed_by_person_id === null ? null : parsePersonId(row.reviewed_by_person_id),
  reviewReason: optionalString(row.review_reason, 'map-proposal'),
  sensitivity: enumValue(row.sensitivity, sensitivities, 'map-proposal'),
  status: enumValue(row.status, proposalStatuses, 'map-proposal'),
  structuredContent: jsonValue(row.structured_content, 'map-proposal'),
  summary: requiredString(row.summary, 'map-proposal'),
  title: requiredString(row.title, 'map-proposal'),
  trustCandidate: enumValue(row.trust_candidate, trustValues, 'map-proposal'),
});

const mapItemResult = (row: ItemRevisionRow): MemoryItemResult => {
  const itemId = parseMemoryItemId(row.item_id);
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
      createdAt: mappedInstant(row.created_at, 'revision.createdAt'),
      createdByPrincipal: mapPrincipal(row.created_by_kind, row.created_by_id, 'map-memory-revision'),
      guidance: guidanceValue(row.guidance, 'map-memory-revision'),
      id: parseMemoryRevisionId(row.revision_id),
      memoryItemId: itemId,
      reason: optionalString(row.reason, 'map-memory-revision'),
      revisionNumber,
      structuredContent: jsonValue(row.structured_content, 'map-memory-revision'),
      summary: requiredString(row.summary, 'map-memory-revision'),
      title: requiredString(row.title, 'map-memory-revision'),
    },
  };
};

const mapMemoryImport = (row: MemoryImportRow): MemoryImport => {
  if (
    (row.source_kind !== 'legacy-jsonl' && row.source_kind !== 'legacy-markdown') ||
    (row.status !== 'previewed' && row.status !== 'confirmed' && row.status !== 'quarantined' && row.status !== 'stale')
  ) {
    throw new MemoryRepositoryError('unavailable', 'map-memory-import');
  }
  return {
    confirmedAt: row.confirmed_at === null ? null : mappedInstant(row.confirmed_at, 'memoryImport.confirmedAt'),
    confirmedByPersonId: row.confirmed_by_person_id === null ? null : parsePersonId(row.confirmed_by_person_id),
    contentHash: requiredString(row.content_hash, 'map-memory-import'),
    createdAt: mappedInstant(row.created_at, 'memoryImport.createdAt'),
    destinationProjectId: row.project_id === null ? null : parseProjectId(row.project_id),
    destinationSpaceId: parseSpaceId(row.space_id),
    fingerprint: requiredString(row.fingerprint, 'map-memory-import'),
    id: parseMemoryImportId(row.id),
    previewProof: requiredString(row.preview_proof, 'map-memory-import'),
    sourceKind: row.source_kind,
    sourceLocator: requiredString(row.source_locator, 'map-memory-import'),
    status: row.status,
  };
};

const withMemoryTransaction = async <Value>(
  pool: Pool,
  spaceId: SpaceId,
  operation: string,
  run: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new MemoryRepositoryError('unavailable', operation);
  }
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('ai_usage.active_space_id', $1, TRUE)", [spaceId]);
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof MemoryRepositoryError) {
      throw error;
    }
    throw new MemoryRepositoryError('unavailable', operation);
  } finally {
    client.release();
  }
};

const isPostgreSqlQueryCancelled = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '57014';

const withMemorySearchTransaction = async <Value>(
  pool: Pool,
  query: SearchMemoryRepositoryQuery,
  run: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  if (
    query.signal?.aborted ||
    !Number.isFinite(query.nowEpochMs) ||
    !Number.isFinite(query.deadlineEpochMs) ||
    query.deadlineEpochMs <= query.nowEpochMs ||
    query.deadlineEpochMs - query.nowEpochMs > memorySearchBounds.timeoutMs
  ) {
    throw new MemoryRepositoryError(query.signal?.aborted ? 'cancelled' : 'timeout', 'search-items');
  }
  const budgetMs = query.deadlineEpochMs - query.nowEpochMs;
  const startedAt = performance.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new MemoryRepositoryError('unavailable', 'search-items');
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SELECT set_config('ai_usage.active_space_id', $1, TRUE)", [query.spaceId]);
    await client.query("SELECT set_config('statement_timeout', $1, TRUE)", [`${Math.ceil(budgetMs)}ms`]);
    const value = await run(client);
    if (query.signal?.aborted) {
      throw new MemoryRepositoryError('cancelled', 'search-items');
    }
    if (performance.now() - startedAt > budgetMs) {
      throw new MemoryRepositoryError('timeout', 'search-items');
    }
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof MemoryRepositoryError) {
      throw error;
    }
    if (isPostgreSqlQueryCancelled(error)) {
      throw new MemoryRepositoryError(query.signal?.aborted ? 'cancelled' : 'timeout', 'search-items');
    }
    throw new MemoryRepositoryError('unavailable', 'search-items');
  } finally {
    client.release();
  }
};

const insertAudit = async (client: PoolClient, event: MemoryAuditEvent): Promise<void> => {
  const actor = principalColumns(event.actor);
  await client.query(
    `INSERT INTO authorization_audit_events
      (id, space_id, actor_person_id, actor_service_id, action,
       subject_type, subject_id, result, recorded_at, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::JSONB)`,
    [
      crypto.randomUUID(),
      event.spaceId,
      actor.personId,
      actor.serviceId,
      event.action,
      event.subjectType,
      event.subjectId,
      event.result,
      event.recordedAt,
    ],
  );
};

const parseMemoryStateVersion = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!(typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0)) {
    throw new MemoryRepositoryError('unavailable', 'read-memory-state');
  }
  return parsed;
};

const ensureMemoryState = async (client: PoolClient, spaceId: SpaceId): Promise<number> => {
  await client.query(
    `INSERT INTO memory_space_state (space_id, version)
     VALUES ($1, 0)
     ON CONFLICT (space_id) DO NOTHING`,
    [spaceId],
  );
  const result = await client.query<{ readonly version: unknown }>(
    'SELECT version FROM memory_space_state WHERE space_id = $1 FOR UPDATE',
    [spaceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new MemoryRepositoryError('unavailable', 'read-memory-state');
  }
  return parseMemoryStateVersion(row.version);
};

const markMemorySearchProjectionState = async (
  client: PoolClient,
  spaceId: SpaceId,
  sourceStateVersion: number,
): Promise<void> => {
  await client.query(
    `INSERT INTO memory_search_projection_state (space_id, source_state_version, chunker_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (space_id) DO UPDATE SET
       source_state_version = excluded.source_state_version,
       chunker_version = excluded.chunker_version`,
    [spaceId, sourceStateVersion, MEMORY_SEARCH_CHUNKER_VERSION],
  );
};

const bumpMemoryState = async (client: PoolClient, spaceId: SpaceId): Promise<number> => {
  const previousVersion = await ensureMemoryState(client, spaceId);
  const result = await client.query<{ readonly version: unknown }>(
    'UPDATE memory_space_state SET version = version + 1 WHERE space_id = $1 RETURNING version',
    [spaceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new MemoryRepositoryError('unavailable', 'bump-memory-state');
  }
  const version = parseMemoryStateVersion(row.version);
  await client.query(
    `UPDATE memory_search_projection_state
     SET source_state_version = $1, chunker_version = $2
     WHERE space_id = $3 AND source_state_version = $4`,
    [version, MEMORY_SEARCH_CHUNKER_VERSION, spaceId, previousVersion],
  );
  return version;
};

const insertMemoryScope = async (
  client: PoolClient,
  input: {
    readonly createdAt: Instant;
    readonly memoryId: string;
    readonly ownerPersonId: string;
    readonly projectId: string | null;
    readonly sensitivity: MemorySensitivity;
    readonly spaceId: SpaceId;
  },
): Promise<void> => {
  await client.query(
    `INSERT INTO memory_authorization_scopes
      (id, space_id, project_id, owner_person_id, status, sensitivity, requires_trusted_device)
     VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
    [
      input.memoryId,
      input.spaceId,
      input.projectId,
      input.ownerPersonId,
      input.sensitivity,
      input.sensitivity === 'sensitive',
    ],
  );
  await client.query(
    `INSERT INTO memory_content_grants
      (id, space_id, memory_id, person_id, role, status, created_at)
     VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
    [crypto.randomUUID(), input.spaceId, input.memoryId, input.ownerPersonId, input.createdAt],
  );
};

const insertRevision = async (client: PoolClient, revision: MemoryRevision, spaceId: SpaceId): Promise<void> => {
  const actor = principalStorageColumns(revision.createdByPrincipal);
  await client.query(
    `INSERT INTO memory_revisions
      (id, memory_item_id, space_id, revision_number, title, summary, guidance,
       structured_content, created_by_kind, created_by_id, created_at, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::JSONB, $9, $10, $11, $12)`,
    [
      revision.id,
      revision.memoryItemId,
      spaceId,
      revision.revisionNumber,
      revision.title,
      revision.summary,
      JSON.stringify(revision.guidance),
      JSON.stringify(revision.structuredContent),
      actor.kind,
      actor.id,
      revision.createdAt,
      revision.reason,
    ],
  );
};

const insertImportedObservation = async (client: PoolClient, observation: MemoryObservation): Promise<void> => {
  const actor = principalStorageColumns(observation.createdByPrincipal);
  await client.query(
    `INSERT INTO memory_observations
      (id, space_id, project_id, capture_context_id, source_kind, source_locator,
       fingerprint, content_hash, observed_at, content, sensitivity,
       redaction_rule_set_version, created_by_kind, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11, $12, $13, $14)`,
    [
      observation.id,
      observation.owningSpaceId,
      observation.projectId,
      observation.captureContextId,
      observation.sourceKind,
      observation.sourceLocator,
      observation.fingerprint,
      observation.contentHash,
      observation.observedAt,
      JSON.stringify(observation.content),
      observation.sensitivity,
      observation.redactionRuleSetVersion,
      actor.kind,
      actor.id,
    ],
  );
};

const insertImportedProposal = async (
  client: PoolClient,
  proposal: MemoryProposal,
  itemId: string | null,
  createdAt: Instant,
): Promise<void> => {
  if (proposal.proposedByPrincipal.kind !== 'person') {
    throw new MemoryRepositoryError('invalid-input', 'confirm-import');
  }
  await insertMemoryScope(client, {
    createdAt,
    memoryId: proposal.id,
    ownerPersonId: proposal.proposedByPrincipal.personId,
    projectId: proposal.projectId,
    sensitivity: proposal.sensitivity,
    spaceId: proposal.owningSpaceId,
  });
  const actor = principalStorageColumns(proposal.proposedByPrincipal);
  await client.query(
    `INSERT INTO memory_proposals
      (id, space_id, project_id, proposed_kind, title, summary, guidance,
       structured_content, trust_candidate, sensitivity, status,
       proposed_by_kind, proposed_by_id, reviewed_by_person_id, reviewed_at,
       review_reason, accepted_memory_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::JSONB, $9, $10, $11,
             $12, $13, $14, $15, $16, $17)`,
    [
      proposal.id,
      proposal.owningSpaceId,
      proposal.projectId,
      proposal.proposedKind,
      proposal.title,
      proposal.summary,
      JSON.stringify(proposal.guidance),
      JSON.stringify(proposal.structuredContent),
      proposal.trustCandidate,
      proposal.sensitivity,
      proposal.status,
      actor.kind,
      actor.id,
      proposal.reviewedByPersonId,
      proposal.reviewedAt,
      proposal.reviewReason,
      itemId,
    ],
  );
  if (proposal.status !== 'pending') {
    await client.query(
      `UPDATE memory_authorization_scopes SET status = 'superseded'
       WHERE id = $1 AND space_id = $2`,
      [proposal.id, proposal.owningSpaceId],
    );
  }
};

const insertImportedItem = async (
  client: PoolClient,
  item: MemoryItem,
  revision: MemoryRevision,
  ownerPersonId: string,
): Promise<void> => {
  await insertMemoryScope(client, {
    createdAt: revision.createdAt,
    memoryId: item.id,
    ownerPersonId,
    projectId: item.projectId,
    sensitivity: item.sensitivity,
    spaceId: item.owningSpaceId,
  });
  await client.query(
    `INSERT INTO memory_items
      (id, space_id, project_id, scope, kind, status, trust, sensitivity, current_revision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      item.id,
      item.owningSpaceId,
      item.projectId,
      item.scope,
      item.kind,
      item.status,
      item.trust,
      item.sensitivity,
      item.currentRevisionId,
    ],
  );
  await insertRevision(client, revision, item.owningSpaceId);
};

const insertImportedRelation = async (client: PoolClient, relation: MemoryRelation): Promise<void> => {
  const actor = principalStorageColumns(relation.createdByPrincipal);
  await client.query(
    `INSERT INTO memory_relations
      (id, space_id, from_memory_item_id, to_memory_item_id, relation_kind,
       created_by_kind, created_by_id, created_at, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (space_id, from_memory_item_id, to_memory_item_id, relation_kind) DO NOTHING`,
    [
      relation.id,
      relation.owningSpaceId,
      relation.fromMemoryItemId,
      relation.toMemoryItemId,
      relation.kind,
      actor.kind,
      actor.id,
      relation.createdAt,
      relation.reason,
    ],
  );
};

const proposalSelect = `
  SELECT id, space_id, project_id, proposed_kind, title, summary, guidance,
         structured_content, trust_candidate, sensitivity, status,
         proposed_by_kind, proposed_by_id, reviewed_by_person_id, reviewed_at, review_reason
  FROM memory_proposals
`;

const itemSelect = `
  SELECT item.id AS item_id, item.space_id, item.project_id, item.scope, item.kind,
         item.status, item.trust, item.sensitivity, item.current_revision_id,
         revision.id AS revision_id, revision.revision_number, revision.title,
         revision.summary, revision.guidance, revision.structured_content,
         revision.created_by_kind, revision.created_by_id, revision.created_at, revision.reason
  FROM memory_items item
  INNER JOIN memory_revisions revision ON revision.id = item.current_revision_id
`;

const itemRevisionHistorySelect = `
  SELECT item.id AS item_id, item.space_id, item.project_id, item.scope, item.kind,
         item.status, item.trust, item.sensitivity, item.current_revision_id,
         revision.id AS revision_id, revision.revision_number, revision.title,
         revision.summary, revision.guidance, revision.structured_content,
         revision.created_by_kind, revision.created_by_id, revision.created_at, revision.reason
  FROM memory_items item
  INNER JOIN memory_revisions revision ON revision.memory_item_id = item.id
`;

const insertMemorySearchProjection = async (
  client: PoolClient,
  item: MemoryItem,
  revision: MemoryRevision,
): Promise<void> => {
  for (const chunk of createMemorySearchChunks(item, revision)) {
    await client.query(
      `INSERT INTO memory_search_chunks
        (chunk_id, chunk_ordinal, chunker_version, content_hash, space_id, project_id,
         memory_item_id, revision_id, revision_number, scope, kind, status, trust, sensitivity,
         title, summary, guidance, structured_terms, supporting_text)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19)`,
      [
        chunk.chunkId,
        chunk.chunkOrdinal,
        chunk.chunkerVersion,
        chunk.contentHash,
        item.owningSpaceId,
        item.projectId,
        item.id,
        revision.id,
        revision.revisionNumber,
        item.scope,
        item.kind,
        item.status,
        item.trust,
        item.sensitivity,
        chunk.title,
        chunk.summary,
        chunk.guidance,
        chunk.structuredTerms,
        chunk.supportingText,
      ],
    );
  }
};

const replaceMemorySearchProjection = async (
  client: PoolClient,
  item: MemoryItem,
  revision: MemoryRevision,
): Promise<void> => {
  await client.query('DELETE FROM memory_search_chunks WHERE space_id = $1 AND memory_item_id = $2', [
    item.owningSpaceId,
    item.id,
  ]);
  await insertMemorySearchProjection(client, item, revision);
};

const reindexMemorySearchItem = async (client: PoolClient, spaceId: SpaceId, itemId: string): Promise<void> => {
  const result = await client.query<ItemRevisionRow>(`${itemSelect} WHERE item.space_id = $1 AND item.id = $2`, [
    spaceId,
    itemId,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new MemoryRepositoryError('not-found', 'reindex-memory-search-item');
  }
  const current = mapItemResult(row);
  await replaceMemorySearchProjection(client, current.item, current.revision);
};

const ensureMemorySearchProjection = async (client: PoolClient, spaceId: SpaceId): Promise<void> => {
  const sourceStateVersion = await ensureMemoryState(client, spaceId);
  const projectionResult = await client.query<MemorySearchProjectionStateRow>(
    `SELECT source_state_version, chunker_version
     FROM memory_search_projection_state
     WHERE space_id = $1
     FOR UPDATE`,
    [spaceId],
  );
  const projection = projectionResult.rows[0];
  const projectionVersion =
    typeof projection?.source_state_version === 'string'
      ? Number(projection.source_state_version)
      : projection?.source_state_version;
  if (
    projection &&
    projectionVersion === sourceStateVersion &&
    projection.chunker_version === MEMORY_SEARCH_CHUNKER_VERSION
  ) {
    return;
  }
  await client.query('DELETE FROM memory_search_chunks WHERE space_id = $1', [spaceId]);
  const items = await client.query<ItemRevisionRow>(`${itemSelect} WHERE item.space_id = $1 ORDER BY item.id ASC`, [
    spaceId,
  ]);
  for (const row of items.rows) {
    const current = mapItemResult(row);
    await insertMemorySearchProjection(client, current.item, current.revision);
  }
  await markMemorySearchProjectionState(client, spaceId, sourceStateVersion);
};

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
    return readAuthorizedResourceScopeIds(authorizationScope).map((id) => parseMemoryItemId(id));
  } catch {
    throw new MemoryRepositoryError('invalid-input', operation);
  }
};

const POSTGRESQL_MEMORY_SEARCH_ADAPTER_VERSION = 'postgres-fts-trgm-v1' as const;

interface PostgreSqlMemorySearchCursor {
  readonly adapterVersion: typeof POSTGRESQL_MEMORY_SEARCH_ADAPTER_VERSION;
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

const encodeMemorySearchCursor = (cursor: PostgreSqlMemorySearchCursor): string => btoa(JSON.stringify(cursor));

const decodeMemorySearchCursor = (
  value: string | null,
  query: SearchMemoryRepositoryQuery,
): PostgreSqlMemorySearchCursor | null => {
  if (value === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('invalid cursor');
    }
    const cursor = parsed as Partial<PostgreSqlMemorySearchCursor>;
    if (
      cursor.version !== 1 ||
      cursor.adapterVersion !== POSTGRESQL_MEMORY_SEARCH_ADAPTER_VERSION ||
      cursor.chunkerVersion !== MEMORY_SEARCH_CHUNKER_VERSION ||
      cursor.rankingVersion !== MEMORY_SEARCH_RANKING_VERSION ||
      cursor.queryFingerprint !== query.queryFingerprint ||
      typeof cursor.scopeHash !== 'string' ||
      cursor.scopeHash.length !== 32 ||
      typeof cursor.orderHash !== 'string' ||
      cursor.orderHash.length !== 32 ||
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
    return cursor as PostgreSqlMemorySearchCursor;
  } catch (error) {
    if (error instanceof MemoryRepositoryError) {
      throw error;
    }
    throw new MemoryRepositoryError('invalid-input', 'search-items-cursor');
  }
};

const memorySearchAuthorization = (query: SearchMemoryRepositoryQuery) => {
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
  let binding: unknown;
  try {
    binding = readAuthorizedResourceScopeAdapterBinding(authorizationScope);
  } catch {
    throw new MemoryRepositoryError('invalid-input', 'search-items-authorization');
  }
  const scopeSql = authorizationScopeSql(expectedPermission, 'memory');
  if (!(isPostgreSqlAuthorizationScopeBinding(binding) && scopeSql)) {
    throw new MemoryRepositoryError('invalid-input', 'search-items-authorization');
  }
  return { binding, scopeSql };
};

const postgresMemorySearchSql = (query: SearchMemoryRepositoryQuery) => {
  const authorization = memorySearchAuthorization(query);
  const compiled = compileMemorySearchQuery(query.query, query.matchingMode);
  const websearchQuery = compiled.sourceTerms.map((term) => `"${term.replaceAll('"', '')}"`).join(' OR ');
  const values: readonly unknown[] = [
    query.spaceId,
    authorization.binding.personId,
    authorization.binding.trustedDevice,
    query.projectId,
    query.includeSpaceWide,
    query.kinds,
    query.statuses,
    query.trust,
    query.query,
    websearchQuery,
    query.matchingMode,
    query.matchingMode === 'literal' ? 1 : 2.6,
  ];
  const orderBy = 'total_score DESC, exact_score DESC, lexical_score DESC, trigram_score DESC, memory_item_id ASC';
  return {
    cte: `
      WITH authorized_resources AS (
        ${authorization.scopeSql}
      ),
      query_input AS (
        SELECT lower($9::TEXT) AS literal,
               websearch_to_tsquery('simple', $10::TEXT) AS lexical_query
      ),
      eligible AS (
        SELECT chunk.*
        FROM memory_search_chunks chunk
        INNER JOIN authorized_resources authorized ON authorized.id = chunk.memory_item_id
        WHERE chunk.space_id = $1
          AND ($4::UUID IS NULL OR chunk.project_id = $4::UUID OR ($5::BOOLEAN AND chunk.scope IN ('space', 'person')))
          AND chunk.kind = ANY($6::TEXT[])
          AND chunk.status = ANY($7::TEXT[])
          AND chunk.trust = ANY($8::TEXT[])
      ),
      component_scores AS (
        SELECT eligible.*,
               CASE
                 WHEN position(query_input.literal IN lower(eligible.title)) > 0 THEN 100.0
                 WHEN position(query_input.literal IN lower(eligible.summary)) > 0 THEN 60.0
                 WHEN position(query_input.literal IN lower(eligible.guidance)) > 0 THEN 50.0
                 WHEN position(query_input.literal IN lower(eligible.structured_terms)) > 0 THEN 50.0
                 WHEN position(query_input.literal IN eligible.normalized_document) > 0 THEN 20.0
                 ELSE 0.0
               END::DOUBLE PRECISION AS exact_score,
               CASE WHEN $11::TEXT = 'hybrid' THEN
                 (ts_rank_cd(ARRAY[0.1, 0.4, 0.8, 1.0]::REAL[], eligible.search_vector,
                             query_input.lexical_query, 32) * 100.0)::DOUBLE PRECISION
               ELSE 0.0 END AS lexical_score,
               CASE WHEN $11::TEXT = 'hybrid' THEN
                 (GREATEST(
                   similarity(lower(eligible.title), query_input.literal),
                   similarity(lower(eligible.summary), query_input.literal),
                   similarity(lower(eligible.guidance), query_input.literal),
                   similarity(lower(eligible.structured_terms), query_input.literal),
                   word_similarity(query_input.literal, eligible.normalized_document)
                 ) * 10.0)::DOUBLE PRECISION
               ELSE 0.0 END AS trigram_score
        FROM eligible
        CROSS JOIN query_input
        WHERE
          position(query_input.literal IN eligible.normalized_document) > 0
          OR (
            $11::TEXT = 'hybrid' AND (
              eligible.search_vector @@ query_input.lexical_query
              OR lower(eligible.title) % query_input.literal
              OR lower(eligible.summary) % query_input.literal
              OR lower(eligible.guidance) % query_input.literal
              OR lower(eligible.structured_terms) % query_input.literal
              OR eligible.normalized_document % query_input.literal
            )
          )
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
        WHERE total_score >= $12::DOUBLE PRECISION
      ),
      best_items AS (
        SELECT * FROM ranked_chunks WHERE item_chunk_rank = 1
      )`,
    compiled,
    orderBy,
    values,
  };
};

const searchNumber = (value: unknown, operation: string): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new MemoryRepositoryError('unavailable', operation);
  }
  return parsed;
};

export const createPlatformMemoryRepository = (pool: Pool): PlatformMemoryRepository => {
  const repository: MemoryRepository = {
    acceptProposal: (input: AcceptProposalInput) =>
      withMemoryTransaction(pool, input.item.owningSpaceId, 'accept-proposal', async (client) => {
        if (
          input.item.owningSpaceId !== input.audit.spaceId ||
          input.item.id !== input.revision.memoryItemId ||
          input.item.currentRevisionId !== input.revision.id ||
          input.revision.revisionNumber !== 1 ||
          (input.item.scope === 'project' && input.item.projectId === null)
        ) {
          throw new MemoryRepositoryError('invalid-input', 'accept-proposal');
        }
        const proposalResult = await client.query<{ readonly project_id: unknown; readonly status: unknown }>(
          `SELECT project_id, status FROM memory_proposals
           WHERE id = $1 AND space_id = $2 FOR UPDATE`,
          [input.proposalId, input.item.owningSpaceId],
        );
        const proposal = proposalResult.rows[0];
        if (!proposal) {
          throw new MemoryRepositoryError('not-found', 'accept-proposal');
        }
        if (proposal.status !== 'pending' || proposal.project_id !== input.item.projectId) {
          throw new MemoryRepositoryError('conflict', 'accept-proposal');
        }
        await insertMemoryScope(client, {
          createdAt: input.reviewedAt,
          memoryId: input.item.id,
          ownerPersonId: input.reviewerPersonId,
          projectId: input.item.projectId,
          sensitivity: input.item.sensitivity,
          spaceId: input.item.owningSpaceId,
        });
        await client.query(
          `INSERT INTO memory_items
            (id, space_id, project_id, scope, kind, status, trust, sensitivity, current_revision_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            input.item.id,
            input.item.owningSpaceId,
            input.item.projectId,
            input.item.scope,
            input.item.kind,
            input.item.status,
            input.item.trust,
            input.item.sensitivity,
            input.item.currentRevisionId,
          ],
        );
        await insertRevision(client, input.revision, input.item.owningSpaceId);
        const updated = await client.query(
          `UPDATE memory_proposals
           SET status = 'accepted', reviewed_by_person_id = $1, reviewed_at = $2,
               review_reason = $3, accepted_memory_item_id = $4
           WHERE id = $5 AND space_id = $6 AND status = 'pending'`,
          [
            input.reviewerPersonId,
            input.reviewedAt,
            input.revision.reason,
            input.item.id,
            input.proposalId,
            input.item.owningSpaceId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new MemoryRepositoryError('conflict', 'accept-proposal');
        }
        await replaceMemorySearchProjection(client, input.item, input.revision);
        await client.query(
          `UPDATE memory_authorization_scopes SET status = 'superseded'
           WHERE id = $1 AND space_id = $2`,
          [input.proposalId, input.item.owningSpaceId],
        );
        await bumpMemoryState(client, input.item.owningSpaceId);
        await insertAudit(client, input.audit);
        return { item: input.item, revision: input.revision };
      }),
    confirmImport: (input: ConfirmMemoryImportInput): Promise<ConfirmMemoryImportResult> =>
      withMemoryTransaction(pool, input.spaceId, 'confirm-import', async (client) => {
        const importResult = await client.query<MemoryImportRow>(
          `${importSelect} WHERE id = $1 AND space_id = $2 FOR UPDATE`,
          [input.importId, input.spaceId],
        );
        const importRow = importResult.rows[0];
        if (!importRow) {
          throw new MemoryRepositoryError('not-found', 'confirm-import');
        }
        const memoryImport = mapMemoryImport(importRow);
        if (memoryImport.status === 'confirmed') {
          return { kind: 'already-confirmed' };
        }
        if (memoryImport.status === 'quarantined') {
          return { kind: 'quarantined' };
        }
        const stateVersion = await ensureMemoryState(client, input.spaceId);
        const currentProof = memoryImportPreviewProof({
          contentHash: memoryImport.contentHash,
          destinationProjectId: memoryImport.destinationProjectId,
          destinationSpaceId: memoryImport.destinationSpaceId,
          destinationStateVersion: stateVersion,
          fingerprint: memoryImport.fingerprint,
        });
        if (input.previewProof !== memoryImport.previewProof || currentProof !== memoryImport.previewProof) {
          await client.query("UPDATE memory_imports SET status = 'stale' WHERE id = $1 AND space_id = $2", [
            input.importId,
            input.spaceId,
          ]);
          await insertAudit(client, { ...input.audit, result: 'rejected' });
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
            proposal.proposedByPrincipal.kind !== 'person' ||
            proposal.proposedByPrincipal.personId !== input.confirmedByPersonId ||
            proposal.projectId !== observation.projectId ||
            (item !== null && (item.owningSpaceId !== input.spaceId || item.projectId !== proposal.projectId)) ||
            memoryContentHash(observation.content) !== observation.contentHash
          ) {
            throw new MemoryRepositoryError('invalid-input', 'confirm-import');
          }
        }
        const importedFingerprints: string[] = [];
        for (const record of input.records) {
          const existing = await client.query<ExistingObservationRow>(
            `SELECT id, content_hash FROM memory_observations
             WHERE space_id = $1 AND fingerprint = $2`,
            [input.spaceId, record.observation.fingerprint],
          );
          const existingRow = existing.rows[0];
          if (existingRow) {
            if (
              parseMemoryObservationId(existingRow.id) !== record.observation.id ||
              existingRow.content_hash !== record.observation.contentHash
            ) {
              throw new MemoryRepositoryError('conflict', 'confirm-import');
            }
            continue;
          }
          await insertImportedObservation(client, record.observation);
          await insertImportedProposal(client, record.proposal, record.item?.id ?? null, record.observation.observedAt);
          await client.query(
            `INSERT INTO memory_proposal_observations (space_id, proposal_id, observation_id)
             VALUES ($1, $2, $3)`,
            [input.spaceId, record.proposal.id, record.observation.id],
          );
          if (record.item && record.revision) {
            await insertImportedItem(client, record.item, record.revision, input.confirmedByPersonId);
          }
          importedFingerprints.push(record.observation.fingerprint);
        }
        for (const relation of input.relations) {
          if (relation.owningSpaceId !== input.spaceId) {
            throw new MemoryRepositoryError('invalid-input', 'confirm-import');
          }
          await insertImportedRelation(client, relation);
        }
        const updated = await client.query(
          `UPDATE memory_imports
           SET status = 'confirmed', confirmed_by_person_id = $1, confirmed_at = $2
           WHERE id = $3 AND space_id = $4 AND status IN ('previewed', 'stale')`,
          [input.confirmedByPersonId, input.confirmedAt, input.importId, input.spaceId],
        );
        if (updated.rowCount !== 1) {
          throw new MemoryRepositoryError('stale', 'confirm-import');
        }
        for (const record of input.records) {
          if (record.item && record.revision) {
            await replaceMemorySearchProjection(client, record.item, record.revision);
          }
        }
        await bumpMemoryState(client, input.spaceId);
        await insertAudit(client, input.audit);
        return { importedObservationFingerprints: importedFingerprints, kind: 'confirmed' };
      }),
    createProposal: (input: CreateProposalInput) =>
      withMemoryTransaction(pool, input.proposal.owningSpaceId, 'create-proposal', async (client) => {
        const ownerPersonId =
          input.proposal.proposedByPrincipal.kind === 'person' ? input.proposal.proposedByPrincipal.personId : null;
        if (
          input.proposal.owningSpaceId !== input.audit.spaceId ||
          input.proposal.status !== 'pending' ||
          ownerPersonId === null
        ) {
          throw new MemoryRepositoryError('invalid-input', 'create-proposal');
        }
        const uniqueObservationIds = new Set(input.observationIds);
        if (
          uniqueObservationIds.size !== input.observationIds.length ||
          (input.proposal.trustCandidate === 'harvest-accepted' && uniqueObservationIds.size === 0)
        ) {
          throw new MemoryRepositoryError('invalid-input', 'create-proposal');
        }
        await insertMemoryScope(client, {
          createdAt: input.audit.recordedAt,
          memoryId: input.proposal.id,
          ownerPersonId,
          projectId: input.proposal.projectId,
          sensitivity: input.proposal.sensitivity,
          spaceId: input.proposal.owningSpaceId,
        });
        const actor = principalStorageColumns(input.proposal.proposedByPrincipal);
        await client.query(
          `INSERT INTO memory_proposals
            (id, space_id, project_id, proposed_kind, title, summary, guidance,
             structured_content, trust_candidate, sensitivity, status, proposed_by_kind, proposed_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::JSONB, $9, $10, 'pending', $11, $12)`,
          [
            input.proposal.id,
            input.proposal.owningSpaceId,
            input.proposal.projectId,
            input.proposal.proposedKind,
            input.proposal.title,
            input.proposal.summary,
            JSON.stringify(input.proposal.guidance),
            JSON.stringify(input.proposal.structuredContent),
            input.proposal.trustCandidate,
            input.proposal.sensitivity,
            actor.kind,
            actor.id,
          ],
        );
        for (const observationId of uniqueObservationIds) {
          await client.query(
            `INSERT INTO memory_proposal_observations (space_id, proposal_id, observation_id)
             VALUES ($1, $2, $3)`,
            [input.proposal.owningSpaceId, input.proposal.id, observationId],
          );
        }
        await bumpMemoryState(client, input.proposal.owningSpaceId);
        await insertAudit(client, input.audit);
        return input.proposal.id;
      }),
    createRelation: (relation: MemoryRelation, event: MemoryAuditEvent) =>
      withMemoryTransaction(pool, relation.owningSpaceId, 'create-relation', async (client) => {
        if (relation.owningSpaceId !== event.spaceId || relation.fromMemoryItemId === relation.toMemoryItemId) {
          throw new MemoryRepositoryError('invalid-input', 'create-relation');
        }
        const items = await client.query('SELECT id FROM memory_items WHERE space_id = $1 AND id = ANY($2::UUID[])', [
          relation.owningSpaceId,
          [relation.fromMemoryItemId, relation.toMemoryItemId],
        ]);
        if (items.rows.length !== 2) {
          throw new MemoryRepositoryError('invalid-input', 'create-relation');
        }
        const actor = principalStorageColumns(relation.createdByPrincipal);
        await client.query(
          `INSERT INTO memory_relations
            (id, space_id, from_memory_item_id, to_memory_item_id, relation_kind,
             created_by_kind, created_by_id, created_at, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            relation.id,
            relation.owningSpaceId,
            relation.fromMemoryItemId,
            relation.toMemoryItemId,
            relation.kind,
            actor.kind,
            actor.id,
            relation.createdAt,
            relation.reason,
          ],
        );
        await bumpMemoryState(client, relation.owningSpaceId);
        await insertAudit(client, event);
      }),
    exportMemory: (query: ExportMemoryQuery): Promise<MemoryExportSnapshot> =>
      withMemoryTransaction(pool, query.spaceId, 'export-memory', async (client) => {
        const authorizedIds = authorizedMemoryIds(query, 'export-memory');
        const itemResult = await client.query<ItemRevisionRow>(
          `${itemSelect}
           WHERE item.space_id = $1
             AND ($2::UUID IS NULL OR item.project_id = $2::UUID)
             AND item.id = ANY($3::UUID[])
           ORDER BY item.id ASC LIMIT 1001`,
          [query.spaceId, query.projectId ?? null, authorizedIds],
        );
        if (itemResult.rows.length > 1000) {
          throw new MemoryRepositoryError('invalid-input', 'export-memory');
        }
        const items: MemoryExportItem[] = [];
        for (const itemRow of itemResult.rows) {
          const current = mapItemResult(itemRow);
          const revisionResult = await client.query<ItemRevisionRow>(
            `${itemRevisionHistorySelect}
             WHERE item.space_id = $1 AND item.id = $2
             ORDER BY revision.revision_number ASC LIMIT 1001`,
            [query.spaceId, current.item.id],
          );
          const provenanceResult = await client.query<ProposalObservationSourceRow>(
            `SELECT observation.id, observation.source_kind, observation.source_locator,
                    observation.observed_at, observation.sensitivity
             FROM memory_proposals proposal
             INNER JOIN memory_proposal_observations link
               ON link.proposal_id = proposal.id AND link.space_id = proposal.space_id
             INNER JOIN memory_observations observation
               ON observation.id = link.observation_id AND observation.space_id = link.space_id
             WHERE proposal.space_id = $1 AND proposal.accepted_memory_item_id = $2
             ORDER BY observation.id ASC LIMIT 101`,
            [query.spaceId, current.item.id],
          );
          const relationResult = await client.query<ExportRelationRow>(
            `SELECT relation_kind, to_memory_item_id, reason
             FROM memory_relations
             WHERE space_id = $1 AND from_memory_item_id = $2
             ORDER BY relation_kind ASC, to_memory_item_id ASC LIMIT 101`,
            [query.spaceId, current.item.id],
          );
          if (
            revisionResult.rows.length > 1000 ||
            provenanceResult.rows.length > 100 ||
            relationResult.rows.length > 100
          ) {
            throw new MemoryRepositoryError('invalid-input', 'export-memory');
          }
          items.push({
            item: current.item,
            provenance: provenanceResult.rows.map((source) => ({
              id: parseMemoryObservationId(source.id),
              observedAt: mappedInstant(source.observed_at, 'exportSource.observedAt'),
              sensitivity: enumValue(source.sensitivity, sensitivities, 'map-export-source'),
              sourceKind: enumValue(source.source_kind, observationSourceKinds, 'map-export-source'),
              sourceLocator: optionalString(source.source_locator, 'map-export-source'),
            })),
            relations: relationResult.rows.map((relation) => ({
              kind: enumValue(relation.relation_kind, relationKinds, 'map-export-relation'),
              reason: optionalString(relation.reason, 'map-export-relation'),
              toMemoryItemId: parseMemoryItemId(relation.to_memory_item_id),
            })),
            revisions: revisionResult.rows.map((row) => mapItemResult(row).revision),
          });
        }
        return { items, spaceId: query.spaceId };
      }),
    getItem: (spaceId, itemId) =>
      withMemoryTransaction(pool, spaceId, 'get-item', async (client) => {
        const result = await client.query<ItemRevisionRow>(`${itemSelect} WHERE item.space_id = $1 AND item.id = $2`, [
          spaceId,
          itemId,
        ]);
        const row = result.rows[0];
        return row ? mapItemResult(row) : null;
      }),
    getProposal: (spaceId, proposalId) =>
      withMemoryTransaction(pool, spaceId, 'get-proposal', async (client) => {
        const result = await client.query<ProposalRow>(`${proposalSelect} WHERE space_id = $1 AND id = $2`, [
          spaceId,
          proposalId,
        ]);
        const row = result.rows[0];
        return row ? mapProposal(row) : null;
      }),
    listAuthorizationResourceIds: (spaceId) =>
      withMemoryTransaction(pool, spaceId, 'list-memory-authorization-resources', async (client) => {
        const result = await client.query<{ readonly id: unknown }>(
          `SELECT id FROM memory_items WHERE space_id = $1
           UNION
           SELECT id FROM memory_proposals WHERE space_id = $1 AND status = 'pending'
           ORDER BY id ASC`,
          [spaceId],
        );
        return result.rows.map((row) => requiredString(row.id, 'list-memory-authorization-resources'));
      }),
    listItems: (query) => {
      if (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100) {
        return Promise.reject(new MemoryRepositoryError('invalid-input', 'list-items'));
      }
      let afterItemId: string | null;
      try {
        afterItemId = decodeCursor(query.cursor, query);
      } catch (error) {
        return Promise.reject(error);
      }
      return withMemoryTransaction(pool, query.spaceId, 'list-items', async (client) => {
        const authorizedIds = authorizedMemoryIds(query, 'list-items');
        const result = await client.query<ItemRevisionRow>(
          `${itemSelect}
           WHERE item.space_id = $1
             AND ($2::UUID IS NULL OR item.project_id = $2::UUID)
             AND ($3::TEXT IS NULL OR item.status = $3::TEXT)
             AND ($4::UUID IS NULL OR item.id > $4::UUID)
             AND item.id = ANY($6::UUID[])
           ORDER BY item.id ASC
           LIMIT $5`,
          [
            query.spaceId,
            query.projectId ?? null,
            query.status ?? null,
            afterItemId,
            query.pageSize + 1,
            authorizedIds,
          ],
        );
        const hasNext = result.rows.length > query.pageSize;
        const items = (hasNext ? result.rows.slice(0, query.pageSize) : result.rows).map(mapItemResult);
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
      });
    },
    listProposals: (query) => {
      if (!Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100) {
        return Promise.reject(new MemoryRepositoryError('invalid-input', 'list-proposals'));
      }
      let afterProposalId: string | null;
      try {
        afterProposalId = decodeProposalCursor(query.cursor, query);
      } catch (error) {
        return Promise.reject(error);
      }
      return withMemoryTransaction(pool, query.spaceId, 'list-proposals', async (client) => {
        const authorizedIds = authorizedMemoryIds(query, 'list-proposals');
        const result = await client.query<ProposalRow>(
          `${proposalSelect}
           WHERE space_id = $1 AND status = $2
             AND ($3::UUID IS NULL OR id > $3::UUID)
             AND id = ANY($5::UUID[])
           ORDER BY id ASC LIMIT $4`,
          [query.spaceId, query.status, afterProposalId, query.pageSize + 1, authorizedIds],
        );
        const hasNext = result.rows.length > query.pageSize;
        const pageRows = hasNext ? result.rows.slice(0, query.pageSize) : result.rows;
        const items = await Promise.all(
          pageRows.map(async (row) => {
            const proposal = mapProposal(row);
            const sources = await client.query<ProposalObservationSourceRow>(
              `SELECT observation.id, observation.source_kind, observation.source_locator,
                      observation.observed_at, observation.sensitivity
               FROM memory_proposal_observations link
               INNER JOIN memory_observations observation ON observation.id = link.observation_id
               WHERE link.space_id = $1 AND link.proposal_id = $2
               ORDER BY observation.id ASC LIMIT 101`,
              [query.spaceId, proposal.id],
            );
            if (sources.rows.length > 100) {
              throw new MemoryRepositoryError('unavailable', 'list-proposals');
            }
            return {
              observationSources: sources.rows.map((source) => ({
                id: parseMemoryObservationId(source.id),
                observedAt: mappedInstant(source.observed_at, 'proposalSource.observedAt'),
                sensitivity: enumValue(source.sensitivity, sensitivities, 'map-proposal-source'),
                sourceKind: enumValue(source.source_kind, observationSourceKinds, 'map-proposal-source'),
                sourceLocator: optionalString(source.source_locator, 'map-proposal-source'),
              })),
              proposal,
            };
          }),
        );
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
      });
    },
    previewImport: (input: PreviewMemoryImportInput): Promise<PreviewMemoryImportResult> =>
      withMemoryTransaction(pool, input.destinationSpaceId, 'preview-import', async (client) => {
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
        const stateVersion = await ensureMemoryState(client, input.destinationSpaceId);
        const previewProof = memoryImportPreviewProof({
          contentHash: input.contentHash,
          destinationProjectId: input.destinationProjectId,
          destinationSpaceId: input.destinationSpaceId,
          destinationStateVersion: stateVersion,
          fingerprint: input.fingerprint,
        });
        const existingResult = await client.query<MemoryImportRow>(
          `${importSelect} WHERE space_id = $1 AND fingerprint = $2 FOR UPDATE`,
          [input.destinationSpaceId, input.fingerprint],
        );
        const existingRow = existingResult.rows[0];
        if (existingRow && parseMemoryImportId(existingRow.id) !== input.id) {
          throw new MemoryRepositoryError('conflict', 'preview-import');
        }
        const duplicateResult =
          input.observationFingerprints.length === 0
            ? { rows: [] as { readonly fingerprint: string }[] }
            : await client.query<{ readonly fingerprint: string }>(
                `SELECT fingerprint FROM memory_observations
                 WHERE space_id = $1 AND fingerprint = ANY($2::TEXT[])`,
                [input.destinationSpaceId, input.observationFingerprints],
              );
        const duplicateSet = new Set(duplicateResult.rows.map((row) => row.fingerprint));
        const duplicateObservationFingerprints = input.observationFingerprints.filter((fingerprint) =>
          duplicateSet.has(fingerprint),
        );
        if (existingRow && existingRow.status === 'confirmed') {
          await insertAudit(client, input.audit);
          return {
            alreadyConfirmed: true,
            duplicateObservationFingerprints,
            memoryImport: mapMemoryImport(existingRow),
          };
        }
        const storedResult = await client.query<MemoryImportRow>(
          `INSERT INTO memory_imports
            (id, space_id, project_id, source_kind, source_locator, fingerprint,
             content_hash, preview_proof, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (space_id, fingerprint) DO UPDATE SET
             project_id = excluded.project_id,
             source_kind = excluded.source_kind,
             source_locator = excluded.source_locator,
             content_hash = excluded.content_hash,
             preview_proof = excluded.preview_proof,
             status = excluded.status,
             created_at = excluded.created_at,
             confirmed_by_person_id = NULL,
             confirmed_at = NULL
           RETURNING id, space_id, project_id, source_kind, source_locator, fingerprint,
                     content_hash, preview_proof, status, created_at,
                     confirmed_by_person_id, confirmed_at`,
          [
            input.id,
            input.destinationSpaceId,
            input.destinationProjectId,
            input.sourceKind,
            input.sourceLocator,
            input.fingerprint,
            input.contentHash,
            previewProof,
            input.status,
            input.createdAt,
          ],
        );
        const stored = storedResult.rows[0];
        if (!stored) {
          throw new MemoryRepositoryError('unavailable', 'preview-import');
        }
        await insertAudit(client, input.audit);
        return {
          alreadyConfirmed: false,
          duplicateObservationFingerprints,
          memoryImport: mapMemoryImport(stored),
        };
      }),
    purgeItem: (input: PurgeMemoryItemInput) =>
      withMemoryTransaction(pool, input.spaceId, 'purge-memory-item', async (client) => {
        if (
          input.audit.spaceId !== input.spaceId ||
          input.audit.subjectId !== input.itemId ||
          input.audit.subjectType !== 'memory-item'
        ) {
          throw new MemoryRepositoryError('invalid-input', 'purge-memory-item');
        }
        const exists = await client.query('SELECT 1 FROM memory_items WHERE id = $1 AND space_id = $2 FOR UPDATE', [
          input.itemId,
          input.spaceId,
        ]);
        if (!exists.rows[0]) {
          throw new MemoryRepositoryError('not-found', 'purge-memory-item');
        }
        const proposalResult = await client.query<{ readonly id: string }>(
          `SELECT id FROM memory_proposals
           WHERE space_id = $1 AND accepted_memory_item_id = $2`,
          [input.spaceId, input.itemId],
        );
        const proposalIds = proposalResult.rows.map((row) => row.id);
        const observationResult = await client.query<{ readonly observation_id: string }>(
          `SELECT DISTINCT link.observation_id
           FROM memory_proposals proposal
           INNER JOIN memory_proposal_observations link
             ON link.proposal_id = proposal.id AND link.space_id = proposal.space_id
           WHERE proposal.space_id = $1 AND proposal.accepted_memory_item_id = $2`,
          [input.spaceId, input.itemId],
        );
        await client.query("SELECT set_config('ai_usage.allow_memory_privacy_purge', 'on', TRUE)");
        await client.query(
          `DELETE FROM memory_proposal_observations
           WHERE space_id = $1 AND proposal_id = ANY($2::UUID[])`,
          [input.spaceId, proposalIds],
        );
        await client.query(
          `DELETE FROM memory_proposals
           WHERE space_id = $1 AND accepted_memory_item_id = $2`,
          [input.spaceId, input.itemId],
        );
        await client.query(
          `DELETE FROM memory_relations
           WHERE space_id = $1 AND (from_memory_item_id = $2 OR to_memory_item_id = $2)`,
          [input.spaceId, input.itemId],
        );
        await client.query('DELETE FROM memory_revisions WHERE space_id = $1 AND memory_item_id = $2', [
          input.spaceId,
          input.itemId,
        ]);
        await client.query('DELETE FROM memory_items WHERE space_id = $1 AND id = $2', [input.spaceId, input.itemId]);
        for (const row of observationResult.rows) {
          await client.query(
            `DELETE FROM memory_observations observation
             WHERE observation.space_id = $1 AND observation.id = $2
               AND NOT EXISTS (
                 SELECT 1 FROM memory_proposal_observations link
                 WHERE link.space_id = $1 AND link.observation_id = $2
               )`,
            [input.spaceId, row.observation_id],
          );
        }
        const authorizationResourceIds = [...proposalIds, input.itemId];
        await client.query(
          `DELETE FROM memory_content_grants
           WHERE space_id = $1 AND memory_id = ANY($2::UUID[])`,
          [input.spaceId, authorizationResourceIds],
        );
        await client.query(
          `DELETE FROM memory_authorization_scopes
           WHERE space_id = $1 AND id = ANY($2::UUID[])`,
          [input.spaceId, authorizationResourceIds],
        );
        await bumpMemoryState(client, input.spaceId);
        await insertAudit(client, input.audit);
      }),
    recordAuditEvent: (event) =>
      withMemoryTransaction(pool, event.spaceId, 'record-audit-event', async (client) => {
        await insertAudit(client, event);
      }),
    recordObservation: (input: RecordObservationInput) =>
      withMemoryTransaction(pool, input.observation.owningSpaceId, 'record-observation', async (client) => {
        const { observation } = input;
        if (
          observation.owningSpaceId !== input.audit.spaceId ||
          memoryContentHash(observation.content) !== observation.contentHash
        ) {
          throw new MemoryRepositoryError('invalid-input', 'record-observation');
        }
        const actor = principalStorageColumns(observation.createdByPrincipal);
        const inserted = await client.query<ExistingObservationRow>(
          `INSERT INTO memory_observations
            (id, space_id, project_id, capture_context_id, source_kind, source_locator,
             fingerprint, content_hash, observed_at, content, sensitivity,
             redaction_rule_set_version, created_by_kind, created_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11, $12, $13, $14)
           ON CONFLICT (space_id, fingerprint) DO NOTHING
           RETURNING id, content_hash`,
          [
            observation.id,
            observation.owningSpaceId,
            observation.projectId,
            observation.captureContextId,
            observation.sourceKind,
            observation.sourceLocator,
            observation.fingerprint,
            observation.contentHash,
            observation.observedAt,
            JSON.stringify(observation.content),
            observation.sensitivity,
            observation.redactionRuleSetVersion,
            actor.kind,
            actor.id,
          ],
        );
        let created = true;
        let row = inserted.rows[0];
        if (!row) {
          created = false;
          const existing = await client.query<ExistingObservationRow>(
            `SELECT id, content_hash FROM memory_observations
             WHERE space_id = $1 AND fingerprint = $2`,
            [observation.owningSpaceId, observation.fingerprint],
          );
          row = existing.rows[0];
        }
        if (!row) {
          throw new MemoryRepositoryError('unavailable', 'record-observation');
        }
        const id = parseMemoryObservationId(row.id);
        if (id !== observation.id || row.content_hash !== observation.contentHash) {
          throw new MemoryRepositoryError('conflict', 'record-observation');
        }
        if (created) {
          await bumpMemoryState(client, observation.owningSpaceId);
        }
        await insertAudit(client, input.audit);
        return { created, id };
      }),
    rejectProposal: (input: RejectProposalInput) =>
      withMemoryTransaction(pool, input.spaceId, 'reject-proposal', async (client) => {
        const existing = await client.query(
          'SELECT status FROM memory_proposals WHERE id = $1 AND space_id = $2 FOR UPDATE',
          [input.proposalId, input.spaceId],
        );
        if (!existing.rows[0]) {
          throw new MemoryRepositoryError('not-found', 'reject-proposal');
        }
        if (existing.rows[0].status !== 'pending') {
          throw new MemoryRepositoryError('conflict', 'reject-proposal');
        }
        await client.query(
          `UPDATE memory_proposals
           SET status = 'rejected', reviewed_by_person_id = $1, reviewed_at = $2, review_reason = $3
           WHERE id = $4 AND space_id = $5`,
          [input.reviewerPersonId, input.reviewedAt, input.reason, input.proposalId, input.spaceId],
        );
        await client.query(
          `UPDATE memory_authorization_scopes SET status = 'superseded'
           WHERE id = $1 AND space_id = $2`,
          [input.proposalId, input.spaceId],
        );
        await bumpMemoryState(client, input.spaceId);
        await insertAudit(client, input.audit);
      }),
    reviseItem: (input: ReviseMemoryItemInput) =>
      withMemoryTransaction(pool, input.spaceId, 'revise-item', async (client) => {
        const result = await client.query<ItemStateRow>(
          `SELECT item.current_revision_id, item.status, revision.revision_number
           FROM memory_items item
           INNER JOIN memory_revisions revision ON revision.id = item.current_revision_id
           WHERE item.id = $1 AND item.space_id = $2 FOR UPDATE OF item`,
          [input.revision.memoryItemId, input.spaceId],
        );
        const state = result.rows[0];
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
        await insertRevision(client, input.revision, input.spaceId);
        const updated = await client.query(
          `UPDATE memory_items SET current_revision_id = $1, sensitivity = $2
           WHERE id = $3 AND space_id = $4 AND current_revision_id = $5`,
          [
            input.revision.id,
            input.sensitivity,
            input.revision.memoryItemId,
            input.spaceId,
            input.expectedCurrentRevisionId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new MemoryRepositoryError('stale', 'revise-item');
        }
        await client.query(
          `UPDATE memory_authorization_scopes
           SET sensitivity = $1, requires_trusted_device = $2
           WHERE id = $3 AND space_id = $4`,
          [input.sensitivity, input.sensitivity === 'sensitive', input.revision.memoryItemId, input.spaceId],
        );
        await reindexMemorySearchItem(client, input.spaceId, input.revision.memoryItemId);
        await bumpMemoryState(client, input.spaceId);
        await insertAudit(client, input.audit);
        return input.revision;
      }),
    searchItems: (query: SearchMemoryRepositoryQuery): Promise<MemorySearchPage> => {
      const cursor = decodeMemorySearchCursor(query.cursor, query);
      const searchSql = postgresMemorySearchSql(query);
      return withMemorySearchTransaction(pool, query, async (client) => {
        await ensureMemorySearchProjection(client, query.spaceId);
        await client.query("SELECT set_config('pg_trgm.similarity_threshold', '0.12', TRUE)");
        const metadataResult = await client.query<MemorySearchMetadataRow>(
          `${searchSql.cte},
           scope_metadata AS (
             SELECT md5(COALESCE(string_agg(id::TEXT, ',' ORDER BY id), '')) AS scope_hash
             FROM authorized_resources
           ),
           result_metadata AS (
             SELECT count(*) AS total_count,
                    md5(COALESCE(
                      string_agg(
                        memory_item_id::TEXT || ':' || revision_id::TEXT || ':' || content_hash || ':' ||
                        status || ':' || round(exact_score::NUMERIC, 6)::TEXT || ':' ||
                        round(lexical_score::NUMERIC, 6)::TEXT || ':' ||
                        round(trigram_score::NUMERIC, 6)::TEXT || ':' ||
                        round(total_score::NUMERIC, 6)::TEXT,
                        ',' ORDER BY ${searchSql.orderBy}
                      ),
                      ''
                    )) AS order_hash
             FROM best_items
           )
           SELECT result_metadata.total_count, result_metadata.order_hash, scope_metadata.scope_hash
           FROM result_metadata CROSS JOIN scope_metadata`,
          [...searchSql.values],
        );
        const metadata = metadataResult.rows[0];
        if (!metadata) {
          throw new MemoryRepositoryError('unavailable', 'search-items-metadata');
        }
        const total = searchNumber(metadata.total_count, 'search-items-metadata');
        const orderHash = requiredString(metadata.order_hash, 'search-items-metadata');
        const scopeHash = requiredString(metadata.scope_hash, 'search-items-metadata');
        if (!Number.isSafeInteger(total) || total < 0 || orderHash.length !== 32 || scopeHash.length !== 32) {
          throw new MemoryRepositoryError('unavailable', 'search-items-metadata');
        }
        if (cursor && (cursor.orderHash !== orderHash || cursor.scopeHash !== scopeHash)) {
          throw new MemoryRepositoryError('stale', 'search-items-cursor-snapshot');
        }
        const offset = cursor?.offset ?? 0;
        if (offset > total) {
          throw new MemoryRepositoryError('stale', 'search-items-cursor-offset');
        }
        if (query.signal?.aborted) {
          throw new MemoryRepositoryError('cancelled', 'search-items');
        }
        const result = await client.query<MemorySearchResultRow>(
          `${searchSql.cte}
           SELECT best.memory_item_id AS item_id, best.project_id, best.kind, best.status,
                  best.trust, best.sensitivity, best.content_hash, best.revision_id,
                  best.revision_number, revision.title, revision.summary,
                  revision.guidance, revision.structured_content,
                  best.exact_score, best.lexical_score, best.trigram_score, best.total_score
           FROM best_items best
           INNER JOIN memory_revisions revision
             ON revision.id = best.revision_id
            AND revision.memory_item_id = best.memory_item_id
            AND revision.space_id = best.space_id
           ORDER BY best.total_score DESC, best.exact_score DESC, best.lexical_score DESC,
                    best.trigram_score DESC, best.memory_item_id ASC
           LIMIT $13 OFFSET $14`,
          [...searchSql.values, query.limit, offset],
        );
        const items: MemorySearchPage['items'][number][] = [];
        for (const row of result.rows) {
          const itemId = parseMemoryItemId(row.item_id);
          const guidance = guidanceValue(row.guidance, 'search-items-guidance');
          const structuredContent = jsonValue(row.structured_content, 'search-items-structured-content');
          const title = requiredString(row.title, 'search-items-title').slice(0, memorySearchBounds.maxTitleCharacters);
          const summary = requiredString(row.summary, 'search-items-summary').slice(
            0,
            memorySearchBounds.maxSummaryCharacters,
          );
          const provenanceResult = await client.query<ProposalObservationSourceRow>(
            `SELECT observation.id, observation.source_kind, observation.observed_at,
                    observation.sensitivity
             FROM memory_proposals proposal
             INNER JOIN memory_proposal_observations link
               ON link.proposal_id = proposal.id AND link.space_id = proposal.space_id
             INNER JOIN memory_observations observation
               ON observation.id = link.observation_id AND observation.space_id = link.space_id
             WHERE proposal.space_id = $1 AND proposal.accepted_memory_item_id = $2
             ORDER BY observation.id ASC
             LIMIT $3`,
            [query.spaceId, itemId, memorySearchBounds.maxProvenancePerResult],
          );
          const revisionNumber = searchNumber(row.revision_number, 'search-items-revision-number');
          if (!Number.isSafeInteger(revisionNumber) || revisionNumber <= 0) {
            throw new MemoryRepositoryError('unavailable', 'search-items-revision-number');
          }
          const exact = normalizeMemorySearchScore(searchNumber(row.exact_score, 'search-items-score'));
          const lexical = normalizeMemorySearchScore(searchNumber(row.lexical_score, 'search-items-score'));
          const trigram = normalizeMemorySearchScore(searchNumber(row.trigram_score, 'search-items-score'));
          const totalScore = normalizeMemorySearchScore(searchNumber(row.total_score, 'search-items-score'));
          items.push({
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
              searchSql.compiled,
            ),
            projectId: row.project_id === null ? null : parseProjectId(row.project_id),
            provenance: provenanceResult.rows.map((source) => ({
              observationId: parseMemoryObservationId(source.id),
              observedAt: mappedInstant(source.observed_at, 'search-items-provenance'),
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
          });
        }
        const nextOffset = offset + items.length;
        const page: MemorySearchPage = {
          items,
          nextCursor:
            nextOffset < total
              ? encodeMemorySearchCursor({
                  adapterVersion: POSTGRESQL_MEMORY_SEARCH_ADAPTER_VERSION,
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
          rankingVersion: `${MEMORY_SEARCH_RANKING_VERSION}/${POSTGRESQL_MEMORY_SEARCH_ADAPTER_VERSION}`,
          total,
        };
        assertMemorySearchPageBounds(page);
        return page;
      });
    },
    supersedeItem: (input: SupersedeMemoryItemInput) =>
      withMemoryTransaction(pool, input.spaceId, 'supersede-item', async (client) => {
        const updated = await client.query(
          `UPDATE memory_items SET status = 'superseded'
           WHERE id = $1 AND space_id = $2 AND status = 'active'`,
          [input.itemId, input.spaceId],
        );
        if (updated.rowCount !== 1) {
          const exists = await client.query('SELECT 1 FROM memory_items WHERE id = $1 AND space_id = $2', [
            input.itemId,
            input.spaceId,
          ]);
          throw new MemoryRepositoryError(exists.rows[0] ? 'conflict' : 'not-found', 'supersede-item');
        }
        await reindexMemorySearchItem(client, input.spaceId, input.itemId);
        await bumpMemoryState(client, input.spaceId);
        await insertAudit(client, input.audit);
      }),
  };
  return Object.freeze(repository);
};
