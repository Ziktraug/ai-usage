import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DistillationSourceGrant } from '@ai-usage/memory-service/distillation-repository';
import {
  type DistillationEvidencePacket,
  distillationEvidenceDigestInput,
} from '@ai-usage/platform-core/distillation-evidence';
import {
  createCaptureContextId,
  createDeviceId,
  createPersonId,
  createProjectId,
  createSpaceId,
} from '@ai-usage/platform-core/identity';
import { distillationBounds, type SessionAnalysisContent } from '@ai-usage/platform-core/session-distillation';
import { createSqliteDistillationRepository } from './distillation';
import { type LocalIdentityKernel, openLocalIdentityKernel } from './identity';
import { localDistillationSchema } from './schema';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const content = (summary = 'The ENOENT investigation remains unresolved.'): SessionAnalysisContent => ({
  schemaVersion: 1,
  summary: { text: summary, basis: 'inferred', evidence: [{ eventId: 'result-one', quote: 'ENOENT src/cache.ts' }] },
  episodes: [
    {
      id: 'cache',
      objective: {
        text: 'Investigate the cache failure.',
        basis: 'reported',
        evidence: [{ eventId: 'user-one', quote: 'Find the cache failure' }],
      },
      attempts: [
        { text: 'The focused test failed.', basis: 'observed', evidence: [{ eventId: 'result-one', quote: '1 fail' }] },
      ],
      result: {
        status: 'unresolved',
        assertion: { text: 'The cause remains unknown.', basis: 'unknown', evidence: [] },
      },
      decisions: [],
      difficulties: [],
      entryPoints: [
        { text: 'src/cache.ts', basis: 'observed', evidence: [{ eventId: 'result-one', quote: 'src/cache.ts' }] },
      ],
      openQuestions: [],
    },
  ],
  abstention: null,
});
const packetFor = (projectId: string, nativeSessionId = 'source-one'): DistillationEvidencePacket => {
  const packet: DistillationEvidencePacket = {
    schemaVersion: 1,
    normalizationVersion: 1,
    redactionVersion: 1,
    packetDigest: '',
    source: {
      harnessKey: 'codex',
      machineId: 'machine-one',
      projectId,
      nativeSessionId,
      reportAnchor: { revision: 'report-one', rowId: nativeSessionId },
      version: { digest: digest(nativeSessionId), bytes: 1000, totalBytes: 1000, modifiedAtMs: 1 },
    },
    events: [
      {
        id: 'user-one',
        line: 1,
        kind: 'user',
        text: 'Find the cache failure',
        timestamp: null,
        nativeTurnId: 'turn-one',
        roundId: 'prompt:prompt-1',
        toolName: null,
        callId: null,
        truncated: false,
        redacted: false,
      },
      {
        id: 'result-one',
        line: 2,
        kind: 'tool-result',
        text: '1 fail\nENOENT src/cache.ts',
        timestamp: null,
        nativeTurnId: 'turn-one',
        roundId: 'prompt:prompt-1',
        toolName: null,
        callId: 'call-one',
        truncated: false,
        redacted: false,
      },
    ],
    coverage: {
      scope: 'session-only',
      completion: 'completed',
      status: 'complete',
      lines: 2,
      includedEvents: 2,
      exclusions: [],
      childDiscovery: 'not-performed',
      childrenNotAnalyzed: null,
    },
  };
  packet.packetDigest = digest(distillationEvidenceDigestInput(packet));
  return packet;
};
const grantFor = (packet: DistillationEvidencePacket): DistillationSourceGrant => ({
  projectId: packet.source.projectId,
  machineId: packet.source.machineId,
  nativeSessionId: packet.source.nativeSessionId,
  projectSourceId: `${packet.source.machineId}|/synthetic/project`,
  checkoutPath: '/synthetic/project',
  selection: { revision: 'report-one', rowId: packet.source.nativeSessionId },
});
const fixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'distillation-sqlite-'));
  const databasePath = path.join(directory, 'memory.sqlite');
  let milliseconds = Date.parse('2026-10-04T12:00:00.000Z');
  const clock = () => new Date(milliseconds);
  let kernel: LocalIdentityKernel = await openLocalIdentityKernel({ databasePath, clock });
  const identity = await kernel.getBootstrapIdentity();
  const projectId = createProjectId();
  const otherProjectId = createProjectId();
  for (const id of [projectId, otherProjectId]) {
    await kernel.createProject({
      id,
      displayName: 'Synthetic project',
      kind: 'local',
      owningSpaceId: identity.space.id,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    });
  }
  const packet = packetFor(projectId);
  const input = { packet, grant: grantFor(packet), producerSessionId: 'producer-one', revisionKey: null };
  const read = <T>(run: (database: Database) => T): T => {
    const database = new Database(databasePath, { readonly: true, strict: true });
    try {
      return run(database);
    } finally {
      database.close();
    }
  };
  const prepare = (revisionKey: string | null = null) => kernel.distillation.prepare({ ...input, revisionKey });
  const publish = async (revisionKey: string | null = null, value = content()) => {
    const job = await prepare(revisionKey);
    const lease = await kernel.distillation.claim(projectId, job.id);
    const submission = {
      projectId,
      jobId: job.id,
      leaseId: lease.leaseId,
      packetDigest: packet.packetDigest,
      content: value,
    };
    return { analysis: await kernel.distillation.submit(submission), submission, lease, job };
  };
  closers.push(async () => {
    await kernel.close();
    await rm(directory, { force: true, recursive: true });
  });
  return {
    get kernel() {
      return kernel;
    },
    projectId,
    otherProjectId,
    packet,
    input,
    identity,
    read,
    prepare,
    publish,
    advance: (duration: number) => {
      milliseconds += duration;
    },
    reopen: async () => {
      await kernel.close();
      kernel = await openLocalIdentityKernel({ databasePath, clock });
    },
    modifyClosedFixture: async (sql: string) => {
      await kernel.close();
      const database = new Database(databasePath, { strict: true });
      try {
        database.exec(sql);
      } finally {
        database.close();
      }
      kernel = await openLocalIdentityKernel({ databasePath, clock });
    },
  };
};

