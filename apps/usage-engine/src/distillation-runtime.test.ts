import { afterEach, expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDistillationEvidencePacket } from '@ai-usage/platform-core/distillation-evidence';
import { createProjectId } from '@ai-usage/platform-core/identity';
import type { DistillationLease, SessionAnalysisContent } from '@ai-usage/platform-core/session-distillation';
import {
  DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION,
  distillationObject,
  parseDistillationStatus,
  parseSessionAnalysis,
  parseSessionAnalysisContent,
} from '@ai-usage/platform-core/session-distillation';
import { queryUsageStoreGenerations } from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import { createDistillationRuntime } from './distillation-runtime';
import { createDistillationFixture } from './fixtures/distillation';
import { longSessionExpectations } from './fixtures/distillation-long-session';

const fixtures: Awaited<ReturnType<typeof createDistillationFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose();
  }
});

test('real multi-window workflow reaches late validation after recovery, keeps exact segments, and rejects a changed snapshot', async () => {
  const f = await fixture('long-session');
  const prepared = distillationObject(
    await f.client.distillation({
      kind: 'prepare',
      projectId: f.projectId,
      selections: [f.selection],
      providerProcessingAuthorized: true,
      producerSessionId: 'synthetic-distiller',
      revisionKey: null,
    }),
  );
  const jobId = (prepared.jobs as { id: string }[])[0]!.id;
  let lease = (await f.client.distillation({ kind: 'claim', projectId: f.projectId, jobId })) as DistillationLease;
  const firstPacket = structuredClone(lease.packet);
  expect(firstPacket.source.version.bytes).toBeGreaterThan(longSessionExpectations.sourceBytesAbove);
  const checkpoint: SessionAnalysisContent = {
    schemaVersion: 1,
    summary: { text: 'Initial observations remain unverified.', basis: 'unknown', evidence: [] },
    episodes: [],
    abstention: null,
  };
  const submission = (current: DistillationLease, content: SessionAnalysisContent) => ({
    projectId: f.projectId,
    jobId,
    leaseId: current.leaseId,
    packetDigest: current.packet.packetDigest,
    extractorVersion: current.extractorVersion,
    snapshotDigest: current.packet.source.version.digest,
    segmentIndex: current.packet.window!.index,
    content,
  });
  const first = { kind: 'advance' as const, ...submission(lease, checkpoint) };
  const advanced = await f.client.distillation(first);
  expect(await f.client.distillation(first)).toEqual(advanced);
  lease = (await f.client.distillation({ kind: 'claim', projectId: f.projectId, jobId })) as DistillationLease;
  const expired = lease;
  await f.restart();
  await f.client.distillation({ kind: 'retry', projectId: f.projectId, jobId });
  lease = (await f.client.distillation({ kind: 'claim', projectId: f.projectId, jobId })) as DistillationLease;
  expect(lease.checkpoint).toEqual(checkpoint);
  expect(lease.packet.events.some((event) => event.text === longSessionExpectations.finalDecision)).toBe(true);
  const observed = lease.packet.events.find((event) => event.text === longSessionExpectations.recordedValidation)!;
  const finalContent: SessionAnalysisContent = {
    schemaVersion: 1,
    summary: {
      text: 'The final recorded test passes; the earlier unsupported success claim is not the validation.',
      basis: 'observed',
      evidence: [{ eventId: observed.id, quote: observed.text }],
    },
    episodes: [],
    abstention: null,
  };
  await expect(f.client.distillation({ kind: 'advance', ...submission(expired, finalContent) })).rejects.toThrow();
  await f.client.distillation({ kind: 'advance', ...submission(lease, finalContent) });
  const archived = distillationObject(
    await f.client.distillation({
      kind: 'segment',
      projectId: f.projectId,
      jobId,
      snapshotDigest: firstPacket.source.version.digest,
      segmentIndex: 0,
    }),
  );
  expect(archived.packet).toEqual(firstPacket);
  const consolidation = (await f.client.distillation({
    kind: 'claim',
    projectId: f.projectId,
    jobId,
  })) as DistillationLease;
  const saved = parseSessionAnalysis(
    await f.client.distillation({ kind: 'submit', ...submission(consolidation, finalContent) }),
  );
  expect(saved.coverage.includedEvents).toBeGreaterThan(longSessionExpectations.nativeEventsAbove);
  expect(saved.coverage.status).toBe('partial');
  expect(
    await f.client.distillation({
      kind: 'evidence',
      projectId: f.projectId,
      analysisId: saved.id,
      eventIds: [observed.id],
      identity: { packetDigest: saved.packetDigest, sourceDigest: saved.source.version.digest },
    }),
  ).toMatchObject({ status: 'available', events: [{ text: longSessionExpectations.recordedValidation }] });
  const next = distillationObject(
    await f.client.distillation({
      kind: 'prepare',
      projectId: f.projectId,
      selections: [f.selection],
      providerProcessingAuthorized: true,
      producerSessionId: null,
      revisionKey: 'mutation',
    }),
  );
  const nextId = (next.jobs as { id: string }[])[0]!.id;
  const pending = (await f.client.distillation({
    kind: 'claim',
    projectId: f.projectId,
    jobId: nextId,
  })) as DistillationLease;
  await appendFile(f.sourceFile, '\n');
  await expect(
    f.client.distillation({ kind: 'advance', ...submission(pending, checkpoint), jobId: nextId }),
  ).rejects.toThrow();
}, 30_000);
const fixture = async (caseId?: string) => {
  const value = await createDistillationFixture(caseId);
  fixtures.push(value);
  return value;
};

