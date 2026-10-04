import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { redactDistillationText } from '@ai-usage/memory-service/distillation-redaction';
import type { DistillationRepository, DistillationSourceGrant } from '@ai-usage/memory-service/distillation-repository';
import {
  type DistillationEvidencePacket,
  distillationEvidenceDigestInput,
  parseDistillationEvidencePacket,
} from '@ai-usage/platform-core/distillation-evidence';
import {
  type AnalysisRevisionMetadata,
  analysisAssertions,
  DISTILLATION_EXTRACTOR_VERSION,
  DISTILLATION_SCHEMA_VERSION,
  DistillationError,
  type DistillationJobView,
  type DistillationSearchHit,
  distillationBounds,
  distillationInteger,
  distillationText,
  parseSessionAnalysis,
  parseSessionAnalysisContent,
  type SessionAnalysis,
  type SessionAnalysisContent,
  validateAnalysisEvidence,
} from '@ai-usage/platform-core/session-distillation';

interface JobRow {
  analysis_id: string | null;
  attempt: number;
  content_digest: string | null;
  error_code: string | null;
  extractor_version: string;
  grant_json: string;
  id: string;
  lease_expires_at: string | null;
  lease_id: string | null;
  machine_id: string;
  native_session_id: string;
  packet_digest: string;
  packet_json: string | null;
  producer_session_id: string | null;
  project_id: string;
  state: DistillationJobView['state'];
}
interface AnalysisRow {
  analysis_json: string;
  coverage_status: 'complete' | 'partial';
  created_at: string;
  episode_ids_json: string;
  id: string;
  machine_id: string;
  native_session_id: string;
  packet_digest: string;
  project_id: string;
  revision: number;
  summary: string;
}
type AnalysisMetadataRow = Pick<
  AnalysisRow,
  'id' | 'project_id' | 'machine_id' | 'native_session_id' | 'packet_digest' | 'revision' | 'created_at'
>;
type JobViewRow = Pick<JobRow, 'id' | 'state' | 'attempt' | 'error_code' | 'analysis_id'>;
const ANALYSIS_METADATA_COLUMNS = 'id, project_id, machine_id, native_session_id, packet_digest, revision, created_at';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const SEARCH_WHITESPACE = /\s+/u;
const jobView = (row: JobViewRow): DistillationJobView => ({
  id: row.id,
  state: row.state,
  attempt: row.attempt,
  errorCode: row.error_code,
  analysisId: row.analysis_id,
});
const metadata = (row: AnalysisMetadataRow): AnalysisRevisionMetadata => ({
  id: row.id,
  projectId: row.project_id,
  machineId: row.machine_id,
  nativeSessionId: row.native_session_id,
  packetDigest: row.packet_digest,
  revision: row.revision,
  createdAt: row.created_at,
});
const operation = <T>(run: () => T): Promise<T> => {
  try {
    return Promise.resolve(run());
  } catch (cause) {
    return Promise.reject(cause instanceof DistillationError ? cause : new DistillationError('storage-failed'));
  }
};
const parsePacket = (value: unknown): DistillationEvidencePacket => {
  try {
    const packet = parseDistillationEvidencePacket(value);
    if (hash(distillationEvidenceDigestInput(packet)) !== packet.packetDigest) {
      throw new DistillationError('packet-digest-mismatch');
    }
    return packet;
  } catch (cause) {
    throw cause instanceof DistillationError ? cause : new DistillationError('invalid-packet');
  }
};

const supportedExtractorVersion = (job: JobRow): typeof DISTILLATION_EXTRACTOR_VERSION => {
  if (job.extractor_version !== DISTILLATION_EXTRACTOR_VERSION) {
    throw new DistillationError('extractor-version-mismatch');
  }
  return job.extractor_version;
};

const validateGrant = (grant: DistillationSourceGrant, packet: DistillationEvidencePacket): void => {
  for (const value of [
    grant.projectId,
    grant.machineId,
    grant.nativeSessionId,
    grant.projectSourceId,
    grant.checkoutPath,
    grant.selection.revision,
    grant.selection.rowId,
  ]) {
    distillationText(value, 4096);
  }
  if (
    grant.projectId !== packet.source.projectId ||
    grant.machineId !== packet.source.machineId ||
    grant.nativeSessionId !== packet.source.nativeSessionId ||
    grant.selection.revision !== packet.source.reportAnchor?.revision ||
    grant.selection.rowId !== packet.source.reportAnchor?.rowId
  ) {
    throw new DistillationError('source-grant-mismatch');
  }
};