describe('local-only session distillation persistence', () => {
  test.each([
    'claim',
    'retry',
    'submit',
  ] as const)('rejects %s for an incompatible stored extractor without changing the job or publishing', async (transition) => {
    const database = new Database(':memory:', { strict: true });
    try {
      database.exec(
        "PRAGMA foreign_keys=ON; CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project-one');",
      );
      database.exec(localDistillationSchema);
      let milliseconds = Date.parse('2026-10-04T12:00:00.000Z');
      const repository = createSqliteDistillationRepository(database, () => new Date(milliseconds));
      const packet = packetFor('project-one');
      const grant = grantFor(packet);
      const job = await repository.prepare({ packet, grant, revisionKey: null, producerSessionId: null });
      const lease = transition === 'claim' ? null : await repository.claim('project-one', job.id);
      if (transition === 'retry') {
        milliseconds += distillationBounds.leaseMs + 1;
        await repository.status(grant);
      }
      database
        .query('UPDATE distillation_jobs SET extractor_version=? WHERE id=?')
        .run('unsupported-extractor', job.id);
      const before = database.query('SELECT * FROM distillation_jobs WHERE id=?').get(job.id);
      const submit = () =>
        repository.submit({
          projectId: 'project-one',
          jobId: job.id,
          leaseId: lease?.leaseId ?? 'no-lease',
          packetDigest: packet.packetDigest,
          content: content(),
        });
      const result = transition === 'submit' ? submit() : repository[transition]('project-one', job.id);
      await expect(result).rejects.toMatchObject({ code: 'extractor-version-mismatch' });
      expect(database.query('SELECT * FROM distillation_jobs WHERE id=?').get(job.id)).toEqual(before);
      expect(database.query('SELECT COUNT(*) AS count FROM session_analyses').get()).toEqual({ count: 0 });
      expect(database.query('SELECT COUNT(*) AS count FROM session_analyses_fts').get()).toEqual({ count: 0 });
      if (transition === 'submit') {
        milliseconds += distillationBounds.leaseMs + 1;
        await expect(submit()).rejects.toMatchObject({ code: 'extractor-version-mismatch' });
        expect(database.query('SELECT * FROM distillation_jobs WHERE id=?').get(job.id)).toMatchObject({
          state: 'failed',
          error_code: 'lease-expired',
          extractor_version: 'unsupported-extractor',
          lease_id: null,
          lease_expires_at: null,
        });
      }
    } finally {
      database.close();
    }
  });

  test('prepares idempotently, publishes once, persists exact revisions and searches independently after restart', async () => {
    const f = await fixture();
    expect(await f.prepare()).toEqual(await f.prepare());
    const { analysis, submission } = await f.publish();
    expect(await f.kernel.distillation.submit(submission)).toEqual(analysis);
    await expect(
      f.kernel.distillation.submit({ ...submission, content: content('Different interpretation') }),
    ).rejects.toMatchObject({ code: 'submission-conflict' });
    await f.reopen();
    expect(await f.kernel.distillation.get(f.projectId, analysis.id)).toEqual(analysis);
    expect(await f.kernel.distillation.submit(submission)).toEqual(analysis);
    const found = await f.kernel.distillation.search(f.projectId, 'ENOENT', 5);
    expect(found.corpus).toBe('session-analyses');
    expect(found.items.map((item) => item.id)).toEqual([analysis.id]);
    expect(found.items[0]?.episodeIds).toEqual(['cache']);
    expect((await f.kernel.distillation.status(f.input.grant)).latest?.id).toBe(analysis.id);
    expect(analysis.producer).toEqual({
      kind: 'active-harness',
      sessionId: 'producer-one',
      attribution: 'worker-declared',
    });
    expect(await f.kernel.distillation.isProducerSession('machine-one', 'producer-one')).toBe(true);
    expect(await f.kernel.distillation.isProducerSession('machine-two', 'producer-one')).toBe(false);
  });

  test('separates Project reads, search, jobs and source grants', async () => {
    const f = await fixture();
    const { analysis, job } = await f.publish();
    await expect(f.kernel.distillation.get(f.otherProjectId, analysis.id)).rejects.toMatchObject({
      code: 'analysis-not-found',
    });
    await expect(f.kernel.distillation.getGrant(f.otherProjectId, analysis.id)).rejects.toMatchObject({
      code: 'analysis-not-found',
    });
    await expect(f.kernel.distillation.cancel(f.otherProjectId, job.id)).rejects.toMatchObject({
      code: 'job-not-found',
    });
    expect((await f.kernel.distillation.search(f.otherProjectId, 'ENOENT', 5)).items).toEqual([]);
    await expect(
      f.kernel.distillation.prepare({ ...f.input, grant: { ...f.input.grant, projectId: f.otherProjectId } }),
    ).rejects.toMatchObject({ code: 'source-grant-mismatch' });
    await expect(
      f.kernel.distillation.prepare({ ...f.input, packet: { ...f.packet, packetDigest: 'f'.repeat(64) } }),
    ).rejects.toMatchObject({ code: 'packet-digest-mismatch' });
  });

  test('a report publication or mtime-only change reuses the original snapshot job unless explicitly revised', async () => {
    const f = await fixture();
    const original = await f.prepare();
    const packet = structuredClone(f.packet);
    packet.source.reportAnchor = { revision: 'later-report', rowId: 'new-projection-row' };
    packet.source.version.modifiedAtMs = 10;
    packet.packetDigest = digest(distillationEvidenceDigestInput(packet));
    const grant = { ...f.input.grant, selection: packet.source.reportAnchor };
    const repeated = await f.kernel.distillation.prepare({ ...f.input, packet, grant });
    expect(repeated.id).toBe(original.id);
    const lease = await f.kernel.distillation.claim(f.projectId, repeated.id);
    expect(lease.packet).toEqual(f.packet);
    const explicit = await f.kernel.distillation.prepare({
      ...f.input,
      packet,
      grant,
      revisionKey: 'explicit-new-interpretation',
    });
    expect(explicit.id).not.toBe(original.id);
  });

  test('one active lease covers the whole local service and cancellation refuses late publication', async () => {
    const f = await fixture();
    const first = await f.prepare();
    const firstLease = await f.kernel.distillation.claim(f.projectId, first.id);
    const otherPacket = packetFor(f.otherProjectId);
    const second = await f.kernel.distillation.prepare({
      ...f.input,
      packet: otherPacket,
      grant: grantFor(otherPacket),
    });
    await expect(f.kernel.distillation.claim(f.otherProjectId, second.id)).rejects.toMatchObject({
      code: 'worker-busy',
    });
    expect((await f.kernel.distillation.cancel(f.projectId, first.id)).state).toBe('cancelled');
    await expect(
      f.kernel.distillation.submit({
        projectId: f.projectId,
        jobId: first.id,
        leaseId: firstLease.leaseId,
        packetDigest: f.packet.packetDigest,
        content: content(),
      }),
    ).rejects.toMatchObject({ code: 'stale-worker' });
    await expect(f.kernel.distillation.retry(f.projectId, first.id)).rejects.toMatchObject({
      code: 'job-not-retryable',
    });
    expect((await f.kernel.distillation.claim(f.otherProjectId, second.id)).job.state).toBe('running');
  });

  test('expires leases, bounds retries and rejects every prior lease', async () => {
    const f = await fixture();
    const job = await f.prepare();
    let expiredLease = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await f.kernel.distillation.claim(f.projectId, job.id);
      expect(lease.job.attempt).toBe(attempt);
      if (expiredLease) {
        await expect(
          f.kernel.distillation.submit({
            projectId: f.projectId,
            jobId: job.id,
            leaseId: expiredLease,
            packetDigest: f.packet.packetDigest,
            content: content(),
          }),
        ).rejects.toMatchObject({ code: 'stale-worker' });
      }
      expiredLease = lease.leaseId;
      f.advance(distillationBounds.leaseMs + 1);
      expect((await f.kernel.distillation.status(f.input.grant)).job).toMatchObject({
        state: 'failed',
        errorCode: 'lease-expired',
      });
      if (attempt < 3) {
        await f.kernel.distillation.retry(f.projectId, job.id);
      }
    }
    await expect(f.kernel.distillation.retry(f.projectId, job.id)).rejects.toMatchObject({ code: 'attempt-limit' });
  });

  test('recovers an in-flight job after process restart and requires an explicit retry', async () => {
    const f = await fixture();
    const job = await f.prepare();
    const lease = await f.kernel.distillation.claim(f.projectId, job.id);
    await f.reopen();
    expect((await f.kernel.distillation.status(f.input.grant)).job).toMatchObject({
      state: 'failed',
      errorCode: 'worker-recovered',
    });
    await expect(
      f.kernel.distillation.submit({
        projectId: f.projectId,
        jobId: job.id,
        leaseId: lease.leaseId,
        packetDigest: f.packet.packetDigest,
        content: content(),
      }),
    ).rejects.toMatchObject({ code: 'stale-worker' });
    await f.kernel.distillation.retry(f.projectId, job.id);
    expect((await f.kernel.distillation.claim(f.projectId, job.id)).leaseId).not.toBe(lease.leaseId);
  });

  test('validates evidence tiers and exact quotes before persistence and masks output secrets', async () => {
    const f = await fixture();
    const job = await f.prepare();
    const lease = await f.kernel.distillation.claim(f.projectId, job.id);
    const submit = (value: SessionAnalysisContent) =>
      f.kernel.distillation.submit({
        projectId: f.projectId,
        jobId: job.id,
        leaseId: lease.leaseId,
        packetDigest: f.packet.packetDigest,
        content: value,
      });
    const invalid = content();
    invalid.summary = {
      basis: 'observed',
      text: 'All tests passed.',
      evidence: [{ eventId: 'user-one', quote: 'Find the cache failure' }],
    };
    await expect(submit(invalid)).rejects.toMatchObject({ code: 'observation-requires-tool-result' });
    const forged = content();
    forged.summary.evidence = [{ eventId: 'result-one', quote: 'all tests passed' }];
    await expect(submit(forged)).rejects.toMatchObject({ code: 'invalid-evidence-reference' });
    const analysis = await submit(content('Historical token=synthetic-secret-value must not persist.'));
    expect(JSON.stringify(analysis)).not.toContain('synthetic-secret-value');
    expect(analysis.content.summary.text).toContain('[REDACTED]');
    expect(JSON.stringify(f.read((db) => db.query('SELECT analysis_json FROM session_analyses').all()))).not.toContain(
      'synthetic-secret-value',
    );
    await expect(submit(content('Historical token=different-secret-value must not persist.'))).rejects.toMatchObject({
      code: 'submission-conflict',
    });
  });

  test('preserves the old analysis when regeneration fails and creates explicit immutable revisions', async () => {
    const f = await fixture();
    const first = await f.publish(null, content('Obsoleteword investigation.'));
    const failedJob = await f.prepare('regeneration-one');
    await f.kernel.distillation.claim(f.projectId, failedJob.id);
    f.advance(distillationBounds.leaseMs + 1);
    const failedStatus = await f.kernel.distillation.status(f.input.grant);
    expect(failedStatus.state).toBe('failed');
    expect(failedStatus.latest?.id).toBe(first.analysis.id);
    const second = await f.publish('regeneration-two', content('Replacementword investigation.'));
    expect(second.analysis.revision).toBe(2);
    expect((await f.kernel.distillation.get(f.projectId, first.analysis.id)).content.summary.text).toBe(
      'Obsoleteword investigation.',
    );
    expect((await f.kernel.distillation.search(f.projectId, 'Obsoleteword', 10)).items).toEqual([]);
    expect(
      (await f.kernel.distillation.search(f.projectId, 'Replacementword', 10)).items.map((item) => item.id),
    ).toEqual([second.analysis.id]);
    await expect(f.kernel.distillation.retry(f.projectId, second.job.id)).rejects.toMatchObject({
      code: 'job-not-retryable',
    });
  });

  test('cleanup deletes only terminal packets and retains exact analyses and locator grants', async () => {
    const f = await fixture();
    const published = await f.publish();
    const queued = await f.prepare('queued-later');
    f.advance(10);
    expect(await f.kernel.distillation.cleanup(f.projectId, '2026-10-05T00:00:00Z')).toEqual({ removedPackets: 1 });
    expect(await f.kernel.distillation.getGrant(f.projectId, published.analysis.id)).toEqual(f.input.grant);
    expect(await f.kernel.distillation.get(f.projectId, published.analysis.id)).toEqual(published.analysis);
    expect(await f.kernel.distillation.submit(published.submission)).toEqual(published.analysis);
    expect((await f.kernel.distillation.claim(f.projectId, queued.id)).packet.packetDigest).toBe(f.packet.packetDigest);
    expect(await f.kernel.distillation.cleanup(f.projectId, '2026-10-05T00:00:00Z')).toEqual({ removedPackets: 0 });
  });

  test('a database failure rolls publication back and exposes only a sanitized typed error', async () => {
    const f = await fixture();
    await f.modifyClosedFixture(`CREATE TRIGGER fail_synthetic_analysis BEFORE INSERT ON session_analyses
      BEGIN SELECT RAISE(ABORT, 'synthetic-sensitive-diagnostic'); END;`);
    const job = await f.prepare();
    const lease = await f.kernel.distillation.claim(f.projectId, job.id);
    await expect(
      f.kernel.distillation.submit({
        projectId: f.projectId,
        jobId: job.id,
        leaseId: lease.leaseId,
        packetDigest: f.packet.packetDigest,
        content: content(),
      }),
    ).rejects.toMatchObject({
      name: 'DistillationError',
      code: 'storage-failed',
      message: 'Session distillation: storage-failed',
    });
    expect((await f.kernel.distillation.status(f.input.grant)).job?.state).toBe('running');
    expect((await f.kernel.distillation.status(f.input.grant)).latest).toBeNull();
    expect((await f.kernel.distillation.search(f.projectId, 'ENOENT', 5)).items).toEqual([]);
    expect(f.read((db) => db.query('SELECT COUNT(*) AS count FROM session_analyses').get())).toEqual({ count: 0 });
  });

  test('bounds metadata, search results and literal FTS syntax while reporting omissions', async () => {
    const f = await fixture();
    for (let index = 0; index < 22; index += 1) {
      await f.publish(`revision-${index}`);
    }
    const status = await f.kernel.distillation.status(f.input.grant);
    expect(status.revisions).toHaveLength(20);
    expect(status.revisionsOmitted).toBe(2);
    for (let index = 0; index < 3; index += 1) {
      const packet = packetFor(f.projectId, `other-session-${index}`);
      const job = await f.kernel.distillation.prepare({ ...f.input, packet, grant: grantFor(packet) });
      const lease = await f.kernel.distillation.claim(f.projectId, job.id);
      await f.kernel.distillation.submit({
        projectId: f.projectId,
        jobId: job.id,
        leaseId: lease.leaseId,
        packetDigest: packet.packetDigest,
        content: content(),
      });
    }
    const search = await f.kernel.distillation.search(f.projectId, 'ENOENT', 2);
    expect(search.items).toHaveLength(2);
    expect(search.omitted).toBe(2);
    expect((await f.kernel.distillation.search(f.projectId, 'ENOENT OR secret', 2)).items).toEqual([]);
    await expect(f.kernel.distillation.search(f.projectId, 'ENOENT', 21)).rejects.toMatchObject({
      code: 'invalid-limit',
    });
  });

  test('never creates accepted Memory, observations, exports or replication events, including backfill', async () => {
    const f = await fixture();
    await f.publish();
    const captureContext = {
      deviceId: createDeviceId(),
      id: createCaptureContextId(),
      personId: createPersonId(),
      projectId: null,
      scmAccountId: null,
      scmInstallationId: null,
      source: 'personal-fallback' as const,
      spaceId: createSpaceId(),
    };
    const configured = await f.kernel.configureReplication({
      captureContext,
      configuredAt: new Date('2026-10-04T13:00:00Z'),
      localProjectId: null,
      localSpaceId: f.identity.space.id,
    });
    expect(configured.backfilled).toBe(0);
    expect(f.kernel.replication.status().pending).toBe(0);
    for (const table of [
      'memory_observations',
      'memory_proposals',
      'memory_items',
      'memory_revisions',
      'memory_search_chunks',
      'replication_outbox_events',
    ]) {
      const count = f.read((database) => database.query(`SELECT COUNT(*) AS count FROM ${table}`).get()) as {
        count: number;
      };
      expect(count.count).toBe(0);
    }
  });
});
