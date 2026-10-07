import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { redactDistillationText } from '@ai-usage/memory-service/distillation-redaction';
import type {
  DistillationRemovalPreview,
  DistillationRepository,
  DistillationSourceGrant,
} from '@ai-usage/memory-service/distillation-repository';
import {
  type DistillationEvidenceEvent,
  type DistillationEvidencePacket,
  distillationEvidenceDigestInput,
  parseDistillationEvidencePacket,
} from '@ai-usage/platform-core/distillation-evidence';
import {
  type AnalysisRevisionMetadata,
  analysisAssertions,
  DISTILLATION_EXTRACTOR_VERSION,
  DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION,
  DISTILLATION_SCHEMA_VERSION,
  DistillationError,
  type DistillationExtractorVersion,
  type DistillationJobView,
  distillationBounds,
  distillationText,
  parseDistillationProgress,
  parseSessionAnalysis,
  parseSessionAnalysisContent,
  type SessionAnalysis,
  type SessionAnalysisContent,
  validateAnalysisEvidence,
} from '@ai-usage/platform-core/session-distillation';
import { createDistillationCatalog } from './distillation-catalog';
import { distillationProgressColumns, distillationProgressFields } from './distillation-progress';

interface ProgressRow {
  checkpoint_json: string | null;
  segment_index: number;
  source_digest: string;
  stage: 'segment' | 'consolidation';
}

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
const manifest = (packet: DistillationEvidencePacket): string =>
  JSON.stringify({
    packetDigest: packet.packetDigest,
    source: packet.source,
    window: packet.window,
    eventIds: packet.events.map((event) => event.id),
  });
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

