import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type DistillationEvidencePacket,
  distillationEvidenceDigestInput,
} from '@ai-usage/platform-core/distillation-evidence';
import { createProjectId } from '@ai-usage/platform-core/identity';
import { openLocalIdentityKernel } from './identity';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'distillation-catalog-'));
  const kernel = await openLocalIdentityKernel({ databasePath: path.join(root, 'memory.sqlite') });
  closers.push(async () => {
    await kernel.close();
    await rm(root, { recursive: true, force: true });
  });
  const identity = await kernel.getBootstrapIdentity();
  const projectId = createProjectId();
  const otherProjectId = createProjectId();
  for (const id of [projectId, otherProjectId]) {
    await kernel.createProject({
      id,
      displayName: id === projectId ? 'Project one' : 'Other project',
      kind: 'local',
      owningSpaceId: identity.space.id,
      repositoryId: null,
      repositorySubpath: null,
      status: 'active',
    });
  }
  const publish = async (
    nativeSessionId: string,
    text: string,
    id: string = projectId,
    revisionKey: string | null = null,
  ) => {
    const packet: DistillationEvidencePacket = {
      schemaVersion: 1,
      normalizationVersion: 1,
      redactionVersion: 1,
      packetDigest: '',
      source: {
        harnessKey: 'codex',
        machineId: 'machine',
        nativeSessionId,
        projectId: id,
        reportAnchor: { revision: 'retained', rowId: nativeSessionId },
        sessionDate: '2026-10-01T12:00:00.000Z',
        version: { digest: 'a'.repeat(64), bytes: 100, totalBytes: 100, modifiedAtMs: 1 },
      },
      events: [
        {
          id: 'result',
          line: 1,
          kind: 'tool-result',
          text,
          timestamp: '2026-10-01T12:00:00.000Z',
          nativeTurnId: null,
          roundId: null,
          toolName: null,
          callId: null,
          truncated: false,
          redacted: false,
        },
      ],
      coverage: {
        scope: 'session-only',
        completion: 'completed',
        status: 'complete',
        lines: 1,
        includedEvents: 1,
        exclusions: [],
        childDiscovery: 'not-performed',
        childrenNotAnalyzed: null,
      },
    };
    packet.packetDigest = createHash('sha256').update(distillationEvidenceDigestInput(packet)).digest('hex');
    const job = await kernel.distillation.prepare({
      packet,
      grant: {
        checkoutPath: '/synthetic',
        machineId: 'machine',
        nativeSessionId,
        projectId: id,
        projectSourceId: 'machine|/synthetic',
        selection: { revision: 'retained', rowId: nativeSessionId },
      },
      producerSessionId: null,
      revisionKey,
    });
    const lease = await kernel.distillation.claim(id, job.id);
    return kernel.distillation.submit({
      projectId: id,
      jobId: job.id,
      leaseId: lease.leaseId,
      packetDigest: packet.packetDigest,
      content: {
        schemaVersion: 1,
        summary: { text, basis: 'observed', evidence: [{ eventId: 'result', quote: text.slice(0, 600) }] },
        episodes: [],
        abstention: null,
      },
    });
  };
  return { kernel, projectId, otherProjectId, publish };
};

test('bounded task recall finds natural questions and literal mode preserves exact errors without widening Project', async () => {
  const f = await fixture();
  const expected = await f.publish('cache', 'Repair cache invalidation after ENOENT: src/cache.ts');
  expect(
    (
      await f.kernel.distillation.search(f.projectId, 'How can I investigate cache invalidation safely?', 10, 'task')
    ).items.map((item) => item.id),
  ).toEqual([expected.id]);
  expect(
    (await f.kernel.distillation.search(f.projectId, 'ENOENT: src/cache.ts', 10, 'literal')).items.map(
      (item) => item.id,
    ),
  ).toEqual([expected.id]);
  expect((await f.kernel.distillation.search(f.projectId, 'ENOENT src/cache.ts', 10, 'literal')).items).toEqual([]);
  const baseline = await f.kernel.distillation.search(f.projectId, 'cache invalidation', 10, 'task');
  await f.publish('foreign', 'cache invalidation cache invalidation cache invalidation', f.otherProjectId);
  expect(await f.kernel.distillation.search(f.projectId, 'cache invalidation', 10, 'task')).toEqual(baseline);
  expect((await f.kernel.distillation.search(f.otherProjectId, 'ENOENT', 10, 'literal')).items).toEqual([]);
});

test('library UTF-8 response bounds retain a continuation rather than dropping large cards', async () => {
  const f = await fixture();
  for (let index = 0; index < 40; index += 1) {
    await f.publish(`unicode-${index}`, '🔎'.repeat(800));
  }
  const query = {
    kind: 'browse' as const,
    projectId: f.projectId,
    since: null,
    until: null,
    query: '',
    limit: 50,
    cursor: null,
  };
  const first = await f.kernel.distillation.browse(query);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(128 * 1024);
  expect(first.items.length).toBeLessThan(40);
  expect(first.nextCursor).not.toBeNull();
  const second = await f.kernel.distillation.browse({ ...query, cursor: first.nextCursor });
  expect(first.items.length + second.items.length).toBe(40);
  expect(second.nextCursor).toBeNull();
});

test('library pages hold one revision per session across publication and history survives report absence', async () => {
  const f = await fixture();
  const original = await f.publish('session-0', 'Session zero historical result');
  const revised = await f.publish('session-0', 'Session zero revised result', f.projectId, 'second-interpretation');
  for (let index = 1; index < 26; index += 1) {
    await f.publish(`session-${index}`, `Cache investigation number ${index}`);
  }
  const query = {
    kind: 'browse' as const,
    projectId: f.projectId,
    since: '2026-10-01T00:00:00.000Z',
    until: '2026-10-02T00:00:00.000Z',
    query: '',
    limit: 7,
    cursor: null,
  };
  const first = await f.kernel.distillation.browse(query);
  expect(first.items).toHaveLength(7);
  const later = await f.publish('new-publication', 'New publication after pagination began');
  const items = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await f.kernel.distillation.browse({ ...query, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  expect(items).toHaveLength(26);
  expect(new Set(items.map((item) => item.nativeSessionId)).size).toBe(26);
  expect(items.some((item) => item.id === original.id || item.id === later.id)).toBe(false);
  expect(items.some((item) => item.id === revised.id)).toBe(true);
  expect(items.every((item) => item.sessionDate === '2026-10-01T12:00:00.000Z')).toBe(true);
  expect(
    (await f.kernel.distillation.history(f.projectId, original.id, 20, null)).items.map((item) => item.id),
  ).toEqual([revised.id, original.id]);
  await expect(
    f.kernel.distillation.browse({ ...query, projectId: f.otherProjectId, cursor: first.nextCursor }),
  ).rejects.toMatchObject({ code: 'cursor-scope-mismatch' });
  await expect(f.kernel.distillation.history(f.otherProjectId, original.id, 20, null)).rejects.toMatchObject({
    code: 'analysis-not-found',
  });
  await f.kernel.distillation.remove(f.projectId, first.items[0]!.id, 'withdraw');
  await expect(f.kernel.distillation.browse({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({
    code: 'cursor-stale',
  });
});