test('real local service prepares, validates, publishes once, restarts, searches and reloads exact evidence', async () => {
  const f = await fixture();
  const before = await Effect.runPromise(queryUsageStoreGenerations({ dbPath: f.databasePath }));
  const prepared = distillationObject(
    await f.client.distillation({
      kind: 'prepare',
      projectId: f.projectId,
      selections: [f.selection],
      providerProcessingAuthorized: true,
      producerSessionId: 'synthetic-distiller',
      revisionKey: null,
    }),
  );
  const jobs = prepared.jobs as { id: string }[];
  expect(jobs).toHaveLength(1);
  const lease = distillationObject(
    await f.client.distillation({ kind: 'claim', projectId: f.projectId, jobId: jobs[0]!.id }),
  );
  const packet = parseDistillationEvidencePacket(lease.packet);
  // Software producer is controlled; semantic quality is evaluated separately against independent checkpoints.
  const event = packet.events.find((entry) => entry.kind === 'tool-result')!;
  const content = parseSessionAnalysisContent({
    schemaVersion: 1,
    summary: {
      text: 'The initial revision cache test failed.',
      basis: 'observed',
      evidence: [{ eventId: event.id, quote: event.text }],
    },
    episodes: [],
    abstention: null,
  });
  const submission = {
    kind: 'submit' as const,
    projectId: f.projectId,
    jobId: jobs[0]!.id,
    leaseId: String(lease.leaseId),
    packetDigest: packet.packetDigest,
    extractorVersion: DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION,
    snapshotDigest: packet.source.version.digest,
    segmentIndex: packet.window?.index ?? 0,
    content,
  };
  const saved = parseSessionAnalysis(await f.client.distillation(submission));
  expect(parseSessionAnalysis(await f.client.distillation(submission)).id).toBe(saved.id);
  expect(await Effect.runPromise(queryUsageStoreGenerations({ dbPath: f.databasePath }))).toEqual(before);
  await f.restart();
  expect(
    parseSessionAnalysis(await f.client.distillation({ kind: 'get', projectId: f.projectId, analysisId: saved.id })),
  ).toEqual(saved);
  const search = distillationObject(
    await f.client.distillation({ kind: 'search', projectId: f.projectId, query: 'revision cache', limit: 10 }),
  );
  expect(search.items).toHaveLength(1);
  const context = await f.client.distillation({
    kind: 'context',
    projectId: f.projectId,
    query: 'revision cache',
    maxBytes: 4096,
  });
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(4096);
  expect(distillationObject(context).bytes).toBe(Buffer.byteLength(JSON.stringify(context)));
  const evidence = { kind: 'evidence' as const, selection: f.selection, analysisId: saved.id, eventIds: [event.id] };
  expect(await f.client.distillation(evidence)).toMatchObject({ status: 'available', events: [{ id: event.id }] });
  await f.client.distillation({
    kind: 'cleanup',
    projectId: f.projectId,
    before: new Date(Date.now() + 1000).toISOString(),
  });
  expect(await f.client.distillation(evidence)).toMatchObject({ status: 'available' });
  await appendFile(f.sourceFile, '\n');
  expect(await f.client.distillation(evidence)).toMatchObject({ status: 'changed', events: [] });
  expect(
    parseDistillationStatus(await f.client.distillation({ kind: 'status', selection: f.selection })).latest?.id,
  ).toBe(saved.id);
}, 30_000);