const supportedExtractorVersion = (job: JobRow): DistillationExtractorVersion => {
  if (
    job.extractor_version !== DISTILLATION_EXTRACTOR_VERSION &&
    job.extractor_version !== DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION
  ) {
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
  const progress = (jobId: string): ProgressRow | null =>
    database.query('SELECT * FROM distillation_progress WHERE job_id=?').get(jobId) as ProgressRow | null;
  const view = (job: JobViewRow): DistillationJobView => {
    const current = database
      .query(
        `SELECT ${distillationProgressColumns('progress.job_id')} FROM distillation_progress progress WHERE progress.job_id=?`,
      )
      .get(job.id) as Record<string, unknown> | null;
    return {
      ...jobView(job),
      ...(current ? { progress: parseDistillationProgress(distillationProgressFields(current)) } : {}),
    };
  };
  const evidenceForContent = (job: JobRow, value: SessionAnalysisContent): DistillationEvidenceEvent[] => {
    const ids = [
      ...new Set(analysisAssertions(value).flatMap((assertion) => assertion.evidence.map((ref) => ref.eventId))),
    ];
    const events: DistillationEvidenceEvent[] = [];
    for (const id of ids) {
      const row = database
        .query(
          `SELECT event.value AS event_json FROM distillation_segments segment, json_each(segment.packet_json, '$.events') event WHERE segment.job_id=? AND json_extract(event.value,'$.id')=? LIMIT 1`,
        )
        .get(job.id, id) as { event_json: string } | null;
      if (!row) {
        throw new DistillationError('invalid-evidence-reference');
      }
      events.push(JSON.parse(row.event_json) as DistillationEvidenceEvent);
    }
    return events;
  };
  const progressiveContent = (job: JobRow, value: SessionAnalysisContent): SessionAnalysisContent => {
    const content = parseSessionAnalysisContent(value);
    const events = evidenceForContent(job, content);
    validateAnalysisEvidence(content, events);
    const redacted = parseSessionAnalysisContent(
      JSON.parse(
        JSON.stringify(content, (_key, item: unknown) =>
          typeof item === 'string' ? redactDistillationText(item) : item,
        ),
      ),
    );
    validateAnalysisEvidence(redacted, events);
    return redacted;
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
  const removalPreview = (projectId: string, analysisId: string): DistillationRemovalPreview => {
    const row = database
      .query('SELECT machine_id,native_session_id FROM session_analyses WHERE project_id=? AND id=?')
      .get(projectId, analysisId) as { machine_id: string; native_session_id: string } | null;
    if (!row) {
      const receipt = database
        .query(
          "SELECT w.receipt_json FROM distillation_withdrawals w,json_each(w.receipt_json,'$.analysisIds') id WHERE w.project_id=? AND id.value=? LIMIT 1",
        )
        .get(projectId, analysisId) as { receipt_json: string } | null;
      if (!receipt) {
        throw new DistillationError('analysis-not-found');
      }
      return JSON.parse(receipt.receipt_json) as DistillationRemovalPreview;
    }
    const ids = database
      .query(
        'SELECT id FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=? ORDER BY revision LIMIT 100',
      )
      .all(projectId, row.machine_id, row.native_session_id) as { id: string }[];
    if (!ids.some((entry) => entry.id === analysisId)) {
      ids[ids.length - 1] = { id: analysisId };
    }
    const analysisCount = database
      .query(
        'SELECT COUNT(*) AS count FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=?',
      )
      .get(projectId, row.machine_id, row.native_session_id) as { count: number };
    const dependencies = database
      .query(
        'SELECT p.proposal_id AS proposalId,proposal.accepted_memory_item_id AS acceptedItemId FROM memory_analysis_promotions p JOIN memory_proposals proposal ON proposal.id=p.proposal_id JOIN session_analyses a ON a.id=p.analysis_id WHERE a.project_id=? AND a.machine_id=? AND a.native_session_id=? ORDER BY p.proposal_id LIMIT 100',
      )
      .all(projectId, row.machine_id, row.native_session_id) as DistillationRemovalPreview['dependencies'];
    const dependencyCount = database
      .query(
        'SELECT COUNT(*) AS count FROM memory_analysis_promotions p JOIN memory_proposals proposal ON proposal.id=p.proposal_id JOIN session_analyses a ON a.id=p.analysis_id WHERE a.project_id=? AND a.machine_id=? AND a.native_session_id=?',
      )
      .get(projectId, row.machine_id, row.native_session_id) as { count: number };
    return {
      analysisIds: ids.map((entry) => entry.id),
      analysisCount: analysisCount.count,
      analysesOmitted: Math.max(0, analysisCount.count - ids.length),
      dependencies,
      dependencyCount: dependencyCount.count,
      dependenciesOmitted: Math.max(0, dependencyCount.count - dependencies.length),
      retainsKnowledge: true,
    };
  };

  const repository: DistillationRepository = {
    segment: (projectId, jobId, snapshotDigest, segmentIndex) =>
      operation(() => {
        const job = readJob(projectId, jobId);
        const current = progress(job.id);
        if (job.state === 'cancelled') {
          throw new DistillationError('job-cancelled');
        }
        if (!current || current.source_digest !== snapshotDigest) {
          throw new DistillationError('snapshot-version-mismatch');
        }
        const row = database
          .query('SELECT packet_json,content_json FROM distillation_segments WHERE job_id=? AND segment_index=?')
          .get(jobId, segmentIndex) as { packet_json: string | null; content_json: string | null } | null;
        if (!row?.packet_json) {
          throw new DistillationError('packet-unavailable');
        }
        return {
          packet: parsePacket(JSON.parse(row.packet_json)),
          checkpoint: row.content_json === null ? null : parseSessionAnalysisContent(JSON.parse(row.content_json)),
          historical: true,
        };
      }),
    prepare: (input) =>
      transaction(() => {
        const packet = parsePacket(input.packet);
        const withdrawal = database
          .query('SELECT 1 FROM distillation_withdrawals WHERE project_id=? AND machine_id=? AND native_session_id=?')
          .get(packet.source.projectId, packet.source.machineId, packet.source.nativeSessionId);
        if (withdrawal && input.revisionKey === null) {
          throw new DistillationError('analysis-withdrawn');
        }
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
            packet.window ? DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION : DISTILLATION_EXTRACTOR_VERSION,
            input.revisionKey,
          ]),
        );
        const existing = database
          .query('SELECT * FROM distillation_jobs WHERE dedupe_key=?')
          .get(dedupe) as JobRow | null;
        if (existing) {
          return view(existing);
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
            packet.window ? DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION : DISTILLATION_EXTRACTOR_VERSION,
            JSON.stringify(packet),
            JSON.stringify(input.grant),
            input.producerSessionId,
            now(),
            now(),
          );
        if (packet.window) {
          database
            .query('INSERT INTO distillation_progress(job_id,segment_index,stage,source_digest) VALUES (?,0,?,?)')
            .run(id, packet.window.nextLine === null ? 'consolidation' : 'segment', packet.source.version.digest);
          database
            .query('INSERT INTO distillation_segments(job_id,segment_index,packet_json,manifest_json) VALUES (?,0,?,?)')
            .run(id, JSON.stringify(packet), manifest(packet));
        }
        return view(readJob(packet.source.projectId, id));
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
          job: view(readJob(projectId, jobId)),
          ...(progress(jobId)
            ? {
                checkpoint: progress(jobId)?.checkpoint_json
                  ? parseSessionAnalysisContent(JSON.parse(progress(jobId)?.checkpoint_json ?? 'null'))
                  : null,
              }
            : {}),
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
        return view(readJob(projectId, jobId));
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
        return view(readJob(projectId, jobId));
      }),
    getJobPacket: (projectId, jobId) =>
      operation(() => {
        const job = readJob(projectId, jobId);
        if (!job.packet_json) {
          throw new DistillationError('packet-unavailable');
        }
        return {
          packet: parsePacket(JSON.parse(job.packet_json)),
          grant: JSON.parse(job.grant_json) as DistillationSourceGrant,
        };
      }),
    advance: (input) =>
      transaction(() => {
        const job = readJob(input.projectId, input.jobId);
        const current = progress(job.id);
        supportedExtractorVersion(job);
        if (input.extractorVersion !== job.extractor_version) {
          throw new DistillationError('extractor-version-mismatch');
        }
        if (!current || input.snapshotDigest !== current.source_digest || input.segmentIndex === undefined) {
          throw new DistillationError('snapshot-version-mismatch');
        }
        const submitted = database
          .query(
            "SELECT content_digest,lease_id,json_extract(manifest_json,'$.packetDigest') AS packet_digest FROM distillation_segments WHERE job_id=? AND segment_index=?",
          )
          .get(job.id, input.segmentIndex) as {
          content_digest: string | null;
          lease_id: string | null;
          packet_digest: string;
        } | null;
        const contentDigest = hash(JSON.stringify(parseSessionAnalysisContent(input.content)));
        if (submitted?.content_digest && submitted.lease_id === input.leaseId && job.state !== 'cancelled') {
          if (submitted.packet_digest !== input.packetDigest) {
            throw new DistillationError('stale-worker');
          }
          if (submitted.content_digest !== contentDigest) {
            throw new DistillationError('submission-conflict');
          }
          return view(job);
        }
        if (
          current.stage !== 'segment' ||
          current.segment_index !== input.segmentIndex ||
          job.state !== 'running' ||
          job.lease_id !== input.leaseId ||
          job.packet_digest !== input.packetDigest ||
          !job.lease_expires_at ||
          job.lease_expires_at <= now()
        ) {
          throw new DistillationError('stale-worker');
        }
        if (!job.packet_json) {
          throw new DistillationError('packet-unavailable');
        }
        const packet = parsePacket(JSON.parse(job.packet_json));
        const content = progressiveContent(job, input.content);
        const next = input.nextPacket === null ? null : parsePacket(input.nextPacket);
        if (!packet.window || (packet.window.nextLine === null) !== (next === null)) {
          throw new DistillationError('segment-boundary-mismatch');
        }
        if (
          next &&
          (!next.window ||
            next.window.index !== current.segment_index + 1 ||
            next.window.startLine !== packet.window.nextLine ||
            next.source.version.digest !== current.source_digest ||
            JSON.stringify(next.source) !== JSON.stringify(packet.source))
        ) {
          throw new DistillationError('snapshot-version-mismatch');
        }
        database
          .query(
            'UPDATE distillation_segments SET content_json=?,content_digest=?,lease_id=? WHERE job_id=? AND segment_index=?',
          )
          .run(JSON.stringify(content), contentDigest, input.leaseId, job.id, current.segment_index);
        if (next) {
          database
            .query('INSERT INTO distillation_segments(job_id,segment_index,packet_json,manifest_json) VALUES (?,?,?,?)')
            .run(job.id, current.segment_index + 1, JSON.stringify(next), manifest(next));
        }
        database
          .query('UPDATE distillation_progress SET segment_index=?,stage=?,checkpoint_json=? WHERE job_id=?')
          .run(
            current.segment_index + (next ? 1 : 0),
            next ? 'segment' : 'consolidation',
            JSON.stringify(content),
            job.id,
          );
        database
          .query(
            "UPDATE distillation_jobs SET state='queued',attempt=0,lease_id=NULL,lease_expires_at=NULL,packet_json=?,packet_digest=?,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(next ?? packet), (next ?? packet).packetDigest, now(), job.id);
        return view(readJob(input.projectId, job.id));
      }),
    submit: (input) =>
      transaction(() => {
        const job = readJob(input.projectId, input.jobId);
        const extractorVersion = supportedExtractorVersion(job);
        if (
          job.extractor_version === DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION &&
          input.extractorVersion !== extractorVersion
        ) {
          throw new DistillationError('extractor-version-mismatch');
        }
        const current = progress(job.id);
        if (
          current &&
          (current.stage !== 'consolidation' ||
            input.snapshotDigest !== current.source_digest ||
            input.segmentIndex !== current.segment_index)
        ) {
          throw new DistillationError('consolidation-required');
        }
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
        const content = current ? progressiveContent(job, input.content) : redactedContent(input.content, packet);
        if (current) {
          const count = database
            .query(
              `SELECT COALESCE(SUM(json_extract(packet_json,'$.coverage.includedEvents') - json_array_length(packet_json,'$.window.overlapEventIds')),0) AS count FROM distillation_segments WHERE job_id=?`,
            )
            .get(job.id) as { count: number };
          packet.coverage.includedEvents = count.count;
        }
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
        database
          .query('DELETE FROM distillation_withdrawals WHERE project_id=? AND machine_id=? AND native_session_id=?')
          .run(job.project_id, job.machine_id, job.native_session_id);
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
        const withdrawn = database
          .query('SELECT 1 FROM distillation_withdrawals WHERE project_id=? AND machine_id=? AND native_session_id=?')
          .get(...parameters);
        const latest = withdrawn ? null : (revisions[0] ?? null);
        const settled = latest ? 'available' : 'not-analyzed';
        const state = job && job.state !== 'published' ? job.state : settled;
        return {
          state,
          latest,
          revisions,
          revisionsOmitted: Math.max(0, count.count - revisions.length),
          job: job === null ? null : view(job),
          sourceStatus: 'unchecked',
        };
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
        database
          .query(
            "UPDATE distillation_segments SET packet_json=NULL,content_json=NULL WHERE job_id IN (SELECT id FROM distillation_jobs WHERE project_id=? AND state IN ('published','failed','cancelled') AND updated_at<?)",
          )
          .run(projectId, new Date(before).toISOString());
        database
          .query(
            "UPDATE distillation_progress SET checkpoint_json=NULL WHERE job_id IN (SELECT id FROM distillation_jobs WHERE project_id=? AND state IN ('published','failed','cancelled') AND updated_at<?)",
          )
          .run(projectId, new Date(before).toISOString());
        return { removedPackets: result.changes };
      }),
    getEvidencePackets: (projectId, analysisId, eventIds) =>
      operation(() => {
        const row = database
          .query('SELECT job_id FROM session_analyses WHERE project_id=? AND id=?')
          .get(projectId, analysisId) as { job_id: string } | null;
        if (!row) {
          throw new DistillationError('analysis-not-found');
        }
        const packets = new Map<
          string,
          { packet: Pick<DistillationEvidencePacket, 'packetDigest' | 'source' | 'window'>; eventIds: string[] }
        >();
        for (const id of eventIds) {
          const source = database
            .query(
              `SELECT segment.manifest_json FROM distillation_segments segment, json_each(segment.manifest_json,'$.eventIds') event WHERE segment.job_id=? AND event.value=? ORDER BY segment.segment_index LIMIT 1`,
            )
            .get(row.job_id, id) as { manifest_json: string } | null;
          if (!source) {
            throw new DistillationError('invalid-evidence-reference');
          }
          const { eventIds: _eventIds, ...packet } = JSON.parse(source.manifest_json) as Pick<
            DistillationEvidencePacket,
            'packetDigest' | 'source' | 'window'
          > & { eventIds: string[] };
          const entry = packets.get(packet.packetDigest) ?? { packet, eventIds: [] };
          entry.eventIds.push(id);
          packets.set(packet.packetDigest, entry);
        }
        return [...packets.values()];
      }),
    removalPreview: (projectId, analysisId) => operation(() => removalPreview(projectId, analysisId)),
    remove: (projectId, analysisId, mode) =>
      transaction(() => {
        const preview = removalPreview(projectId, analysisId);
        const row = database
          .query('SELECT machine_id,native_session_id FROM session_analyses WHERE project_id=? AND id=?')
          .get(projectId, analysisId) as { machine_id: string; native_session_id: string } | null;
        if (!row) {
          return { ...preview, mode, removedAnalyses: 0, nativeHistoryUntouched: true };
        }
        const scope = [projectId, row.machine_id, row.native_session_id];
        database
          .query(
            'INSERT INTO distillation_withdrawals(project_id,machine_id,native_session_id,withdrawn_at,receipt_json) VALUES (?,?,?,?,?) ON CONFLICT(project_id,machine_id,native_session_id) DO UPDATE SET withdrawn_at=excluded.withdrawn_at,receipt_json=excluded.receipt_json',
          )
          .run(...scope, now(), JSON.stringify(preview));
        database
          .query(
            'DELETE FROM session_analyses_fts WHERE analysis_id IN (SELECT id FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=?)',
          )
          .run(...scope);
        database
          .query(
            "UPDATE distillation_jobs SET state='cancelled',lease_id=NULL,lease_expires_at=NULL,error_code='analysis-withdrawn',updated_at=? WHERE project_id=? AND machine_id=? AND native_session_id=? AND state<>'published'",
          )
          .run(now(), ...scope);
        let removedAnalyses = 0;
        if (mode === 'purge') {
          removedAnalyses = database
            .query('DELETE FROM session_analyses WHERE project_id=? AND machine_id=? AND native_session_id=?')
            .run(...scope).changes;
          database
            .query(
              'DELETE FROM distillation_segments WHERE job_id IN (SELECT id FROM distillation_jobs WHERE project_id=? AND machine_id=? AND native_session_id=?)',
            )
            .run(...scope);
          database
            .query(
              'DELETE FROM distillation_progress WHERE job_id IN (SELECT id FROM distillation_jobs WHERE project_id=? AND machine_id=? AND native_session_id=?)',
            )
            .run(...scope);
          database
            .query(
              "UPDATE distillation_jobs SET state='cancelled',lease_id=NULL,lease_expires_at=NULL,error_code='analysis-purged',packet_json=NULL,grant_json='{}',analysis_id=NULL,content_digest=NULL,updated_at=? WHERE project_id=? AND machine_id=? AND native_session_id=?",
            )
            .run(now(), ...scope);
        }
        return { ...preview, mode, removedAnalyses, nativeHistoryUntouched: true };
      }),
    ...createDistillationCatalog(database),
  };
  return repository;
};