const redactedContent = (value: unknown, packet: DistillationEvidencePacket): SessionAnalysisContent => {
  const content = parseSessionAnalysisContent(value);
  validateAnalysisEvidence(content, packet.events);
  const redacted = parseSessionAnalysisContent(
    JSON.parse(
      JSON.stringify(content, (_key, item: unknown) =>
        typeof item === 'string' ? redactDistillationText(item) : item,
      ),
    ),
  );
  validateAnalysisEvidence(redacted, packet.events);
  return redacted;
};

const safeSearchQuery = (query: string): string => {
  const terms = distillationText(query, 1000).trim().split(SEARCH_WHITESPACE);
  if (terms.length > 32) {
    throw new DistillationError('search-query-too-large');
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
};

/** Constructed only by the existing local sole-writer kernel; no independent connection. */
export const createSqliteDistillationRepository = (
  database: Database,
  clock: () => Date = () => new Date(),
): DistillationRepository => {
  const now = (): string => clock().toISOString();
  const recover = database.transaction(() => {
    database
      .query(`UPDATE distillation_jobs SET state='failed', error_code='worker-recovered', lease_id=NULL,
      lease_expires_at=NULL, updated_at=? WHERE state='running'`)
      .run(now());
  });
  recover.immediate();

  const expire = (): void => {
    database
      .query(`UPDATE distillation_jobs SET state='failed', error_code='lease-expired', lease_id=NULL,
      lease_expires_at=NULL, updated_at=? WHERE state='running' AND lease_expires_at<=?`)
      .run(now(), now());
  };
  const readJob = (projectId: string, jobId: string): JobRow => {
    const row = database
      .query('SELECT * FROM distillation_jobs WHERE id=? AND project_id=?')
      .get(jobId, projectId) as JobRow | null;
    if (!row) {
      throw new DistillationError('job-not-found');
    }
    return row;
  };
  const readAnalysis = (projectId: string, analysisId: string): SessionAnalysis => {
    const row = database
      .query('SELECT analysis_json FROM session_analyses WHERE id=? AND project_id=?')
      .get(analysisId, projectId) as Pick<AnalysisRow, 'analysis_json'> | null;
    if (!row) {
      throw new DistillationError('analysis-not-found');
    }
    return parseSessionAnalysis(JSON.parse(row.analysis_json));
  };
  const transaction = <T>(run: () => T): Promise<T> =>
    operation(() => {
      // Expiration commits even when the requested transition is rejected.
      expire();
      return database.transaction(run).immediate();
    });

  const repository: DistillationRepository = {
    prepare: (input) =>
      transaction(() => {
        const packet = parsePacket(input.packet);
        validateGrant(input.grant, packet);
        if (packet.events.some((event) => redactDistillationText(event.text) !== event.text)) {
          throw new DistillationError('unredacted-packet');
        }
        if (input.revisionKey !== null) {
          distillationText(input.revisionKey, 128);
        }
        if (input.producerSessionId !== null) {
          distillationText(input.producerSessionId);
        }
        // A report publication or filesystem timestamp alone is not a new interpretation.
        // Keep the original packet/grant exact when returning an existing job.
        const snapshotIdentity = hash(
          distillationEvidenceDigestInput({
            ...packet,
            source: { ...packet.source, reportAnchor: null, version: { ...packet.source.version, modifiedAtMs: 0 } },
          }),
        );
        const dedupe = hash(
          JSON.stringify([
            packet.source.projectId,
            packet.source.machineId,
            packet.source.nativeSessionId,
            snapshotIdentity,
            DISTILLATION_EXTRACTOR_VERSION,
            input.revisionKey,
          ]),
        );
        const existing = database
          .query('SELECT * FROM distillation_jobs WHERE dedupe_key=?')
          .get(dedupe) as JobRow | null;
        if (existing) {
          return jobView(existing);
        }
        const id = randomUUID();
        database
          .query(`INSERT INTO distillation_jobs (id, project_id, machine_id, native_session_id, packet_digest,
        dedupe_key, extractor_version, state, packet_json, grant_json, producer_session_id, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,'queued',?,?,?,?,?)`)
          .run(
            id,
            packet.source.projectId,
            packet.source.machineId,
            packet.source.nativeSessionId,
            packet.packetDigest,
            dedupe,
            DISTILLATION_EXTRACTOR_VERSION,
            JSON.stringify(packet),
            JSON.stringify(input.grant),
            input.producerSessionId,
            now(),
            now(),
          );
        return jobView(readJob(packet.source.projectId, id));
      }),
    claim: (projectId, jobId) =>
      transaction(() => {
        const job = readJob(projectId, jobId);
        const extractorVersion = supportedExtractorVersion(job);
        if (job.state !== 'queued') {
          throw new DistillationError('job-not-queued');
        }
        if (job.attempt >= distillationBounds.attempts) {
          throw new DistillationError('attempt-limit');
        }
        if (database.query("SELECT id FROM distillation_jobs WHERE state='running' LIMIT 1").get()) {
          throw new DistillationError('worker-busy');
        }
        if (job.packet_json === null) {
          throw new DistillationError('packet-unavailable');
        }
        const packet = parsePacket(JSON.parse(job.packet_json));
        const leaseId = randomUUID();
        const expiresAt = new Date(clock().getTime() + distillationBounds.leaseMs).toISOString();
        database
          .query(`UPDATE distillation_jobs SET state='running', attempt=attempt+1, lease_id=?,
        lease_expires_at=?, error_code=NULL, updated_at=? WHERE id=?`)
          .run(leaseId, expiresAt, now(), job.id);
        return {
          leaseId,
          expiresAt,
          packet,
          job: jobView(readJob(projectId, jobId)),
          schemaVersion: DISTILLATION_SCHEMA_VERSION,
          extractorVersion,
        };
      }),
    cancel: (projectId, jobId) =>
      transaction(() => {
        const job = readJob(projectId, jobId);
        if (job.state === 'published') {
          throw new DistillationError('already-published');
        }
        if (job.state !== 'cancelled') {
          database
            .query(`UPDATE distillation_jobs SET state='cancelled', lease_id=NULL, lease_expires_at=NULL,
          error_code=NULL, updated_at=? WHERE id=?`)
            .run(now(), job.id);
        }
        return jobView(readJob(projectId, jobId));
      }),
    retry: (projectId, jobId) =>
      transaction(() => {
        const job = readJob(projectId, jobId);
        supportedExtractorVersion(job);
        if (job.state !== 'failed') {
          throw new DistillationError('job-not-retryable');
        }
        if (job.attempt >= distillationBounds.attempts) {
          throw new DistillationError('attempt-limit');
        }
        if (job.packet_json === null) {
          throw new DistillationError('packet-unavailable');
        }
        database
          .query(`UPDATE distillation_jobs SET state='queued', error_code=NULL, lease_id=NULL,
        lease_expires_at=NULL, updated_at=? WHERE id=?`)
          .run(now(), job.id);
        return jobView(readJob(projectId, jobId));
      }),
    submit: (input) =>
      transaction(() => {
        const job = readJob(input.projectId, input.jobId);
        const extractorVersion = supportedExtractorVersion(job);
        if (job.packet_digest !== input.packetDigest || job.lease_id !== input.leaseId) {
          throw new DistillationError('stale-worker');
        }
        if (job.state === 'published') {
          const normalized = parseSessionAnalysisContent(input.content);
          if (hash(JSON.stringify(normalized)) !== job.content_digest || !job.analysis_id) {
            throw new DistillationError('submission-conflict');
          }
          return readAnalysis(input.projectId, job.analysis_id);
        }
        if (job.state !== 'running' || job.lease_expires_at === null || job.lease_expires_at <= now()) {
          throw new DistillationError('stale-worker');
        }
        if (job.packet_json === null) {
          throw new DistillationError('packet-unavailable');
        }
        const packet = parsePacket(JSON.parse(job.packet_json));
        const content = redactedContent(input.content, packet);
        const latest = database
          .query(`SELECT COALESCE(MAX(revision),0) AS revision FROM session_analyses
        WHERE project_id=? AND machine_id=? AND native_session_id=?`)
          .get(job.project_id, job.machine_id, job.native_session_id) as { revision: number };
        const analysis: SessionAnalysis = {
          id: randomUUID(),
          projectId: job.project_id,
          machineId: job.machine_id,
          nativeSessionId: job.native_session_id,
          revision: latest.revision + 1,
          packetDigest: job.packet_digest,
          createdAt: now(),
          schemaVersion: DISTILLATION_SCHEMA_VERSION,
          normalizationVersion: packet.normalizationVersion,
          extractorVersion,
          source: packet.source,
          coverage: packet.coverage,
          producer: {
            kind: 'active-harness',
            sessionId: job.producer_session_id,
            attribution: job.producer_session_id === null ? 'unknown' : 'worker-declared',
          },
          content,
          validation: 'schema-and-references',
        };
        parseSessionAnalysis(analysis);
        database
          .query(`INSERT INTO session_analyses (id, project_id, machine_id, native_session_id, revision, job_id,
        packet_digest, created_at, summary, coverage_status, episode_ids_json, analysis_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            analysis.id,
            job.project_id,
            job.machine_id,
            job.native_session_id,
            analysis.revision,
            job.id,
            job.packet_digest,
            analysis.createdAt,
            content.summary.text,
            packet.coverage.status,
            JSON.stringify(content.episodes.map((episode) => episode.id)),
            JSON.stringify(analysis),
          );
        database
          .query(`DELETE FROM session_analyses_fts WHERE analysis_id IN
        (SELECT id FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=?)`)
          .run(job.project_id, job.machine_id, job.native_session_id);
        const searchable = analysisAssertions(content)
          .map((assertion) => [assertion.text, ...assertion.evidence.map((ref) => ref.quote)].join('\n'))
          .join('\n');
        database
          .query('INSERT INTO session_analyses_fts (analysis_id, project_id, content) VALUES (?,?,?)')
          .run(analysis.id, job.project_id, searchable);
        database
          .query(`UPDATE distillation_jobs SET state='published', analysis_id=?, content_digest=?,
        lease_expires_at=NULL, updated_at=? WHERE id=?`)
          .run(analysis.id, hash(JSON.stringify(parseSessionAnalysisContent(input.content))), now(), job.id);
        return analysis;
      }),
    get: (projectId, analysisId) => operation(() => readAnalysis(projectId, analysisId)),
    getGrant: (projectId, analysisId) =>
      operation(() => {
        const row = database
          .query(`SELECT j.grant_json FROM distillation_jobs j JOIN session_analyses a ON a.job_id=j.id
        WHERE a.id=? AND a.project_id=?`)
          .get(analysisId, projectId) as { grant_json: string } | null;
        if (!row) {
          throw new DistillationError('analysis-not-found');
        }
        return JSON.parse(row.grant_json) as DistillationSourceGrant;
      }),
    status: (grant) =>
      transaction(() => {
        const parameters = [grant.projectId, grant.machineId, grant.nativeSessionId];
        const job = database
          .query(`SELECT id, state, attempt, error_code, analysis_id FROM distillation_jobs WHERE project_id=? AND machine_id=? AND native_session_id=?
        ORDER BY rowid DESC LIMIT 1`)
          .get(...parameters) as JobViewRow | null;
        const rows = database
          .query(`SELECT ${ANALYSIS_METADATA_COLUMNS} FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=?
        ORDER BY revision DESC LIMIT 20`)
          .all(...parameters) as AnalysisMetadataRow[];
        const count = database
          .query(`SELECT COUNT(*) AS count FROM session_analyses
        WHERE project_id=? AND machine_id=? AND native_session_id=?`)
          .get(...parameters) as { count: number };
        const revisions = rows.map(metadata);
        const latest = revisions[0] ?? null;
        const settled = latest ? 'available' : 'not-analyzed';
        const state = job && job.state !== 'published' ? job.state : settled;
        return {
          state,
          latest,
          revisions,
          revisionsOmitted: Math.max(0, count.count - revisions.length),
          job: job === null ? null : jobView(job),
          sourceStatus: 'unchecked',
        };
      }),
    search: (projectId, query, limit) =>
      operation(() => {
        distillationInteger(limit, 1, distillationBounds.searchResults);
        const match = safeSearchQuery(query);
        const count = database
          .query(`SELECT COUNT(*) AS count FROM session_analyses_fts
        WHERE project_id=? AND session_analyses_fts MATCH ?`)
          .get(projectId, match) as { count: number };
        const rows = database
          .query(`SELECT a.id, a.project_id, a.machine_id, a.native_session_id, a.packet_digest, a.revision, a.created_at,
            a.summary, a.coverage_status, a.episode_ids_json FROM session_analyses_fts f JOIN session_analyses a ON a.id=f.analysis_id
        WHERE f.project_id=? AND session_analyses_fts MATCH ? ORDER BY bm25(session_analyses_fts), a.created_at DESC, a.id LIMIT ?`)
          .all(projectId, match, limit) as Omit<AnalysisRow, 'analysis_json'>[];
        const items: DistillationSearchHit[] = rows.map((row) => ({
          ...metadata(row),
          summary: row.summary,
          coverage: row.coverage_status,
          episodeIds: JSON.parse(row.episode_ids_json) as string[],
        }));
        return { corpus: 'session-analyses', items, omitted: Math.max(0, count.count - items.length) };
      }),
    isProducerSession: (machineId, nativeSessionId) =>
      operation(() =>
        Boolean(
          database
            .query('SELECT id FROM distillation_jobs WHERE machine_id=? AND producer_session_id=? LIMIT 1')
            .get(machineId, nativeSessionId),
        ),
      ),
    cleanup: (projectId, before) =>
      transaction(() => {
        if (!Number.isFinite(Date.parse(before))) {
          throw new DistillationError('invalid-date');
        }
        const result = database
          .query(`UPDATE distillation_jobs SET packet_json=NULL WHERE project_id=?
        AND state IN ('published','failed','cancelled') AND updated_at<? AND packet_json IS NOT NULL`)
          .run(projectId, new Date(before).toISOString());
        return { removedPackets: result.changes };
      }),
  };
  return repository;
};