test('fails closed for other Projects, portable rows and connected composition', async () => {
  const f = await fixture();
  const other = createProjectId();
  expect(await f.client.distillation({ kind: 'select', projectId: other, selections: [f.selection] })).toMatchObject({
    candidates: [{ eligible: false, reason: 'project-mismatch' }],
    jobs: [],
  });
  await f.publish('portable-revision', 'portable-opaque');
  expect(
    await f.client.distillation({
      kind: 'select',
      projectId: f.projectId,
      selections: [{ ...f.selection, revision: 'portable-revision' }],
    }),
  ).toMatchObject({ candidates: [{ eligible: false, reason: 'not-local' }] });
  const connected = createDistillationRuntime({
    kernel: f.kernel(),
    databasePath: f.databasePath,
    homeDirectory: f.homeDirectory,
    connected: true,
  });
  await expect(connected.execute({ kind: 'status', selection: f.selection })).rejects.toThrow('unsupported-connected');
}, 30_000);

test('context retains a useful summary and relevant episodes when a full analysis exceeds its byte budget', async () => {
  const f = await fixture();
  const prepared = distillationObject(
    await f.client.distillation({
      kind: 'prepare',
      projectId: f.projectId,
      selections: [f.selection],
      providerProcessingAuthorized: true,
      producerSessionId: null,
      revisionKey: null,
    }),
  );
  const job = (prepared.jobs as { id: string }[])[0]!;
  const lease = distillationObject(
    await f.client.distillation({ kind: 'claim', projectId: f.projectId, jobId: job.id }),
  );
  const packet = parseDistillationEvidencePacket(lease.packet);
  const assertion = (text: string) => ({ text, basis: 'inferred' as const, evidence: [] });
  const episode = (id: string) => ({
    id,
    objective: assertion(id),
    attempts: [],
    result: { status: 'unknown' as const, assertion: assertion('Outcome not established.') },
    difficulties: [],
    decisions: [],
    entryPoints: [],
    openQuestions: [],
  });
  const content = parseSessionAnalysisContent({
    schemaVersion: 1,
    summary: assertion('Investigating the revision cache.'),
    abstention: null,
    episodes: [
      {
        ...episode('large'),
        attempts: Array.from({ length: 8 }, () => assertion('Bounded synthetic context. '.repeat(40))),
      },
      { ...episode('revision-cache'), entryPoints: [assertion('Historical entry point: src/revision-cache.ts')] },
    ],
  });
  const saved = parseSessionAnalysis(
    await f.client.distillation({
      kind: 'submit',
      projectId: f.projectId,
      jobId: job.id,
      leaseId: String(lease.leaseId),
      packetDigest: packet.packetDigest,
      extractorVersion: DISTILLATION_PROGRESSIVE_EXTRACTOR_VERSION,
      snapshotDigest: packet.source.version.digest,
      segmentIndex: packet.window?.index ?? 0,
      content,
    }),
  );
  const request = { kind: 'context' as const, projectId: f.projectId, query: 'revision cache', maxBytes: 4096 };
  const result = distillationObject(await f.client.distillation(request));
  expect(result).toMatchObject({
    omitted: 0,
    analyses: [
      {
        id: saved.id,
        omittedEpisodes: 1,
        content: { summary: saved.content.summary, episodes: [{ id: 'revision-cache' }] },
      },
    ],
  });
  expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
  expect(Number(result.bytes)).toBeLessThanOrEqual(4096);
  expect(await f.client.distillation({ ...request, maxBytes: 512 })).toMatchObject({ analyses: [], omitted: 1 });
  expect(
    parseSessionAnalysis(await f.client.distillation({ kind: 'get', projectId: f.projectId, analysisId: saved.id })),
  ).toEqual(saved);
}, 30_000);

test('actual reader and runtime redact wrapped secret JSON before packet persistence and claim', async () => {
  const f = await fixture('malicious-data');
  const raw = await readFile(f.sourceFile, 'utf8');
  const records: Record<string, unknown>[] = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const output = records.find((entry) => entry.id === 'malicious-document')!;
  const payload = distillationObject(output.payload);
  payload.output = 'Process exited with code 0\nFinal output:\n{"password":"synthetic-hidden-secret"}';
  await writeFile(f.sourceFile, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const prepared = distillationObject(
    await f.client.distillation({
      kind: 'prepare',
      projectId: f.projectId,
      selections: [f.selection],
      providerProcessingAuthorized: true,
      producerSessionId: null,
      revisionKey: null,
    }),
  );
  const jobs = prepared.jobs as { id: string }[];
  const lease = await f.client.distillation({ kind: 'claim', projectId: f.projectId, jobId: jobs[0]!.id });
  expect(JSON.stringify(lease)).not.toContain('synthetic-hidden-secret');
  expect(JSON.stringify(lease)).toContain('[REDACTED]');
  const database = await readFile(f.memoryDatabasePath);
  const wal = await readFile(path.join(f.stateDirectory, 'memory.sqlite-wal'));
  expect(
    database.includes(Buffer.from('synthetic-hidden-secret')) || wal.includes(Buffer.from('synthetic-hidden-secret')),
  ).toBe(false);
}, 30_000);
